export interface PricingPlanConfig {
  /** Only the no-cost tier is modelled; a paid tier must be a deliberate code change. */
  readonly tier: 'FREE';
  /** CLOUDFRONT-scope web ACL (us-east-1); how it is created is decided in milestone 7. */
  readonly webAclArn: string;
}

export interface GitHubDeployConfig {
  readonly ownerName: string;
  /** Immutable GitHub IDs; this repository's OIDC subject includes them (ADR 0004). */
  readonly ownerId: number;
  readonly repoName: string;
  readonly repoId: number;
  /** GitHub environment the deploy job runs in; its deployment branches are limited to main. */
  readonly environment: string;
  /** Fixed so the site stack can grant permissions to the role by name. */
  readonly deployRoleName: string;
}

/** The `sub` claim GitHub issues for jobs in the deploy environment (immutable-ID format). */
export function githubOidcSubject(github: GitHubDeployConfig): string {
  return `repo:${github.ownerName}@${github.ownerId}/${github.repoName}@${github.repoId}:environment:${github.environment}`;
}

export interface SiteConfig {
  /** Website account (426499248998), which owns the existing hosted zone. Never an administrative account. */
  readonly account: string;
  /** Region for every stack and regional resource (ADR 0002). */
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
  /** GitHub Actions identity allowed to publish the website. */
  readonly github: GitHubDeployConfig;
}

export const production: SiteConfig = {
  account: '426499248998',
  region: 'us-east-1',
  hostedZoneId: 'Z03492543O0YEY0RDZZ0J',
  domainName: 'zachdavids.com',
  wwwDomainName: 'www.zachdavids.com',
  // Set after the certificate is issued (milestone 4).
  certificateArn: undefined,
  pricingPlan: undefined,
  github: {
    ownerName: 'zachdavids',
    ownerId: 43345768,
    repoName: 'zachverse',
    repoId: 1414719760,
    environment: 'production',
    deployRoleName: 'zachverse-github-site-deploy',
  },
};
