# Website DNS change batches

The `zachdavids.com` hosted zone (`Z03492543O0YEY0RDZZ0J`) is managed outside CDK. It also carries Google Workspace email records (MX, SPF, DKIM, and later DMARC), which must never change as part of website work.

Website DNS changes are committed here as Route 53 change batches (the JSON for `aws route53 change-resource-record-sets --change-batch file://...`). Applying one is an administrative step. No stack may define DNS resources or grant DNS write access. The guardrail tests (`infra/test/guardrails.test.ts`) reject both in the synthesized templates, and `infra/test/entrypoints.test.ts` runs `bin/zachverse.ts` (the CDK CLI's entry point) in-process, with two of the variables the CLI sets for an app (`CDK_OUTDIR`, and `CDK_CONTEXT_JSON` holding `cdk.json`'s context plus version reporting), and requires it to write the same cloud assembly as the app those tests check, call stacks in the metadata aside. Both run in CI and before every CDK CLI synth, diff, and deploy. Until milestone 4 sets `certificateArn`, the CLI writes only the identity stack, and the tests show its template is the one they check (ADR 0003, "Template checks"). These are template checks, not access controls: CloudFormation deploys stacks through the CDK execution role, which can write DNS, so deploy only reviewed commits (ADR 0003, "Limits", lists what these checks miss).

`infra/test/dns-batches.test.ts` checks every file in this directory and its subfolders except this README, since the AWS CLI applies any file it is given, whatever its name. Dot-files and dot-folders count, symlinks are read through to their targets, and a linked folder is itself flagged. The rules:

- Only two kinds of record may change: ACM validation CNAMEs (`_<32 hex>.zachdavids.com` / `_<32 hex>.www.zachdavids.com` pointing at `*.acm-validations.aws`), and website routing (apex `A`/`AAAA`, `www` `A`/`AAAA`/`CNAME`).
- Aliases must target CloudFront (`Z2FDTNDATAQYW2`, `*.cloudfront.net`).

Review rules, which no test checks:

- Each forward batch gets a matching reverse batch for the same website names only.
- Never roll back by restoring a whole-zone export: it would undo email-authentication changes made since the export.

Export the zone before and after applying a batch, and diff the two exports, to confirm nothing else changed.
