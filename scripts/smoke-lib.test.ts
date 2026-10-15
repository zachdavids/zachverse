import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '../src/entry-server.tsx';
import { prerenderPages, renderDocument } from './prerender-lib.ts';
import { type SiteFile, siteFiles } from './release-lib.ts';
import { distributionRequests, type Get, prerendered, type Reply, retrying, smokeTest } from './smoke-lib.ts';

const CLOUDFRONT = 'd111111abcdef8.cloudfront.net';
const BUCKET = 'site-bucket';
const PROBE = 'smoke-test-probe';
const TARGET = { origin: 'https://example.com', cloudfront: CLOUDFRONT, bucket: BUCKET, probe: PROBE };
const RELEASE = 'a'.repeat(40);

const HOME = [
  '<!doctype html><html><head><title>Example</title>',
  `<meta name="zachverse-release" content="${RELEASE}" />`,
  '<link rel="icon" href="/favicon.svg" /><link rel="canonical" href="https://example.com/" />',
  '<script type="module" src="/assets/index-AbCd1234.js"></script><link rel="stylesheet" href="/assets/index-EfGh5678.css?v=1">',
  '</head><body><div id="root" data-page="home"><main><h1>A Name</h1><a href="/">Home</a> <a href="/about">About</a>',
  '<a href="#top">Top</a>',
  '<a href="//other.example/x">Other</a></main></div></body></html>',
].join('\n');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function site(changes: Record<string, string | undefined> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-lib-test-'));
  dirs.push(dir);
  const files: Record<string, string | undefined> = {
    'index.html': HOME,
    'about/index.html': '<!doctype html><title>About</title>',
    '404.html': '<!doctype html><title>Not found</title><link rel="icon" href="/favicon.svg" />',
    'favicon.svg': '<svg/>',
    'assets/index-AbCd1234.js': 'console.log(1);',
    'assets/index-EfGh5678.css': 'body{}',
    ...changes,
  };
  for (const [path, text] of Object.entries(files)) {
    if (text === undefined) continue;
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const reply = (status: number, body: string | Buffer = '', headers: Reply['headers'] = {}): Reply => ({
  status,
  headers,
  body: Buffer.from(body),
});

// The distribution as deployed: the CloudFront hostname reached directly, the custom hostnames reached through it,
// HTTPS and www redirects, the viewer-request function's paths, the 404 page, and S3's 403s.
function cloudFront(dir: string): Get {
  const files = new Map<string, SiteFile>(siteFiles(dir).map((file) => [file.path, file]));
  const notFound = files.get('404.html')!;
  return async (url, via) => {
    const { protocol, host, pathname, search } = new URL(url);
    if (host === `${BUCKET}.s3.us-east-1.amazonaws.com` && via === undefined) return reply(403, 'AccessDenied');
    if (host === CLOUDFRONT ? via !== undefined : via !== CLOUDFRONT) throw new Error(`not through CloudFront: ${url}`);
    if (protocol === 'http:') return reply(301, '', { location: `https://${host}${pathname}${search}` });
    if (host === 'www.example.com') return reply(301, '', { location: `https://example.com${pathname}${search}` });
    if (pathname.startsWith('/_releases/')) return reply(403, 'AccessDenied');
    const name = pathname.slice(pathname.lastIndexOf('/') + 1);
    const path = pathname.slice(1) + (name === '' ? 'index.html' : name.includes('.') ? '' : '/index.html');
    const file = files.get(path);
    if (file === undefined) return reply(404, notFound.body, { 'content-type': notFound.contentType });
    return reply(200, file.body, { 'content-type': file.contentType, 'cache-control': [file.cacheControl] });
  };
}

// cloudFront, except where answer returns a reply for a URL, which it gets parsed, to match by host and path.
function except(dir: string, answer: (url: URL) => Reply | undefined): Get {
  const healthy = cloudFront(dir);
  return async (url, via) => answer(new URL(url)) ?? healthy(url, via);
}

const CHECKS = [
  `https://${CLOUDFRONT}/ serves the home page`,
  'https://example.com/ serves the prerendered home page',
  'https://example.com serves every file of the release, with its content type and caching',
  "every page's scripts, styles, icons, and page links load",
  'http://example.com/ redirects to HTTPS',
  'http://www.example.com/ redirects to HTTPS',
  'https://www.example.com/ redirects to the apex, keeping the path and query',
  'a missing page gets the 404 page, with status 404',
  'a missing asset gets status 404',
  "a release record gets S3's 403, not the 404 page",
  'the bucket refuses unauthenticated requests made to it directly',
];

describe('smokeTest', () => {
  it('passes every check against a distribution that serves the release as deployed', async () => {
    const dir = site();
    expect(await smokeTest(dir, TARGET, cloudFront(dir))).toEqual({ passed: CHECKS, failures: [] });
  });

  it('fails a file served with another body, status, content type, or caching', async () => {
    const dir = site();
    const result = await smokeTest(
      dir,
      TARGET,
      except(dir, (url) => {
        if (url.href === 'https://example.com/favicon.svg') return reply(200, '<svg/>', { 'content-type': 'text/plain' });
        if (url.href === 'https://example.com/about/index.html') return reply(500);
        if (url.pathname.endsWith('.css')) {
          return reply(200, 'stale', { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'max-age=60' });
        }
        return undefined;
      }),
    );
    expect(result.passed).toEqual(CHECKS.filter((_check, index) => index !== 2 && index !== 3));
    // Every file in path order, then each URL the pages load, once, in page order: the 404 page's icon, then the home
    // page's stylesheet, its icon already judged. Their replies are the ones the earlier check got, not new requests;
    // /about gets about/index.html, which serves.
    expect(result.failures).toEqual([
      `${CHECKS[2]}: /about/index.html: status 500, not 200`,
      `${CHECKS[2]}: /assets/index-EfGh5678.css: the body is not the release's /assets/index-EfGh5678.css`,
      `${CHECKS[2]}: /assets/index-EfGh5678.css: cache-control is "max-age=60", not "public, max-age=31536000, immutable"`,
      `${CHECKS[2]}: /favicon.svg: content-type is "text/plain", not "image/svg+xml"`,
      `${CHECKS[2]}: /favicon.svg: cache-control is undefined, not "no-cache"`,
      `${CHECKS[3]}: /favicon.svg: content-type is "text/plain", not "image/svg+xml"`,
      `${CHECKS[3]}: /favicon.svg: cache-control is undefined, not "no-cache"`,
      `${CHECKS[3]}: /assets/index-EfGh5678.css: the body is not the release's /assets/index-EfGh5678.css`,
      `${CHECKS[3]}: /assets/index-EfGh5678.css: cache-control is "max-age=60", not "public, max-age=31536000, immutable"`,
    ]);
  });

  it('fails a home page that is not the release, or not prerendered, at either hostname', async () => {
    const dir = site({ 'index.html': '<!doctype html><title></title><div id="root" data-page="home"></div>' });
    const result = await smokeTest(
      dir,
      TARGET,
      except(dir, (url) => (url.pathname.endsWith('/') && !url.pathname.includes(PROBE) ? reply(503) : undefined)),
    );
    expect(result.failures).toEqual(
      expect.arrayContaining([
        `${CHECKS[0]}: /: status 503, not 200`,
        `${CHECKS[1]}: /: status 503, not 200`,
        `${CHECKS[1]}: the home page has no a title`,
        `${CHECKS[1]}: the home page has no prerendered markup`,
        `${CHECKS[1]}: the home page has no a heading`,
        `${CHECKS[1]}: the home page has no the release it belongs to`,
      ]),
    );
  });

  it('requests each URL through the distribution once, however many pages refer to it, as distributionRequests counts', async () => {
    const dir = site({
      'about/index.html': '<!doctype html><title>About</title><a href="/">Home</a><a href="/about">About</a><link rel="icon" href="/favicon.svg" />',
      'work/index.html': '<!doctype html><title>Work</title><a href="/about/">About</a><a href="/about">About</a>',
    });
    const healthy = cloudFront(dir);
    const requests: string[] = [];
    const counting: Get = async (url, via) => {
      if (via !== undefined || new URL(url).host === CLOUDFRONT) requests.push(url);
      return healthy(url, via);
    };
    expect((await smokeTest(dir, TARGET, counting)).failures).toEqual([]);
    expect(requests.filter((url, i) => requests.indexOf(url) !== i)).toEqual([]);
    // The fixed seven, the home page, the seven files, and the two page addresses the pages link to, /about and /about/.
    expect(requests).toHaveLength(7 + 1 + 7 + 2);
    expect(distributionRequests(siteFiles(dir))).toBe(requests.length);
  });

  it('reports a file whose request failed outright under both checks, and goes on with the other references', async () => {
    const dir = site({ '404.html': '<!doctype html><title>x</title><link rel="icon" href="/favicon.svg" /><a href="/about">About</a>' });
    const result = await smokeTest(
      dir,
      TARGET,
      except(dir, (url) => {
        if (url.pathname === '/favicon.svg') throw new Error('read ECONNRESET');
        return undefined;
      }),
    );
    // The file check stops at the icon; the references check reports it once and still checks /about.
    expect(result.failures).toEqual([`${CHECKS[2]}: read ECONNRESET`, `${CHECKS[3]}: /favicon.svg: read ECONNRESET`]);
  });

  it('fails a page that refers to a file the release does not have', async () => {
    const dir = site({ '404.html': '<!doctype html><title>x</title><script src="/assets/gone-AbCd1234.js"></script>' });
    const result = await smokeTest(dir, TARGET, cloudFront(dir));
    expect(result.failures).toEqual([
      `${CHECKS[3]}: /404.html refers to /assets/gone-AbCd1234.js, which the release does not have`,
    ]);
  });

  it('fails missing or misdirected redirects', async () => {
    const dir = site();
    const result = await smokeTest(
      dir,
      TARGET,
      except(dir, (url) => {
        if (url.href === 'http://example.com/') return reply(200, HOME);
        if (url.href === 'http://www.example.com/') return reply(302, '', { location: 'https://www.example.com/' });
        if (url.protocol === 'https:' && url.host === 'www.example.com') return reply(301, '', { location: 'https://example.com/' });
        return undefined;
      }),
    );
    expect(result.failures).toEqual([
      `${CHECKS[4]}: status 200 to undefined, not 301 to https://example.com/`,
      `${CHECKS[5]}: status 302 to "https://www.example.com/", not 301 to https://www.example.com/`,
      `${CHECKS[6]}: status 301 to "https://example.com/", not 301 to https://example.com/${PROBE}/page?from=smoke-test`,
    ]);
  });

  it('fails when a missing page or asset is served, or the 404 page hides an access failure', async () => {
    const dir = site();
    const notFoundPage = siteFiles(dir).find(({ path }) => path === '404.html')!.body;
    const result = await smokeTest(
      dir,
      TARGET,
      except(dir, (url) => {
        const bucket = url.host === `${BUCKET}.s3.us-east-1.amazonaws.com`;
        if (url.host === 'example.com' && url.pathname === `/${PROBE}/`) return reply(200, HOME);
        if (url.pathname === `/assets/${PROBE}.js`) return reply(200, 'js');
        if (url.pathname === '/_releases/history.json') return reply(404, notFoundPage);
        if (bucket && url.pathname === '/index.html') return reply(200, HOME);
        if (bucket && url.pathname === '/') return reply(200, '<ListBucketResult/>');
        return undefined;
      }),
    );
    expect(result.failures).toEqual([
      `${CHECKS[7]}: /${PROBE}/: status 200, not 404`,
      `${CHECKS[7]}: the body is not the 404 page`,
      `${CHECKS[8]}: /assets/${PROBE}.js: status 200, not 404`,
      `${CHECKS[9]}: /_releases/history.json: status 404, not 403`,
      `${CHECKS[9]}: the body is the 404 page`,
      `${CHECKS[10]}: https://${BUCKET}.s3.us-east-1.amazonaws.com/index.html: status 200, not 403`,
      `${CHECKS[10]}: https://${BUCKET}.s3.us-east-1.amazonaws.com/: status 200, not 403`,
    ]);
  });

  it('reports a check that cannot connect, and runs the rest', async () => {
    const dir = site();
    const failing: Get = async (url, via) => {
      if (url === 'http://example.com/') throw new Error('connect ETIMEDOUT');
      if (url === 'http://www.example.com/') throw 'reset';
      return cloudFront(dir)(url, via);
    };
    const result = await smokeTest(dir, TARGET, failing);
    expect(result.failures).toEqual([`${CHECKS[4]}: connect ETIMEDOUT`, `${CHECKS[5]}: reset`]);
    expect(result.passed).toHaveLength(CHECKS.length - 2);
  });

  it('needs the release to have a home page and a 404 page', async () => {
    const dir = site({ '404.html': undefined });
    await expect(smokeTest(dir, TARGET, cloudFront(dir))).rejects.toThrow(`${dir} has no index.html or no 404.html.`);
  });
});

describe('prerendered', () => {
  const template = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const [home] = prerenderPages;

  it('finds nothing wrong with the home page as the build prerenders it, release included', () => {
    expect(prerendered(Buffer.from(renderDocument(template, home!, render('home'), RELEASE)))).toEqual([]);
  });

  it('fails the template before prerendering, a client-rendered shell, and a page without its release', () => {
    expect(prerendered(Buffer.from(template))).toEqual([
      'the home page has no prerendered markup',
      'the home page has no a heading',
      'the home page has no the release it belongs to',
      'the home page still has a prerender marker',
    ]);
    const shell = renderDocument(template, home!, '<!-- rendered in the browser -->', RELEASE).replace('<!-- rendered in the browser -->', '');
    expect(prerendered(Buffer.from(shell))).toEqual(['the home page has no prerendered markup', 'the home page has no a heading']);
    expect(prerendered(Buffer.from(renderDocument(template, home!, render('home'))))).toEqual([
      'the home page has no the release it belongs to',
    ]);
  });
});

describe('retrying', () => {
  it('retries a request that fails outright twice, waiting longer each time, but not a reply', async () => {
    const sleep = vi.fn(async () => {});
    const get = vi
      .fn<Get>()
      .mockRejectedValueOnce(new Error('reset'))
      .mockRejectedValueOnce(new Error('reset'))
      .mockResolvedValueOnce(reply(500));
    expect((await retrying(get, sleep)('https://example.com/', 'via')).status).toBe(500);
    expect(get.mock.calls).toEqual([
      ['https://example.com/', 'via'],
      ['https://example.com/', 'via'],
      ['https://example.com/', 'via'],
    ]);
    expect(sleep.mock.calls).toEqual([[2000], [4000]]);
  });

  it('gives up after the third failure', async () => {
    const get = vi.fn<Get>().mockRejectedValue(new Error('timed out'));
    await expect(retrying(get, async () => {})('https://example.com/')).rejects.toThrow('timed out');
    expect(get).toHaveBeenCalledTimes(3);
  });
});
