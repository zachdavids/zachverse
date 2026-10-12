import { App, Stack } from 'aws-cdk-lib/core';
import { CloudAssembly } from 'aws-cdk-lib/cx-api';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { createStacks } from '../lib/app';
import type { SiteConfig } from '../lib/config';
import { TEST_CERTIFICATE_ARN } from './support/synth';

// CDK deletes its temporary cloud assemblies on process exit, which Vitest workers skip.
afterAll(() => CloudAssembly.cleanupTemporaryDirectories());

// Importing bin/zachverse.ts runs the same code `cdk synth` does (cdk-json.test.ts pins the app command).
describe('CDK entry point', () => {
  afterEach(() => {
    vi.doUnmock('../lib/config');
    vi.doUnmock('../lib/app');
    vi.resetModules();
  });

  it('lets a configuration error fail the synth instead of swallowing it', async () => {
    vi.doMock('../lib/config', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../lib/config')>();
      return { ...actual, production: { ...actual.production, certificateArn: undefined } };
    });

    await expect(import('../bin/zachverse.js')).rejects.toThrow(
      new Error(
        'certificateArn is not set. Request the us-east-1 ACM certificate and add its ARN to infra/lib/config.ts (docs/adr/0002).',
      ),
    );
  });

  it('builds a new app with only the site stack, from the production config unchanged', async () => {
    let configured: SiteConfig | undefined;
    vi.doMock('../lib/config', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../lib/config')>();
      configured = { ...actual.production, certificateArn: TEST_CERTIFICATE_ARN };
      return { ...actual, production: configured };
    });
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

    await import('../bin/zachverse.js');

    expect(calls).toHaveLength(1);
    const [app, config] = calls[0]!;
    expect(App.isApp(app)).toBe(true);
    expect(config).toEqual(configured);
    expect(app.node.findAll().filter((c) => Stack.isStack(c)).map((s) => s.node.id)).toEqual(['ZachverseSite']);
  });
});
