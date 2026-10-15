import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import { App, type AppProps, NestedStack, Stack } from 'aws-cdk-lib/core';
import { createStacks } from '../../lib/app';
import { production, type SiteConfig } from '../../lib/config';
import type { CfnTemplate } from '../../lib/guardrails/template';

/** A web ACL ARN of the right form, for the guardrail tests; the site stack creates its own web ACL (ADR 0007). */
export const TEST_WEB_ACL_ARN = `arn:aws:wafv2:us-east-1:${production.account}:global/webacl/zachverse/00000000-0000-0000-0000-000000000000`;

const cdkJson = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'cdk.json'), 'utf8'));

/**
 * cdk.json's feature flags, plus version reporting, which cdk.json keeps on for the CLI. The CLI also passes keys for
 * path and asset metadata and for bundling, which this leaves out. Tests then synthesize the same resources and
 * properties as `cdk deploy`; only the CLI's path metadata differs.
 */
export const cdkContext = { ...cdkJson.context, 'aws:cdk:version-reporting': cdkJson.versionReporting !== false };

export function productionConfig(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return { ...production, ...overrides };
}

/** The production config with the Free flat-rate plan off and on. Production deploys one, so tests check both. */
export const PRICING_MODES = {
  'pay-as-you-go': productionConfig({ pricingPlan: undefined }),
  'Free flat-rate plan': productionConfig({ pricingPlan: { tier: 'FREE' } }),
};

export interface SynthesizedStack {
  stack: Stack;
  template: Template;
  json: CfnTemplate;
}

/** The app the guardrail suites check (through synthesizeAll): every stack for `config`, with cdkContext. */
export function createApp(config: SiteConfig, props: Omit<AppProps, 'context'> = {}): App {
  const app = new App({ ...props, context: cdkContext });
  createStacks(app, config);
  return app;
}

/**
 * Synthesizes every stack in the app for the given configuration, including any created inside another
 * stack or a Stage, which createStacks does not return but `cdk synth` still emits. A nested stack is
 * part of its parent's template, where prohibitedResourceViolations flags it.
 */
export function synthesizeAll(config: SiteConfig = productionConfig()): SynthesizedStack[] {
  const app = createApp(config);
  const stacks = app.node.findAll().filter((c): c is Stack => Stack.isStack(c) && !NestedStack.isNestedStack(c));
  return stacks.map((stack) => {
    const template = Template.fromStack(stack);
    return { stack, template, json: template.toJSON() as CfnTemplate };
  });
}

export function synthesizeSite(config: SiteConfig = productionConfig()): SynthesizedStack {
  const site = synthesizeAll(config).find((s) => s.stack.stackName === 'ZachverseSite');
  if (!site) throw new Error('ZachverseSite stack not found');
  return site;
}
