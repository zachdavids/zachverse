# ADR 0009: DigitalOcean retirement

- Status: Accepted (milestone 9). Prepared, not carried out: it runs 7 to 14 days after milestone 8's cutover, and before the Droplet's certificate expires.
- Date: 2026-10-15

## Context

Until milestone 8's cutover, a DigitalOcean Droplet serves `zachdavids.com` and `www.zachdavids.com`. Read on 2026-10-15:
- **Addresses:** `159.203.37.93` and `2604:a880:cad:d0::46:6001`.
- **Server:** nginx 1.15.5 on Ubuntu.
- **Certificate:** Let's Encrypt, valid until 2026-11-18 01:32 UTC, for both names, over IPv4 and IPv6.

After the cutover it serves only the DNS rollback: milestone 8's reverse batch points both names back at it (ADR 0008). Once both names point at CloudFront, the Droplet can't renew its certificate, so the rollback window ends at that certificate's `notAfter` at the latest. ADR 0008's step 2 records the date (ADR 0008, "Limits").

The domain's DNS moved from DigitalOcean to Route 53 before this phase. DigitalOcean's copy of the zone may still exist in its account, but no resolver asks it, since the `.com` servers delegate to Route 53 (ADR 0008, precondition 6).

The plan's milestone 9 retires the Droplet after 7 to 14 days of successful operation, and before its certificate expires.

## Decision

**When.** The owner ends the rollback window 7 to 14 days after the cutover, once the site has run on CloudFront without a DNS rollback, and before the `notAfter` that ADR 0008's step 2 recorded. If 7 days after the cutover falls after that date, the window has already ended there: from then on, the Droplet can't take the site back.

**This change ends the rollback window.** It deletes milestone 8's four batches, forward and reverse (`2026-10-15-website-ttl.json`, `2026-10-15-website-cutover.json`, and a `.reverse.json` for each); git history keeps them. It also deletes the tests that replayed them.
- **The reverse batches are a hazard after retirement:** they point both names at the Droplet. Once it's destroyed, DigitalOcean can give its addresses to another customer, who would then receive the website's traffic and could obtain certificates for its names.
- **The forward batches go too,** since the tests refuse a routing batch without its reverse (`infra/dns/README.md`).
- **A guard keeps them gone.** `infra/test/support/dns-batch.ts` refuses any batch that creates or upserts a website record at either Droplet address, in any spelling, so a revert can't bring a reverse batch back. A batch may still delete such a record.
- **After this, a DNS rollback has no target.** A CloudFront problem is fixed on CloudFront's side (ADR 0006, "Three kinds of rollback").

**Retention plan:**

| What | Kept? | Where | Until |
| --- | --- | --- | --- |
| `/var/www` and `/etc/nginx` | Only if the owner wants the old site's files | The owner's private storage, never this public repository | The owner's call |
| `/etc/letsencrypt` | No: its keys belong to the Droplet's certificate, which ends with it | — | Destroyed with the Droplet |
| A snapshot of the Droplet | Only if a recovery copy is useful; none by default | DigitalOcean | At most 30 days after the Droplet is destroyed, on a deletion date recorded in `docs/progress.md` |
| DigitalOcean's DNS zone for `zachdavids.com` | No: its records are exported into the archive first, if one is kept | — | Deleted at retirement |
| Milestone 8's batches | Git history only | This repository | — |

**Snapshot cost.** DigitalOcean charges Droplet snapshots $0.06 per GB a month, on the snapshot's size, with a minimum of $0.01 (DigitalOcean's "Snapshots Pricing" page, last verified by DigitalOcean on 2024-05-08, read 2026-10-15). A snapshot of a few GB therefore costs cents a month. Every cost accrues, since nothing pauses the account (CLAUDE.md, "Billing").

## Runbook

The owner does the DigitalOcean and Workspace steps. An administrator does the AWS checks, which only read, in Git Bash with `--profile default`.

1. **Preconditions.** Stop if any fails.
   1. ADR 0008's cutover was applied at least 7 days ago, its verification passed, and no DNS rollback has run since (`docs/progress.md`).
   2. The site has run on CloudFront since. Every Deploy run on `main` since the cutover passed, or its failure was settled (`gh run list --workflow deploy.yml --branch main`).
   3. The `notAfter` that ADR 0008's step 2 recorded is still ahead, or the window has already ended (see "When").
   4. The owner decides to end the rollback window.
2. **Nothing else depends on the Droplet.**
   - **Route 53:** `aws route53 list-resource-record-sets --hosted-zone-id Z03492543O0YEY0RDZZ0J --query "ResourceRecordSets[?ResourceRecords[?Value=='159.203.37.93' || Value=='2604:a880:cad:d0::46:6001']].[Name, Type]" --output text` prints nothing.
   - **Delegation:** ADR 0008's precondition 6 passes, so DigitalOcean's copy of the zone answers no one.
   - **The owner's check:** nothing still needed runs on the Droplet, such as another site, a scheduled job, or mail. Nothing uses another name in DigitalOcean's zone.
3. **Archive (owner, optional).** Copy what's worth keeping from `/var/www` and `/etc/nginx` into private storage, for example `sudo tar czf ~/droplet-archive.tgz /var/www /etc/nginx` on the Droplet, then `scp` it off. Leave out `/etc/letsencrypt`. Export DigitalOcean's zone into the same archive, from its Domains page or with `doctl compute domain records list zachdavids.com`.
4. **Snapshot (owner, optional).** Take one only if a recovery copy is useful. Record in `docs/progress.md` its size, its monthly cost, and its deletion date, at most 30 days after step 6.
5. **End the rollback window:** merge this change. From here on there is no DNS rollback, and no batch can point a website name at the Droplet again.
6. **Destroy the Droplet (owner)** from its page in DigitalOcean's control panel.
7. **Delete DigitalOcean's DNS zone (owner)** from Networking > Domains. Then `nslookup -type=NS zachdavids.com ns1.digitalocean.com` no longer returns the zone's records.
8. **Workspace (owner):**
   - the Admin console shows the Workspace subscription active;
   - a message from an outside account reaches the Workspace mailbox, and a reply gets back;
   - the zone's MX, SPF, DKIM, and DMARC records equal an export taken before step 6.
9. **Verify (administrator):**
   - Step 2's Route 53 check still prints nothing.
   - `nslookup` for both names, at `ns-1989.awsdns-56.co.uk` and at `8.8.8.8`, returns CloudFront addresses, as in ADR 0008's "Verify".
   - `curl -sS -m 10 --connect-to zachdavids.com:443:159.203.37.93:443 https://zachdavids.com/` fails, since the Droplet no longer serves the site.
   - A Deploy run on `main`, started by hand, passes.
10. **Delete the snapshot,** if one was taken, by its recorded date.
11. **Record** each step's result and date in `docs/progress.md`.

## Limits

- **The guard knows two addresses:** it refuses only the Droplet's. A record pointing at any other address someone has released goes unchecked.
- **What the checks see:** they read DNS. Whether anything else still needs the Droplet is the owner's knowledge.
- **Outside AWS and this repository:** the archive, the snapshot, the Droplet, and DigitalOcean's zone. Their state is what the owner records.
- **No DNS fallback afterwards:** once the window ends, a problem with the distribution has to be fixed on CloudFront's side, by an application or CloudFormation rollback (ADR 0006). Moving the site elsewhere would take a new, reviewed batch.
