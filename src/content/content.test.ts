import { describe, expect, it } from 'vitest';
import { render } from '../entry-server.tsx';
import { caseStudy, howBuilt, pages, profile, resume, site, type Section } from './index.ts';

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
    expect(pages.filter((page) => page.path === null)).toEqual([
      expect.objectContaining({ id: 'not-found', file: '404.html' }),
    ]);
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

describe('the long pages', () => {
  // Each id is its section's anchor, so a link can point at it; "sources" is the anchor of the links HowBuilt adds.
  it.each([
    ['case study', caseStudy.sections.map((section) => section.id)],
    ['"How this site is built"', [...howBuilt.sections.map((section) => section.id), 'sources']],
  ])('give each %s section a distinct id', (_, ids) => {
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  // A deep dive is optional reading, closed until opened, so the decisions and results come first and none hides there.
  it.each<[string, readonly Section[]]>([
    ['case study', caseStudy.sections],
    ['"How this site is built"', howBuilt.sections],
  ])('put the %s deep dives last, each headed as one', (_, sections) => {
    const first = sections.findIndex((section) => section.deepDive);
    expect(first).toBeGreaterThan(0);
    expect(sections.slice(first).every((section) => section.deepDive)).toBe(true);
    for (const section of sections) {
      expect(section.heading.startsWith('Deep dive: '), section.id).toBe(section.deepDive === true);
    }
  });

  it('put the diagram after a section of the case study', () => {
    expect(caseStudy.sections.map((section) => section.id)).toContain(caseStudy.diagram.afterSection);
  });

  // Zach keeps some of the project's figures private, so the case study gives only those the résumé page already
  // shows, and scale in its round words, plus any he supplied for the page itself. Years aside, each of its numbers is
  // one of those, though a small one, such as 1, could match an unrelated number on the résumé.
  it('give no figure in the case study but those the résumé page shows or Zach supplied', () => {
    const numbers = (value: unknown) => strings(value).flatMap((text) => text.match(/\d+(?:[.,]\d+)*/g) ?? []);
    // The feature gates he removed ("Beyond my team"), which he supplied on 2026-10-22.
    const supplied = ['30'];
    const published = new Set([...numbers(resume), ...supplied]);
    expect(numbers(caseStudy).filter((number) => !/^20\d\d$/.test(number) && !published.has(number))).toEqual([]);
  });

  it('link only to the public repository on GitHub, each page once', () => {
    const hrefs = howBuilt.links.map((link) => link.href);
    expect(hrefs.filter((href) => !/^https:\/\/github\.com\/zachdavids\/zachverse(?:\/|$)/.test(href))).toEqual([]);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

// The résumé the content comes from has a phone number, and a "City, ST, Country" line for Zach and for each employer
// and the school; the site shows neither (approved 2026-10-18). This test names none of the places it guards against,
// since this repository is public. Instead, no content type has a field for a location (resume.ts), which `satisfies`
// holds to, and these patterns catch the résumé's forms of both in the content and in every page as it renders.
const PHONE = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}/;
const LOCATION = /\b[A-Z][a-z]+(?: [A-Z][a-z]+)*, [A-Z]{2}\b/;

describe('the content', () => {
  const all = strings({ pages, profile, resume, site, caseStudy, howBuilt });

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
