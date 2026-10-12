import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { CloudAssembly } from 'aws-cdk-lib/cx-api';
import { afterAll, describe, expect, it } from 'vitest';
import { productionConfig, synthesizeSite, TEST_CERTIFICATE_ARN, TEST_WEB_ACL_ARN } from './support/synth';

// CDK deletes its temporary cloud assemblies on process exit, which Vitest workers skip.
afterAll(() => CloudAssembly.cleanupTemporaryDirectories());

const DISTRIBUTION = 'SiteDistribution3FF9535D';
const BUCKET = 'SiteBucket397A1860';
const VIEWER_REQUEST_FUNCTION = 'ViewerRequestFunction48E73F66';

describe('site stack (pay-as-you-go)', () => {
  const { stack, template, json } = synthesizeSite();
  const distributionConfig = () => json.Resources[DISTRIBUTION]!.Properties!.DistributionConfig;

  it('keeps the bucket private: Block Public Access on, no static website hosting', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
      WebsiteConfiguration: Match.absent(),
    });
  });

  it('encrypts objects with S3-managed keys and expires only noncurrent versions, after 90 days', () => {
    // Exact matches: a partial match would accept a rule that also expires the live site.
    const bucket = json.Resources[BUCKET]!.Properties!;
    expect(bucket.BucketEncryption).toEqual({
      ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
    });
    expect(bucket.VersioningConfiguration).toEqual({ Status: 'Enabled' });
    expect(bucket.LifecycleConfiguration).toEqual({
      Rules: [{ Id: 'ExpireOldVersions', NoncurrentVersionExpiration: { NoncurrentDays: 90 }, Status: 'Enabled' }],
    });
  });

  it('lets only this distribution read and list the bucket, with no write access', () => {
    const statements = json.Resources['SiteBucketPolicy3AC1D0F8']!.Properties!.PolicyDocument.Statement as any[];
    const allows = statements.filter((s) => s.Effect === 'Allow');
    expect(allows).toHaveLength(1);
    expect(allows[0].Principal).toEqual({ Service: 'cloudfront.amazonaws.com' });
    expect([...allows[0].Action].sort()).toEqual(['s3:GetObject', 's3:ListBucket']);
    expect(JSON.stringify(allows[0].Condition.StringEquals['AWS:SourceArn'])).toContain(`"Ref":"${DISTRIBUTION}"`);

    const denyInsecure = statements.find((s) => s.Effect === 'Deny');
    expect(denyInsecure.Condition).toEqual({ Bool: { 'aws:SecureTransport': 'false' } });
  });

  it('reaches S3 through its REST endpoint with origin access control', () => {
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: { OriginAccessControlOriginType: 's3', SigningBehavior: 'always', SigningProtocol: 'sigv4' },
    });
    const [origin] = distributionConfig().Origins;
    expect(origin.DomainName).toEqual({ 'Fn::GetAtt': [BUCKET, 'RegionalDomainName'] });
    expect(origin.S3OriginConfig).toEqual({ OriginAccessIdentity: '' });
    expect(origin.OriginAccessControlId).toEqual({ 'Fn::GetAtt': ['SiteOriginAccessControl4DD454FF', 'Id'] });
  });

  it('serves index.html at the root', () => {
    expect(distributionConfig().DefaultRootObject).toBe('index.html');
  });

  it('maps only 404 to /404.html with status 404 and a short error cache; 403 stays unmapped', () => {
    expect(distributionConfig().CustomErrorResponses).toEqual([
      { ErrorCode: 404, ResponseCode: 404, ResponsePagePath: '/404.html', ErrorCachingMinTTL: 60 },
    ]);
  });

  it('redirects HTTP to HTTPS and runs the viewer-request function on cloudfront-js-2.0', () => {
    const behavior = distributionConfig().DefaultCacheBehavior;
    expect(behavior.ViewerProtocolPolicy).toBe('redirect-to-https');
    expect(behavior.AllowedMethods).toEqual(['GET', 'HEAD']);
    expect(behavior.FunctionAssociations).toEqual([
      { EventType: 'viewer-request', FunctionARN: { 'Fn::GetAtt': [VIEWER_REQUEST_FUNCTION, 'FunctionARN'] } },
    ]);
    template.hasResourceProperties('AWS::CloudFront::Function', {
      AutoPublish: true,
      FunctionConfig: Match.objectLike({ Runtime: 'cloudfront-js-2.0' }),
      FunctionCode: Match.stringLikeRegexp("var APEX_HOST = 'zachdavids\\.com';[\\s\\S]*var WWW_HOST = 'www\\.zachdavids\\.com';"),
    });
  });

  it('caches GET and HEAD with CachingOptimized, compresses, and adds the managed security headers', () => {
    const behavior = distributionConfig().DefaultCacheBehavior;
    expect(behavior.CachedMethods).toEqual(['GET', 'HEAD']);
    expect(behavior.CachePolicyId).toBe('658327ea-f89d-4fab-a63d-7e88639e58f6'); // CachingOptimized
    expect(behavior.ResponseHeadersPolicyId).toBe('67f7725c-6f97-4210-82d7-5512b31e9d03'); // SecurityHeadersPolicy
    expect(behavior.Compress).toBe(true);
  });

  it('serves both hostnames with the us-east-1 certificate over TLS 1.2+, HTTP/2 and HTTP/3, and IPv6', () => {
    const config = distributionConfig();
    expect(config.Aliases).toEqual(['zachdavids.com', 'www.zachdavids.com']);
    expect(config.ViewerCertificate).toEqual({
      AcmCertificateArn: productionConfig().certificateArn,
      MinimumProtocolVersion: 'TLSv1.2_2021',
      SslSupportMethod: 'sni-only',
    });
    expect(config.HttpVersion).toBe('http2and3');
    expect(config.IPV6Enabled).toBe(true);
  });

  it('has no web ACL or pricing-plan subscription before the plan is enabled', () => {
    expect(distributionConfig().WebACLId).toBeUndefined();
    template.resourceCountIs('AWS::PricingPlanManager::Subscription', 0);
  });

  it('tags the bucket, distribution, and function with the project', () => {
    for (const id of [BUCKET, DISTRIBUTION, VIEWER_REQUEST_FUNCTION]) {
      expect(json.Resources[id]!.Properties!.Tags ?? [], id).toContainEqual({ Key: 'project', Value: 'zachverse' });
    }
  });

  it('exports the values the deploy workflow needs', () => {
    expect(json.Outputs).toEqual({
      SiteBucketName: { Value: { Ref: BUCKET } },
      DistributionId: { Value: { Ref: DISTRIBUTION } },
      DistributionDomainName: { Value: { 'Fn::GetAtt': [DISTRIBUTION, 'DomainName'] } },
    });
  });

  // Error annotations already fail synthesis (@aws-cdk/core:annotationsInValidationReport in cdk.json).
  it('synthesizes without warnings (the bucket-listing warning is acknowledged)', () => {
    expect(Annotations.fromStack(stack).findWarning('*', Match.anyValue())).toEqual([]);
  });
});

describe('site stack (Free flat-rate plan enabled)', () => {
  const { stack, template, json } = synthesizeSite(
    productionConfig({ pricingPlan: { tier: 'FREE', webAclArn: TEST_WEB_ACL_ARN } }),
  );

  it('synthesizes without warnings', () => {
    expect(Annotations.fromStack(stack).findWarning('*', Match.anyValue())).toEqual([]);
  });

  it('attaches the intended web ACL to the distribution', () => {
    expect(json.Resources[DISTRIBUTION]!.Properties!.DistributionConfig.WebACLId).toBe(TEST_WEB_ACL_ARN);
  });

  it('subscribes the distribution, web ACL, and existing hosted zone to the FREE tier', () => {
    template.resourceCountIs('AWS::PricingPlanManager::Subscription', 1);
    const [, subscription] = Object.entries(json.Resources).find(
      ([, r]) => r.Type === 'AWS::PricingPlanManager::Subscription',
    )!;
    expect(subscription.Properties).toEqual({
      PlanFamily: 'CloudFront',
      PlanTier: 'FREE',
      ResourceArns: [
        { 'Fn::Join': ['', ['arn:aws:cloudfront::426499248998:distribution/', { Ref: DISTRIBUTION }]] },
        TEST_WEB_ACL_ARN,
        // The existing zone from docs/adr/0002.
        'arn:aws:route53:::hostedzone/Z03492543O0YEY0RDZZ0J',
      ],
    });
  });
});

describe('site stack configuration errors', () => {
  // toThrow('text') only checks for a substring, so pass the whole message.
  const error = (message: unknown) => expect.objectContaining({ message });
  const synthesizeWith = (certificateArn: string | undefined) => () =>
    synthesizeSite(productionConfig({ certificateArn }));

  it.each([
    ['missing', undefined],
    ['empty', ''],
  ])('refuses to synthesize when the certificate ARN is %s', (_case, certificateArn) => {
    expect(synthesizeWith(certificateArn)).toThrow(
      error(
        'certificateArn is not set. Request the us-east-1 ACM certificate and add its ARN to infra/lib/config.ts (docs/adr/0002).',
      ),
    );
  });

  // Each ARN changes one part of TEST_CERTIFICATE_ARN, which every other test synthesizes successfully.
  it.each([
    ['another service', TEST_CERTIFICATE_ARN.replace(':acm:', ':acm-pca:')],
    ['another ACM resource type', TEST_CERTIFICATE_ARN.replace(':certificate/', ':certificate-authority/')],
    ['another Region', TEST_CERTIFICATE_ARN.replace(':us-east-1:', ':us-east-2:')],
    ['another account', TEST_CERTIFICATE_ARN.replace(':426499248998:', ':111111111111:')],
  ])('rejects a certificate ARN with %s', (_case, certificateArn) => {
    expect(certificateArn).not.toBe(TEST_CERTIFICATE_ARN);
    expect(synthesizeWith(certificateArn)).toThrow(
      error(`certificateArn must be an ACM certificate in us-east-1 owned by 426499248998: ${certificateArn}`),
    );
  });

  // Paste errors that CloudFront would otherwise reject only at deploy time.
  it.each([
    ['no certificate ID', TEST_CERTIFICATE_ARN.replace(/\/.*$/, '')],
    ['an empty certificate ID', TEST_CERTIFICATE_ARN.replace(/\/.*$/, '/')],
    ['a truncated certificate ID', TEST_CERTIFICATE_ARN.slice(0, -1)],
    ['a trailing newline', `${TEST_CERTIFICATE_ARN}\n`],
    ['an extra path segment', `${TEST_CERTIFICATE_ARN}/extra`],
    ['the ARN pasted twice', TEST_CERTIFICATE_ARN.repeat(2)],
  ])('rejects a certificate ARN with %s', (_case, certificateArn) => {
    expect(certificateArn).not.toBe(TEST_CERTIFICATE_ARN);
    expect(synthesizeWith(certificateArn)).toThrow(
      error(`certificateArn must end in the certificate ID (a UUID): ${certificateArn}`),
    );
  });

  it.each([
    ['a bare certificate ID', '00000000-0000-0000-0000-000000000000'],
    ['an ARN cut off before the resource', 'arn:aws:acm:us-east-1:426499248998'],
  ])('rejects %s as malformed, naming it', (_case, certificateArn) => {
    // aws-cdk-lib's ARN parser words these errors, so pin only the value they name.
    expect(synthesizeWith(certificateArn)).toThrow(error(expect.stringContaining(certificateArn)));
  });

  it('checks ownership against the configured account', () => {
    const otherAccount = productionConfig({ account: '111111111111', certificateArn: TEST_CERTIFICATE_ARN });
    expect(() => synthesizeSite(otherAccount)).toThrow(
      error(`certificateArn must be an ACM certificate in us-east-1 owned by 111111111111: ${TEST_CERTIFICATE_ARN}`),
    );
  });

  it('requires a us-east-1 certificate even when the stack targets another Region', () => {
    const certificateArn = TEST_CERTIFICATE_ARN.replace(':us-east-1:', ':us-east-2:');
    expect(() => synthesizeSite(productionConfig({ region: 'us-east-2', certificateArn }))).toThrow(
      error(`certificateArn must be an ACM certificate in us-east-1 owned by 426499248998: ${certificateArn}`),
    );
  });
});
