// Proves each guardrail check actually fails on the problem it guards against,
// using stacks and templates that deliberately include offending resources.
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Template } from 'aws-cdk-lib/assertions';
import { App, CfnDynamicReference, CfnDynamicReferenceService, CfnParameter, Fn, NestedStack, RemovalPolicy, Stack } from 'aws-cdk-lib/core';
import { CloudAssembly } from 'aws-cdk-lib/cx-api';
import { afterAll, describe, expect, it } from 'vitest';
import { githubOidcSubject, production } from '../lib/config';
import {
  deployRoleViolations,
  dnsWriteViolations,
  freePlanViolations,
  freePlanWebAclViolations,
  githubTrustViolations,
  MANAGED_CACHE_POLICY_IDS,
  MANAGED_ORIGIN_REQUEST_POLICY_IDS,
  MANAGED_RESPONSE_HEADERS_POLICY_IDS,
  prohibitedResourceViolations,
  retentionViolations,
  WEBSITE_DEPLOY_ACTIONS,
} from './support/checks';
import type { CfnResource, CfnTemplate } from './support/synth';
import { PRICING_MODES, synthesizeAll, synthesizeSite, TEST_CERTIFICATE_ARN, TEST_WEB_ACL_ARN } from './support/synth';

const ZONE_ID = 'Z03492543O0YEY0RDZZ0J';
const VALIDATION_NAME = '_0123456789abcdef0123456789abcdef.zachdavids.com';

// CDK deletes its temporary cloud assemblies on process exit, which Vitest workers skip.
afterAll(() => CloudAssembly.cleanupTemporaryDirectories());

function synth(build: (stack: Stack) => void): CfnTemplate {
  const stack = new Stack(new App(), 'Offending', { env: { account: '426499248998', region: 'us-east-1' } });
  build(stack);
  return Template.fromStack(stack).toJSON() as CfnTemplate;
}

const clone = <T>(value: T): T => structuredClone(value);

describe('prohibitedResourceViolations', () => {
  const DNS = 'hosted zones, DNS records, and domains are managed outside CDK (reviewed batches in infra/dns/)';
  const DNS_WRITERS = 'Amplify domains and Cloud Map write DNS records themselves, bypassing the reviewed batches in infra/dns/';
  const CUSTOM = 'custom resources (bucket emptying, bucket deployment, cross-Region helpers) are not allowed';
  const LAMBDA = 'website stacks need no Lambda functions (and Lambda@Edge is not allowed in this project)';
  const CERTIFICATE = 'the CloudFront certificate lives in us-east-1 and is managed outside CloudFormation (ADR 0002)';
  const NESTED = 'nested stacks and Service Catalog products launch templates these guardrails do not check';
  const CLOUDFORMATION = 'other CloudFormation resource types are not checked by these guardrails';
  const EXTENSION = 'resource types outside the AWS namespace are not checked by these guardrails';
  const TRANSFORMED = 'transforms and macros rewrite the template during deployment, so these guardrails cannot see the result';
  const include = { Name: 'AWS::Include', Parameters: { Location: 's3://zachverse-snippets/dns.yaml' } };

  it('flags automatic bucket emptying (custom resource + Lambda)', () => {
    const template = synth((s) => new s3.Bucket(s, 'B', { autoDeleteObjects: true, removalPolicy: RemovalPolicy.DESTROY }));
    expect(prohibitedResourceViolations(template)).toEqual([
      `BAutoDeleteObjectsCustomResource6224D839 (Custom::S3AutoDeleteObjects): ${CUSTOM}`,
      `CustomS3AutoDeleteObjectsCustomResourceProviderHandler9D90184F (AWS::Lambda::Function): ${LAMBDA}`,
    ]);
  });

  it('flags hosted zones and website or email record sets', () => {
    const template = synth((s) => {
      const zone = new route53.PublicHostedZone(s, 'Zone', { zoneName: 'zachdavids.com' });
      new route53.ARecord(s, 'Apex', { zone, target: route53.RecordTarget.fromIpAddresses('192.0.2.1') });
      new route53.MxRecord(s, 'Mx', { zone, values: [{ priority: 1, hostName: 'aspmx.l.google.com' }] });
      new route53.TxtRecord(s, 'Spf', { zone, values: ['v=spf1 -all'] });
    });
    expect(prohibitedResourceViolations(template)).toEqual([
      `ZoneA5DE4B68 (AWS::Route53::HostedZone): ${DNS}`,
      `Apex7EB71B37 (AWS::Route53::RecordSet): ${DNS}`,
      `Mx9052D311 (AWS::Route53::RecordSet): ${DNS}`,
      `Spf455B68FA (AWS::Route53::RecordSet): ${DNS}`,
    ]);
  });

  it('flags a CloudFormation-managed certificate that would write validation records itself', () => {
    const template = synth((s) => {
      const zone = route53.HostedZone.fromHostedZoneAttributes(s, 'Zone', { hostedZoneId: ZONE_ID, zoneName: 'zachdavids.com' });
      new acm.Certificate(s, 'Cert', { domainName: 'zachdavids.com', validation: acm.CertificateValidation.fromDns(zone) });
    });
    expect(prohibitedResourceViolations(template)).toEqual([`Cert5C9FAEC1 (AWS::CertificateManager::Certificate): ${CERTIFICATE}`]);
  });

  it('flags a nested stack, whose resources (here a DNS policy) these checks cannot see', () => {
    const template = synth((s) => {
      const nested = new NestedStack(s, 'Nested');
      const policyDocument = { Statement: [{ Effect: 'Allow', Action: 'route53:*', Resource: '*' }] };
      new iam.CfnRolePolicy(nested, 'Dns', { roleName: 'deploy', policyName: 'dns', policyDocument });
    });
    expect(prohibitedResourceViolations(template)).toEqual([
      `NestedNestedStackNestedNestedStackResourceDEFDAA4D (AWS::CloudFormation::Stack): ${NESTED}`,
    ]);
  });

  it('flags a macro added to the stack, which rewrites the template after these checks run', () => {
    const template = synth((s) => {
      new s3.Bucket(s, 'B');
      s.addTransform('DnsMacro');
    });
    expect(prohibitedResourceViolations(template)).toEqual([`Transform "DnsMacro": ${TRANSFORMED}`]);
  });

  it.each<[string, object, string]>([
    ['several transforms', { Transform: ['AWS::Serverless-2016-10-31', 'DnsMacro'], Resources: {} },
      `Transform ["AWS::Serverless-2016-10-31","DnsMacro"]: ${TRANSFORMED}`],
    ['AWS::Include in place of resources', { Resources: { 'Fn::Transform': include } }, `Fn::Transform: ${TRANSFORMED}`],
    ['AWS::Include inside a resource', { Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: { 'Fn::Transform': include } } } },
      `Fn::Transform: ${TRANSFORMED}`],
  ])('flags %s', (_case, template, expected) => {
    expect(prohibitedResourceViolations(template as CfnTemplate)).toEqual([expected]);
  });

  it('only treats Fn::Transform as a transform when it is a key, not a value', () => {
    const bucket: CfnResource = { Type: 'AWS::S3::Bucket', Properties: { Tags: [{ Key: 'note', Value: 'Fn::Transform' }] } };
    expect(prohibitedResourceViolations({ Resources: { Bucket: bucket } })).toEqual([]);
  });

  it.each([
    ['AWS::Route53::RecordSetGroup', DNS],
    ['AWS::Route53::DNSSEC', DNS],
    ['AWS::Route53Domains::Domain', DNS],
    ['AWS::Amplify::Domain', DNS_WRITERS],
    ['AWS::ServiceDiscovery::PublicDnsNamespace', DNS_WRITERS],
    ['AWS::ServiceDiscovery::Service', DNS_WRITERS],
    ['Custom::BucketDeployment', CUSTOM],
    ['AWS::CloudFormation::CustomResource', CUSTOM],
    ['AWS::Lambda::Function', LAMBDA],
    ['AWS::Serverless::Function', LAMBDA],
    ['AWS::CertificateManager::Certificate', CERTIFICATE],
    ['AWS::CloudFormation::StackSet', 'StackSets are not allowed in this project'],
    ['AWS::CloudFormation::Stack', NESTED],
    ['AWS::Serverless::Application', NESTED],
    ['AWS::ServiceCatalog::CloudFormationProvisionedProduct', NESTED],
    ['AWS::ServiceCatalog::CloudFormationProduct', NESTED],
    ['AWS::ServiceCatalog::Portfolio', NESTED],
    // Every other AWS::CloudFormation type, as of aws-cdk-lib 2.273.
    ...['ChangeSet', 'GeneratedTemplate', 'GuardHook', 'HookDefaultVersion', 'HookTypeConfig', 'HookVersion', 'LambdaHook', 'Macro',
      'ModuleDefaultVersion', 'ModuleVersion', 'PublicTypeVersion', 'Publisher', 'ResourceDefaultVersion', 'ResourceVersion',
      'TypeActivation', 'WaitCondition', 'WaitConditionHandle'].map((name) => [`AWS::CloudFormation::${name}`, CLOUDFORMATION]),
    ['Cloudflare::Dns::Record', EXTENSION],
    ['Zachverse::Dns::Records::MODULE', EXTENSION],
  ])('flags %s with its reason', (type, reason) => {
    expect(prohibitedResourceViolations({ Resources: { Offender: { Type: type } } })).toEqual([`Offender (${type}): ${reason}`]);
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

  it.each([
    ['no retention policies', {}],
    ['only DeletionPolicy Retain', { DeletionPolicy: 'Retain' }],
    ['only DeletionPolicy RetainExceptOnCreate', { DeletionPolicy: 'RetainExceptOnCreate' }],
    ['only UpdateReplacePolicy Retain', { UpdateReplacePolicy: 'Retain' }],
    ['DeletionPolicy Delete', { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Retain' }],
    ['DeletionPolicy Snapshot', { DeletionPolicy: 'Snapshot', UpdateReplacePolicy: 'Retain' }],
    ['UpdateReplacePolicy Delete', { DeletionPolicy: 'RetainExceptOnCreate', UpdateReplacePolicy: 'Delete' }],
  ])('flags a resource with %s', (_case, policies) => {
    expect(retentionViolations({ Resources: { Bucket: { Type: 'AWS::S3::Bucket', ...policies } } })).toEqual([
      'Bucket (AWS::S3::Bucket) must have DeletionPolicy Retain or RetainExceptOnCreate, and UpdateReplacePolicy Retain',
    ]);
  });

  // RetainExceptOnCreate differs from Retain only when the operation that created the resource rolls back.
  it.each(['Retain', 'RetainExceptOnCreate'])(
    'accepts a resource with DeletionPolicy %s and UpdateReplacePolicy Retain',
    (deletionPolicy) => {
      const bucket = { Type: 'AWS::S3::Bucket', DeletionPolicy: deletionPolicy, UpdateReplacePolicy: 'Retain' };
      expect(retentionViolations({ Resources: { Bucket: bucket } })).toEqual([]);
    },
  );

  it('exempts CDK version-reporting metadata by its type, not its logical ID', () => {
    expect(retentionViolations({ Resources: { CDKMetadata: { Type: 'AWS::CDK::Metadata' } } })).toEqual([]);
    expect(retentionViolations({ Resources: { CDKMetadata: { Type: 'AWS::S3::Bucket' } } })).toEqual([
      'CDKMetadata (AWS::S3::Bucket) must have DeletionPolicy Retain or RetainExceptOnCreate, and UpdateReplacePolicy Retain',
    ]);
  });
});

// Operation lists from the Amazon Route 53 API Reference ("Amazon Route 53" and "Amazon Route 53
// domain registration" action lists), read 2026-10-12. IAM action names match the operation names.
const ROUTE53_API = `ActivateKeySigningKey AssociateVPCWithHostedZone ChangeCidrCollection ChangeResourceRecordSets
  ChangeTagsForResource CreateCidrCollection CreateHealthCheck CreateHostedZone CreateKeySigningKey CreateQueryLoggingConfig
  CreateReusableDelegationSet CreateTrafficPolicy CreateTrafficPolicyInstance CreateTrafficPolicyVersion
  CreateVPCAssociationAuthorization DeactivateKeySigningKey DeleteCidrCollection DeleteHealthCheck DeleteHostedZone
  DeleteKeySigningKey DeleteQueryLoggingConfig DeleteReusableDelegationSet DeleteTrafficPolicy DeleteTrafficPolicyInstance
  DeleteVPCAssociationAuthorization DisableHostedZoneDNSSEC DisassociateVPCFromHostedZone EnableHostedZoneDNSSEC
  GetAccountLimit GetChange GetCheckerIpRanges GetDNSSEC GetGeoLocation GetHealthCheck GetHealthCheckCount
  GetHealthCheckLastFailureReason GetHealthCheckStatus GetHostedZone GetHostedZoneCount GetHostedZoneLimit
  GetQueryLoggingConfig GetReusableDelegationSet GetReusableDelegationSetLimit GetTrafficPolicy GetTrafficPolicyInstance
  GetTrafficPolicyInstanceCount ListCidrBlocks ListCidrCollections ListCidrLocations ListGeoLocations ListHealthChecks
  ListHostedZones ListHostedZonesByName ListHostedZonesByVPC ListQueryLoggingConfigs ListResourceRecordSets
  ListReusableDelegationSets ListTagsForResource ListTagsForResources ListTrafficPolicies ListTrafficPolicyInstances
  ListTrafficPolicyInstancesByHostedZone ListTrafficPolicyInstancesByPolicy ListTrafficPolicyVersions
  ListVPCAssociationAuthorizations TestDNSAnswer UpdateHealthCheck UpdateHostedZoneComment UpdateHostedZoneFeatures
  UpdateTrafficPolicyComment UpdateTrafficPolicyInstance`.split(/\s+/).map((op) => `route53:${op}`);
const ROUTE53_DOMAINS_API = `AcceptDomainTransferFromAnotherAwsAccount AssociateDelegationSignerToDomain
  CancelDomainTransferToAnotherAwsAccount CheckDomainAvailability CheckDomainTransferability DeleteDomain DeleteTagsForDomain
  DisableDomainAutoRenew DisableDomainTransferLock DisassociateDelegationSignerFromDomain EnableDomainAutoRenew
  EnableDomainTransferLock GetContactReachabilityStatus GetDomainDetail GetDomainSuggestions GetOperationDetail ListDomains
  ListOperations ListPrices ListTagsForDomain PushDomain RegisterDomain RejectDomainTransferFromAnotherAwsAccount RenewDomain
  ResendContactReachabilityEmail ResendOperationAuthorization RetrieveDomainAuthCode TransferDomain
  TransferDomainToAnotherAwsAccount UpdateDomainContact UpdateDomainContactPrivacy UpdateDomainNameservers
  UpdateTagsForDomain ViewBilling`.split(/\s+/).map((op) => `route53domains:${op}`);
const isRead = (action: string) => /:(Get|List|Check|Test|View)/.test(action);
const ROUTE53_WRITES = ROUTE53_API.filter((a) => !isRead(a));
const ROUTE53_DOMAINS_WRITES = ROUTE53_DOMAINS_API.filter((a) => !isRead(a));

describe('dnsWriteViolations', () => {
  const allowance = { hostedZoneId: ZONE_ID, validationRecordNames: [VALIDATION_NAME] };
  const zoneArn = `arn:aws:route53:::hostedzone/${ZONE_ID}`;
  const lambda = new iam.ServicePrincipal('lambda.amazonaws.com');
  const POLICY = 'RoleDefaultPolicy5FFB7DAB';
  const NAMES = `${POLICY}: record names must be limited to the exact ACM validation names`;
  const TYPES = `${POLICY}: record types must be limited to CNAME`;
  const CHANGES = `${POLICY}: change actions must be limited to CREATE/UPSERT`;
  const computedAction = (where: string) => `${where}: Allow with a computed or missing Action is too broad to verify`;
  const grants = (where: string, actions: string[]) => `${where}: grants Route 53 write access (${[...actions].sort().join(', ')})`;
  /** A validation name of the right shape that the allowance does not list, as another account's request would have. */
  const UNLISTED_NAME = '_ffffffffffffffffffffffffffffffff.zachdavids.com';
  /** ChangeResourceRecordSets scoped like the ACM validation allowance; override one part to break it. */
  const recordChanges = ({
    resource = zoneArn,
    names = [VALIDATION_NAME],
    types = ['CNAME'],
    actions = ['UPSERT'],
    operator = 'ForAllValues:StringEquals',
  } = {}) =>
    new iam.PolicyStatement({
      actions: ['route53:ChangeResourceRecordSets'],
      resources: [resource],
      conditions: {
        [operator]: {
          'route53:ChangeResourceRecordSetsNormalizedRecordNames': names,
          'route53:ChangeResourceRecordSetsRecordTypes': types,
          'route53:ChangeResourceRecordSetsActions': actions,
        },
      },
    });
  const roleWith = (...statements: iam.PolicyStatement[]) =>
    synth((s) => {
      const role = new iam.Role(s, 'Role', { assumedBy: lambda });
      statements.forEach((st) => role.addToPolicy(st));
    });
  /** A raw template with one standalone policy, for shapes CDK will not generate. */
  const policy = (...statements: object[]): CfnTemplate => ({
    Resources: { Policy: { Type: 'AWS::IAM::Policy', Properties: { PolicyDocument: { Statement: statements } } } },
  });
  const allow = (action: unknown) => policy({ Effect: 'Allow', Action: action, Resource: '*' });
  const resource = (Type: string, Properties: Record<string, unknown>): CfnResource => ({ Type, Properties });
  const dnsAll = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'route53:*', Resource: '*' }] };

  it('accepts a statement limited to exact validation names, CNAME, and UPSERT', () => {
    expect(dnsWriteViolations(roleWith(recordChanges()), allowance)).toEqual([]);
  });

  it('flags any DNS write when no validation names are allowed', () => {
    expect(dnsWriteViolations(roleWith(recordChanges()))).toEqual([
      grants(POLICY, ['route53:ChangeResourceRecordSets']),
    ]);
  });

  it('accepts CREATE as well as UPSERT', () => {
    expect(dnsWriteViolations(roleWith(recordChanges({ actions: ['CREATE', 'UPSERT'] })), allowance)).toEqual([]);
  });

  it('reads allowance names in any case, with or without the trailing dot', () => {
    const loose = { hostedZoneId: ZONE_ID, validationRecordNames: [`${VALIDATION_NAME.toUpperCase()}.`] };
    expect(dnsWriteViolations(roleWith(recordChanges()), loose)).toEqual([]);
  });

  // The site certificate's validation names are _<32 hex digits> on the apex or www; the allowance drops anything else.
  it.each([
    ['a website name', 'www.zachdavids.com'],
    ['a label too short for a validation token', '_ab.zachdavids.com'],
    ['31 hex digits', '_123456789abcdef0123456789abcdef.zachdavids.com'],
    ['33 hex digits', '_0123456789abcdef0123456789abcdef0.zachdavids.com'],
    ['a letter that is not hex', '_0123456789abcdef0123456789abcdeg.zachdavids.com'],
    ['a host other than the apex and www', '_0123456789abcdef0123456789abcdef.mail.zachdavids.com'],
  ])('ignores allowance names that are not ACM validation names: %s', (_case, name) => {
    const other = { hostedZoneId: ZONE_ID, validationRecordNames: [name] };
    expect(dnsWriteViolations(roleWith(recordChanges({ names: [name] })), other)).toEqual([NAMES]);
  });

  it.each([
    ['broad actions', new iam.PolicyStatement({ actions: ['route53:*'], resources: [zoneArn] }), [grants(POLICY, ROUTE53_WRITES)]],
    [
      'full admin',
      new iam.PolicyStatement({ actions: ['*'], resources: ['*'] }),
      [grants(POLICY, [...ROUTE53_WRITES, ...ROUTE53_DOMAINS_WRITES])],
    ],
    [
      'domain registration',
      new iam.PolicyStatement({ actions: ['route53domains:*'], resources: ['*'] }),
      [grants(POLICY, ROUTE53_DOMAINS_WRITES)],
    ],
    [
      'unconditioned record changes',
      new iam.PolicyStatement({ actions: ['route53:ChangeResourceRecordSets'], resources: [zoneArn] }),
      [NAMES, TYPES, CHANGES],
    ],
    // ForAnyValue holds when any one requested value is listed, so one batch could also DELETE the MX records.
    ['record conditions under ForAnyValue', recordChanges({ operator: 'ForAnyValue:StringEquals' }), [NAMES, TYPES, CHANGES]],
    ['record conditions without a set operator', recordChanges({ operator: 'StringEquals' }), [NAMES, TYPES, CHANGES]],
    [
      'record types and change actions under ForAnyValue',
      new iam.PolicyStatement({
        actions: ['route53:ChangeResourceRecordSets'],
        resources: [zoneArn],
        conditions: {
          'ForAllValues:StringEquals': { 'route53:ChangeResourceRecordSetsNormalizedRecordNames': [VALIDATION_NAME] },
          'ForAnyValue:StringEquals': {
            'route53:ChangeResourceRecordSetsRecordTypes': ['CNAME'],
            'route53:ChangeResourceRecordSetsActions': ['UPSERT'],
          },
        },
      }),
      [TYPES, CHANGES],
    ],
    ['wildcard record names', recordChanges({ names: ['*.zachdavids.com'] }), [NAMES]],
    ['a validation name next to a website name', recordChanges({ names: [VALIDATION_NAME, 'www.zachdavids.com'] }), [NAMES]],
    // ACM makes each validation name for one account's request, so only the exact names listed may change.
    ['a validation name the allowance does not list', recordChanges({ names: [UNLISTED_NAME] }), [NAMES]],
    ['a listed validation name next to an unlisted one', recordChanges({ names: [VALIDATION_NAME, UNLISTED_NAME] }), [NAMES]],
    ['an unlisted www validation name', recordChanges({ names: ['_ffffffffffffffffffffffffffffffff.www.zachdavids.com'] }), [NAMES]],
    // IAM compares the normalized (lower-case, dotless) names case-sensitively, so these never match.
    ['a validation name with a trailing dot', recordChanges({ names: [`${VALIDATION_NAME}.`] }), [NAMES]],
    ['a validation name in upper case', recordChanges({ names: [VALIDATION_NAME.toUpperCase()] }), [NAMES]],
    ['MX/TXT changes', recordChanges({ types: ['CNAME', 'MX', 'TXT'], actions: ['UPSERT', 'DELETE'] }), [TYPES, CHANGES]],
    [
      'every hosted zone',
      (() => { const st = recordChanges(); st.addResources('arn:aws:route53:::hostedzone/*'); return st; })(),
      [`${POLICY}: Resource must be exactly ${zoneArn}`],
    ],
    [
      'another hosted zone',
      recordChanges({ resource: 'arn:aws:route53:::hostedzone/Z111111111111' }),
      [`${POLICY}: Resource must be exactly ${zoneArn}`],
    ],
    [
      'other Route 53 actions next to the record change',
      (() => { const st = recordChanges(); st.addActions('route53:GetChange'); return st; })(),
      [grants(POLICY, ['route53:ChangeResourceRecordSets'])],
    ],
    [
      'other Route 53 actions in another letter case next to the record change',
      (() => { const st = recordChanges(); st.addActions('ROUTE53:GetChange'); return st; })(),
      [grants(POLICY, ['route53:ChangeResourceRecordSets'])],
    ],
    [
      'Route 53 Domains actions next to the record change',
      (() => { const st = recordChanges(); st.addActions('route53domains:GetDomainDetail'); return st; })(),
      [grants(POLICY, ['route53:ChangeResourceRecordSets'])],
    ],
    [
      'a Route 53 action missing from its list next to the record change',
      (() => { const st = recordChanges(); st.addActions('route53:FutureWriteAction'); return st; })(),
      [grants(POLICY, ['route53:ChangeResourceRecordSets', 'route53:FutureWriteAction'])],
    ],
    [
      // The record-name conditions do not apply to other actions, so this would allow DeleteHostedZone.
      'every other action next to the record change',
      (() => { const st = recordChanges(); st.addActions('*'); return st; })(),
      [grants(POLICY, [...ROUTE53_WRITES, ...ROUTE53_DOMAINS_WRITES])],
    ],
    ['TXT-only changes', recordChanges({ types: ['TXT'] }), [TYPES]],
  ])('flags %s', (_case, statement, expected) => {
    expect(dnsWriteViolations(roleWith(statement), allowance)).toEqual(expected);
  });

  // A pattern also grants actions added later, which the record conditions do not limit (ForAllValues holds
  // for a request that has none of their keys); IAM matches wildcards in the service prefix too.
  it.each([
    'route53:ChangeResourceRecordSet*',
    'route53:ChangeResourceRecordSet?',
    'route53:Change*Sets',
    '*:ChangeResourceRecordSets',
    'route5?:ChangeResourceRecordSet*',
  ])('flags the record change granted by the pattern %s, even with the allowance', (action) => {
    const statement = { ...recordChanges().toStatementJson(), Action: action };
    expect(dnsWriteViolations(policy(statement), allowance)).toEqual([grants('Policy', ['route53:ChangeResourceRecordSets'])]);
  });

  it('accepts actions outside Route 53 next to the exact record change', () => {
    const statement = recordChanges();
    statement.addActions('s3:GetObject');
    expect(dnsWriteViolations(roleWith(statement), allowance)).toEqual([]);
  });

  it('flags wildcard record names even when the allowance lists them', () => {
    const statement = recordChanges({ names: ['*.zachdavids.com'] });
    const wildcardAllowance = { hostedZoneId: ZONE_ID, validationRecordNames: ['*.zachdavids.com'] };
    expect(dnsWriteViolations(roleWith(statement), wildcardAllowance)).toEqual([NAMES]);
  });

  it('ignores Deny statements', () => {
    const deny = new iam.PolicyStatement({ effect: iam.Effect.DENY, actions: ['route53:*', 'route53domains:*'], resources: ['*'] });
    expect(dnsWriteViolations(roleWith(deny))).toEqual([]);
  });

  it.each([
    ['an Fn::If', { 'Fn::If': ['IsProd', 'Deny', 'Allow'] }],
    ['a dynamic reference', '{{resolve:ssm:/zachverse/effect}}'],
  ])('treats a computed Effect (%s) as Allow', (_case, effect) => {
    const statement = { Effect: effect, Action: 'route53:CreateHostedZone', Resource: '*' };
    expect(dnsWriteViolations(policy(statement))).toEqual([grants('Policy', ['route53:CreateHostedZone'])]);
  });

  it('flags Allow with NotAction, which grants every action not listed', () => {
    const statement = new iam.PolicyStatement({ notActions: ['s3:*'], resources: ['*'] });
    expect(dnsWriteViolations(roleWith(statement), allowance)).toEqual([
      `${POLICY}: Allow with NotAction is too broad to verify`,
    ]);
  });

  it('flags an Action it cannot read: a CloudFormation token, or a statement wrapped in Fn::If', () => {
    const imported = new iam.PolicyStatement({ actions: [Fn.importValue('DnsActions')], resources: ['*'] });
    expect(dnsWriteViolations(roleWith(imported))).toEqual([computedAction(POLICY)]);
    const conditional = { 'Fn::If': ['GrantDns', { Effect: 'Allow', Action: 'route53:*', Resource: '*' }, { Ref: 'AWS::NoValue' }] };
    expect(dnsWriteViolations(policy(conditional))).toEqual([computedAction('Policy')]);
  });

  // CloudFormation resolves {{resolve:...}} during deployment, so the deployed action could be route53:* or *.
  it.each([
    ['an SSM parameter', CfnDynamicReferenceService.SSM, '/zachverse/ops-actions'],
    ['a Secrets Manager secret', CfnDynamicReferenceService.SECRETS_MANAGER, 'dns:SecretString:action'],
  ])('flags an Action that a dynamic reference reads from %s', (_case, service, key) => {
    const action = new CfnDynamicReference(service, key).toString();
    expect(dnsWriteViolations(roleWith(new iam.PolicyStatement({ actions: [action], resources: ['*'] })))).toEqual([
      computedAction(POLICY),
    ]);
  });

  // CloudFormation substitutes a reference anywhere in the string, so a literal prefix does not limit the action:
  // these could deploy as *:* or route53:*.
  it.each(['*{{resolve:ssm:/zachverse/suffix}}', 'route53:{{resolve:ssm:/zachverse/action}}'])(
    'flags the Action %s, a dynamic reference after a literal prefix',
    (action) => {
      expect(dnsWriteViolations(allow(action))).toEqual([computedAction('Policy')]);
    },
  );

  it('flags a dynamic reference among literal actions, even next to a record change the allowance accepts', () => {
    expect(dnsWriteViolations(allow(['s3:GetObject', '{{resolve:ssm:/zachverse/more-actions:3}}']))).toEqual([computedAction('Policy')]);
    const statement = recordChanges();
    statement.addActions(new CfnDynamicReference(CfnDynamicReferenceService.SSM, '/zachverse/extra-actions').toString());
    expect(dnsWriteViolations(roleWith(statement), allowance)).toEqual([computedAction(POLICY)]);
  });

  it.each<[string, CfnResource, string]>([
    ['a policy document wrapped in Fn::If',
      resource('AWS::IAM::Policy', { PolicyDocument: { 'Fn::If': ['GrantDns', dnsAll, { Ref: 'AWS::NoValue' }] } }), 'Offender'],
    ['a policy document given as a JSON string', resource('AWS::IAM::ManagedPolicy', { PolicyDocument: JSON.stringify(dnsAll) }), 'Offender'],
    ['a policy without a document', resource('AWS::IAM::RolePolicy', { PolicyName: 'dns', RoleName: 'deploy' }), 'Offender'],
    ['an inline policy wrapped in Fn::If',
      resource('AWS::IAM::Role', { Policies: [{ 'Fn::If': ['GrantDns', { PolicyName: 'dns', PolicyDocument: dnsAll }, { Ref: 'AWS::NoValue' }] }] }),
      'Offender/(computed)'],
    ['a list of inline policies wrapped in Fn::If',
      resource('AWS::IAM::User', { Policies: { 'Fn::If': ['GrantDns', [{ PolicyName: 'dns', PolicyDocument: dnsAll }], []] } }),
      'Offender/(computed)'],
  ])('flags %s, which it cannot read', (_case, offender, where) => {
    expect(dnsWriteViolations({ Resources: { Offender: offender } })).toEqual([
      `${where}: a computed or missing PolicyDocument cannot be verified`,
    ]);
  });

  it('ignores Allow statements that grant no Route 53 write, including read-only Route 53 access', () => {
    const reads = new iam.PolicyStatement({
      actions: ['s3:GetObject', 'route53:Get*', 'route53:List*', 'route53:TestDNSAnswer', 'route53domains:Check*', 'route53domains:ViewBilling'],
      resources: ['*'],
    });
    expect(dnsWriteViolations(roleWith(reads))).toEqual([]);
  });

  it('reads a single Statement object and a single-string Action', () => {
    const template: CfnTemplate = {
      Resources: {
        Policy: {
          Type: 'AWS::IAM::ManagedPolicy',
          Properties: { PolicyDocument: { Statement: { Effect: 'Allow', Action: 'route53:DeleteHostedZone', Resource: '*' } } },
        },
      },
    };
    expect(dnsWriteViolations(template)).toEqual([grants('Policy', ['route53:DeleteHostedZone'])]);
  });

  it.each([
    ['? as one character in the action name', 'route53:ChangeResourceRecordSet?', 'route53:ChangeResourceRecordSets'],
    ['? as one character in the service prefix', 'route5?:CreateHostedZone', 'route53:CreateHostedZone'],
    ['? in a Route 53 Domains action', 'route53domains:TransferDomai?', 'route53domains:TransferDomain'],
    ['a different letter case', 'ROUTE53:createhostedzone', 'route53:CreateHostedZone'],
    ['* matching nothing at the end', 'route53:ChangeResourceRecordSets*', 'route53:ChangeResourceRecordSets'],
    ['* matching nothing at the start of the action name', 'route53:*DeleteHostedZone', 'route53:DeleteHostedZone'],
    ['* matching nothing inside the action name', 'route53:Delete*HostedZone', 'route53:DeleteHostedZone'],
  ])('matches actions the way IAM does: %s', (_case, pattern, granted) => {
    expect(dnsWriteViolations(allow(pattern))).toEqual([grants('Policy', [granted])]);
  });

  it.each([
    ['? as exactly one character', 'route53:CreateHostedZon??'],
    // As a regular expression, `.` would match the Z of CreateHostedZone.
    ['other characters literally', 'route53:CreateHosted.on*'],
  ])('matches %s', (_case, pattern) => {
    expect(dnsWriteViolations(allow(pattern))).toEqual([]);
  });

  it('flags Route 53 actions missing from its list when granted by name, such as newer ones', () => {
    const actions = ['route53:FutureWriteAction', 'ROUTE53DOMAINS:FutureWriteAction', 'route53:DeleteHostedZone'];
    expect(dnsWriteViolations(allow(actions))).toEqual([grants('Policy', actions)]);
  });

  it('treats unknown Route 53 actions named like reads as reads', () => {
    expect(dnsWriteViolations(allow(['route53:GetFutureThing', 'route53domains:ListFutureThings']))).toEqual([]);
  });

  it('flags unknown Route 53 actions with a read verb after the first word', () => {
    // Only a name that starts with a read verb is a read. These contain Check, List, and (ignoring case, as IAM does) get.
    const actions = [
      'route53:CreateHealthCheckAlarm',
      'route53:UpdateTrafficTarget',
      'route53:ChangeTrafficPolicyTags',
      'route53domains:UpdateDomainListing',
    ];
    expect(dnsWriteViolations(allow(actions))).toEqual([grants('Policy', actions)]);
  });

  it('flags DNS write granted through inline policies of roles, users, and groups', () => {
    const template = synth((s) => {
      const dns = new iam.PolicyDocument({
        statements: [new iam.PolicyStatement({ actions: ['route53:ChangeResourceRecordSets'], resources: ['*'] })],
      });
      new iam.Role(s, 'Role', { assumedBy: lambda, inlinePolicies: { Dns: dns } });
      new iam.CfnUser(s, 'User', { policies: [{ policyName: 'Dns', policyDocument: dns }] });
      new iam.CfnGroup(s, 'Group', { policies: [{ policyName: 'Dns', policyDocument: dns }] });
    });
    expect(dnsWriteViolations(template)).toEqual([
      grants('Role1ABCC5F0/Dns', ['route53:ChangeResourceRecordSets']),
      grants('User/Dns', ['route53:ChangeResourceRecordSets']),
      grants('Group/Dns', ['route53:ChangeResourceRecordSets']),
    ]);
  });

  it('flags DNS write granted by standalone role, user, and group policy resources', () => {
    const template = synth((s) => {
      const policyDocument = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'route53:*', Resource: '*' }] };
      new iam.CfnRolePolicy(s, 'RolePolicy', { roleName: 'deploy', policyName: 'dns', policyDocument });
      new iam.CfnUserPolicy(s, 'UserPolicy', { userName: 'ops', policyName: 'dns', policyDocument });
      new iam.CfnGroupPolicy(s, 'GroupPolicy', { groupName: 'ops', policyName: 'dns', policyDocument });
    });
    expect(dnsWriteViolations(template)).toEqual([
      grants('RolePolicy', ROUTE53_WRITES),
      grants('UserPolicy', ROUTE53_WRITES),
      grants('GroupPolicy', ROUTE53_WRITES),
    ]);
  });

  it('treats users and groups without properties as granting nothing', () => {
    const template = synth((s) => {
      new iam.User(s, 'User');
      new iam.Group(s, 'Group');
    });
    expect(template.Resources).toEqual({ User00B015A1: { Type: 'AWS::IAM::User' }, GroupC77FDACD: { Type: 'AWS::IAM::Group' } });
    expect(dnsWriteViolations(template)).toEqual([]);
  });

  it('flags managed policies attached from outside the stack, which it cannot inspect', () => {
    const template = synth((s) => {
      new iam.Role(s, 'Role', { assumedBy: lambda, managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')] });
      new iam.CfnUser(s, 'User', {
        managedPolicyArns: ['arn:aws:iam::aws:policy/AmazonRoute53FullAccess', new CfnParameter(s, 'PolicyArn').valueAsString],
      });
      new iam.CfnGroup(s, 'Group', { managedPolicyArns: [Fn.importValue('SharedPolicyArn')] });
    });
    const unverifiable = (where: string, arn: unknown) =>
      `${where}: managed policy ${JSON.stringify(arn)} is not defined in this stack, so it cannot be verified`;
    expect(dnsWriteViolations(template)).toEqual([
      unverifiable('Role1ABCC5F0', { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/AdministratorAccess']] }),
      unverifiable('User', 'arn:aws:iam::aws:policy/AmazonRoute53FullAccess'),
      unverifiable('User', { Ref: 'PolicyArn' }),
      unverifiable('Group', { 'Fn::ImportValue': 'SharedPolicyArn' }),
    ]);
  });

  it('flags a managed policy ARN taken from an in-stack resource that is not a managed policy', () => {
    // A custom resource can return any ARN as its physical ID.
    const template: CfnTemplate = {
      Resources: {
        Arn: { Type: 'Custom::PolicyArn', Properties: {} },
        Role: { Type: 'AWS::IAM::Role', Properties: { ManagedPolicyArns: [{ Ref: 'Arn' }] } },
      },
    };
    expect(dnsWriteViolations(template)).toEqual([
      'Role: managed policy {"Ref":"Arn"} is not defined in this stack, so it cannot be verified',
    ]);
  });

  it('flags users joining groups defined outside the stack, whose policies it cannot inspect', () => {
    const template = synth((s) => {
      const local = new iam.Group(s, 'Local');
      new iam.User(s, 'Ci', { groups: [iam.Group.fromGroupName(s, 'Admins', 'Admins'), local] });
      new iam.CfnUserToGroupAddition(s, 'AddToAdmins', { groupName: 'Admins', users: ['ci'] });
      new iam.CfnUserToGroupAddition(s, 'AddToLocal', { groupName: local.groupName, users: ['ci'] });
    });
    expect(dnsWriteViolations(template)).toEqual([
      'CiA080E7EE: group "Admins" is not defined in this stack, so it cannot be verified',
      'AddToAdmins: group "Admins" is not defined in this stack, so it cannot be verified',
    ]);
  });

  it('flags IAM Identity Center resources, which grant permissions outside IAM policies', () => {
    const permissionSet = resource('AWS::SSO::PermissionSet', {
      Name: 'Admins',
      InstanceArn: 'arn:aws:sso:::instance/ssoins-0000000000000000',
      ManagedPolicies: ['arn:aws:iam::aws:policy/AdministratorAccess'],
    });
    expect(dnsWriteViolations({ Resources: { Admins: permissionSet } })).toEqual([
      'Admins (AWS::SSO::PermissionSet): IAM Identity Center permissions cannot be verified',
    ]);
  });

  it('checks managed policies defined in the stack through their own documents', () => {
    const template = synth((s) => {
      const read = new iam.ManagedPolicy(s, 'ReadDns', {
        statements: [new iam.PolicyStatement({ actions: ['route53:GetHostedZone'], resources: ['*'] })],
      });
      const write = new iam.ManagedPolicy(s, 'WriteDns', {
        statements: [new iam.PolicyStatement({ actions: ['route53:ChangeResourceRecordSets'], resources: ['*'] })],
      });
      new iam.Role(s, 'Role', { assumedBy: lambda, managedPolicies: [read, write] });
    });
    expect(dnsWriteViolations(template)).toEqual([grants('WriteDns11BF3E76', ['route53:ChangeResourceRecordSets'])]);
  });

  describe('across the whole Route 53 and Route 53 Domains APIs', () => {
    it.each([...ROUTE53_WRITES, ...ROUTE53_DOMAINS_WRITES])('flags %s', (action) => {
      expect(dnsWriteViolations(allow(action))).toEqual([grants('Policy', [action])]);
    });

    it.each([...ROUTE53_API, ...ROUTE53_DOMAINS_API].filter(isRead))('allows read-only %s', (action) => {
      expect(dnsWriteViolations(allow(action))).toEqual([]);
    });
  });
});

// Both pricing modes, so no test depends on whether production has a web ACL yet.
describe.each(Object.entries(PRICING_MODES))('freePlanViolations (%s)', (_mode, config) => {
  const site = synthesizeSite(config).json;
  const DIST = 'SiteDistribution3FF9535D';
  const FN = 'ViewerRequestFunction48E73F66';
  const ORIGIN: string = site.Resources[DIST]!.Properties!.DistributionConfig.Origins[0].Id;
  const API_ORIGIN = { Id: 'Api', DomainName: 'api.example.com', CustomOriginConfig: { OriginProtocolPolicy: 'https-only' } };
  const mutate = (fn: (config: any, template: CfnTemplate) => void) => {
    const template = clone(site);
    fn(template.Resources[DIST]!.Properties!.DistributionConfig, template);
    return freePlanViolations(template);
  };

  it('passes the real site stack', () => {
    expect(freePlanViolations(site)).toEqual([]);
  });

  it.each<[string, (config: any, template: CfnTemplate) => unknown, string]>([
    ['standard access logging', (c) => (c.Logging = { Bucket: 'logs.s3.amazonaws.com' }), `${DIST}: Logging: access logs need Pro or higher`],
    ['continuous deployment', (c) => (c.ContinuousDeploymentPolicyId = 'cdp-1'),
      `${DIST}: ContinuousDeploymentPolicyId: continuous deployment is unsupported`],
    ['an Anycast IP list', (c) => (c.AnycastIpListId = 'aip-1'), `${DIST}: AnycastIpListId: Anycast IP lists are unsupported`],
    ['origin failover groups', (c) => (c.OriginGroups = { Quantity: 1, Items: [] }), `${DIST}: OriginGroups: origin failover needs Premium`],
    ['a tenant config', (c) => (c.TenantConfig = { ParameterDefinitions: [] }),
      `${DIST}: TenantConfig: multi-tenant distributions are unsupported`],
    ['a legacy S3Origin', (c) => (c.S3Origin = { DNSName: 'b.s3.amazonaws.com' }), `${DIST}: S3Origin: legacy origin settings are unsupported`],
    ['a legacy CustomOrigin', (c) => (c.CustomOrigin = { DNSName: 'example.com', OriginProtocolPolicy: 'https-only' }),
      `${DIST}: CustomOrigin: legacy origin settings are unsupported`],
    ['legacy CNAMEs', (c) => (c.CNAMEs = ['zachdavids.com']), `${DIST}: CNAMEs: legacy CNAMEs setting is unsupported; use Aliases`],
    ['a staging distribution', (c) => (c.Staging = true), `${DIST}: staging distributions are unsupported`],
    ['a tenant-only connection mode', (c) => (c.ConnectionMode = 'tenant-only'), `${DIST}: multi-tenant distributions are unsupported`],
    ['an IAM server certificate', (c) => (c.ViewerCertificate.IamCertificateId = 'ASCAEXAMPLE'),
      `${DIST}: IAM server certificates are unsupported; use ACM`],
    ['dedicated IP SSL', (c) => (c.ViewerCertificate.SslSupportMethod = 'vip'), `${DIST}: dedicated IP SSL is unsupported`],
    ['viewer mutual TLS', (c) => (c.ViewerMtlsConfig = { Mode: 'required', TrustStoreConfig: { TrustStoreId: 'ts-1' } }),
      `${DIST}: ViewerMtlsConfig: viewer mutual TLS needs Premium`],
    ['a connection function', (c) => (c.ConnectionFunctionAssociation = { Id: 'cf-1' }),
      `${DIST}: ConnectionFunctionAssociation: connection functions (viewer mutual TLS) need Premium`],
    ['cache-tag invalidation', (c) => (c.CacheTagConfig = { HeaderName: 'Cache-Tag' }),
      `${DIST}: CacheTagConfig: cache-tag invalidation needs Pro or higher`],
    ['origin mutual TLS', (c) => c.Origins.push({
      ...API_ORIGIN,
      CustomOriginConfig: { ...API_ORIGIN.CustomOriginConfig, OriginMtlsConfig: { ClientCertificateArn: TEST_CERTIFICATE_ARN } },
    }), `${DIST} origin Api: origin mutual TLS needs Business or higher`],
    ['more than five cache behaviors',
      (c) => (c.CacheBehaviors = Array.from({ length: 5 }, (_, i) => ({ ...c.DefaultCacheBehavior, PathPattern: `/p${i}/*` }))),
      `${DIST}: 6 cache behaviors exceeds the Free limit of 5`],
    ['a cloudfront-js-1.0 function', (_c, t) => (t.Resources[FN]!.Properties!.FunctionConfig.Runtime = 'cloudfront-js-1.0'),
      `${DIST} behavior default: ${FN} must use runtime cloudfront-js-2.0`],
    ['a function that declares no runtime', (_c, t) => delete t.Resources[FN]!.Properties!.FunctionConfig,
      `${DIST} behavior default: ${FN} must use runtime cloudfront-js-2.0`],
    ['a KeyValueStore association', (_c, t) => (t.Resources[FN]!.Properties!.FunctionConfig.KeyValueStoreAssociations = [
      { KeyValueStoreARN: 'arn:aws:cloudfront::1:key-value-store/x' },
    ]), `${DIST} behavior default: ${FN}: KeyValueStore needs Pro or higher`],
  ])('flags %s', (_case, fn, expected) => {
    expect(mutate(fn)).toEqual([expected]);
  });

  // Every cache behavior is checked, not only the default: the second run adds a path behavior copied from it.
  describe.each<[string, (config: any) => any]>([
    ['default', (c) => c.DefaultCacheBehavior],
    ['/api/*', (c) => (c.CacheBehaviors = [{ ...clone(c.DefaultCacheBehavior), PathPattern: '/api/*' }])[0]],
  ])('on the %s cache behavior', (label, behaviorIn) => {
    /** Points the behavior at its own CloudFront Function with this config, which no other behavior uses. */
    const ownFunction = (behavior: any, template: CfnTemplate, FunctionConfig: object) => {
      template.Resources.OwnFunction = { Type: 'AWS::CloudFront::Function', Properties: { FunctionConfig } };
      behavior.FunctionAssociations = [{ EventType: 'viewer-request', FunctionARN: { 'Fn::GetAtt': ['OwnFunction', 'FunctionARN'] } }];
    };

    // Each policy ID is tried as an intrinsic and as a literal, the form a custom policy imported by ID takes.
    it.each<[string, (behavior: any, template: CfnTemplate) => unknown, string]>([
      ['a custom cache policy', (b) => (b.CachePolicyId = { Ref: 'MyCachePolicy' }), 'CachePolicyId must be an AWS-managed policy ID'],
      ['an unknown cache policy', (b) => (b.CachePolicyId = 'not-managed'), 'CachePolicyId must be an AWS-managed policy ID'],
      ['an imported origin request policy', (b) => (b.OriginRequestPolicyId = { 'Fn::ImportValue': 'SharedOriginRequestPolicyId' }),
        'OriginRequestPolicyId must be an AWS-managed policy ID'],
      ['an unknown origin request policy', (b) => (b.OriginRequestPolicyId = 'not-managed'), 'OriginRequestPolicyId must be an AWS-managed policy ID'],
      ['a custom response headers policy', (b) => (b.ResponseHeadersPolicyId = { Ref: 'X' }),
        'ResponseHeadersPolicyId must be an AWS-managed policy ID'],
      ['an unknown response headers policy', (b) => (b.ResponseHeadersPolicyId = 'not-managed'),
        'ResponseHeadersPolicyId must be an AWS-managed policy ID'],
      ['real-time logs', (b) => (b.RealtimeLogConfigArn = 'arn:aws:cloudfront::1:realtime-log-config/x'),
        'real-time logs are unsupported on pricing plans'],
      // An existing Lambda@Edge version adds no Lambda resource, so only this check sees it.
      ['Lambda@Edge', (b) => (b.LambdaFunctionAssociations = [
        { EventType: 'origin-request', LambdaFunctionARN: 'arn:aws:lambda:us-east-1:426499248998:function:edge:3' },
      ]), 'Lambda@Edge is not allowed in this project'],
      ['a function association by literal ARN', (b) => (b.FunctionAssociations[0].FunctionARN = 'arn:aws:cloudfront::426499248998:function/other'),
        'function associations must reference a CloudFront Function defined in this stack'],
      ['a function association to a resource that is not a CloudFront Function',
        (b) => (b.FunctionAssociations[0].FunctionARN = { 'Fn::GetAtt': ['SiteBucket397A1860', 'Arn'] }),
        'function associations must reference a CloudFront Function defined in this stack'],
      ['a function on cloudfront-js-1.0', (b, t) => ownFunction(b, t, { Runtime: 'cloudfront-js-1.0' }),
        'OwnFunction must use runtime cloudfront-js-2.0'],
      ['a function with a KeyValueStore', (b, t) => ownFunction(b, t, {
        Runtime: 'cloudfront-js-2.0',
        KeyValueStoreAssociations: [{ KeyValueStoreARN: 'arn:aws:cloudfront::1:key-value-store/x' }],
      }), 'OwnFunction: KeyValueStore needs Pro or higher'],
    ])('flags %s', (_case, fn, expected) => {
      expect(mutate((c, t) => fn(behaviorIn(c), t))).toEqual([`${DIST} behavior ${label}: ${expected}`]);
    });

    it.each(['ForwardedValues', 'MinTTL', 'DefaultTTL', 'MaxTTL', 'TrustedSigners', 'FieldLevelEncryptionId'])(
      'flags the legacy cache behavior setting %s',
      (setting) => {
        expect(mutate((c) => (behaviorIn(c)[setting] = {}))).toEqual([
          `${DIST} behavior ${label}: legacy setting ${setting} is unsupported on pricing plans`,
        ]);
      },
    );
  });

  // Every origin is checked, not only the first: the second run adds a copy of the S3 origin.
  describe.each<[string, (config: any) => any]>([
    [ORIGIN, (c) => c.Origins[0]],
    ['second', (c) => {
      const origin = { ...clone(c.Origins[0]), Id: 'second' };
      c.Origins.push(origin);
      return origin;
    }],
  ])('on origin %s', (originId, originIn) => {
    it.each<[string, (origin: any) => unknown, string]>([
      ['Origin Shield', (o) => (o.OriginShield = { Enabled: true, OriginShieldRegion: 'us-east-2' }), 'Origin Shield needs Premium'],
      ['a VPC origin', (o) => (o.VpcOriginConfig = { VpcOriginId: 'vo-1' }), 'VPC origins need Business or higher'],
      ['an OAI', (o) => (o.S3OriginConfig.OriginAccessIdentity = 'origin-access-identity/cloudfront/E1'), 'OAI is unsupported; use OAC'],
    ])('flags %s', (_case, fn, expected) => {
      expect(mutate((c) => fn(originIn(c)))).toEqual([`${DIST} origin ${originId}: ${expected}`]);
    });
  });

  it.each<[string, (config: any) => unknown]>([
    ['an AWS-managed origin request policy', (c) => (c.DefaultCacheBehavior.OriginRequestPolicyId = '88a5eaf4-2fd4-4709-b370-b4c650ea3fcf')],
    ['five cache behaviors', (c) => (c.CacheBehaviors = Array.from({ length: 4 }, (_, i) => ({ ...c.DefaultCacheBehavior, PathPattern: `/p${i}/*` })))],
    ['Staging set to false', (c) => (c.Staging = false)],
    ['the direct connection mode', (c) => (c.ConnectionMode = 'direct')],
    ['Origin Shield turned off', (c) => (c.Origins[0].OriginShield = { Enabled: false })],
    ['a custom origin', (c) => c.Origins.push(clone(API_ORIGIN))],
    ['an S3 origin without an OriginAccessIdentity setting', (c) => delete c.Origins[0].S3OriginConfig.OriginAccessIdentity],
  ])('accepts %s', (_case, fn) => {
    expect(mutate(fn)).toEqual([]);
  });

  // aws-cdk-lib's constants for the AWS-managed policies: a source independent of the ID lists in checks.ts.
  const { CachePolicy: CP, OriginRequestPolicy: ORP, ResponseHeadersPolicy: RHP } = cloudfront;
  it.each<[string, Set<string>, string[]]>([
    ['CachePolicyId', MANAGED_CACHE_POLICY_IDS, [
      CP.AMPLIFY, CP.CACHING_DISABLED, CP.CACHING_OPTIMIZED, CP.CACHING_OPTIMIZED_FOR_UNCOMPRESSED_OBJECTS, CP.ELEMENTAL_MEDIA_PACKAGE,
      CP.USE_ORIGIN_CACHE_CONTROL_HEADERS, CP.USE_ORIGIN_CACHE_CONTROL_HEADERS_QUERY_STRINGS,
    ].map((p) => p.cachePolicyId)],
    ['OriginRequestPolicyId', MANAGED_ORIGIN_REQUEST_POLICY_IDS, [
      ORP.ALL_VIEWER, ORP.ALL_VIEWER_AND_CLOUDFRONT_2022, ORP.ALL_VIEWER_EXCEPT_HOST_HEADER, ORP.CORS_CUSTOM_ORIGIN, ORP.CORS_S3_ORIGIN,
      ORP.ELEMENTAL_MEDIA_TAILOR, ORP.HOST_HEADER_ONLY, ORP.USER_AGENT_REFERER_HEADERS,
    ].map((p) => p.originRequestPolicyId)],
    ['ResponseHeadersPolicyId', MANAGED_RESPONSE_HEADERS_POLICY_IDS, [
      RHP.CORS_ALLOW_ALL_ORIGINS, RHP.CORS_ALLOW_ALL_ORIGINS_WITH_PREFLIGHT, RHP.SECURITY_HEADERS, RHP.CORS_ALLOW_ALL_ORIGINS_AND_SECURITY_HEADERS,
      RHP.CORS_ALLOW_ALL_ORIGINS_WITH_PREFLIGHT_AND_SECURITY_HEADERS,
    ].map((p) => p.responseHeadersPolicyId)],
  ])('allows exactly the AWS-managed policies as %s, and accepts each one', (field, allowed, managed) => {
    expect([...allowed].sort()).toEqual([...managed].sort());
    for (const id of managed) expect(mutate((c) => (c.DefaultCacheBehavior[field] = id)), id).toEqual([]);
  });

  it('names extra cache behaviors by path pattern, or by position when the pattern is missing', () => {
    const violations = mutate((c) => (c.CacheBehaviors = [
      { ...c.DefaultCacheBehavior, PathPattern: '/notes/*', CachePolicyId: 'custom' },
      { ...c.DefaultCacheBehavior, CachePolicyId: 'custom' },
    ]));
    expect(violations).toEqual([
      `${DIST} behavior /notes/*: CachePolicyId must be an AWS-managed policy ID`,
      `${DIST} behavior 2: CachePolicyId must be an AWS-managed policy ID`,
    ]);
  });

  it('flags a distribution without a DistributionConfig for its missing managed cache policy', () => {
    expect(freePlanViolations({ Resources: { Cdn: { Type: 'AWS::CloudFront::Distribution' } } })).toEqual([
      'Cdn behavior default: CachePolicyId must be an AWS-managed policy ID',
    ]);
  });

  it('flags unsupported resource types', () => {
    const template = synth((s) => {
      new cloudfront.CachePolicy(s, 'Custom');
      const bucket = new s3.Bucket(s, 'B');
      new cloudfront.Distribution(s, 'D', { defaultBehavior: { origin: origins.S3BucketOrigin.withOriginAccessIdentity(bucket) } });
    });
    // Logical and origin IDs here are generated by CDK internals, so only their shape is pinned.
    expect(freePlanViolations(template)).toEqual([
      expect.stringMatching(/^Custom\w+ \(AWS::CloudFront::CachePolicy\): custom cache policies need Business or higher$/),
      expect.stringMatching(/^D\w+ \(AWS::CloudFront::CloudFrontOriginAccessIdentity\): OAI is unsupported; use OAC$/),
      expect.stringMatching(/^D\w+ origin \w+: OAI is unsupported; use OAC$/),
    ]);
  });

  it.each([
    ['AWS::CloudFront::CachePolicy', 'custom cache policies need Business or higher'],
    ['AWS::CloudFront::OriginRequestPolicy', 'custom origin request policies need Business or higher'],
    ['AWS::CloudFront::ResponseHeadersPolicy', 'custom response header policies need Business or higher'],
    ['AWS::CloudFront::KeyValueStore', 'KeyValueStore needs Pro or higher'],
    ['AWS::CloudFront::RealtimeLogConfig', 'real-time logs are unsupported on pricing plans'],
    ['AWS::CloudFront::ContinuousDeploymentPolicy', 'continuous deployment is unsupported on pricing plans'],
    ['AWS::CloudFront::CloudFrontOriginAccessIdentity', 'OAI is unsupported; use OAC'],
    ['AWS::CloudFront::AnycastIpList', 'Anycast IP lists are unsupported on pricing plans'],
    ['AWS::CloudFront::VpcOrigin', 'VPC origins need Business or higher'],
    ['AWS::CloudFront::DistributionTenant', 'multi-tenant distributions are unsupported on pricing plans'],
    ['AWS::CloudFront::TrustStore', 'viewer mutual TLS needs Premium'],
    ['AWS::CloudFront::ConnectionFunction', 'connection functions (viewer mutual TLS) need Premium'],
    ['AWS::Logs::DeliverySource', 'access-log delivery needs Pro or higher on flat-rate plans'],
    ['AWS::WAFv2::LoggingConfiguration', 'WAF request logs need Pro or higher'],
    ['AWS::WAFv2::RuleGroup', 'rule groups are unsupported on pricing plans'],
    ['AWS::Shield::Protection', 'Shield Advanced makes a distribution ineligible'],
  ])('flags a %s resource', (type, reason) => {
    expect(freePlanViolations({ Resources: { Extra: { Type: type, Properties: {} } } })).toEqual([`Extra (${type}): ${reason}`]);
  });

  // A plan distribution's functions and web ACL can be used by no other distribution ("Unsupported associations").
  describe('with a second distribution', () => {
    const PREVIEW = 'PreviewDistribution';
    const shared = (what: string) => `${what} is shared by ${DIST}, ${PREVIEW}: a pricing-plan distribution cannot share its functions or web ACL`;
    /**
     * Adds a copy of the site distribution, as a preview distribution might be, then changes both configs. The copy
     * starts without a web ACL, so each test sets the web ACLs it means to test.
     */
    const withPreview = (change: (preview: any, config: any, template: CfnTemplate) => void = () => {}) =>
      mutate((c, t) => {
        const preview = clone(t.Resources[DIST]!);
        preview.Properties!.DistributionConfig.Aliases = ['preview.zachdavids.com'];
        delete preview.Properties!.DistributionConfig.WebACLId;
        t.Resources[PREVIEW] = preview;
        change(preview.Properties!.DistributionConfig, c, t);
      });
    const ownFunction = (preview: any, t: CfnTemplate) => {
      t.Resources.PreviewFunction = clone(t.Resources[FN]!);
      preview.DefaultCacheBehavior.FunctionAssociations[0].FunctionARN = { 'Fn::GetAtt': ['PreviewFunction', 'FunctionARN'] };
    };

    it('flags a CloudFront Function both use', () => {
      expect(withPreview()).toEqual([shared(`CloudFront Function ${FN}`)]);
    });

    it('flags a CloudFront Function the second uses only on a path behavior', () => {
      const violations = withPreview((preview, c, t) => {
        ownFunction(preview, t);
        preview.WebACLId = TEST_WEB_ACL_ARN.replace(/zachverse/, 'preview');
        preview.CacheBehaviors = [{ ...clone(c.DefaultCacheBehavior), PathPattern: '/x/*' }];
      });
      expect(violations).toEqual([shared(`CloudFront Function ${FN}`)]);
    });

    it.each([
      ['an ARN', TEST_WEB_ACL_ARN],
      ['a reference to a web ACL in the stack', { 'Fn::GetAtt': ['Acl', 'Arn'] }],
    ])('flags a web ACL both use, given as %s', (_case, webAclId) => {
      const violations = withPreview((preview, c, t) => {
        ownFunction(preview, t);
        c.WebACLId = webAclId;
        preview.WebACLId = webAclId;
      });
      expect(violations).toEqual([shared(`web ACL ${JSON.stringify(webAclId)}`)]);
    });

    it('accepts distributions with their own functions and web ACLs', () => {
      const violations = withPreview((preview, c, t) => {
        ownFunction(preview, t);
        c.WebACLId = TEST_WEB_ACL_ARN;
        preview.WebACLId = TEST_WEB_ACL_ARN.replace(/zachverse/, 'preview');
      });
      expect(violations).toEqual([]);
    });

    it("accepts distributions that both set WebACLId to '', which CloudFront reads as no web ACL", () => {
      const violations = withPreview((preview, c, t) => {
        ownFunction(preview, t);
        c.WebACLId = '';
        preview.WebACLId = '';
      });
      expect(violations).toEqual([]);
    });
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
  const freeAcl = (): any => ({
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
  const byteMatch = (fieldToMatch: object) => ({
    ByteMatchStatement: { SearchString: 'x', FieldToMatch: fieldToMatch, PositionalConstraint: 'CONTAINS', TextTransformations: [] },
  });

  it('accepts five Free-plan rules', () => {
    expect(freePlanWebAclViolations(freeAcl())).toEqual([]);
  });

  it('accepts null values inside rule statements', () => {
    const acl = freeAcl();
    acl.Rules[4].Statement.GeoMatchStatement.ForwardedIPConfig = null;
    expect(freePlanWebAclViolations(acl)).toEqual([]);
  });

  it.each<[string, (acl: any) => unknown, string]>([
    ['a sixth rule', (a) => a.Rules.push(rule('Extra', { GeoMatchStatement: { CountryCodes: ['RU'] } })),
      '6 rules exceeds the Free limit of 5'],
    ['regional scope', (a) => (a.Scope = 'REGIONAL'), 'Scope must be CLOUDFRONT'],
    ['custom response bodies', (a) => (a.CustomResponseBodies = { Busy: { ContentType: 'TEXT_PLAIN', Content: 'busy' } }),
      'custom WAF responses need Pro or higher'],
    ['a custom response on the default action', (a) => (a.DefaultAction = { Block: { CustomResponse: { ResponseCode: 403 } } }),
      'custom WAF responses need Pro or higher'],
    ['partner rules', (a) => (a.Rules[0].Statement.ManagedRuleGroupStatement.VendorName = 'F5'),
      'AWSManagedRulesAmazonIpReputationList: partner managed rules (F5) are unsupported'],
    ['a rule group reference', (a) => (a.Rules[3] = rule('RG', { RuleGroupReferenceStatement: { Arn: 'arn' } })),
      'RG: rule groups are unsupported on pricing plans'],
    ['regex matching',
      (a) => (a.Rules[3] = rule('Re', { RegexMatchStatement: { RegexString: 'x', FieldToMatch: { UriPath: {} }, TextTransformations: [] } })),
      'Re: regex-based filtering needs Business or higher'],
    ['a regex pattern set',
      (a) => (a.Rules[3] = rule('Rs', { RegexPatternSetReferenceStatement: { Arn: 'arn', FieldToMatch: { UriPath: {} }, TextTransformations: [] } })),
      'Rs: regex-based filtering needs Business or higher'],
    ['header-keyed rate limits',
      (a) => (a.Rules[3].Statement.RateBasedStatement = { Limit: 100, AggregateKeyType: 'CUSTOM_KEYS', CustomKeys: [{ Header: { Name: 'x' } }] }),
      'RateLimit: header- or cookie-keyed rate limits need Pro or higher'],
    ['cookie-keyed rate limits',
      (a) => (a.Rules[3].Statement.RateBasedStatement = {
        Limit: 100, AggregateKeyType: 'CUSTOM_KEYS', CustomKeys: [{ Cookie: { Name: 'session', TextTransformations: [] } }],
      }),
      'RateLimit: header- or cookie-keyed rate limits need Pro or higher'],
    ['CAPTCHA', (a) => (a.Rules[3].Action = { Captcha: {} }), 'RateLimit: CAPTCHA needs Pro or higher'],
    ['JavaScript challenge', (a) => (a.Rules[3].Action = { Challenge: {} }), 'RateLimit: JavaScript challenge needs Business or higher'],
    ['a custom block response', (a) => (a.Rules[3].Action = { Block: { CustomResponse: { ResponseCode: 429 } } }),
      'RateLimit: custom WAF responses need Pro or higher'],
  ])('flags %s', (_case, fn, expected) => {
    const acl = freeAcl();
    fn(acl);
    expect(freePlanWebAclViolations(acl)).toEqual([expected]);
  });

  it.each(['SingleHeader', 'Headers', 'Cookies', 'HeaderOrder', 'JA3Fingerprint', 'JA4Fingerprint'])('flags %s matching', (field) => {
    const acl = freeAcl();
    acl.Rules[3] = rule('Match', byteMatch({ [field]: {} }));
    expect(freePlanWebAclViolations(acl)).toEqual([`Match: ${field} matching (header-based filtering) needs Pro or higher`]);
  });

  it.each([
    ['AWSManagedRulesBotControlRuleSet', 'Bot Control needs Business or higher'],
    ['AWSManagedRulesAntiDDoSRuleSet', 'Advanced DDoS protection needs Business or higher'],
    ['AWSManagedRulesATPRuleSet', 'Account Takeover Protection is unsupported'],
    ['AWSManagedRulesACFPRuleSet', 'Account Creation Fraud Prevention is unsupported'],
    ['AWSManagedRulesWordPressRuleSet', 'use-case protections need Pro or higher'],
    ['AWSManagedRulesPHPRuleSet', 'use-case protections need Pro or higher'],
    ['AWSManagedRulesSQLiRuleSet', 'use-case protections need Pro or higher'],
    ['AWSManagedRulesLinuxRuleSet', 'use-case protections need Pro or higher'],
    ['AWSManagedRulesUnixRuleSet', 'use-case protections need Pro or higher'],
    ['AWSManagedRulesWindowsRuleSet', 'use-case protections need Pro or higher'],
  ])('flags the %s managed rule group', (name, reason) => {
    const acl = freeAcl();
    acl.Rules[0] = managed(name);
    expect(freePlanWebAclViolations(acl)).toEqual([`${name}: ${name}: ${reason}`]);
  });

  it.each([
    ['CAPTCHA', { Captcha: {} }, 'CAPTCHA needs Pro or higher'],
    ['JavaScript challenge', { Challenge: {} }, 'JavaScript challenge needs Business or higher'],
    ['custom block response', { Block: { CustomResponse: { ResponseCode: 403 } } }, 'custom WAF responses need Pro or higher'],
  ])('flags a %s override inside a managed rule group', (_case, actionToUse, reason) => {
    const acl = freeAcl();
    acl.Rules[1].Statement.ManagedRuleGroupStatement.RuleActionOverrides = [{ Name: 'SizeRestrictions_BODY', ActionToUse: actionToUse }];
    expect(freePlanWebAclViolations(acl)).toEqual([`AWSManagedRulesCommonRuleSet: ${reason}`]);
  });

  it('accepts a count override inside a managed rule group', () => {
    const acl = freeAcl();
    acl.Rules[1].Statement.ManagedRuleGroupStatement.RuleActionOverrides = [{ Name: 'SizeRestrictions_BODY', ActionToUse: { Count: {} } }];
    expect(freePlanWebAclViolations(acl)).toEqual([]);
  });

  it.each(['KB_32', 'KB_48', 'KB_64'])('flags the body inspection limit %s, above the 16 KB of the Free plan', (limit) => {
    const acl = { ...freeAcl(), AssociationConfig: { RequestBody: { CLOUDFRONT: { DefaultSizeInspectionLimit: limit } } } };
    expect(freePlanWebAclViolations(acl)).toEqual(['request body inspection above 16 KB needs Business or higher']);
  });

  it.each([
    ['set explicitly', { CLOUDFRONT: { DefaultSizeInspectionLimit: 'KB_16' } }],
    ['left at the default', { CLOUDFRONT: {} }],
  ])('accepts the 16 KB body inspection limit %s', (_case, requestBody) => {
    expect(freePlanWebAclViolations({ ...freeAcl(), AssociationConfig: { RequestBody: requestBody } })).toEqual([]);
  });

  it('labels violations from a rule that has no name or statement', () => {
    expect(freePlanWebAclViolations({ Scope: 'CLOUDFRONT', Rules: [{ Action: { Captcha: {} } }] })).toEqual([
      '(unnamed rule): CAPTCHA needs Pro or higher',
    ]);
  });

  it('applies to web ACLs found in a template, and flags WAF logging', () => {
    const template: CfnTemplate = {
      Resources: {
        Acl: { Type: 'AWS::WAFv2::WebACL', Properties: { ...freeAcl(), Scope: 'REGIONAL' } },
        AclLogs: { Type: 'AWS::WAFv2::LoggingConfiguration', Properties: {} },
      },
    };
    expect(freePlanViolations(template)).toEqual([
      'AclLogs (AWS::WAFv2::LoggingConfiguration): WAF request logs need Pro or higher',
      'Acl: Scope must be CLOUDFRONT',
    ]);
  });

  it('flags a web ACL resource without properties for its missing scope', () => {
    expect(freePlanViolations({ Resources: { Acl: { Type: 'AWS::WAFv2::WebACL' } } })).toEqual(['Acl: Scope must be CLOUDFRONT']);
  });
});

describe('a stack with no resources', () => {
  it('has no Resources section, and every check accepts it', () => {
    const template = synth(() => {});
    expect(template.Resources).toBeUndefined();
    expect(prohibitedResourceViolations(template)).toEqual([]);
    expect(retentionViolations(template)).toEqual([]);
    expect(dnsWriteViolations(template)).toEqual([]);
    expect(freePlanViolations(template)).toEqual([]);
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

  const AUD = 'token.actions.githubusercontent.com:aud';
  const SUB = 'token.actions.githubusercontent.com:sub';
  const REF = 'token.actions.githubusercontent.com:ref';
  const ref = production.github.deployRef;
  const exact = { [AUD]: 'sts.amazonaws.com', [SUB]: subject, [REF]: ref };

  it('accepts the exact production-environment subject on main with the STS audience', () => {
    expect(githubTrustViolations(roleTrusting({ StringEquals: exact }), subject, ref)).toEqual([]);
  });

  it.each([
    ['a repository-wide wildcard', {
      StringEquals: { [AUD]: 'sts.amazonaws.com', [REF]: ref },
      StringLike: { [SUB]: 'repo:zachdavids@43345768/zachverse@1414719760:*' },
    }],
    ['the old name-only subject format', { StringEquals: { ...exact, [SUB]: 'repo:zachdavids/zachverse:environment:production' } }],
    ['a branch subject instead of the environment', {
      StringEquals: { ...exact, [SUB]: 'repo:zachdavids@43345768/zachverse@1414719760:ref:refs/heads/main' },
    }],
    ['a missing audience', { StringEquals: { [SUB]: subject, [REF]: ref } }],
    ['a missing ref', { StringEquals: { [AUD]: 'sts.amazonaws.com', [SUB]: subject } }],
    ['a ref other than main', { StringEquals: { ...exact, [REF]: 'refs/heads/feature' } }],
  ])('flags %s', (_case, conditions) => {
    expect(githubTrustViolations(roleTrusting(conditions), subject, ref).length).toBeGreaterThan(0);
  });

  it('flags trust statements that allow more than AssumeRoleWithWebIdentity', () => {
    const template = roleTrusting({}, ['sts:AssumeRoleWithWebIdentity', 'sts:TagSession']);
    expect(githubTrustViolations(template, subject, ref).some((v) => v.includes('only sts:AssumeRoleWithWebIdentity'))).toBe(true);
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
