import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { render } from '../src/entry-server.tsx';
import { checkDist } from './check-dist-lib.ts';
import { prerenderPages, renderDocument } from './prerender-lib.ts';

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const [home, notFound] = prerenderPages;

// `vite build` swaps the dev entry script for hashed bundles in the head.
const bundles =
  '<script type="module" crossorigin src="/assets/index-mKM-b7Ju.js"></script>' +
  '<link rel="stylesheet" crossorigin href="/assets/index-Brn_qMvo.css">';
const template = source('../index.html')
  .replace('<script type="module" src="/src/main.tsx"></script>', '')
  .replace('</head>', `${bundles}</head>`);

// dist/ as a successful `npm run build` leaves it, with the markup App renders.
const build: Record<string, string> = {
  'index.html': renderDocument(template, home!, render('home')),
  '404.html': renderDocument(template, notFound!, render('not-found')),
  'robots.txt': source('../public/robots.txt'),
  'sitemap.xml': source('../public/sitemap.xml'),
  'assets/index-mKM-b7Ju.js': 'console.log("app");\n',
  'assets/index-Brn_qMvo.css': 'body { margin: 0; }\n',
};

// Writes the build with `changes` applied (null leaves a file out) to a temp
// directory removed after the test, and returns its directory URL.
async function dist(changes: Record<string, string | null> = {}): Promise<URL> {
  const dir = await mkdtemp(join(tmpdir(), 'check-dist-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  for (const [file, content] of Object.entries({ ...build, ...changes })) {
    if (content === null) continue;
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), content);
  }
  return pathToFileURL(dir + sep);
}

// Replaces the one occurrence of `from` in a build file.
function edit(file: string, from: string, to: string): Record<string, string> {
  const parts = build[file]!.split(from);
  expect(parts.length - 1, `occurrences of ${JSON.stringify(from)} in ${file}`).toBe(1);
  return { [file]: parts.join(to) };
}

describe('checkDist', () => {
  it('passes a complete prerendered build of the pages App renders', async () => {
    expect(checkDist(await dist())).toEqual([]);
  });

  it.each([
    {
      problem: 'a wrong home page title',
      file: 'index.html',
      from: '<title>Zachverse — Zach Davids</title>',
      to: '<title>Zachverse</title>',
      failure: 'dist/index.html does not contain "<title>Zachverse — Zach Davids</title>"',
    },
    {
      problem: 'a home page hydrating as another page',
      file: 'index.html',
      from: 'data-page="home"',
      to: 'data-page="not-found"',
      failure: 'dist/index.html does not contain "data-page=\\"home\\""',
    },
    {
      problem: 'a home page without the name heading',
      file: 'index.html',
      from: '<h1>Zach Davids</h1>',
      to: '<h1></h1>',
      failure: 'dist/index.html does not contain ">Zach Davids</h1>"',
    },
    // The template's meta description repeats the role and status, so these
    // two catch only rendered page content.
    {
      problem: 'a home page without the rendered role',
      file: 'index.html',
      from: '<p class="role">Senior Software Engineer at Amazon</p>',
      to: '',
      failure: 'dist/index.html does not contain ">Senior Software Engineer at Amazon</p>"',
    },
    {
      problem: 'a home page without the rendered status',
      file: 'index.html',
      from: '<p class="status">Interactive portfolio coming soon.</p>',
      to: '',
      failure: 'dist/index.html does not contain ">Interactive portfolio coming soon.</p>"',
    },
    {
      problem: 'a home page without the canonical link',
      file: 'index.html',
      from: '<link rel="canonical" href="https://zachdavids.com/" />',
      to: '',
      failure: 'dist/index.html does not contain "<link rel=\\"canonical\\" href=\\"https://zachdavids.com/\\" />"',
    },
    {
      problem: 'a home page missing the GitHub link',
      file: 'index.html',
      from: '<li><a href="https://github.com/zachdavids" rel="me">GitHub</a></li>',
      to: '',
      failure: 'dist/index.html does not contain "href=\\"https://github.com/zachdavids\\""',
    },
    {
      problem: 'a home page missing the LinkedIn link',
      file: 'index.html',
      from: '<li><a href="https://www.linkedin.com/in/zacharydavids/" rel="me">LinkedIn</a></li>',
      to: '',
      failure: 'dist/index.html does not contain "href=\\"https://www.linkedin.com/in/zacharydavids/\\""',
    },
    {
      problem: 'a home page missing the email link',
      file: 'index.html',
      from: '<li><a href="mailto:zach@zachdavids.com">Email</a></li>',
      to: '',
      failure: 'dist/index.html does not contain "href=\\"mailto:zach@zachdavids.com\\""',
    },
    {
      problem: 'a wrong 404 page title',
      file: '404.html',
      from: '<title>Page not found — Zachverse</title>',
      to: '<title>Zachverse — Zach Davids</title>',
      failure: 'dist/404.html does not contain "<title>Page not found — Zachverse</title>"',
    },
    {
      problem: 'a 404 page hydrating as the home page',
      file: '404.html',
      from: 'data-page="not-found"',
      to: 'data-page="home"',
      failure: 'dist/404.html does not contain "data-page=\\"not-found\\""',
    },
    {
      problem: 'a 404 page that search engines may index',
      file: '404.html',
      from: '<meta name="robots" content="noindex" />',
      to: '',
      failure: 'dist/404.html does not contain "<meta name=\\"robots\\" content=\\"noindex\\" />"',
    },
    {
      problem: 'a 404 page without its heading',
      file: '404.html',
      from: '<h1>Page not found</h1>',
      to: '<h1></h1>',
      failure: 'dist/404.html does not contain ">Page not found</h1>"',
    },
    {
      problem: 'a leftover head marker',
      file: 'index.html',
      from: '</head>',
      to: '<!--app-head--></head>',
      failure: 'dist/index.html still contains a prerender marker',
    },
    {
      problem: 'a leftover body marker',
      file: '404.html',
      from: '</main></div>',
      to: '</main><!--app-html--></div>',
      failure: 'dist/404.html still contains a prerender marker',
    },
    {
      problem: 'a page that loads no JavaScript bundle',
      file: '404.html',
      from: '<script type="module" crossorigin src="/assets/index-mKM-b7Ju.js"></script>',
      to: '',
      failure: 'dist/404.html references no JavaScript bundle',
    },
    {
      problem: 'a page that loads no stylesheet',
      file: 'index.html',
      from: '<link rel="stylesheet" crossorigin href="/assets/index-Brn_qMvo.css">',
      to: '',
      failure: 'dist/index.html references no stylesheet',
    },
    {
      problem: 'robots.txt without the sitemap line',
      file: 'robots.txt',
      from: 'Sitemap: https://zachdavids.com/sitemap.xml',
      to: '',
      failure: 'dist/robots.txt does not contain "Sitemap: https://zachdavids.com/sitemap.xml"',
    },
    {
      problem: 'a sitemap without the site origin',
      file: 'sitemap.xml',
      from: '<loc>https://zachdavids.com/</loc>',
      to: '<loc>https://www.zachdavids.com/</loc>',
      failure: 'dist/sitemap.xml does not contain "<loc>https://zachdavids.com/</loc>"',
    },
  ])('reports $problem', async ({ file, from, to, failure }) => {
    expect(checkDist(await dist(edit(file, from, to)))).toEqual([failure]);
  });

  it('reports a referenced asset that is missing on disk, once per page', async () => {
    expect(checkDist(await dist({ 'assets/index-Brn_qMvo.css': null }))).toEqual([
      'dist/index.html references missing /assets/index-Brn_qMvo.css',
      'dist/404.html references missing /assets/index-Brn_qMvo.css',
    ]);
  });

  // Vite's content hashes are 8 characters; icon-sprites ends in a 7-character word.
  it.each(['/assets/vendor.js', '/assets/logo-dark.svg', '/assets/icon-sprites.svg'])(
    'reports %s as having no content hash in its name',
    async (asset) => {
      const prefetch = `<link rel="prefetch" href="${asset}"></head>`;
      const changes = { ...edit('index.html', '</head>', prefetch), [asset.slice(1)]: '' };
      expect(checkDist(await dist(changes))).toEqual([`${asset} has no content hash in its name`]);
    },
  );

  it('accepts a hashed asset with a digit in its extension, such as a font', async () => {
    const preload = '<link rel="preload" href="/assets/inter-Q4_x-9Zb.woff2" as="font" crossorigin></head>';
    const changes = { ...edit('index.html', '</head>', preload), 'assets/inter-Q4_x-9Zb.woff2': '' };
    expect(checkDist(await dist(changes))).toEqual([]);
  });

  it.each(['index.html', '404.html', 'robots.txt', 'sitemap.xml'])(
    'reports a missing %s, then only the checks that needed it',
    async (file) => {
      const [first, ...rest] = checkDist(await dist({ [file]: null }));
      expect(first).toBe(`missing dist/${file}`);
      expect(rest.filter((failure) => !failure.startsWith(`dist/${file} `))).toEqual([]);
    },
  );

  it('reports every file as missing before a build has run', async () => {
    const failures = checkDist(new URL('never-built/', await dist()));
    expect(failures.filter((failure) => failure.startsWith('missing '))).toEqual([
      'missing dist/index.html',
      'missing dist/404.html',
      'missing dist/robots.txt',
      'missing dist/sitemap.xml',
    ]);
  });
});
