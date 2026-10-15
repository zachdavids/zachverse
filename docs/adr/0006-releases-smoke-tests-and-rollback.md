# ADR 0006: Releases, smoke tests, and rollback

- Status: Accepted (milestone 6). The workflows publish only on `main`, so the first release follows the merge.
- Date: 2026-10-15

## Decision

**A release** is the build of one commit on `main`: the files the deploy workflow's build job checked and uploaded (ADR 0005). It is named by its full commit SHA, and its pages name it too: the build sets `RELEASE_COMMIT`, so `index.html` and `404.html` carry `<meta name="zachverse-release" content="<commit>" />`, which `check:dist` and the browser check require. Every release's pages therefore differ from every other's, and the page served shows which release is live.

**Four jobs.** The deploy workflow runs them one after another (ADR 0005):

1. **`build`**, without the deploy role: CI's checks, the build, the browser check of the built pages (below), `check:dist`, and the upload.
2. **`deploy`**, with the role: publishes the release and smoke-tests it over HTTP.
3. **`browser`**, without the role: the browser check again, on the live release through CloudFront.
4. **`verify`**, with the role: records the release as verified if the smoke test and the browser check passed, and otherwise rolls back.

The jobs with the role install no packages. The browser checks, which need Playwright and the Chromium it downloads, run only in jobs without it.

**Publishing.** After its access check, the deploy job runs `node scripts/release.ts publish site`, which:

1. **Checks the order.** It reads the release history and, through GitHub's compare API with the job's read-only token, refuses a commit older than the newest one published, or on another line of history. Publishing the current release again is a retry and goes ahead, and so is publishing again a release that an automatic rollback (below) replaced. While a restore is the current release, it refuses every release unless the run asks to resume ("Holding deploys", below). A refusal fails the job, visibly, before anything changes (ADR 0005, "Limits", asked for that).
2. **Checks any saved copy.** If the release was copied before, the copy's manifest must list exactly this build's files, or the job fails before writing anything.
3. **Uploads the assets.** Every file under `assets/` must end in a hyphen and an 8-character hash before its extension, as Vite names its output; the script refuses any other, and `tests/repo-policy.test.ts` keeps `public/` from holding an `assets/` directory, whose files Vite would copy unhashed. An asset is uploaded unless an object with the same SHA-256, content type, and `Cache-Control` is there already. One whose name holds other bytes or headers, as after a change to the header table, is replaced, and its path is invalidated with the pages'. Each upload carries a SHA-256 checksum, which S3 checks before it accepts the object.
4. **Saves a copy**, if there is none: every file of the release under `_releases/<commit>/site/`, then its manifest (each file's path, SHA-256, size, content type, and `Cache-Control`) as `_releases/<commit>/manifest.json`, written last so a manifest means a complete copy.
5. **Records the release as started** in `_releases/history.json`: the action, the commit, the run (`<run ID>-<attempt>`), and the time.
6. **Publishes the pages**, every file outside `assets/`: other files first, then HTML, then each `index.html`, so whatever a page refers to is there before it.
7. **Removes the pages the release no longer has:** every object outside `assets/` and `_releases/` that the release does not list. Before it writes any page, it fails on a key no release would write (one with characters outside the plain set that release files use), leaving that key for someone to look at.
8. **Invalidates** the paths of its pages and of the pages it removed and, for an `index.html`, the directory paths viewers request it by (`/`, and `/about/` and `/about` for `about/index.html`), since the viewer-request function serves those; AWS recommends invalidating both the requested and the rewritten path. A new asset needs none, since its name is new, but a replaced one is invalidated too. It waits for the invalidation to complete (the AWS CLI gives up after 10 minutes).
9. **Records the release as published.** The smoke test follows, then the browser job's check; the verify job then records the release as verified, or rolls it back (see "Automatic rollback").

**What is deleted, and what never is.** The deploy role may delete objects in the bucket, but its policy denies deleting anything under `assets/` or `_releases/` (ADR 0004), and it cannot delete object versions. Every release's assets therefore stay where they are, so a page an earlier release left in a browser's cache, or a restored release, still finds its files. A page that a release no longer has is deleted, and stops being served once the invalidation completes. The bucket is versioned, so a delete only hides the page behind a delete marker, and its earlier versions stay recoverable for 90 days (ADR 0003).

**Caching**, with the distribution's AWS-managed `CachingOptimized` policy, which the Free flat-rate plan supports (ADR 0003) and which honors each object's `Cache-Control` within its TTLs:

| Files | `Cache-Control` | Effect |
| --- | --- | --- |
| `assets/` (content-hashed names) | `public, max-age=31536000, immutable` | Browsers and CloudFront keep them a year; a changed asset gets a new name |
| Every other file | `no-cache` | Browsers revalidate on each use; CloudFront keeps the file for the policy's 1-second minimum TTL, which takes precedence over `no-cache` |

Content types come from a fixed table in `scripts/release-lib.ts`; a file with another extension fails the publish rather than going out with a guessed type.

**Release records.** `_releases/` holds the copies and the history. The bucket policy denies CloudFront `s3:GetObject` there (`infra/lib/site-stack.ts`), so the records are not part of the site: a request for one gets S3's 403, which the distribution leaves unmapped (ADR 0003). A path there with no object behind it gets the usual 404, since S3 says a key is missing when the caller may list the bucket, as CloudFront may; the smoke test asks for the history, which exists by then. The deploy role reads and writes the records but may not delete them. Bucket versioning keeps each overwritten version of the history for 90 days.

**One publication at a time.** The deploy workflow and the Restore workflow share the concurrency group `deploy-refs/heads/main`; concurrency groups span a repository's workflows, and `tests/repo-policy.test.ts` keeps the repository's other workflows and jobs out of it. One run publishes at a time, neither workflow cancels a run in progress, and at most one waits: a newer run replaces a waiting one, which then shows as cancelled. A pull request's own workflow files could still join the group (ADR 0005, "Limits"). No one else writes the site's objects: infrastructure changes go through ADR 0004's runbook, and releases only through these workflows.

**Smoke test.** After every publish, restore, or rollback, `node scripts/smoke.ts <dir>` checks what viewers get over HTTP, from the GitHub runner and through CloudFront, against the release's own files in `<dir>`. The custom hostnames are reached as `curl --connect-to` reaches them: the connection goes to the distribution while TLS (server name and certificate check) and the `Host` header use the custom name, so they are tested before DNS points at CloudFront (milestone 8). Each request opens its own connection and checks the certificate whatever the environment says. It checks that:

- the CloudFront hostname, and `zachdavids.com` through it, serve the home page over HTTPS;
- the home page is prerendered (a title, markup inside its root element, text ending a heading, no prerender marker; no stricter than what `check:dist` requires of every build) and names its release;
- every file of the release is served with its exact bytes, content type, and `Cache-Control`, and every root-relative reference in every page loads;
- `http://` redirects to `https://` with a 301 for both hostnames, and `www` redirects to the apex with a 301 that keeps the path and query (one parameter, since CloudFront can reorder different ones; ADR 0003, "Limits");
- a missing page gets the 404 page with status 404, and a missing asset gets 404;
- a release record gets S3's 403, not the 404 page, so a genuine access failure stays visible;
- the bucket's own endpoint refuses unauthenticated requests with 403.

A failed check fails its job, and the release is never recorded as verified, so the Restore workflow refuses to restore it.

**Browser check.** `scripts/browser-check.ts` loads the pages in headless Chromium through Playwright, as a visitor's browser does, for what an HTTP check cannot see. It runs on the way to every release: in CI on each pull request, and in the build job, on the built pages served locally the way CloudFront serves them (`npm run check:browser`); then in the browser job, on the live release at `zachdavids.com`, with Chromium resolving the site's hostnames to the distribution, so it too runs before DNS points at CloudFront. On the home page in a 320-pixel and a 1280-pixel window, and on a missing page, it checks that:

- no script throws, nothing logs a console error, and no request fails or gets an error status (the 404 page's own status aside);
- every script and stylesheet the page links loads, and every stylesheet has rules;
- the page does not scroll sideways, and its main heading is visible inside the window;
- a Tab press on the home page moves the focus to an element that shows it, with an outline or a shadow;
- the page names the release expected: none in CI, the run's commit in the deploy workflow.

React reports a page whose markup differs from what its scripts render as a console error, so the check catches that as well.

**Automatic rollback.** The verify job runs whenever the deploy job ran, unless the run was cancelled. If the deploy job and the browser check both passed, it records the release as verified. Otherwise (publishing was refused or failed, the smoke test or the browser check failed, or either job timed out) it runs `node scripts/release.ts rollback rolled-back`. If this run left a release in place that has not been verified, that command publishes the last release before it that has, from that release's copy and exactly as a restore does, and records it in the history as a `rollback`. The job then smoke-tests that release against `rolled-back/` and records it as verified, but only if that smoke test passes, and then fails, so the run fails visibly. Nothing is rolled back when the run changed nothing (the order check or the hold refused it, or it failed before writing a page), or when no earlier release has been verified, as for the very first; the rollback step then says so and leaves the site as it is. Re-running all of the failed run's jobs publishes the same release again, as a retry, and rolls it back again if it fails again.

**Restore.** `.github/workflows/restore.yml` runs by hand on `main`. Its one input is the full commit SHA of a verified release, which the run summaries of deploys and restores name; an input that is not one fails, listing the verified releases, newest first. The SHA is fixed when the run starts, so a re-run, or a run that waited in the group, restores the same release. A test job first typechecks and tests the commit at `main`'s head, without the role, as the deploy workflow's build job does. Then the restore job, in the `production` environment as the deploy role, runs `node scripts/release.ts restore`, which reads the release's copy and checks every file against the manifest's SHA-256, writes the files to `restored/` for the smoke test, puts back any asset that has gone missing, publishes the pages and removes the ones the release lacks, as a `restore` entry in the history, invalidates, and waits. The smoke test then runs against `restored/`, and the release is recorded as verified again. The Restore workflow does not roll back by itself: a restore that fails its smoke test stays in place for whoever ran it, since rolling back from it could put back the release they were rolling away from.

**Holding deploys.** A restore holds deploys. While it is the current release, publishing refuses every release, so the next push to `main` cannot quietly bring back what was restored away: that push's run builds and checks the commit, then fails at the publish step, saying deploys are held. To publish again, run the Deploy workflow on `main` by hand with "Publish over a restore" (its `resume` input) checked. That run publishes `main`'s head, which may be the very release the restore replaced, and the hold ends with it. An automatic rollback holds nothing, so a fix pushed after a failed release goes out as usual. A restore that waits behind a deploy in the group replaces what that deploy published.

## Three kinds of rollback

| | What it changes | How | Who |
| --- | --- | --- | --- |
| **Application rollback** (this ADR) | Only the site's objects in S3, and CloudFront's cache | The Restore workflow, which holds deploys until someone resumes them; the verify job's automatic rollback after a failed check; or a fix pushed to `main` | Anyone who can run workflows; the deploy role |
| **CloudFormation rollback** | A stack's resources and configuration: the bucket, distribution, function, policies, identity stack | CloudFormation rolls a failed update back by itself. To undo a deployed change, deploy the previous commit's template with ADR 0004's runbook; `cdk rollback` recovers a stack stuck in `UPDATE_ROLLBACK_FAILED`. Every resource is retained (ADR 0003), and no stack holds the site's content, so none of this changes a release. Rolling the site stack back past milestone 6 removes the release-record deny and the deploy role's page deletion, though: CloudFront then serves the records, so every smoke test fails, and a publish with a page to remove fails, until the stack is deployed again | An administrator |
| **DNS rollback** (milestone 8) | The website's records in the hosted zone | The reverse change batch in `infra/dns/` for the website names only, never a whole-zone export, which could erase later email-authentication changes (`infra/dns/README.md`) | An administrator |

Each changes only its own layer: restoring a release changes no stack and no DNS record, rolling back a stack changes no object in the bucket, and a DNS rollback changes neither. Each still relies on the others: releases on the stack's bucket policy, distribution, and deploy permissions, and the site's hostnames on DNS.

## Verification before the merge (2026-10-15)

- Unit tests cover the release, smoke-test, and browser-check scripts at 100%, among them: the order of every write, removal, and invalidation in a publish, a restore, and a rollback; the pages a release no longer has removed and invalidated, but never an asset or a release record; assets kept, uploaded, or replaced and invalidated, by checksum and headers; a stale, diverged, or replaced release refused before any write, and every release over a restore unless the run resumes; a copy with other files, a history or manifest that is not what it should be, or a key no release writes, refused before any page is written; a re-run of a restore restoring the same release; a rollback to the last verified release after a failed check or a publish that stopped partway, past earlier failed releases, and none when the run changed nothing or no earlier release was verified; a damaged copy, a missing file, or a never-verified release not restored; each smoke and browser check failing for the fault it looks for; the home-page check passing the build's real prerendered page.
- The browser check, run for real in Chromium against copies of a fresh build broken on purpose, caught all ten breakages tried: a script that throws, a console error, a layout wider than a phone, a missing stylesheet, a missing script, no focus indicator, a hidden heading, a heading off the screen, pages that name another release, and a hydration mismatch.
- `tests/repo-policy.test.ts` pins the jobs that may assume the deploy role (the deploy and verify jobs, and the Restore workflow's restore job): their steps in order, the verify job's conditions exactly, their settings (no container, services, matrix, or shell override), their permissions and role inputs, and their shared concurrency group, which no other workflow or job may join. It keeps the browser job out of the environment, without variables or an OIDC token. It also pins the Deploy workflow's `resume` input, the Restore workflow's test job, the release scripts' commands, and that those scripts import only Node's built-in modules and the repository's own files, since the role jobs install no packages; and it forbids `NODE_` variables in those jobs.
- `infra/test/site-stack.test.ts` pins the bucket policy's statements, the release-record deny included, and the deploy policy's, with its page deletion and its deny of deleting assets or release records.
- A review of the change in five areas, with each finding checked by two independent skeptics, confirmed 21 findings, all addressed here. CodeQL then flagged two patterns in the smoke test's own tests (a local server echoing the request path, and a host matched by substring), both fixed.
- The release-record deny was deployed with ADR 0004's runbook on 2026-10-15 from `398c15b`, before the merge. Through CloudFront, at both hostnames, an object written under `_releases/` as a probe got 403 `AccessDenied`, and a missing key there 404 `NoSuchKey` (ADR 0003, "Deployed state").

## Limits

- No release, check against the live distribution, or restore can run before the merge: the environment and the role's trust admit only `main`. The first release, its checks through CloudFront, and the restore rehearsal follow it, and `docs/progress.md` records them. The rehearsal needs a second release after the first, which any later commit to `main` makes, since every release's pages name their commit, and it ends by resuming deploys.
- The release-record deny and the deploy role's page deletion are infrastructure. They must be live before a release, or its smoke test fails on the 403 check, and a publish with a page to remove fails partway, after writing its pages. A rollback of the site stack past them would bring those failures back (see "Three kinds of rollback").
- The browser check sees what Chromium sees, in two window sizes and after one Tab press. It cannot judge how a page looks beyond what it measures, and other browsers can differ. It checks the home page and the 404 page, which are all the placeholder has.
- A restore and a rollback check what they put back with the smoke test only: the release passed the browser check when it first went out, and its copy goes back with every file's SHA-256 checked.
- A held deploy fails its run. Until someone resumes deploys, every push to `main` builds, checks, and stops at the publish step.
- The order check, the hold, the rollback, and the restore trust the history. A history edited by hand, or replaced by an older version, misleads them. It is written without a conditional write; only the concurrency group keeps two runs from writing it at once.
- A run cancelled while it publishes or rolls back, by someone or by another run in its group, leaves the site partly updated, with an unfinished history entry, and nothing rolls it back, since the verify job does not run after a cancellation. Re-running the whole run publishes the same release again, which the order check allows; the Restore workflow puts back a verified one. A deploy or browser job that times out is rolled back like one that failed.
- Re-running only the failed jobs, after the browser check failed, cannot finish the release: the deploy job passed, so it does not run again, and the browser job finds the rolled-back release live and fails again. Re-run all jobs instead.
- A rollback goes back to the last release that passed its checks, which need not be the one live before the failed publish. If the rolled-back release fails its own smoke test, it stays in place, unverified, and the run fails; then run the Restore workflow or push a fix.
- An asset name check cannot tell a hash from a word: `assets/hero-backdrop.png` passes. Vite's output names carry a hash (`tests/repo-policy.test.ts` checks its config), and `public/` may not hold an `assets/` directory, so only those reach `assets/`.
- The smoke test and the live browser check each run from one GitHub runner over IPv4, so they see one edge location. A completed invalidation applies to every edge, but the checks do not show it.
- A restore job, like a deploy or verify job, makes GitHub record a deployment to `production` of the workflow's own commit. The release it restored is in the run's summary and the history, not in that record.
- The release scripts run with the deploy role's credentials, from the job's own checkout of the commit, like every other step of those jobs (ADR 0005, "Limits"). The deploy workflow's build job and the Restore workflow's test job test them at that commit first. The browser checks run Playwright and its Chromium without the role.
- Each release of the placeholder invalidates six paths, plus any it removes, and a restore or rollback the same; CloudFront's first 1,000 invalidation paths each month are free.
