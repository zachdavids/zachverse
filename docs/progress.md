# Phase 1 progress

One branch and one pull request per milestone (milestones 1 and 2 share PR #2). A milestone may start while the previous one is in review, on a branch stacked on it, as #3 is on #2.

| # | Milestone | Status | PR / evidence |
| --- | --- | --- | --- |
| 1–2 | Repository skeleton; infrastructure checks | In review; CI green at `b1e5dca`, with a 100% coverage gate in both packages | [#2](https://github.com/zachdavids/zachverse/pull/2) |
| 3 | CDK bootstrap and GitHub OIDC identity stack | In review, stacked on #2 | [#3](https://github.com/zachdavids/zachverse/pull/3); GitHub `production` environment created 2026-10-11: `main` only, no admin bypass |
| 4 | Initial site deployment (no WAF or plan) | Not started | — |
| 5 | GitHub environment variables and deploy workflow | Not started | — |
| 6 | Placeholder release, smoke tests, rollback | Not started | — |
| 7 | WAF and Free flat-rate subscription | Not started | — |
| 8 | Website DNS cutover (no earlier than 2026-10-14 00:00 UTC) | Not started | — |
| 9 | DigitalOcean retirement | Not started | — |

Domain transfer from Squarespace: in progress (step 7 of 14 on 2026-10-11).
