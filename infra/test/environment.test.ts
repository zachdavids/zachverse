import { App } from 'aws-cdk-lib/core';
import { describe, expect, it } from 'vitest';
import { createStacks } from '../lib/app';
import { production } from '../lib/config';
import { productionConfig, synthesizeAll, TEST_WEB_ACL_ARN } from './support/synth';

// The Website account; never the Management or Identity Delegated Admin accounts.
const EXPECTED_ACCOUNT = '426499248998';
// Every stack and regional resource lives in us-east-1 (docs/adr/0002).
const EXPECTED_REGION = 'us-east-1';

describe('stack environments', () => {
  const stacks = synthesizeAll();

  it('defines the identity and site stacks, with the site deployed after identity', () => {
    expect(stacks.map((s) => s.stack.stackName)).toEqual(['ZachverseIdentity', 'ZachverseSite']);
    const [identity, site] = stacks;
    expect(site!.stack.dependencies).toEqual([identity!.stack]);
  });

  it.each(stacks.map((s) => [s.stack.stackName, s.stack] as const))(
    '%s targets the Website account and us-east-1 with termination protection',
    (_name, stack) => {
      expect(stack.account).toBe(EXPECTED_ACCOUNT);
      expect(stack.region).toBe(EXPECTED_REGION);
      expect(stack.terminationProtection).toBe(true);
    },
  );

  it('synthesizes only the identity stack until the certificate ARN is configured', () => {
    expect(production.certificateArn).toBeUndefined();
    const { identity, site } = createStacks(new App(), production);
    expect(identity.stackName).toBe('ZachverseIdentity');
    expect(site).toBeUndefined();
  });
});

// Changing a logical ID makes CloudFormation replace the resource (for the
// distribution: a new domain name, and alias conflicts). Update these lists
// only for an intended, reviewed replacement.
const IDENTITY_RESOURCES = {
  GitHubOidcProvider7EBF861F: 'AWS::IAM::OIDCProvider',
  SiteDeployRoleE4618DD6: 'AWS::IAM::Role',
};
const SITE_RESOURCES = {
  SiteBucket397A1860: 'AWS::S3::Bucket',
  SiteBucketPolicy3AC1D0F8: 'AWS::S3::BucketPolicy',
  SiteOriginAccessControl4DD454FF: 'AWS::CloudFront::OriginAccessControl',
  ViewerRequestFunction48E73F66: 'AWS::CloudFront::Function',
  SiteDistribution3FF9535D: 'AWS::CloudFront::Distribution',
  SiteDeployPolicyEEC9A210: 'AWS::IAM::Policy',
};

function logicalIds(resources: Record<string, { Type: string }>) {
  return Object.fromEntries(Object.entries(resources).map(([id, r]) => [id, r.Type]));
}

describe('logical ID stability', () => {
  it('keeps identity and site resource logical IDs fixed', () => {
    const [identity, site] = synthesizeAll();
    expect(logicalIds(identity!.json.Resources)).toEqual(IDENTITY_RESOURCES);
    expect(logicalIds(site!.json.Resources)).toEqual(SITE_RESOURCES);
  });

  it('enabling the Free plan only adds the subscription; nothing is replaced', () => {
    const [identity, site] = synthesizeAll(productionConfig({ pricingPlan: { tier: 'FREE', webAclArn: TEST_WEB_ACL_ARN } }));
    expect(logicalIds(identity!.json.Resources)).toEqual(IDENTITY_RESOURCES);
    expect(logicalIds(site!.json.Resources)).toEqual({
      ...SITE_RESOURCES,
      PricingPlanSubscription: 'AWS::PricingPlanManager::Subscription',
    });
  });
});
