# ADR 0001: Web toolchain and prerendering

- Status: Accepted
- Date: 2026-10-11, revised 2026-10-12 after review, and on 2026-10-19 for Phase 2's first upgrades

## Context

Phase 1 ships a placeholder page; the later 3D portfolio will use React Three Fiber. The repository had no earlier research notes or lockfiles, so versions were checked against the npm registry on 2026-10-11 (publish dates and peer ranges).

## Decision

| Package | Version | Compatibility evidence |
| --- | --- | --- |
| Node.js | 24 LTS (`.nvmrc`; engines `>=24.11.0 <25`; 24.20.0 locally) | Vitest 5 engines `^22.12 \|\| ^24 \|\| >=26`; Vite 8 `^20.19 \|\| >=22.12`; jsdom 30.1.3 (tests only) and three of its dependencies `^22.22.2 \|\| ^24.15.0 \|\| >=26` |
| react, react-dom | 19.3.1 | `@react-three/fiber` 9.8.2 peers `react >=19 <19.4` |
| vite | 8.3.4 | — |
| @vitejs/plugin-react | 6.1.2 | peers `vite ^8.0.0` |
| vitest | 5.0.5 | peers `vite ^6.4 \|\| ^7 \|\| ^8` |
| typescript | ~7.0.2 | same range `cdk init` (aws-cdk 2.1145.0) generates |
| aws-cdk-lib / aws-cdk CLI | 2.273.0 / 2.1145.0 | `aws-cdk-lib` peers `constructs ^10.5.0` |

The engines floor stays at 24.11.0, the first Node 24 LTS release, although jsdom's range makes npm warn on 24.11–24.14. Engines are advisory (npm still installs), and CI and local development run a current 24.x release; the repository policy requires the Node running the tests to satisfy engines.

Three.js and React Three Fiber are not installed in Phase 1.

The website (repo root) and the CDK app (`infra/`) are separate npm projects with separate lockfiles, so routine website builds never install infrastructure tooling.

Prerendering uses Vite's own SSR build, not a plugin. The steps, which `npm run build` runs, are `vite build`, then `vite build --ssr src/entry-server.tsx --outDir dist-ssr` (its own directory, because Vite empties the output directory before building), then `node scripts/prerender.ts`. That last step runs on Node's built-in type stripping, writes each page in the page table (Phase 1's `index.html` and `404.html`; ADR 0010) with the rendered markup and the page's title, description, and head tags from `src/content/`, and deletes `dist-ssr/`. The client hydrates the page named in `data-page`, or renders it on the client when nothing was prerendered, as under `npm run dev`.

`npm run check:dist` then checks the output; `scripts/check-dist-lib.ts` has the full list, and ADR 0010 what Phase 2 added. Every page must carry its prerendered content and shared head, use no relative URL (one breaks where `/404.html` is served on nested paths), and reference only site files that exist under the exact, case-sensitive name S3 looks up for the path a browser requests (dot segments resolved, with `..` stopping at the site root). A reference with an encoded slash or backslash fails, since the build never emits one and the CloudFront docs don't say whether S3 reads it as a separator. Every `/assets/` file a page references must have a hash-like suffix and not be a copy from `public/`. An unhashed name that happens to end that way, such as `three-renderer.js`, passes, so `tests/repo-policy.test.ts` separately requires `[hash]` in every client and web worker output name the Vite config sets.

## Consequences

- Upgrading React past 19.3 requires checking React Three Fiber's peer range first.
- TypeScript 7 is the native compiler. Tools that need TypeScript's JavaScript API (for example typed lint rules) may need a TypeScript 6 install alongside it.
- `src/styles.test.ts` reads the stylesheet in jsdom, which does no layout, so it cannot catch every cause of sideways scrolling at 320 CSS px (wide fixed padding or long unbreakable words, for example). Since milestone 6 the browser check (`scripts/browser-check.ts`, ADR 0006) renders the pages in Chromium and fails on sideways scrolling, among other things; since Phase 2 it loads each page with an address at 320, 768, and 1280 pixels, and the 404 page at 320, with scrollbars shown (ADR 0010). `src/styles.css` stays unnested, as those tests reject nested rules; they also miss declarations jsdom drops and some spellings, such as a `white-space` value or an outline color set through a custom property (the comments in `src/styles.test.ts` list others).
