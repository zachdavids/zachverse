import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
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
  'favicon.svg': source('../public/favicon.svg'),
  'robots.txt': source('../public/robots.txt'),
  'sitemap.xml': source('../public/sitemap.xml'),
  'assets/index-mKM-b7Ju.js': 'console.log("app");\n',
  'assets/index-Brn_qMvo.css': 'body { margin: 0; }\n',
};

// Writes a project to a temp directory removed after the test, and returns its
// root URL: dist/ holds the build with `changes` applied (null leaves a file
// out), and public/ holds `publicFiles`.
async function project(
  changes: Record<string, string | null> = {},
  publicFiles: Record<string, string> = {},
): Promise<URL> {
  const root = await mkdtemp(join(tmpdir(), 'check-dist-'));
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const files = { ...prefixed('dist/', { ...build, ...changes }), ...prefixed('public/', publicFiles) };
  for (const [file, content] of Object.entries(files)) {
    if (content === null) continue;
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
  return pathToFileURL(root + sep);
}

function prefixed<T>(dir: string, files: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(files).map(([file, content]) => [dir + file, content]));
}

// Replaces the one occurrence of `from` in a build file.
function edit(file: string, from: string, to: string): Record<string, string> {
  const parts = build[file]!.split(from);
  expect(parts.length - 1, `occurrences of ${JSON.stringify(from)} in ${file}`).toBe(1);
  return { [file]: parts.join(to) };
}

// One edit to a build file, plus any `files` the edited page needs, and the one failure it causes.
interface Problem {
  problem: string;
  file: string;
  from: string;
  to: string;
  files?: Record<string, string>;
  failure: string;
}

describe('checkDist', () => {
  it('passes a complete prerendered build of the pages App renders', async () => {
    expect(checkDist(await project())).toEqual([]);
  });

  it('passes a build whose content has characters React escapes', async () => {
    vi.resetModules();
    vi.doMock('../src/content.ts', async (importOriginal) => {
      const { profile, site } = await importOriginal<typeof import('../src/content.ts')>();
      return {
        profile: {
          ...profile,
          name: 'Zach "ZD" Davids',
          role: 'Engineer at R&D <Labs>',
          status: "It's coming soon.",
          links: [{ label: 'Email', href: 'mailto:zach@zachdavids.com?subject=Hi&body=Hello' }],
        },
        site: { ...site, description: `Zach's R&D "notes" <soon>` },
      };
    });
    onTestFinished(() => {
      vi.doUnmock('../src/content.ts');
    });
    // Fresh copies of every module that reads the content, as a build with it would run.
    const { render: renderPage } = await import('../src/entry-server.tsx');
    const { prerenderPages: pages, renderDocument: renderPageDocument } = await import('./prerender-lib.ts');
    const { checkDist: check } = await import('./check-dist-lib.ts');
    const changes = Object.fromEntries(
      pages.map((page) => [page.file, renderPageDocument(template, page, renderPage(page.id))]),
    );
    expect(check(await project(changes))).toEqual([]);
  });

  it.each<Problem>([
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
    // The meta description repeats the role and status, so these two catch
    // only rendered page content.
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
    // Both pages share the template's head.
    {
      problem: 'a page rendered in quirks mode',
      file: '404.html',
      from: '<!doctype html>',
      to: '',
      failure: 'dist/404.html does not contain "<!doctype html>"',
    },
    {
      problem: 'a page without its language',
      file: 'index.html',
      from: '<html lang="en">',
      to: '<html>',
      failure: 'dist/index.html does not contain "<html lang=\\"en\\">"',
    },
    {
      problem: 'a page without its character encoding',
      file: '404.html',
      from: '<meta charset="UTF-8" />',
      to: '',
      failure: 'dist/404.html does not contain "<meta charset=\\"UTF-8\\" />"',
    },
    {
      problem: 'a page laid out for a desktop-width viewport on phones',
      file: 'index.html',
      from: 'content="width=device-width, initial-scale=1"',
      to: 'content="width=1024"',
      failure:
        'dist/index.html does not contain "<meta name=\\"viewport\\" content=\\"width=device-width, initial-scale=1\\" />"',
    },
    {
      problem: 'a description that no longer matches the profile',
      file: '404.html',
      from: 'Engineer at Amazon. Interactive',
      to: 'Engineer at Example. Interactive',
      failure:
        'dist/404.html does not contain "<meta name=\\"description\\" content=\\"Zach Davids, Senior Software Engineer at Amazon. Interactive portfolio coming soon.\\" />"',
    },
    {
      problem: 'a mistyped icon link',
      file: 'index.html',
      from: 'href="/favicon.svg"',
      to: 'href="/favicon.svgg"',
      failure: 'dist/index.html references missing /favicon.svgg',
    },
    {
      problem: 'a relative icon link, which resolves elsewhere on nested paths',
      file: '404.html',
      from: 'href="/favicon.svg"',
      to: 'href="./favicon.svg"',
      failure: 'dist/404.html references ./favicon.svg, a relative URL that breaks on nested paths; start it with /',
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
    // Each page keeps an asset with .js or .css inside its name, which a substring match would take for a bundle.
    {
      problem: 'a page that loads no JavaScript bundle',
      file: '404.html',
      from: '<script type="module" crossorigin src="/assets/index-mKM-b7Ju.js"></script>',
      to: '<link rel="preload" href="/assets/content-Qx7Lm2Pa.json" as="fetch" crossorigin>',
      files: { 'assets/content-Qx7Lm2Pa.json': '{}\n' },
      failure: 'dist/404.html references no JavaScript bundle',
    },
    {
      problem: 'a page that loads no stylesheet',
      file: 'index.html',
      from: '<link rel="stylesheet" crossorigin href="/assets/index-Brn_qMvo.css">',
      to: '<link rel="prefetch" href="/assets/theme.css-Qx7Lm2Pa.svg">',
      files: { 'assets/theme.css-Qx7Lm2Pa.svg': '<svg/>\n' },
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
  ])('reports $problem', async ({ file, from, to, files, failure }) => {
    expect(checkDist(await project({ ...edit(file, from, to), ...files }))).toEqual([failure]);
  });

  it.each(['/favicon.svg', '/assets/index-Brn_qMvo.css'])('reports %s missing on disk, once per page', async (path) => {
    expect(checkDist(await project({ [path.slice(1)]: null }))).toEqual([
      `dist/index.html references missing ${path}`,
      `dist/404.html references missing ${path}`,
    ]);
  });

  it('resolves links to pages as CloudFront does', async () => {
    // CloudFront serves /about from about/index.html, /notes/ from notes/index.html, and
    // /.well-known/ paths as they are. So /talks is missing although talks/ exists, and
    // /notes.v2 is missing although notes.v2/index.html exists: its dot makes it a file name.
    const links = [
      '<a href="/about">About</a>',
      '<a href="/notes/">Notes</a>',
      '<a href="/talks">Talks</a>',
      '<a href="/.well-known/apple-app-site-association">Apps</a>',
      '<a href="/notes.v2">Notes v2</a>',
    ].join('');
    const changes = {
      ...edit('index.html', '</main>', `${links}</main>`),
      'about/index.html': '',
      'notes/index.html': '',
      'talks/slides.pdf': '',
      '.well-known/apple-app-site-association': '{}\n',
      'notes.v2/index.html': '',
    };
    expect(checkDist(await project(changes))).toEqual([
      'dist/index.html references missing /talks',
      'dist/index.html references missing /notes.v2',
    ]);
  });

  // Also a fragment with no query, as in an SVG sprite reference such as /assets/icons-AbCd1234.svg#github.
  it.each(['?v=2#app', '#app'])('checks the file a URL names, without its query or fragment: %s', async (suffix) => {
    const changes = edit('404.html', 'src="/assets/index-mKM-b7Ju.js"', `src="/assets/index-mKM-b7Ju.js${suffix}"`);
    expect(checkDist(await project(changes))).toEqual([]);
  });

  it('leaves protocol-relative URLs to their hosts', async () => {
    const preconnect = '<link rel="preconnect" href="//cdn.example.com"></head>';
    expect(checkDist(await project(edit('index.html', '</head>', preconnect)))).toEqual([]);
  });

  // What Vite's base: './' does to a page: the bundle URLs in /404.html would
  // resolve under /a/b/ when it is served for /a/b/c.
  it('reports a bundle loaded by a relative URL', async () => {
    const changes = edit('404.html', 'src="/assets/index-mKM-b7Ju.js"', 'src="./assets/index-mKM-b7Ju.js"');
    expect(checkDist(await project(changes))).toEqual([
      'dist/404.html references ./assets/index-mKM-b7Ju.js, a relative URL that breaks on nested paths; start it with /',
      'dist/404.html references no JavaScript bundle',
    ]);
  });

  // A content hash is a dash and 8 or more name characters right before the
  // extension: icon-sprites has 7, and vendor-libraries is followed by .min.
  it.each([
    '/assets/vendor.js',
    '/assets/logo-dark.svg',
    '/assets/icon-sprites.svg',
    '/assets/vendor-libraries.min.js',
    '/assets/highlight-github-dark.min.css',
  ])('reports %s as having no content hash in its name', async (asset) => {
    const prefetch = `<link rel="prefetch" href="${asset}"></head>`;
    const changes = { ...edit('index.html', '</head>', prefetch), [asset.slice(1)]: '' };
    expect(checkDist(await project(changes))).toEqual([`${asset} has no content hash in its name`]);
  });

  // Longer words pass the name check, so a copy from public/ is caught by its origin.
  it.each(['/assets/background-gradient.svg', '/assets/index-component.js'])(
    'reports %s as copied unhashed from public/',
    async (asset) => {
      const copy = { [asset.slice(1)]: '' };
      const changes = { ...edit('index.html', '</head>', `<link rel="prefetch" href="${asset}"></head>`), ...copy };
      expect(checkDist(await project(changes, copy))).toEqual([`${asset} is copied unhashed from public/`]);
    },
  );

  it('accepts a hashed asset with a digit in its extension, such as a font', async () => {
    const preload = '<link rel="preload" href="/assets/inter-Q4_x-9Zb.woff2" as="font" crossorigin></head>';
    const changes = { ...edit('index.html', '</head>', preload), 'assets/inter-Q4_x-9Zb.woff2': '' };
    expect(checkDist(await project(changes))).toEqual([]);
  });

  // The 404 page links home, so its link needs index.html too.
  it.each([
    ['index.html', ['dist/404.html references missing /']],
    ['404.html', []],
    ['robots.txt', []],
    ['sitemap.xml', []],
  ])('reports a missing %s, then only the checks that needed it', async (file, others) => {
    const [first, ...rest] = checkDist(await project({ [file]: null }));
    expect(first).toBe(`missing dist/${file}`);
    expect(rest.filter((failure) => !failure.startsWith(`dist/${file} `))).toEqual(others);
  });

  it('reports every file as missing before a build has run', async () => {
    const failures = checkDist(new URL('never-built/', await project()));
    expect(failures.filter((failure) => failure.startsWith('missing '))).toEqual([
      'missing dist/index.html',
      'missing dist/404.html',
      'missing dist/robots.txt',
      'missing dist/sitemap.xml',
    ]);
  });
});
