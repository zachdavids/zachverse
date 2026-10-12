import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as pricingplanmanager from 'aws-cdk-lib/aws-pricingplanmanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Annotations, Arn, ArnFormat, CfnOutput, Duration, RemovalPolicies, Stack, type StackProps, Tags } from 'aws-cdk-lib/core';
import type { Construct } from 'constructs';
import type { SiteConfig } from './config';
import { viewerRequestCode } from './viewer-request';

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

    this.bucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Versioning keeps overwritten release files recoverable (milestone 6).
      versioned: true,
      lifecycleRules: [{ id: 'ExpireOldVersions', noncurrentVersionExpiration: Duration.days(90) }],
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

    RemovalPolicies.of(this).retain();
    Tags.of(this).add('project', 'zachverse');

    new CfnOutput(this, 'SiteBucketName', { value: this.bucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new CfnOutput(this, 'DistributionDomainName', { value: this.distribution.distributionDomainName });
  }
}

function requireCertificateArn(config: SiteConfig): string {
  const arn = config.certificateArn;
  if (!arn) {
    throw new Error(
      'certificateArn is not set. Request the us-east-1 ACM certificate and add its ARN to infra/lib/config.ts (docs/adr/0002).',
    );
  }
  const parsed = Arn.split(arn, ArnFormat.SLASH_RESOURCE_NAME);
  if (
    parsed.service !== 'acm' ||
    parsed.resource !== 'certificate' ||
    parsed.region !== 'us-east-1' ||
    parsed.account !== config.account
  ) {
    throw new Error(`certificateArn must be an ACM certificate in us-east-1 owned by ${config.account}: ${arn}`);
  }
  return arn;
}
