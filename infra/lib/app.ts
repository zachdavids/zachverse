import { type App, Validations } from 'aws-cdk-lib/core';
import type { SiteConfig } from './config';
import { GuardrailsPlugin } from './guardrails/plugin';
import { IdentityStack } from './identity-stack';
import { SiteStack } from './site-stack';

/**
 * Adds every Zachverse stack to the app, and the guardrails that check them whenever the app is synthesized. A
 * violation fails the synthesis unless the app's context turns that off, as the CLI's does; bin/ turns it back on, so
 * every CLI command that synthesizes the app fails on a violation even when the tests are skipped. Tests synthesize
 * through this too.
 */
export function createStacks(app: App, config: SiteConfig) {
  const env = { account: config.account, region: config.region };

  const identity = new IdentityStack(app, 'ZachverseIdentity', {
    env,
    config,
    terminationProtection: true,
    description: 'Zachverse GitHub OIDC provider and website deploy role',
  });

  const site = new SiteStack(app, 'ZachverseSite', {
    env,
    config,
    terminationProtection: true,
    description: `Zachverse website hosting for ${config.domainName}: S3 origin and CloudFront distribution`,
  });
  // The site stack grants permissions to the identity stack's deploy role.
  site.addStackDependency(identity);

  addGuardrails(app);
  return { identity, site };
}

/**
 * Makes every synthesis of the app run the guardrails on every stack in it. They are registered during synthesis,
 * after CDK creates each stack's version-reporting resource (AWS::CDK::Metadata), which records the validation plugins
 * registered at that moment: registered earlier, they would be listed there and change the deployed identity stack's
 * template. CDK validates the construct tree after creating those resources and before it runs the plugins.
 */
function addGuardrails(app: App): void {
  let added = false;
  app.node.addValidation({
    validate: () => {
      // Once, however often the app is synthesized.
      if (!added) Validations.of(app).addPlugins(new GuardrailsPlugin());
      added = true;
      return [];
    },
  });
}
