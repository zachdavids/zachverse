# Website DNS change batches

The `zachdavids.com` hosted zone (`Z03492543O0YEY0RDZZ0J`) is managed outside CDK. It also carries Google Workspace email records (MX, SPF, DKIM, and DMARC), which must never change as part of website work.

Website DNS changes are committed here as Route 53 change batches (the JSON for `aws route53 change-resource-record-sets --change-batch file://...`). Applying one is an administrative step. No stack may define DNS resources or grant DNS write access. The template guardrails (`infra/lib/guardrails/`) reject both. They run inside every synthesis and fail it, so the CDK CLI's synth, diff, and deploy fail on a DNS resource or a DNS-write grant even with `--build ''` or `--ignore-errors`, and the tests run them in CI. These are template checks, not access controls: CloudFormation deploys stacks through the CDK execution role, which can write DNS, and the templates of an assembly synthesized earlier and passed with `--app` are not checked again, so deploy only reviewed commits (ADR 0003, "Limits", lists what these checks miss).

`infra/test/dns-batches.test.ts` checks every file in this directory and its subfolders except this README, since the AWS CLI applies any file it is given, whatever its name. Dot-files and dot-folders count, symlinks are read through to their targets, and a linked folder is itself flagged. The rules:

- Only two kinds of record may change: ACM validation CNAMEs (`_<32 hex>.zachdavids.com` / `_<32 hex>.www.zachdavids.com` pointing at `*.acm-validations.aws`), and website routing (apex `A`/`AAAA`, `www` `A`/`AAAA`/`CNAME`).
- Every record is a simple one: a record set may set only `Name`, `Type`, `TTL`, `ResourceRecords`, and `AliasTarget` (`HostedZoneId`, `DNSName`, `EvaluateTargetHealth`), so no routing policy or health check. A website record is either an alias, with no `TTL` or values, or a `TTL` with a list of string values.
- Aliases must target CloudFront (`Z2FDTNDATAQYW2`, `*.cloudfront.net`).
- No batch may delete an ACM validation record, and a batch that creates or upserts either of the site certificate's two validation names must give it the value `2026-10-13-acm-validation.json` does.
- A batch holds only `Comment` and `Changes`, and its `Comment`, if any, is at most 256 printable ASCII characters: Route 53's documented limit, which neither the CLI nor the SDKs check, so a longer one fails only when the batch is applied.
- Every batch is a top-level file named with lower-case letters, digits, `.`, and `-` only, ending in `.json`, such as `2026-10-15-website-ttl.json`. A batch that changes a website routing record pairs with `<name>.reverse.json`, which must undo exactly its website changes (each `CREATE` deleted, each `DELETE` created again) and change nothing else, and neither uses `UPSERT` at a website name, since a reverse can't know what an `UPSERT` replaced. Route 53 applies a batch change by change, so the pair must also apply in its order to the record sets the forward batch deletes: each `DELETE` before the `CREATE` that replaces it, and a `CNAME` only once the records beside it are gone. A batch that changes only validation records needs no reverse.

Before applying any batch:

- Public delegation must equal the zone's four name servers: a `.com` name server, such as `a.gtld-servers.net`, must list exactly `ns-1989.awsdns-56.co.uk`, `ns-163.awsdns-20.com`, `ns-980.awsdns-58.net`, and `ns-1399.awsdns-46.org` for `zachdavids.com`. Otherwise resolvers may not see the zone's records.
- A website-routing batch, such as the milestone 8 cutover, also waits until no registrar operation for the domain is pending, its transfer to Route 53 Domains included. An operation in `ERROR` counts as pending, since it may still resume (ADR 0008, precondition 5). The transfer's request named no name servers, so its completion should leave the delegation as it is; the rule still keeps registrar and DNS changes apart. An additive ACM validation batch may be applied while one is pending, as long as delegation matches, since the zone serves its records whatever the registrar. For the same reason, a reverse batch applied as a rollback doesn't wait for a registrar operation, though delegation must still match.
- While the zone is attached to the Free flat-rate plan (ADR 0007), it may hold at most 50 records, the Free tier's limit. Check `ResourceRecordSetCount` (`aws route53 get-hosted-zone --id Z03492543O0YEY0RDZZ0J`) before a batch that adds records; the zone had 11 on 2026-10-15, after a DMARC record was added, and milestone 8's cutover adds one more.

Review rules, beyond what the tests check:

- ACM validation records get no reverse batch, and no rollback touches them: they stay while a certificate for these names is in use, since ACM renews it only while they resolve (ADR 0002). To restore a lost one, commit a copy of its batch with `UPSERT` in place of `CREATE` and apply that: Route 53 applies a batch all or nothing, and a `CREATE` of a record that still exists fails.
- Never roll back by restoring a whole-zone export: it would undo email-authentication changes made since the export.

Export the zone before and after applying a batch, and diff the two exports, to confirm nothing else changed. Write the exports outside the repository, where no test reads them (ADR 0008 names a folder).

The batches here:

- `2026-10-13-acm-validation.json`: the site certificate's validation records (milestone 4, applied on 2026-10-13).
- `2026-10-15-website-ttl.json` and `2026-10-15-website-cutover.json`, with a `.reverse.json` for each: milestone 8's two steps, which lower the website records' TTL and then point both names at the site distribution. ADR 0008 has their runbook, and `infra/test/dns-batches.test.ts` replays them against the zone as it was on 2026-10-15. Milestone 9 deletes all four together when the rollback window ends.
