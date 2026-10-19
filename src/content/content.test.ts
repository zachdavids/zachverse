import { describe, expect, it } from 'vitest';
import { render } from '../entry-server.tsx';
import { pages, profile, resume, site } from './index.ts';

// Every string the content module holds, however deeply nested.
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

describe('pages', () => {
  it('gives each page a distinct id and file, and each address once', () => {
    expect(new Set(pages.map((page) => page.id)).size).toBe(pages.length);
    expect(new Set(pages.map((page) => page.file)).size).toBe(pages.length);
    const paths = pages.flatMap((page) => (page.path === null ? [] : [page.path]));
    expect(new Set(paths).size).toBe(paths.length);
  });

  // infra/functions/viewer-request.js serves a path ending in / from that directory's index.html; the trailing slash is
  // the canonical form, and the same page also answers without it.
  it('serves each address from the file the viewer-request function maps it to', () => {
    for (const page of pages) {
      if (page.path === null) continue;
      expect(page.path, page.id).toMatch(/^\/(?:[a-z0-9-]+\/)*$/);
      expect(page.file, page.id).toBe(`${page.path.slice(1)}index.html`);
    }
  });

  it('has a home page at the root and one 404 page with no address', () => {
    expect(pages.find((page) => page.id === 'home')).toMatchObject({ path: '/', file: 'index.html' });
    expect(pages.filter((page) => page.path === null)).toEqual([expect.objectContaining({ id: 'not-found', file: '404.html' })]);
  });
});

describe('the résumé', () => {
  it('gives every role, project, skill group, and degree a distinct id', () => {
    const ids = [
      ...resume.experience.flatMap((role) => [role.id, ...role.projects.map((project) => project.id)]),
      ...resume.skills.map((skill) => skill.id),
      ...resume.education.map((degree) => degree.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it('lists the roles newest first, ending with Rockstar Games', () => {
    expect(resume.experience.map((role) => role.dates)).toEqual([
      'Oct. 2024 - Present',
      'Jul. 2021 - Oct. 2024',
      'Mar. 2020 - Jul. 2021',
      'Jan. 2020 - Mar. 2020',
    ]);
    expect(resume.experience.at(-1)?.employer).toBe('Rockstar Games (Rockstar Toronto)');
  });
});

// The résumé the content comes from has a phone number, and a "City, ST, Country" line for Zach and for each employer
// and the school; the site shows neither (approved 2026-10-18). The places themselves aren't named here, since this
// repository is public. Instead, no content type has a field for a location (resume.ts), which `satisfies` holds to,
// and these patterns catch the résumé's forms of both in the content and in every page as it renders.
const PHONE = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}/;
const LOCATION = /\b[A-Z][a-z]+(?: [A-Z][a-z]+)*, [A-Z]{2}\b/;

describe('the content', () => {
  const all = strings({ pages, profile, resume, site });

  it('holds no phone number, and no location in the form "City, ST"', () => {
    expect(all.filter((text) => PHONE.test(text) || LOCATION.test(text))).toEqual([]);
  });

  it('keeps the strings plain text, with no markup or Markdown emphasis', () => {
    // An asterisk, or an underscore at the edge of a word, is emphasis left behind; one inside a word, as in
    // compile_commands.json, is not.
    expect(all.filter((text) => /[<>*]|\\[#_]|(?:^|\s)_\S|\S_(?:\s|$)/.test(text))).toEqual([]);
  });

  // The patterns themselves, on the forms the résumé writes.
  it('recognizes a phone number and a "City, ST" location in the forms the résumé writes them', () => {
    expect(['(555) 010-0199', '555-010-0199', '555.010.0199'].filter((text) => !PHONE.test(text))).toEqual([]);
    expect(['Springfield, ZZ, Country', 'Some Town, QQ'].filter((text) => !LOCATION.test(text))).toEqual([]);
    // Names, products, and lists of technologies, as the content writes them, are not locations.
    const others = ['Zach Davids, Senior Software Engineer', 'Java, AWS', 'C++, Java', 'Lambda, API Gateway'];
    expect(others.filter((text) => LOCATION.test(text))).toEqual([]);
  });
});

describe('every page', () => {
  it.each(pages.map((page) => page.id))('renders no phone number or "City, ST" location on the %s page', (id) => {
    const html = render(id);
    expect(html.match(PHONE)).toBeNull();
    expect(html.match(LOCATION)).toBeNull();
  });
});
