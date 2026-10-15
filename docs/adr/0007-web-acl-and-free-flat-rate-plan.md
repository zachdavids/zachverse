# ADR 0007: Web ACL and the Free flat-rate plan

- Status: Accepted (milestone 7), and deployed on 2026-10-15 with the runbook below, after milestone 6's first release had passed its checks. Its steps 6 to 9 passed ("Deployed").
- Date: 2026-10-15, revised the same day after review and after the Phase 1 review

## Context

CloudFront's flat-rate pricing plans charge one monthly price, with no overage charges, for a distribution together with its AWS WAF web ACL, a Route 53 hosted zone attached to the plan, and CloudWatch Logs ingestion for its logs. The Free tier costs nothing and comes with an allowance of 1 million requests and 100 GB a month; requests that AWS WAF blocks don't count toward it. A distribution on a plan must keep a web ACL attached, and the Free tier allows at most five WAF rules, AWS managed rule groups included. It has no customer rule groups, Bot Control, CAPTCHA or JavaScript challenges, custom responses, header- or regex-based matching, or WAF request logs. (CloudFront Developer Guide, "CloudFront flat-rate pricing plans", and the PricingPlanManager User Guide, both read 2026-10-15.)

ADR 0002 left it to this milestone to decide how the web ACL is created. Since milestones 1–2 the site stack could attach an existing web ACL by ARN and subscribe it, and since milestone 4 the guardrails have checked every synthesized template against the Free tier's limits (ADR 0003, "Template checks").

## Decision

**The site stack creates the web ACL.** With `pricingPlan: { tier: 'FREE' }`, which production sets, `ZachverseSite` adds:

- the web ACL `zachverse-site` (`AWS::WAFv2::WebACL`, scope `CLOUDFRONT`, in us-east-1), attached to the distribution;
- an `AWS::PricingPlanManager::Subscription`, family `CloudFront`, tier `FREE`, over the distribution, the web ACL, and the existing hosted zone `Z03492543O0YEY0RDZZ0J`.

Without `pricingPlan`, there is neither. On pay-as-you-go pricing AWS WAF would bill the web ACL, its rules, and its requests, which the plan covers. The `webAclArn` option from milestones 1–2, kept only until this decision, is gone.

Attaching the hosted zone is a pricing association: the plan pays the zone's monthly fee, records, and queries, within the Free tier's allowances (at most 50 records; runbook step 3 checks the zone's `ResourceRecordSetCount`, which counts its SOA and NS records too). It changes no record.

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
- **Visibility:** CloudWatch metrics and sampled requests are on; WAF keeps them at no charge, the sampled requests for 3 hours. Request logs need the Pro tier, so there are none.
- **The fifth rule** is left free.
- **The site's own checks pass these rules:**
  - The Common Rule Set blocks requests without a `User-Agent`; the smoke test sends one (`scripts/smoke-http.ts`, pinned by its tests), and Chromium sends its own.
  - Neither check's requests match the other rules' patterns.
  - The smoke test sends all its requests from one runner address: seven fixed ones, then each URL at the apex once (the home page, every file, and every other address a page links to), 15 for the placeholder. `check:dist` fails a build that would need more than 500, half the rate limit, since WAF counts approximately (`SMOKE_REQUEST_BUDGET` in `scripts/smoke-lib.ts`, which `tests/repo-policy.test.ts` keeps at most half of `RATE_LIMIT_PER_IP`).
  - A visitor's browser sends far fewer requests than the limit while pages need few: a first visit to the placeholder takes 4, about 250 first visits per address in 5 minutes, and the browser keeps the hashed assets for a year (ADR 0006).
  - The IP reputation group judges the address each request comes from, and for the checks that is a GitHub-hosted runner's, which the project doesn't control. A runner on a listed address fails its run with 403s, and a re-run gets another runner ("If a step fails").

**Paid tiers take a reviewed code change.** `PricingPlanConfig.tier` admits only `FREE`. CloudFormation activates a Free subscription at once, but leaves a paid one pending until someone approves it outside CloudFormation. It also refuses to change the tier of an existing subscription.

**Dependencies.** CloudFormation infers the order from the references: the distribution references the web ACL's ARN, and the subscription references both. So CloudFormation:

1. creates the web ACL;
2. updates the distribution to use it, waiting until the change is deployed;
3. creates the subscription.

That is the order AWS documents (web ACL → distribution → subscription). Nothing else references or depends on the web ACL or the subscription (`infra/test/site-stack.test.ts`). Rolling a failed update back doesn't run in reverse, though: CloudFormation restores the distribution first and deletes what the update created afterwards, and CloudFront won't detach the web ACL while a subscription holds the distribution ("If a step fails").

**Retention.** Like every resource in the site stack, both are retained, so removing them from the template, or deleting the stack, leaves them in place, and the subscription keeps the plan on. CloudFront refuses to detach the web ACL while the plan is on, so deploying a template without `pricingPlan`, such as any from before milestone 7, fails at the distribution, and CloudFormation rolls the update back. Going back to pay-as-you-go is therefore an administrator's sequence, with ADR 0004's runbook:

1. **Cancel the subscription.** Take its ARN from the stack output `PricingPlanSubscriptionArn`, which step 3 removes. After a failed update there may be no such output: then take the `arn` of the subscription that names the distribution, from `aws pricing-plan-manager list-subscriptions --region us-east-1 --query "subscriptionSummaries[?contains(resourceArns, 'arn:aws:cloudfront::426499248998:distribution/E3R8NEUOW8Z97U')].[arn, status, statusReason]"`. Right before cancelling, read its `status` and `eTag` with `aws pricing-plan-manager get-subscription --region us-east-1 --arn <arn>`. If it already has a `scheduledChange` of type `CANCELLATION`, go on to step 2. One in `SYNC_IN_PROGRESS` can't be changed: wait out the sync, usually 2 to 5 minutes, and read it again. Any other status can be cancelled, `FAILED` included, which is AWS's remedy for a failed subscription: run `aws pricing-plan-manager cancel-subscription --region us-east-1 --arn <arn> --if-match <eTag>`. A `ConflictException` means the `eTag` changed: read it again.
2. **Wait for the plan to end.** CloudFront's guide says a Free plan is cancelled at once, but the API reference says an active subscription's cancellation takes effect at the end of the billing period. So wait until `aws pricing-plan-manager list-subscriptions --region us-east-1` no longer lists the subscription. If `get-subscription` shows a `scheduledChange` of type `CANCELLATION` instead, the plan stays on until its `effectiveDate`, and step 3 waits until then.
3. **Deploy the template without `pricingPlan`.** That detaches the web ACL. If CloudFront still refuses, CloudFormation rolls the update back: go back to step 2.
4. **Delete the retained web ACL** once that deploy is complete: `aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1` gives its `Id` and `LockToken`, and `aws wafv2 delete-web-acl --scope CLOUDFRONT --region us-east-1 --name zachverse-site --id <Id> --lock-token <LockToken>` deletes it.

From step 1 to step 4, AWS WAF bills the web ACL, its rules, and its requests at pay-as-you-go rates, and Route 53 bills the zone, so each step follows the one before it promptly.

**Monitoring.** The account can't alarm on the site ("Limits"), so from milestone 8's cutover on, the owner runs an external uptime monitor, outside AWS and this repository. Every 5 minutes, from one or two locations, it checks:
- that `https://zachdavids.com/` returns 200 with `zachverse-release` in the body;
- that `https://www.zachdavids.com/` returns a 301 to `https://zachdavids.com/`, without following it;
- the certificate's expiry, and the domain's, if the service offers them, and IPv6 too.

It alerts an address outside zachdavids.com, whose mail depends on the same zone. Its requests pass through the web ACL like a visitor's, so it must send a `User-Agent`, and in its first hour the owner checks the web ACL's sampled requests for its addresses, in case the IP reputation group lists them. They also count against the plan's allowance: about 17,000 a month per location. Its history is what shows the site has run cleanly before the DigitalOcean Droplet is retired (milestone 9).

## Runbook

Run this after milestone 6's first release has passed its checks, as an administrator with ADR 0004's runbook. Until #7 merges, deploy the site stack only from its branch or a branch built on it: once the plan is on, a deploy of `main`'s template, which has no `pricingPlan`, fails at the distribution (see "Retention").

1. **Preflight:** follow ADR 0004's steps 1 and 2: the account is `426499248998`, and no `CDK` variable or `~/.cdk.json` is set.
2. **Export what the deploy could change,** to compare later:
   - the zone: `aws route53 list-resource-record-sets --hosted-zone-id Z03492543O0YEY0RDZZ0J`;
   - the distribution: `aws cloudfront get-distribution-config --id E3R8NEUOW8Z97U`, whose `DistributionConfig` is what matters (its `ETag` changes with every update);
   - the bucket policy: `aws s3api get-bucket-policy --region us-east-1 --bucket <SiteBucketName>`;
   - the deploy role's policies: `aws iam list-role-policies` and `aws iam list-attached-role-policies`, each with `--role-name zachverse-github-site-deploy`, and `aws iam get-role-policy --role-name zachverse-github-site-deploy --policy-name SiteDeployPolicyEEC9A210`.
3. **Check the account and the distribution:**
   - `aws pricing-plan-manager list-subscriptions --region us-east-1` lists nothing for this distribution, and the account has fewer than three Free plans.
   - `aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1` has no `zachverse-site`, and step 2's `WebACLId` is empty. A web ACL attached outside CloudFormation, by hand or by a Firewall Manager policy, would be detached by the deploy and left billed, and one that Firewall Manager manages rules out the plan.
   - No other distribution uses the viewer-request function, which a distribution on a plan can't share. CloudFront can't list distributions by function, so take the function's ARN from step 2's `DefaultCacheBehavior.FunctionAssociations`, and check that it appears nowhere in `aws cloudfront list-distributions --query "DistributionList.Items[?Id!='E3R8NEUOW8Z97U'].[Id, DefaultCacheBehavior.FunctionAssociations.Items[].FunctionARN, CacheBehaviors.Items[].FunctionAssociations.Items[].FunctionARN]"`.
   - `aws shield get-subscription-state --region us-east-1` is `INACTIVE`: Shield Advanced on the distribution rules out the plan.
   - The distribution's recent usage is far below the Free tier's allowances: the 30-day sums of `Requests` and of `BytesDownloaded` over the last three months (`aws cloudwatch get-metric-statistics --region us-east-1 --namespace AWS/CloudFront --metric-name Requests --dimensions Name=DistributionId,Value=E3R8NEUOW8Z97U Name=Region,Value=Global --statistics Sum --period 2592000 --start-time <three months ago> --end-time <now>`, and again for `BytesDownloaded`), against 1 million and 100 GB. AWS judges eligibility from usage itself, by a rule it doesn't publish, so this is only a sanity check.
   - The zone's `ResourceRecordSetCount` (`aws route53 get-hosted-zone --id Z03492543O0YEY0RDZZ0J`) is at most 50.
   - The account's plan has no API to check; the owner confirmed it on 2026-10-15 ("Verification before the merge").
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
   - **Distribution:** `aws cloudfront get-distribution-config --id E3R8NEUOW8Z97U` shows the web ACL's ARN as `WebACLId`, and its `DistributionConfig` differs from step 2's in nothing else.
   - **Web ACL:** `aws wafv2 get-web-acl --region us-east-1 --arn <WebAclArn>` shows the rules above, and `ManagedByFirewallManager` is false. The `--region` matters: the default profile's Region is us-east-2, and CloudFront's web ACLs are only in us-east-1.
   - **Bucket policy and deploy role:** exactly as in step 2.
   - **Stack:** `aws cloudformation describe-stacks --region us-east-1 --stack-name ZachverseSite` shows `UPDATE_COMPLETE`, and `aws cloudformation get-template --region us-east-1 --stack-name ZachverseSite` equals the synthesized `infra/cdk.out/ZachverseSite.template.json`.
7. **Smoke-test the live site through the web ACL:** run the Deploy workflow on `main` by hand. It publishes the current release again, as a retry, then smoke-tests it and checks it in a browser.
8. **Compare the zone:** export it again. Any difference from step 2 must be a separately reviewed change, such as an email record the owner approved.
9. **Test an in-place update:** with the plan active, make an ordinary reviewed change to the stack: the distribution's comment and the web ACL's description. Export as in step 2, then review the diff, deploy, and check as in steps 4 to 7: only those two may change. This shows that later stack updates, a rule fix among them, still work on the plan.

Milestone 8's DNS cutover waits until steps 6 to 9 have all passed and `docs/progress.md` records them.

## If a step fails

- **The deploy fails (step 5).** CloudFormation normally rolls the update back. Don't assume it undid everything:
  - **Find the cause:** read the stack's events, and the subscription's `statusReason` if one was created.
  - **Check what is left,** against step 2's exports:
    - the distribution, and whether its `WebACLId` is empty again;
    - whether the web ACL is gone (the rollback should delete it, since its create rolled back);
    - the subscription: `aws pricing-plan-manager list-subscriptions --region us-east-1` lists none naming the distribution. One left behind, most likely `FAILED`, makes a retry's subscription fail, so cancel it ("Retention", steps 1 and 2, taking its ARN from that listing);
    - the certificate, the bucket and its policy, and the deploy role's permissions;
    - the zone.
  - **If the stack is `UPDATE_ROLLBACK_FAILED`** because CloudFront wouldn't detach the web ACL: the subscription was created before the update failed, and the rollback restores the distribution before it deletes what the update created. Cancel the subscription ("Retention", steps 1 and 2), then run `npm run cdk -- rollback ZachverseSite` in `infra/`, and check what is left. Never skip or orphan the distribution (`--force`, `--orphan`, or `--resources-to-skip`): CloudFormation would record it without the web ACL while it keeps one, and that web ACL would stay attached outside the stack, billed at pay-as-you-go rates, under the name a retry needs.
  - **If the stack is `UPDATE_COMPLETE` but step 6 doesn't show `ACTIVE`:** a sync usually takes 2 to 5 minutes, so check again. If the status is `FAILED`, read its `statusReason` and cancel it ("Retention", steps 1 and 2). Deploying the same template again creates no new subscription, so a retry needs a reviewed change.
  - **Report** any resource left on pay-as-you-go pricing, and what it was charged.
- **A check is blocked (step 7):** the smoke test or the browser check gets 403s from the web ACL. The deploy job fails, and the verify job's rollback fails its smoke test in the same way.
  - **Find the rule within 3 hours,** while WAF keeps sampled requests: run `aws wafv2 get-sampled-requests --scope CLOUDFRONT --region us-east-1 --web-acl-arn <WebAclArn> --rule-metric-name <metric name> --time-window StartTime=<start>,EndTime=<end> --max-items 100` for each rule's metric name. Before the cutover, nearly every request is the checks'. Each rule's `BlockedRequests` metric in CloudWatch (namespace `AWS/WAFV2`) lasts longer.
  - **The IP reputation group, on a runner's address:** re-run all jobs (ADR 0006, "When a release fails"); a new runner usually has another address.
  - **Another rule, or a block that persists:** make a reviewed change in `infra/lib/site-stack.ts`, with its test, that sets only the matching rule to Count (`ruleActionOverrides` in that rule group's statement). Deploy it with ADR 0004's runbook, and repeat steps 6 and 7. That rule then protects no visitor, so record why. Never change the web ACL in the console, where the next deploy would undo it, and don't cancel the plan or run Restore for this.
  - Until it is fixed, every push to `main` fails and rolls back.
- **The zone has a change no one reviewed (step 8):** stop, find who made it (CloudTrail's `ChangeResourceRecordSets` events in us-east-1), and ask the owner before putting anything back: it may be the owner's own approved change. Never restore a whole-zone export. Put back only the records it touched, exporting and diffing the zone before and after:
  - a website routing record (the apex `A`/`AAAA`, `www`): through a reviewed batch in `infra/dns/`, with its reverse batch;
  - one of the site certificate's validation records: with an `UPSERT` copy of its committed batch (`infra/dns/README.md`);
  - any other record, the email records above all: as a separate change the owner approves, kept outside `infra/dns/`, whose tests refuse such records, as the DMARC record was (Route 53 change `C02252852B8LKRZFNHRAO`). Record its change ID in `docs/progress.md`.
- **The in-place update fails (step 9):** read the stack's events, and handle it like a failed deploy.
- **Hold milestone 8's DNS cutover** until steps 6 to 9 all pass.

## Deployed (2026-10-15)

An administrator ran the runbook from #7's branch, with the owner's approval:
- **Steps 1 to 4:** the preflight passed, and step 2's exports were saved outside the repository.
  - **Step 3's checks:** no subscription and no Free plan in the account, no CLOUDFRONT web ACL, an empty `WebACLId`, no other distribution, Shield Advanced `INACTIVE`, 11 record sets, and about 540 requests and 5 MB since the distribution was created.
  - **Step 4's diff:** exactly the web ACL, the subscription, the distribution's `WebACLId`, and the two outputs; `ZachverseIdentity` had no differences.
- **Step 5:** deployed from `90d4b47` in 112 seconds; `UPDATE_COMPLETE` at 09:23:58 UTC.
  - Web ACL: `arn:aws:wafv2:us-east-1:426499248998:global/webacl/zachverse-site/9d3295cb-f213-4a20-a607-d90ba73ab876`.
  - Subscription: `arn:aws:pricingplanmanager::426499248998:subscription:sub_3Kj1lGHIAlYiKp1L1LRQCDf7DWN`.
- **Step 6:**
  - The subscription is `ACTIVE`, `FREE`, family `CloudFront`, with no scheduled change and exactly the three resource ARNs.
  - The distribution's config differs from step 2's only in `WebACLId`.
  - The web ACL has the four rules above, allows by default, uses 927 WCU, and isn't managed by Firewall Manager.
  - The bucket policy and the deploy role's policies are byte for byte as in step 2.
  - The deployed template equals the synthesized one.
- **Step 7:** Deploy run 38712952516, started by hand on `main`, published release `5f333d8` again through the web ACL. Every smoke check and both browser checks passed, and the release was recorded as verified.
- **Step 8:** the zone export equals step 2's.
- **Step 9:** `47d8f90` set the distribution's comment to "zachdavids.com website, Zachverse" and gave the web ACL a description. It was deployed after fresh exports, in 86 seconds, with `UPDATE_COMPLETE` at 09:33:10 UTC.
  - The diff and the result showed exactly those two changes.
  - The subscription stayed `ACTIVE`, and the zone, bucket policy, and role were unchanged.
  - Deploy run 38714014628 then passed every check through the web ACL again.

## Verification before the merge (2026-10-15)

- **Tests:**
  - The guardrails check the web ACL against the Free tier's limits in every synthesis, production's included.
  - `infra/test/site-stack.test.ts` pins the web ACL's properties and rules, the references that order the deployment, that nothing else references or depends on the web ACL or the subscription, the subscription, and the outputs.
  - `infra/test/environment.test.ts` pins the new logical IDs and create-only properties: the web ACL's name and scope, and the subscription's plan family.
  - `scripts/smoke-lib.test.ts` and `scripts/check-dist-lib.test.ts` pin the smoke test's one request per URL, each check judging the reply it needs, its count of them, and the budget `check:dist` holds builds to; `tests/repo-policy.test.ts` keeps the budget at most half the rate limit.
  - Infra tests: 1007 passed; web tests: 448 passed; both at 100% coverage.
- **Diff:** `npm run cdk -- diff --method template` against the live stacks showed:
  - the web ACL and the subscription, added;
  - the distribution's `WebACLId`, added;
  - the two outputs, added;
  - milestone 6's `SiteDeployPolicy` change, which this branch carries, not deployed then (it was later that day, from `a442c2f`, so the runbook's diff won't show it);
  - no differences in `ZachverseIdentity`.
- **The account, read-only:**
  - No CLOUDFRONT-scope web ACL and no pricing-plan subscription. AWS allows three Free plans per account.
  - The zone has 11 record sets (`ResourceRecordSetCount`, at about 07:40 UTC): 10 before the DMARC record the owner approved, added at 06:24 UTC (Route 53 change `C02252852B8LKRZFNHRAO`).
  - The site's distribution is the only one, with an empty `WebACLId`.
  - The viewer-request function is the only CloudFront Function, used by no other distribution.
  - Shield Advanced: `get-subscription-state` is `INACTIVE`.
  - Usage since the distribution was created on 2026-10-14: 371 requests and about 297 KB (CloudWatch, at about 07:40 UTC).
  - The Free Tier API's `GetAccountPlanState` answered `ResourceNotFoundException` ("Missing data for account"), so it couldn't confirm the account's plan type. Accounts on the AWS Free Tier plan can't subscribe; the owner confirmed on 2026-10-15 that the account is on the Paid plan.

## Limits

- **Usage allowances:** the Free tier's 1 million requests and 100 GB a month are not hard limits. AWS notifies at 50%, 80%, and 100%, and may slow delivery after sustained excess. Phase 2's 3D assets may need a higher tier.
- **Rule group updates:** AWS updates its managed rule groups, and the web ACL uses their default versions, so a new rule could start blocking legitimate requests. The smoke test and browser check would see it only at the next release.
- **Seeing blocks:** without request logs, a block shows only in sampled requests, which WAF keeps for 3 hours, and in CloudWatch metrics.
- **The checks' addresses:** the IP reputation group can list a GitHub-hosted runner's address, and so fail that run ("If a step fails").
- **The rate limit:** it counts per IP address, so visitors behind one shared address share it. The smoke test's requests count too: `check:dist` keeps each build under half the limit, and a release with more files than that needs a higher limit or a smoke test that paces itself, though the release jobs' time limits bind first (ADR 0006, "Limits"). The live browser check's requests count as well, with no budget: three page loads with an empty cache, from one runner. The limit was sized for the placeholder; Phase 2 re-derives it from its pages' request counts (`docs/phase-2-inputs.md`).
- **Hosted zone records:** the zone must stay within the Free tier's 50 records while it is attached.
- **No alerting:** nothing in AWS or this repository watches the live site between releases. The Website account's SCP denies CloudWatch alarm writes, SNS, EventBridge, and Synthetics in us-east-1, where CloudFront's and the web ACL's metrics live, and an alarm can't watch another Region's metrics. The repository's workflows run only on pushes, pull requests, and by hand. The release checks connect to the distribution directly, whatever DNS says. What still reaches the owner is email: AWS Health notices, ACM's renewal warnings, the usage notices above, the payer budget's alerts, and a failed Deploy run. From milestone 8's cutover on, the owner's monitor ("Monitoring") is the only check that goes through public DNS.
- **What the guardrails can't check:** they read templates. They can't see another distribution's use of the viewer-request function, a web ACL attached outside CloudFormation, Shield Advanced, the account's plan, or usage that rules out a tier. Runbook step 3 checks the first three and compares the usage with the allowances; the owner confirmed the account's plan, which no API reports. AWS judges usage by a rule it doesn't publish, and refuses an ineligible subscription at deploy time, which rolls the update back ("If a step fails").
