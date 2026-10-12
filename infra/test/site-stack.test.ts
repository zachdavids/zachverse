import { Match } from 'aws-cdk-lib/assertions';
import { App } from 'aws-cdk-lib/core';
import { describe, expect, it } from 'vitest';
import { production } from '../lib/config';
import { SiteStack } from '../lib/site-stack';
import { productionConfig, synthesizeSite, TEST_CERTIFICATE_ARN, TEST_WEB_ACL_ARN } from './support/synth';

const DISTRIBUTION = 'SiteDistribution3FF9535D';
const BUCKET = 'SiteBucket397A1860';

describe('site stack (pay-as-you-go)', () => {
  const { template, json } = synthesizeSite();
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
      { EventType: 'viewer-request', FunctionARN: { 'Fn::GetAtt': ['ViewerRequestFunction48E73F66', 'FunctionARN'] } },
    ]);
    template.hasResourceProperties('AWS::CloudFront::Function', {
      AutoPublish: true,
      FunctionConfig: Match.objectLike({ Runtime: 'cloudfront-js-2.0' }),
      FunctionCode: Match.stringLikeRegexp("var APEX_HOST = 'zachdavids\\.com';[\\s\\S]*var WWW_HOST = 'www\\.zachdavids\\.com';"),
    });
  });

  it('serves both hostnames with the us-east-1 certificate over TLS 1.2+', () => {
    const config = distributionConfig();
    expect(config.Aliases).toEqual(['zachdavids.com', 'www.zachdavids.com']);
    expect(config.ViewerCertificate).toEqual({
      AcmCertificateArn: TEST_CERTIFICATE_ARN,
      MinimumProtocolVersion: 'TLSv1.2_2021',
      SslSupportMethod: 'sni-only',
    });
    expect(config.IPV6Enabled).toBe(true);
  });

  it('has no web ACL or pricing-plan subscription before the plan is enabled', () => {
    expect(distributionConfig().WebACLId).toBeUndefined();
    template.resourceCountIs('AWS::PricingPlanManager::Subscription', 0);
  });

  it('exports the values the deploy workflow needs', () => {
    expect(Object.keys(json.Outputs ?? {}).sort()).toEqual(['DistributionDomainName', 'DistributionId', 'SiteBucketName']);
  });

  it('grants the GitHub deploy role read/write (no delete) on this bucket and invalidation/read on this distribution', () => {
    expect(json.Resources['SiteDeployPolicyEEC9A210']!.Properties).toEqual({
      PolicyName: 'SiteDeployPolicyEEC9A210',
      Roles: ['zachverse-github-site-deploy'],
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Action: 's3:ListBucket', Resource: { 'Fn::GetAtt': [BUCKET, 'Arn'] } },
          {
            Effect: 'Allow',
            Action: ['s3:GetObject', 's3:PutObject'],
            Resource: { 'Fn::Join': ['', [{ 'Fn::GetAtt': [BUCKET, 'Arn'] }, '/*']] },
          },
          {
            Effect: 'Allow',
            Action: [
              'cloudfront:CreateInvalidation',
              'cloudfront:GetDistribution',
              'cloudfront:GetInvalidation',
              'cloudfront:ListInvalidations',
            ],
            Resource: { 'Fn::Join': ['', ['arn:aws:cloudfront::426499248998:distribution/', { Ref: DISTRIBUTION }]] },
          },
        ],
      },
    });
  });
});

describe('site stack (Free flat-rate plan enabled)', () => {
  const { template, json } = synthesizeSite(
    productionConfig({ pricingPlan: { tier: 'FREE', webAclArn: TEST_WEB_ACL_ARN } }),
  );

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
        `arn:aws:route53:::hostedzone/${production.hostedZoneId}`,
      ],
    });
  });
});

describe('site stack configuration errors', () => {
  it('refuses to synthesize without a certificate', () => {
    const config = { ...production, certificateArn: undefined };
    expect(() => new SiteStack(new App(), 'Site', { env: { account: config.account, region: config.region }, config })).toThrow(
      /certificateArn is not set/,
    );
  });

  it.each([
    ['another Region', TEST_CERTIFICATE_ARN.replace('us-east-1', 'us-east-2')],
    ['another account', TEST_CERTIFICATE_ARN.replace(production.account, '111111111111')],
    ['another service', TEST_WEB_ACL_ARN],
  ])('rejects a certificate from %s', (_case, certificateArn) => {
    expect(() => synthesizeSite(productionConfig({ certificateArn }))).toThrow(/must be an ACM certificate in us-east-1/);
  });
});
