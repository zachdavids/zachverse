# ADR 0006: Releases, smoke tests, and rollback

- Status: Accepted (milestone 6). The workflows publish only on `main`, so the first release follows the merge.
- Date: 2026-10-15

## Decision

**A release** is the build of one commit on `main`: the files the deploy workflow's build job checked and uploaded (ADR 0005). It is named by its full commit SHA, and its pages name it too: the build sets `RELEASE_COMMIT`, so `index.html` and `404.html` carry `<meta name="zachverse-release" content="<commit>" />`, which `check:dist` requires. Every release's pages therefore differ from every other's, and the page served shows which release is live.

**Publishing.** After the access check, the deploy job runs `node scripts/release.ts publish site`, which:

1. **Checks the order.** It reads the release history and, through GitHub's compare API with the job's read-only token, refuses a commit older than the newest one published, or on another line of history. Publishing the current release again is a retry and goes ahead. Re-running the deploy of a release that a restore has since replaced is refused, so that re-run cannot put it back; a newer commit still publishes over a restore, whether pushed or re-run. A refusal fails the job, visibly, before anything changes (ADR 0005, "Limits", asked for that).
2. **Checks any saved copy.** If the release was copied before, the copy's manifest must list exactly this build's files, or the job fails before writing anything.
3. **Uploads the assets.** Every file under `assets/` must end in a hyphen and an 8-character hash before its extension, as Vite names its output; the script refuses any other, and `tests/repo-policy.test.ts` keeps `public/` from holding an `assets/` directory, whose files Vite would copy unhashed. An asset is uploaded unless an object with the same SHA-256, content type, and `Cache-Control` is there already. One whose name holds other bytes or headers, as after a change to the header table, is replaced, and its path is invalidated with the pages'. Each upload carries a SHA-256 checksum, which S3 checks before it accepts the object.
4. **Saves a copy**, if there is none: every file of the release under `_releases/<commit>/site/`, then its manifest (each file's path, SHA-256, size, content type, and `Cache-Control`) as `_releases/<commit>/manifest.json`, written last so a manifest means a complete copy.
5. **Records the release as started** in `_releases/history.json`: the action, the commit, the run (`<run ID>-<attempt>`), and the time.
6. **Publishes the pages**, every file outside `assets/`: other files first, then HTML, then each `index.html`, so whatever a page refers to is there before it.
7. **Invalidates** each page's path and, for an `index.html`, the directory paths viewers request it by (`/`, and `/about/` and `/about` for `about/index.html`), since the viewer-request function serves those; AWS recommends invalidating both the requested and the rewritten path. A new asset needs none, since its name is new, but a replaced one is invalidated too. It waits for the invalidation to complete (the AWS CLI gives up after 10 minutes).
8. **Records the release as published.** Then the smoke test runs, and `node scripts/release.ts verified` records when it passed.

**Nothing is deleted.** The deploy role cannot delete objects (ADR 0004), and no step tries. Every release's assets stay where they are, so a page an earlier release left in a browser's cache, or a restored release, still finds its files.

**Caching**, with the distribution's AWS-managed `CachingOptimized` policy, which the Free flat-rate plan supports (ADR 0003) and which honors each object's `Cache-Control` within its TTLs:

| Files | `Cache-Control` | Effect |
| --- | --- | --- |
| `assets/` (content-hashed names) | `public, max-age=31536000, immutable` | Browsers and CloudFront keep them a year; a changed asset gets a new name |
| Every other file | `no-cache` | Browsers revalidate on each use; CloudFront keeps the file for the policy's 1-second minimum TTL, which takes precedence over `no-cache` |

Content types come from a fixed table in `scripts/release-lib.ts`; a file with another extension fails the publish rather than going out with a guessed type.

**Release records.** `_releases/` holds the copies and the history. The bucket policy denies CloudFront `s3:GetObject` there (`infra/lib/site-stack.ts`), so the records are not part of the site: a request for one gets S3's 403, which the distribution leaves unmapped (ADR 0003). The deploy role reads and writes them. Bucket versioning keeps each overwritten version of the history for 90 days.

**One publication at a time.** The deploy workflow and the Restore workflow share the concurrency group `deploy-refs/heads/main`; concurrency groups span a repository's workflows, and `tests/repo-policy.test.ts` keeps the repository's other workflows and jobs out of it. One run publishes at a time, neither workflow cancels a run in progress, and at most one waits: a newer run replaces a waiting one, which then shows as cancelled. A pull request's own workflow files could still join the group (ADR 0005, "Limits"). No one else writes the site's objects: infrastructure changes go through ADR 0004's runbook, and releases only through these workflows.

**Smoke test.** After every publish or restore, `node scripts/smoke.ts <dir>` checks what viewers get, from the GitHub runner and through CloudFront, against the release's own files in `<dir>`. The custom hostnames are reached as `curl --connect-to` reaches them: the connection goes to the distribution while TLS (server name and certificate check) and the `Host` header use the custom name, so they are tested before DNS points at CloudFront (milestone 8). Each request opens its own connection and checks the certificate whatever the environment says. It checks that:

- the CloudFront hostname, and `zachdavids.com` through it, serve the home page over HTTPS;
- the home page is prerendered (a title, markup inside its root element, text ending a heading, no prerender marker; no stricter than what `check:dist` requires of every build) and names its release;
- every file of the release is served with its exact bytes, content type, and `Cache-Control`, and every root-relative reference in every page loads;
- `http://` redirects to `https://` with a 301 for both hostnames, and `www` redirects to the apex with a 301 that keeps the path and query (one parameter, since CloudFront can reorder different ones; ADR 0003, "Limits");
- a missing page gets the 404 page with status 404, and a missing asset gets 404;
- a release record gets S3's 403, not the 404 page, so a genuine access failure stays visible;
- the bucket's own endpoint refuses unauthenticated requests with 403.

A failed check fails the job. The release then stays unverified, and the Restore workflow refuses to restore it.

**Restore.** `.github/workflows/restore.yml` runs by hand on `main`. Its one input is the full commit SHA of a verified release, which the run summaries of deploys and restores name; an input that is not one fails, listing the verified releases, newest first. The SHA is fixed when the run starts, so a re-run, or a run that waited in the group, restores the same release. A test job first typechecks and tests the commit at `main`'s head, without the role, as the deploy workflow's build job does. Then the restore job, in the `production` environment as the deploy role, runs `node scripts/release.ts restore`, which reads the release's copy and checks every file against the manifest's SHA-256, writes the files to `restored/` for the smoke test, puts back any asset that has gone missing, publishes the pages as a `restore` entry in the history, invalidates, and waits. The smoke test then runs against `restored/`, and the release is recorded as verified again.

After a restore, a push publishes as usual, since its commit is newer than every release published, and so does a re-run of a deploy for a commit newer than the release the restore replaced, such as one the Restore run displaced from the group's queue. A restore that waits behind a deploy replaces what that deploy published.

## Three kinds of rollback

| | What it changes | How | Who |
| --- | --- | --- | --- |
| **Application rollback** (this ADR) | Only the site's objects in S3, and CloudFront's cache | The Restore workflow, or a fix pushed to `main` | Anyone who can run workflows; the deploy role |
| **CloudFormation rollback** | A stack's resources and configuration: the bucket, distribution, function, policies, identity stack | CloudFormation rolls a failed update back by itself. To undo a deployed change, deploy the previous commit's template with ADR 0004's runbook; `cdk rollback` recovers a stack stuck in `UPDATE_ROLLBACK_FAILED`. Every resource is retained (ADR 0003), and no stack holds the site's content, so none of this changes a release. Rolling the site stack back past milestone 6 removes the release-record deny, though: CloudFront then serves the records, and every smoke test fails until it is deployed again | An administrator |
| **DNS rollback** (milestone 8) | The website's records in the hosted zone | The reverse change batch in `infra/dns/` for the website names only, never a whole-zone export, which could erase later email-authentication changes (`infra/dns/README.md`) | An administrator |

Each changes only its own layer: restoring a release changes no stack and no DNS record, rolling back a stack changes no object in the bucket, and a DNS rollback changes neither. Each still relies on the others: releases on the stack's bucket policy and distribution, and the site's hostnames on DNS.

## Verification before the merge (2026-10-15)

- Unit tests cover the release and smoke-test scripts at 100%, among them: the order of every write and the invalidation in a publish and a restore; assets kept, uploaded, or replaced and invalidated, by checksum and headers; a stale, diverged, or replaced release refused before any write; a copy with other files, or a history or manifest that is not what it should be, refused before any write; a re-run of a restore restoring the same release; a damaged copy, a missing file, or a never-verified release not restored; each smoke check failing for the fault it looks for; the home-page check passing the build's real prerendered page.
- `tests/repo-policy.test.ts` pins both jobs that may assume the deploy role (the deploy job and the restore job): their steps in order, their settings (no container, services, matrix, or shell override), their permissions and role inputs, and their shared concurrency group, which no other workflow or job may join. It also pins the Restore workflow's test job, the release scripts' commands, and that those scripts import only Node's built-in modules and the repository's own files, since the role jobs install no packages; and it forbids `NODE_` variables in those jobs.
- `infra/test/site-stack.test.ts` pins the bucket policy's statements, the new deny included.
- A review of the change in five areas, with each finding checked by two independent skeptics, confirmed 21 findings, all addressed here.

## Limits

- No release, smoke test against the live distribution, or restore can run before the merge: the environment and the role's trust admit only `main`. The first release, the smoke tests through CloudFront, and the restore rehearsal follow it, and `docs/progress.md` records them. The rehearsal needs a second release after the first, which any later commit to `main` makes, since every release's pages name their commit.
- The release-record deny must be live before the first release, or its smoke test fails on the 403 check; it is an infrastructure change, deployed with ADR 0004's runbook before the merge.
- Neither publishing nor restoring deletes anything. A file that a later release adds and an earlier one lacks stays at its path after the earlier one is restored: no page links to it, but a direct request still gets it, and the restore invalidates only the restored release's paths.
- The order check and the restore trust the history. A history edited by hand, or replaced by an older version, misleads them. It is written without a conditional write; only the concurrency group keeps two runs from writing it at once.
- A run that stops between publishing the pages and recording the release as published, whether it fails, times out, or is cancelled by another run in its group, leaves the site partly updated, with an unfinished history entry. Running it again publishes the same release again, which the order check allows, since it is the current one.
- An asset name check cannot tell a hash from a word: `assets/hero-backdrop.png` passes. Vite's output names carry a hash (`tests/repo-policy.test.ts` checks its config), and `public/` may not hold an `assets/` directory, so only those reach `assets/`.
- The smoke test runs from one GitHub runner over IPv4, so it sees one edge location. A completed invalidation applies to every edge, but the test does not show it.
- A restore job, like a deploy job, makes GitHub record a deployment to `production` of the workflow's own commit. The release it restored is in the run's summary and the history, not in that record.
- The release scripts run with the deploy role's credentials, from the job's own checkout of the commit, like every other step of those jobs (ADR 0005, "Limits"). The deploy workflow's build job and the Restore workflow's test job test them at that commit first.
- Each release of the placeholder invalidates six paths, and a restore the same; CloudFront's first 1,000 invalidation paths each month are free.
