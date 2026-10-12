import { readFile, rm, writeFile } from 'node:fs/promises';
import { site } from '../src/content.ts';

export interface PrerenderPage {
  id: 'home' | 'not-found';
  file: string;
  title: string;
  description: string;
  head: string;
}

export const prerenderPages: readonly PrerenderPage[] = [
  {
    id: 'home',
    file: 'index.html',
    title: site.title,
    description: site.description,
    head: `<link rel="canonical" href="${site.origin}/" />`,
  },
  {
    id: 'not-found',
    file: '404.html',
    title: site.notFoundTitle,
    description: site.description,
    head: '<meta name="robots" content="noindex" />',
  },
];

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

function replaceOnce(source: string, search: string | RegExp, value: string): string {
  const count =
    typeof search === 'string' ? source.split(search).length - 1 : (source.match(new RegExp(search, 'g')) ?? []).length;
  if (count !== 1) throw new Error(`Expected exactly one ${String(search)} in the HTML template, found ${count}`);
  return source.replace(search, () => value);
}

export function renderDocument(template: string, page: PrerenderPage, appHtml: string): string {
  if (!appHtml.trim()) throw new Error(`Prerendered markup for "${page.id}" is empty`);
  const description = escapeHtml(page.description);
  let html = replaceOnce(template, markers.title, `<title>${page.title}</title>`);
  html = replaceOnce(html, markers.description, `<meta name="description" content="${description}" />`);
  html = replaceOnce(html, markers.head, page.head);
  html = replaceOnce(html, markers.page, `data-page="${page.id}"`);
  // Last, so the marker counts never see the markup, such as an SVG <title>.
  return replaceOnce(html, markers.html, appHtml);
}

// Renders every page into rootDir's dist/ with the SSR bundle in dist-ssr/,
// then deletes dist-ssr/. rootDir is a directory URL ending in "/".
export async function prerender(rootDir: URL): Promise<void> {
  const distDir = new URL('dist/', rootDir);
  const ssrDir = new URL('dist-ssr/', rootDir);

  const template = await readFile(new URL('index.html', distDir), 'utf8');
  const { render } = (await import(new URL('entry-server.js', ssrDir).href)) as {
    render: (page: string) => string;
  };

  for (const page of prerenderPages) {
    await writeFile(new URL(page.file, distDir), renderDocument(template, page, render(page.id)));
    console.log(`prerendered ${page.id} -> dist/${page.file}`);
  }

  await rm(ssrDir, { recursive: true, force: true });
}
