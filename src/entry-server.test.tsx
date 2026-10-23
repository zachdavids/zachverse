import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../scripts/prerender-lib.ts';
import { caseStudy, howBuilt, resume, type Section } from './content/index.ts';
import { render } from './entry-server.tsx';

const contactLinks =
  '<nav aria-label="Contact"><ul class="links">' +
  '<li><a href="https://github.com/zachdavids" rel="me">GitHub</a></li>' +
  '<li><a href="https://www.linkedin.com/in/zacharydavids/" rel="me">LinkedIn</a></li>' +
  '<li><a href="mailto:zach@zachdavids.com">Email</a></li>' +
  '</ul></nav>';

// The top line of each page below the home page: a link home, then the site's other pages.
const siteNav = (...links: string[]) =>
  '<nav aria-label="Site" class="eyebrow"><ul class="trail"><li><a href="/">Zach Davids</a></li>' +
  links.map((link) => `<li>${link}</li>`).join('') +
  '</ul></nav>';
const resumeLink = '<a href="/resume/">Résumé</a>';
const caseStudyLink = '<a href="/work/kindle-feature-gating/">Case study</a>';
const howBuiltLink = '<a href="/how-this-site-is-built/">How this site is built</a>';

// One section as Sections renders it: its heading, then its paragraphs, then its list; a deep dive's text sits inside a
// closed details element.
function sectionMarkup(section: Section): string {
  const tag = section.ordered ? 'ol' : 'ul';
  const items = section.list?.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  const list = items === undefined ? '' : `<${tag} class="bullets">${items}</${tag}>`;
  const body = section.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('') + list;
  const shown = section.deepDive ? `<details class="deep-dive"><summary>Read the deep dive</summary>${body}</details>` : body;
  return `<section><h2 id="${section.id}">${escapeHtml(section.heading)}</h2>${shown}</section>`;
}

// A long page's text, in order: each section's heading, with the anchor a link to it uses, then its paragraphs, then
// its list, numbered when its order matters; and each section whole, as Sections renders it.
function expectSections(html: string, sections: readonly Section[]) {
  for (const section of sections) expect(html, section.id).toContain(sectionMarkup(section));
  const headings = [...html.matchAll(/<h2 id="([^"]*)">([^<]*)<\/h2>/g)].map((match) => [match[1], match[2]]);
  expect(headings).toEqual(sections.map((section) => [section.id, escapeHtml(section.heading)]));
  const paragraphs = [...html.matchAll(/<p>([^<]*)<\/p>/g)].map((match) => match[1]);
  expect(paragraphs).toEqual(sections.flatMap((section) => section.paragraphs).map(escapeHtml));
  const lists = [...html.matchAll(/<(ul|ol) class="bullets">(.*?)<\/\1>/g)];
  const items = lists.flatMap((list) => [...list[2]!.matchAll(/<li>([^<]*)<\/li>/g)].map((match) => match[1]));
  expect(items).toEqual(sections.flatMap((section) => section.list ?? []).map(escapeHtml));
  expect(lists.map((list) => list[1])).toEqual(
    sections.flatMap((section) => (section.list === undefined ? [] : [section.ordered ? 'ol' : 'ul'])),
  );
}

// A deep dive's heading stays in view, and its text sits in a details element that starts closed; no other section
// is hidden.
function expectDeepDives(html: string, sections: readonly Section[]) {
  const deepDives = sections.filter((section) => section.deepDive);
  expect(deepDives).not.toEqual([]);
  for (const section of deepDives) {
    expect(html).toContain(
      `<section><h2 id="${section.id}">${escapeHtml(section.heading)}</h2>` +
        '<details class="deep-dive"><summary>Read the deep dive</summary>',
    );
  }
  expect(html.match(/<details/g)).toHaveLength(deepDives.length);
}

// The exact markup prerendered into each page's #root. Every part is load
// bearing: styles.css targets the classes, hydration must reproduce it, and it
// is all a visitor sees before the bundle loads.
describe('render', () => {
  it('renders the home page as one card with the profile details, the page links, and the contact links', () => {
    expect(render('home')).toBe(
      '<main class="card">' +
        '<h1>Zach Davids</h1>' +
        '<p class="role">Senior Software Engineer at Amazon</p>' +
        '<p class="summary">I build embedded C++ systems, device-platform software, and AWS services for Kindle e-readers.</p>' +
        '<p class="summary">Before Amazon, I was a gameplay programmer at Rockstar Games.</p>' +
        '<div class="actions">' +
        '<nav aria-label="Site"><ul class="links">' +
        `<li>${resumeLink}</li><li>${caseStudyLink}</li><li>${howBuiltLink}</li>` +
        '</ul></nav>' +
        contactLinks +
        '</div>' +
        '</main>',
    );
  });

  it('renders the 404 page as one card that only links home', () => {
    expect(render('not-found')).toBe(
      '<main class="card">' +
        '<p class="eyebrow">404</p>' +
        '<h1>Page not found</h1>' +
        '<p class="status">There&#x27;s nothing at this address.</p>' +
        '<p><a href="/">Go to the home page</a></p>' +
        '</main>',
    );
  });

  describe('the résumé page', () => {
    const html = render('resume');

    it('opens with the site links, its heading, the headline, and the contact links', () => {
      expect(html.startsWith(
        '<div class="card">' +
          siteNav(caseStudyLink, howBuiltLink) +
          '<main><h1>Résumé</h1>' +
          '<p class="role">Senior Software Engineer | Embedded Linux, C++ &amp; Device Platforms</p>' +
          contactLinks +
          '<section><h2>Profile Summary</h2><ul class="bullets">',
      )).toBe(true);
      expect(html.endsWith('</section></main></div>')).toBe(true);
    });

    it("gives the résumé's sections in its order", () => {
      const headings = [...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map((match) => match[1]);
      expect(headings).toEqual(['Profile Summary', 'Technical Skills', 'Work Experience', 'Education']);
    });

    it('shows every line of the résumé once, as a list item or a skill', () => {
      const lines = [
        ...resume.summary,
        ...resume.experience.flatMap((role) => [...role.highlights, ...role.projects.flatMap((p) => p.highlights)]),
      ];
      for (const line of lines) expect(html.split(`<li>${escapeHtml(line)}</li>`), line).toHaveLength(2);
      // The site links and the contact links are the only other list items.
      expect(html.match(/<li>/g)).toHaveLength(lines.length + 3 + 3);
      for (const skill of resume.skills) {
        expect(html).toContain(`<div><dt>${escapeHtml(skill.name)}</dt><dd>${escapeHtml(skill.items)}</dd></div>`);
      }
    });

    it("lists the résumé's lines and skills in its order: the summary, then each role's, then its projects'", () => {
      const lines = [...html.matchAll(/<li>([^<]*)<\/li>/g)].map((match) => match[1]);
      expect(lines).toEqual(
        [
          ...resume.summary,
          ...resume.experience.flatMap((role) => [...role.highlights, ...role.projects.flatMap((p) => p.highlights)]),
        ].map(escapeHtml),
      );
      const skills = [...html.matchAll(/<dt>([^<]*)<\/dt>/g)].map((match) => match[1]);
      expect(skills).toEqual(resume.skills.map((skill) => escapeHtml(skill.name)));
    });

    it('heads each role and degree with its title, then its employer or school and dates', () => {
      const entries = [...html.matchAll(/<h3>([^<]*)<\/h3><p class="meta">([^<]*)<\/p>/g)].map((m) => [m[1], m[2]]);
      expect(entries).toEqual([
        ['Senior Software Development Engineer, Kindle', 'Amazon · Oct. 2024 - Present'],
        ['Software Development Engineer II, Amazon Kids', 'Amazon · Jul. 2021 - Oct. 2024'],
        ['Software Development Engineer I, Amazon Kids', 'Amazon · Mar. 2020 - Jul. 2021'],
        ['Junior Gameplay Programmer, Weapons Team', 'Rockstar Games (Rockstar Toronto) · Jan. 2020 - Mar. 2020'],
        ['Bachelor of Computer Science', 'Carleton University · Apr. 2019'],
      ]);
      const projects = [...html.matchAll(/<h4>([^<]*)<\/h4>/g)].map((match) => match[1]);
      expect(projects).toEqual(
        resume.experience.flatMap((role) => role.projects.map((project) => escapeHtml(project.name))),
      );
    });
  });

  describe('the case study', () => {
    const html = render('kindle-feature-gating');
    const { summary, diagram } = caseStudy;

    it('opens with the site links, heading, context, and three answers, and ends with the contact links', () => {
      expect(html.startsWith(
        '<div class="card">' +
          siteNav(resumeLink, howBuiltLink) +
          '<main>' +
          `<h1>${escapeHtml(caseStudy.title)}</h1>` +
          `<p class="role">${escapeHtml(caseStudy.context)}</p>` +
          '<dl class="points">' +
          `<div><dt>The problem</dt><dd>${escapeHtml(summary.problem)}</dd></div>` +
          `<div><dt>What I owned</dt><dd>${escapeHtml(summary.owned)}</dd></div>` +
          `<div><dt>What changed</dt><dd>${escapeHtml(summary.changed)}</dd></div>` +
          '</dl><section>',
      )).toBe(true);
      expect(html.endsWith(`</section></main>${contactLinks}</div>`)).toBe(true);
    });

    it('gives its sections in order', () => {
      expectSections(html, caseStudy.sections);
    });

    it('keeps its deep dives closed under their headings', () => {
      expectDeepDives(html, caseStudy.sections);
    });

    it('draws the diagram as lists of boxes, before and after', () => {
      const list = (tag: string, className: string, entries: readonly string[]) =>
        `<${tag} class="${className}" role="list">${entries.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')}</${tag}>`;
      const { before, after } = diagram;
      expect(html).toContain(
        '<figure class="diagram"><div class="paths">' +
          `<div class="path"><h3>${escapeHtml(before.label)}</h3>` +
          list('ol', 'boxes', before.boxes) +
          `<p class="note">${escapeHtml(before.note)}</p></div>` +
          `<div class="path"><h3>${escapeHtml(after.label)}</h3>` +
          list('ul', 'consumers', after.consumers) +
          '<ol class="boxes" role="list">' +
          after.boxes.map((box) => `<li>${escapeHtml(box)}</li>`).join('') +
          `<li class="container"><span>${escapeHtml(after.container)}</span>${list('ol', 'boxes', after.parts)}</li>` +
          '</ol>' +
          `<p class="note">${escapeHtml(after.note)}</p></div>` +
          `</div><figcaption>${escapeHtml(diagram.caption)}</figcaption></figure>`,
      );
    });

    it('places the diagram between the section it illustrates and the next', () => {
      const index = caseStudy.sections.findIndex((section) => section.id === diagram.afterSection);
      const [shown, next] = [caseStudy.sections[index]!, caseStudy.sections[index + 1]!];
      const figure = html.indexOf('<figure class="diagram">');
      expect(html.lastIndexOf('<section>', figure)).toBe(html.indexOf(`<section><h2 id="${shown.id}">`));
      expect(html.indexOf('<section>', figure)).toBe(html.indexOf(`<section><h2 id="${next.id}">`));
    });
  });

  describe('the "How this site is built" page', () => {
    const html = render('how-this-site-is-built');
    const sources = '<section><h2 id="sources">The code and the decision records</h2>';

    it('opens with the site links, its heading, and its introduction, and ends with the contact links', () => {
      expect(html.startsWith(
        '<div class="card">' +
          siteNav(resumeLink, caseStudyLink) +
          '<main>' +
          `<h1>${escapeHtml(howBuilt.title)}</h1>` +
          howBuilt.intro.map((line) => `<p class="summary">${escapeHtml(line)}</p>`).join('') +
          '<section>',
      )).toBe(true);
      expect(html.endsWith(`</section></main>${contactLinks}</div>`)).toBe(true);
    });

    it('gives its sections in order, then the links to its code and decision records', () => {
      const [text, rest] = html.split(sources);
      expectSections(text!, howBuilt.sections);
      const links = howBuilt.links.map(
        (link) => `<li><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></li>`,
      );
      expect(rest).toBe(`<ul class="bullets">${links.join('')}</ul></section></main>${contactLinks}</div>`);
    });

    it('keeps its deep dives closed under their headings', () => {
      expectDeepDives(html, howBuilt.sections);
    });
  });
});
