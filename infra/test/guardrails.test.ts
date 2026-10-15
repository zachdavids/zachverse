import { CloudAssembly } from 'aws-cdk-lib/cx-api';
import { afterAll, describe, expect, it } from 'vitest';
import { githubOidcSubject, production } from '../lib/config';
import {
  deployRoleViolations,
  dnsWriteViolations,
  freePlanViolations,
  githubTrustViolations,
  prohibitedResourceViolations,
  retentionViolations,
  WEBSITE_DEPLOY_ACTIONS,
} from '../lib/guardrails/checks';
import { PRICING_MODES, productionConfig, synthesizeAll } from './support/synth';

// CDK deletes its temporary cloud assemblies on process exit, which Vitest workers skip.
afterAll(() => CloudAssembly.cleanupTemporaryDirectories());

// What production deploys as configured, and both pricing modes whichever one it selects.
const configs = { 'production config': productionConfig(), ...PRICING_MODES };

describe.each(Object.entries(configs))('every stack (%s)', (_label, config) => {
  const stacks = synthesizeAll(config);
  const each = stacks.map((s) => [s.stack.stackName, s] as const);

  it.each(each)('%s creates no prohibited resources', (_name, s) => {
    expect(prohibitedResourceViolations(s.json)).toEqual([]);
  });

  it.each(each)('%s grants no DNS write access', (_name, s) => {
    expect(dnsWriteViolations(s.json)).toEqual([]);
  });

  it.each(each)('%s retains every resource', (_name, s) => {
    expect(retentionViolations(s.json)).toEqual([]);
  });

  it.each(each)('%s is Free-plan compatible', (_name, s) => {
    expect(freePlanViolations(s.json)).toEqual([]);
  });

  it.each(each)('%s trusts GitHub only for the production environment subject', (_name, s) => {
    expect(githubTrustViolations(s.json, githubOidcSubject(production.github), production.github.deployRef)).toEqual([]);
  });

  it('gives the GitHub deploy role only website publishing permissions', () => {
    const templates = stacks.map((s) => s.json);
    expect(deployRoleViolations(templates, production.github.deployRoleName, WEBSITE_DEPLOY_ACTIONS)).toEqual([]);
  });
});
