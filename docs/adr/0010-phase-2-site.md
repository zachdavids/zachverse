# ADR 0010: The Phase 2 site: design, content, pages, and checks

- Status: Accepted (Phase 2, milestone 1)
- Date: 2026-10-18, revised 2026-10-19 after review and for the public résumé

## Context

Phase 2, as the owner planned it on 2026-10-16, makes the site a complete HTML portfolio before any 3D. It has a home page that names Zach's role and both employers, an accessible résumé, a flagship case study, a "How this site is built" page, and contact links. Every page is prerendered and works without JavaScript. The plan also asks for:
- metadata for search and link previews;
- axe and Lighthouse in CI;
- explicit size budgets;
- lab targets of LCP ≤ 2.5 s and CLS ≤ 0.1. INP ≤ 200 ms needs field data, which the site doesn't collect;
- URL handling verified as production serves it: direct loads and refresh, trailing slashes, query strings, assets, and genuine 404s, never the home page with 200 for an unknown path.

Phase 1's documents assumed Phase 2 would bring the 3D scenes. Under this plan they come in Phase 3, and the notes written for them move too (`docs/progress.md`, "Phase 2").

Milestone 1 delivers the design direction, the content module, the home page, navigation, and verified URL handling. It also brings the résumé page forward from milestone 2, for two reasons:
- A page can link only to pages that exist. `check:dist` fails a reference to a missing file, and the deploy's smoke test fails a release whose links don't load.
- The résumé is the first page below the root, so it is the page that proves nested addresses.

## Decision

**Design: Phase 1's card.** Two homepage concepts were made for the plan's visual checkpoint and declined on 2026-10-18: an e-ink "Sleep Screen" and a game-manual "Instruction booklet". So was a sticker sheet of employer and game logos, which the logos' trademarks rule out. The owner kept Phase 1's layout:
- a centered card on an off-white page;
- system fonts;
- a light and a dark palette;
- pill-shaped links.

New pages extend that layout, and the pages show no "Zachverse" label. The résumé is a longer card with headings for its sections, roles, and projects. The pages download no web fonts and show no images, and nothing on them moves.

The layout may stay for good, or a redesign by the owner or a designer may replace it. To keep a redesign cheap, the pages take their facts from `src/content/`. The components hold only interface words: section headings, link labels, and the 404 page's text. A redesign replaces `src/pages/`, `src/components/`, and `src/styles.css`, and the tests that pin their markup.

**Content: `src/content/`.**
- **`profile.ts`:** the name, title, employer, the home page's two summary lines, and the contact links.
- **`resume.ts`:** the résumé.
- **`site.ts`:** the site's name and origin, the preview picture, and the page table below.

`index.ts` re-exports all three. They stay plain data, because the prerender, `check:dist`, the browser check, and the Lighthouse run load them under plain Node (`docs/phase-2-inputs.md`, "Content module"). Every role, project, skill group, degree, and page has a stable ID, and a page's ID is the `data-page` value it hydrates by.

**The résumé is a public version of the owner's résumé of 2026-10-14.**
- **Approved 2026-10-18:** the résumé as written, without its emphasis, its phone number, or any location: his city, his employers', or his school's.
- **Changed 2026-10-19:** the owner chose to leave out the figures he keeps private: business, traffic, and engagement numbers, and raw reliability rates. Fleet scale is given in round words ("millions of devices"). The rest is unchanged.
- **No download link:** the full résumé goes out privately, on request. The owner judged a trimmed PDF not worth offering.

Tests keep phone numbers, and the résumé's "City, ST" form of a location, out of the content and the rendered pages, and no content type has a field for a location. The places themselves aren't named in this repository, which is public. The owner approved the home page's two summary lines, worded from the résumé, on 2026-10-18.

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

A release writes the home page after every other page, since it links to each of them (ADR 0006, "Publishes the pages").

**Head tags.** Every page with an address names its canonical URL. It also gives link previews a title, description, URL, and picture: the Open Graph tags, which X reads too, plus `twitter:card`. The previews name the site "Zach Davids", as the pages do. The picture is `public/og-image.png`, at 1200 × 630. The home page's description is its two summary lines, which name both employers within the width search results show.

Each such page also carries a JSON-LD `ProfilePage`. Its main entity is Zach: his name, title, and employer, with his GitHub and LinkedIn profiles as `sameAs`. Any `<` in it is written as an escape, so the data can't end its script element.

The 404 page asks not to be indexed and has none of these tags. `public/sitemap.xml` lists the pages that have an address, and `tests/repo-policy.test.ts` keeps it equal to the table. `robots.txt` is unchanged.

**Preview picture.** `docs/og-image/render.mjs` renders `public/og-image.png` in Phase 1's card. It takes the name and role from `src/content/profile.ts`, the domain from `src/content/site.ts`, and the palette from `src/styles.css`. The committed picture was rendered on Windows, in Segoe UI. Run the script again after a change to any of them.

**Checks.** Each check is named here, and its tests say what it checks.
- **`scripts/check-dist-lib.ts`** (`npm run check:dist`) runs in CI and in the deploy build. It checks every page's head, its link-preview tags, its structured data, and its links, and the size budgets below.
- **`scripts/browser-check-lib.ts`**, the browser check, runs in CI, in the deploy build, and on the live release (ADR 0006).
  - Each page with an address is loaded at 320, 768, and 1280 pixels, and at 320 in dark mode. The 404 page is loaded at 320 pixels, in light and dark mode.
  - Each load checks the page's Tab stops and runs axe-core's WCAG 2.0, 2.1, and 2.2 A and AA rules, and its best practices.
  - Each page is also loaded at its other addresses, and a missing page below it must get the 404 page.
  - All the loads stay within 200 requests, a fifth of the web ACL's rate limit for one address.
  - In CI, it saves a screenshot of each of those loads, and CI keeps them with the run.
- **`scripts/lighthouse-lib.ts`** (`npm run check:lighthouse`) runs in CI's web job only. It measures each page with an address as a phone and as a desktop. It holds them to the plan's LCP and CLS targets, to total blocking time (TBT) of at most 200 ms in place of INP, and to Lighthouse's scores. The deploy workflow skips it, because lab scores vary from run to run and CI on the pull request gates the merge.
- **`tests/path-mapping.test.ts`** runs the viewer-request function against the two copies of its mapping. One is `check:dist`'s. The other is in `scripts/release-lib.ts`, and the smoke test and the local server share it.

The browser check and Lighthouse find a new page in the table by themselves. `check:dist` also needs the new page's own markup needles, and the sitemap needs its entry. The local server those checks use serves `dist/` as CloudFront serves the bucket, compression included, so lab measurements see the bytes a visitor downloads.

**Size budgets.** Each file counts at the size CloudFront would send to a browser that accepts gzip: gzipped at Node's default level if CloudFront compresses its type and size, and otherwise its own size. Node's gzip only approximates CloudFront's.

| Kind | Budget |
| --- | --- |
| JavaScript, every script the build sends | 100 KiB |
| CSS | 10 KiB |
| HTML, the largest page | 30 KiB |
| Images | 100 KiB |
| Fonts | none |

Most of the JavaScript is React, which hydrates every page (ADR 0001). The one bundle also carries every page's text, so each new page adds to every page's script.

**Load and allowance.** Milestone 1's release is 9 files, about 300 KB.
- **Smoke test:** 18 requests through the distribution, against its budget of 500.
- **Live browser check:** about 50 requests, against its budget of 200.
- **Invalidation:** each release invalidates 10 paths.
- **Allowance:** a visitor's first load of the home page is 4 requests and about 80 KB as sent. Against the Free plan's monthly allowance, 1 million requests last about 250,000 such visits, and 100 GB about 1.25 million (`docs/phase-2-inputs.md`, "Allowance").

**Test tooling.** Two new dev dependencies, pinned exactly like Playwright:
- axe-core 4.13.0, published 2026-08-05.
- Lighthouse 13.5.0, published 2026-09-18. Its own axe-core range, `^4.13.0`, resolves to the same copy.

They are pinned because a new rule or a scoring change could fail CI with no change to the site. The 109 packages they add include none with an install script beyond the reviewed ones, and every package in the lockfile still comes from its npm registry tarball with a sha512 hash (`tests/repo-policy.test.ts`). Dependabot's version updates cover only the GitHub Actions. npm's security updates arrive as pull requests, reviewed like any other change (ADR 0005).

The verification before the merge is in the pull request's description (`docs/progress.md`, "Phase 2").

## Limits

- **Lab, not field:** every performance number is a lab measurement, one simulated load per page and form factor. The site collects no field data, so INP is unmeasured, and LCP and CLS for real visits are unknown.
- **Lighthouse's machine:** scores and timings depend on the CPU they run on, so a slow runner could fail a page that passes elsewhere. The margins were wide on 2026-10-19: the worst LCP was 1.2 s, against 2.5 s.
- **What the browser check sees:** it sees what Chromium sees, and judges nothing about a page's look beyond what it measures (ADR 0006, "Limits").
  - Dark mode is loaded only at 320 pixels.
  - Its Tab walk models what Chromium's Tab reaches, without radio groups, image maps, or scrolling regions, which the site doesn't have.
  - A negative `tabindex` takes an element out of the walk on purpose, so a link given one by mistake passes.
- **Automated accessibility checks:** axe-core and Lighthouse find only what rules can find. A review by a person, with a screen reader and on real devices, is milestone 3's.
- **One bundle:** the JavaScript carries every page's text, so every page's script grows with the site. If the budget tightens, the next step is a chunk for each page.
- **No redirect to the trailing slash:** `/resume` and `/resume/` both answer 200, and the page names `/resume/` as canonical, which search engines follow. A redirect would take a change to the viewer-request function, staged as ADR 0006's "Infrastructure first" requires.
- **The sitemap** is written by hand. The policy test keeps it equal to the page table.
- **The preview picture** is rendered with the machine's fonts, so rendering it on another machine gives a slightly different picture.
- **The LinkedIn link** can't be checked automatically: LinkedIn refuses automated requests.
- **Locations:** the tests catch a location only in the résumé's "City, ST" form, so a bare place name in new content needs a reviewer's eye.
