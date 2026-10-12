# ADR 0002: Project Region, certificate, and managed-policy constraints

- Status: Accepted (decisions); open blockers listed below
- Date: 2026-10-11

## Context

The AWS project uses the new AWS experience. The account is `426499248998`, and it owns hosted zone `Z03492543O0YEY0RDZZ0J`. The project Region is `us-east-2`, per `~/.aws/config`; confirm it in AWS Settings › View all projects › Overview › Additional info › Region. AWS manages the organization's SCPs ([published policies](https://docs.aws.amazon.com/accounts/latest/reference/scps-and-rcps-for-projects.html), read 2026-10-11).

Read-only calls on 2026-10-11 as `AccountFullAccessRole` returned these explicit SCP denials:

| Call | Region | Denied by |
| --- | --- | --- |
| `cloudformation:ListStacks`, `ssm:GetParameter` | us-east-1 | `p-jx3i24et` (Region policy; us-east-1 allows only global services such as CloudFront, ACM, IAM, Route 53, WAF) |
| `iam:ListOpenIDConnectProviders` | global | `p-ri5x5l1l` (Paid-plan policy, `iam:*Provider*` deny) |
| `pricingplanmanager:ListSubscriptions` | us-east-1 / us-east-2 | `p-ri5x5l1l` / `p-jx3i24et` |

The same calls in us-east-2 succeeded: CloudFormation has no stacks there, and the CDK bootstrap parameter is absent.

## Decision

1. Every stack deploys to `us-east-2`, and CDK is bootstrapped there. This replaces the original plan's us-east-1 bootstrap, which the Region policy blocks.
2. The CloudFront certificate must live in us-east-1, so it is requested with the AWS CLI rather than CloudFormation. It is validated by a reviewed change batch in `infra/dns/` that contains exactly the ACM validation CNAMEs, and its ARN goes in `infra/lib/config.ts`. No stack, custom resource, or deploy role gets Route 53 write access. The site stack refuses to synthesize without an ARN that is in us-east-1 and owned by the project account.
3. A CLOUDFRONT-scope web ACL is also us-east-1-only, so it cannot be a CloudFormation resource here either. The site stack takes its ARN as configuration; how the ACL is created is decided in milestone 7.

## Open blockers

- **Milestone 3, GitHub OIDC:** `iam:*Provider*` is denied, so the project cannot create or reuse the GitHub OIDC provider. The documented policy that applies after activating advanced features has no such deny, but that is unverified until activation, which is the project owner's decision in AWS Settings.
- **Milestone 7, flat-rate plan:** `pricingplanmanager:*` is not allowed by the Paid-plan policy. It is also missing from the documented post-activation us-east-1 allow-list, so `AWS::PricingPlanManager::Subscription` may stay blocked even after activation. Verify this before relying on the Free plan.
