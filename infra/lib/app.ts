import type { App } from 'aws-cdk-lib/core';
import type { SiteConfig } from './config';
import { SiteStack } from './site-stack';

/** Adds every Zachverse stack to the app. Tests synthesize through this too. */
export function createStacks(app: App, config: SiteConfig) {
  const env = { account: config.account, region: config.region };

  const site = new SiteStack(app, 'ZachverseSite', {
    env,
    config,
    terminationProtection: true,
    description: `Zachverse website hosting for ${config.domainName}: S3 origin and CloudFront distribution`,
  });

  return { site };
}
