# zachverse
An interactive 3D portfolio exploring my journey from Rockstar Games to Amazon Kindle, built with React, Three.js, and AWS CDK.

Phase 1 is a responsive placeholder at [zachdavids.com](https://zachdavids.com) plus the hosting and deployment infrastructure; the 3D experience comes later.

## Layout

| Path | Contents |
| --- | --- |
| `src/`, `index.html`, `public/` | React + TypeScript site (Vite), prerendered to static HTML |
| `scripts/` | Prerender step and post-build output check |
| `infra/` | AWS CDK app (TypeScript) and synthesized-template checks |
| `infra/dns/` | Reviewed Route 53 change batches for website records |
| `docs/adr/` | Architecture decisions |

## Commands

Requires Node.js 24 (`.nvmrc`).

```sh
npm ci
npm run dev          # local dev server
npm run typecheck
npm test             # Vitest
npm run build        # client build, SSR build, prerender into dist/
npm run check:dist   # verify prerendered HTML, 404 page, robots.txt, sitemap, assets

cd infra
npm ci
npm run typecheck
npm test             # synthesizes the stacks and runs the guardrail checks
```
