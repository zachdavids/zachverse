# ADR 0008: Website DNS cutover

- Status: Accepted (milestone 8). Prepared, not applied: the batches wait for the preconditions below.
- Date: 2026-10-15, revised the same day after review, after the Phase 1 review, and for milestone 9
- Retired: milestone 9 deleted these batches, and the tests in `infra/test/dns-batches.test.ts` that replayed them against the 2026-10-15 zone, when it ended the rollback window (ADR 0009). Git history keeps them; this ADR records them as milestone 8 left them.

## Context

`zachdavids.com` and `www.zachdavids.com` still point at the DigitalOcean Droplet. On 2026-10-15 the hosted zone `Z03492543O0YEY0RDZZ0J` held 11 records:
- the website records: apex `A 159.203.37.93` and `AAAA 2604:a880:cad:d0::46:6001`, and `www CNAME zachdavids.com`, each with a TTL of 1800 seconds;
- Google Workspace's MX, SPF, DKIM, and DMARC records (the DMARC record added with the owner's approval on 2026-10-15 at 06:24 UTC);
- the zone's NS and SOA;
- the site certificate's two validation CNAMEs (ADR 0002).

The `.com` servers delegate the domain to exactly the zone's four name servers. The domain's transfer to Route 53 Domains, submitted 2026-10-11, was still at "Waiting for the current registrar to complete the transfer (step 7 of 14)". Its request named no name servers (the `TransferDomain` event in CloudTrail, 2026-10-12 01:59:06 UTC), so its completion should leave the delegation as it is.

The Droplet serves both names with a Let's Encrypt certificate valid until 2026-11-18 01:32 UTC, read on 2026-10-15 over IPv4 and IPv6. CloudFront sends `Strict-Transport-Security: max-age=31536000`.

`infra/dns/README.md` sets the rules every website batch follows:
- only website routing and validation records change;
- each routing batch has a reverse batch, for the website names only;
- the zone is exported and diffed before and after;
- a forward routing batch waits until no registrar operation for the domain is pending, while a rollback needs only matching delegation;
- a whole-zone export is never used to roll back, since it would undo later email-authentication changes.

## Decision

**Aliases to the distribution.** Both names get `A` and `AAAA` alias records to the site distribution `E3R8NEUOW8Z97U` (`d15987dzppdzr.cloudfront.net`, CloudFront's alias zone `Z2FDTNDATAQYW2`).
- **IPv6:** the distribution has IPv6 enabled, so `AAAA` aliases go with the `A` ones.
- **`www`:** it aliases the same distribution, whose viewer-request function redirects it to the apex with a 301. Replacing its `CNAME` ends `www`'s inheritance of the apex's other records, the MX and SPF among them, so mail to `@www`, which Google refuses today, fails after the sender's retries instead. `www` is no mail domain (precondition 7), DMARC for `@www` still falls back to `_dmarc.zachdavids.com`, and the cutover's reverse restores the inheritance.
- **The Free plan** (ADR 0007): queries to alias records that point to CloudFront don't count against its DNS query allowance, and every other query, a `CNAME` to CloudFront's included, counts against an additional 1 million a month (CloudFront Developer Guide, "CloudFront flat-rate pricing plans", "Understanding monthly DNS query allowances", read 2026-10-15).

**Two steps, each with its reverse**, committed in `infra/dns/`:

| Step | Batch | What it does | Reverse |
| --- | --- | --- | --- |
| 1 | `2026-10-15-website-ttl.json` | Lowers the three Droplet records' TTL from 1800 to 300 seconds, values unchanged | `2026-10-15-website-ttl.reverse.json` |
| 2 | `2026-10-15-website-cutover.json` | Replaces the apex `A`/`AAAA` and the `www` `CNAME` with the four aliases, in one atomic batch | `2026-10-15-website-cutover.reverse.json`, which restores the Droplet records at TTL 300 |

**Exact deletions.** Every change deletes a record set exactly as reviewed (its TTL and value, or its alias target) and creates its replacement in the same batch. Route 53 applies a batch all or nothing and refuses a deletion that does not match, so a zone that has changed since review makes the whole batch fail, with nothing applied. `UPSERT`, which would overwrite whatever is there, is not used.

**Nothing else changes.** `infra/test/dns-batches.test.ts` applies the batches to the zone as it was on 2026-10-15, with Route 53's rules: all or nothing, exact deletions, no `CREATE` over an existing record, and no `CNAME` beside other records. It checks:
- step 1 changes only the three TTLs: every value, and every other record, stays as it was;
- after both steps, both names alias the site distribution, and the MX, SPF, DKIM, DMARC, NS, SOA, and validation records are exactly as they were;
- each reverse batch restores the zone exactly;
- each batch fails whole on a zone that differs, including when applied twice;
- a record added at `www` after step 2 makes the cutover's reverse fail whole ("Limits");
- the distribution the aliases name is the one ADR 0003 records.

These tests ran until milestone 9 deleted them with the batches (ADR 0009).

Every batch in `infra/dns/` is also checked (`infra/dns/README.md`):
- each website routing batch has a reverse batch that undoes exactly its website changes and applies in its order, change by change as Route 53 applies it;
- no routing batch uses `UPSERT` at a website name;
- every record is a simple one, with no routing policy or health check;
- each batch holds only `Comment` and `Changes`, its `Comment` at most 256 printable ASCII characters, Route 53's documented limit.

## Runbook

An administrator applies the batches, in the Website account with `--profile default` (ADR 0004's runbook, step 1: the account must be `426499248998`), signed in for the cutover only and signed out after it, with `aws logout --all` and from the AWS console (ADR 0004, "Administrative access"), in Git Bash from the repository root: the batches' `file://infra/dns/...` paths are relative, and in Windows PowerShell 5.1 `curl` and `diff` are other commands. Every command only reads, except those marked "applies", and the Deploy run in "Verify", which publishes the current release again. The zone exports go outside the repository, in `~/dns-cutover/`: create it with `mkdir -p ~/dns-cutover` before step 1, check that `ls -A ~/dns-cutover` prints nothing, and run `set -o noclobber` in each session, so that no export overwrites an earlier one. Each export is `aws route53 list-resource-record-sets --hosted-zone-id Z03492543O0YEY0RDZZ0J --output json > ~/dns-cutover/<name>.json`, written out in full below, with `~` unquoted.

**Preconditions.** Check all of them first, and stop if any fails.
1. **Milestone 6:** merged, its first release verified, and the restore rehearsal done (`docs/progress.md`).
2. **Milestone 7:** ADR 0007's runbook done: its steps 6 to 9 passed, the smoke test and browser check through the web ACL among them, and `docs/progress.md` records them.
3. **The current release:** the newest entry in the release history (`aws s3 cp s3://<SiteBucketName>/_releases/history.json - --region us-east-1`) is a `publish` with `verified` set, so no restore holds deploys, and the newest Deploy run on `main` (`gh run list --workflow deploy.yml --branch main --limit 1`) succeeded, after milestone 7's deployment and after the last change to the site stack. If deploys are held, stop: settle the restore first.
4. **The certificate is issued:** `aws acm describe-certificate --region us-east-1 --certificate-arn <certificateArn from infra/lib/config.ts> --query Certificate.Status` returns `ISSUED`.
5. **No registrar operation is pending, and the registration is in order:** `aws route53domains list-operations --region us-east-1 --query "Operations[?DomainName=='zachdavids.com' && Status!='SUCCESSFUL' && Status!='FAILED']"` prints `[]`, so the transfer to Route 53 Domains is over (`infra/dns/README.md`). An operation in `ERROR` may still resume, so it counts; settle it with `aws route53domains get-operation-detail --region us-east-1 --operation-id <OperationId>`, or an AWS Support case. The command sees only this account's operations, where the domain's are. Once the transfer is over, check the registration too:
   - `aws route53domains get-contact-reachability-status --region us-east-1 --domain-name zachdavids.com --query status --output text` prints `DONE`. `PENDING` means the registrant hasn't confirmed their email address, which AWS asks for soon after a transfer is requested and suspends the domain without: the owner resends the email from the Route 53 console (Domains > Requests) and follows its link, and the cutover waits. `EXPIRED` means the domain is suspended or about to be: treat it as an incident.
   - `aws route53domains get-domain-detail --region us-east-1 --domain-name zachdavids.com --query "{Status:StatusList,AutoRenew:AutoRenew,Expires:ExpirationDate,Privacy:[AdminPrivacy,RegistrantPrivacy,TechPrivacy,BillingPrivacy]}"` shows neither `clientHold` nor `serverHold` in the status list. Keep the `--query`, so the contacts' details aren't printed. Record the status list, auto-renew, the privacy flags, and the expiry date, about 2028-06-10, in `docs/progress.md`.
   - If the status list lacks `clientTransferProhibited`, turn the transfer lock back on, which the transfer left off: `aws route53domains enable-domain-transfer-lock --region us-east-1 --domain-name zachdavids.com` (applies). It starts a registrar operation, so check this precondition again once that operation is `SUCCESSFUL`. Auto-renew and privacy came with the transfer request, so they need nothing.
6. **Delegation matches:** `nslookup -norecurse -type=NS zachdavids.com. 192.5.6.30` (`a.gtld-servers.net`) lists exactly `ns-1989.awsdns-56.co.uk`, `ns-163.awsdns-20.com`, `ns-980.awsdns-58.net`, and `ns-1399.awsdns-46.org`.
7. **`www` is no mail domain:** `www.zachdavids.com` is neither a domain nor an alias domain in Google Workspace ("Decision", `www`). The owner confirmed it on 2026-10-15; if Workspace's domains change, check again in its Admin console (Account > Domains > Manage domains).
8. **The Droplet can renew its certificate until the cutover:** its renewal method, `authenticator` in its `/etc/letsencrypt/renewal/` file (or `sudo certbot renew --dry-run`), is not `dns-digitalocean`. If it is, renewal has failed since the delegation moved to Route 53, and the Droplet's certificate expires on 2026-11-18 whatever the cutover does: switch it to `nginx` or `webroot` while DNS still points at the Droplet.
9. **The account:** `aws sts get-caller-identity` returns `426499248998`.

**Step 1: lower the TTLs.**
1. **Export:** `aws route53 list-resource-record-sets --hosted-zone-id Z03492543O0YEY0RDZZ0J --output json > ~/dns-cutover/zone-0.json`. Confirm its three website records are exactly those in "Context". If not, stop: the batches need regenerating, through review.
2. **Apply** (applies): `aws route53 change-resource-record-sets --hosted-zone-id Z03492543O0YEY0RDZZ0J --change-batch file://infra/dns/2026-10-15-website-ttl.json`, then `aws route53 wait resource-record-sets-changed --id <ChangeInfo.Id>`.
3. **Export and compare:** export to `~/dns-cutover/zone-1.json`, then `diff -u ~/dns-cutover/zone-0.json ~/dns-cutover/zone-1.json`. Only the three records' TTLs may differ. Anything else that differs is someone else's change: stop, find it, and never revert it here.
4. **Wait** at least 40 minutes after the change is `INSYNC`. The old TTL is 30 minutes, and the plan keeps a 40-minute minimum.

**Step 2: cut over.**
1. **Re-check** preconditions 3, 5, and 6.
2. **Check the distribution as it is now,** reaching it whatever DNS says, once with `-4` and once with `-6`. Stop if any check fails. They reach the web ACL from the administrator's address only.
   - `curl -sSf --connect-to zachdavids.com:443:d15987dzppdzr.cloudfront.net:443 https://zachdavids.com/ | grep -o '<meta name="zachverse-release"[^>]*>'` names the release precondition 3 found;
   - `curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' --connect-to www.zachdavids.com:443:d15987dzppdzr.cloudfront.net:443 "https://www.zachdavids.com/a?b=1"` prints `301 https://zachdavids.com/a?b=1`;
   - `curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' --connect-to zachdavids.com:80:d15987dzppdzr.cloudfront.net:80 http://zachdavids.com/` prints `301 https://zachdavids.com/`.
3. **Export and check again:** export to `~/dns-cutover/zone-1b.json`. Its three website records must be exactly as step 1 left them. Diff it with `zone-1.json` (`diff -u ~/dns-cutover/zone-1.json ~/dns-cutover/zone-1b.json`): any other difference is someone else's change since step 1, so note it in `docs/progress.md`, and never revert it here. `aws route53 get-hosted-zone --id Z03492543O0YEY0RDZZ0J --query HostedZone.ResourceRecordSetCount` is at most 49, since the cutover adds one record.
4. **Record the Droplet's certificate:** the `notAfter` it serves for both names, over IPv4 and IPv6, in `docs/progress.md`. `openssl s_client -connect 159.203.37.93:443 -servername zachdavids.com </dev/null 2>/dev/null | openssl x509 -noout -enddate` reads it; repeat with `-servername www.zachdavids.com`, and both with `-connect [2604:a880:cad:d0::46:6001]:443`. After the cutover the Droplet can't renew it, so that date ends the rollback window ("Limits").
5. **Apply** (applies): `aws route53 change-resource-record-sets --hosted-zone-id Z03492543O0YEY0RDZZ0J --change-batch file://infra/dns/2026-10-15-website-cutover.json`, then wait for `INSYNC` as before.
6. **Export and compare:** export to `~/dns-cutover/zone-2.json`, then `diff -u ~/dns-cutover/zone-1b.json ~/dns-cutover/zone-2.json`. Exactly three records go (the apex `A`/`AAAA` and the `www` `CNAME`), and exactly four aliases come. Every other record, the email records above all, is unchanged.

**Verify**, and record the results in `docs/progress.md`:
- **Authoritative DNS:** `nslookup -type=A zachdavids.com. ns-1989.awsdns-56.co.uk` and `-type=AAAA` return CloudFront addresses, and so do the same queries for `www.zachdavids.com.`.
- **Public resolvers,** at least 5 minutes after `INSYNC`, the old records' TTL: the same names through `8.8.8.8` and `1.1.1.1` return CloudFront's addresses, not the Droplet's.
- **The site, through real DNS,** once `nslookup zachdavids.com` no longer returns the Droplet's addresses. A reply with `Server: nginx`, or a Let's Encrypt certificate, is a cached answer from the Droplet: wait and repeat, rather than roll back.
  - `curl -sSI https://zachdavids.com/` returns 200 with a `Via` header naming CloudFront, and `curl -sS https://zachdavids.com/ | grep -o '<meta name="zachverse-release"[^>]*>'` names the current release;
  - `curl -sSI http://zachdavids.com/` returns a 301 to `https://zachdavids.com/`;
  - `curl -sSI "https://www.zachdavids.com/a?b=1"` returns a 301 to `https://zachdavids.com/a?b=1`;
  - a missing path returns the 404 page with status 404;
  - the certificate served for both names is the site certificate.
- **The checks:** run the Deploy workflow on `main` by hand. It publishes the current release again, as a retry, then smoke-tests it and checks it in a browser.
- **Email:**
  - the MX, SPF, DKIM, and DMARC records are unchanged (step 2's diff);
  - send a message to the Workspace mailbox from an outside account, and reply from it;
  - in the received copies, SPF, DKIM, and DMARC pass;
  - `nslookup -type=MX www.zachdavids.com. ns-1989.awsdns-56.co.uk` finds no MX, as expected ("Decision", `www`).

  The cutover changes nothing email depends on, so an email problem with step 2's diff clean is no reason to roll back the website.
- **The monitor:** once the checks above pass, the owner turns on the external uptime monitor (ADR 0007, "Monitoring") and sees its first checks pass. Its history from then on is what milestone 9 judges.

**This rollback ended with milestone 9** (ADR 0009). Never apply a reverse batch taken from git history: the Droplet's addresses may now belong to someone else.

**Rollback.** A rollback doesn't wait for a registrar operation (`infra/dns/README.md`). First check that the Droplet can take the site back, and that the reverse batch can apply:
- **Delegation:** precondition 6's check passes. If it doesn't, the outage is a delegation problem that no batch can fix.
- **The Droplet:** `curl -sS -o /dev/null -w '%{http_code}\n' --connect-to zachdavids.com:443:159.203.37.93:443 https://zachdavids.com/` prints 200, and so does the same for `www.zachdavids.com`, and both with `[2604:a880:cad:d0::46:6001]` in place of the IPv4 address. curl refuses an expired certificate.
- **`www`:** `aws route53 list-resource-record-sets --hosted-zone-id Z03492543O0YEY0RDZZ0J --query "ResourceRecordSets[?Name=='www.zachdavids.com.'].[Type,AliasTarget.DNSName]" --output text` prints exactly `A d15987dzppdzr.cloudfront.net.` and `AAAA d15987dzppdzr.cloudfront.net.`. Anything else there makes the reverse batch fail whole ("Limits"): stop, and settle it through review.

If the Droplet's certificate has expired, a DNS rollback leaves visitors with certificate errors, which CloudFront's HSTS keeps them from clicking through, until the Droplet renews. Prefer a fix on CloudFront's side (ADR 0006's application or CloudFormation rollback). If DNS must still go back, run `sudo certbot renew` on the Droplet as soon as the reverse batch is `INSYNC` and resolvers return the Droplet, then check its certificate again.

Then, from the repository root:
1. **Export** to `~/dns-cutover/zone-r0.json`, fresh, since the zone may have changed since step 2.
2. **Apply** `2026-10-15-website-cutover.reverse.json` (applies) and wait for `INSYNC`. That puts the Droplet records back at TTL 300.
3. **Export and compare:** export to `~/dns-cutover/zone-r1.json`, then `diff -u ~/dns-cutover/zone-r0.json ~/dns-cutover/zone-r1.json`: exactly the four aliases go, and the three Droplet records come back.
4. **Check the rollback.** Verify's checks expect CloudFront, so they don't apply now. Instead:
   - `nslookup -type=A` and `-type=AAAA` for `zachdavids.com.` and `www.zachdavids.com.` at `ns-1989.awsdns-56.co.uk` return `159.203.37.93` and `2604:a880:cad:d0::46:6001`, `www` through its `CNAME`;
   - at least 60 seconds later, the alias answers' TTL, `8.8.8.8` and `1.1.1.1` return them too; repeat until they do;
   - once `nslookup zachdavids.com` returns the Droplet, `curl -4 -sS -o /dev/null -w '%{http_code} %{remote_ip} %header{server}\n' https://zachdavids.com/` prints `200 159.203.37.93 nginx`, with the server's version, and the same with `-6` prints the IPv6 address; repeat for `www.zachdavids.com`. If the certificate had expired, run these only after the renewal above.
5. **If the cutover is abandoned,** export to `~/dns-cutover/zone-r2.json`, apply `2026-10-15-website-ttl.reverse.json` (applies) to restore the records' TTL, export to `~/dns-cutover/zone-r3.json`, and diff the two: only the three TTLs differ.

Never restore a whole-zone export, and don't run the Deploy workflow as part of a rollback: it would publish again and check the distribution, not the Droplet. Resolvers that cached an alias answer keep it for up to its TTL, which an alias takes from CloudFront's records (60 seconds).

## Limits

- **Pinned to 2026-10-15:** the batches name the zone's website records as they were then. Any change to those records makes them fail, as intended, and they must be regenerated and reviewed again. Changes to records at other names don't affect them. After step 2, though, `www` is no longer a `CNAME`, so other record types can be added there, and any record at `www.zachdavids.com` besides the two aliases (a `TXT`, a `CAA`, or an `HTTPS` record, say) makes the cutover's reverse fail whole, since its `CNAME` can't share the name.
- **The Droplet's address and certificate:** the reverse batches restore that address, so they are useful only while the Droplet serves the site. After step 2 the Droplet can't renew its Let's Encrypt certificate by itself, since its challenges reach CloudFront, and nothing warns before the certificate expires. So the rollback window ends at the `notAfter` that step 2 records, unless the Droplet renews by hand after a rollback; past it, CloudFront's HSTS turns the expired certificate into an error visitors can't click through. Milestone 9 retires the Droplet before that date, and deletes the reverse batches together with their forward batches, since the tests refuse a routing batch without its reverse (ADR 0009).
- **What the tests can't check:** they model Route 53's rules and check each batch's envelope against its documented limits, but they can't check what Route 53 itself will accept, and Route 53 has no dry run, so a reverse batch is first tested when it is used. A batch Route 53 refuses applies nothing, at any step, a rollback included; its fix goes through review.
- **One vantage point:** the checks after the cutover see DNS and CloudFront from one network, and the checks before it reach the web ACL from one address. Resolvers elsewhere move to the new answers as their caches expire.
- **Record count:** the zone grows by one record (the `www` `CNAME` becomes two aliases), to 12 of the Free plan's 50.
