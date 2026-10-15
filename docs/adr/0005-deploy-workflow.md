# ADR 0005: Deploy workflow

- Status: Accepted (milestone 5). Since milestone 6 its deploy job publishes, smoke-tests, and records each release (ADR 0006).
- Date: 2026-10-14, revised 2026-10-15 for milestone 6

## Decision

**Two workflows.** `ci.yml` runs on every pull request and every push to `main`, with a read-only token and no AWS access. `deploy.yml` runs on pushes to `main` and by hand (`workflow_dispatch`, no inputs), as two jobs:

1. **`build`** (`Build (typecheck, test, build)`) fails unless the run is for `refs/heads/main`. It then runs the checks of CI's web job on the same commit: a clean install with no dependency cache, the typecheck, the tests with the 100% coverage gate, the build, and `check:dist`. Right after `check:dist`, it records a SHA-256 digest over the name and contents of every file in `dist/` and uploads `dist/`, hidden files included, as the artifact `site`. It runs in no environment, so it has no AWS access and no variables.
2. **`deploy`** (`Deploy (publish, smoke-test, and record the release)`) needs `build` and runs in the `production` environment. Its token's scopes are `id-token: write` and, since milestone 6, `contents: read`, for its checkout and the order check. It checks the four variables' formats, checks out its commit for the release scripts and installs Node, and downloads `site`; the download action fails if the archive's digest differs from the one recorded at upload. It then recomputes the file digest, which must equal the build job's. Only after that does it assume the deploy role through OIDC (`aws-actions/configure-aws-credentials`, with `allowed-account-ids`, a session named after the run, 30 minutes long since milestone 6, and `translate-env-variables: false`, so no variable fills an input it leaves out). Read-only, it then checks that the session is the deploy role's in the account, and that the role can list the bucket, read the distribution, and list its invalidations. The distribution's only origin must be that bucket's REST endpoint. Then it publishes the release, smoke-tests it, and records it as verified (ADR 0006).

**Why the deploy workflow checks the commit itself.** GitHub starts both workflows for the same push, and neither waits for the other. `workflow_run`, the trigger that would chain them, is not one the repository's workflows may use (`tests/repo-policy.test.ts`). The ruleset's required checks are not strict, so a commit made by merging a pull request is first checked by these runs. The deploy workflow therefore checks the exact commit it deploys, and deploys the files that check built rather than a rebuild.

**Only `main` deploys,** checked three ways: the build job stops any other ref; the `production` environment admits only `main` (a custom deployment-branch policy, `main`, with `can_admins_bypass: false`, no required reviewers, and no wait timer); and the role's trust requires `ref` = `refs/heads/main` and the environment's subject (ADR 0004).

**Order.** The workflow's concurrency group is per ref, with `cancel-in-progress: false`. Its runs for `main` go one at a time, and none cancels one in progress. At most one run waits: a newer run replaces it, and the replaced run shows as cancelled. GitHub takes runs in the order they reach the group and does not promise that this is the order of the pushes, so two pushes close together can deploy the older commit last (see "Limits"). A group on the deploy job alone would make that likely, since deploys would follow the order in which builds finish. A manual run of this workflow for another ref has a group of its own, so it cannot replace a waiting run for `main`. Since milestone 6, publishing refuses a release older than the newest one published, and the Restore workflow shares the group (ADR 0006).

**Environment variables.** Set on `production` on 2026-10-14 from the stack outputs, each checked against the live resource: the role exists, the bucket is in us-east-1, and the distribution's only origin is that bucket. GitHub stores variables as plain text, and only jobs in the environment can read them. The deploy job passes them to its scripts as `ACCOUNT_ID`, `ROLE_ARN`, `BUCKET`, and `DISTRIBUTION_ID`, because the AWS CLI reads some `AWS_` variables, such as `AWS_ACCOUNT_ID`, beside the session's credentials.

| Variable | Value | Source |
| --- | --- | --- |
| `AWS_ACCOUNT_ID` | `426499248998` | the Website account (ADR 0002) |
| `AWS_SITE_DEPLOY_ROLE_ARN` | `arn:aws:iam::426499248998:role/zachverse-github-site-deploy` | `ZachverseIdentity` output `SiteDeployRoleArn` |
| `SITE_BUCKET` | `zachversesite-sitebucket397a1860-xlygnlvrlo5t` | `ZachverseSite` output `SiteBucketName` |
| `CLOUDFRONT_DISTRIBUTION_ID` | `E3R8NEUOW8Z97U` | `ZachverseSite` output `DistributionId` |

**Required checks.** Unchanged: the `main protection` ruleset (24904589) requires `Web (typecheck, test, build)` and `Infra (typecheck, template checks)` from GitHub Actions. The deploy workflow's jobs must not be added: they never run on pull requests, so a check required from them would never report and would block every merge. CodeQL's checks stay optional.

**Actions,** pinned to full commit SHAs resolved from each upstream release tag, all signed commits: `actions/upload-artifact` v7.0.2, `actions/download-artifact` v8.0.2, and `aws-actions/configure-aws-credentials` v6.3.0, beside CI's `actions/checkout` and `actions/setup-node`. Dependabot proposes updates weekly.

## Verification before the merge (2026-10-14)

This section records milestone 5's checks of the job as it was then, before milestone 6 added the publishing steps (ADR 0006).

- The environment's settings and variables, read back through GitHub's API.
- The IAM policy simulator, run on the deploy role's identity policies: it allows the seven actions the role grants on the site's bucket and distribution (ADR 0004), and denies 16 others, including the same actions on another bucket or distribution, deleting objects, changing the bucket or distribution, DNS changes, assuming the CDK roles, passing roles, and changing the role's own policy.
- The workflow's scripts, run locally under `bash -eo pipefail` as GitHub runs them:
  - The variables check accepts the live values and rejects 11 malformed ones.
  - The digest check passes an exact copy of a fresh `dist/`, and fails when a file is dropped, changed, or added, including a hidden one.
  - The access check ran read-only against the live bucket and distribution as the administrator, with its caller check pointed at that session's role, and passed. It failed for another expected role or account, a bucket the distribution does not serve, and a missing distribution.
- Static analysis: actionlint 1.7.12 with ShellCheck 0.11.0 reported nothing on either workflow. zizmor 1.30.1 also reported nothing, with its online audits and its `auditor` persona.
- `tests/repo-policy.test.ts` checks this design as `deploy.yml` writes it:
  - the triggers, the two jobs and `needs`, and the concurrency;
  - that the build job runs CI's web checks in order, none with `if` or `continue-on-error`, and records the digest and uploads the whole of `dist/` right after `check:dist`;
  - that the deploy job runs only its five steps, in order: the variables check, the download, the digest check (with the build job's command), the role, and the access check;
  - the role inputs, and the four variables, however `vars` is written;
  - that no step of the deploy job sets a variable the AWS CLI, its SDKs, or the credentials action read: no `AWS_` or proxy name, `$GITHUB_ENV` or `$GITHUB_PATH` write, or `aws configure`;
  - that no other job, in this or another workflow, may request an OIDC token or read variables.

  The suite's rules for every workflow apply to `deploy.yml`: pinned actions, the token's scopes, and AWS credentials and variables only in a `production` job of a workflow that runs only on pushes to `main` or by hand. Three are new with this milestone: no `${{ }}` expression inside a `run:` script or `actions/github-script`'s `script`; no checkout input but `persist-credentials: false`, so every checkout is of the run's own commit; and only the step keys these checks model, so a `background`, `wait`, `wait-all`, `cancel`, or `parallel` step fails.
- Mutation testing: 65 changes to the workflows each fail those tests, and two harmless edits pass. Among the changes: a backgrounded digest check, tests started in the background and then cancelled, a step that changes `dist/` after `check:dist`, a second download or a fetched script before the role, a fifth variable read as `VARS.NAME` or `vars['NAME']`, all of them read as `toJSON(vars)`, an endpoint written to `$GITHUB_ENV`, a checkout of another ref, and a second workflow with a `production` job.

## Limits

- Nothing before the merge runs the deploy job: the environment and the role's trust admit only `main`. Its first run, for the merge commit `388d16a` on 2026-10-15 (run 38672380380), was the first GitHub job to assume the role (ADR 0004): the build, the digest check, the role, and the access check all passed, and it published nothing.
- An older commit could deploy after a newer one: a re-run deploys its run's commit again, even after newer commits have deployed, and two pushes close together can reach the concurrency group out of order. Since milestone 6, publishing refuses a release older than the newest one published, failing the job visibly before it changes anything, and going back is the Restore workflow's job (ADR 0006). A run that reaches the group late can still replace a newer commit's waiting run, which then shows as cancelled, so the site can stay on the older commit until that run is re-run (it is newer, so it publishes) or the next push.
- GitHub records a deployment to `production` for each deploy job that runs. The ones before milestone 6, such as 388d16a's, published nothing; since then each records a release, and a restore job records one too (ADR 0006, "Limits").
- Concurrency groups are shared by every workflow in the repository, and a pull request's run uses the pull request's own workflow files. One that names `deploy-refs/heads/main` can replace a waiting deploy or, with `cancel-in-progress: true`, cancel a running one, though it gets no AWS access. Before approving a run from a fork, check its workflow changes for `concurrency`.
- Anyone with admin access to the repository can change the environment's variables or its deployment-branch policy without review. The workflow checks the variables' formats, that they agree with each other and with the role's session, and that the role can read the bucket and distribution they name; a wrong set that agrees with itself, and whose role can read what it names, gets past it. The role's trust and permissions (ADR 0004) bound what a wrong value can reach.
- Every step of the deploy job can request its OIDC token, and the credentials action and the AWS CLI still read some settings from the environment: the action's proxy falls back to `HTTP_PROXY`, and the AWS CLI and SDKs take endpoints from `AWS_ENDPOINT_URL_STS`, `AWS_ENDPOINT_URL`, and `~/.aws/config`. Each step of the job is therefore trusted with the role.
- The tests read the workflows' YAML, not what their steps do. They miss a command added inside an existing script, a variable an action exports, and an action other than `actions/github-script` that runs an input as code, so every workflow change needs review.
- The access check calls only `s3:ListBucket`, `cloudfront:GetDistribution`, and `cloudfront:ListInvalidations`. The role's other four actions, `s3:GetObject`, `s3:PutObject`, `cloudfront:CreateInvalidation`, and `cloudfront:GetInvalidation`, are first used by publishing (ADR 0006).
- The digest covers file names and contents, not file modes or empty directories, which S3 does not keep.
