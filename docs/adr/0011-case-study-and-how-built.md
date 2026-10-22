# ADR 0011: The case study and "How this site is built"

- Status: Accepted (Phase 2, milestone 2)
- Date: 2026-10-22

## Context

Milestone 2 adds the plan's two long pages (ADR 0010, "Context"). The case study opens with what a recruiter needs: the problem that mattered, what Zach owned, and what changed. Then, for an engineer:
- context and constraints;
- the decisions, each with the alternatives rejected and its cost;
- how he led the work, within his team and beyond it;
- reliability, with the evidence for it;
- trade-offs and lessons;
- a diagram, where it helps;
- deep dives, for readers who want the detail.

"How this site is built" is organized around five decisions: the architecture, protecting email through the DNS move, checking each release where viewers get it, the pipeline's access, and directing the AI that wrote the site. Trade-offs and limits, deep dives, and links to the decision records follow. A second case study comes only if approved material is ready, and none is.

## Decision

**Flagship: Kindle's feature-gating migration,** the owner's choice on 2026-10-19, at `/work/kindle-feature-gating/`. The `/work/` segment leaves room for more case studies without moving this one.

**The case study's sources are the owner's résumé, his own record of the project, which isn't published, and his corrections to drafts.** Where they differ, his corrections win, then the résumé (the owner's calls, 2026-10-19 and 2026-10-22).
- It keeps to what the record holds with confidence, with the split between Zach's work, his teammates', and the platform team's.
- It gives only figures the résumé page shows or that the owner supplied for it, with scale in round words. `src/content/content.test.ts` fails on any other number in it but a year.
- It leaves out people's and systems' names, figures the owner keeps private, and what he chose not to publish.
- By the owner's choice, it says nothing about AI assistance. "How this site is built" covers how this site was made.
- The owner approved its text line by line on 2026-10-22.

**"How this site is built" takes its facts from this repository:** the decision records, the workflows and checks, and the pull requests. Where the record can't establish a detail, the page claims no more than the record does. It keeps to decisions and their evidence, and leaves runbooks to the decision records it links. It dates itself, as of October 2026. The owner approved its text on 2026-10-22.

**Content.** The pages' text is in `src/content/case-study.ts` and `src/content/how-built.ts`, plain data like the rest (ADR 0010, "Content"). Both build on `Section` (`src/content/prose.ts`): a heading, paragraphs, and an optional list, numbered when its order matters. A section's ID is its heading's anchor, so links to it keep working.

**Deep dives.** Each long page ends with optional deep dives.
- A deep dive's heading shows, and its text sits in a `<details>` element that starts closed and opens without JavaScript.
- The heading stays outside the `<summary>`, so screen readers still announce it as a heading.
- `content.test.ts` keeps the deep dives last, each headed "Deep dive: ".

**Navigation.**
- Every page below the home page opens with a line of links: Zach's name, which links home, then the site's other pages. On the résumé it replaces the link home.
- The home page's buttons list every page, so the row wraps on most screens.
- The case study and "How this site is built" end with the contact links.
- The 404 page still links only home.
- When Tab scrolls a link or a deep dive's toggle into view, the root's scroll padding leaves room at the window's edges, so its focus outline shows whole.

**The diagram is HTML, not a picture.**
- The boxes are list items and the arrows are drawn in CSS, so a screen reader reads each path in order and skips the arrows. Each list says `role="list"`, since Safari doesn't expose a list drawn without markers as one, and each arrowhead is clipped to its triangle, so contrast themes don't turn it into a bar.
- It follows the color scheme, needs no JavaScript, and adds nothing to the image budget.
- The "before" column is the path from a C++ app to the assignment logic. The "after" column shows the apps that share the daemon, the façade in each, and the daemon's parts.
- The columns sit side by side where there's room and stack on a phone.

**Structured data.** ADR 0010 gives every page with an address a `ProfilePage`, which stays for the home page and the résumé. The two long pages are articles by Zach, so they carry an `Article`: its headline is the page's heading, and its author is Zach, under the same `@id` as the profile pages' main entity. Each page's entry in the table names its type, and `check:dist` checks it.

**Checks.** `check:dist` looks for each long page's heading and each section's heading with its anchor. The render tests pin both pages' markup, deep dives included, and the browser check and Lighthouse find them in the table (ADR 0010, "Checks").

## Limits

- **Truth:** tests catch figures and markup, not a false sentence. The case study rests on the owner's record, his résumé, his corrections, and his approval. "How this site is built" rests on the repository and his approval.
- **Going stale:** both pages speak as of October 2026, and both need checking with each revision.
  - The case study's "as of" claims are his role and work in progress.
  - "How this site is built" dates its intro, its rollback record, and its plans.
  - Its text also needs an edit when the checks, the release workflow, the decision records it names, or the plan change. Phase 3's 3D is a known change ahead.
- **One bundle:** the two pages add 10.6 KiB to the one script every page loads, which grows from milestone 1's 75.3 KiB to 85.9 KiB of its 100 KiB budget (ADR 0010, "Limits").
- **The diagram simplifies:** it leaves out the bypass paths and the bridge for Java consumers, which its notes mention.
- **Release order:** the pages below the home page link to one another, so a release that adds a page can briefly link to it before it is written (ADR 0006, "Publishes the pages").
