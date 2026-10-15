import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { App } from 'aws-cdk-lib/core';
import { CloudAssembly } from 'aws-cdk-lib/cx-api';
import { afterAll, describe, expect, it } from 'vitest';
import { RATE_LIMIT_PER_IP, SiteStack } from '../lib/site-stack';
import type { CfnTemplate } from '../lib/guardrails/template';
import { cdkContext, PRICING_MODES, productionConfig, synthesizeSite } from './support/synth';

// CDK deletes its temporary cloud assemblies on process exit, which Vitest workers skip.
afterAll(() => CloudAssembly.cleanupTemporaryDirectories());

// The certificate for both hostnames, requested out of band on 2026-10-13 (ADR 0002) and validated by
// infra/dns/2026-10-13-acm-validation.json.
const CERTIFICATE_ARN = 'arn:aws:acm:us-east-1:426499248998:certificate/f285dc12-6f64-4d9b-8309-043d5e90f354';
const DISTRIBUTION = 'SiteDistribution3FF9535D';
const BUCKET = 'SiteBucket397A1860';
const BUCKET_POLICY = 'SiteBucketPolicy3AC1D0F8';
const ORIGIN_ACCESS_CONTROL = 'SiteOriginAccessControl4DD454FF';
const VIEWER_REQUEST_FUNCTION = 'ViewerRequestFunction48E73F66';
const CACHING_OPTIMIZED = '658327ea-f89d-4fab-a63d-7e88639e58f6';
const SECURITY_HEADERS_POLICY = '67f7725c-6f97-4210-82d7-5512b31e9d03';
const VIEWER_REQUEST = { EventType: 'viewer-request', FunctionARN: { 'Fn::GetAtt': [VIEWER_REQUEST_FUNCTION, 'FunctionARN'] } };

// Enabling the plan may add only the web ACL and the subscription, so the design is checked with it off and on.
describe.each(Object.entries(PRICING_MODES))('site stack design (%s)', (_mode, siteConfig) => {
  const { stack, template, json } = synthesizeSite(siteConfig);
  const distributionConfig = () => json.Resources[DISTRIBUTION]!.Properties!.DistributionConfig;
  const bucketPolicyStatements = () => json.Resources[BUCKET_POLICY]!.Properties!.PolicyDocument.Statement as any[];

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

  it('encrypts with S3-managed keys, expires only noncurrent versions, and aborts incomplete uploads after 7 days', () => {
    // Exact matches: a partial match would accept a rule that also expires the live site.
    const bucket = json.Resources[BUCKET]!.Properties!;
    expect(bucket.BucketEncryption).toEqual({
      ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
    });
    expect(bucket.VersioningConfiguration).toEqual({ Status: 'Enabled' });
    expect(bucket.LifecycleConfiguration).toEqual({
      Rules: [
        { Id: 'ExpireOldVersions', NoncurrentVersionExpiration: { NoncurrentDays: 90 }, Status: 'Enabled' },
        { Id: 'AbortIncompleteMultipartUploads', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }, Status: 'Enabled' },
      ],
    });
  });

  it('sets only the bucket properties checked here', () => {
    // A new one may be create-only, such as BucketName, and replace the bucket (environment.test.ts).
    expect(Object.keys(json.Resources[BUCKET]!.Properties!).sort()).toEqual([
      'BucketEncryption',
      'LifecycleConfiguration',
      'OwnershipControls',
      'PublicAccessBlockConfiguration',
      'Tags',
      'VersioningConfiguration',
    ]);
  });

  it('lets only this distribution read and list the bucket, with no write access', () => {
    const allows = bucketPolicyStatements().filter((s) => s.Effect === 'Allow');
    expect(allows).toHaveLength(1);
    expect(allows[0].Principal).toEqual({ Service: 'cloudfront.amazonaws.com' });
    expect([...allows[0].Action].sort()).toEqual(['s3:GetObject', 's3:ListBucket']);
    expect(JSON.stringify(allows[0].Condition.StringEquals['AWS:SourceArn'])).toContain(`"Ref":"${DISTRIBUTION}"`);
  });

  it('denies every request that does not use TLS, and CloudFront every release record', () => {
    // Exact: a narrower action, principal, or resource would let some plain-HTTP requests through, or let CloudFront
    // serve a release record; a broader one could deny CloudFront the site itself.
    const bucketArn = { 'Fn::GetAtt': [BUCKET, 'Arn'] };
    expect(bucketPolicyStatements().filter((s) => s.Effect === 'Deny')).toEqual([
      {
        Effect: 'Deny',
        Principal: { AWS: '*' },
        Action: 's3:*',
        Resource: [bucketArn, { 'Fn::Join': ['', [bucketArn, '/*']] }],
        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      },
      {
        Effect: 'Deny',
        Principal: { Service: 'cloudfront.amazonaws.com' },
        Action: 's3:GetObject',
        Resource: { 'Fn::Join': ['', [bucketArn, '/_releases/*']] },
      },
    ]);
  });

  it('reaches S3 through its REST endpoint with origin access control, and through nothing else', () => {
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: { OriginAccessControlOriginType: 's3', SigningBehavior: 'always', SigningProtocol: 'sigv4' },
    });
    // Exact: an origin path, Origin Shield, or another origin would change what every request fetches.
    expect(distributionConfig().Origins).toEqual([
      {
        Id: expect.any(String),
        DomainName: { 'Fn::GetAtt': [BUCKET, 'RegionalDomainName'] },
        OriginAccessControlId: { 'Fn::GetAtt': [ORIGIN_ACCESS_CONTROL, 'Id'] },
        S3OriginConfig: { OriginAccessIdentity: '' },
      },
    ]);
  });

  it('is enabled, with only the settings checked here', () => {
    expect(distributionConfig().Enabled).toBe(true);
    expect(distributionConfig().Comment).toBe('zachdavids.com website, Zachverse');
    // A new setting, such as a geo restriction, a price class, or another behavior, needs its own test first.
    expect(Object.keys(distributionConfig()).sort()).toEqual([
      'Aliases',
      'Comment',
      'CustomErrorResponses',
      'DefaultCacheBehavior',
      'DefaultRootObject',
      'Enabled',
      'HttpVersion',
      'IPV6Enabled',
      'Origins',
      'ViewerCertificate',
      ...(siteConfig.pricingPlan ? ['WebACLId'] : []),
    ]);
  });

  it('serves index.html at the root', () => {
    expect(distributionConfig().DefaultRootObject).toBe('index.html');
  });

  it('maps only 404 to /404.html with status 404 and a short error cache; 403 stays unmapped', () => {
    expect(distributionConfig().CustomErrorResponses).toEqual([
      { ErrorCode: 404, ResponseCode: 404, ResponsePagePath: '/404.html', ErrorCachingMinTTL: 60 },
    ]);
  });

  it('redirects HTTP to HTTPS, runs the viewer-request function, and adds the security headers on every behavior', () => {
    const { DefaultCacheBehavior, CacheBehaviors = [] } = distributionConfig();
    for (const behavior of [DefaultCacheBehavior, ...CacheBehaviors]) {
      expect(behavior.ViewerProtocolPolicy).toBe('redirect-to-https');
      expect(behavior.FunctionAssociations).toEqual([VIEWER_REQUEST]);
      expect(behavior.ResponseHeadersPolicyId).toBe(SECURITY_HEADERS_POLICY);
    }
  });

  it('publishes the viewer-request function on cloudfront-js-2.0 with the site hostnames', () => {
    template.hasResourceProperties('AWS::CloudFront::Function', {
      AutoPublish: true,
      FunctionConfig: Match.objectLike({ Runtime: 'cloudfront-js-2.0' }),
      FunctionCode: Match.stringLikeRegexp("var APEX_HOST = 'zachdavids\\.com';[\\s\\S]*var WWW_HOST = 'www\\.zachdavids\\.com';"),
    });
  });

  it('caches GET and HEAD with CachingOptimized, compresses, and adds the managed security headers', () => {
    // Exact: an origin request policy that forwards Host (AllViewer) breaks the S3 origin, and trusted key
    // groups would turn every visitor away.
    const config = distributionConfig();
    expect(config.DefaultCacheBehavior).toEqual({
      AllowedMethods: ['GET', 'HEAD'],
      CachedMethods: ['GET', 'HEAD'],
      CachePolicyId: CACHING_OPTIMIZED,
      Compress: true,
      FunctionAssociations: [VIEWER_REQUEST],
      ResponseHeadersPolicyId: SECURITY_HEADERS_POLICY,
      TargetOriginId: config.Origins[0].Id,
      ViewerProtocolPolicy: 'redirect-to-https',
    });
  });

  it('serves both hostnames with the us-east-1 certificate over TLS 1.2+, HTTP/2 and HTTP/3, and IPv6', () => {
    const config = distributionConfig();
    expect(config.Aliases).toEqual(['zachdavids.com', 'www.zachdavids.com']);
    expect(config.ViewerCertificate).toEqual({
      AcmCertificateArn: CERTIFICATE_ARN,
      MinimumProtocolVersion: 'TLSv1.2_2021',
      SslSupportMethod: 'sni-only',
    });
    expect(config.HttpVersion).toBe('http2and3');
    expect(config.IPV6Enabled).toBe(true);
  });

  it('tags the bucket, distribution, and function with the project', () => {
    for (const id of [BUCKET, DISTRIBUTION, VIEWER_REQUEST_FUNCTION]) {
      expect(json.Resources[id]!.Properties!.Tags ?? [], id).toContainEqual({ Key: 'project', Value: 'zachverse' });
    }
  });

  it('retains every resource on stack deletion and replacement, deleting only what a failed first create made', () => {
    // RetainExceptOnCreate: a rolled-back first deploy leaves no fixed-name function or OAC to block the retry.
    // CDK's version-reporting metadata creates nothing in the account, and retentionViolations exempts it.
    const retained = Object.entries(json.Resources).filter(([, resource]) => resource.Type !== 'AWS::CDK::Metadata');
    expect(retained).toHaveLength(Object.keys(json.Resources).length - 1);
    for (const [id, resource] of retained) {
      expect([resource.DeletionPolicy, resource.UpdateReplacePolicy], id).toEqual(['RetainExceptOnCreate', 'Retain']);
    }
  });

  it('exports the values the deploy workflow needs, and with the plan, the ARNs the checks after a deploy read', () => {
    expect(json.Outputs).toEqual({
      SiteBucketName: { Value: { Ref: BUCKET } },
      DistributionId: { Value: { Ref: DISTRIBUTION } },
      DistributionDomainName: { Value: { 'Fn::GetAtt': [DISTRIBUTION, 'DomainName'] } },
      ...(siteConfig.pricingPlan && {
        WebAclArn: { Value: { 'Fn::GetAtt': ['SiteWebAcl', 'Arn'] } },
        PricingPlanSubscriptionArn: { Value: { 'Fn::GetAtt': ['PricingPlanSubscription', 'Arn'] } },
      }),
    });
  });

  // Error annotations already fail synthesis (@aws-cdk/core:annotationsInValidationReport in cdk.json).
  it('synthesizes without warnings (the bucket-listing warning is acknowledged)', () => {
    expect(Annotations.fromStack(stack).findWarning('*', Match.anyValue())).toEqual([]);
  });
});

describe('site stack (pay-as-you-go)', () => {
  const { template, json } = synthesizeSite(PRICING_MODES['pay-as-you-go']);

  it('has no web ACL or pricing-plan subscription without the plan, so pay-as-you-go pays for no web ACL', () => {
    expect(json.Resources[DISTRIBUTION]!.Properties!.DistributionConfig.WebACLId).toBeUndefined();
    template.resourceCountIs('AWS::WAFv2::WebACL', 0);
    template.resourceCountIs('AWS::PricingPlanManager::Subscription', 0);
  });

  it('grants the GitHub deploy role read, write, and page deletion on this bucket, and invalidation/read on this distribution', () => {
    expect(json.Resources['SiteDeployPolicyEEC9A210']!.Properties).toEqual({
      PolicyName: 'SiteDeployPolicyEEC9A210',
      Roles: ['zachverse-github-site-deploy'],
      PolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Action: 's3:ListBucket', Resource: { 'Fn::GetAtt': [BUCKET, 'Arn'] } },
          {
            Effect: 'Allow',
            Action: ['s3:DeleteObject', 's3:GetObject', 's3:PutObject'],
            Resource: { 'Fn::Join': ['', [{ 'Fn::GetAtt': [BUCKET, 'Arn'] }, '/*']] },
          },
          // Never an asset, which an earlier page may still load, or a release record (ADR 0006).
          {
            Effect: 'Deny',
            Action: 's3:DeleteObject',
            Resource: [
              { 'Fn::Join': ['', [{ 'Fn::GetAtt': [BUCKET, 'Arn'] }, '/_releases/*']] },
              { 'Fn::Join': ['', [{ 'Fn::GetAtt': [BUCKET, 'Arn'] }, '/assets/*']] },
            ],
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
  const { json } = synthesizeSite(PRICING_MODES['Free flat-rate plan']);
  const WEB_ACL = 'SiteWebAcl';
  const managed = (name: string, priority: number) => ({
    Name: `AWS-${name}`,
    Priority: priority,
    Statement: { ManagedRuleGroupStatement: { VendorName: 'AWS', Name: name } },
    OverrideAction: { None: {} },
    VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: `AWS-${name}` },
  });

  it('is what production deploys, since milestone 7 (ADR 0007)', () => {
    expect(productionConfig()).toEqual(PRICING_MODES['Free flat-rate plan']);
  });

  it('creates a CLOUDFRONT-scope web ACL with four of the plan\'s five rules: a per-IP rate limit and three AWS managed rule groups', () => {
    expect(json.Resources[WEB_ACL]!.Type).toBe('AWS::WAFv2::WebACL');
    expect(json.Resources[WEB_ACL]!.Properties).toEqual({
      Name: 'zachverse-site',
      Description: 'zachdavids.com website, Free flat-rate plan, ADR 0007',
      Scope: 'CLOUDFRONT',
      DefaultAction: { Allow: {} },
      VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: 'zachverse-site' },
      Rules: [
        managed('AWSManagedRulesAmazonIpReputationList', 0),
        {
          Name: 'RateLimitPerIp',
          Priority: 1,
          Statement: { RateBasedStatement: { Limit: 1000, EvaluationWindowSec: 300, AggregateKeyType: 'IP' } },
          Action: { Block: {} },
          VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: 'RateLimitPerIp' },
        },
        managed('AWSManagedRulesKnownBadInputsRuleSet', 2),
        managed('AWSManagedRulesCommonRuleSet', 3),
      ],
      Tags: [{ Key: 'project', Value: 'zachverse' }],
    });
    expect(RATE_LIMIT_PER_IP).toBe(1000);
  });

  // The references order the deployment: the web ACL first, then the distribution that uses it, then the subscription.
  it('attaches the web ACL to the distribution by reference', () => {
    expect(json.Resources[DISTRIBUTION]!.Properties!.DistributionConfig.WebACLId).toEqual({ 'Fn::GetAtt': [WEB_ACL, 'Arn'] });
  });

  it('subscribes the distribution, the web ACL, and the existing hosted zone to the FREE tier', () => {
    const subscriptions = Object.entries(json.Resources).filter(([, r]) => r.Type === 'AWS::PricingPlanManager::Subscription');
    expect(subscriptions.map(([id]) => id)).toEqual(['PricingPlanSubscription']);
    expect(subscriptions[0]![1].Properties).toEqual({
      PlanFamily: 'CloudFront',
      PlanTier: 'FREE',
      ResourceArns: [
        { 'Fn::Join': ['', ['arn:aws:cloudfront::426499248998:distribution/', { Ref: DISTRIBUTION }]] },
        { 'Fn::GetAtt': [WEB_ACL, 'Arn'] },
        // The existing zone from docs/adr/0002.
        'arn:aws:route53:::hostedzone/Z03492543O0YEY0RDZZ0J',
      ],
    });
  });

  it('gives the web ACL, the distribution, and the subscription no DependsOn, so only their references order them', () => {
    for (const id of [WEB_ACL, DISTRIBUTION, 'PricingPlanSubscription']) expect(json.Resources[id]!.DependsOn).toBeUndefined();
  });

  it('lets nothing else reference or depend on the web ACL or the subscription', () => {
    // Every direct edge into them, from a resource or an output. The distribution is left out: the bucket policy, the
    // deploy policy, and the subscription reference it, as they should.
    const plan = [WEB_ACL, 'PricingPlanSubscription'];
    const edges: string[] = [];
    for (const [id, resource] of Object.entries(json.Resources)) {
      for (const to of [resource.DependsOn ?? []].flat()) if (plan.includes(to)) edges.push(`${id} DependsOn ${to}`);
      for (const to of referencedIds(resource)) if (plan.includes(to)) edges.push(`${id} -> ${to}`);
    }
    for (const [key, output] of Object.entries(json.Outputs ?? {})) {
      for (const to of referencedIds(output)) if (plan.includes(to)) edges.push(`Outputs.${key} -> ${to}`);
    }
    expect(edges.sort()).toEqual([
      `Outputs.PricingPlanSubscriptionArn -> PricingPlanSubscription`,
      `Outputs.WebAclArn -> ${WEB_ACL}`,
      `PricingPlanSubscription -> ${WEB_ACL}`,
      `${DISTRIBUTION} -> ${WEB_ACL}`,
    ]);
  });

});

/** The logical IDs a template value refers to, through Ref, Fn::GetAtt in either form, or a ${Id} in Fn::Sub. */
function referencedIds(value: unknown, ids = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) referencedIds(item, ids);
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'Ref' && typeof item === 'string') ids.add(item);
      else if (key === 'Fn::GetAtt') ids.add(Array.isArray(item) ? String(item[0]) : String(item).split('.')[0]!);
      else if (key === 'Fn::Sub') {
        const [text, variables] = Array.isArray(item) ? item : [item, {}];
        // ${!Literal} is no reference, and a name the variable map defines is not a logical ID.
        for (const [, id] of String(text).matchAll(/\$\{([^!}.][^}.]*)/g)) if (!(id! in (variables ?? {}))) ids.add(id!);
      }
      referencedIds(item, ids);
    }
  }
  return ids;
}

// toThrow('text') only checks for a substring, so pass the whole message.
const error = (message: unknown) => expect.objectContaining({ message });
// Any lowercase UUID; ACM and WAF issue IDs in this form.
const ANY_ID = 'abcdef01-2345-4789-8bcd-ef0123456789';

describe('site stack configuration errors', () => {
  // The site stack's template, with cdk.json's context. It builds the stack on its own: these errors come from the
  // site stack itself, in any app.
  const synthesizeWith = (certificateArn: string | undefined) => () => {
    const config = productionConfig({ certificateArn });
    const env = { account: config.account, region: config.region };
    const stack = new SiteStack(new App({ context: cdkContext }), 'ZachverseSite', { env, config });
    return Template.fromStack(stack).toJSON() as CfnTemplate;
  };

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

  // Each ARN changes one part of CERTIFICATE_ARN, which every other test synthesizes successfully.
  it.each([
    ['another partition', CERTIFICATE_ARN.replace('arn:aws:', 'arn:aws-cn:')],
    ['another service', CERTIFICATE_ARN.replace(':acm:', ':acm-pca:')],
    ['another ACM resource type', CERTIFICATE_ARN.replace(':certificate/', ':certificate-authority/')],
    ['another Region', CERTIFICATE_ARN.replace(':us-east-1:', ':us-east-2:')],
    ['another account', CERTIFICATE_ARN.replace(':426499248998:', ':111111111111:')],
  ])('rejects a certificate ARN with %s', (_case, certificateArn) => {
    expect(certificateArn).not.toBe(CERTIFICATE_ARN);
    expect(synthesizeWith(certificateArn)).toThrow(
      error(`certificateArn must be an ACM certificate in us-east-1 owned by 426499248998: ${certificateArn}`),
    );
  });

  // Paste errors that CloudFront would otherwise reject only at deploy time.
  it.each([
    ['no certificate ID', CERTIFICATE_ARN.replace(/\/.*$/, '')],
    ['an empty certificate ID', CERTIFICATE_ARN.replace(/\/.*$/, '/')],
    ['a truncated certificate ID', CERTIFICATE_ARN.slice(0, -1)],
    ['a trailing newline', `${CERTIFICATE_ARN}\n`],
    ['an extra path segment', `${CERTIFICATE_ARN}/extra`],
    ['the ARN pasted twice', CERTIFICATE_ARN.repeat(2)],
    ['a letter that is not hex in the certificate ID', CERTIFICATE_ARN.replace(/\/[0-9a-f]/, '/o')],
    ['an uppercase certificate ID', CERTIFICATE_ARN.replace(/[0-9a-f-]{36}$/, ANY_ID.toUpperCase())],
    ['a misplaced dash in the certificate ID', CERTIFICATE_ARN.replace(/[0-9a-f-]{36}$/, '0000000-00000-0000-0000-000000000000')],
  ])('rejects a certificate ARN with %s', (_case, certificateArn) => {
    expect(certificateArn).not.toBe(CERTIFICATE_ARN);
    expect(synthesizeWith(certificateArn)).toThrow(
      error(`certificateArn must end in the certificate ID (a UUID): ${certificateArn}`),
    );
  });

  it.each([
    ['a colon before the certificate ID', CERTIFICATE_ARN.replace(':certificate/', ':certificate:')],
    ['a slash before the resource type', CERTIFICATE_ARN.replace(':certificate/', ':/certificate/')],
  ])('rejects a certificate ARN with %s', (_case, certificateArn) => {
    expect(synthesizeWith(certificateArn)).toThrow(
      error(`certificateArn must have the form arn:aws:acm:us-east-1:<account>:certificate/<ID>: ${certificateArn}`),
    );
  });

  it('accepts a certificate ID with any lowercase hex digit', () => {
    const certificateArn = CERTIFICATE_ARN.replace(/[0-9a-f-]{36}$/, ANY_ID);
    const json = synthesizeWith(certificateArn)();
    expect(json.Resources[DISTRIBUTION]!.Properties!.DistributionConfig.ViewerCertificate.AcmCertificateArn).toBe(certificateArn);
  });

  it.each([
    ['a bare certificate ID', '00000000-0000-0000-0000-000000000000'],
    ['an ARN cut off before the resource', 'arn:aws:acm:us-east-1:426499248998'],
  ])('rejects %s as malformed, naming it', (_case, certificateArn) => {
    // aws-cdk-lib's ARN parser words these errors, so pin only the value they name.
    expect(synthesizeWith(certificateArn)).toThrow(error(expect.stringContaining(certificateArn)));
  });

  it('checks ownership against the configured account', () => {
    const otherAccount = productionConfig({ account: '111111111111', certificateArn: CERTIFICATE_ARN });
    expect(() => synthesizeSite(otherAccount)).toThrow(
      error(`certificateArn must be an ACM certificate in us-east-1 owned by 111111111111: ${CERTIFICATE_ARN}`),
    );
  });

  it('requires a us-east-1 certificate even when the stack targets another Region', () => {
    const certificateArn = CERTIFICATE_ARN.replace(':us-east-1:', ':us-east-2:');
    expect(() => synthesizeSite(productionConfig({ region: 'us-east-2', certificateArn }))).toThrow(
      error(`certificateArn must be an ACM certificate in us-east-1 owned by 426499248998: ${certificateArn}`),
    );
  });
});
