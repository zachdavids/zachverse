import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { prerenderPages, renderDocument } from './prerender-lib.ts';

const template = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const [home, notFound] = prerenderPages;

describe('renderDocument', () => {
  it('fills the title, head, page id, and markup for the home page', () => {
    const html = renderDocument(template, home!, '<main>hello</main>');
    expect(html).toContain('<title>Zachverse — Zach Davids</title>');
    expect(html).toContain('<link rel="canonical" href="https://zachdavids.com/" />');
    expect(html).toContain('<div id="root" data-page="home"><main>hello</main></div>');
    expect(html).not.toContain('<!--app-');
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

  it('does not interpret $ patterns in rendered markup', () => {
    expect(renderDocument(template, home!, '<p>$& $1</p>')).toContain('<p>$& $1</p>');
  });
});
