import { ContactLinks, SiteNav } from '../components/Links.tsx';
import { Sections } from '../components/Prose.tsx';
import { howBuilt } from '../content/index.ts';

/**
 * How the site is built: the decisions that shaped it, each with its evidence, how an AI agent's work is directed and
 * checked, the trade-offs, and deep dives that open on request; then links to the repository and its decision records.
 */
export function HowBuilt() {
  return (
    <main className="card">
      <SiteNav current="how-this-site-is-built" />
      <h1>{howBuilt.title}</h1>
      {howBuilt.intro.map((paragraph) => (
        <p className="summary" key={paragraph}>
          {paragraph}
        </p>
      ))}
      <Sections sections={howBuilt.sections} />
      <section>
        <h2 id="sources">The code and the decision records</h2>
        <ul className="bullets">
          {howBuilt.links.map((link) => (
            <li key={link.href}>
              <a href={link.href}>{link.label}</a>
            </li>
          ))}
        </ul>
      </section>
      <ContactLinks />
    </main>
  );
}
