# ADR 0006: Releases, smoke tests, and rollback

- Status: Accepted (milestone 6). The workflows publish only on `main`, so the first release follows the merge.
- Date: 2026-10-15

## Decision

**A release** is the build of one commit on `main`: the files the deploy workflow's build job checked and uploaded (ADR 0005). It is named by its full commit SHA, and its pages name it too: the build sets `RELEASE_COMMIT`, so `index.html` and `404.html` carry `<meta name="zachverse-release" content="<commit>" />`, which `check:dist` requires. Every release's pages therefore differ from every other's, and the page served shows which release is live.

**Publishing.** After the access check, the deploy job runs `node scripts/release.ts publish site`, which:

1. **Checks the order.** It reads the release history and, through GitHub's compare API with the job's read-only token, refuses a commit older than the newest one published, or on another line of history. Publishing the current release again is a retry and goes ahead; publishing a release that a restore has since replaced is refused, so a re-run cannot undo a restore. A refusal fails the job, visibly, before anything changes (ADR 0005, "Limits", asked for that).
2. **Uploads the assets.** Every file under `assets/` has a content hash in its name (the script refuses one without), so it is uploaded only if no object with the same SHA-256, content type, and `Cache-Control` is there already. Each upload carries a SHA-256 checksum, which S3 checks before it accepts the object.
3. **Saves a copy.** Every file of the release goes under `_releases/<commit>/site/`, then its manifest (each file's path, SHA-256, size, content type, and `Cache-Control`) as `_releases/<commit>/manifest.json`, written last so a manifest means a complete copy. A copy that already exists must match the build, so a rebuild with other files fails rather than replacing it.
4. **Records the release as started** in `_releases/history.json`: the action, the commit, the run (`<run ID>-<attempt>`), and the time.
5. **Publishes the pages**, every file outside `assets/`: other files first, then HTML, then each `index.html`, so whatever a page refers to is there before it.
6. **Invalidates** each page's path and, for an `index.html`, the directory paths viewers request it by (`/`, and `/about/` and `/about` for `about/index.html`), since the viewer-request function serves those; AWS recommends invalidating both the requested and the rewritten path. Assets need none: a new release names its own. It waits for the invalidation to complete (the AWS CLI gives up after 10 minutes).
7. **Records the release as published.** Then the smoke test runs, and `node scripts/release.ts verified` records when it passed.

**Nothing is deleted.** The deploy role cannot delete objects (ADR 0004), and no step tries. Every release's assets stay where they are, so a page an earlier release left in a browser's cache, or a restored release, still finds its files.

**Caching**, with the distribution's AWS-managed `CachingOptimized` policy, which the Free flat-rate plan supports (ADR 0003) and which honors each object's `Cache-Control` within its TTLs:

| Files | `Cache-Control` | Effect |
| --- | --- | --- |
| `assets/` (content-hashed names) | `public, max-age=31536000, immutable` | Browsers and CloudFront keep them a year; a changed asset gets a new name |
| Every other file | `no-cache` | Browsers revalidate on each use; CloudFront keeps the file for the policy's 1-second minimum TTL, which takes precedence over `no-cache` |

Content types come from a fixed table in `scripts/release-lib.ts`; a file with another extension fails the publish rather than going out with a guessed type.

**Release records.** `_releases/` holds the copies and the history. The bucket policy denies CloudFront `s3:GetObject` there (`infra/lib/site-stack.ts`), so the records are not part of the site: a request for one gets S3's 403, which the distribution leaves unmapped (ADR 0003). The deploy role reads and writes them. Bucket versioning keeps each overwritten version of the history for 90 days.

**One publication at a time.** The deploy workflow and the Restore workflow share the concurrency group `deploy-refs/heads/main`; concurrency groups span a repository's workflows. One run publishes at a time, none is cancelled while it runs, and at most one waits: a newer run replaces a waiting one, which then shows as cancelled. No one else writes the site's objects: infrastructure changes go through ADR 0004's runbook, and releases only through these workflows.

**Smoke test.** After every publish or restore, `node scripts/smoke.ts <dir>` checks what viewers get, from the GitHub runner and through CloudFront, against the release's own files in `<dir>`. The custom hostnames are reached as `curl --connect-to` reaches them: the connection goes to the distribution while TLS (server name and certificate check) and the `Host` header use the custom name, so they are tested before DNS points at CloudFront (milestone 8). It checks that:

- the CloudFront hostname, and `zachdavids.com` through it, serve the home page over HTTPS;
- the home page is prerendered (a title, the page's markup, a heading) and names its release;
- every file of the release is served with its exact bytes, content type, and `Cache-Control`, and every root-relative reference in every page loads;
- `http://` redirects to `https://` with a 301 for both hostnames, and `www` redirects to the apex with a 301 that keeps the path and query (one parameter, since CloudFront can reorder different ones; ADR 0003, "Limits");
- a missing page gets the 404 page with status 404, and a missing asset gets 404;
- a release record gets S3's 403, not the 404 page, so a genuine access failure stays visible;
- the bucket's own endpoint refuses unauthenticated requests with 403.

A failed check fails the job. The release then stays unverified, and the Restore workflow refuses to restore it.

**Restore.** `.github/workflows/restore.yml` runs by hand on `main`, in the `production` environment, as the deploy role. Its input names a verified release by commit SHA, or `previous`: the most recent verified release other than the current one. `node scripts/release.ts restore` reads that release's copy and checks every file against the manifest's SHA-256, writes the files to `restored/` for the smoke test, puts back any asset that has gone missing, publishes the pages as a `restore` entry in the history, invalidates, and waits. The smoke test then runs against `restored/`, and the release is recorded as verified again. After a restore, the next push publishes as usual, since it is newer than the restored release.

## Three kinds of rollback

| | What it changes | How | Who |
| --- | --- | --- | --- |
| **Application rollback** (this ADR) | Only the site's objects in S3, and CloudFront's cache | The Restore workflow, or a fix pushed to `main` | Anyone who can run workflows; the deploy role |
| **CloudFormation rollback** | A stack's resources and configuration: the bucket, distribution, function, policies, identity stack | CloudFormation rolls a failed update back by itself. To undo a deployed change, deploy the previous commit's template with ADR 0004's runbook; `cdk rollback` recovers a stack stuck in `UPDATE_ROLLBACK_FAILED`. Every resource is retained (ADR 0003), and no stack holds the site's content, so none of this touches a release | An administrator |
| **DNS rollback** (milestone 8) | The website's records in the hosted zone | The reverse change batch in `infra/dns/` for the website names only, never a whole-zone export, which could erase later email-authentication changes (`infra/dns/README.md`) | An administrator |

None of them reaches the others: restoring a release changes no stack and no DNS record, rolling back a stack changes no object in the bucket, and a DNS rollback changes neither.

## Verification before the merge (2026-10-15)

- Unit tests cover the release and smoke-test scripts at 100%, among them: the order of every write and the invalidation in a publish and a restore; assets kept or replaced by checksum and headers; a stale, diverged, or replaced release refused before any write; a copy with other files refused; a damaged copy, a missing file, or a never-verified release not restored; a history or manifest that is not what it should be refused before any write; each smoke check failing for the fault it looks for.
- `tests/repo-policy.test.ts` pins both jobs that may assume the deploy role (the deploy job and the restore job), their steps in order, their permissions and role inputs, their shared concurrency group, the release scripts' commands, and that those scripts import only Node's built-in modules and the repository's own files, since the jobs install no packages.
- `infra/test/site-stack.test.ts` pins the bucket policy's statements, the new deny included.

## Limits

- No release, smoke test against the live distribution, or restore can run before the merge: the environment and the role's trust admit only `main`. The first release, the smoke tests through CloudFront, and the restore rehearsal follow it, and `docs/progress.md` records them. The rehearsal needs a second release after the first, which any later commit to `main` makes, since every release's pages name their commit.
- Neither publishing nor restoring deletes anything. A file that a later release adds and an earlier one lacks stays at its path after the earlier one is restored: no page links to it, but a direct request still gets it, and the restore invalidates only the restored release's paths.
- The order check and the restore trust the history. A history edited by hand, or replaced by an older version, misleads them. It is written without a conditional write; only the concurrency group keeps two runs from writing it at once.
- A run that stops between publishing the pages and recording the release as published leaves the site partly updated, with an unfinished history entry. Running it again publishes the same release again, which the order check allows, since it is the current one.
- The smoke test runs from one GitHub runner over IPv4, so it sees one edge location. A completed invalidation applies to every edge, but the test does not show it.
- A restore job, like a deploy job, makes GitHub record a deployment to `production` of the workflow's own commit. The release it restored is in the run's summary and the history, not in that record.
- The release scripts run with the deploy role's credentials, from the job's own checkout of the commit, like every other step of those jobs (ADR 0005, "Limits"); the build job's tests cover them.
- Each release of the placeholder invalidates six paths, and a restore the same; CloudFront's first 1,000 invalidation paths each month are free.
