import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { pages, resume, site } from '../src/content/index.ts';
import { render } from '../src/entry-server.tsx';
import { BUDGETS, budgetProblems, checkDist, measureDist, releaseProblems, sizeReport } from './check-dist-lib.ts';
import { escapeHtml, prerenderPages, profilePageData, renderDocument } from './prerender-lib.ts';
import { siteFiles } from './release-lib.ts';
import { distributionRequests, SMOKE_REQUEST_BUDGET } from './smoke-lib.ts';

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

// `vite build` swaps the dev entry script for hashed bundles in the head.
const bundles =
  '<script type="module" crossorigin src="/assets/index-mKM-b7Ju.js"></script>' +
  '<link rel="stylesheet" crossorigin href="/assets/index-Brn_qMvo.css">';
const template = source('../index.html')
  .replace('<script type="module" src="/src/main.tsx"></script>', '')
  .replace('</head>', `${bundles}</head>`);

// Every page, by file, prerendered with the markup App renders; release, if given, is the one each names.
const rendered = (release?: string): Record<string, string> =>
  Object.fromEntries(
    prerenderPages.map((page) => [page.file, renderDocument(template, page, render(page.id), release)]),
  );

// dist/ as a successful `npm run build` leaves it: every page, what Vite copies from public/, and the bundles.
const build: Record<string, string | Buffer> = {
  ...rendered(),
  'og-image.png': readFileSync(new URL('../public/og-image.png', import.meta.url)),
  'favicon.svg': source('../public/favicon.svg'),
  'robots.txt': source('../public/robots.txt'),
  'sitemap.xml': source('../public/sitemap.xml'),
  'assets/index-mKM-b7Ju.js': 'console.log("app");\n',
  'assets/index-Brn_qMvo.css': 'body { margin: 0; }\n',
};

// The pages with an address, at their URLs, which link previews and search engines show; and the page without one,
// which every missing address serves.
const addressed = pages.flatMap((page) =>
  page.path === null ? [] : [{ ...page, path: page.path, url: `${site.origin}${page.path}` }],
);
const unaddressed = pages.filter((page) => page.path === null);

// Writes a project to a temp directory removed after the test, and returns its
// root URL: dist/ holds the build with `changes` applied (null leaves a file
// out), and public/ holds `publicFiles`.
async function project(
  changes: Record<string, string | Buffer | null> = {},
  publicFiles: Record<string, string | Buffer> = {},
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

// Changes that leave every file of the build out, for a dist/ that holds only the files a test gives.
const nothing = Object.fromEntries(Object.keys(build).map((file) => [file, null]));

// Replaces the one occurrence of `from` in a text file of the build.
function edit(file: string, from: string, to: string): Record<string, string> {
  const parts = (build[file] as string).split(from);
  expect(parts.length - 1, `occurrences of ${JSON.stringify(from)} in ${file}`).toBe(1);
  return { [file]: parts.join(to) };
}

// The failure for a file that lacks a needle.
const lacks = (file: string, needle: string) => `dist/${file} does not contain ${JSON.stringify(needle)}`;

// One edit to a build file, plus any `files` the edited page needs, and the one failure it causes.
interface Problem {
  problem: string;
  file: string;
  from: string;
  to: string;
  files?: Record<string, string>;
  failure: string;
}

async function expectProblem({ file, from, to, files, failure }: Problem): Promise<void> {
  expect(checkDist(await project({ ...edit(file, from, to), ...files }))).toEqual([failure]);
}

describe('checkDist', () => {
  it('passes a complete prerendered build of the pages App renders', async () => {
    expect(checkDist(await project())).toEqual([]);
  });

  it("requires each page to name the deploy build's release exactly once, and other builds' pages to name none", async () => {
    const release = '0123456789abcdef0123456789abcdef01234567';
    const named = rendered(release);
    expect(checkDist(await project(named), release)).toEqual([]);
    expect(checkDist(await project(named))).toEqual(
      pages.map(({ file }) => `dist/${file} names a release, but no RELEASE_COMMIT was given`),
    );
    expect(checkDist(await project(), release)).toEqual(
      pages.map(({ file }) => `dist/${file} does not name release ${release} exactly once`),
    );
    // The home page names it twice, and the other pages another release.
    const twice = named['index.html']!.replace(
      '</head>',
      `<meta name="zachverse-release" content="${release}" /></head>`,
    );
    expect(checkDist(await project({ ...rendered('f'.repeat(40)), 'index.html': twice }), release)).toEqual(
      pages.map(({ file }) => `dist/${file} does not name release ${release} exactly once`),
    );
  });

  it('passes a build whose content has characters React escapes', async () => {
    vi.resetModules();
    // src/content/site.ts builds the page table and the picture's description from ./profile.ts itself, so a profile
    // mocked here alone would not reach them: the mock builds them from this profile too.
    vi.doMock('../src/content/index.ts', async (importOriginal) => {
      const content = await importOriginal<typeof import('../src/content/index.ts')>();
      const profile = {
        ...content.profile,
        name: 'Zach "ZD" <Davids>',
        role: 'Engineer at R&D <Labs>',
        summary: ["It's coming soon.", 'Tom & "Jerry" <show>'],
        links: [{ id: 'email', label: 'Email', href: 'mailto:zach@zachdavids.com?subject=Hi&body=Hello' }],
      };
      return {
        ...content,
        profile,
        site: {
          ...content.site,
          name: `Zach's "R&D" <verse>`,
          image: { ...content.site.image, alt: `${profile.name}, ${profile.role}` },
        },
        pages: content.pages.map((page) => ({
          ...page,
          title: `${page.label} — ${profile.name}`,
          description: `${profile.name}'s "${page.label}" page & <more>`,
        })),
        resume: {
          ...content.resume,
          experience: content.resume.experience.map((role) => ({ ...role, title: `${role.title} & <R&D>` })),
        },
      };
    });
    onTestFinished(() => {
      vi.doUnmock('../src/content/index.ts');
    });
    // Fresh copies of every module that reads the content, as a build with it would run.
    const { render: renderPage } = await import('../src/entry-server.tsx');
    const { prerenderPages: freshPages, renderDocument: renderPageDocument } = await import('./prerender-lib.ts');
    const { checkDist: check } = await import('./check-dist-lib.ts');
    const changes = Object.fromEntries(
      freshPages.map((page) => [page.file, renderPageDocument(template, page, renderPage(page.id))]),
    );
    // The content reaches the pages, escaped in the markup, the head, and the structured data.
    expect(changes['index.html']).toContain('<h1>Zach &quot;ZD&quot; &lt;Davids&gt;</h1>');
    expect(changes['resume/index.html']).toContain('<title>Résumé — Zach &quot;ZD&quot; &lt;Davids&gt;</title>');
    expect(changes['index.html']).toContain('"name":"Zach \\"ZD\\" ');
    expect(Object.values(changes).filter((html) => html.includes('<Davids>'))).toEqual([]);
    expect(check(await project(changes))).toEqual([]);
  });

  // What every page needs, whichever it is, and how a reference on any page resolves.
  describe.each(pages)('in $file', (page) => {
    const { file } = page;
    const other = pages.find(({ id }) => id !== page.id)!;
    const title = `<title>${escapeHtml(page.title)}</title>`;
    const description = `<meta name="description" content="${escapeHtml(page.description)}" />`;

    it.each<Problem>([
      { problem: 'a wrong title', file, from: title, to: '<title>Zachverse</title>', failure: lacks(file, title) },
      {
        problem: 'a page hydrating as another page',
        file,
        from: `data-page="${page.id}"`,
        to: `data-page="${other.id}"`,
        failure: lacks(file, `data-page="${page.id}"`),
      },
      {
        problem: "a description other than the page table's",
        file,
        from: description,
        to: '<meta name="description" content="Zachverse" />',
        failure: lacks(file, description),
      },
      // The template's head, which every page shares.
      {
        problem: 'a page rendered in quirks mode',
        file,
        from: '<!doctype html>',
        to: '',
        failure: lacks(file, '<!doctype html>'),
      },
      {
        problem: 'a page without its language',
        file,
        from: '<html lang="en">',
        to: '<html>',
        failure: lacks(file, '<html lang="en">'),
      },
      {
        problem: 'a page without its character encoding',
        file,
        from: '<meta charset="UTF-8" />',
        to: '',
        failure: lacks(file, '<meta charset="UTF-8" />'),
      },
      {
        problem: 'a page laid out for a desktop-width viewport on phones',
        file,
        from: 'content="width=device-width, initial-scale=1"',
        to: 'content="width=1024"',
        failure: lacks(file, '<meta name="viewport" content="width=device-width, initial-scale=1" />'),
      },
      {
        problem: 'a leftover head marker',
        file,
        from: '</head>',
        to: '<!--app-head--></head>',
        failure: `dist/${file} still contains a prerender marker`,
      },
      {
        problem: 'a leftover body marker',
        file,
        from: '</main></div>',
        to: '</main><!--app-html--></div>',
        failure: `dist/${file} still contains a prerender marker`,
      },
      {
        problem: 'a mistyped icon link',
        file,
        from: 'href="/favicon.svg"',
        to: 'href="/favicon.svgg"',
        failure: `dist/${file} references missing /favicon.svgg`,
      },
      // S3 matches keys by exact name, and so does the check, so this fails on NTFS too, which ignores case.
      {
        problem: 'an icon link in the wrong case',
        file,
        from: 'href="/favicon.svg"',
        to: 'href="/FAVICON.SVG"',
        failure: `dist/${file} references missing /FAVICON.SVG`,
      },
      {
        problem: 'a relative icon link, which resolves elsewhere on nested paths',
        file,
        from: 'href="/favicon.svg"',
        to: 'href="./favicon.svg"',
        failure: `dist/${file} references ./favicon.svg, a relative URL that breaks on nested paths; start it with /`,
      },
      // The page keeps an asset with .js or .css inside its name, which a substring match would take for a bundle.
      {
        problem: 'a page that loads no JavaScript bundle',
        file,
        from: '<script type="module" crossorigin src="/assets/index-mKM-b7Ju.js"></script>',
        to: '<link rel="preload" href="/assets/content-Qx7Lm2Pa.json" as="fetch" crossorigin>',
        files: { 'assets/content-Qx7Lm2Pa.json': '{}\n' },
        failure: `dist/${file} references no JavaScript bundle`,
      },
      {
        problem: 'a page that loads no stylesheet',
        file,
        from: '<link rel="stylesheet" crossorigin href="/assets/index-Brn_qMvo.css">',
        to: '<link rel="prefetch" href="/assets/theme.css-Qx7Lm2Pa.svg">',
        files: { 'assets/theme.css-Qx7Lm2Pa.svg': '<svg/>\n' },
        failure: `dist/${file} references no stylesheet`,
      },
    ])('reports $problem', expectProblem);

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
        ...edit(file, '</main>', `${links}</main>`),
        'about/index.html': '',
        'notes/index.html': '',
        'talks/slides.pdf': '',
        '.well-known/apple-app-site-association': '{}\n',
        'notes.v2/index.html': '',
      };
      expect(checkDist(await project(changes))).toEqual([
        `dist/${file} references missing /talks`,
        `dist/${file} references missing /notes.v2`,
      ]);
    });

    // Also a fragment with no query, as in an SVG sprite reference such as /assets/icons-AbCd1234.svg#github.
    it.each(['?v=2#app', '#app'])('checks the file a URL names, without its query or fragment: %s', async (suffix) => {
      const changes = edit(file, 'src="/assets/index-mKM-b7Ju.js"', `src="/assets/index-mKM-b7Ju.js${suffix}"`);
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
      const changes = { ...edit(file, '</main>', `${links}</main>`), '100%.svg': '', 'icon@2x.png': '' };
      expect(checkDist(await project(changes))).toEqual([`dist/${file} references missing /100%.svg`]);
    });

    // The build never emits an encoded slash or backslash, and the CloudFront docs don't say whether S3 then reads
    // one as a separator, so a path with either names no key, even where its decoded name is a file's.
    it.each(['%2F', '%2f', '%5C', '%5c'])('reports a path with the encoded separator %s as missing', async (escape) => {
      const path = `/assets${escape}index-mKM-b7Ju.js`;
      // A file under the decoded name. For %5C that name holds a backslash, which Linux keeps in a file name and
      // Windows reads as a separator.
      const decoded = { [decodeURIComponent(path).slice(1)]: '' };
      const changes = { ...edit(file, '</main>', `<a href="${path}">App</a></main>`), ...decoded };
      expect(checkDist(await project(changes))).toEqual([`dist/${file} references missing ${path}`]);
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
      const changes = edit(file, '</main>', `${links}</main>`);
      expect(checkDist(await project(changes, { 'favicon.svg': '' }))).toEqual([
        `dist/${file} references missing /../dist/favicon.svg`,
        `dist/${file} references missing /%2E%2E/dist/favicon.svg`,
        `dist/${file} references missing /../public/favicon.svg`,
        `dist/${file} references missing /../DIST/favicon.svg`,
      ]);
    });

    it('leaves protocol-relative URLs to their hosts', async () => {
      const preconnect = '<link rel="preconnect" href="//cdn.example.com"></head>';
      expect(checkDist(await project(edit(file, '</head>', preconnect)))).toEqual([]);
    });

    // A browser reads a backslash as a slash, so it takes /\other.invalid/favicon.svg to another host, not to the
    // site's /favicon.svg, and finds no valid host in /\a b/favicon.svg.
    it('reports a path that a browser takes to another host, or to none, as missing', async () => {
      const links = '<a href="/\\other.invalid/favicon.svg">Icon</a><a href="/\\a b/favicon.svg">Icon</a></main>';
      expect(checkDist(await project(edit(file, '</main>', links)))).toEqual([
        `dist/${file} references missing /\\other.invalid/favicon.svg`,
        `dist/${file} references missing /\\a b/favicon.svg`,
      ]);
    });

    it("accepts a bare fragment, which resolves against the page's own URL, so it works on any path", async () => {
      const skip = '<a href="#main">Skip to content</a><main';
      expect(checkDist(await project(edit(file, '<main', skip)))).toEqual([]);
    });

    // What Vite's base: './' does to a page: the bundle URLs in /404.html would
    // resolve under /a/b/ when it is served for /a/b/c.
    it('reports a bundle loaded by a relative URL', async () => {
      const changes = edit(file, 'src="/assets/index-mKM-b7Ju.js"', 'src="./assets/index-mKM-b7Ju.js"');
      expect(checkDist(await project(changes))).toEqual([
        `dist/${file} references ./assets/index-mKM-b7Ju.js, a relative URL that breaks on nested paths; start it with /`,
        `dist/${file} references no JavaScript bundle`,
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
      const changes = { ...edit(file, '</head>', prefetch), [asset.slice(1)]: '' };
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
      const changes = { ...edit(file, '</head>', `${links}</head>`), 'assets/vendor.js': '', ...copy };
      expect(checkDist(await project(changes, { 'favicon.svg': '', ...copy }))).toEqual([
        '/x/../assets/vendor.js has no content hash in its name',
        '/%61ssets/vendor.js has no content hash in its name',
        '/x/../assets/background-gradient.svg is copied unhashed from public/',
        '/%61ssets/background-gradient.svg is copied unhashed from public/',
      ]);
    });

    // S3 decodes the name, so an escaped bundle and stylesheet are still hashed build outputs.
    it('accepts a bundle and stylesheet whose names hold escapes', async () => {
      const escaped = (build[file] as string)
        .replace('src="/assets/index-mKM-b7Ju.js"', 'src="/assets/index-mKM-b7Ju.j%73"')
        .replace('href="/assets/index-Brn_qMvo.css"', 'href="/assets/index-Brn_qMvo.c%73s"');
      expect(escaped).toContain('.j%73"');
      expect(escaped).toContain('.c%73s"');
      expect(checkDist(await project({ [file]: escaped }))).toEqual([]);
    });

    // Longer words pass the name check, so a copy from public/ is caught by its origin.
    it.each(['/assets/background-gradient.svg', '/assets/index-component.js'])(
      'reports %s as copied unhashed from public/',
      async (asset) => {
        const copy = { [asset.slice(1)]: '' };
        const changes = { ...edit(file, '</head>', `<link rel="prefetch" href="${asset}"></head>`), ...copy };
        expect(checkDist(await project(changes, copy))).toEqual([`${asset} is copied unhashed from public/`]);
      },
    );

    // Vite copies what a public/ symlink points at, so a linked file's copy is still unhashed.
    it('reports a file symlinked into public/ as copied unhashed', async (ctx) => {
      const asset = '/assets/vendor-component.js';
      const prefetch = `<link rel="prefetch" href="${asset}"></head>`;
      const root = await project({ ...edit(file, '</head>', prefetch), [asset.slice(1)]: '' });
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
      const changes = { ...edit(file, '</head>', prefetch), ...copy };
      expect(checkDist(await project(changes, copy))).toEqual([
        `dist/${file} references missing /assets/background-gradient.svg`,
      ]);
    });

    it('accepts a hashed asset with a digit in its extension, such as a font', async () => {
      const preload = '<link rel="preload" href="/assets/inter-Q4_x-9Zb.woff2" as="font" crossorigin></head>';
      const changes = { ...edit(file, '</head>', preload), 'assets/inter-Q4_x-9Zb.woff2': '' };
      expect(checkDist(await project(changes))).toEqual([]);
    });

    // A link whose target is gone names no file, wherever it is. A junction needs no extra privileges on Windows;
    // other systems ignore the type and make a plain symlink.
    it('reports a reference to a dangling link as missing, and ignores unreferenced ones', async () => {
      const changes = edit(file, '</main>', '<a href="/archive/">Archive</a></main>');
      const root = await project(changes, { 'favicon.svg': '' });
      for (const link of ['dist/archive', 'dist/assets/old', 'public/old']) {
        await symlink(new URL('missing', root), new URL(link, root), 'junction');
      }
      expect(checkDist(root)).toEqual([`dist/${file} references missing /archive/`]);
    });
  });

  // What link previews and search engines read of each page with an address. The values are escaped as the head
  // escapes them.
  describe.each(addressed)('in $file, at $url', ({ file, title, description, url }) => {
    const tag = (property: string, content: string | number) => `<meta property="${property}" content="${content}" />`;
    const canonical = `<link rel="canonical" href="${url}" />`;
    const picture = tag('og:image', 'https://zachdavids.com/og-image.png');
    const json = profilePageData(url);
    const script = `<script type="application/ld+json">${json}</script>`;
    const notOne = `dist/${file} does not carry exactly one application/ld+json script`;

    it.each<Problem>([
      { problem: 'a page without its canonical link', file, from: canonical, to: '', failure: lacks(file, canonical) },
      {
        problem: 'a canonical link to another address',
        file,
        from: canonical,
        to: '<link rel="canonical" href="https://zachdavids.com/other/" />',
        failure: lacks(file, canonical),
      },
      {
        problem: 'an og:url other than the canonical URL',
        file,
        from: tag('og:url', url),
        to: tag('og:url', 'https://zachdavids.com/other/'),
        failure: lacks(file, tag('og:url', url)),
      },
      {
        problem: "an og:title other than the page's title",
        file,
        from: tag('og:title', escapeHtml(title)),
        to: tag('og:title', 'Zachverse'),
        failure: lacks(file, tag('og:title', escapeHtml(title))),
      },
      {
        problem: "an og:description other than the page's description",
        file,
        from: tag('og:description', escapeHtml(description)),
        to: tag('og:description', 'Zachverse'),
        failure: lacks(file, tag('og:description', escapeHtml(description))),
      },
      { problem: 'a link preview without its picture', file, from: picture, to: '', failure: lacks(file, picture) },
      {
        problem: 'a picture at another address',
        file,
        from: picture,
        to: tag('og:image', 'https://zachdavids.com/assets/og-image.png'),
        failure: lacks(file, picture),
      },
      {
        problem: 'a picture said to be another width',
        file,
        from: tag('og:image:width', 1200),
        to: tag('og:image:width', 1201),
        failure: lacks(file, tag('og:image:width', 1200)),
      },
      {
        problem: 'a picture said to be another height',
        file,
        from: tag('og:image:height', 630),
        to: tag('og:image:height', 631),
        failure: lacks(file, tag('og:image:height', 630)),
      },
      {
        problem: 'a link preview card without the large picture',
        file,
        from: '<meta name="twitter:card" content="summary_large_image" />',
        to: '<meta name="twitter:card" content="summary" />',
        failure: lacks(file, '<meta name="twitter:card" content="summary_large_image" />'),
      },
      {
        problem: 'no og:type',
        file,
        from: tag('og:type', 'website'),
        to: '',
        failure: `dist/${file} has no og:type, or an empty one`,
      },
      {
        problem: 'an empty og:site_name',
        file,
        from: tag('og:site_name', escapeHtml(site.name)),
        to: tag('og:site_name', ''),
        failure: `dist/${file} has no og:site_name, or an empty one`,
      },
      {
        problem: 'no og:image:alt',
        file,
        from: tag('og:image:alt', escapeHtml(site.image.alt)),
        to: '',
        failure: `dist/${file} has no og:image:alt, or an empty one`,
      },
      {
        problem: 'an og:image:alt of white space',
        file,
        from: tag('og:image:alt', escapeHtml(site.image.alt)),
        to: tag('og:image:alt', ' '),
        failure: `dist/${file} has no og:image:alt, or an empty one`,
      },
      { problem: 'a page without structured data', file, from: script, to: '', failure: notOne },
      { problem: 'a page with structured data twice', file, from: script, to: script + script, failure: notOne },
      // JSX writes attributes in the order its props are given, so the type need not come first. This one would also
      // end its script early, but the page already fails.
      {
        problem: 'a second script of structured data, with an id before its type',
        file,
        from: script,
        to: `${script}<script id="crumbs" type="application/ld+json">{"name":"<!-- x"}</script>`,
        failure: notOne,
      },
      {
        problem: 'structured data that is not JSON',
        file,
        from: json,
        to: json.slice(0, -1),
        failure: `dist/${file} has structured data that is not JSON`,
      },
      // An unescaped "<!--" changes how the browser reads the rest of the script.
      {
        problem: 'structured data holding a "<"',
        file,
        from: '"@context":"https://schema.org"',
        to: '"@context":"https://schema.org","description":"<!-- soon -->"',
        failure: `dist/${file} has structured data holding a "<", which can end its script early`,
      },
      {
        problem: 'structured data about another kind of page',
        file,
        from: '"@type":"ProfilePage"',
        to: '"@type":"WebPage"',
        failure: `dist/${file} has structured data whose @type is "WebPage", not "ProfilePage"`,
      },
      {
        problem: 'structured data for another address',
        file,
        from: `"@type":"ProfilePage","url":"${url}"`,
        to: '"@type":"ProfilePage","url":"https://zachdavids.com/other/"',
        failure: `dist/${file} has structured data whose url is "https://zachdavids.com/other/", not "${url}"`,
      },
      {
        problem: 'structured data about someone else',
        file,
        from: '"name":"Zach Davids"',
        to: '"name":"Someone Else"',
        failure: `dist/${file} has structured data whose mainEntity.name is "Someone Else", not "Zach Davids"`,
      },
    ])('reports $problem', expectProblem);

    it('reports each field of structured data that is not an object', async () => {
      expect(checkDist(await project(edit(file, json, 'null')))).toEqual([
        `dist/${file} has structured data whose @type is undefined, not "ProfilePage"`,
        `dist/${file} has structured data whose url is undefined, not "${url}"`,
        `dist/${file} has structured data whose mainEntity.name is undefined, not "Zach Davids"`,
      ]);
    });

    it('accepts its one script of structured data with an id before its type', async () => {
      const changes = edit(
        file,
        '<script type="application/ld+json">',
        '<script id="profile" type="application/ld+json">',
      );
      expect(checkDist(await project(changes))).toEqual([]);
    });

    // Open Graph prefers the first of two tags, so a wrong one placed before the right one wins.
    it.each<[string, string]>([
      ['rel="canonical"', '<link rel="canonical" href="https://zachdavids.com/other/" />'],
      ...[
        'og:type',
        'og:site_name',
        'og:title',
        'og:description',
        'og:url',
        'og:image',
        'og:image:width',
        'og:image:height',
        'og:image:alt',
      ].map((property): [string, string] => [`property="${property}"`, tag(property, 'Wrong')]),
      ['name="twitter:card"', '<meta name="twitter:card" content="summary" />'],
    ])('reports a second tag with %s, before the right one', async (attribute, wrong) => {
      const changes = edit(file, '<meta charset="UTF-8" />', `<meta charset="UTF-8" />${wrong}`);
      expect(checkDist(await project(changes))).toEqual([
        `dist/${file} has more than one tag with ${attribute}, and a crawler may read any of them`,
      ]);
    });

    // What one line in the template would add to every page. Google reads the tag in any case and either order of its
    // attributes, its rules from a comma-separated list, and none as noindex and nofollow.
    it.each([
      '<meta name="robots" content="noindex" />',
      '<meta name="robots" content="none" />',
      '<meta content="nofollow, NoIndex" name="Robots" />',
    ])('reports a robots tag that keeps the page out of search results: %s', async (robots) => {
      expect(checkDist(await project(edit(file, '</head>', `${robots}</head>`)))).toEqual([
        `dist/${file} has a robots tag that keeps it out of search results`,
      ]);
    });

    // max-image-preview:none asks for no image previews, which is not the none rule.
    it('accepts a robots tag whose rules let search engines index the page', async () => {
      const robots = '<meta name="robots" content="index, follow, max-image-preview:none" /></head>';
      expect(checkDist(await project(edit(file, '</head>', robots)))).toEqual([]);
    });
  });

  // Every missing address serves the 404 page, so it has no address of its own.
  describe.each(unaddressed)('in $file, which every missing address serves', ({ file }) => {
    it.each<Problem>([
      {
        problem: 'a page that search engines may index',
        file,
        from: '<meta name="robots" content="noindex" />',
        to: '',
        failure: lacks(file, '<meta name="robots" content="noindex" />'),
      },
      {
        problem: 'a canonical URL',
        file,
        from: '</head>',
        to: '<link rel="canonical" href="https://zachdavids.com/" /></head>',
        failure: `dist/${file} has a canonical URL, though every missing address serves it`,
      },
      {
        problem: 'Open Graph tags',
        file,
        from: '</head>',
        to: '<meta property="og:title" content="Page not found" /></head>',
        failure: `dist/${file} has Open Graph tags, though every missing address serves it`,
      },
      {
        problem: 'structured data',
        file,
        from: '</head>',
        to: '<script type="application/ld+json">{}</script></head>',
        failure: `dist/${file} has structured data, though every missing address serves it`,
      },
      {
        problem: 'a Twitter card',
        file,
        from: '</head>',
        to: '<meta name="twitter:card" content="summary_large_image" /></head>',
        failure: `dist/${file} has a Twitter card, though every missing address serves it`,
      },
    ])('reports $problem', expectProblem);
  });

  it.each<Problem>([
    {
      problem: 'a home page without the name heading',
      file: 'index.html',
      from: '<h1>Zach Davids</h1>',
      to: '<h1></h1>',
      failure: 'dist/index.html does not contain ">Zach Davids</h1>"',
    },
    // The meta description repeats the role and the summary, so these catch
    // only rendered page content.
    {
      problem: 'a home page without the rendered role',
      file: 'index.html',
      from: '<p class="role">Senior Software Engineer at Amazon</p>',
      to: '',
      failure: 'dist/index.html does not contain ">Senior Software Engineer at Amazon</p>"',
    },
    {
      problem: "a home page without the summary's first line",
      file: 'index.html',
      from: '<p class="summary">I build embedded C++ systems, device-platform software, and AWS services for Kindle e-readers.</p>',
      to: '',
      failure:
        'dist/index.html does not contain ">I build embedded C++ systems, device-platform software, and AWS services for Kindle e-readers.</p>"',
    },
    {
      problem: "a home page without the summary's second line",
      file: 'index.html',
      from: '<p class="summary">Before Amazon, I was a gameplay programmer at Rockstar Games.</p>',
      to: '',
      failure: 'dist/index.html does not contain ">Before Amazon, I was a gameplay programmer at Rockstar Games.</p>"',
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
      problem: 'a résumé without its heading',
      file: 'resume/index.html',
      from: '<h1>Résumé</h1>',
      to: '<h1></h1>',
      failure: 'dist/resume/index.html does not contain ">Résumé</h1>"',
    },
    {
      problem: 'a 404 page without its heading',
      file: '404.html',
      from: '<h1>Page not found</h1>',
      to: '<h1></h1>',
      failure: 'dist/404.html does not contain ">Page not found</h1>"',
    },
    {
      problem: 'robots.txt without the sitemap line',
      file: 'robots.txt',
      from: 'Sitemap: https://zachdavids.com/sitemap.xml',
      to: '',
      failure: 'dist/robots.txt does not contain "Sitemap: https://zachdavids.com/sitemap.xml"',
    },
  ])('reports $problem', expectProblem);

  // The home page links to every other page with an address, so a visitor can reach each one.
  it.each(addressed.filter(({ id }) => id !== 'home'))(
    'reports a home page that does not link to $path',
    async ({ path }) => {
      const changes = edit('index.html', `<a href="${path}">`, '<a href="/">');
      expect(checkDist(await project(changes))).toEqual([lacks('index.html', `href="${path}"`)]);
    },
  );

  it.each(resume.experience)('reports a résumé without the heading for $title', async ({ title }) => {
    const changes = edit('resume/index.html', `<h3>${escapeHtml(title)}</h3>`, '<h3></h3>');
    expect(checkDist(await project(changes))).toEqual([lacks('resume/index.html', `>${escapeHtml(title)}</h3>`)]);
  });

  it.each(addressed)('reports a sitemap that does not list $url', async ({ url }) => {
    const loc = `<loc>${url}</loc>`;
    const changes = edit('sitemap.xml', loc, loc.replace(site.origin, 'https://www.zachdavids.com'));
    expect(checkDist(await project(changes))).toEqual([lacks('sitemap.xml', loc)]);
  });

  describe('the link-preview picture', () => {
    const png = build['og-image.png'] as Buffer;

    it('is reported missing by every page with an address, in any other case too', async () => {
      const missing = addressed.map(({ file }) => `dist/${file} references missing /og-image.png`);
      expect(checkDist(await project({ 'og-image.png': null }))).toEqual(missing);
      // S3 matches keys by exact name, as for any reference.
      expect(checkDist(await project({ 'og-image.png': null, 'OG-IMAGE.PNG': png }))).toEqual(missing);
    });

    // A PNG starts with its signature, then its header chunk, IHDR.
    it.each([
      ['a short text file', Buffer.from('not a picture\n')],
      ['a JPEG', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), png.subarray(4)])],
      [
        'a PNG whose first chunk is not its header',
        Buffer.concat([png.subarray(0, 12), Buffer.from('IDAT'), png.subarray(16)]),
      ],
    ])('reports %s as not a PNG', async (_, body) => {
      expect(checkDist(await project({ 'og-image.png': body }))).toEqual(['dist/og-image.png is not a PNG']);
    });

    it.each([
      [1200, 628],
      [1199, 630],
    ])('reports a %i x %i picture, which the pages say is 1200 x 630', async (width, height) => {
      const resized = Buffer.from(png);
      resized.writeUInt32BE(width, 16);
      resized.writeUInt32BE(height, 20);
      expect(checkDist(await project({ 'og-image.png': resized }))).toEqual([
        `dist/og-image.png is a ${width} x ${height} picture, not the 1200 x 630 that og:image:width and og:image:height give`,
      ]);
    });
  });

  it.each(['/favicon.svg', '/assets/index-Brn_qMvo.css'])('reports %s missing on disk, once per page', async (path) => {
    expect(checkDist(await project({ [path.slice(1)]: null }))).toEqual(
      pages.map(({ file }) => `dist/${file} references missing ${path}`),
    );
  });

  // The résumé and the 404 page link home, and the home page links to the résumé, so each needs the other's file.
  it.each([
    ['index.html', ['dist/resume/index.html references missing /', 'dist/404.html references missing /']],
    ['resume/index.html', ['dist/index.html references missing /resume/']],
    ['404.html', []],
    ['robots.txt', []],
    ['sitemap.xml', []],
  ])('reports a missing %s, then only the checks that needed it', async (file, others) => {
    const [first, ...rest] = checkDist(await project({ [file]: null }));
    expect(first).toBe(`missing dist/${file}`);
    expect(rest.filter((failure) => !failure.startsWith(`dist/${file} `))).toEqual(others);
  });

  const missingFiles = [
    ...pages.map(({ file }) => `missing dist/${file}`),
    'missing dist/robots.txt',
    'missing dist/sitemap.xml',
  ];

  it('reports every file as missing before a build has run', async () => {
    const failures = checkDist(new URL('never-built/', await project()));
    expect(failures.filter((failure) => failure.startsWith('missing '))).toEqual(missingFiles);
  });

  // A file where a folder belongs holds no files.
  it('reports every file as missing when dist is a file', async () => {
    const root = new URL('built-to-a-file/', await project());
    await mkdir(root);
    await writeFile(new URL('dist', root), '');
    expect(checkDist(root).filter((failure) => failure.startsWith('missing '))).toEqual(missingFiles);
  });

  it('finds no copies in a public that is a file', async () => {
    const root = await project();
    await writeFile(new URL('public', root), '');
    expect(checkDist(root)).toEqual([]);
  });
});

describe('releaseProblems', () => {
  // public/ as the repository has it; Vite copies these into dist/ as they are.
  const publicDir = Object.fromEntries(
    ['favicon.svg', 'og-image.png', 'robots.txt', 'sitemap.xml'].map((file) => [file, build[file]!]),
  );

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
      'dist/og-image.png is built outside assets/, so a release would publish it as a page',
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

  // The site uses system fonts, so a font file of even one byte is over the budget.
  it('reports a font file, which the site has no budget for', async () => {
    const root = await project({ 'assets/inter-Q4_x-9Zb.woff2': Buffer.alloc(1) }, publicDir);
    expect(releaseProblems(root)).toEqual([
      'dist/ is over a size budget (gzip where CloudFront compresses): fonts 1 byte, more than the budget of 0 bytes',
    ]);
  });

  it('reports a build over a size budget by one byte, and passes one at it', async () => {
    const { images } = measureDist(await project({}, publicDir));
    // CloudFront does not compress a PNG, so each byte counts.
    const photo = (bytes: number) => ({ 'assets/photo-AbCd1234.png': Buffer.alloc(bytes) });
    expect(releaseProblems(await project(photo(BUDGETS.images - images), publicDir))).toEqual([]);
    expect(releaseProblems(await project(photo(BUDGETS.images - images + 1), publicDir))).toEqual([
      'dist/ is over a size budget (gzip where CloudFront compresses): images 102,401 bytes, more than the budget of ' +
        '102,400 bytes',
    ]);
  });

  it('leaves a missing build to checkDist', async () => {
    expect(releaseProblems(await project(nothing))).toEqual([]);
  });
});

describe('measureDist', () => {
  // Hex digits, which gzip shrinks only by about half, unlike repeated markup, which it shrinks to almost nothing.
  const digits = (count: number) =>
    Array.from({ length: Math.ceil(count / 64) }, (_, i) => createHash('sha256').update(String(i)).digest('hex'))
      .join('')
      .slice(0, count);
  const gzipped = (text: string) => gzipSync(text).length;

  it('measures each kind of file as CloudFront would send it to a browser that accepts gzip', async () => {
    const png = build['og-image.png'] as Buffer;
    // CloudFront leaves a file under 1,000 bytes as it is.
    const chunk = 'export {};\n';
    const print = 'p { color: black; }\n';
    const icon = '<svg xmlns="http://www.w3.org/2000/svg"/>\n';
    // Over 1,000 bytes, of types it compresses.
    const script = digits(3000);
    const style = `body { --noise: "${digits(2000)}"; }\n`;
    const sprite = `<svg xmlns="http://www.w3.org/2000/svg"><desc>${digits(2000)}</desc></svg>\n`;
    // The larger page as written is the smaller one gzipped.
    const repeated = `<!doctype html>${'<p>Hello</p>'.repeat(500)}`;
    const varied = `<!doctype html><p>${digits(2000)}</p>`;
    const root = await project({
      ...nothing,
      'index.html': repeated,
      'resume/index.html': varied,
      '404.html': '<!doctype html><title>Page not found</title>\n',
      'assets/index-AbCd1234.js': script,
      'assets/chunk-AbCd1234.mjs': chunk,
      // Outside assets/, as a script copied from public/ would be, but sent all the same.
      'sw.js': script,
      'assets/index-AbCd1234.css': style,
      'assets/print-AbCd1234.css': print,
      'favicon.svg': icon,
      'assets/sprite-AbCd1234.svg': sprite,
      'og-image.png': png,
      'assets/photo-AbCd1234.jpg': Buffer.alloc(1100),
      'assets/photo-AbCd1234.jpeg': Buffer.alloc(1200),
      'assets/photo-AbCd1234.gif': Buffer.alloc(1300),
      'assets/photo-AbCd1234.webp': Buffer.alloc(1400),
      'assets/photo-AbCd1234.avif': Buffer.alloc(1500),
      'favicon.ico': Buffer.alloc(1600),
      // An extension in capitals has the same type.
      'photos/PORTRAIT.PNG': Buffer.alloc(1700),
      'assets/inter-AbCd1234.woff': Buffer.alloc(2100),
      'assets/inter-AbCd1234.woff2': Buffer.alloc(2200),
      // Of no kind the budgets count.
      'robots.txt': digits(3000),
      'assets/data-AbCd1234.json': `"${digits(3000)}"`,
    });
    expect(measureDist(root)).toEqual({
      javascript: 2 * gzipped(script) + chunk.length,
      css: gzipped(style) + print.length,
      html: gzipped(varied),
      images: icon.length + gzipped(sprite) + png.length + 1100 + 1200 + 1300 + 1400 + 1500 + 1600 + 1700,
      fonts: 2100 + 2200,
    });
    expect(gzipped(varied)).toBeLessThan(repeated.length);
  });

  it('throws for a build a release would refuse, as siteFiles does', async () => {
    const root = await project({ 'assets/vendor.js': 'x\n' });
    expect(() => measureDist(root)).toThrow(
      'assets/vendor.js has no content hash in its name, so it cannot be cached as immutable.',
    );
  });
});

describe('budgetProblems', () => {
  it('passes a build at every budget', () => {
    expect(budgetProblems(BUDGETS)).toEqual([]);
  });

  it('reports each kind of file over its budget, with its size and the budget in bytes', () => {
    expect(budgetProblems({ javascript: 102_401, css: 12_000, html: 31_744, images: 204_800, fonts: 2048 })).toEqual([
      'dist/ is over a size budget (gzip where CloudFront compresses): JavaScript 102,401 bytes, more than the budget of 102,400 bytes',
      'dist/ is over a size budget (gzip where CloudFront compresses): CSS 12,000 bytes, more than the budget of 10,240 bytes',
      'dist/ is over a size budget (gzip where CloudFront compresses): largest page 31,744 bytes, more than the budget of 30,720 bytes',
      'dist/ is over a size budget (gzip where CloudFront compresses): images 204,800 bytes, more than the budget of 102,400 bytes',
      'dist/ is over a size budget (gzip where CloudFront compresses): fonts 2,048 bytes, more than the budget of 0 bytes',
    ]);
  });

  // In KiB to one decimal place, as the size report gives sizes, this page would read as 30.0 KiB of 30 KiB.
  it('reports only the kinds over budget, even by one byte', () => {
    expect(budgetProblems({ ...BUDGETS, html: BUDGETS.html + 1 })).toEqual([
      'dist/ is over a size budget (gzip where CloudFront compresses): largest page 30,721 bytes, more than the budget of 30,720 bytes',
    ]);
  });
});

describe('sizeReport', () => {
  it("gives each kind's size and its budget in KiB, to one decimal place unless whole", () => {
    expect(sizeReport({ javascript: 79_974, css: 922, html: 7200, images: 34_406, fonts: 0 })).toBe(
      'sizes (gzip where CloudFront compresses): JavaScript 78.1 KiB of 100 KiB, CSS 0.9 KiB of 10 KiB, ' +
        'largest page 7.0 KiB of 30 KiB, images 33.6 KiB of 100 KiB, fonts 0 KiB of 0 KiB',
    );
    expect(sizeReport(BUDGETS)).toBe(
      'sizes (gzip where CloudFront compresses): JavaScript 100 KiB of 100 KiB, CSS 10 KiB of 10 KiB, ' +
        'largest page 30 KiB of 30 KiB, images 100 KiB of 100 KiB, fonts 0 KiB of 0 KiB',
    );
  });
});
