# ADR 0002: Region, certificate, and organization-policy constraints

- Status: Accepted. On 2026-10-11 deployment was blocked by SCP `p-ie47xwqg` (see "Blocker"); the SCP change applied on 2026-10-12 is recorded in milestone 3 (PR #3)
- Date: 2026-10-11 (revised that day after AWS advanced features were activated); revised 2026-10-12 after review

## Decision

1. All regional Zachverse infrastructure lives in **us-east-1** in the Website account `426499248998`, which owns hosted zone `Z03492543O0YEY0RDZZ0J`. That covers the CDK bootstrap, every stack, the S3 bucket, the ACM certificate, and the CLOUDFRONT-scope WAF ACL. CloudFront, Route 53, and IAM are global. Nothing is deployed to us-east-2 (the project's originally selected Region), or to the Management (`969788248923`) or Identity Delegated Admin accounts.
2. The certificate is still requested outside CloudFormation and validated by a reviewed change batch in `infra/dns/`. CloudFormation-managed DNS validation would write records using the CDK execution role's full permissions, and the records would belong to a stack. Out-of-band validation limits DNS writes to the exact validation names and keeps the zone independent of the stacks.
3. The web ACL can become a CloudFormation resource. That is decided in milestone 7.

## Evidence

All checks were run on 2026-10-11, after activation, as `AccountFullAccessRole` in `426499248998`. The organization is `o-zo739dr2bx`, with management account `969788248923`. The Website account cannot read SCP contents (`organizations:DescribePolicy` is denied).

| Check | us-east-1 result |
| --- | --- |
| Real calls: `cloudformation:ListStacks`, `ssm:GetParameter`, `ecr:DescribeRepositories`, `pricingplanmanager:ListSubscriptions` (the last one is global, so it is denied from any Region) | explicit deny, SCP `p-ie47xwqg` |
| Real call: `iam:ListOpenIDConnectProviders` | allowed (the earlier `iam:*Provider*` deny is gone) |
| `iam:SimulatePrincipalPolicy`, `aws:RequestedRegion=us-east-1`, Organizations decision | **denied:** CloudFormation (CreateStack, Create/ExecuteChangeSet, DescribeStacks, UpdateTerminationProtection), S3 (CreateBucket, PutBucketPolicy, PutBucketVersioning, PutObject), SSM (Get/PutParameter), ECR (CreateRepository, SetRepositoryPolicy), Pricing Plan Manager (Create/ListSubscriptions). **allowed:** IAM (CreateRole, PutRolePolicy, PassRole, CreateOpenIDConnectProvider), ACM, WAF, CloudFront, KMS, STS |

These results match the `UsEast1Partitional` statement that AWS [publishes](https://docs.aws.amazon.com/accounts/latest/reference/scps-and-rcps-for-projects.html) for projects with advanced features. That statement is a `Deny` on `NotAction` (a list of global services), with `StringEquals aws:RequestedRegion = us-east-1`. The list excludes `cloudformation`, most of `s3`, `ssm`, `ecr`, and `pricingplanmanager`.

## Blocker and proposed adjustment (as of 2026-10-11)

The SCP change applied on 2026-10-12 differed from this proposal; milestone 3 (PR #3) records it.

The smallest change that unblocks the decision: add these to the `NotAction` list of `UsEast1Partitional` in `p-ie47xwqg`.

```json
"cloudformation:*", "s3:*", "ssm:*", "ecr:*", "pricingplanmanager:*"
```

- `cloudformation`, `s3`, `ssm`, `ecr`: the CDK bootstrap (staging bucket, version parameter, and the container repository in the default template) and stack deployments. `s3` also covers the site bucket and uploads.
- `pricingplanmanager`: the milestone 7 subscription. This one is needed regardless of where the stacks live.

Every other service stays denied in us-east-1, and the other statements are unchanged. If the policy is attached above the Website account (at the root or an OU), limit the exemption to `426499248998` so the administrative accounts keep the original control. To do that, add `"StringNotEquals": {"aws:PrincipalAccount": "426499248998"}` to the existing statement, and add a copy of the statement with the expanded list conditioned on that account.

Before applying this, read the live policy, its attachment targets, and whether AWS manages it, from the management account.
