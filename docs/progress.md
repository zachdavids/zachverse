# Phase 1 progress

One branch and one pull request per milestone (milestones 1 and 2 share PR #2). A milestone may start while the previous one is in review, on a branch stacked on it, as #3 was on #2 and #4 is on #3.

| # | Milestone | Status | PR / evidence |
| --- | --- | --- | --- |
| 1–2 | Repository skeleton; infrastructure checks | Merged 2026-10-13; CI requires 100% coverage in both packages | [#2](https://github.com/zachdavids/zachverse/pull/2) |
| 3 | CDK bootstrap and GitHub OIDC identity stack | Deployed 2026-10-12; in review | [#3](https://github.com/zachdavids/zachverse/pull/3); ADR 0004. Prerequisite SCP change: ADR 0002, `docs/org-policy/`. GitHub `production` environment: `main` only, no admin bypass |
| 4 | Initial site deployment (no WAF or plan) | Deployed 2026-10-14; in review | [#4](https://github.com/zachdavids/zachverse/pull/4); ADR 0003, "Deployed state": distribution `E3R8NEUOW8Z97U` (`d15987dzppdzr.cloudfront.net`) in front of an empty private bucket, verified live; no DNS record points at it until milestone 8. Certificate `arn:aws:acm:us-east-1:426499248998:certificate/f285dc12-6f64-4d9b-8309-043d5e90f354`, issued 2026-10-13, valid until 2027-04-28, and in use by the distribution. The account-wide S3 public-access block is on since 2026-10-14 (ADR 0002, "Account and billing"). Its validation batch, `infra/dns/2026-10-13-acm-validation.json` (ADR 0002), was applied on 2026-10-13 as Route 53 change `C0538187366HON9LAQEWB`, adding only its two CNAMEs; deploy steps in ADR 0004's runbook. Budget `aws-monthly-spend` (management account, payer-wide): 5.00 USD per month, email alerts when actual cost exceeds 20% and 100%. Registrar transfer in progress (still step 7 of 14 on 2026-10-14); the domain's transfer lock, auto-renew, and privacy can be set only once it completes (the owner sets them then) |
| 5 | GitHub environment variables and deploy workflow | Not started | — |
| 6 | Placeholder release, smoke tests, rollback | Not started | — |
| 7 | WAF and Free flat-rate subscription | Not started; the SCP now allows `pricingplanmanager:*` for the Website account | — |
| 8 | Website DNS cutover (no earlier than 2026-10-14 00:00 UTC) | Not started | — |
| 9 | DigitalOcean retirement | Not started | — |

Domain transfer from Squarespace to Route 53 Domains: submitted 2026-10-11 and, on 2026-10-14, still waiting for the current registrar, so the domain is not yet in the Website account. Public delegation already equals the hosted zone's four name servers (`infra/dns/README.md`), and the zone has no CAA records.

Milestone 4 runs the guardrails in every synthesis (ADR 0003, "Template checks"). On 2026-10-13 that was checked against the CDK CLI itself, without AWS credentials. With an apex `A` record temporarily added to the site stack, `cdk synth --build '' --ignore-errors`, `cdk synth` with `CDK_IGNORE_ERRORS=true` and `CDK_BUILD=` set (no tests ran), `cdk list --build ''`, and `cdk synth ZachverseIdentity --exclusively --build ''` each printed the violation and exited 1. The record was then removed.
