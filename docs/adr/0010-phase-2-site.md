# ADR 0010: The Phase 2 site: design, content, pages, and checks

- Status: Accepted (Phase 2, milestone 1)
- Date: 2026-10-18

## Context

Phase 2, as the owner planned it on 2026-10-16, makes the site a complete HTML portfolio before any 3D. It has a home page that names Zach's role and both employers, an accessible résumé, a flagship case study, a "How this site is built" page, and contact links. Every page is prerendered and works without JavaScript. The plan also asks for:
- metadata for search and link previews;
- axe and Lighthouse in CI;
- explicit size budgets;
- lab targets of LCP ≤ 2.5 s and CLS ≤ 0.1. INP ≤ 200 ms needs field data, which the site doesn't collect;
- URL handling verified as production serves it: direct loads and refresh, trailing slashes, query strings, assets, and genuine 404s, never the home page with 200 for an unknown path.

Phase 1's documents assumed Phase 2 would bring the 3D scenes. Under this plan they come in Phase 3, and `docs/phase-2-inputs.md`'s "3D content" items move with them (`docs/progress.md`, "Phase 2").

Milestone 1 delivers the design direction, the content module, the home page, navigation, and verified URL handling. It also brings the résumé page forward from milestone 2, for two reasons:
- A page can link only to pages that exist. `check:dist` fails a reference to a missing file, and the deploy's smoke test fails a release whose links don't load.
- The résumé is the first page below the root, so it is the page that proves nested addresses.

## Decision

**Design: Phase 1's card.** Two homepage concepts were made for the plan's visual checkpoint and declined on 2026-10-18: an e-ink "Sleep Screen" and a game-manual "Instruction booklet". So was a sticker sheet of employer and game logos, which the logos' trademarks rule out. The owner kept Phase 1's layout:
- a centered card on an off-white page;
- system fonts;
- a light and a dark palette;
- pill-shaped links.

New pages extend that layout. The résumé is a longer card with headings for its sections, roles, and projects. The pages download no web fonts and show no images, and nothing on them moves. The layout may stay for good, or a redesign by the owner or a designer may replace it. To keep a redesign cheap, the pages take all their text from `src/content/`, so a redesign replaces only `src/pages/`, `src/components/`, and `src/styles.css`.

**Content: `src/content/`.**
- **`profile.ts`:** the name, title, employer, the home page's two summary lines, and the contact links.
- **`resume.ts`:** the résumé.
- **`site.ts`:** the site's name and origin, the preview picture, and the page table below.

`index.ts` re-exports all three. They stay plain data, because the prerender, `check:dist`, the browser check, and the Lighthouse run load them under plain Node (`docs/phase-2-inputs.md`, "Content module"). Every role, project, skill group, degree, and page has a stable ID, and a page's ID is the `data-page` value it hydrates by.

The résumé is the owner's résumé of 2026-10-14. On 2026-10-18 the owner approved it for the site as written, without its emphasis, its phone number, or any location: his city, his employers', or his school's. Tests keep phone numbers and those places out of the content. The owner approved the home page's two summary lines, worded from the résumé, the same day.

**Pages and addresses.** One table, `pages` in `src/content/site.ts`, lists every page. Each entry has the page's ID, its address, the file the build writes, its link label, its title, and its description. The app, the prerender, the sitemap's test, `check:dist`, both browser-check runs, and the Lighthouse run all read it (`docs/phase-2-inputs.md`, "Routes"). An address ends in a slash, and that form is canonical.

The viewer-request function and the distribution's 404 response (ADR 0003) already serve this scheme, so no infrastructure change is needed:

| Request | Object asked of S3 | Response |
| --- | --- | --- |
| `/` | `index.html` | 200, the home page |
| `/resume/` | `resume/index.html` | 200, the résumé, at its canonical address |
| `/resume` | `resume/index.html` | 200, the same page, which names `/resume/` as canonical. A redirect would need a change to the function |
| `/resume/?from=x` | `resume/index.html` | 200. The query string is in neither the function's mapping nor the cache key (`CachingOptimized`) |
| `/resume/index.html` | `resume/index.html` | 200, the same page |
| `/assets/index-<hash>.js` | itself | 200, cached for a year; a missing asset gets 404 |
| any other path, such as `/resume/x` | `resume/x/index.html`, which is missing | 404, with the 404 page (`noindex`) |
| `/_releases/...` | the record itself | S3's 403 (ADR 0006) |
| `www.zachdavids.com/...` | none | 301 to the apex, keeping the path and query |

The function looks up a path whose last segment holds a dot as a file, so a page address can't contain one. The page table's test enforces this: each address is a run of lowercase words, each ending in a slash, and its file is the address followed by `index.html`.

**Head tags.** Every page with an address names its canonical URL. It also gives link previews its title, description, URL, and a picture: the Open Graph tags, which X reads too, plus `twitter:card`. The picture is `public/og-image.png`, at 1200 × 630.

Each such page also carries a JSON-LD `ProfilePage`. Its main entity is Zach: his name, title, and employer, with his GitHub and LinkedIn profiles as `sameAs`. Any `<` in it is written as an escape, so the data can't end its script element.

The 404 page asks not to be indexed and has none of these tags. `public/sitemap.xml` lists the pages that have an address, and `tests/repo-policy.test.ts` keeps it equal to the table. `robots.txt` is unchanged.

**Preview picture.** `docs/og-image/render.mjs` renders `public/og-image.png` from the name and role in `src/content/profile.ts`, using Phase 1's card, palette, and system fonts. The committed picture was rendered on Windows, in Segoe UI. Run the script again after a change to the name, role, or palette.

TODO-CHECKS

**Test tooling.** Two new dev dependencies, pinned exactly like Playwright:
- axe-core 4.13.0, published 2026-08-05.
- Lighthouse 13.5.0, published 2026-09-18. Its own axe-core range, `^4.13.0`, resolves to the same copy.

They are pinned because a new rule or a scoring change could fail CI with no change to the site. The 109 packages they add include none with an install script beyond the reviewed ones, and every package in the lockfile still comes from its npm registry tarball with a sha512 hash (`tests/repo-policy.test.ts`). They are newer versions only by reviewed change, since Dependabot updates only the GitHub Actions.

## Verification before the merge (2026-10-18)

TODO-VERIFY

## Limits

TODO-LIMITS
