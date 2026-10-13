// Proves that every synthesis of an app built by createStacks runs the template guardrails (lib/guardrails/plugin.ts)
// and fails on any violation. checks.test.ts proves the checks themselves; entrypoints.test.ts, that bin/ runs them
// and fails on a violation although the CLI's context turns failing off.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { App, RemovalPolicies, Stack, Stage, Validations } from 'aws-cdk-lib/core';
import { CloudAssembly } from 'aws-cdk-lib/cx-api';
import { Construct } from 'constructs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createStacks } from '../lib/app';
import { githubOidcSubject, production } from '../lib/config';
import { GuardrailsPlugin } from '../lib/guardrails/plugin';
import { cdkContext, createApp, PRICING_MODES, productionConfig } from './support/synth';

// CDK deletes its temporary cloud assemblies on process exit, which Vitest workers skip.
afterAll(() => CloudAssembly.cleanupTemporaryDirectories());
afterEach(() => vi.restoreAllMocks());

const WEBSITE = { account: '426499248998', region: 'us-east-1' };
const DNS = 'hosted zones, DNS records, and domains are managed outside CDK (reviewed batches in infra/dns/)';
const TRANSFORMED = 'transforms and macros rewrite the template during deployment, so these guardrails cannot see the result';

type Stacks = ReturnType<typeof createStacks>;

/** The production app as createStacks builds it, with cdk.json's context, after `change`. */
function productionApp(change: (app: App, stacks: Stacks) => void): App {
  const app = new App({ context: cdkContext });
  change(app, createStacks(app, productionConfig()));
  return app;
}

/** Another stack that deploys to the Website account and us-east-1, with termination protection, retaining everything. */
function extraStack(scope: Construct, id = 'Extra'): Stack {
  const stack = new Stack(scope, id, { env: WEBSITE, terminationProtection: true });
  RemovalPolicies.of(stack).retain();
  return stack;
}

/** An apex A record, which only the reviewed batches in infra/dns/ may change. */
const record = (scope: Construct, id: string) =>
  new route53.CfnRecordSet(scope, id, {
    hostedZoneId: 'Z03492543O0YEY0RDZZ0J',
    name: 'zachdavids.com',
    type: 'A',
    ttl: '300',
    resourceRecords: ['192.0.2.1'],
  });

/** Synthesizes `app`, which must fail, and returns the error and the report the guardrails gave. */
function failedSynthesis(app: App) {
  const validate = vi.spyOn(GuardrailsPlugin.prototype, 'validate');
  let error: unknown;
  try {
    app.synth();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(Error);
  expect(validate).toHaveBeenCalledOnce();
  return { message: (error as Error).message, report: validate.mock.results[0]!.value };
}

// The report as CDK hands it on: it finds the construct for the logical ID the guardrails name, and makes the template
// path relative to the cloud assembly.
/** A violation about a resource in the template. */
const resource = (resourceLogicalId: string, constructPath: string, templatePath = 'ZachverseSite.template.json') => ({
  resourceLogicalId,
  constructPath,
  templatePath,
  locations: [],
});
/** A violation about a stack, or its template as a whole. */
const wholeStack = (constructPath: string) => ({ constructPath, templatePath: `${constructPath}.template.json`, locations: [] });
const fatal = (ruleName: string, description: string, violating: object) => ({
  ruleName,
  description,
  severity: 'fatal',
  violatingResources: [violating],
});

describe.each(Object.entries(PRICING_MODES))('the production app (%s)', (_mode, config) => {
  it('synthesizes, with the guardrails checking both stacks and finding nothing', () => {
    const validate = vi.spyOn(GuardrailsPlugin.prototype, 'validate');
    const assembly = createApp(config).synth();
    expect(assembly.stacks.map((s) => s.stackName)).toEqual(['ZachverseIdentity', 'ZachverseSite']);
    expect(validate).toHaveBeenCalledOnce();
    const [context] = validate.mock.calls[0]!;
    expect(context.stackTemplates.map((s) => s.templatePath)).toEqual(assembly.stacks.map((s) => s.templateFullPath));
    expect(validate.mock.results[0]!.value).toEqual({ success: true, violations: [] });
  });
});

describe('every synthesis of an app built by createStacks', () => {
  it.each<[string, (site: Stack) => unknown, string]>([
    ['a DNS record', (site) => record(site, 'Dns'), `Dns (AWS::Route53::RecordSet): ${DNS}`],
    [
      'a Lambda function',
      (site) =>
        new lambda.Function(site, 'Fn', {
          runtime: lambda.Runtime.NODEJS_22_X,
          handler: 'index.handler',
          code: lambda.Code.fromInline('exports.handler = async () => {};'),
        }),
      'Fn9270CBC0 (AWS::Lambda::Function): website stacks need no Lambda functions (and Lambda@Edge is not allowed in this project)',
    ],
  ])('fails when the site stack gets %s, naming the violation', (_case, add, violation) => {
    const app = productionApp((_app, { site }) => add(site));
    expect(() => app.synth()).toThrow(`FATAL ${violation} (Zachverse guardrails)`);
  });

  it('runs once in each synthesis, however often the app is synthesized', () => {
    const app = productionApp((_app, { site }) => record(site, 'Dns'));
    const validate = vi.spyOn(GuardrailsPlugin.prototype, 'validate');
    const violation = `FATAL Dns (AWS::Route53::RecordSet): ${DNS} (Zachverse guardrails)`;
    expect(() => app.synth()).toThrow(violation);
    // A failed synthesis leaves no cloud assembly, so CDK synthesizes the app again.
    expect(() => app.synth()).toThrow(violation);
    expect(validate).toHaveBeenCalledTimes(2);
  });

  // CDK skips acknowledged violations unless they are fatal. Pinned, so a CDK release that changes this fails here.
  it('still fails when the rule is acknowledged, since every violation is fatal', () => {
    const app = productionApp((app, { site }) => {
      record(site, 'Dns');
      for (const scope of [app, site]) {
        Validations.of(scope).acknowledge({ id: 'Zachverse-guardrails::prohibited-resources', reason: 'Proves nothing changes.' });
      }
    });
    const { message, report } = failedSynthesis(app);
    // CDK names the rule by the ID acknowledged above.
    expect(message).toContain(`FATAL Dns (AWS::Route53::RecordSet): ${DNS} (Zachverse guardrails)`);
    expect(message).toContain('Rule Zachverse-guardrails::prohibited-resources');
    expect(report).toEqual({
      success: false,
      violations: [fatal('prohibited-resources', `Dns (AWS::Route53::RecordSet): ${DNS}`, resource('Dns', 'ZachverseSite/Dns'))],
    });
  });

  const subject = githubOidcSubject(production.github);
  it.each<[string, (app: App, stacks: Stacks) => unknown, ReturnType<typeof fatal>[]]>([
    ['a prohibited resource', (_app, { site }) => record(site, 'Dns'),
      [fatal('prohibited-resources', `Dns (AWS::Route53::RecordSet): ${DNS}`, resource('Dns', 'ZachverseSite/Dns'))]],
    ['a transform (about the whole stack, as it names no resource)', (_app, { site }) => site.addTransform('DnsMacro'),
      [fatal('prohibited-resources', `Transform "DnsMacro": ${TRANSFORMED}`, wholeStack('ZachverseSite'))]],
    [
      'DNS write access (about the role whose inline policy grants it)',
      (_app, { site }) =>
        new iam.Role(site, 'Ops', {
          assumedBy: new iam.AccountRootPrincipal(),
          inlinePolicies: {
            Dns: new iam.PolicyDocument({
              statements: [new iam.PolicyStatement({ actions: ['route53:ChangeResourceRecordSets'], resources: ['*'] })],
            }),
          },
        }),
      [fatal('dns-write-access', 'OpsA097D252/Dns: grants Route 53 write access (route53:ChangeResourceRecordSets)',
        resource('OpsA097D252', 'ZachverseSite/Ops/Resource'))],
    ],
    [
      'a resource that is not retained',
      (app) => new s3.CfnBucket(new Stack(app, 'Extra', { env: WEBSITE, terminationProtection: true }), 'Bucket'),
      [fatal('retention',
        'Bucket (AWS::S3::Bucket) must have DeletionPolicy Retain or RetainExceptOnCreate, and UpdateReplacePolicy Retain',
        resource('Bucket', 'Extra/Bucket', 'Extra.template.json'))],
    ],
    ['a custom cache policy', (_app, { site }) => new cloudfront.CachePolicy(site, 'Custom'),
      [fatal('free-plan', 'Custom8166710A (AWS::CloudFront::CachePolicy): custom cache policies need Business or higher',
        resource('Custom8166710A', 'ZachverseSite/Custom/Resource'))]],
    [
      'GitHub trust without conditions',
      (app) =>
        new iam.CfnRole(extraStack(app), 'Trusting', {
          assumeRolePolicyDocument: {
            Statement: [{
              Effect: 'Allow',
              Action: 'sts:AssumeRoleWithWebIdentity',
              Principal: { Federated: 'arn:aws:iam::426499248998:oidc-provider/token.actions.githubusercontent.com' },
            }],
          },
        }),
      [
        'Trusting: GitHub trust must use only StringEquals conditions (found none)',
        'Trusting: audience must be sts.amazonaws.com',
        `Trusting: subject must be exactly ${subject}`,
        'Trusting: ref must be exactly refs/heads/main',
      ].map((description) => fatal('github-trust', description, resource('Trusting', 'Extra/Trusting', 'Extra.template.json'))),
    ],
    [
      // The deploy role is in the identity stack; this grant to it is in another stack.
      'a grant to the deploy role from another stack',
      (app) => {
        const extra = extraStack(app);
        new iam.Policy(extra, 'Grant', {
          roles: [iam.Role.fromRoleName(extra, 'DeployRole', 'zachverse-github-site-deploy')],
          statements: [new iam.PolicyStatement({ actions: ['s3:DeleteObject'], resources: ['arn:aws:s3:::bucket/index.html'] })],
        });
      },
      [fatal('deploy-role', 'GrantD7D271C4: s3:DeleteObject is not an allowed deploy action',
        resource('GrantD7D271C4', 'Extra/Grant/Resource', 'Extra.template.json'))],
    ],
    [
      'a stack that deploys elsewhere (about the stack)',
      (app) => new Stack(app, 'Elsewhere', { env: { account: '969788248923', region: 'us-east-2' } }),
      [
        'account must be 426499248998, the Website account, not 969788248923',
        'Region must be us-east-1, not us-east-2',
        'termination protection must be on',
      ].map((description) => fatal('environment', description, wholeStack('Elsewhere'))),
    ],
  ])('reports %s as fatal, with its rule, resource, and template', (_case, change, violations) => {
    const { message, report } = failedSynthesis(productionApp(change));
    expect(report).toEqual({ success: false, violations });
    for (const { description } of violations) expect(message).toContain(`FATAL ${description} (Zachverse guardrails)`);
  });

  // cdk synth emits these stacks too, so they must be checked although createStacks does not return them. A Stage's
  // stacks are in a nested cloud assembly.
  it.each<[string, (app: App, site: Stack) => Construct, string, string]>([
    ['inside the site stack', (_app, site) => site, 'ZachverseSite/Dns', 'ZachverseSiteDnsDE62EAB5.template.json'],
    ['inside a Stage', (app) => new Stage(app, 'Staged'), 'Staged/Dns',
      path.join('assembly-Staged', 'StagedDns88DF7736.template.json')],
    ['under a plain construct', (app) => new Construct(app, 'Shared'), 'Shared/Dns', 'SharedDnsD7C37332.template.json'],
  ])('checks a stack created %s', (_case, scopeFor, stackPath, templatePath) => {
    const app = productionApp((app, { site }) => record(extraStack(scopeFor(app, site), 'Dns'), 'Record'));
    const { message, report } = failedSynthesis(app);
    const description = `Record (AWS::Route53::RecordSet): ${DNS}`;
    expect(message).toContain(`FATAL ${description} (Zachverse guardrails)`);
    expect(report).toEqual({
      success: false,
      violations: [fatal('prohibited-resources', description, resource('Record', `${stackPath}/Record`, templatePath))],
    });
  });
});

describe('GuardrailsPlugin', () => {
  it('flags a template whose stack is not in the app, since where that stack deploys cannot be verified', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'zachverse-guardrails-'));
    try {
      const templatePath = path.join(dir, 'Lost.template.json');
      // No Resources section, as CDK writes for a stack with nothing in it.
      writeFileSync(templatePath, JSON.stringify({ Transform: 'DnsMacro' }));
      const report = new GuardrailsPlugin().validate({
        templatePaths: [templatePath],
        stackTemplates: [{ stackConstructPath: 'Lost', templatePath, accountId: WEBSITE.account, region: WEBSITE.region }],
        appConstruct: new App(),
      });
      // Called directly, so the report is as the plugin returns it, before CDK adds to it.
      const lost = { constructPath: 'Lost', templatePath, locations: [] };
      const unknown = 'the app has no stack at Lost, so its account, Region, and termination protection cannot be verified';
      expect(report).toEqual({
        success: false,
        violations: [
          fatal('prohibited-resources', `Transform "DnsMacro": ${TRANSFORMED}`, lost),
          fatal('environment', unknown, lost),
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
