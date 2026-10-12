import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { production } from '../lib/config';
import { VIEWER_REQUEST_SOURCE, viewerRequestCode } from '../lib/viewer-request';

type Querystring = Record<string, { value: string; multiValue?: { value: string }[] }>;
type Handler = (event: unknown) => any;

// CloudFront Functions are plain scripts with a global `handler`. Top-level vars
// are properties of the context, so `globals` can set the hostnames that
// viewerRequestCode fills in at synth time.
function evaluate(code: string, filename: string, globals: Record<string, string> = {}): Handler {
  const context = vm.createContext();
  vm.runInContext(code, context, { filename });
  Object.assign(context, globals);
  for (const [name, value] of Object.entries(globals)) {
    if (vm.runInContext(name, context) !== value) {
      throw new Error(`${filename} must declare ${name} with a top-level var so these tests can set it`);
    }
  }
  return context.handler;
}

const handlers: [string, Handler][] = [
  // The unmodified file, run under its own path so V8 coverage attributes it.
  [
    'functions/viewer-request.js',
    evaluate(readFileSync(VIEWER_REQUEST_SOURCE, 'utf8'), VIEWER_REQUEST_SOURCE, {
      APEX_HOST: 'zachdavids.com',
      WWW_HOST: 'www.zachdavids.com',
    }),
  ],
  // Exactly what the stack deploys, in strict mode as on cloudfront-js-2.0. Its
  // offsets differ from the file's, so it runs under a name coverage ignores.
  ['deployed code in strict mode', evaluate(`'use strict';${viewerRequestCode(production)}`, 'viewer-request.js (deployed)')],
];

/** A CloudFront viewer-request event; a null host omits the Host header. */
function viewerRequest(uri: string, host: string | null = 'zachdavids.com', querystring: Querystring = {}) {
  const headers: Record<string, { value: string }> = host === null ? {} : { host: { value: host } };
  return { version: '1.0', context: { eventType: 'viewer-request' }, request: { method: 'GET', uri, querystring, headers, cookies: {} } };
}

describe.each(handlers)('%s', (_name, handler) => {
  describe('www to apex redirect', () => {
    it('answers 301 with the apex location, cacheable for an hour', () => {
      expect(handler(viewerRequest('/notes/', 'www.zachdavids.com'))).toEqual({
        statusCode: 301,
        statusDescription: 'Moved Permanently',
        headers: {
          location: { value: 'https://zachdavids.com/notes/' },
          'cache-control': { value: 'max-age=3600' },
        },
      });
    });

    it('matches the www host case-insensitively', () => {
      expect(handler(viewerRequest('/', 'WWW.ZachDavids.com')).headers.location.value).toBe('https://zachdavids.com/');
    });

    it('keeps the requested path instead of mapping it to index.html', () => {
      expect(handler(viewerRequest('/about', 'www.zachdavids.com')).headers.location.value).toBe('https://zachdavids.com/about');
    });

    it('redirects well-known URIs too', () => {
      expect(handler(viewerRequest('/.well-known/security.txt', 'www.zachdavids.com')).headers.location.value).toBe(
        'https://zachdavids.com/.well-known/security.txt',
      );
    });

    it.each<[string, Querystring, string]>([
      ['no query string', {}, ''],
      ['a single value', { utm_source: { value: 'x' } }, '?utm_source=x'],
      ['an empty value as a bare name', { flag: { value: '' } }, '?flag'],
      ['every value of a repeated name', { tag: { value: 'a', multiValue: [{ value: 'a' }, { value: '' }, { value: 'b' }] } }, '?tag=a&tag&tag=b'],
      [
        'several names in order',
        { utm_source: { value: 'x' }, flag: { value: '' }, tag: { value: 'a', multiValue: [{ value: 'a' }, { value: 'b' }] } },
        '?utm_source=x&flag&tag=a&tag=b',
      ],
    ])('carries %s over to the location', (_case, querystring, search) => {
      const response = handler(viewerRequest('/notes/', 'www.zachdavids.com', querystring));
      expect(response.headers.location.value).toBe(`https://zachdavids.com/notes/${search}`);
    });

    // Assumes CloudFront passes the path and query through percent-encoded, as the
    // viewer sent them; re-encoding or decoding them would corrupt the redirect.
    it('copies an encoded path and query into the location verbatim', () => {
      const querystring = { q: { value: 'a%20b%26c%3Dd' }, 'k%5B0%5D': { value: '1' } };
      const response = handler(viewerRequest('/caf%C3%A9/50%25%20off', 'www.zachdavids.com', querystring));
      expect(response.headers.location.value).toBe('https://zachdavids.com/caf%C3%A9/50%25%20off?q=a%20b%26c%3Dd&k%5B0%5D=1');
    });
  });

  describe('requests for other hosts', () => {
    it('passes an apex request through with only its uri mapped', () => {
      expect(handler(viewerRequest('/about', 'zachdavids.com', { q: { value: '1' } }))).toEqual({
        method: 'GET',
        uri: '/about/index.html',
        querystring: { q: { value: '1' } },
        headers: { host: { value: 'zachdavids.com' } },
        cookies: {},
      });
    });

    it('does not redirect the CloudFront default hostname', () => {
      expect(handler(viewerRequest('/', 'd111111abcdef8.cloudfront.net')).uri).toBe('/index.html');
    });

    it('does not redirect a request without a Host header', () => {
      expect(handler(viewerRequest('/about', null)).uri).toBe('/about/index.html');
    });
  });

  describe('index.html mapping', () => {
    it.each([
      ['/', '/index.html'],
      ['/about/', '/about/index.html'],
      ['/v1.2/', '/v1.2/index.html'],
    ])('maps the directory %s to %s', (uri, expected) => {
      expect(handler(viewerRequest(uri)).uri).toBe(expected);
    });

    it.each([
      ['/about', '/about/index.html'],
      ['/v1.2/notes', '/v1.2/notes/index.html'],
    ])('maps the extensionless path %s to %s', (uri, expected) => {
      expect(handler(viewerRequest(uri)).uri).toBe(expected);
    });

    it.each(['/assets/index-mKM-b7Ju.js', '/404.html', '/robots.txt'])('leaves the file %s alone', (uri) => {
      expect(handler(viewerRequest(uri)).uri).toBe(uri);
    });

    it('treats any dotted last segment as a file, so a dotted slug needs a trailing slash', () => {
      expect(handler(viewerRequest('/notes/v1.2')).uri).toBe('/notes/v1.2');
    });

    it.each(['/.well-known/', '/.well-known/security.txt', '/.well-known/apple-app-site-association'])(
      'leaves the well-known URI %s alone',
      (uri) => {
        expect(handler(viewerRequest(uri)).uri).toBe(uri);
      },
    );

    it('maps a .well-known directory below the root like any other path', () => {
      expect(handler(viewerRequest('/notes/.well-known/x')).uri).toBe('/notes/.well-known/x/index.html');
    });

    it('maps a path that only starts like /.well-known/', () => {
      expect(handler(viewerRequest('/.well-known-x/')).uri).toBe('/.well-known-x/index.html');
    });
  });
});

describe('deployed code', () => {
  it('leaves no placeholder unfilled', () => {
    expect(viewerRequestCode(production)).not.toMatch(/__[A-Z_]+__/);
  });

  it('stays within the 10 KB CloudFront Functions size limit', () => {
    expect(Buffer.byteLength(viewerRequestCode(production))).toBeLessThan(10 * 1024);
  });
});

describe('viewerRequestCode', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'viewer-request-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function functionFile(source: string): string {
    const file = path.join(dir, 'viewer-request.js');
    writeFileSync(file, source);
    return file;
  }

  it('fills in each placeholder with the lowercased hostname and changes nothing else', () => {
    const file = functionFile("// __APEX_HOST_ and __WWW_HOST are near misses\nvar APEX_HOST = '__APEX_HOST__';\n\nvar WWW_HOST = '__WWW_HOST__'; // kept\n");
    expect(viewerRequestCode({ domainName: 'Example.COM', wwwDomainName: 'WWW.Example.com' }, file)).toBe(
      "// __APEX_HOST_ and __WWW_HOST are near misses\nvar APEX_HOST = 'example.com';\n\nvar WWW_HOST = 'www.example.com'; // kept\n",
    );
  });

  it.each([
    ['__APEX_HOST__', 'missing', "var WWW_HOST = '__WWW_HOST__';\n"],
    ['__APEX_HOST__', 'repeated', "// __APEX_HOST__\nvar APEX_HOST = '__APEX_HOST__';\nvar WWW_HOST = '__WWW_HOST__';\n"],
    ['__WWW_HOST__', 'missing', "var APEX_HOST = '__APEX_HOST__';\n"],
    ['__WWW_HOST__', 'repeated', "// __WWW_HOST__\nvar APEX_HOST = '__APEX_HOST__';\nvar WWW_HOST = '__WWW_HOST__';\n"],
  ])('refuses a source with %s %s', (placeholder, _case, source) => {
    const file = functionFile(source);
    expect(() => viewerRequestCode(production, file)).toThrow(new Error(`${file} must contain ${placeholder} exactly once`));
  });
});
