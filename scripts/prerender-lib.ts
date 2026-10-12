import { site } from '../src/content.ts';

export interface PrerenderPage {
  id: 'home' | 'not-found';
  file: string;
  title: string;
  head: string;
}

export const prerenderPages: readonly PrerenderPage[] = [
  {
    id: 'home',
    file: 'index.html',
    title: site.title,
    head: `<link rel="canonical" href="${site.origin}/" />`,
  },
  {
    id: 'not-found',
    file: '404.html',
    title: site.notFoundTitle,
    head: '<meta name="robots" content="noindex" />',
  },
];

const markers = {
  head: '<!--app-head-->',
  html: '<!--app-html-->',
  page: 'data-page="home"',
  title: /<title>[^<]*<\/title>/,
};

function replaceOnce(source: string, search: string | RegExp, value: string): string {
  const count =
    typeof search === 'string' ? source.split(search).length - 1 : (source.match(new RegExp(search, 'g')) ?? []).length;
  if (count !== 1) throw new Error(`Expected exactly one ${String(search)} in the HTML template, found ${count}`);
  return source.replace(search, () => value);
}

export function renderDocument(template: string, page: PrerenderPage, appHtml: string): string {
  if (!appHtml.trim()) throw new Error(`Prerendered markup for "${page.id}" is empty`);
  let html = replaceOnce(template, markers.title, `<title>${page.title}</title>`);
  html = replaceOnce(html, markers.head, page.head);
  html = replaceOnce(html, markers.page, `data-page="${page.id}"`);
  return replaceOnce(html, markers.html, appHtml);
}
