import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ArtifactMetadataEntryType, type MetadataEntry } from 'aws-cdk-lib/cloud-assembly-schema';
import { App, Stack } from 'aws-cdk-lib/core';
import { CloudAssembly } from 'aws-cdk-lib/cx-api';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { createStacks } from '../lib/app';
import { cdkContext, createApp, productionConfig, TEST_CERTIFICATE_ARN } from './support/synth';

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
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('lets a configuration error fail the synth instead of swallowing it', async () => {
    // Set, so createStacks adds the site stack, but to a certificate in another Region, which the site stack rejects.
    const certificateArn = TEST_CERTIFICATE_ARN.replace(':us-east-1:', ':us-east-2:');
    vi.doMock('../lib/config', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../lib/config')>();
      return { ...actual, production: { ...actual.production, certificateArn } };
    });

    await expect(import('../bin/zachverse.js')).rejects.toThrow(
      new Error(`certificateArn must be an ACM certificate in us-east-1 owned by 426499248998: ${certificateArn}`),
    );
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
    vi.stubEnv('CDK_CONTEXT_JSON', JSON.stringify(cdkContext));
    vi.stubEnv('CDK_OUTDIR', outdir);
    // A frozen copy, so bin/ fails where it changes the config. It has the placeholder certificate only until
    // milestone 4 sets certificateArn.
    vi.doMock('../lib/config', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../lib/config')>()),
      production: deepFreeze(structuredClone(productionConfig())),
    }));
    const calls: Parameters<typeof createStacks>[] = [];
    vi.doMock('../lib/app', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../lib/app')>();
      return {
        createStacks: (...args: Parameters<typeof createStacks>) => {
          calls.push(args);
          return actual.createStacks(...args);
        },
      };
    });

    const { beforeExit, exit } = await listenersAddedBy(() => import('../bin/zachverse.js'));
    // One app, so one synthesis, and no beforeExit or exit listener added, before or after that synthesis. Node calls
    // the listener once the event loop is empty, so calling it now misses work bin/ defers longer than
    // listenersAddedBy waits (a delayed timer, an I/O callback).
    expect(beforeExit).toHaveLength(1);
    expect(exit).toEqual([]);
    expect(await listenersAddedBy(() => beforeExit[0]!.call(process, 0))).toEqual({ beforeExit: [], exit: [] });

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
  });

  it('synthesizes only the identity stack, and says why, while certificateArn is unset', async () => {
    // As above, with the certificate unset in both the checked app and bin/'s config.
    const reference = temporaryDirectory();
    createApp(productionConfig({ certificateArn: undefined }), { outdir: reference, autoSynth: false }).synth();

    const outdir = temporaryDirectory();
    vi.stubEnv('CDK_CONTEXT_JSON', JSON.stringify(cdkContext));
    vi.stubEnv('CDK_OUTDIR', outdir);
    vi.doMock('../lib/config', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../lib/config')>();
      return { ...actual, production: deepFreeze({ ...structuredClone(actual.production), certificateArn: undefined }) };
    });
    // Captured, so the test checks the message instead of printing it.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { beforeExit } = await listenersAddedBy(() => import('../bin/zachverse.js'));
    expect(beforeExit).toHaveLength(1);
    await listenersAddedBy(() => beforeExit[0]!.call(process, 0));

    expect(error.mock.calls).toEqual([
      ['ZachverseSite skipped: set certificateArn in infra/lib/config.ts first (docs/adr/0002).'],
    ]);
    expect(new CloudAssembly(outdir).stacks.map((s) => s.stackName)).toEqual(['ZachverseIdentity']);
    expect(assemblyFiles(outdir)).toEqual(assemblyFiles(reference));
  });
});
