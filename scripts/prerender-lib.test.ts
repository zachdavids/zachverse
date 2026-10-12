import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { prerender, prerenderPages, renderDocument } from './prerender-lib.ts';

const template = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const [home, notFound] = prerenderPages;

describe('renderDocument', () => {
  it('fills the title, head, page id, and markup for the home page', () => {
    const html = renderDocument(template, home!, '<main>hello</main>');
    expect(html).toContain('<title>Zachverse — Zach Davids</title>');
    expect(html).toContain('<link rel="canonical" href="https://zachdavids.com/" />');
    expect(html).toContain('<div id="root" data-page="home"><main>hello</main></div>');
    expect(html).not.toContain('<!--app-');
    expect(html).not.toContain('noindex');
  });

  it('marks the 404 page noindex and records its page id for hydration', () => {
    const html = renderDocument(template, notFound!, '<main>missing</main>');
    expect(html).toContain('<title>Page not found — Zachverse</title>');
    expect(html).toContain('<meta name="robots" content="noindex" />');
    expect(html).toContain('data-page="not-found"');
    expect(html).not.toContain('rel="canonical"');
  });

  it('rejects empty markup and templates without the expected markers', () => {
    expect(() => renderDocument(template, home!, '  ')).toThrow(/empty/);
    expect(() => renderDocument(template.replace('<!--app-html-->', ''), home!, '<main />')).toThrow(
      /exactly one/,
    );
  });

  it('reports how many title tags or markers it found when there is not exactly one', () => {
    const withoutTitle = template.replace(/<title>[^<]*<\/title>/, '');
    expect(() => renderDocument(withoutTitle, home!, '<main />')).toThrow(
      'Expected exactly one /<title>[^<]*<\\/title>/ in the HTML template, found 0',
    );
    const twoTitles = template.replace('</head>', '<title>Other</title></head>');
    expect(() => renderDocument(twoTitles, home!, '<main />')).toThrow(
      'Expected exactly one /<title>[^<]*<\\/title>/ in the HTML template, found 2',
    );
    const twoHeadMarkers = template.replace('<!--app-head-->', '<!--app-head--><!--app-head-->');
    expect(() => renderDocument(twoHeadMarkers, home!, '<main />')).toThrow(
      'Expected exactly one <!--app-head--> in the HTML template, found 2',
    );
  });

  it('does not interpret $ patterns in rendered markup', () => {
    expect(renderDocument(template, home!, '<p>$& $1</p>')).toContain('<p>$& $1</p>');
  });
});

describe('prerender', () => {
  // Stands in for the `vite build --ssr` output.
  const serverEntry = 'export const render = (page) => "<main>rendered " + page + "</main>";\n';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Creates a project root holding `files` in a temp directory removed after
  // the test, and returns its directory URL.
  async function projectRoot(files: Record<string, string>): Promise<URL> {
    const root = await mkdtemp(join(tmpdir(), 'prerender-'));
    onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
    for (const [file, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), content);
    }
    return pathToFileURL(root + sep);
  }

  const readDist = (rootUrl: URL, file: string) => readFile(new URL(`dist/${file}`, rootUrl), 'utf8');

  it('writes every page from the client template and server render, then removes dist-ssr', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rootUrl = await projectRoot({ 'dist/index.html': template, 'dist-ssr/entry-server.js': serverEntry });

    await prerender(rootUrl);

    const index = await readDist(rootUrl, 'index.html');
    expect(index).toContain('<title>Zachverse — Zach Davids</title>');
    expect(index).toContain('<link rel="canonical" href="https://zachdavids.com/" />');
    expect(index).toContain('<div id="root" data-page="home"><main>rendered home</main></div>');
    expect(index).toBe(renderDocument(template, home!, '<main>rendered home</main>'));

    // Rendered from the original template, not the index.html written just before it.
    const notFoundPage = await readDist(rootUrl, '404.html');
    expect(notFoundPage).toContain('<title>Page not found — Zachverse</title>');
    expect(notFoundPage).toContain('<meta name="robots" content="noindex" />');
    expect(notFoundPage).toContain('<div id="root" data-page="not-found"><main>rendered not-found</main></div>');
    expect(notFoundPage).toBe(renderDocument(template, notFound!, '<main>rendered not-found</main>'));

    expect(existsSync(new URL('dist-ssr/', rootUrl))).toBe(false);
    expect(log.mock.calls).toEqual([
      ['prerendered home -> dist/index.html'],
      ['prerendered not-found -> dist/404.html'],
    ]);
  });

  it('fails when the client build has not produced dist/index.html', async () => {
    const rootUrl = await projectRoot({ 'dist-ssr/entry-server.js': serverEntry });

    await expect(prerender(rootUrl)).rejects.toMatchObject({
      code: 'ENOENT',
      path: fileURLToPath(new URL('dist/index.html', rootUrl)),
    });
  });

  it('fails when the server build has not produced dist-ssr/entry-server.js', async () => {
    const rootUrl = await projectRoot({ 'dist/index.html': template });

    await expect(prerender(rootUrl)).rejects.toMatchObject({
      code: 'ERR_MODULE_NOT_FOUND',
      message: expect.stringMatching(/dist-ssr[\\/]entry-server\.js/),
    });
    expect(await readDist(rootUrl, 'index.html')).toBe(template);
  });

  it('stops at an empty server render without writing pages, logging, or removing dist-ssr', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rootUrl = await projectRoot({
      'dist/index.html': template,
      'dist-ssr/entry-server.js': 'export const render = () => "  ";\n',
    });

    await expect(prerender(rootUrl)).rejects.toThrow('Prerendered markup for "home" is empty');
    expect(await readDist(rootUrl, 'index.html')).toBe(template);
    expect(existsSync(new URL('dist/404.html', rootUrl))).toBe(false);
    // The SSR bundle is kept for debugging, and no page is reported as prerendered.
    expect(existsSync(new URL('dist-ssr/entry-server.js', rootUrl))).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });
});
