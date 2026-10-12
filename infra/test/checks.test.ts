// Proves each guardrail check actually fails on the problem it guards against,
// using stacks and templates that deliberately include offending resources.
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Template } from 'aws-cdk-lib/assertions';
import { App, RemovalPolicy, Stack } from 'aws-cdk-lib/core';
import { describe, expect, it } from 'vitest';
import { githubOidcSubject, production } from '../lib/config';
import {
  deployRoleViolations,
  dnsWriteViolations,
  freePlanViolations,
  freePlanWebAclViolations,
  githubTrustViolations,
  prohibitedResourceViolations,
  retentionViolations,
  WEBSITE_DEPLOY_ACTIONS,
} from './support/checks';
import type { CfnTemplate } from './support/synth';
import { synthesizeAll, synthesizeSite } from './support/synth';

const ZONE_ID = 'Z03492543O0YEY0RDZZ0J';
const VALIDATION_NAME = '_0123456789abcdef0123456789abcdef.zachdavids.com';

function synth(build: (stack: Stack) => void): CfnTemplate {
  const stack = new Stack(new App(), 'Offending', { env: { account: '426499248998', region: 'us-east-1' } });
  build(stack);
  return Template.fromStack(stack).toJSON() as CfnTemplate;
}

const clone = <T>(value: T): T => structuredClone(value);

describe('prohibitedResourceViolations', () => {
  it('flags automatic bucket emptying (custom resource + Lambda)', () => {
    const template = synth((s) => new s3.Bucket(s, 'B', { autoDeleteObjects: true, removalPolicy: RemovalPolicy.DESTROY }));
    const violations = prohibitedResourceViolations(template);
    expect(violations.some((v) => v.includes('Custom::S3AutoDeleteObjects'))).toBe(true);
    expect(violations.some((v) => v.includes('AWS::Lambda::Function'))).toBe(true);
  });

  it('flags hosted zones and website or email record sets', () => {
    const template = synth((s) => {
      const zone = new route53.PublicHostedZone(s, 'Zone', { zoneName: 'zachdavids.com' });
      new route53.ARecord(s, 'Apex', { zone, target: route53.RecordTarget.fromIpAddresses('192.0.2.1') });
      new route53.MxRecord(s, 'Mx', { zone, values: [{ priority: 1, hostName: 'aspmx.l.google.com' }] });
      new route53.TxtRecord(s, 'Spf', { zone, values: ['v=spf1 -all'] });
    });
    const violations = prohibitedResourceViolations(template);
    expect(violations.filter((v) => v.includes('AWS::Route53::HostedZone'))).toHaveLength(1);
    expect(violations.filter((v) => v.includes('AWS::Route53::RecordSet'))).toHaveLength(3);
  });

  it('flags a CloudFormation-managed certificate that would write validation records itself', () => {
    const template = synth((s) => {
      const zone = route53.HostedZone.fromHostedZoneAttributes(s, 'Zone', { hostedZoneId: ZONE_ID, zoneName: 'zachdavids.com' });
      new acm.Certificate(s, 'Cert', { domainName: 'zachdavids.com', validation: acm.CertificateValidation.fromDns(zone) });
    });
    expect(prohibitedResourceViolations(template)).toEqual([
      expect.stringContaining('AWS::CertificateManager::Certificate'),
    ]);
  });

  it('passes the real site stack', () => {
    expect(prohibitedResourceViolations(synthesizeSite().json)).toEqual([]);
  });
});

describe('retentionViolations', () => {
  it('flags resources that would be deleted with the stack', () => {
    const template = synth((s) => new s3.Bucket(s, 'B', { removalPolicy: RemovalPolicy.DESTROY }));
    expect(retentionViolations(template)).toEqual([expect.stringContaining('AWS::S3::Bucket')]);
  });
});

describe('dnsWriteViolations', () => {
  const allowance = { hostedZoneId: ZONE_ID, validationRecordNames: [VALIDATION_NAME] };
  const zoneArn = `arn:aws:route53:::hostedzone/${ZONE_ID}`;
  const scopedStatement = () =>
    new iam.PolicyStatement({
      actions: ['route53:ChangeResourceRecordSets'],
      resources: [zoneArn],
      conditions: {
        'ForAllValues:StringEquals': {
          'route53:ChangeResourceRecordSetsNormalizedRecordNames': [VALIDATION_NAME],
          'route53:ChangeResourceRecordSetsRecordTypes': ['CNAME'],
          'route53:ChangeResourceRecordSetsActions': ['UPSERT'],
        },
      },
    });
  const roleWith = (...statements: iam.PolicyStatement[]) =>
    synth((s) => {
      const role = new iam.Role(s, 'Role', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
      statements.forEach((st) => role.addToPolicy(st));
    });

  it('accepts a statement limited to exact validation names, CNAME, and UPSERT', () => {
    expect(dnsWriteViolations(roleWith(scopedStatement()), allowance)).toEqual([]);
  });

  it('flags any DNS write when no validation names are allowed', () => {
    expect(dnsWriteViolations(roleWith(scopedStatement()))).toHaveLength(1);
  });

  it.each([
    ['broad actions', new iam.PolicyStatement({ actions: ['route53:*'], resources: [zoneArn] })],
    ['full admin', new iam.PolicyStatement({ actions: ['*'], resources: ['*'] })],
    ['domain registration', new iam.PolicyStatement({ actions: ['route53domains:*'], resources: ['*'] })],
    ['unconditioned record changes', new iam.PolicyStatement({ actions: ['route53:ChangeResourceRecordSets'], resources: [zoneArn] })],
    [
      'wildcard record names',
      new iam.PolicyStatement({
        actions: ['route53:ChangeResourceRecordSets'],
        resources: [zoneArn],
        conditions: {
          'ForAllValues:StringEquals': {
            'route53:ChangeResourceRecordSetsNormalizedRecordNames': ['*.zachdavids.com'],
            'route53:ChangeResourceRecordSetsRecordTypes': ['CNAME'],
            'route53:ChangeResourceRecordSetsActions': ['UPSERT'],
          },
        },
      }),
    ],
    [
      'MX/TXT changes',
      new iam.PolicyStatement({
        actions: ['route53:ChangeResourceRecordSets'],
        resources: [zoneArn],
        conditions: {
          'ForAllValues:StringEquals': {
            'route53:ChangeResourceRecordSetsNormalizedRecordNames': [VALIDATION_NAME],
            'route53:ChangeResourceRecordSetsRecordTypes': ['CNAME', 'MX', 'TXT'],
            'route53:ChangeResourceRecordSetsActions': ['UPSERT', 'DELETE'],
          },
        },
      }),
    ],
    ['every hosted zone', (() => { const st = scopedStatement(); st.addResources('arn:aws:route53:::hostedzone/*'); return st; })()],
  ])('flags %s', (_case, statement) => {
    expect(dnsWriteViolations(roleWith(statement), allowance).length).toBeGreaterThan(0);
  });
});

describe('freePlanViolations', () => {
  const site = synthesizeSite().json;
  const DIST = 'SiteDistribution3FF9535D';
  const mutate = (fn: (config: any, template: CfnTemplate) => void) => {
    const template = clone(site);
    fn(template.Resources[DIST]!.Properties!.DistributionConfig, template);
    return freePlanViolations(template);
  };

  it('passes the real site stack', () => {
    expect(freePlanViolations(site)).toEqual([]);
  });

  it.each([
    ['a custom cache policy', (c: any) => (c.DefaultCacheBehavior.CachePolicyId = { Ref: 'MyCachePolicy' })],
    ['an unknown origin request policy', (c: any) => (c.DefaultCacheBehavior.OriginRequestPolicyId = 'not-managed')],
    ['a custom response headers policy', (c: any) => (c.DefaultCacheBehavior.ResponseHeadersPolicyId = { Ref: 'X' })],
    ['legacy ForwardedValues', (c: any) => (c.DefaultCacheBehavior.ForwardedValues = { QueryString: false })],
    ['real-time logs', (c: any) => (c.DefaultCacheBehavior.RealtimeLogConfigArn = 'arn:aws:cloudfront::1:realtime-log-config/x')],
    ['Lambda@Edge', (c: any) => (c.DefaultCacheBehavior.LambdaFunctionAssociations = [{ EventType: 'origin-request' }])],
    ['standard access logging', (c: any) => (c.Logging = { Bucket: 'logs.s3.amazonaws.com' })],
    ['origin failover groups', (c: any) => (c.OriginGroups = { Quantity: 1, Items: [] })],
    ['Origin Shield', (c: any) => (c.Origins[0].OriginShield = { Enabled: true, OriginShieldRegion: 'us-east-2' })],
    ['an OAI', (c: any) => (c.Origins[0].S3OriginConfig.OriginAccessIdentity = 'origin-access-identity/cloudfront/E1')],
    ['dedicated IP SSL', (c: any) => (c.ViewerCertificate.SslSupportMethod = 'vip')],
    ['a staging distribution', (c: any) => (c.Staging = true)],
    [
      'more than five cache behaviors',
      (c: any) =>
        (c.CacheBehaviors = Array.from({ length: 5 }, (_, i) => ({ ...c.DefaultCacheBehavior, PathPattern: `/p${i}/*` }))),
    ],
    ['a cloudfront-js-1.0 function', (_c: any, t: CfnTemplate) => {
      t.Resources['ViewerRequestFunction48E73F66']!.Properties!.FunctionConfig.Runtime = 'cloudfront-js-1.0';
    }],
    ['a KeyValueStore association', (_c: any, t: CfnTemplate) => {
      t.Resources['ViewerRequestFunction48E73F66']!.Properties!.FunctionConfig.KeyValueStoreAssociations = [
        { KeyValueStoreARN: 'arn:aws:cloudfront::1:key-value-store/x' },
      ];
    }],
  ])('flags %s', (_case, fn) => {
    expect(mutate(fn).length).toBeGreaterThan(0);
  });

  it('flags unsupported resource types', () => {
    const template = synth((s) => {
      new cloudfront.CachePolicy(s, 'Custom');
      const bucket = new s3.Bucket(s, 'B');
      new cloudfront.Distribution(s, 'D', { defaultBehavior: { origin: origins.S3BucketOrigin.withOriginAccessIdentity(bucket) } });
    });
    const violations = freePlanViolations(template);
    expect(violations.some((v) => v.includes('AWS::CloudFront::CachePolicy'))).toBe(true);
    expect(violations.some((v) => v.includes('AWS::CloudFront::CloudFrontOriginAccessIdentity'))).toBe(true);
    expect(violations.some((v) => v.includes('OAI is unsupported'))).toBe(true);
  });
});

describe('freePlanWebAclViolations', () => {
  const rule = (name: string, statement: object, action: object = { Block: {} }) => ({
    Name: name,
    Priority: 0,
    Statement: statement,
    Action: action,
    VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: name },
  });
  const managed = (name: string) => ({
    Name: name,
    Priority: 0,
    Statement: { ManagedRuleGroupStatement: { VendorName: 'AWS', Name: name } },
    OverrideAction: { None: {} },
    VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: name },
  });
  const freeAcl = () => ({
    Scope: 'CLOUDFRONT',
    DefaultAction: { Allow: {} },
    VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: 'acl' },
    Rules: [
      managed('AWSManagedRulesAmazonIpReputationList'),
      managed('AWSManagedRulesCommonRuleSet'),
      managed('AWSManagedRulesKnownBadInputsRuleSet'),
      rule('RateLimit', { RateBasedStatement: { Limit: 1000, AggregateKeyType: 'IP' } }),
      rule('GeoBlock', { GeoMatchStatement: { CountryCodes: ['KP'] } }),
    ],
  });

  it('accepts five Free-plan rules', () => {
    expect(freePlanWebAclViolations(freeAcl())).toEqual([]);
  });

  it.each([
    ['a sixth rule', (a: any) => a.Rules.push(rule('Extra', { GeoMatchStatement: { CountryCodes: ['RU'] } }))],
    ['regional scope', (a: any) => (a.Scope = 'REGIONAL')],
    ['Bot Control', (a: any) => (a.Rules[0] = managed('AWSManagedRulesBotControlRuleSet'))],
    ['a use-case rule group', (a: any) => (a.Rules[0] = managed('AWSManagedRulesWordPressRuleSet'))],
    ['partner rules', (a: any) => (a.Rules[0].Statement.ManagedRuleGroupStatement.VendorName = 'F5')],
    ['a rule group reference', (a: any) => (a.Rules[3] = rule('RG', { RuleGroupReferenceStatement: { Arn: 'arn' } }))],
    ['regex matching', (a: any) => (a.Rules[3] = rule('Re', { RegexMatchStatement: { RegexString: 'x', FieldToMatch: { UriPath: {} }, TextTransformations: [] } }))],
    ['header matching', (a: any) => (a.Rules[3] = rule('H', { ByteMatchStatement: { SearchString: 'x', FieldToMatch: { SingleHeader: { Name: 'user-agent' } }, PositionalConstraint: 'CONTAINS', TextTransformations: [] } }))],
    ['header-keyed rate limits', (a: any) => (a.Rules[3].Statement.RateBasedStatement = { Limit: 100, AggregateKeyType: 'CUSTOM_KEYS', CustomKeys: [{ Header: { Name: 'x' } }] })],
    ['CAPTCHA', (a: any) => (a.Rules[3].Action = { Captcha: {} })],
    ['JavaScript challenge', (a: any) => (a.Rules[3].Action = { Challenge: {} })],
    ['a custom block response', (a: any) => (a.Rules[3].Action = { Block: { CustomResponse: { ResponseCode: 429 } } })],
    ['larger body inspection', (a: any) => (a.AssociationConfig = { RequestBody: { CLOUDFRONT: { DefaultSizeInspectionLimit: 'KB_64' } } })],
  ])('flags %s', (_case, fn) => {
    const acl = freeAcl();
    fn(acl);
    expect(freePlanWebAclViolations(acl).length).toBeGreaterThan(0);
  });

  it('applies to web ACLs found in a template, and flags WAF logging', () => {
    const template: CfnTemplate = {
      Resources: {
        Acl: { Type: 'AWS::WAFv2::WebACL', Properties: { ...freeAcl(), Scope: 'REGIONAL' } },
        AclLogs: { Type: 'AWS::WAFv2::LoggingConfiguration', Properties: {} },
      },
    };
    const violations = freePlanViolations(template);
    expect(violations).toContain('Acl: Scope must be CLOUDFRONT');
    expect(violations.some((v) => v.startsWith('AclLogs'))).toBe(true);
  });
});

describe('githubTrustViolations', () => {
  const subject = githubOidcSubject(production.github);
  const roleTrusting = (conditions: Record<string, unknown>, actions = ['sts:AssumeRoleWithWebIdentity']) =>
    synth((s) => {
      const provider = new iam.OidcProviderNative(s, 'GitHub', {
        url: 'https://token.actions.githubusercontent.com',
        clientIds: ['sts.amazonaws.com'],
      });
      const role = new iam.Role(s, 'Role', { assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, conditions) });
      if (actions.length > 1) {
        (role.assumeRolePolicy as iam.PolicyDocument).addStatements(
          new iam.PolicyStatement({ actions: ['sts:TagSession'], principals: [new iam.FederatedPrincipal(provider.oidcProviderArn)] }),
        );
      }
    });

  it('accepts the exact production-environment subject with the STS audience', () => {
    const template = roleTrusting({
      StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': subject },
    });
    expect(githubTrustViolations(template, subject)).toEqual([]);
  });

  it.each([
    ['a repository-wide wildcard', {
      StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
      StringLike: { 'token.actions.githubusercontent.com:sub': 'repo:zachdavids@43345768/zachverse@1414719760:*' },
    }],
    ['the old name-only subject format', {
      StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': 'repo:zachdavids/zachverse:environment:production' },
    }],
    ['a branch subject instead of the environment', {
      StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': 'repo:zachdavids@43345768/zachverse@1414719760:ref:refs/heads/main' },
    }],
    ['a missing audience', { StringEquals: { 'token.actions.githubusercontent.com:sub': subject } }],
  ])('flags %s', (_case, conditions) => {
    expect(githubTrustViolations(roleTrusting(conditions), subject).length).toBeGreaterThan(0);
  });

  it('flags trust statements that allow more than AssumeRoleWithWebIdentity', () => {
    const template = roleTrusting({}, ['sts:AssumeRoleWithWebIdentity', 'sts:TagSession']);
    expect(githubTrustViolations(template, subject).some((v) => v.includes('only sts:AssumeRoleWithWebIdentity'))).toBe(true);
  });
});

describe('deployRoleViolations', () => {
  const roleName = production.github.deployRoleName;
  const withGrant = (statement: iam.PolicyStatement, managed = false) =>
    synth((s) => {
      const role = new iam.Role(s, 'Role', { roleName, assumedBy: new iam.AccountRootPrincipal() });
      role.addToPolicy(statement);
      if (managed) role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess'));
    });

  it('passes the real stacks', () => {
    const templates = synthesizeAll().map((s) => s.json);
    expect(deployRoleViolations(templates, roleName, WEBSITE_DEPLOY_ACTIONS)).toEqual([]);
  });

  it.each([
    ['s3:* on the bucket', new iam.PolicyStatement({ actions: ['s3:*'], resources: ['arn:aws:s3:::bucket/*'] })],
    ['object deletion', new iam.PolicyStatement({ actions: ['s3:DeleteObject'], resources: ['arn:aws:s3:::bucket/x'] })],
    ['a wildcard resource', new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: ['*'] })],
    ['DNS changes', new iam.PolicyStatement({ actions: ['route53:ChangeResourceRecordSets'], resources: ['arn:aws:route53:::hostedzone/Z1'] })],
    ['IAM administration', new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: ['arn:aws:iam::426499248998:role/x'] })],
    ['assuming the CDK roles', new iam.PolicyStatement({ actions: ['sts:AssumeRole'], resources: ['arn:aws:iam::426499248998:role/cdk-x'] })],
    ['stack changes', new iam.PolicyStatement({ actions: ['cloudformation:UpdateStack'], resources: ['arn:aws:cloudformation:us-east-1:426499248998:stack/x/*'] })],
  ])('flags %s', (_case, statement) => {
    expect(deployRoleViolations([withGrant(statement)], roleName, WEBSITE_DEPLOY_ACTIONS).length).toBeGreaterThan(0);
  });

  it('flags managed policies on the role', () => {
    const template = withGrant(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: ['arn:aws:s3:::bucket/x'] }), true);
    expect(deployRoleViolations([template], roleName, WEBSITE_DEPLOY_ACTIONS)).toEqual([
      expect.stringContaining('managed policies are not allowed'),
    ]);
  });

  it('flags grants made from another stack by role name', () => {
    const template = synth((s) => {
      new iam.Policy(s, 'Elsewhere', {
        roles: [iam.Role.fromRoleName(s, 'Imported', roleName)],
        statements: [new iam.PolicyStatement({ actions: ['iam:CreateRole'], resources: ['*'] })],
      });
    });
    expect(deployRoleViolations([template], roleName, WEBSITE_DEPLOY_ACTIONS).length).toBe(2);
  });
});
