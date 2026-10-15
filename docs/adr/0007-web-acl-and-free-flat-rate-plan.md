# ADR 0007: Web ACL and the Free flat-rate plan

- Status: Accepted (milestone 7). Not deployed yet: per the plan, it deploys after milestone 6's first release has passed its checks, with the runbook below.
- Date: 2026-10-15

## Context

CloudFront's flat-rate pricing plans charge one monthly price, with no overage charges, for a distribution together with its AWS WAF web ACL, a Route 53 hosted zone attached to the plan, and CloudWatch Logs ingestion for its logs. The Free tier costs nothing and comes with an allowance of 1 million requests and 100 GB a month; requests that AWS WAF blocks don't count toward it. A distribution on a plan must keep a web ACL attached, and the Free tier allows at most five WAF rules, AWS managed rule groups included. It has no customer rule groups, Bot Control, CAPTCHA or JavaScript challenges, custom responses, header- or regex-based matching, or WAF request logs. (CloudFront Developer Guide, "CloudFront flat-rate pricing plans", and the PricingPlanManager User Guide, both read 2026-10-15.)

ADR 0002 left it to this milestone to decide how the web ACL is created. Since milestone 4 the site stack could attach an existing web ACL by ARN and subscribe it, and the guardrails have checked every template against the Free tier's limits (ADR 0003, "Template checks").

## Decision

**The site stack creates the web ACL.** With `pricingPlan: { tier: 'FREE' }`, which production sets, `ZachverseSite` adds:

- the web ACL `zachverse-site` (`AWS::WAFv2::WebACL`, scope `CLOUDFRONT`, in us-east-1), attached to the distribution;
- an `AWS::PricingPlanManager::Subscription`, family `CloudFront`, tier `FREE`, over the distribution, the web ACL, and the existing hosted zone `Z03492543O0YEY0RDZZ0J`.

Without `pricingPlan`, there is neither. On pay-as-you-go pricing AWS WAF would bill the web ACL, its rules, and its requests, which the plan covers. Milestone 4's `webAclArn` option, kept only until this decision, is gone.

Attaching the hosted zone is a pricing association: the plan pays the zone's monthly fee, records, and queries, within the Free tier's allowances (at most 50 records; the zone has 10). It changes no record.

**Four rules**, of the five the Free tier allows:

| Priority | Rule | Action |
| --- | --- | --- |
| 0 | `AWS-AWSManagedRulesAmazonIpReputationList`: addresses on Amazon's threat-intelligence lists | the rule group's own |
| 1 | `RateLimitPerIp`: more than 1,000 requests from one IP address in 5 minutes | Block |
| 2 | `AWS-AWSManagedRulesKnownBadInputsRuleSet`: request patterns of known exploits | the rule group's own |
| 3 | `AWS-AWSManagedRulesCommonRuleSet`: the core rule set | the rule group's own |

- **Which rules:** the three rule groups are the ones in AWS's example web ACL for a pricing-plan subscription (PricingPlanManager User Guide). The rate limit is the Free tier's IP-based rate limiting, and 5 minutes is the window it counts over.
- **Order:** the cheaper checks run first: known bad addresses, then floods, then the rule groups that inspect each request.
- **Default action:** Allow.
- **Visibility:** CloudWatch metrics and sampled requests are on; WAF keeps them at no charge. Request logs need the Pro tier, so there are none.
- **The fifth rule** is left free.
- **The site's own checks pass these rules:**
  - The Common Rule Set blocks requests without a `User-Agent`; the smoke test sends one (`scripts/smoke-http.ts`, pinned by its tests), and Chromium sends its own.
  - Neither check's requests match the other rules' patterns.
  - A visitor's browser sends far fewer requests than the limit: it keeps the hashed assets for a year (ADR 0006).

**Paid tiers take a reviewed code change.** `PricingPlanConfig.tier` admits only `FREE`. CloudFormation activates a Free subscription at once, but leaves a paid one pending until someone approves it outside CloudFormation. It also refuses to change the tier of an existing subscription.

**Dependencies.** CloudFormation infers the order from the references: the distribution references the web ACL's ARN, and the subscription references both. So CloudFormation:

1. creates the web ACL;
2. updates the distribution to use it, waiting until the change is deployed;
3. creates the subscription.

That is the order AWS documents (web ACL → distribution → subscription). Removal runs in reverse, and nothing else depends on them.

**Retention.** Like every resource in the site stack, both are retained, so removing them from the template, or deleting the stack, leaves them in place, and the subscription keeps the plan on. CloudFront refuses to detach the web ACL while the plan is on. Going back to pay-as-you-go is therefore an administrator's sequence:

1. Cancel the subscription (`aws pricing-plan-manager cancel-subscription`). A Free plan cancels at once.
2. Deploy the template without `pricingPlan`. That detaches the web ACL.
3. Delete the retained web ACL.

## Runbook

Run this after milestone 6's first release has passed its checks, as an administrator with ADR 0004's runbook:

1. **Preflight:** follow ADR 0004's steps 1 and 2: the account is `426499248998`, and no `CDK` variable or `~/.cdk.json` is set.
2. **Export the zone:** save `aws route53 list-resource-record-sets --hosted-zone-id Z03492543O0YEY0RDZZ0J` to compare later.
3. **Check the account.** `aws pricing-plan-manager list-subscriptions --region us-east-1` lists nothing for this distribution, and the account has fewer than three Free plans. `aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1` has no `zachverse-site`. The zone has at most 50 records.
4. **Review the diff:** `npm run cdk -- diff` in `infra/`. Expect only:
   - the web ACL and the subscription, added;
   - the distribution's `WebACLId`, added;
   - two new outputs, `WebAclArn` and `PricingPlanSubscriptionArn`.
5. **Deploy:** `npm run cdk -- deploy ZachverseSite --require-approval never`.
6. **Check the result:**
   - **Subscription:** `aws pricing-plan-manager get-subscription --region us-east-1 --arn <PricingPlanSubscriptionArn>` shows:
     - status `ACTIVE`;
     - tier `FREE`, with no scheduled change;
     - exactly the three resource ARNs (the distribution, the web ACL, the zone).
   - **Distribution:** `aws cloudfront get-distribution-config` shows the web ACL's ARN as `WebACLId`, and nothing else changed.
   - **Web ACL:** `aws wafv2 get-web-acl` shows the rules above.
   - **Stack:** `ZachverseSite` is `UPDATE_COMPLETE`, and its deployed template equals the synthesized one.
7. **Smoke-test the live site through the web ACL:** run the Deploy workflow on `main` by hand. It publishes the current release again, as a retry, then smoke-tests it and checks it in a browser.
8. **Compare the zone:** export it again; it must not differ from step 2.
9. **Test an in-place update:** with the plan active, make an ordinary change to the stack, the distribution's comment, then deploy and check it as in steps 4 to 7. This shows that later stack updates still work on the plan.

**If the subscription fails,** CloudFormation rolls the update back. Do not assume it undid everything:

- **Find the cause:** read the stack's events, and the subscription's `StatusReason` if one was created.
- **Check what is left:**
  - the distribution, and whether its `WebACLId` is empty again;
  - whether the web ACL is gone (the rollback should delete it, since its create rolled back);
  - the certificate, the bucket and its policy, and the deploy role's permissions;
  - the zone, against step 2's export.
- **Report** any resource left on pay-as-you-go pricing, and what it was charged.
- **Hold milestone 8's DNS cutover** until every check in step 6 passes.

## Verification before the merge (2026-10-15)

- **Tests:**
  - The guardrails check the web ACL against the Free tier's limits in every synthesis, production's included.
  - `infra/test/site-stack.test.ts` pins the web ACL's properties and rules, the references that order the deployment, the subscription, and the outputs.
  - `infra/test/environment.test.ts` pins the new logical IDs and create-only properties: the web ACL's name and scope, and the subscription's plan family.
  - Infra tests: 1006 passed, at 100% coverage.
- **Diff:** `npm run cdk -- diff --method template` against the live stacks showed:
  - the web ACL and the subscription, added;
  - the distribution's `WebACLId`, added;
  - the two outputs, added;
  - milestone 6's undeployed `SiteDeployPolicy` change, which this branch carries;
  - no differences in `ZachverseIdentity`.
- **The account, read-only:**
  - No CLOUDFRONT-scope web ACL and no pricing-plan subscription. AWS allows three Free plans per account.
  - The zone has 10 records.
  - The site's distribution is the only one, with no web ACL.
  - The viewer-request function is the only CloudFront Function, used by no other distribution.
  - The Free Tier API's `GetAccountPlanState` answered `ResourceNotFoundException` ("Missing data for account"), so it couldn't confirm the account's plan type. Accounts on the AWS Free Tier plan can't subscribe. The Website account is a member of the organization, and the owner reports the Paid account plan. An ineligible account would fail the subscription, which the runbook covers.

## Limits

- **Usage allowances:** the Free tier's 1 million requests and 100 GB a month are not hard limits. AWS notifies at 50%, 80%, and 100%, and may slow delivery after sustained excess. Phase 2's 3D assets may need a higher tier.
- **Rule group updates:** AWS updates its managed rule groups, and the web ACL uses their default versions, so a new rule could start blocking legitimate requests. The smoke test and browser check would see it only at the next release.
- **Seeing blocks:** without request logs, a block shows only in sampled requests and CloudWatch metrics.
- **The rate limit:** it counts per IP address, so visitors behind one shared address share it.
- **Hosted zone records:** the zone must stay within the Free tier's 50 records while it is attached.
- **What the guardrails can't check:** they read templates. They can't check an account's eligibility, its usage history (which can rule out a tier), or another distribution's use of the web ACL or function; the runbook checks those.
