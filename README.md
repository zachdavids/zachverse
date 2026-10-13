# zachverse
An interactive 3D portfolio exploring my journey from Rockstar Games to Amazon Kindle, built with React, Three.js, and AWS CDK.

Phase 1 is a responsive placeholder at [zachdavids.com](https://zachdavids.com) plus the hosting and deployment infrastructure; the 3D experience comes later.

## Layout

| Path | Contents |
| --- | --- |
| `src/`, `index.html`, `public/` | React + TypeScript site (Vite), prerendered to static HTML |
| `scripts/` | Prerender step and post-build output check |
| `tests/` | Repository policy checks, run by the root `npm test`: GitHub Actions workflows and CI steps; Dependabot; type-check, test, and coverage settings; build commands and output names; npm settings, lockfiles, and Node engines; `.gitignore`; AWS access key IDs, secret access keys after a name such as `aws_secret_access_key`, and private key blocks in any file git does not ignore; crawler files |
| `infra/` | AWS CDK app (TypeScript), its CloudFront Function (`infra/functions/`), and synthesized-template checks |
| `infra/dns/` | Reviewed Route 53 change batches for website records |
| `docs/` | Architecture decisions (`docs/adr/`) and milestone status (`docs/progress.md`) |
| `docs/org-policy/` | The SCP change behind ADR 0002's us-east-1 decision: backup, the policies as applied, a comparison script, and apply, verify, and rollback steps |

## Commands

Requires Node.js 24 (`.nvmrc`).

```sh
npm ci
npm run dev          # local dev server (renders on the client; nothing is prerendered)
npm run typecheck    # the type check (the root tsconfig.json only points editors at the projects)
npm test             # Vitest: unit tests and repository policy checks
npm run test:coverage  # Vitest with the 100% coverage gate CI enforces
npm run build        # client build, SSR build, prerender into dist/
npm run check:dist   # verify prerendered HTML and head, 404 page, robots.txt, sitemap, referenced files, hashed assets

cd infra
npm ci
npm run typecheck
npm test             # synthesizes the stacks and runs the guardrail checks
npm run test:coverage  # the same, with the 100% coverage gate CI enforces
npm run cdk -- diff  # the CDK CLI typechecks and runs the tests before every synth, diff, and deploy (cdk.json "build")
```

Until milestone 4 sets `certificateArn` in `infra/lib/config.ts`, the app leaves out the site stack and says why on stderr, so `cdk synth`, `diff`, and `deploy` cover only `ZachverseIdentity` (ADR 0004). A `certificateArn` set to an invalid ARN fails synthesis (an empty string counts as unset). The tests check the site stack with a placeholder certificate meanwhile. The CDK bootstrap (`npm run bootstrap` in `infra/`) changes the account and was already run; ADR 0004's runbook covers it.

Both packages' `.npmrc` files stop dependencies' install scripts from running and stop `npx` from downloading packages that aren't installed. To run one package's install script deliberately, use `npm rebuild <package> --ignore-scripts=false`.
