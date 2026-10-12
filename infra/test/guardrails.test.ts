import { describe, expect, it } from 'vitest';
import {
  dnsWriteViolations,
  freePlanViolations,
  prohibitedResourceViolations,
  retentionViolations,
} from './support/checks';
import { productionConfig, synthesizeAll, TEST_WEB_ACL_ARN } from './support/synth';

const modes = {
  'pay-as-you-go': productionConfig(),
  'Free flat-rate plan': productionConfig({ pricingPlan: { tier: 'FREE', webAclArn: TEST_WEB_ACL_ARN } }),
};

describe.each(Object.entries(modes))('every stack (%s)', (_mode, config) => {
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
