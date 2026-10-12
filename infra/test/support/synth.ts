import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import { App, type Stack } from 'aws-cdk-lib/core';
import { createStacks } from '../../lib/app';
import { production, type SiteConfig } from '../../lib/config';

/** Placeholder until the real certificate exists; same account and Region rules as the real one. */
export const TEST_CERTIFICATE_ARN = `arn:aws:acm:us-east-1:${production.account}:certificate/00000000-0000-0000-0000-000000000000`;
export const TEST_WEB_ACL_ARN = `arn:aws:wafv2:us-east-1:${production.account}:global/webacl/zachverse/00000000-0000-0000-0000-000000000000`;

/** Feature flags from cdk.json, so tests synthesize exactly what `cdk deploy` would. */
const cdkContext = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'cdk.json'), 'utf8')).context;

export function productionConfig(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return { ...production, certificateArn: production.certificateArn ?? TEST_CERTIFICATE_ARN, ...overrides };
}

export interface SynthesizedStack {
  stack: Stack;
  template: Template;
  json: CfnTemplate;
}

export interface CfnResource {
  Type: string;
  Properties?: Record<string, any>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  DependsOn?: string | string[];
}

export interface CfnTemplate {
  Transform?: unknown;
  Resources: Record<string, CfnResource>;
  Outputs?: Record<string, unknown>;
}

/** Synthesizes every stack in the app for the given configuration. */
export function synthesizeAll(config: SiteConfig = productionConfig()): SynthesizedStack[] {
  const app = new App({ context: cdkContext });
  const stacks = Object.values(createStacks(app, config));
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
