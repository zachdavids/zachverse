import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { servedFile } from '../scripts/check-dist-lib.ts';
import { servedPath } from '../scripts/release-lib.ts';
import { pages, site } from '../src/content/index.ts';

// infra/functions/viewer-request.js decides which object CloudFront asks S3 for. check:dist (servedFile), the smoke
// test, and the browser check's local server (both servedPath) copy that mapping, since they can't load infra/. These
// tests run the real function, its source read as infra/lib/viewer-request.ts reads it, on the same paths as each copy
// (docs/phase-2-inputs.md, "Path mapping"). They read the file rather than import infra/, which this package's type
// check leaves alone.
const apex = new URL(site.origin).host;
const source = readFileSync(new URL('../infra/functions/viewer-request.js', import.meta.url), 'utf8');
for (const placeholder of ['__APEX_HOST__', '__WWW_HOST__']) {
  if (source.split(placeholder).length !== 2) throw new Error(`viewer-request.js must contain ${placeholder} once`);
}
const handler = runInNewContext(
  `${source.replace('__APEX_HOST__', apex).replace('__WWW_HOST__', `www.${apex}`)}\nhandler;`,
) as (event: unknown) => { uri?: string; statusCode?: number; headers?: { location?: { value: string } } };

// What the function does with a request for path at host.
const viewerRequest = (path: string, host = apex) =>
  handler({ request: { uri: path, headers: { host: { value: host } }, querystring: {} } });

// The key CloudFront asks S3 for when the apex is requested at path.
const keyFor = (path: string) => viewerRequest(path).uri!.slice(1);

// Every kind of path the site serves or a visitor may ask for: each page in the table at its address, without its
// trailing slash, and as its own file; the files the build writes; paths with dots before and in their last segment;
// hidden names; repeated slashes; and escapes, which the function and the copies leave for S3 to decode.
const addressed = pages.flatMap(({ path }) => (path === null ? [] : [path]));
const PATHS = [
  ...addressed,
  ...addressed.filter((path) => path !== '/').map((path) => path.slice(0, -1)),
  ...pages.map(({ file }) => `/${file}`),
  '/favicon.svg',
  '/og-image.png',
  '/robots.txt',
  '/sitemap.xml',
  '/assets/index-AbCd1234.js',
  '/assets/index-AbCd1234.css',
  '/assets/',
  '/resume/x',
  '/a/b/c',
  '/a/b/c/',
  '/a.b/c',
  '/a.b/c/',
  '/a/b.c',
  '/v1.2',
  '/.hidden',
  '/x/.y',
  '/x/y.',
  '//double//slashes',
  '/%7Euser/',
  '/caf%C3%A9',
  '/_releases/history.json',
];
// The function passes these through as they are; servedPath leaves out that exception.
const WELL_KNOWN = ['/.well-known/security.txt', '/.well-known/acme-challenge/token'];

describe('the viewer-request function', () => {
  it('maps each page in the table to its file, at its address and without its trailing slash', () => {
    for (const { path, file } of pages) {
      if (path === null) continue;
      expect(keyFor(path), path).toBe(file);
      if (path !== '/') expect(keyFor(path.slice(0, -1)), path).toBe(file);
    }
  });

  it('is the real function: it sends www to the apex, keeping the path', () => {
    const reply = viewerRequest('/resume/', `www.${apex}`);
    expect([reply.statusCode, reply.headers?.location?.value]).toEqual([301, `https://${apex}/resume/`]);
  });
});

describe("check:dist's copy of the mapping (servedFile)", () => {
  it.each([...PATHS, ...WELL_KNOWN])('maps %s as the function does', (path) => {
    expect(servedFile(path)).toBe(`/${keyFor(path)}`);
  });
});

describe("the smoke test's and the local server's copy of the mapping (servedPath)", () => {
  it.each(PATHS)('maps %s as the function does', (path) => {
    expect(servedPath(path)).toBe(keyFor(path));
  });

  // So a /.well-known/ file without a dot in its name fails closed in those checks (ADR 0006, "Limits").
  it("leaves out the function's /.well-known/ exception", () => {
    expect(WELL_KNOWN.map(servedPath)).toEqual(['.well-known/security.txt', '.well-known/acme-challenge/token/index.html']);
    expect(WELL_KNOWN.map(keyFor)).toEqual(['.well-known/security.txt', '.well-known/acme-challenge/token']);
  });
});
