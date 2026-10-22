import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { pages } from '../src/content/index.ts';
import { escapeHtml, headFor, prerender, prerenderPages, renderDocument, structuredData } from './prerender-lib.ts';

const template = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const byId = (id: string) => prerenderPages.find((page) => page.id === id)!;
const home = byId('home');
const resume = byId('resume');
const notFound = byId('not-found');

describe('escapeHtml', () => {
  it('escapes the characters React escapes in text and attribute values', () => {
    expect(escapeHtml(`Tom & "Jerry's" <Show>`)).toBe('Tom &amp; &quot;Jerry&#x27;s&quot; &lt;Show&gt;');
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('renderDocument', () => {
  it('fills the title, description, head, page id, and markup for the home page', () => {
    const html = renderDocument(template, home!, '<main>hello</main>');
    expect(html).toContain('<title>Zach Davids — Senior Software Engineer at Amazon</title>');
    expect(html).toContain(
      '<meta name="description" content="I build embedded C++ systems, device-platform software, and AWS services for ' +
        'Kindle e-readers. Before Amazon, I was a gameplay programmer at Rockstar Games." />',
    );
    expect(html).toContain('<link rel="canonical" href="https://zachdavids.com/" />');
    expect(html).toContain('<div id="root" data-page="home"><main>hello</main></div>');
    expect(html).not.toContain('<!--app-');
    expect(html).not.toContain('noindex');
  });

  it('names the release in the head only when given one', () => {
    const release = '0123456789abcdef0123456789abcdef01234567';
    const tag = `<meta name="zachverse-release" content="${release}" />`;
    expect(renderDocument(template, home!, '<main>hi</main>', release)).toContain(`</script>\n    ${tag}\n  </head>`);
    expect(renderDocument(template, notFound!, '<main>hi</main>', release)).toContain(
      `<meta name="robots" content="noindex" />\n    ${tag}\n  </head>`,
    );
    expect(renderDocument(template, home!, '<main>hi</main>')).not.toContain('zachverse-release');
  });

  it('marks the 404 page noindex and records its page id for hydration', () => {
    const html = renderDocument(template, notFound!, '<main>missing</main>');
    expect(html).toContain('<title>Page not found — Zach Davids</title>');
    expect(html).toContain('<meta name="robots" content="noindex" />');
    expect(html).toContain('data-page="not-found"');
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain('og:');
  });

  it('fills the résumé page with its own title, canonical URL, and page id', () => {
    expect(resume).toMatchObject({ file: 'resume/index.html', title: 'Résumé — Zach Davids' });
    const html = renderDocument(template, resume, '<main>cv</main>');
    expect(html).toContain('<title>Résumé — Zach Davids</title>');
    expect(html).toContain('<link rel="canonical" href="https://zachdavids.com/resume/" />');
    expect(html).toContain('<div id="root" data-page="resume"><main>cv</main></div>');
  });

  it('escapes the title for the title element', () => {
    const html = renderDocument(template, { ...home, title: 'Tom & <Jerry>' }, '<main />');
    expect(html).toContain('<title>Tom &amp; &lt;Jerry&gt;</title>');
  });

  it("replaces the template's description with the page's, escaped for the attribute", () => {
    const html = renderDocument(template, { ...home!, description: `Zach's "notes" & <demos>` }, '<main />');
    expect(html).toContain('<meta name="description" content="Zach&#x27;s &quot;notes&quot; &amp; &lt;demos&gt;" />');
    expect(html.match(/<meta name="description"/g)).toHaveLength(1);
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
    const withoutDescription = template.replace(/<meta name="description"[^>]*>/, '');
    expect(() => renderDocument(withoutDescription, home!, '<main />')).toThrow(
      'Expected exactly one /<meta name="description" content="[^"]*" \\/>/ in the HTML template, found 0',
    );
  });

  it('does not interpret $ patterns in rendered markup', () => {
    expect(renderDocument(template, home!, '<p>$& $1</p>')).toContain('<p>$& $1</p>');
  });

  // An accessible SVG icon has a <title> of its own; only the template's markers count.
  it.each(prerenderPages)('inserts markup that repeats the template markers verbatim into $file', (page) => {
    const markup =
      '<main><svg role="img"><title>GitHub</title></svg><!--app-head--><p data-page="home"></p>' +
      '<meta name="description" content="" /></main>';
    const html = renderDocument(template, page, markup);
    expect(html).toContain(`<div id="root" data-page="${page.id}">${markup}</div>`);
    expect(html).toContain(`<title>${escapeHtml(page.title)}</title>`);
    expect(html).toContain(page.head);
  });
});

describe('headFor', () => {
  it('gives a page with an address its canonical URL, link-preview tags, and structured data, one tag a line', () => {
    const page = pages.find((p) => p.id === 'resume')!;
    const data = structuredData({ type: 'ProfilePage' }, 'https://zachdavids.com/resume/');
    expect(headFor(page).split('\n    ')).toEqual([
      '<link rel="canonical" href="https://zachdavids.com/resume/" />',
      '<meta property="og:type" content="website" />',
      '<meta property="og:site_name" content="Zach Davids" />',
      '<meta property="og:title" content="Résumé — Zach Davids" />',
      `<meta property="og:description" content="${escapeHtml(page.description)}" />`,
      '<meta property="og:url" content="https://zachdavids.com/resume/" />',
      '<meta property="og:image" content="https://zachdavids.com/og-image.png" />',
      '<meta property="og:image:width" content="1200" />',
      '<meta property="og:image:height" content="630" />',
      '<meta property="og:image:alt" content="Zach Davids, Senior Software Engineer at Amazon" />',
      '<meta name="twitter:card" content="summary_large_image" />',
      `<script type="application/ld+json">${data}</script>`,
    ]);
  });

  it('asks search engines not to index the 404 page, and gives it nothing else', () => {
    expect(headFor(pages.find((p) => p.id === 'not-found')!)).toBe('<meta name="robots" content="noindex" />');
  });

  it("escapes a page's title and description in the tags' values", () => {
    const head = headFor({ ...pages[0], title: 'A "B" & C', description: "D's <E>" });
    expect(head).toContain('<meta property="og:title" content="A &quot;B&quot; &amp; C" />');
    expect(head).toContain('<meta property="og:description" content="D&#x27;s &lt;E&gt;" />');
  });
});

describe('structuredData', () => {
  it('describes a page about Zach, with Zach and the profiles that are also his', () => {
    expect(JSON.parse(structuredData({ type: 'ProfilePage' }, 'https://zachdavids.com/'))).toEqual({
      '@context': 'https://schema.org',
      '@type': 'ProfilePage',
      url: 'https://zachdavids.com/',
      mainEntity: {
        '@type': 'Person',
        '@id': 'https://zachdavids.com/#person',
        name: 'Zach Davids',
        url: 'https://zachdavids.com/',
        jobTitle: 'Senior Software Engineer',
        worksFor: { '@type': 'Organization', name: 'Amazon' },
        sameAs: ['https://github.com/zachdavids', 'https://www.linkedin.com/in/zacharydavids/'],
      },
    });
  });

  it('describes an article by its headline, with Zach as its author by the same @id', () => {
    const schema = { type: 'Article', headline: 'A case study' } as const;
    expect(JSON.parse(structuredData(schema, 'https://zachdavids.com/work/x/'))).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Article',
      url: 'https://zachdavids.com/work/x/',
      headline: 'A case study',
      author: {
        '@type': 'Person',
        '@id': 'https://zachdavids.com/#person',
        name: 'Zach Davids',
        url: 'https://zachdavids.com/',
      },
    });
  });

  it('writes no < that could end the script element, and JSON reads the escape back', () => {
    const url = 'https://zachdavids.com/</script><script>alert(1)</script>';
    const data = structuredData({ type: 'Article', headline: '<!-- x -->' }, url);
    expect(data).not.toContain('<');
    expect(data).toContain('\\u003c/script>');
    expect(JSON.parse(data)).toMatchObject({ url, headline: '<!-- x -->' });
  });

  it('gives each page with an address the structured data its entry names', () => {
    for (const page of pages) {
      if (page.path === null) continue;
      expect(headFor(page)).toContain(structuredData(page.schema, `https://zachdavids.com${page.path}`));
    }
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
    expect(index).toContain('<title>Zach Davids — Senior Software Engineer at Amazon</title>');
    expect(index).toContain('<link rel="canonical" href="https://zachdavids.com/" />');
    expect(index).toContain('<div id="root" data-page="home"><main>rendered home</main></div>');
    expect(index).toBe(renderDocument(template, home!, '<main>rendered home</main>'));

    // Rendered from the original template, not the index.html written just before it.
    const notFoundPage = await readDist(rootUrl, '404.html');
    expect(notFoundPage).toContain('<title>Page not found — Zach Davids</title>');
    expect(notFoundPage).toContain('<meta name="robots" content="noindex" />');
    expect(notFoundPage).toContain('<div id="root" data-page="not-found"><main>rendered not-found</main></div>');
    expect(notFoundPage).toBe(renderDocument(template, notFound!, '<main>rendered not-found</main>'));

    // Every page in the table, each in its own file: a page at a directory's address, such as resume/index.html, goes
    // into a directory the client build did not make.
    expect(resume.file).toBe('resume/index.html');
    for (const page of prerenderPages) {
      expect(await readDist(rootUrl, page.file), page.file).toBe(
        renderDocument(template, page, `<main>rendered ${page.id}</main>`),
      );
    }

    expect(existsSync(new URL('dist-ssr/', rootUrl))).toBe(false);
    expect(log.mock.calls).toEqual(prerenderPages.map((page) => [`prerendered ${page.id} -> dist/${page.file}`]));
  });

  it('names the release in every page when given one, and refuses one that is not a full commit SHA', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const release = 'fedcba9876543210fedcba9876543210fedcba98';
    const rootUrl = await projectRoot({ 'dist/index.html': template, 'dist-ssr/entry-server.js': serverEntry });

    for (const wrong of ['', 'main', release.slice(1), release.toUpperCase(), `${release}\n`]) {
      await expect(prerender(rootUrl, wrong), JSON.stringify(wrong)).rejects.toThrow(
        `RELEASE_COMMIT must be a full commit SHA; got ${JSON.stringify(wrong)}`,
      );
    }
    expect(await readDist(rootUrl, 'index.html')).toBe(template);

    await prerender(rootUrl, release);
    for (const page of prerenderPages) {
      expect(await readDist(rootUrl, page.file), page.file).toBe(
        renderDocument(template, page, `<main>rendered ${page.id}</main>`, release),
      );
    }
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
