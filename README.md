# zachverse
An interactive 3D portfolio exploring my journey from Rockstar Games to Amazon Kindle, built with React, Three.js, and AWS CDK.

Phase 1 is a responsive placeholder at [zachdavids.com](https://zachdavids.com) plus the hosting and deployment infrastructure; the 3D experience comes later.

## Layout

| Path | Contents |
| --- | --- |
| `src/`, `index.html`, `public/` | React + TypeScript site (Vite), prerendered to static HTML |
| `scripts/` | Prerender step, post-build output check, and the release and smoke-test scripts the deploy and restore workflows run |
| `tests/` | Repository policy checks, run by the root `npm test`: GitHub Actions workflows, CI steps, and the deploy and restore workflows' build, artifact, role, and release steps; Dependabot; type-check, test, and coverage settings; build commands and output names; npm settings, lockfiles, and Node engines; `.gitignore`; AWS access key IDs, secret access keys after a name such as `aws_secret_access_key`, and private key blocks in any file git does not ignore; crawler files |
| `infra/` | AWS CDK app (TypeScript), its CloudFront Function (`infra/functions/`), and the template guardrails (`infra/lib/guardrails/`), which run in every synthesis and in the tests |
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

The app always synthesizes both stacks, `ZachverseIdentity` and `ZachverseSite`. `certificateArn` in `infra/lib/config.ts` names the site certificate (ADR 0002), and an empty or malformed one fails synthesis. Every synthesis also runs the template guardrails as a CDK validation plugin, and `bin/zachverse.ts` makes any violation fail the synthesis, so every CLI command that synthesizes the app fails on one, even with `--build ''` (which skips only the typecheck and the tests) or `--ignore-errors`. Changed code, or an assembly synthesized earlier and passed with `--app` (or `CDK_APP`), still gets past them (ADR 0003, "Limits"). The CDK bootstrap (`npm run bootstrap` in `infra/`) changes the account and was already run; ADR 0004's runbook covers it.

Pushes to `main` also run `.github/workflows/deploy.yml` (ADR 0005). It checks and builds the commit, then, in the GitHub `production` environment, assumes the deploy role through OIDC, publishes the build as a release, smoke-tests it through CloudFront, and records it as verified (ADR 0006). To go back to an earlier verified release, run the Restore workflow (`.github/workflows/restore.yml`) on `main` with `previous` or that release's commit SHA. Infrastructure changes are not deployed by any workflow: an administrator deploys them with ADR 0004's runbook.

Both packages' `.npmrc` files stop dependencies' install scripts from running and stop `npx` from downloading packages that aren't installed. To run one package's install script deliberately, use `npm rebuild <package> --ignore-scripts=false`.
