// Guardrail checks over synthesized CloudFormation templates. Each returns a
// list of human-readable violations (empty = pass), so the same functions can
// be pointed at deliberately bad templates to prove they detect problems.
// ./plugin.ts runs them in every synthesis of the app; the tests also call them directly.
import type { CfnResource, CfnTemplate, Json } from './template';

const asArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

function resourcesOf(template: CfnTemplate, predicate: (r: CfnResource) => boolean): [string, CfnResource][] {
  return Object.entries(template.Resources ?? {}).filter(([, r]) => predicate(r));
}

// ---------------------------------------------------------------------------
// Prohibited resources
// ---------------------------------------------------------------------------

// The first matching rule gives the reason.
const PROHIBITED: { matches: (type: string) => boolean; reason: string }[] = [
  {
    matches: (t) => t.startsWith('AWS::Route53::') || t.startsWith('AWS::Route53Domains::'),
    reason: 'hosted zones, DNS records, and domains are managed outside CDK (reviewed batches in infra/dns/)',
  },
  {
    matches: (t) => t === 'AWS::Amplify::Domain' || t.startsWith('AWS::ServiceDiscovery::'),
    reason: 'Amplify domains and Cloud Map write DNS records themselves, bypassing the reviewed batches in infra/dns/',
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
  {
    // An identity pool that accepts GitHub's OIDC provider hands out credentials no role trust check sees.
    matches: (t) => t.startsWith('AWS::Cognito::'),
    reason: 'website stacks need no Cognito resources, and an identity pool can exchange outside tokens for credentials',
  },
  {
    // Service Catalog products launch their own templates, and its other types exist only to serve products.
    matches: (t) =>
      t === 'AWS::CloudFormation::Stack' || t === 'AWS::Serverless::Application' || t.startsWith('AWS::ServiceCatalog::'),
    reason: 'nested stacks and Service Catalog products launch templates these guardrails do not check',
  },
  {
    // Last of the CloudFormation rules, so those above keep their reasons. Change sets carry their own templates;
    // hooks, macros, modules, and registry types run code or rewrite templates during deployment; wait conditions
    // take outside input.
    matches: (t) => t.startsWith('AWS::CloudFormation::'),
    reason: 'other CloudFormation resource types are not checked by these guardrails',
  },
  {
    // Registry extensions: third-party types such as Cloudflare::Dns::Record, private types, and modules.
    matches: (t) => !t.startsWith('AWS::'),
    reason: 'resource types outside the AWS namespace are not checked by these guardrails',
  },
];

const TRANSFORMED = 'transforms and macros rewrite the template during deployment, so these guardrails cannot see the result';

/** Prohibited resources, and transforms that would hide what is actually deployed. */
export function prohibitedResourceViolations(template: CfnTemplate): string[] {
  const violations: string[] = [];
  if (template.Transform !== undefined) violations.push(`Transform ${JSON.stringify(template.Transform)}: ${TRANSFORMED}`);
  // Fn::Transform (AWS::Include or a macro) can appear at any level, including in place of a resource.
  if (JSON.stringify(template).includes('"Fn::Transform":')) violations.push(`Fn::Transform: ${TRANSFORMED}`);
  for (const [id, resource] of Object.entries(template.Resources ?? {})) {
    if (id === 'Fn::Transform') continue;
    const rule = PROHIBITED.find((r) => r.matches(resource.Type));
    if (rule) violations.push(`${id} (${resource.Type}): ${rule.reason}`);
  }
  return violations;
}

/**
 * Every resource must survive stack deletion and replacement. RetainExceptOnCreate also counts: it
 * differs from Retain only by deleting a resource when the operation that created it rolls back.
 * AWS::CDK::Metadata, which CDK's version reporting adds, creates nothing in the account (it carries only the
 * version-reporting record), so deleting it loses nothing.
 */
export function retentionViolations(template: CfnTemplate): string[] {
  return Object.entries(template.Resources ?? {})
    .filter(
      ([, r]) =>
        r.Type !== 'AWS::CDK::Metadata' &&
        ((r.DeletionPolicy !== 'Retain' && r.DeletionPolicy !== 'RetainExceptOnCreate') ||
          r.UpdateReplacePolicy !== 'Retain'),
    )
    .map(([id, r]) => `${id} (${r.Type}) must have DeletionPolicy Retain or RetainExceptOnCreate, and UpdateReplacePolicy Retain`);
}

// ---------------------------------------------------------------------------
// Route 53 write permissions
// ---------------------------------------------------------------------------

/** An ACM DNS validation record name for the site's hostnames: _<32 hex digits> on the apex or www, normalized. */
export const ACM_VALIDATION_NAME = /^_[0-9a-f]{32}\.(?:www\.)?zachdavids\.com$/;

export interface DnsWriteAllowance {
  hostedZoneId: string;
  /** ACM validation record names, in any case, trailing dot optional. Any other name is ignored. */
  validationRecordNames: string[];
}

/** IAM action matching: case-insensitive; `*` matches any run of characters (including none) and `?` any one character. */
function wildcardMatches(pattern: string, action: string): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${source}$`, 'i').test(action);
}

// Every Route 53 and Route 53 Domains API action except the reads (Get*, List*, Check*, TestDNSAnswer,
// ViewBilling), from the API Reference operation lists, read 2026-10-12. Add new write actions here so
// wildcards find them too; one granted by name already counts as a write (isUnlistedRoute53Write).
const ROUTE53_WRITE_PROBES = [
  ...[
    'ActivateKeySigningKey', 'AssociateVPCWithHostedZone', 'ChangeCidrCollection', 'ChangeResourceRecordSets',
    'ChangeTagsForResource', 'CreateCidrCollection', 'CreateHealthCheck', 'CreateHostedZone', 'CreateKeySigningKey',
    'CreateQueryLoggingConfig', 'CreateReusableDelegationSet', 'CreateTrafficPolicy', 'CreateTrafficPolicyInstance',
    'CreateTrafficPolicyVersion', 'CreateVPCAssociationAuthorization', 'DeactivateKeySigningKey', 'DeleteCidrCollection',
    'DeleteHealthCheck', 'DeleteHostedZone', 'DeleteKeySigningKey', 'DeleteQueryLoggingConfig',
    'DeleteReusableDelegationSet', 'DeleteTrafficPolicy', 'DeleteTrafficPolicyInstance',
    'DeleteVPCAssociationAuthorization', 'DisableHostedZoneDNSSEC', 'DisassociateVPCFromHostedZone',
    'EnableHostedZoneDNSSEC', 'UpdateHealthCheck', 'UpdateHostedZoneComment', 'UpdateHostedZoneFeatures',
    'UpdateTrafficPolicyComment', 'UpdateTrafficPolicyInstance',
  ].map((action) => `route53:${action}`),
  ...[
    'AcceptDomainTransferFromAnotherAwsAccount', 'AssociateDelegationSignerToDomain',
    'CancelDomainTransferToAnotherAwsAccount', 'DeleteDomain', 'DeleteTagsForDomain', 'DisableDomainAutoRenew',
    'DisableDomainTransferLock', 'DisassociateDelegationSignerFromDomain', 'EnableDomainAutoRenew',
    'EnableDomainTransferLock', 'PushDomain', 'RegisterDomain', 'RejectDomainTransferFromAnotherAwsAccount',
    'RenewDomain', 'ResendContactReachabilityEmail', 'ResendOperationAuthorization', 'RetrieveDomainAuthCode',
    'TransferDomain', 'TransferDomainToAnotherAwsAccount', 'UpdateDomainContact', 'UpdateDomainContactPrivacy',
    'UpdateDomainNameservers', 'UpdateTagsForDomain',
  ].map((action) => `route53domains:${action}`),
];
const ROUTE53_ACTION = /^route53(?:domains)?:/i;
const ROUTE53_READ = /^route53(?:domains)?:(?:Get|List|Check|Test|View)/i;
/** A CloudFormation dynamic reference, which is resolved only during deployment. */
const DYNAMIC_REFERENCE = /\{\{resolve:/i;

/** An action named exactly in either service that is neither a read nor listed above, such as one added since. */
function isUnlistedRoute53Write(action: string): boolean {
  return (
    !/[*?]/.test(action) &&
    ROUTE53_ACTION.test(action) &&
    !ROUTE53_READ.test(action) &&
    !ROUTE53_WRITE_PROBES.some((probe) => wildcardMatches(action, probe))
  );
}

/** Resources whose PolicyDocument grants permissions to IAM identities. */
const POLICY_DOCUMENT_TYPES = new Set([
  'AWS::IAM::Policy',
  'AWS::IAM::ManagedPolicy',
  'AWS::IAM::RolePolicy',
  'AWS::IAM::UserPolicy',
  'AWS::IAM::GroupPolicy',
]);
const IDENTITY_TYPES = new Set(['AWS::IAM::Role', 'AWS::IAM::User', 'AWS::IAM::Group']);

function policyDocuments(template: CfnTemplate): { where: string; document: Json }[] {
  const docs: { where: string; document: Json }[] = [];
  for (const [id, r] of Object.entries(template.Resources ?? {})) {
    const props = r.Properties ?? {};
    if (POLICY_DOCUMENT_TYPES.has(r.Type)) docs.push({ where: id, document: props.PolicyDocument });
    if (IDENTITY_TYPES.has(r.Type)) {
      for (const p of asArray<Json>(props.Policies)) {
        // An entry (or the whole list) wrapped in Fn::If has no literal name.
        const name = typeof p.PolicyName === 'string' ? p.PolicyName : '(computed)';
        docs.push({ where: `${id}/${name}`, document: p.PolicyDocument });
      }
    }
  }
  return docs;
}

/**
 * Permissions granted from outside the template cannot be inspected: AWS managed or
 * imported managed policies, groups defined elsewhere, and IAM Identity Center.
 */
function unverifiableGrantViolations(template: CfnTemplate): string[] {
  const resources = template.Resources ?? {};
  const definedHere = (value: Json, type: string) => typeof value?.Ref === 'string' && resources[value.Ref]?.Type === type;
  const out: string[] = [];
  for (const [id, r] of Object.entries(resources)) {
    const props = r.Properties ?? {};
    if (IDENTITY_TYPES.has(r.Type)) {
      for (const arn of asArray<Json>(props.ManagedPolicyArns)) {
        if (!definedHere(arn, 'AWS::IAM::ManagedPolicy')) {
          out.push(`${id}: managed policy ${JSON.stringify(arn)} is not defined in this stack, so it cannot be verified`);
        }
      }
    }
    // A user also gets the permissions of every group it joins.
    const groups =
      r.Type === 'AWS::IAM::User' ? props.Groups : r.Type === 'AWS::IAM::UserToGroupAddition' ? props.GroupName : undefined;
    for (const group of asArray<Json>(groups)) {
      if (!definedHere(group, 'AWS::IAM::Group')) {
        out.push(`${id}: group ${JSON.stringify(group)} is not defined in this stack, so it cannot be verified`);
      }
    }
    if (/^AWS::SSO::/.test(r.Type)) out.push(`${id} (${r.Type}): IAM Identity Center permissions cannot be verified`);
  }
  return out;
}

/**
 * Any IAM permission that can change DNS must be limited to UPSERT/CREATE of
 * CNAMEs with the exact ACM validation names in the one existing zone. With
 * no allowance (the current design) any Route 53 write is a violation, and so
 * is any permission the check cannot read: NotAction, computed actions
 * (intrinsic functions or {{resolve:...}} dynamic references) or documents,
 * and managed policies, groups, or Identity Center permissions from outside
 * the stack. It does not model privilege escalation, such as
 * iam:PutRolePolicy or sts:AssumeRole into a role that can write DNS.
 */
export function dnsWriteViolations(template: CfnTemplate, allowance?: DnsWriteAllowance): string[] {
  const violations = unverifiableGrantViolations(template);
  for (const { where, document } of policyDocuments(template)) {
    // A document wrapped in Fn::If, or given as a JSON string, has no readable Statement.
    if (document?.Statement === undefined) {
      violations.push(`${where}: a computed or missing PolicyDocument cannot be verified`);
      continue;
    }
    for (const statement of asArray<Json>(document.Statement)) {
      // Only a literal Deny is skipped: a computed Effect may resolve to Allow.
      if (statement.Effect === 'Deny') continue;
      if (statement.NotAction !== undefined) {
        violations.push(`${where}: Allow with NotAction is too broad to verify`);
        continue;
      }
      const actions = asArray<Json>(statement.Action);
      if (actions.length === 0 || actions.some((a) => typeof a !== 'string' || DYNAMIC_REFERENCE.test(a))) {
        violations.push(`${where}: Allow with a computed or missing Action is too broad to verify`);
        continue;
      }
      const grants = [
        ...ROUTE53_WRITE_PROBES.filter((probe) => actions.some((a) => wildcardMatches(a, probe))),
        ...actions.filter(isUnlistedRoute53Write),
      ].sort();
      if (grants.length === 0) continue;
      const onlyRecordChanges = grants.every((g) => g === 'route53:ChangeResourceRecordSets');
      // Any other action must be outside Route 53. A pattern that matches the record change, even through
      // a wildcard service prefix, also grants later actions it matches, which the conditions do not limit.
      const exactActions = actions.every(
        (a) =>
          a === 'route53:ChangeResourceRecordSets' ||
          (!ROUTE53_ACTION.test(a) && !ROUTE53_WRITE_PROBES.some((probe) => wildcardMatches(a, probe))),
      );
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
  // IAM compares normalized names (lower case, no trailing dot) case-sensitively, so only that form can match.
  const allowedNames = new Set(
    allowance.validationRecordNames.map((n) => n.toLowerCase().replace(/\.$/, '')).filter((n) => ACM_VALIDATION_NAME.test(n)),
  );
  const names = asArray<string>(conditions['route53:ChangeResourceRecordSetsNormalizedRecordNames']);
  if (names.length === 0 || names.some((n) => !allowedNames.has(n))) {
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

/** The keys of a Principal the check can read. */
const PRINCIPAL_TYPES = new Set(['AWS', 'Federated', 'Service', 'CanonicalUser']);

/** A string CloudFormation deploys as written: no intrinsic function, and no {{resolve:...}} dynamic reference. */
const isLiteral = (value: Json): value is string => typeof value === 'string' && !DYNAMIC_REFERENCE.test(value);

/**
 * Whether a Federated principal is GitHub's OIDC provider: a literal ARN, or the Ref or Arn attribute (both its ARN)
 * of an OIDC provider in the template with a literal Url. Undefined for anything else, which could resolve to any
 * provider during deployment.
 */
function isGitHubOidcPrincipal(template: CfnTemplate, federated: Json): boolean | undefined {
  // The host of a provider ARN or Url, compared whole and in any letter case. An enterprise issuer adds a path.
  const namesGitHub = (value: Json) => {
    if (!isLiteral(value)) return undefined;
    const host = value.startsWith('arn:') ? value.split(':oidc-provider/')[1]?.split('/')[0] : URL.parse(value)?.host;
    return host?.toLowerCase() === GITHUB_OIDC_HOST;
  };
  if (typeof federated === 'string') return namesGitHub(federated);
  const [getAttId, attribute] = asArray<Json>(federated?.['Fn::GetAtt']);
  const id = federated?.Ref ?? (attribute === 'Arn' ? getAttId : undefined);
  const provider = typeof id === 'string' ? template.Resources[id] : undefined;
  return provider?.Type === 'AWS::IAM::OIDCProvider' ? namesGitHub(provider.Properties?.Url) : undefined;
}

/**
 * Every role trusting GitHub's OIDC provider must require the STS audience,
 * exactly the expected subject, and the expected ref (no wildcards, no StringLike).
 * Like the DNS check, it fails closed. A wildcard principal or NotPrincipal,
 * which GitHub's tokens also match, is a violation. So is a trust policy,
 * statement, or Principal it cannot read, an AWS, Service, or CanonicalUser
 * value that is not a literal (it may be "*"), a Federated principal it cannot
 * resolve to an OIDC provider, and GitHub trust with a computed Effect. Values
 * with {{resolve:...}} dynamic references count as computed.
 */
export function githubTrustViolations(template: CfnTemplate, expectedSubject: string, expectedRef: string): string[] {
  const out: string[] = [];
  for (const [id, role] of resourcesOf(template, (r) => r.Type === 'AWS::IAM::Role')) {
    const document = role.Properties?.AssumeRolePolicyDocument;
    // A document wrapped in Fn::If, or given as a JSON string, has no readable Statement.
    if (document?.Statement === undefined) {
      out.push(`${id}: a computed or missing AssumeRolePolicyDocument cannot be verified`);
      continue;
    }
    for (const statement of asArray<Json>(document.Statement)) {
      if (typeof statement !== 'object' || statement === null) {
        out.push(`${id}: a trust statement without a readable Principal cannot be verified`);
        continue;
      }
      // Only a literal Deny is skipped: it can only take access away, and a computed Effect may resolve to Allow.
      if (statement.Effect === 'Deny') continue;
      if (statement.NotPrincipal !== undefined) {
        out.push(`${id}: NotPrincipal trusts everyone it does not name, GitHub included`);
        continue;
      }
      // "*" is the same as AWS "*".
      const principal = statement.Principal === '*' ? { AWS: '*' } : statement.Principal;
      // A statement wrapped in Fn::If has no Principal, and a Principal wrapped in one has no principal types.
      if (typeof principal !== 'object' || principal === null || Object.keys(principal).some((t) => !PRINCIPAL_TYPES.has(t))) {
        out.push(`${id}: a trust statement without a readable Principal cannot be verified`);
        continue;
      }
      if (Object.values<Json>(principal).some((names) => asArray(names).includes('*'))) {
        out.push(`${id}: a wildcard principal trusts everyone, GitHub included`);
        continue;
      }
      // Federated entries are resolved below; any other computed value may be "*".
      for (const [type, names] of Object.entries<Json>(principal)) {
        if (type === 'Federated') continue;
        for (const name of asArray<Json>(names).filter((n) => !isLiteral(n))) {
          out.push(`${id}: ${type} principal ${JSON.stringify(name)} cannot be verified (it may be "*")`);
        }
      }
      const federated = asArray<Json>(principal.Federated);
      for (const entry of federated.filter((e) => isGitHubOidcPrincipal(template, e) === undefined)) {
        const what = `Federated principal ${JSON.stringify(entry)}`;
        out.push(
          `${id}: ${what} is not a literal ARN or an OIDC provider in this stack with a literal Url, so it cannot be verified`,
        );
      }
      if (!federated.some((e) => isGitHubOidcPrincipal(template, e))) continue;
      if (statement.Effect !== 'Allow') out.push(`${id}: GitHub trust must have a literal Effect, Allow or Deny`);
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

/** Resources that grant a role permissions: their Roles, or a RolePolicy's RoleName, name the role. */
const ROLE_POLICY_TYPES = new Set(['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy', 'AWS::IAM::RolePolicy']);
/** IAM's role name characters; an ARN is not a role name. */
const ROLE_NAME = /^[\w+=,.@-]+$/;
/** What CDK writes for distributionArn before the distribution's ID: a literal account, so no wildcard. */
const DISTRIBUTION_ARN_PREFIX = /^arn:aws:cloudfront::\d{12}:distribution\/$/;

/**
 * Whether a computed Resource is the template's own bucket, objects in it, or distribution, in the forms CDK
 * writes for bucketArn, arnForObjects, and distributionArn.
 */
function isOwnSiteResource(template: CfnTemplate, value: Json): boolean {
  const defines = (id: unknown, type: string) => typeof id === 'string' && template.Resources[id]?.Type === type;
  const isBucketArn = (v: Json) => {
    const [id, attribute] = asArray<Json>(v?.['Fn::GetAtt']);
    return attribute === 'Arn' && defines(id, 'AWS::S3::Bucket');
  };
  if (isBucketArn(value)) return true;
  const [separator, parts] = asArray<Json>(value?.['Fn::Join']);
  if (separator !== '' || parts?.length !== 2) return false;
  const [head, tail] = parts;
  // The key pattern must start with a slash, or it would also match other buckets whose names start with this one's.
  if (isBucketArn(head)) return typeof tail === 'string' && tail.startsWith('/');
  return typeof head === 'string' && DISTRIBUTION_ARN_PREFIX.test(head) && defines(tail?.Ref, 'AWS::CloudFront::Distribution');
}

/**
 * Collects every permission granted to the named role across all templates
 * (its inline policies, and the AWS::IAM::Policy, ManagedPolicy, and
 * RolePolicy resources that name it or Ref it) and flags anything beyond the
 * allowed actions, any resource other than a literal ARN without wildcards or
 * the stack's own bucket, objects in it, or distribution, and any managed
 * policy attached by ARN. Like the DNS check, it fails closed: a RoleName,
 * policy role, document, Effect, Action, or computed resource it cannot read
 * is a violation, and a {{resolve:...}} dynamic reference counts as computed.
 * It reads identity-based policies only, not resource policies, such as a
 * bucket policy that names the role.
 */
export function deployRoleViolations(
  templates: CfnTemplate[],
  roleName: string,
  allowedActions: ReadonlySet<string>,
): string[] {
  return deployRoleViolationsByTemplate(templates, roleName, allowedActions).flat();
}

/** deployRoleViolations, with the violations found in each template listed apart, in the order of the templates. */
export function deployRoleViolationsByTemplate(
  templates: CfnTemplate[],
  roleName: string,
  allowedActions: ReadonlySet<string>,
): string[][] {
  // Role names are unique regardless of case, so IAM finds the role by its name in any case.
  const isRoleName = (name: string) => name.toLowerCase() === roleName.toLowerCase();

  return templates.map((template) => {
    const out: string[] = [];
    const checkDocument = (where: string, document: Json) => {
      // A document wrapped in Fn::If, or given as a JSON string, has no readable Statement.
      if (document?.Statement === undefined) {
        out.push(`${where}: a computed or missing PolicyDocument cannot be verified`);
        return;
      }
      for (const statement of asArray<Json>(document.Statement)) {
        // Only a literal Deny is skipped: a computed Effect may resolve to Allow.
        if (statement.Effect === 'Deny') continue;
        if (statement.Effect !== 'Allow') {
          out.push(`${where}: a statement without a literal Effect (Allow or Deny) cannot be verified`);
          continue;
        }
        if (statement.NotAction !== undefined || statement.NotResource !== undefined) {
          out.push(`${where}: NotAction/NotResource grants are too broad`);
        }
        for (const action of asArray<Json>(statement.Action)) {
          if (!isLiteral(action)) out.push(`${where}: a computed Action ${JSON.stringify(action)} cannot be verified`);
          else if (!allowedActions.has(action)) out.push(`${where}: ${action} is not an allowed deploy action`);
        }
        for (const resource of asArray<Json>(statement.Resource)) {
          // IAM reads both * and ? in an ARN as wildcards.
          if (isLiteral(resource)) {
            if (/[*?]/.test(resource)) out.push(`${where}: wildcard resource ${resource}`);
          } else if (!isOwnSiteResource(template, resource)) {
            const what = `resource ${JSON.stringify(resource)}`;
            out.push(`${where}: ${what} is not this stack's bucket, objects in it, or its distribution, so it cannot be verified`);
          }
        }
      }
    };

    const roleIds: string[] = [];
    for (const [id, role] of resourcesOf(template, (r) => r.Type === 'AWS::IAM::Role')) {
      const props = role.Properties;
      const name = props?.RoleName;
      // Without a RoleName, CloudFormation generates a unique one; a computed one may be the deploy role's.
      if (name !== undefined && !isLiteral(name)) out.push(`${id}: a computed RoleName cannot be verified`);
      if (!isLiteral(name) || !isRoleName(name)) continue;
      roleIds.push(id);
      if (asArray(props?.ManagedPolicyArns).length > 0) out.push(`${id}: managed policies are not allowed on the deploy role`);
      for (const p of asArray<Json>(props?.Policies)) {
        // An entry (or the whole list) wrapped in Fn::If has no literal name.
        checkDocument(`${id}/${typeof p.PolicyName === 'string' ? p.PolicyName : '(computed)'}`, p.PolicyDocument);
      }
    }

    /** Whether a policy's role is the deploy role; undefined for anything but a role name or a Ref to a role here. */
    const isDeployRole = (role: Json): boolean | undefined => {
      if (typeof role === 'string') return ROLE_NAME.test(role) ? isRoleName(role) : undefined;
      const isRoleHere = typeof role?.Ref === 'string' && template.Resources[role.Ref]?.Type === 'AWS::IAM::Role';
      return isRoleHere ? roleIds.includes(role.Ref) : undefined;
    };
    for (const [id, policy] of resourcesOf(template, (r) => ROLE_POLICY_TYPES.has(r.Type))) {
      const props = policy.Properties;
      const roles = asArray<Json>(policy.Type === 'AWS::IAM::RolePolicy' ? props?.RoleName : props?.Roles);
      for (const role of roles.filter((r) => isDeployRole(r) === undefined)) {
        out.push(`${id}: role ${JSON.stringify(role)} is not a role name or a role in this stack, so it cannot be verified`);
      }
      if (roles.some((r) => isDeployRole(r))) checkDocument(id, props?.PolicyDocument);
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// CloudFront flat-rate Free plan compatibility
// Source: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html
// (feature table, "Unsupported features" and "Unsupported associations"), read 2026-10-12.
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
  'AWS::CloudFront::TrustStore': 'viewer mutual TLS needs Premium',
  'AWS::CloudFront::ConnectionFunction': 'connection functions (viewer mutual TLS) need Premium',
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
  const distributions = resourcesOf(template, (r) => r.Type === 'AWS::CloudFront::Distribution').map(
    ([id, r]): [string, Json] => [id, r.Properties?.DistributionConfig ?? {}],
  );
  for (const [id, config] of distributions) violations.push(...distributionViolations(template, id, config));
  violations.push(...sharedAssociationViolations(distributions));
  for (const [id, r] of resourcesOf(template, (r) => r.Type === 'AWS::WAFv2::WebACL')) {
    violations.push(...freePlanWebAclViolations(r.Properties ?? {}).map((v) => `${id}: ${v}`));
  }
  return violations;
}

const behaviorsOf = (config: Json): Json[] => [config.DefaultCacheBehavior ?? {}, ...asArray<Json>(config.CacheBehaviors)];

/** The logical ID of the function a function association references through Fn::GetAtt, if it does. */
const functionRefOf = (assoc: Json): unknown => assoc.FunctionARN?.['Fn::GetAtt']?.[0];

/**
 * A plan distribution's CloudFront Functions and web ACL can be used by no other distribution
 * ("Unsupported associations"). Only distributions in this template can be compared.
 */
function sharedAssociationViolations(distributions: [string, Json][]): string[] {
  const usedBy = new Map<string, Set<string>>();
  for (const [id, config] of distributions) {
    const refs = behaviorsOf(config).flatMap((b) => asArray<Json>(b.FunctionAssociations).map(functionRefOf));
    // CloudFront reads an empty WebACLId as no web ACL.
    const hasWebAcl = config.WebACLId !== undefined && config.WebACLId !== '';
    const associations = [
      ...refs.filter((ref) => typeof ref === 'string').map((ref) => `CloudFront Function ${ref}`),
      ...(hasWebAcl ? [`web ACL ${JSON.stringify(config.WebACLId)}`] : []),
    ];
    for (const association of associations) usedBy.set(association, new Set([...(usedBy.get(association) ?? []), id]));
  }
  const reason = 'a pricing-plan distribution cannot share its functions or web ACL';
  return [...usedBy]
    .filter(([, ids]) => ids.size > 1)
    .map(([association, ids]) => `${association} is shared by ${[...ids].join(', ')}: ${reason}`);
}

function distributionViolations(template: CfnTemplate, id: string, config: Json): string[] {
  const out: string[] = [];
  const behaviors = behaviorsOf(config);
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
    ViewerMtlsConfig: 'viewer mutual TLS needs Premium',
    ConnectionFunctionAssociation: 'connection functions (viewer mutual TLS) need Premium',
    CacheTagConfig: 'cache-tag invalidation needs Pro or higher',
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
    if (origin.CustomOriginConfig?.OriginMtlsConfig !== undefined) {
      out.push(`${id} origin ${origin.Id}: origin mutual TLS needs Business or higher`);
    }
    const oai = origin.S3OriginConfig?.OriginAccessIdentity;
    if (oai !== undefined && oai !== '') out.push(`${id} origin ${origin.Id}: OAI is unsupported; use OAC`);
  }
  return out;
}

function functionAssociationViolations(template: CfnTemplate, where: string, assoc: Json): string[] {
  const ref = functionRefOf(assoc);
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
    const ruleViolations = [...ruleActionViolations(rule.Action), ...statementViolations(rule.Statement ?? {})];
    out.push(...ruleViolations.map((v) => `${name}: ${v}`));
  }
  return out;
}

/** A rule's Action, or a rule group's ActionToUse override. */
function ruleActionViolations(action: Json): string[] {
  const out: string[] = [];
  if (action?.Captcha !== undefined) out.push('CAPTCHA needs Pro or higher');
  if (action?.Challenge !== undefined) out.push('JavaScript challenge needs Business or higher');
  if (action?.Block?.CustomResponse !== undefined) out.push('custom WAF responses need Pro or higher');
  return out;
}

function statementViolations(node: Json): string[] {
  if (node === null || typeof node !== 'object') return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries<Json>(node)) {
    if (key === 'RuleGroupReferenceStatement') out.push('rule groups are unsupported on pricing plans');
    if (key === 'ActionToUse') out.push(...ruleActionViolations(value));
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

// ---------------------------------------------------------------------------
// Stack environment
// ---------------------------------------------------------------------------

/** Where a stack deploys, which the manifest records rather than the template; a CDK Stack has these properties. */
export interface StackEnvironment {
  readonly account: string;
  readonly region: string;
  readonly terminationProtection: boolean;
}

// The Website account and us-east-1 (ADR 0002); never the Management or Identity Delegated Admin accounts.
const WEBSITE_ACCOUNT = '426499248998';
const WEBSITE_REGION = 'us-east-1';

/**
 * Every stack must deploy to the Website account in us-east-1, with termination protection. A stack without an
 * environment has tokens for its account and Region, and deploys wherever the CLI's credentials point.
 */
export function environmentViolations(stack: StackEnvironment): string[] {
  const out: string[] = [];
  if (stack.account !== WEBSITE_ACCOUNT) out.push(`account must be ${WEBSITE_ACCOUNT}, the Website account, not ${stack.account}`);
  if (stack.region !== WEBSITE_REGION) out.push(`Region must be ${WEBSITE_REGION}, not ${stack.region}`);
  if (!stack.terminationProtection) out.push('termination protection must be on');
  return out;
}
