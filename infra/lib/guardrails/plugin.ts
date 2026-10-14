// Runs the template guardrails (./checks.ts) inside every synthesis of the app, as a CDK policy-validation plugin, so
// a violation fails the synthesis whether or not the tests ran first (bin/zachverse.ts stops the CLI turning that off).
import { readFileSync } from 'node:fs';
import {
  type IPolicyValidationContext,
  type IPolicyValidationPlugin,
  type PolicyValidationPluginReport,
  type PolicyViolatingResource,
  type PolicyViolation,
  Stack,
} from 'aws-cdk-lib/core';
import { githubOidcSubject, production } from '../config';
import {
  deployRoleViolationsByTemplate,
  dnsWriteViolations,
  environmentViolations,
  freePlanViolations,
  githubTrustViolations,
  prohibitedResourceViolations,
  retentionViolations,
  WEBSITE_DEPLOY_ACTIONS,
} from './checks';
import type { CfnTemplate } from './template';

/** A synthesized stack: its construct path, its template, and the stack itself, if the app has one at that path. */
interface Checked {
  readonly path: string;
  readonly templatePath: string;
  readonly template: CfnTemplate;
  readonly stack: Stack | undefined;
}

const eachTemplate = (check: (template: CfnTemplate) => string[]) => (checked: Checked[]) =>
  checked.map(({ template }) => check(template));

/**
 * The template checks test/guardrails.test.ts runs on the production app, by rule, each giving the violations it
 * finds in every template, in order. GitHub trust and the deploy role are checked against the production config.
 */
const TEMPLATE_RULES: Record<string, (checked: Checked[]) => string[][]> = {
  'prohibited-resources': eachTemplate(prohibitedResourceViolations),
  // With no allowance: no stack may write DNS (ADR 0002).
  'dns-write-access': eachTemplate((template) => dnsWriteViolations(template)),
  retention: eachTemplate(retentionViolations),
  'free-plan': eachTemplate(freePlanViolations),
  'github-trust': eachTemplate((template) =>
    githubTrustViolations(template, githubOidcSubject(production.github), production.github.deployRef),
  ),
  // Across all templates at once, as any stack can grant the deploy role permissions by its name.
  'deploy-role': (checked) =>
    deployRoleViolationsByTemplate(
      checked.map(({ template }) => template),
      production.github.deployRoleName,
      WEBSITE_DEPLOY_ACTIONS,
    ),
};

/**
 * Checks every template a synthesis writes, wherever its stack is in the app, with every rule above and the
 * account, Region, and termination-protection rules (environmentViolations). Every violation is fatal, and CDK
 * lets no acknowledgment (Validations.of(...).acknowledge()) suppress a fatal one, so any violation fails the report,
 * as does an error thrown here. A failed report fails the synthesis unless the app's context turns that off, which
 * bin/zachverse.ts prevents.
 */
export class GuardrailsPlugin implements IPolicyValidationPlugin {
  readonly name = 'Zachverse guardrails';

  validate(context: IPolicyValidationContext): PolicyValidationPluginReport {
    // A template has no account, Region, or termination protection, so those come from the stack that wrote it.
    const stacks = new Map(
      context.appConstruct.node
        .findAll()
        .filter((c): c is Stack => Stack.isStack(c))
        .map((stack) => [stack.node.path, stack]),
    );
    const checked: Checked[] = context.stackTemplates.map(({ stackConstructPath, templatePath }) => ({
      path: stackConstructPath,
      templatePath,
      template: JSON.parse(readFileSync(templatePath, 'utf8')),
      stack: stacks.get(stackConstructPath),
    }));
    const violations = [
      ...Object.entries(TEMPLATE_RULES).flatMap(([rule, check]) =>
        check(checked).flatMap((found, i) =>
          found.map((description) => fatal(rule, description, violatingResource(description, checked[i]!))),
        ),
      ),
      ...checked.flatMap((c) => environmentOf(c).map((description) => fatal('environment', description, wholeStack(c)))),
    ];
    return { success: violations.length === 0, violations };
  }
}

const fatal = (ruleName: string, description: string, violating: PolicyViolatingResource): PolicyViolation => ({
  ruleName,
  description,
  severity: 'fatal',
  violatingResources: [violating],
});

const wholeStack = ({ path, templatePath }: Checked): PolicyViolatingResource => ({
  constructPath: path,
  templatePath,
  locations: [],
});

/**
 * The resource a violation names first, which lets CDK show its construct and the code that created it. A violation
 * that names none, such as a transform or an association two distributions share, is about the whole stack.
 */
function violatingResource(description: string, checked: Checked): PolicyViolatingResource {
  // The ways ./checks.ts follows a logical ID; a template-wide finding such as `Transform "X": ...` or `Fn::Transform: ...`
  // starts with none of them after any ID, so it is not pinned on a resource that happens to be named Transform or Fn.
  const named = Object.keys(checked.template.Resources ?? {}).find((id) =>
    [' (', ': ', '/', ' origin ', ' behavior '].some((separator) => description.startsWith(`${id}${separator}`)),
  );
  return named ? { resourceLogicalId: named, templatePath: checked.templatePath, locations: [] } : wholeStack(checked);
}

/** The environment rules, which fail closed when the app has no stack at the template's construct path. */
function environmentOf({ path, stack }: Checked): string[] {
  return stack
    ? environmentViolations(stack)
    : [`the app has no stack at ${path}, so its account, Region, and termination protection cannot be verified`];
}
