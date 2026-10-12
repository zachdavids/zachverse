# zachverse
An interactive 3D portfolio exploring my journey from Rockstar Games to Amazon Kindle, built with React, Three.js, and AWS CDK.

Phase 1 is a responsive placeholder at [zachdavids.com](https://zachdavids.com) plus the hosting and deployment infrastructure; the 3D experience comes later.

## Layout

| Path | Contents |
| --- | --- |
| `src/`, `index.html`, `public/` | React + TypeScript site (Vite), prerendered to static HTML |
| `scripts/` | Prerender step and post-build output check |
| `tests/` | Repository policy checks, run by the root `npm test`: action pins, workflow triggers and permissions, CI steps, Dependabot, npm settings, lockfiles, Node engines, coverage gates, `.gitignore`, crawler files |
| `infra/` | AWS CDK app (TypeScript), its CloudFront Function (`infra/functions/`), and synthesized-template checks |
| `infra/dns/` | Reviewed Route 53 change batches for website records |
| `docs/` | Architecture decisions (`docs/adr/`) and milestone status (`docs/progress.md`) |

## Commands

Requires Node.js 24 (`.nvmrc`).

```sh
npm ci
npm run dev          # local dev server
npm run typecheck    # the type check (the root tsconfig.json only points editors at the projects)
npm test             # Vitest: unit tests and repository policy checks
npm run test:coverage  # Vitest with the 100% coverage gate CI enforces
npm run build        # client build, SSR build, prerender into dist/
npm run check:dist   # verify prerendered HTML, 404 page, robots.txt, sitemap, assets

cd infra
npm ci
npm run typecheck
npm test             # synthesizes the stacks and runs the guardrail checks
npm run test:coverage  # the same, with the 100% coverage gate CI enforces
npm run cdk -- diff  # the CDK CLI typechecks and runs the tests before every synth, diff, and deploy
```

Both packages' `.npmrc` files stop dependencies' install scripts from running and stop `npx` from downloading packages that aren't installed. To run one package's install script deliberately, use `npm rebuild <package> --ignore-scripts=false`.
