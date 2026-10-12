# ADR 0004: GitHub deploy identity and CDK bootstrap

- Status: Accepted and deployed 2026-10-12 (UTC)
- Date: 2026-10-11

## Decision

**Identity stack.** `ZachverseIdentity` (Website account `426499248998`, us-east-1) has termination protection, and every resource is retained. It contains two resources:

- **GitHub OIDC provider** (`AWS::IAM::OIDCProvider`): URL `https://token.actions.githubusercontent.com`, client ID `sts.amazonaws.com`, and no thumbprints in the template, which matches AWS's current GitHub instructions. IAM checks GitHub's endpoint against its own trusted CAs. The live provider shows one thumbprint that IAM filled in itself, and drift detection reports it in sync. The account had no OIDC providers before (`ListOpenIDConnectProviders` returned an empty list), so the stack creates one rather than importing.
- **Deploy role `zachverse-github-site-deploy`:** allows only `sts:AssumeRoleWithWebIdentity`, with `StringEquals` on three claims:
  - `aud` = `sts.amazonaws.com`
  - `sub` = `repo:zachdavids@43345768/zachverse@1414719760:environment:production`
  - `ref` = `refs/heads/main`

  It has a one-hour session limit and no permissions of its own.

**Subject format.** `GET repos/zachdavids/zachverse/actions/oidc/customization/sub` returned `use_immutable_subject: true` with prefix `repo:zachdavids@43345768/zachverse@1414719760` (owner ID 43345768, repository ID 1414719760). Appending GitHub's documented environment form, `:environment:<name>`, gives the subject above. A trust policy written for the old `repo:zachdavids/zachverse:…` format would never match.

**Why a separate `ref` check.** An environment subject names no branch. AWS's IAM guidance, and the Access Analyzer warning `SPECIFIC_GITHUB_REPO_AND_BRANCH_RECOMMENDED` on the first deployment, call for checking the branch with the `ref` key. With it, AWS itself requires `main`, independent of GitHub's environment settings.

**GitHub environment.** `production` was created on 2026-10-11 with a custom deployment-branch policy (`main`, type branch), `can_admins_bypass: false`, and no required reviewers.

**Deploy permissions.** These live in `ZachverseSite` as `SiteDeployPolicy`, attached to the role by name:

| Actions | Resource |
| --- | --- |
| `s3:ListBucket` | the site bucket |
| `s3:GetObject`, `s3:PutObject` | objects in the site bucket |
| `cloudfront:CreateInvalidation`, `GetInvalidation`, `ListInvalidations`, `GetDistribution` | the site distribution |

There is no delete, IAM, DNS, CloudFormation, or STS access. The bucket and distribution don't exist until milestone 4, so the policy is created in the same deployment as they are. Until then the role can authenticate but do nothing, and no interim wildcard grant exists. The site stack declares a dependency on the identity stack.

**Admin vs. deploy access.** Infrastructure changes use the administrator's temporary session in the Website account (`aws login`, `AccountFullAccessRole`) and the CDK bootstrap roles. Those roles trust only the account (no trusted external accounts), and the deploy role has no `sts:AssumeRole` permission to reach them. Management-account credentials were used only for the organization-policy change (ADR 0002).

**CDK bootstrap.** Run `npm run bootstrap` in `infra/`, which runs `cdk bootstrap aws://426499248998/us-east-1 --termination-protection`. It uses the default template (qualifier `hnb659fds`), whose CloudFormation execution role has `AdministratorAccess`; only administrator deployments use it.

## Deployed state (verified 2026-10-12)

| Item | Live value |
| --- | --- |
| `CDKToolkit` (us-east-1) | `CREATE_COMPLETE`, termination protection on, bootstrap version 32. Contains the staging bucket `cdk-hnb659fds-assets-426499248998-us-east-1`, the container repository, five `cdk-hnb659fds-*` roles, and the version parameter |
| `ZachverseIdentity` | `UPDATE_COMPLETE`, termination protection on, drift `IN_SYNC` |
| GitHub provider | the only OIDC provider in the account; client ID `sts.amazonaws.com` |
| Deploy role | trust policy exactly as above; no attached or inline policies |
| Access Analyzer `ValidatePolicy` (trust policy) | no warnings. One suggestion, `CONFIRM_AUDIENCE_CLAIM_TYPE`, which warns against qualifiers on `aud`; none are used |
| us-east-2 | no stacks |
| Hosted zone | the 8 original records, unchanged |

## Runbook

1. `aws login --profile default`, then `aws sts get-caller-identity`: the account must be `426499248998`.
2. `cd infra && npm run bootstrap` (once per account and Region).
3. `npx cdk diff ZachverseIdentity`, review, then `npx cdk deploy ZachverseIdentity`.
4. Verify the live state as in the table above.

## Checks and limits

`infra/test` asserts the following, and `checks.test.ts` shows each check failing on deliberately broad input:

- The exact provider configuration and trust policy.
- That every role trusting GitHub uses `StringEquals` on the STS audience, this exact subject, and `refs/heads/main` (so no wildcard, old-format, branch-only, missing-ref, or non-main subjects).
- That, across all stacks, the deploy role's permissions are a subset of the actions above with no wildcard resources or managed policies.

An actual GitHub job assuming the role is only verifiable once the deploy workflow exists (milestone 5).
