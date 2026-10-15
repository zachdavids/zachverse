# ADR 0006: Releases, smoke tests, and rollback

- Status: Accepted (milestone 6), merged on 2026-10-15 as `d6503b1`, whose Deploy run published and verified the first release ("First release"). The restore rehearsal passed the same day ("Restore rehearsal").
- Date: 2026-10-15

## Decision

**A release** is the build of one commit on `main`: the files the deploy workflow's build job checked and uploaded (ADR 0005). It is named by its full commit SHA, and its pages name it too: the build sets `RELEASE_COMMIT`, so `index.html` and `404.html` carry `<meta name="zachverse-release" content="<commit>" />`, which `check:dist` and the browser check require. Every release's pages therefore differ from every other's, and the page served shows which release is live.

**Four jobs.** The deploy workflow runs them one after another (ADR 0005):

1. **`build`**, without the deploy role: CI's checks, the build, and `check:dist`; then the digest and the upload; then the browser check of the built pages (below). Playwright checks nothing but the size of the Chromium it downloads, so Chromium runs only once the site's files are fixed in the artifact. The deploy job still waits for this job, and so for the check.
2. **`deploy`**, with the role: publishes the release and smoke-tests it over HTTP.
3. **`browser`**, without the role: the browser check again, on the live release through CloudFront.
4. **`verify`**, with the role: records the release as verified if the smoke test and the browser check passed, and otherwise rolls back.

The jobs with the role install no packages. The browser checks, which need Playwright and the Chromium it downloads, run only in jobs without it. Of what those jobs produce, only their results reach a job with the role, apart from the build job's digest and `site` artifact, which it records and uploads before Playwright downloads Chromium.

**Publishing.** After its access check, the deploy job runs `node scripts/release.ts publish site`. Everything that can refuse the release does so before the first write:

1. **Checks the order.** It reads the release history and, through GitHub's compare API with the job's read-only token, refuses a commit older than the newest one published, or on another line of history. Publishing the current release again is a retry and goes ahead, and so is publishing again a release that an automatic rollback (below) replaced. While a restore is the current release, it refuses every release unless the run asks to resume ("Holding deploys", below). A refusal fails the job, visibly, before anything changes (ADR 0005, "Limits", asked for that).
2. **Checks any saved copy.** If the release was copied before, the copy's manifest must list exactly this build's files.
3. **Plans the rest**, reading only:
   - the record of assets still to invalidate (step 4);
   - the bucket's keys, for the pages to remove (step 8). It fails on a key no release would write: one with characters outside the plain set that release files use, or a `.` or `..` segment. That key is left for someone to look at.
   - each asset's checksum and headers in the bucket.
4. **Uploads the assets.**
   - **Names:** every file under `assets/` must end in a hyphen and an 8-character hash before its extension, as Vite names its output. The script refuses any other, `check:dist` applies the same rule, and `tests/repo-policy.test.ts` keeps `public/` from holding an `assets/` directory, whose files Vite would copy unhashed.
   - **Which ones:** an asset is uploaded unless an object with the same SHA-256, content type, and `Cache-Control` is there already. One whose name holds other bytes or headers, as after a change to the header table, is replaced.
   - **Pending invalidations:** a replaced asset may still be cached as immutable. Before it is overwritten, its path joins `_releases/pending-invalidation.json`. Every publish, restore, and rollback invalidates the paths recorded there, and clears them only once an invalidation that includes them has completed. A run that fails in between therefore leaves the invalidation to the next one, which would otherwise find the new copy in place and never invalidate it.
   - **Checksums:** each upload carries a SHA-256 checksum, which S3 checks before it accepts the object.
5. **Saves a copy**, if there is none: every file of the release under `_releases/<commit>/site/`, then its manifest (each file's path, SHA-256, size, content type, and `Cache-Control`) as `_releases/<commit>/manifest.json`. The manifest is written last, so a manifest means a complete copy.
6. **Records the release as started** in `_releases/history.json`: the action, the commit, the run (`<run ID>-<attempt>`), and the time.
7. **Publishes the pages**, every file outside `assets/`: other files first, then HTML, then each `index.html`, so whatever a page refers to is there before it.
8. **Removes the pages the release no longer has:** every object outside `assets/` and `_releases/` that the release does not list.
9. **Invalidates**, and waits for the invalidation to complete (the AWS CLI gives up after 10 minutes):
   - the paths of its pages and of the pages it removed;
   - for an `index.html`, the directory paths viewers request it by (`/`, and `/about/` and `/about` for `about/index.html`), since the viewer-request function serves those. AWS recommends invalidating both the requested and the rewritten path;
   - the assets recorded as pending, which it then clears. A new asset needs no invalidation, since its name is new.
10. **Records the release as published.** The smoke test follows, then the browser job's check. The verify job then records the release as verified, or rolls it back (see "Automatic rollback").

**What is deleted, and what never is.** The deploy role may delete objects in the bucket, but its policy denies deleting anything under `assets/` or `_releases/` (ADR 0004), and it cannot delete object versions. Every release's assets therefore stay where they are, so a page an earlier release left in a browser's cache, or a restored release, still finds its files. A page that a release no longer has is deleted, and stops being served once the invalidation completes. The bucket is versioned, so a delete only hides the page behind a delete marker, and its earlier versions stay recoverable for 90 days (ADR 0003).

**`check:dist` applies the release rules too.** A file a release would refuse fails the build's check first. So does any file the build emits outside `assets/` that is neither a page (HTML) nor copied from `public/`. A release would publish such a file as a page, and the next release that lacks it would delete it, which a chunk that an open page loads later must not be.

**Caching**, with the distribution's AWS-managed `CachingOptimized` policy, which the Free flat-rate plan supports (ADR 0003) and which honors each object's `Cache-Control` within its TTLs:

| Files | `Cache-Control` | Effect |
| --- | --- | --- |
| `assets/` (content-hashed names) | `public, max-age=31536000, immutable` | Browsers and CloudFront keep them a year; a changed asset gets a new name |
| Every other file | `no-cache` | Browsers revalidate on each use; CloudFront keeps the file for the policy's 1-second minimum TTL, which takes precedence over `no-cache` |

Content types come from a fixed table in `scripts/release-lib.ts`; a file with another extension fails the publish rather than going out with a guessed type.

**Release records.** `_releases/` holds the copies, the history, and the pending invalidations.
- **Not part of the site:** the bucket policy denies CloudFront `s3:GetObject` there (`infra/lib/site-stack.ts`). A request for a record gets S3's 403, which the distribution leaves unmapped (ADR 0003). A path there with no object behind it gets the usual 404, since S3 says a key is missing when the caller may list the bucket, as CloudFront may. The smoke test asks for the history, which exists by then.
- **Kept:** the deploy role reads and writes the records but may not delete them. Bucket versioning keeps each overwritten version for 90 days.
- **Format marker:** the history carries `"format": 1`, and a history without one reads as format 1. The format changes for a new entry kind, a field that changes type, any new top-level field, or any field older code must act on. Only an informational field inside entries needs none: older code ignores it and writes it back unchanged. So release code older than the history refuses it rather than misreading it, as in a re-run of an old run, or after a revert. Its message says newer code wrote the history, not to put an older version back, which would lose the newest entries.

**One publication at a time.** The deploy workflow and the Restore workflow share the concurrency group `deploy-refs/heads/main`. Concurrency groups span a repository's workflows, and `tests/repo-policy.test.ts` keeps the repository's other workflows and jobs out of it.
- One run publishes at a time, and neither workflow cancels a run in progress.
- At most one run waits: a newer run replaces a waiting one, which then shows as cancelled.
- A pull request's own workflow files could still join the group (ADR 0005, "Limits").
- No one else writes the site's objects: infrastructure changes go through ADR 0004's runbook, and releases only through these workflows.

**Smoke test.** After every publish, restore, or rollback, `node scripts/smoke.ts <dir>` checks what viewers get over HTTP, from the GitHub runner and through CloudFront, against the release's own files in `<dir>`. The custom hostnames are reached as `curl --connect-to` reaches them: the connection goes to the distribution, while TLS (server name and certificate check) and the `Host` header use the custom name. They are therefore tested before DNS points at CloudFront (milestone 8). Each request opens its own connection, sends a `User-Agent`, which AWS WAF's managed core rules require, and checks the certificate whatever the environment says. It checks that:

- the CloudFront hostname, and `zachdavids.com` through it, serve the home page over HTTPS;
- the home page is prerendered (a title, markup inside its root element, text ending a heading, no prerender marker; no stricter than what `check:dist` requires of every build) and names its release;
- every file of the release is served with its exact bytes, content type, and `Cache-Control`, and every root-relative reference in every page loads;
- `http://` redirects to `https://` with a 301 for both hostnames, and `www` redirects to the apex with a 301 that keeps the path and query (one parameter, since CloudFront can reorder different ones; ADR 0003, "Limits");
- a missing page gets the 404 page with status 404, and a missing asset gets 404;
- a release record gets S3's 403, not the 404 page, so a genuine access failure stays visible;
- the bucket's own endpoint refuses unauthenticated requests with 403.

A failed check fails its job, and the release is never recorded as verified, so the Restore workflow refuses to restore it.

**Browser check.** `scripts/browser-check.ts` loads the pages in headless Chromium through Playwright, as a visitor's browser does, for what an HTTP check cannot see. It runs on the way to every release:
- in CI on each pull request, and in the build job, on the built pages served locally the way CloudFront serves them (`npm run check:browser`);
- then in the browser job, on the live release at `zachdavids.com`, with Chromium resolving the site's hostnames to the distribution, so it too runs before DNS points at CloudFront. That job installs its packages and Chromium after the release is live, and a failed install would roll the release back, so it retries each install twice, 30 seconds apart.

It loads the home page in a 320-pixel and a 1280-pixel window, and a missing page. It watches each for 2 seconds after its network goes quiet, then checks that:

- no script threw, nothing logged a console error, and no request failed or got an error status. The 404 page's own status, and the one console message Chromium logs for it, are the exceptions;
- every script and stylesheet the page links loaded, and every stylesheet has rules;
- the page does not scroll sideways;
- its main heading has text and a box inside the window, its computed `visibility` is `visible`, and neither it nor an ancestor has an opacity of 0 (Chromium's `checkVisibility`);
- a Tab press on the home page moves the focus to an element with an outline (a style, a width, and a colour that is not fully transparent) or a box shadow with a layer of some size in such a colour. Neither is compared with the element's unfocused look, and contrast is not judged;
- the page names the release expected: none in CI, the run's commit in the deploy workflow.

React reports a page whose markup differs from what its scripts render as a console error, so the check catches that as well.

**Automatic rollback.** The verify job runs whenever the deploy job ran, unless the run was cancelled.
- **Checks passed:** if the deploy job and the browser check both passed, it records the release as verified.
- **Otherwise,** it runs `node scripts/release.ts rollback rolled-back`. That covers publishing refused or failed, the smoke test or the browser check failed, the browser job unable to run its check, or either job timing out.
- **What it publishes:** if this run left a release in place that has not been verified, that command publishes again the newest release before it that passed its checks or that someone restored. It publishes from that release's copy, exactly as a restore does, and records it in the history as a `rollback`. A restore counts even if its own checks failed: it names a release that had passed them, and rolling back past it would put back the release it restored away from.
- **Then:** the job smoke-tests that release against `rolled-back/` and records it as verified, but only if that smoke test passes. Then it fails, so the run fails visibly.
- **Nothing to roll back:** when the run changed nothing (the order check or the hold refused it, or it failed before writing a page), or when there is no such earlier release, as for the very first. The rollback step then says so, naming the current release, and leaves the site as it is.

A history entry belongs to the workflow run, in any attempt: the run ID decides, and the attempt is kept for the record and for the invalidation reference. So a re-run of the run's failed jobs can roll back, or record, what an earlier attempt published (see "When a release fails").

**Restore.** `.github/workflows/restore.yml` runs by hand on `main`.
- **Input:** the full commit SHA of a verified release, which the run summaries of deploys and restores name. An input that is not one fails, listing the verified releases, newest first. The SHA is fixed when the run starts, so a re-run, or a run that waited in the group, restores the same release.
- **Test job:** typechecks and tests the commit at `main`'s head first, without the role, as the deploy workflow's build job does.
- **Restore job:** runs in the `production` environment as the deploy role. Its `node scripts/release.ts restore`:
  - reads the release's copy and checks every file against the manifest's SHA-256;
  - writes the files to `restored/` for the smoke test;
  - puts back any asset that has gone missing;
  - publishes the pages and removes the ones the release lacks, as a `restore` entry in the history;
  - invalidates, and waits.
- **Then:** the smoke test runs against `restored/`, and the release is recorded as verified again.
- **No rollback of its own:** a restore that fails its smoke test stays in place for whoever ran it, since rolling back from it could put back the release they were rolling away from.

**Holding deploys.** A restore holds deploys.
- **While it is the current release,** publishing refuses every release, so the next push to `main` cannot quietly bring back what was restored away. That push's run builds and checks the commit, then fails at the publish step, saying deploys are held.
- **To publish again,** run the Deploy workflow on `main` by hand with "Publish over a restore" (its `resume` input) checked. That run publishes `main`'s head, which may be the very release the restore replaced, and the hold ends with it.
- **Re-runs:** only a run's first attempt counts the box. A re-run keeps the run's inputs, and re-running an old run must not publish over a restore made since, so a re-run notes this and meets the hold.
- **Automatic rollbacks** hold nothing, so a fix pushed after a failed release goes out as usual.
- **A restore that waits behind a deploy** in the group replaces what that deploy published.

## When a release fails

- **A check failed.** The verify job rolled back to the last good release, and the run failed. Push a fix, or run the Restore workflow for another verified release.
- **A job failed for another reason,** such as a network error or an outage, and nothing was rolled back. Re-run the run's failed jobs. The verify job can then record or roll back what an earlier attempt published. A re-run never counts "Publish over a restore", though: if a run started with it failed before publishing anything, the restore is still the current release, so start a new Deploy run on `main` by hand with the box checked instead.
- **The verify job already rolled back** (as after a browser job that could not install Chromium during an outage). Re-run all jobs instead, once the cause is gone: re-running only the failed ones would check the rolled-back release against this run's commit, and fail. A full re-run publishes the release again, as a retry.
- **A run was cancelled partway.** The site may be partly updated, with an unfinished history entry. Re-running all jobs publishes the same release again; the Restore workflow puts back a verified one.
- **The release scripts themselves are broken.** Publishing, the automatic rollback, and Restore all run the scripts of the commit at hand, so a defect the unit tests miss can stop all three.
  - Revert the change on `main`; the revert's own run publishes with the reverted scripts.
  - If a Restore was tried in the meantime, its entry holds deploys. Run the Deploy workflow by hand with "Publish over a restore" checked.
- **A check got 403s from the web ACL** (since milestone 7). Re-run all jobs, which gets a runner with another address. If the block persists, see ADR 0007, "If a step fails": a fix pushed to `main` is blocked the same way.
- **The history is refused as newer than the code.** Run release code that knows its format. Do not put back an older version of the history: that would drop its newest entries.

## Three kinds of rollback

| | What it changes | How | Who |
| --- | --- | --- | --- |
| **Application rollback** (this ADR) | Only the site's objects in S3, and CloudFront's cache | The Restore workflow, which holds deploys until someone resumes them; the verify job's automatic rollback after a failed check; or a fix pushed to `main` | Anyone who can run workflows; the deploy role |
| **CloudFormation rollback** | A stack's resources and configuration: the bucket, distribution, function, policies, identity stack | CloudFormation rolls a failed update back by itself. To undo a deployed change, deploy the previous commit's template with ADR 0004's runbook; `cdk rollback` recovers a stack stuck in `UPDATE_ROLLBACK_FAILED`. Every resource is retained (ADR 0003), and no stack holds the site's content, so none of this changes a release. Rolling the site stack back past milestone 6 removes the release-record deny and the deploy role's page deletion, though: CloudFront then serves the records, so every smoke test fails, and a publish with a page to remove fails, until the stack is deployed again. Since milestone 7, while the Free plan is on, a template without `pricingPlan` fails at the distribution, which CloudFront won't detach from the web ACL, and CloudFormation rolls the update back: going back to pay-as-you-go is ADR 0007's "Retention" sequence. After a failed milestone 7 deploy, `cdk rollback` works only once the subscription is cancelled (ADR 0007, "If a step fails") | An administrator |
| **DNS rollback** (milestone 8) | The website's records in the hosted zone | The reverse change batch in `infra/dns/` for the website names only, never a whole-zone export, which could erase later email-authentication changes (`infra/dns/README.md`). It lasts only until milestone 9 ends the rollback window and retires the Droplet; after that, nothing is left to roll back to (ADR 0009) | An administrator |

Each changes only its own layer: restoring a release changes no stack and no DNS record, rolling back a stack changes no object in the bucket, and a DNS rollback changes neither. Each still relies on the others: releases on the stack's bucket policy, distribution, and deploy permissions, and the site's hostnames on DNS.

## Verification before the merge (2026-10-15)

- **Unit tests** cover the release, smoke-test, and browser-check scripts at 100%. Among them:
  - the order of every write, removal, and invalidation in a publish, a restore, and a rollback;
  - the pages a release no longer has removed and invalidated, but never an asset or a release record;
  - assets kept, uploaded, or replaced and invalidated, by checksum and headers;
  - a replaced asset recorded as pending before it is overwritten, and invalidated by the rollback and by a re-run after its own run failed first;
  - a stale, diverged, or replaced release refused before any write, and every release over a restore unless a run's first attempt resumes;
  - a copy with other files, a history, manifest, or pending record that is not what it should be, a history from newer release code, or a key no release writes, all refused before any write, in a publish, a restore, and a rollback;
  - a field it does not know inside a history entry kept through every rewrite, as the format rule relies on;
  - a re-run of a restore restoring the same release;
  - a rollback after a failed check or a publish that stopped partway, past earlier failed releases, in a later attempt of the run, and to a restore whose own checks failed; none when the run changed nothing or no earlier release passed or was restored; and a publish of the release a run rolled back allowed again, however many of its attempts rolled back;
  - a damaged copy, a missing file, or a never-verified release not restored;
  - the AWS adapter reading AWS's error codes from the CLI's JSON errors, with only S3's two missing-key codes read as missing;
  - each smoke and browser check failing for the fault it looks for, and the home-page check passing the build's real prerendered page.
- **The browser check in real Chromium**, against copies of a fresh build broken on purpose: the first round's ten breakages, and the second review's eleven experiments, all as expected. The ten were a script that throws, a console error, a layout wider than a phone, a missing stylesheet, a missing script, no focus indicator, a hidden heading, a heading off the screen, pages that name another release, and a hydration mismatch. In the second round, every breakage failed and the unbroken build passed. The breakages were:
  - a heading hidden, made transparent, or moved above or below the window;
  - a transparent focus outline;
  - a script error or console error 1.5 seconds after load;
  - a console error on the 404 page.
- **`tests/repo-policy.test.ts`** pins the jobs that may assume the deploy role: the deploy and verify jobs, and the Restore workflow's restore job.
  - It pins their steps in order, the verify job's conditions exactly, their settings (no container, services, matrix, or shell override), their permissions and role inputs, and their variables.
  - No step may set those variables again, and the jobs read no job's outputs but the build's digest, no input but their own, nothing from the event, and other jobs only for their results. The workflow's own `env`, which reaches every job, counts too.
  - It pins their shared concurrency group, which no other workflow or job may join.
  - It keeps the browser job out of the environment, without variables, an OIDC token, or outputs. No workflow may set a Playwright, npm config, or proxy variable, in `env` or in a script, and `package.json` sets no `config`.
  - It also pins the Deploy workflow's `resume` input, the Restore workflow's test job, and the release scripts' commands.
  - For the scripts the role jobs run, `tsc` on a Node-only project (`tsconfig.release.json`) must load nothing from `node_modules` but Node's types. A scan rejects what `tsc` cannot follow, and both entry points must load under plain Node, copied beside the repository's `package.json` and run under Node's permission model, which lets them read nothing outside the copy, so no package above it can load.
  - It forbids `NODE_` variables in the role jobs.
  - Mutations caught: the six workflow changes the second review's mutations represent, six import forms that the earlier check missed, and the third review's six bypasses: a Playwright download host set through npm config, through `$GITHUB_ENV`'s multiline form, or in `package.json`; event data through the workflow's `env` or `toJSON(github)`; and a dynamic import of `typescript`.
- **`infra/test/site-stack.test.ts`** pins the bucket policy's statements, the release-record deny included, and the deploy policy's, with its page deletion and its deny of deleting assets or release records.
- **Reviews:**
  - The first, of the change in five areas with each finding checked by two independent skeptics, confirmed 21 findings, all addressed.
  - The second, of the pipeline, the scripts, and the design, after the browser check, page removal, and holds were added, raised 18 distinct findings, each checked by two skeptics. All but a few were confirmed, none of high severity, and all are addressed here.
  - A third, of the second's fixes, confirmed 14 low-severity findings (two rollbacks in one run blocking a retry, `npm ci` not retried, mixed colour syntaxes in the focus check, gaps in the policy tests, and overstated docs), all addressed here; mutations show the new tests catch each regression it described.
  - CodeQL flagged two patterns in the smoke test's own tests (a local server echoing the request path, and a host matched by substring), both fixed.
- **Deployed before the merge,** both with ADR 0004's runbook on 2026-10-15 (ADR 0003, "Deployed state"):
  - the release-record deny, from `398c15b`. Through CloudFront, at both hostnames, an object written under `_releases/` as a probe got 403 `AccessDenied`, and a missing key there 404 `NoSuchKey`;
  - the deploy role's page deletion and its deny, from `a442c2f`. IAM's policy simulator, which applies the organization's SCPs, allows the role to delete a page and denies it deleting anything under `assets/` or `_releases/`, or any object version.

## First release (2026-10-15)

The merge's Deploy run, 38708854432, published `d6503b1` and recorded it as verified, its four jobs passing in about three minutes:
- **Published** at 08:54 UTC: the two assets uploaded, none replaced, no page removed, and six paths invalidated (`/`, `/404.html`, `/favicon.svg`, `/index.html`, `/robots.txt`, `/sitemap.xml`). The runner had AWS CLI 2.37.13 and Node 24.21.0.
- **Checked:** the smoke test's 11 checks passed, and so did the browser check, on the built pages in the build job and on the live release through the distribution in the browser job.
- **Read live afterwards:**
  - The CloudFront hostname, and the apex through the distribution over IPv4 and IPv6, serve `d6503b1`'s pages.
  - `www` and HTTP redirect as designed, and a missing page gets the 404 page.
  - The history gets a 403 through CloudFront. Read with the administrator's credentials, it holds one `publish` entry, verified, by run `38708854432-1`.
  - The bucket holds the release's five files outside `assets/`, its two assets, its copy under `_releases/d6503b1…/` (seven files and a manifest), and the history.
- **The probe** written before the merge (ADR 0003, "Deployed state") was deleted afterwards, its only version removed.

#9, which recorded this release, made the second, which the restore rehearsal needs.

## Restore rehearsal (2026-10-15)

| Step | Run | Result |
| --- | --- | --- |
| Release B: #9's merge, `663ef61` | Deploy 38709915354 | Published and verified at 09:04 UTC. Both assets were already in place, and no page was removed |
| Restore A, `d6503b1` | Restore 38710362375 | The test job passed, then the restore job republished A from its copy, passed all 11 smoke checks, recorded A as verified, and held deploys |
| A Deploy run started by hand without "Publish over a restore" | Deploy 38710602886 | Failed as intended. The publish step refused: "deploys are held, since run 38710362375-1 restored d6503b1… Nothing was changed". The browser job was skipped, and the verify job found nothing to roll back |
| A Deploy run with "Publish over a restore" checked | Deploy 38710866434 | Published B again over the restore, passed the smoke test and the browser check, recorded B as verified at 09:12 UTC, and so ended the hold |

Read live after each step: CloudFront served A after the restore, still A after the refused run, and B at the end, at its own hostname and at the apex through the distribution, over IPv4 and IPv6. The history ends publish A, publish B, restore A, publish B, each verified. The automatic rollback hasn't run live, since no release has failed its checks; its unit tests cover it.

## Limits

- **Only on `main`:** no release, check against the live distribution, or restore can run from another branch, since the environment and the role's trust admit only `main`. So the first release and the restore rehearsal followed the merge ("First release", "Restore rehearsal"). The rehearsal needed a second release, which any later commit to `main` makes, since every release's pages name their commit.
- **Infrastructure first:** the release-record deny and the deploy role's page deletion must be live before a release. Otherwise its smoke test fails on the 403 check, and a publish with a page to remove fails partway, after writing its pages. A rollback of the site stack past them would bring those failures back (see "Three kinds of rollback").
- **What the browser check sees:** what Chromium sees, in two window sizes and after one Tab press, watching each page for 2 seconds after its network goes quiet. It judges nothing about a page's look beyond what it measures: a heading drawn in a transparent colour, clipped, filtered, masked, or covered still passes, and so does a focus indicator that also shows without the focus. Other browsers can differ, and an error later than 2 seconds goes unseen. It checks the home page and the 404 page, which are all the placeholder has.
- **Outages during the browser job:** an outage of npm's registry, Ubuntu's mirrors, or Playwright's CDN that outlasts the retries (three attempts of each install, 30 seconds apart, after npm's own retries) fails the browser job, and the verify job rolls back a release that passed its smoke test. Re-run all jobs once it is over.
- **Unchecked Chromium:** Playwright's download of Chromium is checked only by size. In the build job it runs after the upload, and in the browser job without the role; there, a tampered browser could pass or fail the check, which decides only between recording the release and rolling it back.
- **Restores and rollbacks** check what they put back with the smoke test only: the release passed the browser check when it first went out, and its copy goes back with every file's SHA-256 checked.
- **Cancelled during the browser check:** a run cancelled then leaves the published release live, never verified, with nothing rolled back. A later rollback skips it, and Restore refuses it.
- **Held deploys:** a held deploy fails its run. Until someone resumes deploys, every push to `main` builds, checks, and stops at the publish step.
- **The history is trusted:** the order check, the hold, the rollback, and the restore all trust it. A history edited by hand misleads them, and so does one replaced by an older version, even of the same format. It is written without a conditional write; only the concurrency group keeps two runs from writing it at once.
- **Cancelled while publishing or rolling back:** by someone or by another run in its group, this leaves the site partly updated, with an unfinished history entry. Nothing rolls it back, since the verify job does not run after a cancellation (see "When a release fails"). A deploy or browser job that times out is rolled back like one that failed.
- **The rollback target** need not be the release live before the failed publish. If the rolled-back release fails its own smoke test, it stays in place, unverified, and the run fails; then run the Restore workflow or push a fix.
- **Asset names:** the name check cannot tell a hash from a word, so `assets/hero-backdrop.png` passes. Vite's output names carry a hash (`tests/repo-policy.test.ts` checks its config), and `public/` may not hold an `assets/` directory, so only those reach `assets/`.
- **Extensionless files:** a file without an extension cannot be released, since its content type would have to be guessed. The viewer-request function passes `/.well-known/` paths through for such files, so one there needs a content type added to the release scripts first. The smoke test and the browser check's local server map paths as that function does, but without that exception; a `/.well-known/` path therefore fails closed in those checks until then.
- **The AWS CLI:** the release scripts ask it for JSON errors (`--cli-error-format json`), which needs AWS CLI 2.34 or later. GitHub's Ubuntu runners have 2.37, and each release's summary records the CLI's and Node's versions.
- **One edge location:** the smoke test and the live browser check each run from one GitHub runner over IPv4. A completed invalidation applies to every edge, but the checks do not show it.
- **Deployment records:** a restore job, like a deploy or verify job, makes GitHub record a deployment to `production` of the workflow's own commit. The release it restored is in the run's summary and the history, not in that record.
- **The role's scripts:** the release scripts run with the deploy role's credentials, from the job's own checkout of the commit, like every other step of those jobs (ADR 0005, "Limits"). The deploy workflow's build job and the Restore workflow's test job test them at that commit first.
- **Invalidation volume:** each release of the placeholder invalidates six paths, plus any it removes or any pending asset, and a restore or rollback the same. CloudFront's first 1,000 invalidation paths each month are free.
