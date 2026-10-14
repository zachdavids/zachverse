# ADR 0004: GitHub deploy identity and CDK bootstrap

- Status: Accepted and deployed 2026-10-12 (UTC)
- Date: 2026-10-11, revised 2026-10-12 after the deploy and 2026-10-13 after review and for the site stack's first deployment

## Decision

**Identity stack.** `ZachverseIdentity` (Website account `426499248998`, us-east-1) has termination protection. It contains two resources, both retained, besides the `AWS::CDK::Metadata` record that version reporting adds (ADR 0003, "Retention"):

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

There is no delete, IAM, DNS, CloudFormation, or STS access. The bucket and distribution don't exist until milestone 4, so the policy is created in the same deployment as they are. Until then the role can authenticate but do nothing, and no interim wildcard grant exists. The site stack declares a dependency on the identity stack. Like every resource the site stack defines, `SiteDeployPolicy` is retained (ADR 0003, "Retention"), so removing it from the template or deleting the stack leaves its grant on the role. To revoke access, change its statements while it is still in the template, or delete it from the role with `aws iam delete-role-policy`. The identity stack retains its provider and role the same way, so removing them from the template leaves GitHub able to assume the role; revoking that means deleting the role, an administrative step.

**Admin vs. deploy access.** Infrastructure changes use the administrator's temporary session in the Website account (`aws login`, `AccountFullAccessRole`) and the CDK bootstrap roles. Those roles trust only the account (no trusted external accounts), and the deploy role has no `sts:AssumeRole` permission to reach them. Apart from activating advanced features and setting the payer-wide budget (ADR 0002, "Account and billing"), management-account credentials changed only the organization policies (ADR 0002, "Resolution").

**CDK bootstrap.** Run `npm run bootstrap` in `infra/`, which runs `cdk bootstrap aws://426499248998/us-east-1 --termination-protection`. It uses the default template (qualifier `hnb659fds`), whose CloudFormation execution role has `AdministratorAccess`; only administrator deployments use it.

## Administrative access

- Root users are for break-glass use only.
- Management-account CLI sessions are never root: they are the AWS Settings role session (`aws login --profile zachverse-management`, choosing that role), logged out after use with `aws logout --profile zachverse-management`. In the `docs/org-policy/` runbook, the Apply and Rollback scripts log a root session out and stop, and Verify and Rollback end by logging out.
- The identity source stays AWS Builder ID.
- No recovery path may depend on mail delivered through the `zachdavids.com` zone. The zone is in the Website account, so the account or DNS trouble that calls for recovery could also stop that mail (ADR 0002, "Account and billing").

## Deployed state (verified 2026-10-12)

| Item | Live value |
| --- | --- |
| `CDKToolkit` (us-east-1) | `CREATE_COMPLETE`, termination protection on, bootstrap version 32. Contains the staging bucket `cdk-hnb659fds-assets-426499248998-us-east-1`, the container repository, five `cdk-hnb659fds-*` roles, and the version parameter |
| `ZachverseIdentity` | `UPDATE_COMPLETE`, termination protection on, drift `IN_SYNC` |
| GitHub provider | the only OIDC provider in the account; client ID `sts.amazonaws.com` |
| Deploy role | trust policy exactly as above; no attached or inline policies |
| Access Analyzer `ValidatePolicy` (trust policy) | no warnings. One suggestion, `CONFIRM_AUDIENCE_CLAIM_TYPE`, which warns against qualifiers on `aud`; none are used |
| us-east-2 | no stacks |
| Hosted zone | the 8 original records, unchanged. On 2026-10-13 the site certificate's two validation CNAMEs were added (ADR 0002) |

## Runbook

Run the CDK CLI in `infra/` through npm (`npm run cdk -- <command>`), which uses the pinned CLI. Before it synthesizes, the CLI runs `cdk.json`'s `build` step, which typechecks and runs the tests, so a failing test stops the synth, diff, or deploy. The guardrails, GitHub trust and deploy permissions included, also run inside every synthesis and fail it (ADR 0003, "Template checks"), so `--build ''` skips only the typecheck and the tests; it is not for routine use. The app always synthesizes both stacks. Deploy only reviewed commits: changed code, or an assembly synthesized earlier and passed with `--app`, gets past the guardrails (ADR 0003, "Limits").

1. `aws login --profile default`, then `aws sts get-caller-identity`: the account must be `426499248998`.
2. Check that `env | grep '^CDK'` (Git Bash) or `Get-ChildItem Env:CDK*` (PowerShell) prints nothing, or only `CDK_DISABLE_*` opt-outs such as `CDK_DISABLE_CLI_TELEMETRY`, and that the CLI's user settings file, `~/.cdk.json` (`$env:USERPROFILE\.cdk.json` in PowerShell), does not exist. Pass none of `--app` (`-a`), `--build`, `--ignore-errors`, `--no-version-reporting` (or its alias `--no-telemetry`), or `--plugin` (`-p`). The CLI reads every option from any environment variable whose name starts with `CDK`, with or without an underscore, so `CDK_APP` (or `CDKAPP`), `CDK_BUILD`, `CDK_IGNORE_ERRORS`, `CDK_VERSION_REPORTING=false` (or `CDKTELEMETRY=false`), and `CDK_PLUGIN` act like those options. It also merges `~/.cdk.json` under `cdk.json`, so that file can set whatever `cdk.json` leaves open, such as context or the AWS profile; `cdk.json` keeps version reporting on and loads no plugins, which that file cannot change but the command line and `CDK` variables can. `--plugin` loads code into the CLI, and `--no-version-reporting` would delete the identity stack's `AWS::CDK::Metadata` resource, against ADR 0003's decision to keep version reporting on ("Retention"), in a change `cdk diff` hides.
3. `cd infra && npm run bootstrap` (once per account and Region).
4. `npm run cdk -- diff`, review, then `npm run cdk -- deploy ZachverseIdentity --require-approval never`.
5. Verify the live state as in the table above.

Deploys pass `--require-approval never` once the diff, whose IAM statement changes are what the CLI would otherwise ask about, has been reviewed. Without a terminal the CLI cannot ask, and for a new stack it has by then created the stack and turned termination protection on (ADR 0003, "Termination protection").

The site stack's first deployment (milestone 4) follows steps 1 and 2, then steps 6 to 8; steps 6 and 7 were done on 2026-10-13:

6. Apply `infra/dns/2026-10-13-acm-validation.json`, an administrative step that follows `infra/dns/README.md`, within 72 hours of the certificate's request, after which ACM stops trying to validate it (ADR 0002). Done on 2026-10-13, after two read-only reviews checked the batch against ACM's records and the live zone: Route 53 change `C0538187366HON9LAQEWB`, and the zone exports before and after differed only by the two validation CNAMEs.
7. Wait until `aws acm describe-certificate --region us-east-1 --certificate-arn <certificateArn> --query Certificate.Status`, with the ARN from `infra/lib/config.ts`, returns `ISSUED`. CloudFront rejects a certificate still pending validation, and a failed first create leaves a termination-protected stack to retry as ADR 0003 describes ("Termination protection"). ACM issued the certificate at 17:52 UTC on 2026-10-13.
8. `npm run cdk -- diff --method template`, review, then `npm run cdk -- deploy ZachverseSite --require-approval never`. For a stack that does not exist yet, the default diff creates and deletes a temporary one to compute a change set; `--method template` only reads. Deploying `ZachverseSite` also deploys `ZachverseIdentity`, which it depends on, unless `--exclusively` is passed. The identity template is unchanged, so expect no change there unless the CDK or Node.js version differs from the one that deployed it, which changes only its `AWS::CDK::Metadata` resource (`cdk diff` leaves that resource out).

## Checks and limits

`infra/test` asserts the exact provider configuration and trust policy, and pins the identity stack's logical IDs and create-only properties (the provider's URL, and the role's name with no path). Two guardrails also run in every synthesis and in every configuration ADR 0003 lists, and `checks.test.ts` shows each failing on deliberately broad input:

- **GitHub trust**, on every stack: every statement that trusts GitHub's OIDC provider must allow only `sts:AssumeRoleWithWebIdentity`, with only `StringEquals` on the STS audience, this exact subject, and `refs/heads/main`.
- **Deploy permissions**, across all stacks: the role `zachverse-github-site-deploy` may be granted only the actions above, on literal ARNs without wildcards or on a bucket the stack defines, objects in it, or a distribution it defines, and never through a managed policy attached by ARN.

Like the DNS check (ADR 0003), both fail closed on values CloudFormation computes: where a rule depends on a value, an intrinsic function they do not recognize or a `{{resolve:...}}` dynamic reference is a violation. `infra/lib/guardrails/checks.ts` has the complete rules.

Limits:

- The deploy-role check covers only `zachverse-github-site-deploy`. Another role may trust GitHub under the same conditions, and only the DNS check limits what it is granted.
- The deploy-role check reads identity-based policies only, so a bucket policy or other resource policy that names the role is not checked.
- The deploy-role check does not evaluate IAM policy variables: an ARN such as `arn:aws:s3:::${aws:UserAgent}` passes as a literal, though IAM fills it in from each request and the caller sets the user agent.
- A provider ARN built with `Fn::Join` or `Fn::Sub` is flagged rather than read; trust a literal ARN or the provider's `Ref`.
- Failing closed also flags computed principals that cannot be `*`, such as an account root principal built from `AWS::Partition`. `cdk.json` enables `@aws-cdk/core:enablePartitionLiterals`, so CDK writes such principals in these stacks as literal ARNs.
- Neither check models privilege escalation, such as another role changing the deploy role's policies, or a role whose trust names the deploy role, which the deploy role could then assume without any grant of its own.
- An actual GitHub job assuming the role is only verifiable once the deploy workflow exists (milestone 5).
