# ADR 0002: Region, certificate, and organization-policy constraints

- Status: Accepted. The SCP blocker was resolved on 2026-10-12 (see "Resolution")
- Date: 2026-10-11 (revised that day after AWS advanced features were activated); revised 2026-10-12 after the SCP change

## Decision

1. All regional Zachverse infrastructure lives in **us-east-1** in the Website account `426499248998`, which owns hosted zone `Z03492543O0YEY0RDZZ0J`. That covers the CDK bootstrap, every stack, the S3 bucket, the ACM certificate, and the CLOUDFRONT-scope WAF ACL. CloudFront, Route 53, and IAM are global. Nothing is deployed to us-east-2 (the project's originally selected Region), or to the Management (`969788248923`) or Identity Delegated Admin accounts.
2. The certificate is still requested outside CloudFormation and validated by a reviewed change batch in `infra/dns/`. CloudFormation-managed DNS validation would write records using the CDK execution role's full permissions, and the records would belong to a stack. Out-of-band validation limits DNS writes to the exact validation names and keeps the zone independent of the stacks.
3. Now that CloudFormation is allowed in us-east-1, the web ACL can be a CloudFormation resource. That is decided in milestone 7.

## Evidence

All checks were run on 2026-10-11, after activation, as `AccountFullAccessRole` in `426499248998`. The organization is `o-zo739dr2bx`, with management account `969788248923`. The Website account cannot read SCP contents (`organizations:DescribePolicy` is denied).

| Check | us-east-1 result |
| --- | --- |
| Real calls: `cloudformation:ListStacks`, `ssm:GetParameter`, `ecr:DescribeRepositories`, `pricingplanmanager:ListSubscriptions` (the last one is global, so it is denied from any Region) | explicit deny, SCP `p-ie47xwqg` |
| Real call: `iam:ListOpenIDConnectProviders` | allowed (the earlier `iam:*Provider*` deny is gone) |
| `iam:SimulatePrincipalPolicy`, `aws:RequestedRegion=us-east-1`, Organizations decision | **denied:** CloudFormation (CreateStack, Create/ExecuteChangeSet, DescribeStacks, UpdateTerminationProtection), S3 (CreateBucket, PutBucketPolicy, PutBucketVersioning, PutObject), SSM (Get/PutParameter), ECR (CreateRepository, SetRepositoryPolicy), Pricing Plan Manager (Create/ListSubscriptions). **allowed:** IAM (CreateRole, PutRolePolicy, PassRole, CreateOpenIDConnectProvider), ACM, WAF, CloudFront, KMS, STS |

These results match the `UsEast1Partitional` statement that AWS [publishes](https://docs.aws.amazon.com/accounts/latest/reference/scps-and-rcps-for-projects.html) for projects with advanced features. That statement is a `Deny` on `NotAction` (a list of global services), with `StringEquals aws:RequestedRegion = us-east-1`. The list excludes `cloudformation`, most of `s3`, `ssm`, `ecr`, and `pricingplanmanager`.

## Resolution (applied 2026-10-12)

The live policy, read from the management account, confirmed the cause. `p-ie47xwqg` (`AdvancedModeRegionRestrictionSecurityControlPolicy`) is customer-managed and attached at the root `r-58a9`. Its `UsEast1Partitional` statement omits `cloudformation`, `ssm`, `ecr`, and `pricingplanmanager`, and allows only 17 account-level `s3` actions. The policy was 5,104 of the allowed 5,120 characters, so it couldn't simply grow. Because it is attached at the root, editing its list in place would also have loosened the Identity Delegated Admin account.

With approval, the change was scoped to the Website account:

1. `RegionFloor` moved verbatim into a new root SCP, `ZachverseRegionFloor` (`p-xwdm4cce`).
2. A new SCP attached only to `426499248998`, `ZachverseWebsiteUsEast1` (`p-1mpgzmjr`). It holds the same us-east-1 deny, with the `s3` entries replaced by `s3:*` and `cloudformation:*`, `ecr:*`, `pricingplanmanager:*`, and `ssm:*` added.
3. `UsEast1Partitional` gained `StringNotEquals aws:PrincipalAccount = 426499248998`.

Before applying, a local evaluation (`docs/org-policy/compare.cjs`) showed 6 changed decisions, all for the Website account in us-east-1, and 0 for the Identity account. Afterwards, from the Website account:

- Real us-east-1 calls to CloudFormation, ECR, S3, and Pricing Plan Manager succeeded.
- The simulator allows the needed actions. Lambda, EC2, DynamoDB, and SQS are still explicitly denied in us-east-1.

Backup, exact apply commands, and rollback commands are in `docs/org-policy/`.
