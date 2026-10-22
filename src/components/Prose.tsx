import type { Section } from '../content/prose.ts';

/**
 * A long page's sections, each a heading that can be linked to, then its paragraphs and its list. A deep dive keeps its
 * heading in view and its text in a closed details element, which opens without JavaScript; the heading stays outside
 * the summary, where some screen readers would no longer announce it as a heading.
 */
export function Sections({ sections }: { sections: readonly Section[] }) {
  return sections.map((section) => {
    const body = [
      ...section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>),
      section.list === undefined ? null : section.ordered ? (
        <ol className="bullets" key="list">
          {section.list.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      ) : (
        <ul className="bullets" key="list">
          {section.list.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ),
    ];
    return (
      <section key={section.id}>
        <h2 id={section.id}>{section.heading}</h2>
        {section.deepDive ? (
          <details className="deep-dive">
            <summary>Read the deep dive</summary>
            {body}
          </details>
        ) : (
          body
        )}
      </section>
    );
  });
}
