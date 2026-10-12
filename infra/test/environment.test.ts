import { CloudAssembly } from 'aws-cdk-lib/cx-api';
import { afterAll, describe, expect, it } from 'vitest';
import { productionConfig, synthesizeAll, TEST_WEB_ACL_ARN } from './support/synth';

// CDK deletes its temporary cloud assemblies on process exit, which Vitest workers skip.
afterAll(() => CloudAssembly.cleanupTemporaryDirectories());

const EXPECTED_ACCOUNT = '426499248998';
// Every stack and regional resource lives in us-east-1 (docs/adr/0002).
const EXPECTED_REGION = 'us-east-1';

describe('stack environments', () => {
  const stacks = synthesizeAll();

  it('defines the expected stacks', () => {
    expect(stacks.map((s) => s.stack.stackName)).toEqual(['ZachverseSite']);
  });

  it.each(stacks.map((s) => [s.stack.stackName, s.stack] as const))(
    '%s targets the project account and Region with termination protection',
    (_name, stack) => {
      expect(stack.account).toBe(EXPECTED_ACCOUNT);
      expect(stack.region).toBe(EXPECTED_REGION);
      expect(stack.terminationProtection).toBe(true);
    },
  );

  it('describes the site stack by its domain', () => {
    const [site] = stacks;
    expect(site!.template.toJSON().Description).toBe(
      'Zachverse website hosting for zachdavids.com: S3 origin and CloudFront distribution',
    );
  });
});

// Changing a logical ID makes CloudFormation replace the resource (for the
// distribution: a new domain name, and alias conflicts). Update this list only
// for an intended, reviewed replacement.
const SITE_RESOURCES = {
  SiteBucket397A1860: 'AWS::S3::Bucket',
  SiteBucketPolicy3AC1D0F8: 'AWS::S3::BucketPolicy',
  SiteOriginAccessControl4DD454FF: 'AWS::CloudFront::OriginAccessControl',
  ViewerRequestFunction48E73F66: 'AWS::CloudFront::Function',
  SiteDistribution3FF9535D: 'AWS::CloudFront::Distribution',
};

function logicalIds(resources: Record<string, { Type: string }>) {
  return Object.fromEntries(Object.entries(resources).map(([id, r]) => [id, r.Type]));
}

describe('logical ID stability', () => {
  it('keeps site resource logical IDs fixed', () => {
    const [site] = synthesizeAll();
    expect(logicalIds(site!.json.Resources)).toEqual(SITE_RESOURCES);
  });

  it('enabling the Free plan only adds the subscription; nothing is replaced', () => {
    const [site] = synthesizeAll(productionConfig({ pricingPlan: { tier: 'FREE', webAclArn: TEST_WEB_ACL_ARN } }));
    expect(logicalIds(site!.json.Resources)).toEqual({
      ...SITE_RESOURCES,
      PricingPlanSubscription: 'AWS::PricingPlanManager::Subscription',
    });
  });
});
