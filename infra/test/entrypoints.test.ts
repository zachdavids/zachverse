import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { gunzipSync } from 'node:zlib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { ArtifactMetadataEntryType, type MetadataEntry } from 'aws-cdk-lib/cloud-assembly-schema';
import { App, Stack } from 'aws-cdk-lib/core';
import { CloudAssembly } from 'aws-cdk-lib/cx-api';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { createStacks } from '../lib/app';
import { production } from '../lib/config';
import { cdkContext, createApp, productionConfig } from './support/synth';

// CDK deletes its temporary cloud assemblies on process exit, which Vitest workers skip.
afterAll(() => CloudAssembly.cleanupTemporaryDirectories());

/** Freezes `value` and every object it holds, so code that changes any of them throws. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const member of Object.values(value)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}

// Metadata entries that only say where in the source something happened: the call that created each stack and
// CloudFormation element and, in debug mode, the one that assigned each property.
const CALL_STACK_ENTRIES = new Set<string>([
  ArtifactMetadataEntryType.CREATION_STACK,
  ArtifactMetadataEntryType.PROPERTY_ASSIGNMENT,
]);

/**
 * Every file in the cloud assembly at `dir`, by its path relative to `dir`, with its contents. The stack metadata
 * files also record call stacks, which differ between bin/ and this file and change nothing the CLI deploys, so
 * they are left out of those files.
 */
function assemblyFiles(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        const contents = readFileSync(file, 'utf8');
        return [
          path.relative(dir, file).replaceAll(path.sep, '/'),
          entry.name.endsWith('.metadata.json') ? withoutCallStacks(contents) : contents,
        ];
      }),
  );
}

/** A stack metadata file without the entries that are call stacks, or the trace that any entry may carry. */
function withoutCallStacks(contents: string): string {
  const metadata: Record<string, MetadataEntry[]> = JSON.parse(contents);
  const kept = Object.entries(metadata).map(([construct, entries]) => [
    construct,
    entries.filter((entry) => !CALL_STACK_ENTRIES.has(entry.type)).map((entry) => ({ ...entry, trace: undefined })),
  ]);
  return JSON.stringify(Object.fromEntries(kept), undefined, 2);
}

/**
 * What a CDKMetadata record reports, without the CDK and Node.js versions that synthesized it, which vary between
 * machines: the constructs in the stack and the validation plugins registered when CDK wrote the record.
 */
function reportedByMetadata(analytics: string): string {
  const [, compressed] = /^v2:deflate64:([A-Za-z0-9+/]+={0,2})$/.exec(analytics) ?? [];
  expect(compressed, analytics).toBeDefined();
  return gunzipSync(Buffer.from(compressed!, 'base64'))
    .toString('utf8')
    .replace(/^\d+\.\d+\.\d+!/, '<CDK version>!')
    .replace(/node\.js\/v\d+\.\d+\.\d+!/, 'node.js/<Node.js version>!');
}

/**
 * ZachverseIdentity is deployed (ADR 0004), so its template is pinned whole, as the CLI writes it apart from the path
 * metadata the CLI's context adds. Update this only for a reviewed change to the deployed stack.
 */
const IDENTITY_TEMPLATE = {
  Description: 'Zachverse GitHub OIDC provider and website deploy role',
  Resources: {
    GitHubOidcProvider7EBF861F: {
      Type: 'AWS::IAM::OIDCProvider',
      Properties: {
        ClientIdList: ['sts.amazonaws.com'],
        Tags: [{ Key: 'project', Value: 'zachverse' }],
        Url: 'https://token.actions.githubusercontent.com',
      },
      UpdateReplacePolicy: 'Retain',
      DeletionPolicy: 'Retain',
    },
    SiteDeployRoleE4618DD6: {
      Type: 'AWS::IAM::Role',
      Properties: {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: 'sts:AssumeRoleWithWebIdentity',
              Condition: {
                StringEquals: {
                  'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                  'token.actions.githubusercontent.com:sub': 'repo:zachdavids@43345768/zachverse@1414719760:environment:production',
                  'token.actions.githubusercontent.com:ref': 'refs/heads/main',
                },
              },
              Effect: 'Allow',
              Principal: { Federated: { Ref: 'GitHubOidcProvider7EBF861F' } },
            },
          ],
          Version: '2012-10-17',
        },
        Description: 'GitHub Actions website deploys: zachdavids/zachverse, environment production',
        MaxSessionDuration: 3600,
        RoleName: 'zachverse-github-site-deploy',
        Tags: [{ Key: 'project', Value: 'zachverse' }],
      },
      UpdateReplacePolicy: 'Retain',
      DeletionPolicy: 'Retain',
    },
    CDKMetadata: {
      Type: 'AWS::CDK::Metadata',
      // Read by reportedByMetadata, below.
      Properties: { Analytics: expect.any(String) },
    },
  },
  Outputs: {
    GitHubOidcProviderArn: { Value: { Ref: 'GitHubOidcProvider7EBF861F' } },
    SiteDeployRoleArn: { Value: { 'Fn::GetAtt': ['SiteDeployRoleE4618DD6', 'Arn'] } },
  },
  Parameters: {
    BootstrapVersion: {
      Type: 'AWS::SSM::Parameter::Value<String>',
      Default: '/cdk-bootstrap/hnb659fds/version',
      Description:
        'Version of the CDK Bootstrap resources in this environment, automatically retrieved from SSM Parameter Store. [cdk:skip]',
    },
  },
  Rules: {
    CheckBootstrapVersion: {
      Assertions: [
        {
          Assert: { 'Fn::Not': [{ 'Fn::Contains': [['1', '2', '3', '4', '5'], { Ref: 'BootstrapVersion' }] }] },
          AssertDescription: "CDK bootstrap stack version 6 required. Please run 'cdk bootstrap' with a recent version of the CDK CLI.",
        },
      ],
    },
  },
};
/** What the identity stack's CDKMetadata record reports: its constructs, and no validation plugin (lib/app.ts). */
const IDENTITY_METADATA =
  '<CDK version>!aws-cdk-lib.{Stack,aws_iam.{OidcProviderNative[{"url":"*","clientIds":"*"}],CfnOIDCProvider,' +
  'Role[{"roleName":"*","description":"*","maxSessionDuration":"*","assumedBy":{"principalAccount":"*","assumeRoleAction":"*"}}],' +
  'CfnRole},CfnOutput},node.js/<Node.js version>!jsii-runtime.Runtime';

const FAIL_SYNTH = '@aws-cdk/core:failSynthOnValidationErrors';
/**
 * The context the CLI gives the app, apart from path and asset metadata: cdk.json's, version reporting, and the
 * setting with which CLI 2.1145 tells every app to record validation failures in the assembly but not fail on them.
 * The CLI fails on the recorded report instead, unless --ignore-errors (or CDK_IGNORE_ERRORS) is set.
 */
const CLI_CONTEXT = { ...cdkContext, [FAIL_SYNTH]: false };

/** Makes bin/'s createStacks record each call, then apply `change` to the stacks it built. */
function spyOnCreateStacks(change: (stacks: ReturnType<typeof createStacks>) => unknown = () => undefined) {
  const calls: Parameters<typeof createStacks>[] = [];
  vi.doMock('../lib/app', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/app')>();
    return {
      createStacks: (...args: Parameters<typeof createStacks>) => {
        calls.push(args);
        const stacks = actual.createStacks(...args);
        change(stacks);
        return stacks;
      },
    };
  });
  return calls;
}

/**
 * Runs `step` (importing bin/zachverse.ts, or the synthesis it set up), lets the work it defers with
 * process.nextTick, a promise, setImmediate, or a zero-delay timer run, as it would under the CLI before Node empties
 * the event loop, and returns the beforeExit and exit listeners added meanwhile. They are removed by then, so none of
 * them runs when the worker exits.
 */
async function listenersAddedBy(step: () => unknown) {
  const existingBeforeExit = process.listeners('beforeExit');
  const existingExit = process.listeners('exit');
  const added = () => ({
    beforeExit: process.listeners('beforeExit').filter((listener) => !existingBeforeExit.includes(listener)),
    exit: process.listeners('exit').filter((listener) => !existingExit.includes(listener)),
  });
  try {
    await step();
    // Zero-delay timers fire in the order they were set, as do immediates, so any that `step` set run before these.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setImmediate(resolve));
    return added();
  } finally {
    const { beforeExit, exit } = added();
    for (const listener of beforeExit) process.removeListener('beforeExit', listener);
    for (const listener of exit) process.removeListener('exit', listener);
  }
}

// Importing bin/zachverse.ts runs the same code `cdk synth` does (cdk-json.test.ts pins the app command).
describe('CDK entry point', () => {
  const directories: string[] = [];
  function temporaryDirectory(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'zachverse-entry-point-'));
    directories.push(dir);
    return dir;
  }

  afterEach(() => {
    vi.doUnmock('../lib/config');
    vi.doUnmock('../lib/app');
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.exitCode = undefined;
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // createStacks always adds the site stack, which rejects each of these, so no certificate problem can leave it out.
  it.each<[string, (arn: string) => string, (arn: string) => string]>([
    ['empty', () => '', () =>
      'certificateArn is not set. Request the us-east-1 ACM certificate and add its ARN to infra/lib/config.ts (docs/adr/0002).'],
    ['for another Region', (arn) => arn.replace(':us-east-1:', ':us-east-2:'),
      (arn) => `certificateArn must be an ACM certificate in us-east-1 owned by 426499248998: ${arn}`],
    ['truncated', (arn) => arn.slice(0, -1), (arn) => `certificateArn must end in the certificate ID (a UUID): ${arn}`],
  ])('lets a certificate ARN that is %s fail the synth instead of swallowing it', async (_case, change, message) => {
    const certificateArn = change(production.certificateArn);
    vi.doMock('../lib/config', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../lib/config')>();
      return { ...actual, production: { ...actual.production, certificateArn } };
    });

    await expect(import('../bin/zachverse.js')).rejects.toThrow(new Error(message(certificateArn)));
  });

  it('synthesizes, as the CLI runs it, the assembly the guardrails check, from the production config unchanged', async () => {
    // The app the guardrail suites check, synthesized before bin/ runs so that nothing bin/ does can change it. Its
    // outdir and autoSynth are explicit, so no CDK_OUTDIR applies to it.
    const reference = temporaryDirectory();
    createApp(productionConfig(), { outdir: reference, autoSynth: false }).synth();

    // The CLI passes the app its context and output directory in these variables, which App reads when it is
    // constructed. With CDK_OUTDIR set, every App that sets neither outdir nor autoSynth synthesizes into it when the
    // process is about to exit.
    const outdir = temporaryDirectory();
    vi.stubEnv('CDK_CONTEXT_JSON', JSON.stringify(CLI_CONTEXT));
    vi.stubEnv('CDK_OUTDIR', outdir);
    // A frozen copy, so bin/ fails where it changes the config.
    vi.doMock('../lib/config', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../lib/config')>();
      return { ...actual, production: deepFreeze(structuredClone(actual.production)) };
    });
    const calls = spyOnCreateStacks();

    // CDK writes a validation report with any finding, a warning included, to stderr.
    const error = vi.spyOn(console, 'error');
    const { beforeExit, exit } = await listenersAddedBy(() => import('../bin/zachverse.js'));
    // One app, so one synthesis, and no beforeExit or exit listener added, before or after that synthesis. Node calls
    // the listener once the event loop is empty, so calling it now misses work bin/ defers longer than
    // listenersAddedBy waits (a delayed timer, an I/O callback).
    expect(beforeExit).toHaveLength(1);
    expect(exit).toEqual([]);
    expect(await listenersAddedBy(() => beforeExit[0]!.call(process, 0))).toEqual({ beforeExit: [], exit: [] });
    expect(process.exitCode ?? 0).toBe(0);
    expect(error).not.toHaveBeenCalled();

    expect(calls).toHaveLength(1);
    const [app, config] = calls[0]!;
    expect(App.isApp(app)).toBe(true);
    expect(config).toEqual(productionConfig());
    expect(app.node.findAll().filter((c) => Stack.isStack(c)).map((s) => s.node.id)).toEqual([
      'ZachverseIdentity',
      'ZachverseSite',
    ]);
    // Every file in the assembly, call stacks in the metadata aside, including the manifest (each stack's environment,
    // termination protection, and deployment roles), the templates, the asset manifests, the stack metadata, and the
    // construct tree.
    expect(assemblyFiles(outdir)).toEqual(assemblyFiles(reference));
    const identity = JSON.parse(readFileSync(path.join(outdir, 'ZachverseIdentity.template.json'), 'utf8'));
    expect(identity).toEqual(IDENTITY_TEMPLATE);
    expect(reportedByMetadata(identity.Resources.CDKMetadata.Properties.Analytics)).toBe(IDENTITY_METADATA);
  });

  const DNS_VIOLATION =
    'Dns (AWS::Route53::RecordSet): hosted zones, DNS records, and domains are managed outside CDK (reviewed batches in infra/dns/)';
  const PLUGIN_FAILURE = "Validation plugin 'Zachverse guardrails' failed: a check threw";

  // bin/ overrides CLI_CONTEXT's setting, so the app fails on its own, and so does every CLI command that synthesizes
  // it, with --ignore-errors or without.
  it.each<[string, () => Promise<unknown>, string, object]>([
    [
      'a violation',
      async () =>
        spyOnCreateStacks(
          ({ site }) =>
            new route53.CfnRecordSet(site, 'Dns', {
              hostedZoneId: 'Z03492543O0YEY0RDZZ0J',
              name: 'zachdavids.com',
              type: 'A',
              ttl: '300',
              resourceRecords: ['192.0.2.1'],
            }),
        ),
      `FATAL ${DNS_VIOLATION} (Zachverse guardrails)`,
      {
        violations: [
          expect.objectContaining({
            ruleName: 'prohibited-resources',
            description: DNS_VIOLATION,
            severity: 'fatal',
            // The CLI checks the violations whose construct is in a stack it selects.
            violatingConstructs: [expect.objectContaining({ constructPath: 'ZachverseSite/Dns' })],
          }),
        ],
      },
    ],
    [
      'guardrails that fail to run',
      async () => {
        // The module bin/ loads, as modules are reset only after each test.
        const { GuardrailsPlugin } = await import('../lib/guardrails/plugin.js');
        vi.spyOn(GuardrailsPlugin.prototype, 'validate').mockImplementation(() => {
          throw new Error('a check threw');
        });
      },
      `ERROR ${PLUGIN_FAILURE}`,
      // No violations, so the CLI, which reads a report without any as a pass, would not fail on it.
      { violations: [], metadata: { error: PLUGIN_FAILURE } },
    ],
  ])('fails that synthesis on %s, though the CLI turns failing off', async (_case, setUp, printed, report) => {
    const outdir = temporaryDirectory();
    vi.stubEnv('CDK_CONTEXT_JSON', JSON.stringify(CLI_CONTEXT));
    vi.stubEnv('CDK_OUTDIR', outdir);
    await setUp();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { beforeExit } = await listenersAddedBy(() => import('../bin/zachverse.js'));
    expect(beforeExit).toHaveLength(1);
    // The CLI sets no app mode, so CDK prints the report and throws. Every input CDK reads the mode from is cleared, so
    // the shell cannot set one either; under Vitest's NODE_ENV, CDK would put the report in the error instead. Thrown
    // from beforeExit, the error makes the app, and so the CLI command, fail.
    for (const variable of ['NODE_ENV', 'CDK_APP_MODE', 'PYTEST_VERSION', 'PYTEST_CURRENT_TEST']) vi.stubEnv(variable, undefined);
    await expect(listenersAddedBy(() => beforeExit[0]!.call(process, 0))).rejects.toThrow(
      /^Validation failed\. A copy of this report can be found in: .*validation-report\.json$/,
    );
    expect(error).toHaveBeenCalledOnce();
    expect(stripVTControlCharacters(String(error.mock.calls[0]![0]))).toContain(printed);

    // The assembly records the failure too; the CLI reads it there when the assembly is passed to --app.
    const written = JSON.parse(readFileSync(path.join(outdir, 'validation-report.json'), 'utf8'));
    expect(written.pluginReports).toEqual([
      expect.objectContaining({ pluginName: 'Zachverse guardrails', conclusion: 'failure', ...report }),
    ]);
  });

  // The CLI passes the app its context (cdk.json's, --context values, and its own settings) in CDK_CONTEXT_JSON, and
  // any that does not fit in the environment in a file that CONTEXT_OVERFLOW_LOCATION_ENV names.
  it.each<[string, (dir: string) => void]>([
    ['in CDK_CONTEXT_JSON', () => vi.stubEnv('CDK_CONTEXT_JSON', JSON.stringify(CLI_CONTEXT))],
    [
      'in the file for context that does not fit in the environment',
      (dir) => {
        const file = path.join(dir, 'context-overflow.json');
        writeFileSync(file, JSON.stringify({ [FAIL_SYNTH]: false }));
        vi.stubEnv('CDK_CONTEXT_JSON', JSON.stringify(cdkContext));
        vi.stubEnv('CONTEXT_OVERFLOW_LOCATION_ENV', file);
      },
    ],
  ])('keeps failing on validation errors when the CLI turns that off %s', async (_case, pass) => {
    pass(temporaryDirectory());
    const calls = spyOnCreateStacks();
    await import('../bin/zachverse.js');
    expect(calls).toHaveLength(1);
    const [app] = calls[0]!;
    expect(app.node.tryGetContext(FAIL_SYNTH)).toBe(true);
  });
});
