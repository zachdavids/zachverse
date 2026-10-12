# ADR 0001: Web toolchain and prerendering

- Status: Accepted
- Date: 2026-10-11

## Context

Phase 1 ships a placeholder page; the later 3D portfolio will use React Three Fiber. The repository had no earlier research notes or lockfiles, so versions were checked against the npm registry on 2026-10-11 (publish dates and peer ranges).

## Decision

| Package | Version | Compatibility evidence |
| --- | --- | --- |
| Node.js | 24 LTS (`.nvmrc`; 24.20.0 locally) | Vitest 5 engines `^22.12 \|\| ^24 \|\| >=26`; Vite 8 `>=22.12` |
| react, react-dom | 19.3.0 | `@react-three/fiber` 9.8.1 peers `react >=19 <19.4` |
| vite | 8.3.4 | — |
| @vitejs/plugin-react | 6.1.2 | peers `vite ^8.0.0` |
| vitest | 5.0.3 | peers `vite ^6.4 \|\| ^7 \|\| ^8` |
| typescript | ~7.0.2 | same range `cdk init` (aws-cdk 2.1145.0) generates |
| aws-cdk-lib / aws-cdk CLI | 2.273.0 / 2.1145.0 | `aws-cdk-lib` peers `constructs ^10.5.0` |

Three.js and React Three Fiber are not installed in Phase 1.

The website (repo root) and the CDK app (`infra/`) are separate npm projects with separate lockfiles, so routine website builds never install infrastructure tooling.

Prerendering uses Vite's own SSR build, not a plugin. The steps are `vite build`, then `vite build --ssr src/entry-server.tsx`, then `scripts/prerender.ts`. That last step runs on Node's built-in type stripping and writes `index.html` and `404.html` with the rendered markup, and the client hydrates the page named in `data-page`. `npm run check:dist` fails the build if the HTML lacks the expected content or references missing or unhashed assets.

## Consequences

- Upgrading React past 19.3 requires checking React Three Fiber's peer range first.
- TypeScript 7 is the native compiler. Tools that need TypeScript's JavaScript API (for example typed lint rules) may need a TypeScript 6 install alongside it.
