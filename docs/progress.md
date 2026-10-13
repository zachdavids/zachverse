# Phase 1 progress

One branch and one pull request per milestone (milestones 1 and 2 share PR #2). A milestone may start while the previous one is in review, on a branch stacked on it, as #3 was on #2.

| # | Milestone | Status | PR / evidence |
| --- | --- | --- | --- |
| 1–2 | Repository skeleton; infrastructure checks | Merged 2026-10-13; CI requires 100% coverage in both packages | [#2](https://github.com/zachdavids/zachverse/pull/2) |
| 3 | CDK bootstrap and GitHub OIDC identity stack | Deployed 2026-10-12; in review | [#3](https://github.com/zachdavids/zachverse/pull/3); ADR 0004. Prerequisite SCP change: ADR 0002, `docs/org-policy/`. GitHub `production` environment: `main` only, no admin bypass |
| 4 | Initial site deployment (no WAF or plan) | Not started | — |
| 5 | GitHub environment variables and deploy workflow | Not started | — |
| 6 | Placeholder release, smoke tests, rollback | Not started | — |
| 7 | WAF and Free flat-rate subscription | Not started; the SCP now allows `pricingplanmanager:*` for the Website account | — |
| 8 | Website DNS cutover (no earlier than 2026-10-14 00:00 UTC) | Not started | — |
| 9 | DigitalOcean retirement | Not started | — |

Domain transfer from Squarespace: in progress (step 7 of 14 on 2026-10-11).
