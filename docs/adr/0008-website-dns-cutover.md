# ADR 0008: Website DNS cutover

- Status: Accepted (milestone 8). Prepared, not applied: the batches wait for the preconditions below.
- Date: 2026-10-15

## Context

`zachdavids.com` and `www.zachdavids.com` still point at the DigitalOcean Droplet. On 2026-10-15 the hosted zone `Z03492543O0YEY0RDZZ0J` held 11 records:
- the website records: apex `A 159.203.37.93` and `AAAA 2604:a880:cad:d0::46:6001`, and `www CNAME zachdavids.com`, each with a TTL of 1800 seconds;
- Google Workspace's MX, SPF, DKIM, and DMARC records (DMARC added since milestone 7's count of 10);
- the zone's NS and SOA;
- the site certificate's two validation CNAMEs (ADR 0002).

The `.com` servers delegate the domain to exactly the zone's four name servers. The domain's transfer to Route 53 Domains, submitted 2026-10-11, was still at "Waiting for the current registrar to complete the transfer (step 7 of 14)".

`infra/dns/README.md` sets the rules every website batch follows:
- only website routing and validation records change;
- each routing batch has a reverse batch, for the website names only;
- the zone is exported and diffed before and after;
- a routing batch waits until no registrar operation for the domain is pending;
- a whole-zone export is never used to roll back, since it would undo later email-authentication changes.

## Decision

**Aliases to the distribution.** Both names get `A` and `AAAA` alias records to the site distribution `E3R8NEUOW8Z97U` (`d15987dzppdzr.cloudfront.net`, CloudFront's alias zone `Z2FDTNDATAQYW2`).
- **IPv6:** the distribution has IPv6 enabled, so `AAAA` aliases go with the `A` ones.
- **`www`:** it aliases the same distribution, whose viewer-request function redirects it to the apex with a 301.
- **The Free plan:** alias queries to CloudFront don't count against its DNS allowance (ADR 0007), unlike a `CNAME`.

**Two steps, each with its reverse**, committed in `infra/dns/`:

| Step | Batch | What it does | Reverse |
| --- | --- | --- | --- |
| 1 | `2026-10-15-website-ttl.json` | Lowers the three Droplet records' TTL from 1800 to 300 seconds, values unchanged | `2026-10-15-website-ttl.reverse.json` |
| 2 | `2026-10-15-website-cutover.json` | Replaces the apex `A`/`AAAA` and the `www` `CNAME` with the four aliases, in one atomic batch | `2026-10-15-website-cutover.reverse.json`, which restores the Droplet records at TTL 300 |

**Exact deletions.** Every change deletes a record set exactly as reviewed (its TTL and value, or its alias target) and creates its replacement in the same batch. Route 53 applies a batch all or nothing and refuses a deletion that does not match, so a zone that has changed since review makes the whole batch fail, with nothing applied. `UPSERT`, which would overwrite whatever is there, is not used.

**Nothing else changes.** `infra/test/dns-batches.test.ts` applies the batches to the zone as it was on 2026-10-15, with Route 53's rules: all or nothing, exact deletions, no `CREATE` over an existing record, and no `CNAME` beside other records. It checks four things:
- after both steps, both names alias the site distribution, and the MX, SPF, DKIM, DMARC, NS, SOA, and validation records are exactly as they were;
- each reverse batch restores the zone exactly;
- each batch fails whole on a zone that differs, including when applied twice;
- the distribution the aliases name is the one ADR 0003 records.

## Runbook

An administrator applies the batches, in the Website account with `--profile default` (CLAUDE.md, "Credentials"). Every command reads, except the two marked "applies".

**Preconditions.** Check all of them first, and stop if any fails.
1. **Milestone 6:** merged, its first release verified, and the restore rehearsal done (`docs/progress.md`).
2. **Milestone 7:** the subscription is `ACTIVE` on `FREE`, with the distribution, the web ACL, and the zone (ADR 0007, "Runbook", step 6).
3. **The certificate is issued:** `aws acm describe-certificate --region us-east-1 --certificate-arn <certificateArn from infra/lib/config.ts> --query Certificate.Status` returns `ISSUED`.
4. **No registrar operation is pending:** `aws route53domains list-operations --region us-east-1` lists none for `zachdavids.com` with the status `SUBMITTED` or `IN_PROGRESS`. The transfer to Route 53 Domains must be over.
5. **Delegation matches:** `nslookup -norecurse -type=NS zachdavids.com. 192.5.6.30` (`a.gtld-servers.net`) lists exactly `ns-1989.awsdns-56.co.uk`, `ns-163.awsdns-20.com`, `ns-980.awsdns-58.net`, and `ns-1399.awsdns-46.org`.
6. **The account:** `aws sts get-caller-identity` returns `426499248998`.

**Step 1: lower the TTLs.**
1. **Export:** `aws route53 list-resource-record-sets --hosted-zone-id Z03492543O0YEY0RDZZ0J > zone-0.json`. Confirm its three website records are exactly those in "Context". If not, stop: the batches need regenerating, through review.
2. **Apply** (applies): `aws route53 change-resource-record-sets --hosted-zone-id Z03492543O0YEY0RDZZ0J --change-batch file://infra/dns/2026-10-15-website-ttl.json`, then `aws route53 wait resource-record-sets-changed --id <ChangeInfo.Id>`.
3. **Export and compare:** export again to `zone-1.json` and diff it with `zone-0.json`. Only the three records' TTLs may differ.
4. **Wait** at least 40 minutes after the change is `INSYNC`. The old TTL is 30 minutes, and the plan keeps a 40-minute minimum.

**Step 2: cut over.**
1. **Re-check** preconditions 4 and 5.
2. **Apply** (applies): `aws route53 change-resource-record-sets --hosted-zone-id Z03492543O0YEY0RDZZ0J --change-batch file://infra/dns/2026-10-15-website-cutover.json`, then wait for `INSYNC` as before.
3. **Export and compare:** export again to `zone-2.json` and diff it with `zone-1.json`. Exactly three records go (the apex `A`/`AAAA` and the `www` `CNAME`), and exactly four aliases come. Every other record, the email records above all, is unchanged.

**Verify**, and record the results in `docs/progress.md`:
- **Authoritative DNS:** `nslookup -type=A zachdavids.com. ns-1989.awsdns-56.co.uk` and `-type=AAAA` return CloudFront addresses, and so do the same queries for `www.zachdavids.com.`.
- **Public resolvers,** after a few minutes: the same names through `8.8.8.8` and `1.1.1.1`.
- **The site, through real DNS:**
  - `curl -sSI https://zachdavids.com/` returns 200, and the page names the current release;
  - `curl -sSI http://zachdavids.com/` returns a 301 to `https://zachdavids.com/`;
  - `curl -sSI "https://www.zachdavids.com/a?b=1"` returns a 301 to `https://zachdavids.com/a?b=1`;
  - a missing path returns the 404 page with status 404;
  - the certificate served for both names is the site certificate.
- **The checks:** run the Deploy workflow on `main` by hand. It publishes the current release again, as a retry, then smoke-tests it and checks it in a browser.
- **Email:**
  - the MX, SPF, DKIM, and DMARC records are unchanged (step 2's diff);
  - send a message to the Workspace mailbox from an outside account, and reply from it;
  - in the received copies, SPF, DKIM, and DMARC pass.

**Rollback.** Apply `2026-10-15-website-cutover.reverse.json` (applies) and wait for `INSYNC`. That puts the Droplet records back at TTL 300. If the cutover is abandoned, then apply `2026-10-15-website-ttl.reverse.json` to restore their TTL. Export and diff around each, as above. Never restore a whole-zone export. Resolvers that cached an alias answer keep it for up to its TTL, which an alias takes from CloudFront's records (60 seconds).

## Limits

- **Pinned to 2026-10-15:** the batches name the zone's website records as they were then. Any change to those records makes them fail, as intended, and they must be regenerated and reviewed again. Changes to other records don't affect them.
- **The Droplet's address:** the reverse batches restore that address, so they are useful only while the Droplet serves the site. Milestone 9 retires the Droplet, and removes the reverse batches when the rollback window ends.
- **What the tests can't check:** they model Route 53's rules, but can't check what Route 53 itself will accept. A record type or alias the model allows and Route 53 refuses fails at step 1 or 2, with nothing applied.
- **One vantage point:** the checks after the cutover see DNS and CloudFront from one network. Resolvers elsewhere move to the new answers as their caches expire.
- **Record count:** the zone grows by one record (the `www` `CNAME` becomes two aliases), to 12 of the Free plan's 50.
