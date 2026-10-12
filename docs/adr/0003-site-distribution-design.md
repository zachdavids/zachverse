# ADR 0003: Site distribution design

- Status: Accepted (synthesized; not yet deployed)
- Date: 2026-10-11

## Decision

`ZachverseSite` (us-east-2) contains a private S3 bucket, an origin access control, one CloudFront Function, and one distribution. When `pricingPlan` is configured it also contains a pricing-plan subscription.

- **Bucket:** Block Public Access on, bucket-owner-enforced ownership, SSE-S3, a TLS-only policy, no static website hosting. Versioning is on, and noncurrent versions expire after 90 days, so files overwritten by a release can be recovered.
- **Origin access:** the S3 REST endpoint through OAC (SigV4, always). The bucket policy allows only `s3:GetObject` and `s3:ListBucket` to `cloudfront.amazonaws.com`, conditioned on this distribution's ARN. `ListBucket` makes S3 return 404 rather than 403 for missing keys.
- **Errors:** only 404 is mapped, to `/404.html` with status 404 and a 60-second error cache. 403 is left unmapped so real access failures stay visible.
- **Behavior:** one default behavior with HTTPS redirect, `index.html` as the default root object, and AWS-managed `CachingOptimized` and `SecurityHeadersPolicy`. The managed policy's HSTS has no `includeSubDomains`. HTML freshness comes from per-object `Cache-Control` set at upload (milestone 6).
- **Viewer-request function** (`cloudfront-js-2.0`): redirects `www.zachdavids.com` to the apex with a 301, keeping path and query. Directory-style paths map to `index.html`; `/.well-known/` is left alone.
- **Hostnames:** `zachdavids.com` and `www.zachdavids.com`, with the out-of-band certificate (ADR 0002). TLS 1.2_2021, SNI, IPv6, HTTP/2 and HTTP/3.
- **Retention:** every resource has `DeletionPolicy` and `UpdateReplacePolicy` set to `Retain`, the stack has termination protection, and tests pin logical IDs.
- **Free flat-rate plan (off by default):** `pricingPlan: { tier: 'FREE', webAclArn }` sets the distribution's `WebACLId` and adds `AWS::PricingPlanManager::Subscription`. That subscription is `CloudFront`/`FREE` over the distribution, the web ACL, and `arn:aws:route53:::hostedzone/Z03492543O0YEY0RDZZ0J`. Paid tiers are not representable in config.

## Template checks (`infra/test`)

These checks run on every stack, with the pricing plan both off and on:

- No hosted zones, Route 53 records or domains, custom resources, Lambda functions, CloudFormation-managed certificates, or StackSets.
- No IAM permission that can change DNS, unless it is limited to the exact ACM validation names, CNAME, CREATE/UPSERT, and this zone.
- Every resource retained; account `426499248998`, Region `us-east-2`, and termination protection on every stack.
- Free-plan compatibility, per the [plan feature table](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html):
  - at most 5 cache behaviors, and only AWS-managed cache, origin-request, and response-header policy IDs;
  - no legacy cache settings, OAI, logging, real-time logs, Origin Shield, origin groups, staging, Lambda@Edge, or KeyValueStore;
  - CloudFront Functions on `cloudfront-js-2.0`;
  - web ACLs: at most 5 rules, and no rule groups, partner rules, Pro-or-higher managed groups, header or regex matching, CAPTCHA or challenge actions, custom responses, or WAF logging.

`infra/test/checks.test.ts` feeds each check deliberately offending stacks and templates to show that it fails. On 2026-10-11 the guardrail suite was also run once against a temporarily mutated `site-stack.ts`. The mutation added auto-emptying of the bucket, removed the bucket's retention, and added an apex `A` record. The suite flagged `Custom::S3AutoDeleteObjects`, its Lambda handler, the `AWS::Route53::RecordSet`, and the non-retained bucket; the mutation was then reverted.

## Limits

Passing these checks says nothing about live resources, IAM in the account, the effect of the managed SCPs, or whether the pricing-plan service accepts the configuration. Milestones 4–7 verify those against the deployed stack.
