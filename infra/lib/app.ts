import type { App } from 'aws-cdk-lib/core';
import type { SiteConfig } from './config';
import { IdentityStack } from './identity-stack';
import { SiteStack } from './site-stack';

/**
 * Adds every Zachverse stack to the app. Tests synthesize through this too.
 * The site stack needs the out-of-band certificate (ADR 0002), so it is only
 * added once `certificateArn` is configured; the identity stack does not wait.
 */
export function createStacks(app: App, config: SiteConfig) {
  const env = { account: config.account, region: config.region };

  const identity = new IdentityStack(app, 'ZachverseIdentity', {
    env,
    config,
    terminationProtection: true,
    description: 'Zachverse GitHub OIDC provider and website deploy role',
  });

  if (!config.certificateArn) return { identity };

  const site = new SiteStack(app, 'ZachverseSite', {
    env,
    config,
    terminationProtection: true,
    description: `Zachverse website hosting for ${config.domainName}: S3 origin and CloudFront distribution`,
  });
  // The site stack grants permissions to the identity stack's deploy role.
  site.addStackDependency(identity);

  return { identity, site };
}
