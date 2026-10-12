import { describe, expect, it } from 'vitest';
import { production } from '../lib/config';
import { viewerRequestCode } from '../lib/viewer-request';

// CloudFront Functions are plain scripts with a global `handler`; evaluate the
// exact code the stack deploys and call it with CloudFront-shaped events.
const handler = new Function(`${viewerRequestCode(production)}\nreturn handler;`)() as (event: unknown) => any;

function viewerRequest(uri: string, host = 'zachdavids.com', querystring: Record<string, unknown> = {}) {
  return handler({ version: '1.0', context: { eventType: 'viewer-request' }, request: { method: 'GET', uri, querystring, headers: { host: { value: host } }, cookies: {} } });
}

describe('www to apex redirect', () => {
  it('permanently redirects www to the apex, keeping path and query string', () => {
    const response = viewerRequest('/notes/', 'www.zachdavids.com', {
      utm_source: { value: 'x' },
      tag: { value: 'a', multiValue: [{ value: 'a' }, { value: 'b' }] },
      flag: { value: '' },
    });
    expect(response.statusCode).toBe(301);
    expect(response.headers.location.value).toBe('https://zachdavids.com/notes/?utm_source=x&tag=a&tag=b&flag');
  });

  it('matches the www host case-insensitively', () => {
    expect(viewerRequest('/', 'WWW.ZachDavids.com').headers.location.value).toBe('https://zachdavids.com/');
  });

  it('does not redirect the apex or the CloudFront default hostname', () => {
    expect(viewerRequest('/', 'zachdavids.com').statusCode).toBeUndefined();
    expect(viewerRequest('/', 'd111111abcdef8.cloudfront.net').statusCode).toBeUndefined();
  });
});

describe('index.html mapping', () => {
  it.each([
    ['/', '/index.html'],
    ['/about/', '/about/index.html'],
    ['/about', '/about/index.html'],
    ['/v1.2/notes', '/v1.2/notes/index.html'],
    ['/assets/index-mKM-b7Ju.js', '/assets/index-mKM-b7Ju.js'],
    ['/404.html', '/404.html'],
    ['/robots.txt', '/robots.txt'],
    ['/.well-known/security.txt', '/.well-known/security.txt'],
    ['/.well-known/apple-app-site-association', '/.well-known/apple-app-site-association'],
  ])('%s -> %s', (uri, expected) => {
    expect(viewerRequest(uri).uri).toBe(expected);
  });
});

describe('function source', () => {
  it('stays within the 10 KB CloudFront Functions size limit', () => {
    expect(Buffer.byteLength(viewerRequestCode(production))).toBeLessThan(10 * 1024);
  });
});
