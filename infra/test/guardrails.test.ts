import { CloudAssembly } from 'aws-cdk-lib/cx-api';
import { afterAll, describe, expect, it } from 'vitest';
import {
  dnsWriteViolations,
  freePlanViolations,
  prohibitedResourceViolations,
  retentionViolations,
} from './support/checks';
import { PRICING_MODES, productionConfig, synthesizeAll } from './support/synth';

// CDK deletes its temporary cloud assemblies on process exit, which Vitest workers skip.
afterAll(() => CloudAssembly.cleanupTemporaryDirectories());

// What production deploys as configured, and both pricing modes whichever one it selects.
const configs = { 'production config': productionConfig(), ...PRICING_MODES };

describe.each(Object.entries(configs))('every stack (%s)', (_label, config) => {
  const stacks = synthesizeAll(config);

  it.each(stacks.map((s) => [s.stack.stackName, s] as const))('%s creates no prohibited resources', (_name, s) => {
    expect(prohibitedResourceViolations(s.json)).toEqual([]);
  });

  it.each(stacks.map((s) => [s.stack.stackName, s] as const))('%s grants no DNS write access', (_name, s) => {
    expect(dnsWriteViolations(s.json)).toEqual([]);
  });

  it.each(stacks.map((s) => [s.stack.stackName, s] as const))('%s retains every resource', (_name, s) => {
    expect(retentionViolations(s.json)).toEqual([]);
  });

  it.each(stacks.map((s) => [s.stack.stackName, s] as const))('%s is Free-plan compatible', (_name, s) => {
    expect(freePlanViolations(s.json)).toEqual([]);
  });
});
