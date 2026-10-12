import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import { App, NestedStack, Stack } from 'aws-cdk-lib/core';
import { createStacks } from '../../lib/app';
import { production, type SiteConfig } from '../../lib/config';

/** Placeholder until the real certificate exists; same account and Region rules as the real one. */
export const TEST_CERTIFICATE_ARN = `arn:aws:acm:us-east-1:${production.account}:certificate/00000000-0000-0000-0000-000000000000`;
export const TEST_WEB_ACL_ARN = `arn:aws:wafv2:us-east-1:${production.account}:global/webacl/zachverse/00000000-0000-0000-0000-000000000000`;

const cdkJson = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'cdk.json'), 'utf8'));

/**
 * The context the CLI gives the app: cdk.json's feature flags, plus version reporting, which the CLI turns on
 * unless cdk.json sets versionReporting to false. Tests then synthesize the same resources and properties as
 * `cdk deploy`; only the CLI's path metadata differs.
 */
const cdkContext = { ...cdkJson.context, 'aws:cdk:version-reporting': cdkJson.versionReporting !== false };

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

/**
 * Synthesizes every stack in the app for the given configuration, including any created inside another
 * stack or a Stage, which createStacks does not return but `cdk synth` still emits. A nested stack is
 * part of its parent's template, where prohibitedResourceViolations flags it.
 */
export function synthesizeAll(config: SiteConfig = productionConfig()): SynthesizedStack[] {
  const app = new App({ context: cdkContext });
  createStacks(app, config);
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
