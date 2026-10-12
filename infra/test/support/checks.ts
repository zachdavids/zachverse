// Guardrail checks over synthesized CloudFormation templates. Each returns a
// list of human-readable violations (empty = pass), so the same functions can
// be pointed at deliberately bad templates to prove they detect problems.
import type { CfnResource, CfnTemplate } from './synth';

type Json = any;

const asArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

function resourcesOf(template: CfnTemplate, predicate: (r: CfnResource) => boolean): [string, CfnResource][] {
  return Object.entries(template.Resources ?? {}).filter(([, r]) => predicate(r));
}

// ---------------------------------------------------------------------------
// Prohibited resources
// ---------------------------------------------------------------------------

const PROHIBITED: { matches: (type: string) => boolean; reason: string }[] = [
  {
    matches: (t) => t.startsWith('AWS::Route53::') || t.startsWith('AWS::Route53Domains::'),
    reason: 'hosted zones, DNS records, and domains are managed outside CDK (reviewed batches in infra/dns/)',
  },
  {
    matches: (t) => t.startsWith('Custom::') || t === 'AWS::CloudFormation::CustomResource',
    reason: 'custom resources (bucket emptying, bucket deployment, cross-Region helpers) are not allowed',
  },
  {
    matches: (t) => t === 'AWS::Lambda::Function' || t === 'AWS::Serverless::Function',
    reason: 'website stacks need no Lambda functions (and Lambda@Edge is not allowed in this project)',
  },
  {
    matches: (t) => t === 'AWS::CertificateManager::Certificate',
    reason: 'the CloudFront certificate lives in us-east-1 and is managed outside CloudFormation (ADR 0002)',
  },
  { matches: (t) => t === 'AWS::CloudFormation::StackSet', reason: 'StackSets are not allowed in this project' },
];

export function prohibitedResourceViolations(template: CfnTemplate): string[] {
  const violations: string[] = [];
  for (const [id, resource] of Object.entries(template.Resources ?? {})) {
    const rule = PROHIBITED.find((r) => r.matches(resource.Type));
    if (rule) violations.push(`${id} (${resource.Type}): ${rule.reason}`);
  }
  return violations;
}

/** Every resource must survive stack deletion and replacement. */
export function retentionViolations(template: CfnTemplate): string[] {
  return Object.entries(template.Resources ?? {})
    .filter(([, r]) => r.DeletionPolicy !== 'Retain' || r.UpdateReplacePolicy !== 'Retain')
    .map(([id, r]) => `${id} (${r.Type}) must have DeletionPolicy and UpdateReplacePolicy Retain`);
}

// ---------------------------------------------------------------------------
// Route 53 write permissions
// ---------------------------------------------------------------------------

export interface DnsWriteAllowance {
  hostedZoneId: string;
  /** Exact ACM validation record names (lower case, trailing dot optional). */
  validationRecordNames: string[];
}

function wildcardMatches(pattern: string, action: string): boolean {
  const regex = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  return regex.test(action);
}

const ROUTE53_WRITE_PROBES = [
  'route53:ChangeResourceRecordSets',
  'route53:CreateHostedZone',
  'route53:DeleteHostedZone',
  'route53:ChangeTagsForResource',
  'route53:UpdateHostedZoneComment',
  'route53domains:TransferDomain',
  'route53domains:UpdateDomainNameservers',
];

function policyDocuments(template: CfnTemplate): { where: string; document: Json }[] {
  const docs: { where: string; document: Json }[] = [];
  for (const [id, r] of Object.entries(template.Resources ?? {})) {
    const props = r.Properties ?? {};
    if (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') {
      docs.push({ where: id, document: props.PolicyDocument });
    }
    if (r.Type === 'AWS::IAM::Role' || r.Type === 'AWS::IAM::User' || r.Type === 'AWS::IAM::Group') {
      for (const p of asArray<Json>(props.Policies)) docs.push({ where: `${id}/${p.PolicyName}`, document: p.PolicyDocument });
    }
  }
  return docs;
}

/**
 * Any IAM permission that can change DNS must be limited to UPSERT/CREATE of
 * CNAMEs with the exact ACM validation names in the one existing zone. With
 * no allowance (the current design) any Route 53 write is a violation.
 */
export function dnsWriteViolations(template: CfnTemplate, allowance?: DnsWriteAllowance): string[] {
  const violations: string[] = [];
  for (const { where, document } of policyDocuments(template)) {
    for (const statement of asArray<Json>(document?.Statement)) {
      if (statement.Effect !== 'Allow') continue;
      if (statement.NotAction !== undefined) {
        violations.push(`${where}: Allow with NotAction is too broad to verify`);
        continue;
      }
      const actions = asArray<string>(statement.Action).filter((a) => typeof a === 'string');
      const grants = ROUTE53_WRITE_PROBES.filter((probe) => actions.some((a) => wildcardMatches(a, probe)));
      if (grants.length === 0) continue;
      const onlyRecordChanges = grants.every((g) => g === 'route53:ChangeResourceRecordSets');
      const exactActions = actions.every((a) => a === 'route53:ChangeResourceRecordSets' || !a.startsWith('route53'));
      if (!allowance || !onlyRecordChanges || !exactActions) {
        violations.push(`${where}: grants Route 53 write access (${grants.join(', ')})`);
        continue;
      }
      violations.push(...recordChangeConditionViolations(where, statement, allowance));
    }
  }
  return violations;
}

function recordChangeConditionViolations(where: string, statement: Json, allowance: DnsWriteAllowance): string[] {
  const out: string[] = [];
  const zoneArn = `arn:aws:route53:::hostedzone/${allowance.hostedZoneId}`;
  const resources = asArray<Json>(statement.Resource);
  if (resources.length !== 1 || resources[0] !== zoneArn) out.push(`${where}: Resource must be exactly ${zoneArn}`);

  const conditions = statement.Condition?.['ForAllValues:StringEquals'] ?? {};
  const normalize = (n: string) => n.toLowerCase().replace(/\.$/, '');
  const allowedNames = new Set(allowance.validationRecordNames.map(normalize));
  const names = asArray<string>(conditions['route53:ChangeResourceRecordSetsNormalizedRecordNames']);
  if (names.length === 0 || names.some((n) => n.includes('*') || !allowedNames.has(normalize(n)))) {
    out.push(`${where}: record names must be limited to the exact ACM validation names`);
  }
  const types = asArray<string>(conditions['route53:ChangeResourceRecordSetsRecordTypes']);
  if (types.length !== 1 || types[0] !== 'CNAME') out.push(`${where}: record types must be limited to CNAME`);
  const actions = asArray<string>(conditions['route53:ChangeResourceRecordSetsActions']);
  if (actions.length === 0 || actions.some((a) => a !== 'UPSERT' && a !== 'CREATE')) {
    out.push(`${where}: change actions must be limited to CREATE/UPSERT`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// GitHub deploy role: trust and permissions
// ---------------------------------------------------------------------------

const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';

/** Everything routine website publishing needs: no delete, IAM, DNS, or stack actions. */
export const WEBSITE_DEPLOY_ACTIONS: ReadonlySet<string> = new Set([
  's3:ListBucket',
  's3:GetObject',
  's3:PutObject',
  'cloudfront:CreateInvalidation',
  'cloudfront:GetInvalidation',
  'cloudfront:ListInvalidations',
  'cloudfront:GetDistribution',
]);

function isGitHubOidcPrincipal(template: CfnTemplate, federated: Json): boolean {
  if (typeof federated === 'string') return federated.includes(GITHUB_OIDC_HOST);
  const ref = federated?.Ref;
  const provider = typeof ref === 'string' ? template.Resources[ref] : undefined;
  return provider?.Type === 'AWS::IAM::OIDCProvider' && String(provider.Properties?.Url).includes(GITHUB_OIDC_HOST);
}

/**
 * Every role trusting GitHub's OIDC provider must require the STS audience,
 * exactly the expected subject, and the expected ref (no wildcards, no StringLike).
 */
export function githubTrustViolations(template: CfnTemplate, expectedSubject: string, expectedRef: string): string[] {
  const out: string[] = [];
  for (const [id, role] of resourcesOf(template, (r) => r.Type === 'AWS::IAM::Role')) {
    for (const statement of asArray<Json>(role.Properties?.AssumeRolePolicyDocument?.Statement)) {
      if (!isGitHubOidcPrincipal(template, statement.Principal?.Federated)) continue;
      const actions = asArray<string>(statement.Action);
      if (actions.length !== 1 || actions[0] !== 'sts:AssumeRoleWithWebIdentity') {
        out.push(`${id}: GitHub trust must allow only sts:AssumeRoleWithWebIdentity`);
      }
      const condition = statement.Condition ?? {};
      const operators = Object.keys(condition);
      if (operators.length !== 1 || operators[0] !== 'StringEquals') {
        out.push(`${id}: GitHub trust must use only StringEquals conditions (found ${operators.join(', ') || 'none'})`);
      }
      const equals = condition.StringEquals ?? {};
      if (equals[`${GITHUB_OIDC_HOST}:aud`] !== 'sts.amazonaws.com') out.push(`${id}: audience must be sts.amazonaws.com`);
      if (equals[`${GITHUB_OIDC_HOST}:sub`] !== expectedSubject) {
        out.push(`${id}: subject must be exactly ${expectedSubject}`);
      }
      if (equals[`${GITHUB_OIDC_HOST}:ref`] !== expectedRef) out.push(`${id}: ref must be exactly ${expectedRef}`);
    }
  }
  return out;
}

/**
 * Collects every permission granted to the named role across all templates
 * (attached policies, inline policies, managed policies) and flags anything
 * beyond the allowed actions or any wildcard resource.
 */
export function deployRoleViolations(
  templates: CfnTemplate[],
  roleName: string,
  allowedActions: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const checkDocument = (where: string, document: Json) => {
    for (const statement of asArray<Json>(document?.Statement)) {
      if (statement.Effect !== 'Allow') continue;
      if (statement.NotAction !== undefined || statement.NotResource !== undefined) {
        out.push(`${where}: NotAction/NotResource grants are too broad`);
      }
      for (const action of asArray<string>(statement.Action)) {
        if (!allowedActions.has(action)) out.push(`${where}: ${action} is not an allowed deploy action`);
      }
      for (const resource of asArray<Json>(statement.Resource)) {
        if (typeof resource === 'string' && resource.includes('*')) out.push(`${where}: wildcard resource ${resource}`);
      }
    }
  };

  for (const template of templates) {
    const roleIds = resourcesOf(template, (r) => r.Type === 'AWS::IAM::Role' && r.Properties?.RoleName === roleName).map(
      ([id]) => id,
    );
    for (const id of roleIds) {
      const props = template.Resources[id]!.Properties ?? {};
      if (asArray(props.ManagedPolicyArns).length > 0) out.push(`${id}: managed policies are not allowed on the deploy role`);
      for (const p of asArray<Json>(props.Policies)) checkDocument(`${id}/${p.PolicyName}`, p.PolicyDocument);
    }
    const targetsRole = (roles: Json) =>
      asArray<Json>(roles).some((r) => r === roleName || (typeof r?.Ref === 'string' && roleIds.includes(r.Ref)));
    for (const [id, r] of resourcesOf(
      template,
      (r) => (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') && targetsRole(r.Properties?.Roles),
    )) {
      checkDocument(id, r.Properties?.PolicyDocument);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CloudFront flat-rate Free plan compatibility
// Source: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html
// (feature table and "Unsupported features"), read 2026-10-11.
// ---------------------------------------------------------------------------

export const FREE_PLAN_LIMITS = { cacheBehaviors: 5, wafRules: 5 } as const;

// AWS-managed policy IDs, from the CloudFront Developer Guide "Use managed ... policies" pages.
export const MANAGED_CACHE_POLICY_IDS = new Set([
  '2e54312d-136d-493c-8eb9-b001f22f67d2', // Amplify
  '4135ea2d-6df8-44a3-9df3-4b5a84be39ad', // CachingDisabled
  '658327ea-f89d-4fab-a63d-7e88639e58f6', // CachingOptimized
  'b2884449-e4de-46a7-ac36-70bc7f1ddd6d', // CachingOptimizedForUncompressedObjects
  '08627262-05a9-4f76-9ded-b50ca2e3a84f', // Elemental-MediaPackage
  '83da9c7e-98b4-4e11-a168-04f0df8e2c65', // UseOriginCacheControlHeaders
  '4cc15a8a-d715-48a4-82b8-cc0b614638fe', // UseOriginCacheControlHeaders-QueryStrings
]);
export const MANAGED_ORIGIN_REQUEST_POLICY_IDS = new Set([
  '216adef6-5c7f-47e4-b989-5492eafa07d3', // AllViewer
  '33f36d7e-f396-46d9-90e0-52428a34d9dc', // AllViewerAndCloudFrontHeaders-2022-06
  'b689b0a8-53d0-40ab-baf2-68738e2966ac', // AllViewerExceptHostHeader
  '59781a5b-3903-41f3-afcb-af62929ccde1', // CORS-CustomOrigin
  '88a5eaf4-2fd4-4709-b370-b4c650ea3fcf', // CORS-S3Origin
  '775133bc-15f2-49f9-abea-afb2e0bf67d2', // Elemental-MediaTailor-PersonalizedManifests
  'bf0718e1-ba1e-49d1-88b1-f726733018ae', // HostHeaderOnly
  'acba4595-bd28-49b8-b9fe-13317c0390fa', // UserAgentRefererHeaders
]);
export const MANAGED_RESPONSE_HEADERS_POLICY_IDS = new Set([
  'e61eb60c-9c35-4d20-a928-2b84e02af89c', // CORS-and-SecurityHeadersPolicy
  '5cc3b908-e619-4b99-88e5-2cf7f45965bd', // CORS-With-Preflight
  'eaab4381-ed33-4a86-88ca-d9558dc6cd63', // CORS-with-preflight-and-SecurityHeadersPolicy
  '67f7725c-6f97-4210-82d7-5512b31e9d03', // SecurityHeadersPolicy
  '60669652-455b-4ae9-85a4-c4c02393f86c', // SimpleCORS
]);

/** Resource types that are unsupported, legacy, or above the Free tier. */
const FREE_PLAN_DISALLOWED_TYPES: Record<string, string> = {
  'AWS::CloudFront::CachePolicy': 'custom cache policies need Business or higher',
  'AWS::CloudFront::OriginRequestPolicy': 'custom origin request policies need Business or higher',
  'AWS::CloudFront::ResponseHeadersPolicy': 'custom response header policies need Business or higher',
  'AWS::CloudFront::KeyValueStore': 'KeyValueStore needs Pro or higher',
  'AWS::CloudFront::RealtimeLogConfig': 'real-time logs are unsupported on pricing plans',
  'AWS::CloudFront::ContinuousDeploymentPolicy': 'continuous deployment is unsupported on pricing plans',
  'AWS::CloudFront::CloudFrontOriginAccessIdentity': 'OAI is unsupported; use OAC',
  'AWS::CloudFront::AnycastIpList': 'Anycast IP lists are unsupported on pricing plans',
  'AWS::CloudFront::VpcOrigin': 'VPC origins need Business or higher',
  'AWS::CloudFront::DistributionTenant': 'multi-tenant distributions are unsupported on pricing plans',
  'AWS::Logs::DeliverySource': 'access-log delivery needs Pro or higher on flat-rate plans',
  'AWS::WAFv2::LoggingConfiguration': 'WAF request logs need Pro or higher',
  'AWS::WAFv2::RuleGroup': 'rule groups are unsupported on pricing plans',
  'AWS::Shield::Protection': 'Shield Advanced makes a distribution ineligible',
};

export function freePlanViolations(template: CfnTemplate): string[] {
  const violations: string[] = [];
  for (const [id, r] of Object.entries(template.Resources ?? {})) {
    const reason = FREE_PLAN_DISALLOWED_TYPES[r.Type];
    if (reason) violations.push(`${id} (${r.Type}): ${reason}`);
  }
  for (const [id, r] of resourcesOf(template, (r) => r.Type === 'AWS::CloudFront::Distribution')) {
    violations.push(...distributionViolations(template, id, r.Properties?.DistributionConfig ?? {}));
  }
  for (const [id, r] of resourcesOf(template, (r) => r.Type === 'AWS::WAFv2::WebACL')) {
    violations.push(...freePlanWebAclViolations(r.Properties ?? {}).map((v) => `${id}: ${v}`));
  }
  return violations;
}

function distributionViolations(template: CfnTemplate, id: string, config: Json): string[] {
  const out: string[] = [];
  const behaviors: Json[] = [config.DefaultCacheBehavior ?? {}, ...asArray<Json>(config.CacheBehaviors)];
  if (behaviors.length > FREE_PLAN_LIMITS.cacheBehaviors) {
    out.push(`${id}: ${behaviors.length} cache behaviors exceeds the Free limit of ${FREE_PLAN_LIMITS.cacheBehaviors}`);
  }

  behaviors.forEach((b, i) => {
    const where = `${id} behavior ${i === 0 ? 'default' : (b.PathPattern ?? i)}`;
    if (!MANAGED_CACHE_POLICY_IDS.has(b.CachePolicyId)) out.push(`${where}: CachePolicyId must be an AWS-managed policy ID`);
    if (b.OriginRequestPolicyId !== undefined && !MANAGED_ORIGIN_REQUEST_POLICY_IDS.has(b.OriginRequestPolicyId)) {
      out.push(`${where}: OriginRequestPolicyId must be an AWS-managed policy ID`);
    }
    if (b.ResponseHeadersPolicyId !== undefined && !MANAGED_RESPONSE_HEADERS_POLICY_IDS.has(b.ResponseHeadersPolicyId)) {
      out.push(`${where}: ResponseHeadersPolicyId must be an AWS-managed policy ID`);
    }
    for (const legacy of ['ForwardedValues', 'MinTTL', 'DefaultTTL', 'MaxTTL', 'TrustedSigners', 'FieldLevelEncryptionId']) {
      if (b[legacy] !== undefined) out.push(`${where}: legacy setting ${legacy} is unsupported on pricing plans`);
    }
    if (b.RealtimeLogConfigArn !== undefined) out.push(`${where}: real-time logs are unsupported on pricing plans`);
    if (asArray(b.LambdaFunctionAssociations).length > 0) out.push(`${where}: Lambda@Edge is not allowed in this project`);
    for (const assoc of asArray<Json>(b.FunctionAssociations)) {
      out.push(...functionAssociationViolations(template, where, assoc));
    }
  });

  const unsupportedConfig: Record<string, string> = {
    Logging: 'access logs need Pro or higher',
    ContinuousDeploymentPolicyId: 'continuous deployment is unsupported',
    AnycastIpListId: 'Anycast IP lists are unsupported',
    OriginGroups: 'origin failover needs Premium',
    TenantConfig: 'multi-tenant distributions are unsupported',
    S3Origin: 'legacy origin settings are unsupported',
    CustomOrigin: 'legacy origin settings are unsupported',
    CNAMEs: 'legacy CNAMEs setting is unsupported; use Aliases',
  };
  for (const [key, reason] of Object.entries(unsupportedConfig)) {
    if (config[key] !== undefined) out.push(`${id}: ${key}: ${reason}`);
  }
  if (config.Staging === true) out.push(`${id}: staging distributions are unsupported`);
  if (config.ConnectionMode === 'tenant-only') out.push(`${id}: multi-tenant distributions are unsupported`);

  const cert = config.ViewerCertificate ?? {};
  if (cert.IamCertificateId !== undefined) out.push(`${id}: IAM server certificates are unsupported; use ACM`);
  if (cert.SslSupportMethod === 'vip') out.push(`${id}: dedicated IP SSL is unsupported`);

  for (const origin of asArray<Json>(config.Origins)) {
    if (origin.OriginShield?.Enabled) out.push(`${id} origin ${origin.Id}: Origin Shield needs Premium`);
    if (origin.VpcOriginConfig !== undefined) out.push(`${id} origin ${origin.Id}: VPC origins need Business or higher`);
    const oai = origin.S3OriginConfig?.OriginAccessIdentity;
    if (oai !== undefined && oai !== '') out.push(`${id} origin ${origin.Id}: OAI is unsupported; use OAC`);
  }
  return out;
}

function functionAssociationViolations(template: CfnTemplate, where: string, assoc: Json): string[] {
  const ref = assoc.FunctionARN?.['Fn::GetAtt']?.[0];
  const fn = typeof ref === 'string' ? template.Resources[ref] : undefined;
  if (!fn || fn.Type !== 'AWS::CloudFront::Function') {
    return [`${where}: function associations must reference a CloudFront Function defined in this stack`];
  }
  const out: string[] = [];
  const fnConfig = fn.Properties?.FunctionConfig ?? {};
  if (fnConfig.Runtime !== 'cloudfront-js-2.0') out.push(`${where}: ${ref} must use runtime cloudfront-js-2.0`);
  if (asArray(fnConfig.KeyValueStoreAssociations).length > 0) out.push(`${where}: ${ref}: KeyValueStore needs Pro or higher`);
  return out;
}

const NON_FREE_MANAGED_RULE_GROUPS: Record<string, string> = {
  AWSManagedRulesBotControlRuleSet: 'Bot Control needs Business or higher',
  AWSManagedRulesAntiDDoSRuleSet: 'Advanced DDoS protection needs Business or higher',
  AWSManagedRulesATPRuleSet: 'Account Takeover Protection is unsupported',
  AWSManagedRulesACFPRuleSet: 'Account Creation Fraud Prevention is unsupported',
  AWSManagedRulesWordPressRuleSet: 'use-case protections need Pro or higher',
  AWSManagedRulesPHPRuleSet: 'use-case protections need Pro or higher',
  AWSManagedRulesSQLiRuleSet: 'use-case protections need Pro or higher',
  AWSManagedRulesLinuxRuleSet: 'use-case protections need Pro or higher',
  AWSManagedRulesUnixRuleSet: 'use-case protections need Pro or higher',
  AWSManagedRulesWindowsRuleSet: 'use-case protections need Pro or higher',
};
const HEADER_FIELDS = ['Headers', 'SingleHeader', 'Cookies', 'HeaderOrder', 'JA3Fingerprint', 'JA4Fingerprint'];

/** Checks one web ACL (CloudFormation properties shape) against the Free plan's WAF features. */
export function freePlanWebAclViolations(acl: Json): string[] {
  const out: string[] = [];
  if (acl.Scope !== 'CLOUDFRONT') out.push('Scope must be CLOUDFRONT');
  const rules = asArray<Json>(acl.Rules);
  if (rules.length > FREE_PLAN_LIMITS.wafRules) {
    out.push(`${rules.length} rules exceeds the Free limit of ${FREE_PLAN_LIMITS.wafRules}`);
  }
  if (acl.CustomResponseBodies !== undefined) out.push('custom WAF responses need Pro or higher');
  if (acl.DefaultAction?.Block?.CustomResponse !== undefined) out.push('custom WAF responses need Pro or higher');
  for (const body of Object.values<Json>(acl.AssociationConfig?.RequestBody ?? {})) {
    if (body?.DefaultSizeInspectionLimit && body.DefaultSizeInspectionLimit !== 'KB_16') {
      out.push('request body inspection above 16 KB needs Business or higher');
    }
  }
  for (const rule of rules) {
    const name = rule.Name ?? '(unnamed rule)';
    if (rule.Action?.Captcha !== undefined) out.push(`${name}: CAPTCHA needs Pro or higher`);
    if (rule.Action?.Challenge !== undefined) out.push(`${name}: JavaScript challenge needs Business or higher`);
    if (rule.Action?.Block?.CustomResponse !== undefined) out.push(`${name}: custom WAF responses need Pro or higher`);
    out.push(...statementViolations(rule.Statement ?? {}).map((v) => `${name}: ${v}`));
  }
  return out;
}

function statementViolations(node: Json): string[] {
  if (node === null || typeof node !== 'object') return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries<Json>(node)) {
    if (key === 'RuleGroupReferenceStatement') out.push('rule groups are unsupported on pricing plans');
    if (key === 'RegexMatchStatement' || key === 'RegexPatternSetReferenceStatement') {
      out.push('regex-based filtering needs Business or higher');
    }
    if (key === 'ManagedRuleGroupStatement') {
      if (value.VendorName !== 'AWS') out.push(`partner managed rules (${value.VendorName}) are unsupported`);
      const reason = NON_FREE_MANAGED_RULE_GROUPS[value.Name];
      if (reason) out.push(`${value.Name}: ${reason}`);
    }
    if (key === 'FieldToMatch' || key === 'CustomKeys') {
      const fields = JSON.stringify(value);
      for (const header of HEADER_FIELDS) {
        if (fields.includes(`"${header}"`)) out.push(`${header} matching (header-based filtering) needs Pro or higher`);
      }
      if (key === 'CustomKeys' && /"(Header|Cookie)"/.test(fields)) {
        out.push('header- or cookie-keyed rate limits need Pro or higher');
      }
    }
    out.push(...statementViolations(value));
  }
  return out;
}
