import { describe, expect, it } from 'vitest';
import { githubOidcSubject, production } from '../lib/config';
import {
  deployRoleViolations,
  dnsWriteViolations,
  freePlanViolations,
  githubTrustViolations,
  prohibitedResourceViolations,
  retentionViolations,
  WEBSITE_DEPLOY_ACTIONS,
} from './support/checks';
import { productionConfig, synthesizeAll, TEST_WEB_ACL_ARN } from './support/synth';

const modes = {
  'pay-as-you-go': productionConfig(),
  'Free flat-rate plan': productionConfig({ pricingPlan: { tier: 'FREE', webAclArn: TEST_WEB_ACL_ARN } }),
};

describe.each(Object.entries(modes))('every stack (%s)', (_mode, config) => {
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
    expect(githubTrustViolations(s.json, githubOidcSubject(production.github))).toEqual([]);
  });

  it('gives the GitHub deploy role only website publishing permissions', () => {
    const templates = stacks.map((s) => s.json);
    expect(deployRoleViolations(templates, production.github.deployRoleName, WEBSITE_DEPLOY_ACTIONS)).toEqual([]);
  });
});
