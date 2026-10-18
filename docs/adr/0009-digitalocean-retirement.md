# ADR 0009: DigitalOcean retirement

- Status: Accepted (milestone 9). Runbook steps 1 to 4 were done on 2026-10-18, the day of milestone 8's cutover, by the owner's decision ("When"); this change's merge ends the rollback window (step 5).
- Date: 2026-10-15, revised the same day after review and after the Phase 1 review, and on 2026-10-18 for the retirement

## Context

Until milestone 8's cutover, a DigitalOcean Droplet serves `zachdavids.com` and `www.zachdavids.com`. Read on 2026-10-15:
- **Addresses:** `159.203.37.93` and `2604:a880:cad:d0::46:6001`.
- **Server:** nginx 1.15.5 on Ubuntu.
- **Certificate:** Let's Encrypt, valid until 2026-11-18 01:32 UTC, for both names, over IPv4 and IPv6. If the Droplet renews before the cutover, ADR 0008's step 2 records a later date.

After the cutover the Droplet serves only the DNS rollback: milestone 8's reverse batch points both names back at it (ADR 0008). Once both names point at CloudFront, the Droplet can't renew its certificate. So the clean rollback window ends at that certificate's `notAfter`. After that date, a rollback leaves visitors with certificate errors until the Droplet renews by hand (ADR 0008, "Rollback").

The domain's DNS moved from DigitalOcean to Route 53 before this phase. DigitalOcean's copy of the zone may still exist in its account, but no resolver asks it, since the `.com` servers delegate to Route 53 (ADR 0008, precondition 6).

The plan's milestone 9 retires the Droplet after 7 to 14 days of successful operation, and before its certificate expires.

## Decision

**When.** The owner ends the rollback window 7 to 14 days after the cutover, once the site has run on CloudFront without a DNS rollback. Normally that falls before the `notAfter` that ADR 0008's step 2 recorded. If that date comes first, the clean window ended then, and the retirement goes ahead on the owner's decision. On 2026-10-18 the owner chose to end the window the day of the cutover instead, waiving precondition 1's 7 days: the cutover's checks had passed, and the runbook's other checks ran as written (`docs/progress.md`, row 9).

**This change ends the rollback window.** It deletes milestone 8's four batches, forward and reverse (`2026-10-15-website-ttl.json`, `2026-10-15-website-cutover.json`, and a `.reverse.json` for each), and the tests that replayed them. Git history keeps them.
- **The reverse batches are a hazard after retirement:** they point both names at the Droplet. Once it's destroyed, DigitalOcean can give its addresses to another customer, who would then receive the website's traffic and could obtain certificates for its names.
- **The forward batches go too,** since the tests refuse a routing batch without its reverse (`infra/dns/README.md`).
- **A guard keeps the reverse batches out of the repository.** While it stays, `infra/test/support/dns-batch.ts` refuses any committed batch that gives a website `A` or `AAAA` record either Droplet address. The IPv6 address is caught in any notation, the IPv4 one in its IPv4-mapped form too, and either with or without a final dot. So restoring a reverse batch from git history fails the tests. A batch may still delete such a record, and needs no reverse for that deletion, since no batch may create the record again.
- **The guard is a test, not an access control.** Reverting this change removes it together with the batches it brings back, and CI then passes, so review is the control for a revert. The AWS CLI applies any file it's given, one taken from git history included ("Limits").
- **After this, a DNS rollback has no target.** A CloudFront problem is fixed on CloudFront's side (ADR 0006, "Three kinds of rollback").

**Retention plan:**

| What | Kept? | Where | Until |
| --- | --- | --- | --- |
| `/var/www` and `/etc/nginx` | Only if the owner wants the old site's files | The owner's private storage, never this public repository | The owner's call |
| `/etc/letsencrypt` | Never archived. Its private keys stay in any snapshot or automated backup of the Droplet, and its certificate stays valid until its `notAfter` | Those DigitalOcean copies only | The last such copy is deleted or expires |
| Automated backups, if on | Not by choice: destroying the Droplet leaves them, and DigitalOcean documents no way to delete one early | DigitalOcean | Each one's expiry date, read from the Droplet's Backups tab and recorded in `docs/progress.md` |
| A snapshot of the Droplet | Only if a recovery copy is useful; none by default | DigitalOcean | At most 30 days after the Droplet is destroyed, on a deletion date recorded in `docs/progress.md` |
| Volumes and volume snapshots, if any | No | DigitalOcean | Destroyed with the Droplet in step 6, or recorded with their size and monthly cost |
| DigitalOcean's DNS zone for `zachdavids.com` | No: its records are exported into the archive first, if one is kept | — | Deleted at retirement |
| Milestone 8's batches | Git history only | This repository | — |

**Snapshot cost.** DigitalOcean charges Droplet snapshots $0.06 per GB a month, on the snapshot's size, with a minimum of $0.01 (DigitalOcean's "Snapshots Pricing" page, last verified by DigitalOcean on 2024-05-08, read 2026-10-15). A snapshot of a few GB therefore costs cents a month, for as long as it exists, so step 4 records its deletion date. DigitalOcean's "Destroy Droplets" page (last verified 2026-07-13, read 2026-10-15) says destroying a Droplet leaves its automated backups, which "remain for four weeks after creation and then expire", and keeps its snapshots and volumes unless they're selected for deletion.

## Runbook

The owner does the DigitalOcean and Workspace steps. An administrator does the AWS checks, in Git Bash with `--profile default`. They sign in only for a step's checks, first check that `aws sts get-caller-identity --profile default` returns `426499248998`, and end the session with `aws logout --all` and a sign-out of the AWS console (ADR 0004, "Administrative access"). The checks only read. This change's merge (step 5), like every push to `main`, publishes a release through the Deploy workflow (ADR 0006).

Before the first export, create the folder with `mkdir -p ~/droplet-retirement`, check that `ls -A ~/droplet-retirement` prints nothing, and run `set -o noclobber` in each session, so no export overwrites another. Give `nslookup` names with a final dot, as below. Without one, Windows `nslookup` first tries the machine's DNS suffix, and DigitalOcean's name servers answer for some of those, which can hide a zone that still exists.

1. **Preconditions.** Stop if 1, 2, or 4 fails.
   1. ADR 0008's cutover was applied at least 7 days ago, its verification passed, and no DNS rollback has run since (`docs/progress.md`).
   2. The site has run on CloudFront since: the owner's external monitor (ADR 0007, "Monitoring") shows no unexplained downtime since the cutover, and every Deploy run on `main` since then passed, or its failure was settled (`gh run list --workflow deploy.yml --branch main`). The monitor is the only one of these that goes through public DNS: the Deploy runs reach the distribution directly. No restore holds deploys: the newest entry in `aws s3 cp s3://<SiteBucketName>/_releases/history.json - --region us-east-1` is a `publish` with `verified` set, as in ADR 0008's precondition 3.
   3. If the `notAfter` that ADR 0008's step 2 recorded has passed, note in `docs/progress.md` that the clean window ended then ("When"). This doesn't stop the retirement.
   4. The owner decides to end the rollback window.
2. **Nothing else depends on the Droplet.**
   - **Export the zone (administrator):** `aws route53 list-resource-record-sets --hosted-zone-id Z03492543O0YEY0RDZZ0J --output json > ~/droplet-retirement/zone-0.json`, with `~` unquoted.
   - **Route 53 (administrator):** `aws route53 list-resource-record-sets --hosted-zone-id Z03492543O0YEY0RDZZ0J --query "ResourceRecordSets[?ResourceRecords[?Value=='159.203.37.93' || Value=='2604:a880:cad:d0::46:6001']].[Name, Type]" --output text` prints nothing. If it prints anything, stop: a rollback ran, or the cutover isn't in place (precondition 1). Until this change merges, `main`'s checker has no guard, so such a record is fixed there with an ordinary reviewed pair, which this change then deletes too.
   - **Delegation (administrator):** ADR 0008's precondition 6 passes, so DigitalOcean's copy of the zone answers no one.
   - **The owner's checks:**
     - nothing still needed runs on the Droplet, such as another site, a scheduled job, or mail, and nothing uses another name in DigitalOcean's zone;
     - the Droplet's Backups tab shows whether automated backups are on, and when each existing one expires;
     - the Google Workspace subscription is active in the Admin console.
3. **Archive (owner, optional).** Copy what's worth keeping from `/var/www` and `/etc/nginx` into private storage, for example `sudo tar czf ~/droplet-archive.tgz /var/www /etc/nginx` on the Droplet, then `scp` it off. Leave out `/etc/letsencrypt`. Export DigitalOcean's zone into the same archive, from its Domains page or with `doctl compute domain records list zachdavids.com`.
4. **Snapshot (owner, optional).** Take one only if a recovery copy is useful. Record in `docs/progress.md` its size, its monthly cost, and its deletion date, at most 30 days after step 6.
5. **End the rollback window.**
   - Run step 2's Route 53 check again, and ADR 0008's "The site, through real DNS" checks, each `curl` once with `-4` and once with `-6`.
   - Update this ADR's Status and `docs/progress.md`'s row 9 to say this change's merge ends the window, with steps 1 to 4's results.
   - Merge this change, and check that its Deploy run on `main` passed.

   From here on there is no DNS rollback.
6. **Destroy the Droplet (owner).**
   1. **Optionally, first:** make the copies of `/etc/letsencrypt` useless. Run `sudo certbot revoke --cert-name <name>`, with the name from `sudo certbot certificates`, then `sudo certbot unregister`. Do this only after step 5, since a revoked certificate can't serve a rollback.
   2. **Destroy it** from its page in DigitalOcean's control panel. In the Destroy dialog, leave step 4's snapshot unselected. Select any volume and volume snapshot, or record each one you keep, with its size and monthly cost.
   3. **Confirm it's gone:** the Droplets list no longer shows it. A powered-off Droplet still exists, and DigitalOcean still bills it.
   4. **Check related resources:**
      - Networking > Reserved IPs holds nothing from it.
      - If certbot used the `dns-digitalocean` authenticator (ADR 0008, precondition 8), revoke its token under API in DigitalOcean's control panel.
7. **Delete DigitalOcean's DNS zone (owner)** from Networking > Domains. Before the deletion, `nslookup -type=NS zachdavids.com. ns1.digitalocean.com` lists `ns1`, `ns2`, and `ns3.digitalocean.com`, which shows the check can see the zone. After it, the same command prints `can't find zachdavids.com.: Query refused`. If the records still show right after the deletion, wait a few minutes and repeat. The Domains list no longer showing the zone is the direct check of the owner's account.
8. **Workspace (owner):**
   - the Admin console shows the Workspace subscription active;
   - a message from an outside account reaches the Workspace mailbox, and a reply gets back;
   - in the received copies, SPF, DKIM, and DMARC pass.
9. **Verify (administrator).**
   - **Zone diff:** export to `~/droplet-retirement/zone-1.json`, then `diff -u ~/droplet-retirement/zone-0.json ~/droplet-retirement/zone-1.json`. Nothing in this runbook writes to Route 53, so any difference is someone else's change, such as an email record the owner approved. Note it in `docs/progress.md`, and never revert it here.
   - **Route 53:** step 2's check still prints nothing. If a record at the Droplet's addresses ever turns up after the merge, remove it at once with a committed batch that deletes it. That batch needs no reverse.
   - **Public DNS:** `nslookup -type=A zachdavids.com. ns-1989.awsdns-56.co.uk` and `-type=AAAA`, and the same at `8.8.8.8`, return CloudFront's addresses, and so do the same queries for `www.zachdavids.com.`.
   - **The old server:** `curl -sS -m 10 -o /dev/null --connect-to zachdavids.com:443:159.203.37.93:443 https://zachdavids.com/` fails, and so does the same with `[2604:a880:cad:d0::46:6001]` in place of the IPv4 address. Nothing at the Droplet's addresses serves the site with a valid certificate. This doesn't show the Droplet is destroyed; step 6's check in the control panel does.
   - **The site:** ADR 0008's "The site, through real DNS" checks pass again, and step 5's Deploy run passed (`gh run list --workflow deploy.yml --branch main --limit 1`).
10. **Record** steps 1 to 9 in `docs/progress.md`, in a pull request right after step 9.
11. **Later:** delete the snapshot, if one was taken, by its recorded date, and record it. Record when the last automated backup has expired.

## Limits

- **What the guard compares:** values. It refuses `A` and `AAAA` records at the Droplet's two addresses, as "Decision" describes. It doesn't follow a `CNAME`, so a `www` `CNAME` to a name that resolves to the Droplet, such as a wildcard DNS service's `159-203-37-93.sslip.io`, gets past it. Nor does it catch other translated forms (NAT64's `64:ff9b::/96`) or any other address someone has released. Review must catch those.
- **The guard is a test over committed files:** it lives in the change it protects, so reverting this change removes it, and it can't stop an administrator from applying a file taken from git history. What stops a reverse batch applied that way is ADR 0008's rollback pre-check, which needs a valid answer from the Droplet. Never apply a batch from git history.
- **What the checks see:** DNS, the zone's records, and HTTPS at the Droplet's addresses. Whether anything else still needs the Droplet is the owner's knowledge.
- **Outside AWS and this repository:** the archive, the snapshot, the automated backups, any volumes, the Droplet, and DigitalOcean's zone. Their state is what the owner records.
- **No DNS fallback afterwards:** once the window ends, a problem with the distribution has to be fixed on CloudFront's side, by an application or CloudFormation rollback (ADR 0006). Moving the site elsewhere would take a new, reviewed batch.
