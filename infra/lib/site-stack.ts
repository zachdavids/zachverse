import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as pricingplanmanager from 'aws-cdk-lib/aws-pricingplanmanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Annotations, Arn, ArnFormat, CfnOutput, Duration, RemovalPolicies, Stack, type StackProps, Tags } from 'aws-cdk-lib/core';
import type { Construct } from 'constructs';
import type { SiteConfig } from './config';
import { viewerRequestCode } from './viewer-request';

/** The bucket prefix that holds the release records (scripts/release-lib.ts, ADR 0006). */
export const RELEASE_RECORDS = '_releases/';

export interface SiteStackProps extends StackProps {
  readonly config: SiteConfig;
}

/**
 * Private S3 bucket behind a CloudFront distribution (OAC), and, with the Free flat-rate plan, the distribution's web
 * ACL and the plan's subscription (docs/adr/0007). Owns no DNS records, hosted zones, or certificates; see
 * docs/adr/0002 and 0003.
 */
export class SiteStack extends Stack {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: SiteStackProps) {
    super(scope, id, props);
    const { config } = props;
    const certificateArn = requireCertificateArn(config);

    this.bucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Versioning keeps overwritten release files recoverable (milestone 6).
      versioned: true,
      lifecycleRules: [
        { id: 'ExpireOldVersions', noncurrentVersionExpiration: Duration.days(90) },
        // A cancelled or timed-out deploy job kills the AWS CLI before it can abort its multipart uploads,
        // and S3 bills their parts until they are aborted.
        { id: 'AbortIncompleteMultipartUploads', abortIncompleteMultipartUploadAfter: Duration.days(7) },
      ],
    });

    const originAccessControl = new cloudfront.S3OriginAccessControl(this, 'SiteOriginAccessControl', {
      signing: cloudfront.Signing.SIGV4_ALWAYS,
    });

    const viewerRequest = new cloudfront.Function(this, 'ViewerRequestFunction', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(viewerRequestCode(config)),
      comment: 'Redirect www to the apex; map directory paths to index.html',
    });

    this.distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      comment: `${config.domainName} website`,
      domainNames: [config.domainName, config.wwwDomainName],
      certificate: acm.Certificate.fromCertificateArn(this, 'SiteCertificate', certificateArn),
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      sslSupportMethod: cloudfront.SSLMethod.SNI,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableIpv6: true,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        // READ + LIST: with ListBucket, S3 answers 404 (not 403) for missing keys,
        // so only genuine misses reach the custom 404 page.
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket, {
          originAccessControl,
          originAccessLevels: [cloudfront.AccessLevel.READ, cloudfront.AccessLevel.LIST],
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        // AWS-managed policies only: the Free flat-rate plan rejects custom ones.
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        compress: true,
        functionAssociations: [
          { function: viewerRequest, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      // 403 is deliberately left unmapped so access failures stay visible.
      errorResponses: [
        { httpStatus: 404, responseHttpStatus: 404, responsePagePath: '/404.html', ttl: Duration.seconds(60) },
      ],
    });
    Annotations.of(this.distribution).acknowledgeWarning(
      '@aws-cdk/aws-cloudfront-origins:listBucketSecurityRisk',
      'defaultRootObject is index.html (asserted in tests), so "/" never lists the bucket.',
    );

    // The release records (a copy of each release, and the history) live beside the site, under _releases/, and are
    // not part of it: CloudFront may read every object but these, so a request for one gets S3's 403, which the
    // distribution leaves visible (ADR 0006).
    this.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [this.bucket.arnForObjects(`${RELEASE_RECORDS}*`)],
      }),
    );

    // The Free flat-rate plan requires a web ACL on the distribution, and covers its cost; on pay-as-you-go the web ACL
    // would be billed, so it exists only with the plan (ADR 0007). Each resource references the one before it, so
    // CloudFormation creates the web ACL, then attaches it to the distribution, then subscribes them. Rolling the update
    // back is not the reverse: CloudFormation restores the distribution first, which CloudFront refuses while a
    // subscription holds it (ADR 0007, "If a step fails").
    if (config.pricingPlan) {
      const webAcl = new wafv2.CfnWebACL(this, 'SiteWebAcl', {
        name: 'zachverse-site',
        scope: 'CLOUDFRONT',
        defaultAction: { allow: {} },
        visibilityConfig: visibility('zachverse-site'),
        rules: SITE_WEB_ACL_RULES,
      });
      this.distribution.attachWebAclId(webAcl.attrArn);
      const subscription = new pricingplanmanager.CfnSubscription(this, 'PricingPlanSubscription', {
        planFamily: 'CloudFront',
        planTier: config.pricingPlan.tier,
        resourceArns: [
          this.distribution.distributionArn,
          webAcl.attrArn,
          // The existing zone, attached so the plan covers its cost: a pricing association, which changes no record.
          `arn:${this.partition}:route53:::hostedzone/${config.hostedZoneId}`,
        ],
      });
      new CfnOutput(this, 'WebAclArn', { value: webAcl.attrArn });
      new CfnOutput(this, 'PricingPlanSubscriptionArn', { value: subscription.attrArn });
    }

    // The GitHub deploy role lives in the identity stack (deployed first); its
    // permissions are defined here so they reference only this bucket and
    // distribution and come into existence together with them (ADR 0004).
    // A release deletes the pages it no longer has (ADR 0006), but never an asset, which an earlier page may still load,
    // or a release record. With versioning, a delete only hides an object behind a delete marker, and the role cannot
    // delete versions, so every page stays recoverable for 90 days.
    new iam.Policy(this, 'SiteDeployPolicy', {
      roles: [iam.Role.fromRoleName(this, 'SiteDeployRole', config.github.deployRoleName)],
      statements: [
        new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [this.bucket.bucketArn] }),
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
          resources: [this.bucket.arnForObjects('*')],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          actions: ['s3:DeleteObject'],
          resources: [this.bucket.arnForObjects('assets/*'), this.bucket.arnForObjects(`${RELEASE_RECORDS}*`)],
        }),
        new iam.PolicyStatement({
          actions: [
            'cloudfront:CreateInvalidation',
            'cloudfront:GetInvalidation',
            'cloudfront:ListInvalidations',
            'cloudfront:GetDistribution',
          ],
          resources: [this.distribution.distributionArn],
        }),
      ],
    });

    // Kept on stack deletion and replacement. Only a rolled-back create deletes what it made, so a failed
    // first deploy leaves no orphaned, fixed-name function or OAC to block the retry.
    RemovalPolicies.of(this).retainOnUpdateOrDelete();
    Tags.of(this).add('project', 'zachverse');

    new CfnOutput(this, 'SiteBucketName', { value: this.bucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new CfnOutput(this, 'DistributionDomainName', { value: this.distribution.distributionDomainName });
  }
}

/**
 * Requests one viewer IP address may send in 5 minutes, the window the Free plan's rate limiting counts over, before
 * the web ACL blocks it. A visitor's browser sends far fewer: it keeps the hashed assets for a year (ADR 0006). The
 * smoke test sends all its requests from one runner address, so check:dist holds each build to half this limit
 * (SMOKE_REQUEST_BUDGET in scripts/smoke-lib.ts).
 */
export const RATE_LIMIT_PER_IP = 1000;

/** CloudWatch metrics and sampled requests, which AWS WAF keeps at no charge. */
const visibility = (metricName: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({
  sampledRequestsEnabled: true,
  cloudWatchMetricsEnabled: true,
  metricName,
});

/** An AWS managed rule group, whose rules keep their own actions. */
function managedRuleGroup(name: string, priority: number): wafv2.CfnWebACL.RuleProperty {
  return {
    name: `AWS-${name}`,
    priority,
    statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
    overrideAction: { none: {} },
    visibilityConfig: visibility(`AWS-${name}`),
  };
}

/**
 * Four of the five rules the Free plan allows (ADR 0007): a per-IP rate limit, and the three AWS managed rule groups
 * of AWS's example web ACL for a pricing plan. The cheaper rules run first: known bad addresses, then floods, then the
 * rule groups that inspect each request.
 */
const SITE_WEB_ACL_RULES: wafv2.CfnWebACL.RuleProperty[] = [
  managedRuleGroup('AWSManagedRulesAmazonIpReputationList', 0),
  {
    name: 'RateLimitPerIp',
    priority: 1,
    statement: { rateBasedStatement: { limit: RATE_LIMIT_PER_IP, evaluationWindowSec: 300, aggregateKeyType: 'IP' } },
    action: { block: {} },
    visibilityConfig: visibility('RateLimitPerIp'),
  },
  managedRuleGroup('AWSManagedRulesKnownBadInputsRuleSet', 2),
  managedRuleGroup('AWSManagedRulesCommonRuleSet', 3),
];

// ACM certificate IDs are UUIDs.
const CERTIFICATE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function requireCertificateArn(config: SiteConfig): string {
  const arn = config.certificateArn;
  if (!arn) {
    throw new Error(
      'certificateArn is not set. Request the us-east-1 ACM certificate and add its ARN to infra/lib/config.ts (docs/adr/0002).',
    );
  }
  const parsed = Arn.split(arn, ArnFormat.SLASH_RESOURCE_NAME);
  if (
    parsed.partition !== 'aws' ||
    parsed.service !== 'acm' ||
    parsed.resource !== 'certificate' ||
    parsed.region !== 'us-east-1' ||
    parsed.account !== config.account
  ) {
    throw new Error(`certificateArn must be an ACM certificate in us-east-1 owned by ${config.account}: ${arn}`);
  }
  // A truncated or padded paste would otherwise synthesize and fail only at deploy time.
  if (!CERTIFICATE_ID.test(parsed.resourceName ?? '')) {
    throw new Error(`certificateArn must end in the certificate ID (a UUID): ${arn}`);
  }
  // Arn.split also accepts certificate:<ID> and :/certificate/<ID>, which ACM never issues.
  if (parsed.arnFormat !== ArnFormat.SLASH_RESOURCE_NAME) {
    throw new Error(`certificateArn must have the form arn:aws:acm:us-east-1:<account>:certificate/<ID>: ${arn}`);
  }
  return arn;
}
