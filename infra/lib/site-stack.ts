import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as pricingplanmanager from 'aws-cdk-lib/aws-pricingplanmanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
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
 * Private S3 bucket behind a CloudFront distribution (OAC). Owns no DNS
 * records, hosted zones, or certificates; see docs/adr/0002 and 0003.
 */
export class SiteStack extends Stack {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: SiteStackProps) {
    super(scope, id, props);
    const { config } = props;
    const certificateArn = requireCertificateArn(config);
    if (config.pricingPlan) checkWebAclArn(config.pricingPlan.webAclArn, config.account);

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
      webAclId: config.pricingPlan?.webAclArn,
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

    if (config.pricingPlan) {
      // References the distribution, so CloudFormation creates it after the distribution.
      new pricingplanmanager.CfnSubscription(this, 'PricingPlanSubscription', {
        planFamily: 'CloudFront',
        planTier: config.pricingPlan.tier,
        resourceArns: [
          this.distribution.distributionArn,
          config.pricingPlan.webAclArn,
          `arn:${this.partition}:route53:::hostedzone/${config.hostedZoneId}`,
        ],
      });
    }

    // The GitHub deploy role lives in the identity stack (deployed first); its
    // permissions are defined here so they reference only this bucket and
    // distribution and come into existence together with them (ADR 0004).
    // No delete: routine releases never remove objects, and versioning keeps
    // overwritten files recoverable.
    new iam.Policy(this, 'SiteDeployPolicy', {
      roles: [iam.Role.fromRoleName(this, 'SiteDeployRole', config.github.deployRoleName)],
      statements: [
        new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [this.bucket.bucketArn] }),
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:PutObject'],
          resources: [this.bucket.arnForObjects('*')],
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

// ACM certificate IDs are UUIDs.
const CERTIFICATE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// webacl/<name>/<ID>: the name is 1-128 letters, digits, hyphens, or underscores, and the ID is a UUID.
const WEB_ACL_RESOURCE_NAME = /^webacl\/[\w-]{1,128}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

/** The web ACL is created outside this stack, so a bad paste would otherwise fail only at deploy time. */
function checkWebAclArn(arn: string, account: string): void {
  if (!arn) {
    throw new Error('pricingPlan.webAclArn is empty. Set it to the ARN of the CLOUDFRONT-scope web ACL (docs/adr/0002).');
  }
  const parsed = Arn.split(arn, ArnFormat.SLASH_RESOURCE_NAME);
  // CLOUDFRONT-scope web ACLs have the scope "global" and always live in us-east-1.
  if (
    parsed.partition !== 'aws' ||
    parsed.service !== 'wafv2' ||
    parsed.resource !== 'global' ||
    parsed.region !== 'us-east-1' ||
    parsed.account !== account
  ) {
    throw new Error(`pricingPlan.webAclArn must be a CLOUDFRONT-scope web ACL in us-east-1 owned by ${account}: ${arn}`);
  }
  if (!WEB_ACL_RESOURCE_NAME.test(parsed.resourceName ?? '') || parsed.arnFormat !== ArnFormat.SLASH_RESOURCE_NAME) {
    throw new Error(
      `pricingPlan.webAclArn must have the form arn:aws:wafv2:us-east-1:<account>:global/webacl/<name>/<ID>: ${arn}`,
    );
  }
}
