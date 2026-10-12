export interface PricingPlanConfig {
  /** Only the no-cost tier is modelled; a paid tier must be a deliberate code change. */
  readonly tier: 'FREE';
  /** CLOUDFRONT-scope web ACL in us-east-1, created outside CloudFormation (ADR 0002). */
  readonly webAclArn: string;
}

export interface SiteConfig {
  /** AWS project account that owns the existing hosted zone. */
  readonly account: string;
  /** Project Region. Every stack deploys here; the managed SCP denies CloudFormation in us-east-1. */
  readonly region: string;
  /** Existing public hosted zone. Referenced only; never created or modified by CDK. */
  readonly hostedZoneId: string;
  /** Canonical (apex) website hostname. */
  readonly domainName: string;
  /** Alternate hostname that redirects to the apex. */
  readonly wwwDomainName: string;
  /**
   * us-east-1 ACM certificate for both hostnames, requested and DNS-validated
   * outside CloudFormation (ADR 0002). Required to synthesize the site stack.
   */
  readonly certificateArn?: string;
  /** CloudFront flat-rate plan. Omit for pay-as-you-go (the initial deployment). */
  readonly pricingPlan?: PricingPlanConfig;
}

export const production: SiteConfig = {
  account: '426499248998',
  region: 'us-east-2',
  hostedZoneId: 'Z03492543O0YEY0RDZZ0J',
  domainName: 'zachdavids.com',
  wwwDomainName: 'www.zachdavids.com',
  // Set after the certificate is issued (milestone 4).
  certificateArn: undefined,
  pricingPlan: undefined,
};
