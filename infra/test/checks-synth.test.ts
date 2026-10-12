// Tests for test/support/synth.ts, which every guardrail and stack test synthesizes through.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { CloudAssembly } from 'aws-cdk-lib/cx-api';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createStacks } from '../lib/app';
import { production } from '../lib/config';
import { SiteStack } from '../lib/site-stack';
import { productionConfig, synthesizeAll, synthesizeSite, TEST_CERTIFICATE_ARN, TEST_WEB_ACL_ARN } from './support/synth';

// The real createStacks, wrapped so one test can make the app build a differently named stack.
vi.mock('../lib/app', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/app')>();
  return { ...actual, createStacks: vi.fn(actual.createStacks) };
});

const DISTRIBUTION = 'SiteDistribution3FF9535D';
const originalCertificateArn = production.certificateArn;

afterEach(() => {
  vi.mocked(createStacks).mockReset();
  Object.assign(production, { certificateArn: originalCertificateArn });
});

// CDK deletes its temporary cloud assemblies on process exit, which Vitest workers skip.
afterAll(() => CloudAssembly.cleanupTemporaryDirectories());

describe('productionConfig', () => {
  it('is the production config with the placeholder certificate while none is configured', () => {
    Object.assign(production, { certificateArn: undefined });
    expect(productionConfig()).toEqual({ ...production, certificateArn: TEST_CERTIFICATE_ARN });
  });

  it('uses the configured certificate once it is set', () => {
    const issued = TEST_CERTIFICATE_ARN.replace(/0{8}-/, '12345678-');
    Object.assign(production, { certificateArn: issued });
    expect(productionConfig()).toEqual({ ...production, certificateArn: issued });
  });

  it('applies overrides on top', () => {
    const pricingPlan = { tier: 'FREE', webAclArn: TEST_WEB_ACL_ARN } as const;
    const certificateArn = TEST_CERTIFICATE_ARN.replace(/0{8}-/, '87654321-');
    expect(productionConfig({ pricingPlan, certificateArn })).toEqual({ ...production, pricingPlan, certificateArn });
  });
});

describe('synthesizeAll', () => {
  it('synthesizes the production configuration by default', () => {
    const stacks = synthesizeAll();
    expect(stacks.map((s) => s.stack.stackName)).toEqual(['ZachverseSite']);
    const config = stacks[0]!.json.Resources[DISTRIBUTION]!.Properties!.DistributionConfig;
    expect(config.ViewerCertificate.AcmCertificateArn).toBe(productionConfig().certificateArn);
    expect(config.WebACLId).toBe(production.pricingPlan?.webAclArn);
  });

  it('synthesizes the configuration it is given', () => {
    const [site] = synthesizeAll(productionConfig({ pricingPlan: { tier: 'FREE', webAclArn: TEST_WEB_ACL_ARN } }));
    expect(site!.json.Resources[DISTRIBUTION]!.Properties!.DistributionConfig.WebACLId).toBe(TEST_WEB_ACL_ARN);
  });

  it('applies the feature flags from cdk.json, as cdk deploy would', () => {
    const cdkJson = readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8');
    const flags = Object.entries<unknown>(JSON.parse(cdkJson).context);
    expect(flags.length).toBeGreaterThan(0);
    const [site] = synthesizeAll();
    for (const [key, value] of flags) expect(site!.stack.node.tryGetContext(key), key).toEqual(value);
  });
});

describe('synthesizeSite', () => {
  it('fails clearly when the app has no ZachverseSite stack', () => {
    vi.mocked(createStacks).mockImplementationOnce((app, config) => ({ site: new SiteStack(app, 'RenamedSite', { config }) }));
    expect(() => synthesizeSite()).toThrow('ZachverseSite stack not found');
  });

  it('returns the ZachverseSite stack, synthesized for production by default', () => {
    const { stack, json } = synthesizeSite();
    expect(stack).toBeInstanceOf(SiteStack);
    expect(stack.stackName).toBe('ZachverseSite');
    const config = json.Resources[DISTRIBUTION]!.Properties!.DistributionConfig;
    expect(config.ViewerCertificate.AcmCertificateArn).toBe(productionConfig().certificateArn);
    expect(config.WebACLId).toBe(production.pricingPlan?.webAclArn);
  });

  it('synthesizes the configuration it is given', () => {
    const { json } = synthesizeSite(productionConfig({ pricingPlan: { tier: 'FREE', webAclArn: TEST_WEB_ACL_ARN } }));
    expect(json.Resources[DISTRIBUTION]!.Properties!.DistributionConfig.WebACLId).toBe(TEST_WEB_ACL_ARN);
  });
});
