# Website DNS change batches

The `zachdavids.com` hosted zone (`Z03492543O0YEY0RDZZ0J`) is managed outside CDK. It also carries Google Workspace email records (MX, SPF, DKIM, and later DMARC), which must never change as part of website work.

Website DNS changes are committed here as Route 53 change batches (the JSON for `aws route53 change-resource-record-sets --change-batch file://...`). Applying one is an administrative step; no stack or deploy role has DNS write access.

Rules, enforced by `infra/test/dns-batches.test.ts` for every `*.json` file in this directory:

- Only two kinds of record may change: ACM validation CNAMEs (`_<32 hex>.zachdavids.com` / `_<32 hex>.www.zachdavids.com` pointing at `*.acm-validations.aws`), and website routing (apex `A`/`AAAA`, `www` `A`/`AAAA`/`CNAME`).
- Aliases must target CloudFront (`Z2FDTNDATAQYW2`, `*.cloudfront.net`).
- Each forward batch gets a matching reverse batch for the same website names only.
- Never roll back by restoring a whole-zone export: it would undo email-authentication changes made since the export.

Export the zone before and after applying a batch, and diff the two exports, to confirm nothing else changed.
