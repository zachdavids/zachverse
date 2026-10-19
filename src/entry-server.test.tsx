import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../scripts/prerender-lib.ts';
import { resume } from './content/index.ts';
import { render } from './entry-server.tsx';

const contactLinks =
  '<nav aria-label="Contact"><ul class="links">' +
  '<li><a href="https://github.com/zachdavids" rel="me">GitHub</a></li>' +
  '<li><a href="https://www.linkedin.com/in/zacharydavids/" rel="me">LinkedIn</a></li>' +
  '<li><a href="mailto:zach@zachdavids.com">Email</a></li>' +
  '</ul></nav>';

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
        '<nav aria-label="Site"><ul class="links"><li><a href="/resume/">Résumé</a></li></ul></nav>' +
        contactLinks +
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

    it('opens with a link home, its heading, the headline, and the contact links', () => {
      expect(html.startsWith(
        '<main class="card">' +
          '<nav aria-label="Site" class="eyebrow"><a href="/">Zach Davids</a></nav>' +
          '<h1>Résumé</h1>' +
          '<p class="role">Senior Software Engineer | Embedded Linux, C++ &amp; Device Platforms</p>' +
          contactLinks +
          '<section><h2>Profile Summary</h2><ul class="bullets">',
      )).toBe(true);
      expect(html.endsWith('</section></main>')).toBe(true);
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
      // The contact links are the only other list items.
      expect(html.match(/<li>/g)).toHaveLength(lines.length + 3);
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
});
