import { Diagram } from '../components/Diagram.tsx';
import { ContactLinks, SiteNav } from '../components/Links.tsx';
import { Sections } from '../components/Prose.tsx';
import { caseStudy } from '../content/index.ts';

/**
 * The flagship case study: the three answers a reader skims first (the problem, what Zach owned, and what changed),
 * then the sections that back them, with the architecture's diagram after the section it illustrates.
 */
export function CaseStudy() {
  const { summary, sections, diagram } = caseStudy;
  // content.test.ts holds the diagram to a section that exists.
  const split = sections.findIndex((section) => section.id === diagram.afterSection) + 1;
  return (
    <main className="card">
      <SiteNav current="kindle-feature-gating" />
      <h1>{caseStudy.title}</h1>
      <p className="role">{caseStudy.context}</p>
      <dl className="points">
        <div>
          <dt>The problem</dt>
          <dd>{summary.problem}</dd>
        </div>
        <div>
          <dt>What I owned</dt>
          <dd>{summary.owned}</dd>
        </div>
        <div>
          <dt>What changed</dt>
          <dd>{summary.changed}</dd>
        </div>
      </dl>
      <Sections sections={sections.slice(0, split)} />
      <Diagram diagram={diagram} />
      <Sections sections={sections.slice(split)} />
      <ContactLinks />
    </main>
  );
}
