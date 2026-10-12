import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App, isPageId } from './App.tsx';
import { profile } from './content.ts';

describe('home page', () => {
  const html = renderToString(<App page="home" />);

  it('shows the name, confirmed role, and status', () => {
    expect(html).toContain('<h1>Zach Davids</h1>');
    expect(html).toContain('Senior Software Engineer at Amazon');
    expect(html).toContain('Interactive portfolio coming soon.');
  });

  it('links only to the confirmed contact destinations', () => {
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([
      'https://github.com/zachdavids',
      'https://www.linkedin.com/in/zacharydavids/',
      'mailto:zach@zachdavids.com',
    ]);
    expect(hrefs).toEqual(profile.links.map((link) => link.href));
  });
});

describe('not-found page', () => {
  const html = renderToString(<App page="not-found" />);

  it('explains the page is missing and links home', () => {
    expect(html).toContain('<h1>Page not found</h1>');
    expect(html).toContain('href="/"');
    expect(html).not.toContain(profile.role);
  });
});

describe('isPageId', () => {
  it('accepts known pages only', () => {
    expect(isPageId('home')).toBe(true);
    expect(isPageId('not-found')).toBe(true);
    expect(isPageId('admin')).toBe(false);
    expect(isPageId(undefined)).toBe(false);
  });
});
