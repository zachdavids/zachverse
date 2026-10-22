import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { type Page, type PageId, pages, profile, type Schema, site } from '../src/content/index.ts';

export interface PrerenderPage {
  id: PageId;
  file: string;
  title: string;
  description: string;
  head: string;
}

const markers = {
  head: '<!--app-head-->',
  html: '<!--app-html-->',
  page: 'data-page="home"',
  title: /<title>[^<]*<\/title>/,
  description: /<meta name="description" content="[^"]*" \/>/,
};

// Escapes text or an attribute value the way React's server renderer does.
export function escapeHtml(value: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };
  return value.replace(/[&<>"']/g, (char) => entities[char]!);
}

/**
 * Structured data for the page at `url`. A page about Zach has him as its main entity, with the profiles that are also
 * his; an article has its headline and Zach as its author, by the same @id. JSON.stringify escapes nothing that could
 * end the script element, so every < is written as \u003c, which JSON reads back as <.
 */
export function structuredData(schema: Schema, url: string): string {
  const person = { '@type': 'Person', '@id': `${site.origin}/#person`, name: profile.name, url: `${site.origin}/` };
  const context = 'https://schema.org';
  const data =
    schema.type === 'Article'
      ? { '@context': context, '@type': 'Article', url, headline: schema.headline, author: person }
      : {
          '@context': context,
          '@type': 'ProfilePage',
          url,
          mainEntity: {
            ...person,
            jobTitle: profile.title,
            worksFor: { '@type': 'Organization', name: profile.employer },
            sameAs: profile.links.filter((link) => link.href.startsWith('https:')).map((link) => link.href),
          },
        };
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/**
 * The head tags a page adds to the template's. A page with an address names its canonical URL, gives link previews
 * their title, description, and picture (Open Graph, which X also reads), and carries structured data; the 404 page,
 * which every missing address serves, asks search engines not to index it.
 */
export function headFor(page: Page): string {
  if (page.path === null) return '<meta name="robots" content="noindex" />';
  const url = `${site.origin}${page.path}`;
  const meta = (property: string, content: string | number) =>
    `<meta property="${property}" content="${escapeHtml(String(content))}" />`;
  return [
    `<link rel="canonical" href="${escapeHtml(url)}" />`,
    meta('og:type', 'website'),
    meta('og:site_name', site.name),
    meta('og:title', page.title),
    meta('og:description', page.description),
    meta('og:url', url),
    meta('og:image', `${site.origin}${site.image.path}`),
    meta('og:image:width', site.image.width),
    meta('og:image:height', site.image.height),
    meta('og:image:alt', site.image.alt),
    '<meta name="twitter:card" content="summary_large_image" />',
    `<script type="application/ld+json">${structuredData(page.schema, url)}</script>`,
  ].join('\n    ');
}

export const prerenderPages: readonly PrerenderPage[] = pages.map((page) => ({
  id: page.id,
  file: page.file,
  title: page.title,
  description: page.description,
  head: headFor(page),
}));

function replaceOnce(source: string, search: string | RegExp, value: string): string {
  const count =
    typeof search === 'string' ? source.split(search).length - 1 : (source.match(new RegExp(search, 'g')) ?? []).length;
  if (count !== 1) throw new Error(`Expected exactly one ${String(search)} in the HTML template, found ${count}`);
  return source.replace(search, () => value);
}

// A release is named by its full commit SHA (ADR 0006).
const RELEASE = /^[0-9a-f]{40}$/;

// release, if given, is the commit the page is built from; the deploy build names it, so the page served shows which
// release is live.
export function renderDocument(template: string, page: PrerenderPage, appHtml: string, release?: string): string {
  if (!appHtml.trim()) throw new Error(`Prerendered markup for "${page.id}" is empty`);
  const description = escapeHtml(page.description);
  const releaseTag = release === undefined ? '' : `\n    <meta name="zachverse-release" content="${release}" />`;
  let html = replaceOnce(template, markers.title, `<title>${escapeHtml(page.title)}</title>`);
  html = replaceOnce(html, markers.description, `<meta name="description" content="${description}" />`);
  html = replaceOnce(html, markers.head, `${page.head}${releaseTag}`);
  html = replaceOnce(html, markers.page, `data-page="${page.id}"`);
  // Last, so the marker counts never see the markup, such as an SVG <title>.
  return replaceOnce(html, markers.html, appHtml);
}

// Renders every page into rootDir's dist/ with the SSR bundle in dist-ssr/,
// then deletes dist-ssr/. rootDir is a directory URL ending in "/". release,
// if given, is the commit the pages are built from.
export async function prerender(rootDir: URL, release?: string): Promise<void> {
  if (release !== undefined && !RELEASE.test(release)) {
    throw new Error(`RELEASE_COMMIT must be a full commit SHA; got ${JSON.stringify(release)}`);
  }
  const distDir = new URL('dist/', rootDir);
  const ssrDir = new URL('dist-ssr/', rootDir);

  const template = await readFile(new URL('index.html', distDir), 'utf8');
  const { render } = (await import(new URL('entry-server.js', ssrDir).href)) as {
    render: (page: string) => string;
  };

  for (const page of prerenderPages) {
    const file = new URL(page.file, distDir);
    // A page served at a directory's address, such as resume/index.html, is written into that directory.
    await mkdir(new URL('./', file), { recursive: true });
    await writeFile(file, renderDocument(template, page, render(page.id), release));
    console.log(`prerendered ${page.id} -> dist/${page.file}`);
  }

  await rm(ssrDir, { recursive: true, force: true });
}
