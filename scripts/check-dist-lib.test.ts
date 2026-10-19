import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { render } from '../src/entry-server.tsx';
import { checkDist, releaseProblems } from './check-dist-lib.ts';
import { prerenderPages, renderDocument } from './prerender-lib.ts';
import { siteFiles } from './release-lib.ts';
import { distributionRequests, SMOKE_REQUEST_BUDGET } from './smoke-lib.ts';

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

  it("requires each page to name the deploy build's release exactly once, and other builds' pages to name none", async () => {
    const release = '0123456789abcdef0123456789abcdef01234567';
    const named = {
      'index.html': renderDocument(template, home!, render('home'), release),
      '404.html': renderDocument(template, notFound!, render('not-found'), release),
    };
    expect(checkDist(await project(named), release)).toEqual([]);
    expect(checkDist(await project(named))).toEqual([
      'dist/index.html names a release, but no RELEASE_COMMIT was given',
      'dist/404.html names a release, but no RELEASE_COMMIT was given',
    ]);
    expect(checkDist(await project(), release)).toEqual([
      `dist/index.html does not name release ${release} exactly once`,
      `dist/404.html does not name release ${release} exactly once`,
    ]);
    const other = 'f'.repeat(40);
    const twice = named['index.html'].replace('</head>', `<meta name="zachverse-release" content="${release}" /></head>`);
    expect(
      checkDist(
        await project({
          'index.html': twice,
          '404.html': renderDocument(template, notFound!, render('not-found'), other),
        }),
        release,
      ),
    ).toEqual([
      `dist/index.html does not name release ${release} exactly once`,
      `dist/404.html does not name release ${release} exactly once`,
    ]);
  });

  it('passes a build whose content has characters React escapes', async () => {
    vi.resetModules();
    vi.doMock('../src/content/index.ts', async (importOriginal) => {
      const { profile, site } = await importOriginal<typeof import('../src/content/index.ts')>();
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
      vi.doUnmock('../src/content/index.ts');
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
    // S3 matches keys by exact name, and so does the check, so this fails on NTFS too, which ignores case.
    {
      problem: 'an icon link in the wrong case',
      file: 'index.html',
      from: 'href="/favicon.svg"',
      to: 'href="/FAVICON.SVG"',
      failure: 'dist/index.html references missing /FAVICON.SVG',
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

  // S3 decodes the request path to find a key: /100%25.svg names 100%.svg, /icon%402x.png names icon@2x.png
  // (decodeURI would keep the %40), and /100%.svg names nothing.
  it('decodes escapes to find a file, and reports a path with a malformed escape as missing', async () => {
    const links = [
      '<a href="/100%25.svg">Escaped</a>',
      '<a href="/icon%402x.png">Escaped</a>',
      '<a href="/100%.svg">Malformed</a>',
    ].join('');
    const changes = { ...edit('index.html', '</main>', `${links}</main>`), '100%.svg': '', 'icon@2x.png': '' };
    expect(checkDist(await project(changes))).toEqual(['dist/index.html references missing /100%.svg']);
  });

  // The build never emits an encoded slash or backslash, and the CloudFront docs don't say whether S3 then reads
  // one as a separator, so a path with either names no key, even where its decoded name is a file's.
  it.each(['%2F', '%2f', '%5C', '%5c'])('reports a path with the encoded separator %s as missing', async (escape) => {
    const path = `/assets${escape}index-mKM-b7Ju.js`;
    // A file under the decoded name. For %5C that name holds a backslash, which Linux keeps in a file name and
    // Windows reads as a separator.
    const decoded = { [decodeURIComponent(path).slice(1)]: '' };
    const changes = { ...edit('index.html', '</main>', `<a href="${path}">App</a></main>`), ...decoded };
    expect(checkDist(await project(changes))).toEqual([`dist/index.html references missing ${path}`]);
  });

  // A browser resolves dot segments, %2E%2E too, against the site root, where '..' stops at '/': /../favicon.svg
  // requests /favicon.svg, and /x/.. requests /. The site has no dist/ folder, nor public/ or DIST/, which NTFS
  // would take for dist/.
  it('looks up a path with dot segments, even one above the site root, where a browser requests it', async () => {
    const links = [
      '<a href="/../favicon.svg">Icon</a>',
      '<a href="/x/..">Home</a>',
      '<a href="/../dist/favicon.svg">Icon</a>',
      '<a href="/%2E%2E/dist/favicon.svg">Icon</a>',
      '<a href="/../public/favicon.svg">Icon</a>',
      '<a href="/../DIST/favicon.svg">Icon</a>',
    ].join('');
    const changes = edit('index.html', '</main>', `${links}</main>`);
    expect(checkDist(await project(changes, { 'favicon.svg': '' }))).toEqual([
      'dist/index.html references missing /../dist/favicon.svg',
      'dist/index.html references missing /%2E%2E/dist/favicon.svg',
      'dist/index.html references missing /../public/favicon.svg',
      'dist/index.html references missing /../DIST/favicon.svg',
    ]);
  });

  it('leaves protocol-relative URLs to their hosts', async () => {
    const preconnect = '<link rel="preconnect" href="//cdn.example.com"></head>';
    expect(checkDist(await project(edit('index.html', '</head>', preconnect)))).toEqual([]);
  });

  // A browser reads a backslash as a slash, so it takes /\other.invalid/favicon.svg to another host, not to the
  // site's /favicon.svg, and finds no valid host in /\a b/favicon.svg.
  it('reports a path that a browser takes to another host, or to none, as missing', async () => {
    const links = '<a href="/\\other.invalid/favicon.svg">Icon</a><a href="/\\a b/favicon.svg">Icon</a></main>';
    expect(checkDist(await project(edit('index.html', '</main>', links)))).toEqual([
      'dist/index.html references missing /\\other.invalid/favicon.svg',
      'dist/index.html references missing /\\a b/favicon.svg',
    ]);
  });

  it("accepts a bare fragment, which resolves against the page's own URL, so it works on any path", async () => {
    const skip = '<a href="#main">Skip to content</a><main';
    const changes = { ...edit('index.html', '<main', skip), ...edit('404.html', '<main', skip) };
    expect(checkDist(await project(changes))).toEqual([]);
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

  // The asset checks apply to the key a browser's request names: /x/../assets/vendor.js and /%61ssets/vendor.js are
  // an unhashed asset, /assets/../favicon.svg, which requests /favicon.svg, is no asset, although public/ has that
  // file, and a copy from public/ is found however its reference is spelled.
  it('checks the asset a path with dot segments or escapes requests', async () => {
    const hrefs = [
      '/x/../assets/vendor.js',
      '/%61ssets/vendor.js',
      '/assets/../favicon.svg',
      '/x/../assets/background-gradient.svg',
      '/%61ssets/background-gradient.svg',
    ];
    const links = hrefs.map((href) => `<link rel="prefetch" href="${href}">`).join('');
    const copy = { 'assets/background-gradient.svg': '' };
    const changes = { ...edit('index.html', '</head>', `${links}</head>`), 'assets/vendor.js': '', ...copy };
    expect(checkDist(await project(changes, { 'favicon.svg': '', ...copy }))).toEqual([
      '/x/../assets/vendor.js has no content hash in its name',
      '/%61ssets/vendor.js has no content hash in its name',
      '/x/../assets/background-gradient.svg is copied unhashed from public/',
      '/%61ssets/background-gradient.svg is copied unhashed from public/',
    ]);
  });

  // S3 decodes the name, so an escaped bundle and stylesheet are still hashed build outputs.
  it('accepts a bundle and stylesheet whose names hold escapes', async () => {
    const page = build['404.html']!
      .replace('src="/assets/index-mKM-b7Ju.js"', 'src="/assets/index-mKM-b7Ju.j%73"')
      .replace('href="/assets/index-Brn_qMvo.css"', 'href="/assets/index-Brn_qMvo.c%73s"');
    expect(page).toContain('.j%73"');
    expect(page).toContain('.c%73s"');
    expect(checkDist(await project({ '404.html': page }))).toEqual([]);
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

  // Vite copies what a public/ symlink points at, so a linked file's copy is still unhashed.
  it('reports a file symlinked into public/ as copied unhashed', async (ctx) => {
    const asset = '/assets/vendor-component.js';
    const prefetch = `<link rel="prefetch" href="${asset}"></head>`;
    const root = await project({ ...edit('index.html', '</head>', prefetch), [asset.slice(1)]: '' });
    // Outside public/, so only the link puts it there.
    const target = new URL('vendor-component.js', root);
    await writeFile(target, '');
    await mkdir(new URL('public/assets/', root), { recursive: true });
    try {
      await symlink(target, new URL(`public${asset}`, root), 'file');
    } catch (error) {
      // Windows allows file symlinks only in Developer Mode or when elevated; CI on Linux always runs this.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') ctx.skip('file symlinks are not permitted here');
      throw error;
    }
    expect(checkDist(root)).toEqual([`${asset} is copied unhashed from public/`]);
  });

  // Vite keeps public/'s names, so a wrong-case name matches neither the copy nor its source on any host.
  it('reports a wrong-case reference to a copy from public/ as missing, not as copied', async () => {
    const copy = { 'assets/Background-Gradient.svg': '' };
    const prefetch = '<link rel="prefetch" href="/assets/background-gradient.svg"></head>';
    const changes = { ...edit('index.html', '</head>', prefetch), ...copy };
    expect(checkDist(await project(changes, copy))).toEqual([
      'dist/index.html references missing /assets/background-gradient.svg',
    ]);
  });

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

  // A file where a folder belongs holds no files.
  it('reports every file as missing when dist is a file', async () => {
    const root = new URL('built-to-a-file/', await project());
    await mkdir(root);
    await writeFile(new URL('dist', root), '');
    expect(checkDist(root).filter((failure) => failure.startsWith('missing '))).toEqual([
      'missing dist/index.html',
      'missing dist/404.html',
      'missing dist/robots.txt',
      'missing dist/sitemap.xml',
    ]);
  });

  it('finds no copies in a public that is a file', async () => {
    const root = await project();
    await writeFile(new URL('public', root), '');
    expect(checkDist(root)).toEqual([]);
  });

  // A link whose target is gone names no file, wherever it is. A junction needs no extra privileges on Windows;
  // other systems ignore the type and make a plain symlink.
  it('reports a reference to a dangling link as missing, and ignores unreferenced ones', async () => {
    const changes = edit('index.html', '</main>', '<a href="/archive/">Archive</a></main>');
    const root = await project(changes, { 'favicon.svg': '' });
    for (const link of ['dist/archive', 'dist/assets/old', 'public/old']) {
      await symlink(new URL('missing', root), new URL(link, root), 'junction');
    }
    expect(checkDist(root)).toEqual(['dist/index.html references missing /archive/']);
  });
});

describe('releaseProblems', () => {
  // public/ as the repository has it; Vite copies these into dist/ as they are.
  const publicDir = { 'favicon.svg': build['favicon.svg']!, 'robots.txt': build['robots.txt']!, 'sitemap.xml': build['sitemap.xml']! };

  it('passes a build a release can publish: pages, files from public/, and hashed assets under assets/', async () => {
    expect(releaseProblems(await project({ 'about/index.html': build['index.html']! }, publicDir))).toEqual([]);
  });

  it('reports a file the build emits outside assets/ that is not a page, as a lazily loaded chunk could be', async () => {
    const root = await project({ 'chunks/lazy-AbCd1234.js': 'export {};\n', 'favicon.svg': null }, publicDir);
    expect(releaseProblems(root)).toEqual([
      'dist/chunks/lazy-AbCd1234.js is built outside assets/, so a release would publish it as a page',
    ]);
    // A file Vite did not copy from public/ is the build's own, even with a name public/ might have.
    expect(releaseProblems(await project())).toEqual([
      'dist/favicon.svg is built outside assets/, so a release would publish it as a page',
      'dist/robots.txt is built outside assets/, so a release would publish it as a page',
      'dist/sitemap.xml is built outside assets/, so a release would publish it as a page',
    ]);
  });

  it('reports a file a release would refuse, as the release scripts word it', async () => {
    const root = await project({ 'assets/vendor.js': 'x\n', 'assets/index-AbCd12345.js': 'x\n' }, publicDir);
    expect(releaseProblems(root)).toEqual([
      // The first file a release refuses; the hash rule is the one check:dist applies to references.
      'dist/ cannot be released: assets/index-AbCd12345.js has no content hash in its name, so it cannot be cached as immutable.',
    ]);
  });

  it('reports a build whose smoke test would send more requests than its budget, and passes one at the budget', async () => {
    const base = distributionRequests(siteFiles(fileURLToPath(new URL('dist/', await project({}, publicDir)))));
    // Each page adds one request: its own address. Its references are files the smoke test requests anyway.
    const pages = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`p/${i}/index.html`, build['index.html']!]));
    expect(releaseProblems(await project(pages(SMOKE_REQUEST_BUDGET - base), publicDir))).toEqual([]);
    expect(releaseProblems(await project(pages(SMOKE_REQUEST_BUDGET - base + 1), publicDir))).toEqual([
      `dist/ would take the smoke test ${SMOKE_REQUEST_BUDGET + 1} requests through the distribution, more than its ` +
        `budget of ${SMOKE_REQUEST_BUDGET}, half the web ACL's rate limit for one address (ADR 0007)`,
    ]);
  });

  it('leaves a missing build to checkDist', async () => {
    const root = await project(Object.fromEntries(Object.keys(build).map((file) => [file, null])));
    expect(releaseProblems(root)).toEqual([]);
  });
});
