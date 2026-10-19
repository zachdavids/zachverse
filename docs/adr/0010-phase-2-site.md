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

**Checks.** Every check reads the page table, so a page added to it is checked with no other change.
- **`check:dist`** runs in CI and in the deploy build. It checks:
  - each page's title, description, `data-page` value, and canonical URL;
  - for each page with an address, its Open Graph and `twitter:card` tags. `og:url` must be the canonical URL, and `og:image` the site's picture, which must exist as a PNG of the size its tags give;
  - for each page with an address, exactly one JSON-LD script, which parses, names a `ProfilePage` at the canonical URL with Zach as its main entity, and holds no `<`, and no robots rule that keeps the page out of search results;
  - the 404 page's `noindex`, and that it has none of the tags above;
  - the home page's links to every other page with an address;
  - the sitemap's entries.

  It also measures the build against the size budgets below.
- **The browser check** runs in CI, in the deploy build, and on the live release (ADR 0006).
  - **Pages and widths:** every page with an address at 320, 768, and 1280 pixels with scrollbars shown, and at 320 pixels in dark mode. The 404 page is loaded at a missing address, in light and dark mode.
  - **Keyboard:** at 320 pixels, in light and dark mode, Tab walks every stop. Each stop must show a focus indicator and lie on the screen, and Tab must reach each of the page's focusable elements once, in document order.
  - **Accessibility rules:** every one of those loads runs axe-core's WCAG 2.0, 2.1, and 2.2 A and AA rules, and its best practices.
  - **Addresses:** each page loads with a query string. Each page below the root also loads without its trailing slash and after a reload, and a missing page below it must get the 404 page with status 404. Every page must name its own canonical URL, and the 404 page none.
  - **Request budget:** all the loads together stay within 200 requests, a fifth of the web ACL's rate limit for one address. `tests/repo-policy.test.ts` keeps the two in step (`docs/phase-2-inputs.md`, "Browser check").
  - **Screenshots:** in CI, it saves a screenshot of each page at each width and in dark mode. CI keeps them with the run for 30 days, for the pull request's review.
- **Lighthouse** runs in CI's web job only. It measures each page with an address as a phone and as a desktop, with simulated throttling, against these limits:
  - scores of 100 for accessibility, best practices, and SEO, and at least 90 for performance;
  - LCP of at most 2.5 s and CLS of at most 0.1;
  - total blocking time (TBT) of at most 200 ms. TBT stands in for INP, which needs a visitor's interactions.

  The deploy workflow skips Lighthouse, because lab scores vary from run to run and CI on the pull request gates the merge.
- **The local server** that the browser check and Lighthouse use serves `dist/` as CloudFront serves the bucket: the viewer-request function's mapping, the 404 page with status 404, and CloudFront's compression (Brotli or gzip, for the types and sizes CloudFront compresses). So lab measurements see the bytes a visitor downloads. It compresses each file before it starts, so no request waits on it.
- **`tests/path-mapping.test.ts`** runs the real viewer-request function on the paths that the two copies of its mapping see (`docs/phase-2-inputs.md`, "Path mapping"). One copy is `check:dist`'s; the other, in `scripts/release-lib.ts`, is shared by the smoke test and the local server.

**Size budgets.** Each file counts at the size CloudFront would send to a browser that accepts gzip: gzipped at Node's default level if CloudFront compresses its type and size, and otherwise its own size. Node's gzip only approximates CloudFront's.

| Kind | Budget | Milestone 1 |
| --- | --- | --- |
| JavaScript (all of it, under `assets/`) | 100 KiB | 75.4 KiB |
| CSS | 10 KiB | 0.9 KiB |
| HTML, the largest page | 30 KiB | 8.6 KiB, the résumé |
| Images | 100 KiB | 31.3 KiB: the preview picture and the icon |
| Fonts | none | none |

Most of the JavaScript is React, which hydrates every page (ADR 0001). The one bundle also carries every page's text, so each new page adds to every page's script.

**Load and allowance.** A release is now 9 files, 304 KB. Its smoke test sends 18 requests through the distribution, against a budget of 500. The live browser check sends 48 against its budget of 200, and each release invalidates 10 paths.

A visitor's first load of the home page is 4 requests and about 80 KB as sent. Against the Free plan's monthly allowance, 1 million requests last about 250,000 such visits and 100 GB about 1.25 million (`docs/phase-2-inputs.md`, "Allowance").

**Test tooling.** Two new dev dependencies, pinned exactly like Playwright:
- axe-core 4.13.0, published 2026-08-05.
- Lighthouse 13.5.0, published 2026-09-18. Its own axe-core range, `^4.13.0`, resolves to the same copy.

They are pinned because a new rule or a scoring change could fail CI with no change to the site. The 109 packages they add include none with an install script beyond the reviewed ones, and every package in the lockfile still comes from its npm registry tarball with a sha512 hash (`tests/repo-policy.test.ts`). They are newer versions only by reviewed change, since Dependabot updates only the GitHub Actions.

## Verification before the merge (2026-10-18)

On this branch, on Windows 11 with Node 24 and Playwright's Chromium 153 headless shell:
- **`npm run typecheck`:** passed.
- **`npm run test:coverage`:** 765 tests passed in 23 files, at 100% of statements, branches, functions, and lines. Three were skipped: a file-symlink case, once per page, which Windows refuses without Developer Mode and CI on Linux runs.
- **`npm run check:dist`:** passed, with the sizes above.
- **`npm run check:browser`:** passed: 15 loads and 48 requests, with no axe-core violation in light or dark mode.
- **`npm run check:lighthouse`:** passed:

| Page | Form factor | Performance | Accessibility | Best practices | SEO | LCP | CLS | TBT |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/` | mobile | 100 | 100 | 100 | 100 | 1201 ms | 0 | 0 ms |
| `/` | desktop | 100 | 100 | 100 | 100 | 321 ms | 0 | 0 ms |
| `/resume/` | mobile | 100 | 100 | 100 | 100 | 1201 ms | 0 | 0 ms |
| `/resume/` | desktop | 100 | 100 | 100 | 100 | 321 ms | 0 | 0 ms |

These are lab results: one simulated load per page and form factor, from the local server.

**Manual checks** on the built pages, served as CloudFront serves them, in the same Chromium:
- **Keyboard:** Tab reaches every link on each page, in order, each with a 2-pixel outline in the link colour and on the screen. The browser check now checks this on every run.
- **Menu:** the site has none.
- **200% zoom:** each page in a 640 × 400 window, which is a 1280 × 800 window at 200%, with scrollbars shown. Nothing scrolls sideways, and the text reflows.
- **Reduced motion:** no animation or transition runs, with or without `prefers-reduced-motion`. The stylesheet has none.
- **Narrow phone:** at 320 pixels, in light and dark mode, nothing scrolls sideways. The browser check checks this too.
- **Screen reader:** none was run. The accessibility tree, which a screen reader reads, was inspected instead. It has the landmarks (`main`, and the "Site" and "Contact" navigation), one `h1` a page, the résumé's outline of `h2` to `h4` headings, lists, and a definition list for the skills. A screen reader's spot check belongs to milestone 3's device review.

**Links:**
- GitHub's profile resolves, and its API names Zach Davids.
- The LinkedIn link redirects to `/in/zacharydavids`, which refuses automated requests (status 999). It needs the check by hand that milestone 3's review includes.
- The email address receives mail (`docs/progress.md`, "Email records").

**Production** can be checked only after the merge, since the deploy workflow runs only on `main` (ADR 0006, "Limits"). The Deploy run's smoke test fetches `/resume/` and every file through the distribution. Its live browser check loads every address above at `zachdavids.com`, through the distribution: `/resume`, the query strings, the reload, and the 404 page below `/resume/`.

## Limits

- **Lab, not field:** every performance number here is a lab measurement, one simulated load per page and form factor. The site collects no field data, so INP is unmeasured, and LCP and CLS for real visits are unknown.
- **Lighthouse's machine:** scores and timings depend on the CPU they run on, so a slow runner could fail a page that passes elsewhere. The margins were wide on 2026-10-18: the worst LCP was 1.2 s against 2.5 s.
- **What the browser check sees:** it sees what Chromium sees, and judges nothing about a page's look beyond what it measures (ADR 0006, "Limits").
  - Dark mode is loaded only at 320 pixels.
  - Its Tab walk models what Chromium's Tab reaches, without radio groups, image maps, or scrolling regions, which the site doesn't have.
  - A negative `tabindex` takes an element out of the walk on purpose, so a link given one by mistake passes.
- **Automated accessibility checks:** axe-core and Lighthouse find only what rules can find. A person using a screen reader, and on real devices, is milestone 3's review.
- **One bundle:** the JavaScript carries every page's text, so every page's script grows with the site. If the budget tightens, the next step is a chunk for each page.
- **No redirect to the trailing slash:** `/resume` and `/resume/` both answer 200, and the page names `/resume/` as canonical, which search engines follow. A redirect would take a change to the viewer-request function, staged as ADR 0006's "Infrastructure first" requires.
- **The sitemap** is written by hand. The policy test keeps it equal to the page table.
- **The preview picture** is rendered with the machine's fonts, so rendering it on another machine gives a slightly different picture.
- **The LinkedIn link** can't be checked automatically.
