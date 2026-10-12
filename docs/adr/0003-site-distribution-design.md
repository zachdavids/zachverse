# ADR 0003: Site distribution design

- Status: Accepted (synthesized; not yet deployed)
- Date: 2026-10-11, revised 2026-10-12 after review

## Decision

`ZachverseSite` (us-east-1) contains a private S3 bucket, an origin access control, one CloudFront Function, and one distribution. When `pricingPlan` is configured it also contains a pricing-plan subscription.

- **Bucket:** Block Public Access on, bucket-owner-enforced ownership, SSE-S3, a TLS-only policy, no static website hosting. Versioning is on, and noncurrent versions expire after 90 days, so files overwritten by a release can be recovered. A separate rule aborts multipart uploads still incomplete after 7 days: a cancelled or timed-out deploy job kills the AWS CLI before it can abort its uploads, and S3 bills the parts until they are aborted. That rule deletes no objects.
- **Origin access:** the S3 REST endpoint through OAC (SigV4, always). The bucket policy allows only `s3:GetObject` and `s3:ListBucket` to `cloudfront.amazonaws.com`, conditioned on this distribution's ARN. `ListBucket` makes S3 return 404 rather than 403 for missing keys.
- **Errors:** only 404 is mapped, to `/404.html` with status 404 and a 60-second error cache. 403 is left unmapped so real access failures stay visible.
- **Behavior:** one default behavior with HTTPS redirect, `index.html` as the default root object, and AWS-managed `CachingOptimized` and `SecurityHeadersPolicy`. The redirect is set explicitly; `cdk.json`'s HTTPS-by-default CloudFront flag also makes it CDK's default for any behavior added later. The managed policy's HSTS has no `includeSubDomains`. HTML freshness comes from per-object `Cache-Control` set at upload (milestone 6).
- **Viewer-request function** (`cloudfront-js-2.0`): redirects `www.zachdavids.com` to the apex with a 301, keeping path and query. Directory-style paths map to `index.html`; `/.well-known/` is left alone.
- **Hostnames:** `zachdavids.com` and `www.zachdavids.com`, with the out-of-band certificate (ADR 0002). TLS 1.2_2021, SNI, IPv6, HTTP/2 and HTTP/3. Synthesis fails until `certificateArn` is set in `infra/lib/config.ts`, and on any ARN other than `arn:aws:acm:us-east-1:<configured account>:certificate/<lowercase UUID>`, so a bad paste fails before deployment.
- **Retention:** every resource the stack defines has `DeletionPolicy` `RetainExceptOnCreate` and `UpdateReplacePolicy` `Retain`. Each is kept when the stack is deleted, when it leaves the template, and when it is replaced, and is deleted only if the operation that created it rolls back, so a failed first deploy leaves no orphaned, fixed-name function or OAC to block the retry. Tests pin logical IDs and create-only properties. CDK version reporting stays on (AWS uses it to contact users of CDK releases with serious security or reliability issues): the CLI turns it on, so the template also gets an `AWS::CDK::Metadata` resource, which holds no data and is not retained.
- **Termination protection:** on. The CDK CLI turns it on before the first create runs, and it stops the CLI from deleting a stack whose create failed. To retry a failed first deploy, turn protection off and deploy again; the CLI then deletes the failed stack and turns protection back on.
- **Free flat-rate plan (off by default):** `pricingPlan: { tier: 'FREE', webAclArn }` sets the distribution's `WebACLId` and adds `AWS::PricingPlanManager::Subscription`. That subscription is `CloudFront`/`FREE` over the distribution, the web ACL, and `arn:aws:route53:::hostedzone/Z03492543O0YEY0RDZZ0J`. Paid tiers are not representable in config. Synthesis fails on a `webAclArn` other than a CLOUDFRONT-scope web ACL owned by the configured account, `arn:aws:wafv2:us-east-1:<account>:global/webacl/<name>/<lowercase UUID>`.

## Template checks (`infra/test`)

These checks run on every stack the app synthesizes, including any created inside another stack or a Stage, with the pricing plan both off and on; the guardrail suite (`guardrails.test.ts`) also runs on the production config as set. `infra/test/support/checks.ts` has the complete template rules, summarized below. `infra/test/environment.test.ts` checks that every stack targets account `426499248998` and Region `us-east-1` with termination protection, and pins the site stack's logical IDs and create-only properties.

- **Prohibited resources:** no hosted zones, Route 53 records or domains, Amplify domains or Cloud Map resources (both write DNS themselves), custom resources, Lambda functions, CloudFormation-managed certificates, or StackSets.
- **Nothing hidden from the checks:** no nested stacks, `Transform` or `Fn::Transform`, or resource types outside `AWS::`.
- **No DNS write access:** no IAM permission that can write Route 53 or Route 53 Domains, wildcards included. The check fails closed: a grant it cannot read, such as `NotAction`, a computed action or document, a managed policy or group from outside the stack, or an Identity Center resource, fails too. It can allow CNAME CREATE/UPSERT on the exact ACM validation names in this zone, through the literal `route53:ChangeResourceRecordSets` action, but no stack gets that allowance: validation is out of band (ADR 0002).
- **Retention:** every resource retained (`DeletionPolicy` `Retain` or `RetainExceptOnCreate`, and `UpdateReplacePolicy` `Retain`) except `AWS::CDK::Metadata`.
- **Free-plan compatibility**, per the [flat-rate plan page](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html) (read 2026-10-12): at most 5 cache behaviors and 5 web ACL rules, only AWS-managed cache, origin-request, and response-header policies, and none of the CloudFront or WAF features or associations that the plan does not support, such as logging, Origin Shield, mutual TLS, rule groups, CAPTCHA, or a function or web ACL shared with another distribution.
- **Project rules**, which the plan does not impose: no Lambda@Edge (the plan allows it on every tier but bills it outside the flat rate), and CloudFront Functions on `cloudfront-js-2.0`, defined in the stack so their runtime can be checked.

`infra/test/checks.test.ts` feeds each check deliberately offending stacks and templates to show that it fails. On 2026-10-11 the guardrail suite was also run once against a temporarily mutated `site-stack.ts`. The mutation added auto-emptying of the bucket, removed the bucket's retention, and added an apex `A` record. The suite flagged `Custom::S3AutoDeleteObjects`, its Lambda handler, the `AWS::Route53::RecordSet`, and the non-retained bucket; the mutation was then reverted.

## Limits

Passing these checks says nothing about live resources, IAM in the account, the effect of the managed SCPs, or whether the pricing-plan service accepts the configuration. Milestones 4–7 verify those against the deployed stack. The checks also have limits of their own:

- These are template checks, not access controls. CloudFormation deploys every stack through the CDK execution role, which can write DNS (ADR 0002). CI runs the checks on every pull request and push to `main`, and the CDK CLI runs them before every synth, diff, and deploy (`cdk.json`'s `build`), but a commit that weakens them also passes them, so deploy only reviewed commits.
- The DNS check does not model privilege escalation, such as `iam:PutRolePolicy` or `sts:AssumeRole` into a role that can write DNS.
- Shared functions and web ACLs are found only among the distributions in one template, so milestone 7 must confirm that no other distribution uses the web ACL.
- The viewer-request tests approximate the `cloudfront-js-2.0` runtime on V8, with a reduced set of built-ins and a syntax allowlist, so they cannot catch where the runtime and V8 behave differently (the runtime's regular expressions are PCRE, for example), or anything on a path no test runs. The header comment in `infra/test/viewer-request.test.ts` gives the details.
