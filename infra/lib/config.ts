/** CloudFront flat-rate plan. The site stack also creates the web ACL the plan requires (ADR 0007). */
export interface PricingPlanConfig {
  /** Only the no-cost tier is modelled; a paid tier must be a deliberate code change. */
  readonly tier: 'FREE';
}

export interface GitHubDeployConfig {
  readonly ownerName: string;
  /** Immutable GitHub IDs; this repository's OIDC subject includes them (ADR 0004). */
  readonly ownerId: number;
  readonly repoName: string;
  readonly repoId: number;
  /** GitHub environment the deploy job runs in; its deployment branches are limited to main. */
  readonly environment: string;
  /**
   * Git ref the deploy job must run from. An environment subject names no
   * branch, so the trust policy also checks the `ref` claim (AWS IAM guidance).
   */
  readonly deployRef: string;
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
   * outside CloudFormation (ADR 0002). The site stack refuses to synthesize
   * without a valid one.
   */
  readonly certificateArn: string;
  /** CloudFront flat-rate plan, and its web ACL. Omit for pay-as-you-go. */
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
  // Requested on 2026-10-13; infra/dns/2026-10-13-acm-validation.json holds its validation records.
  certificateArn: 'arn:aws:acm:us-east-1:426499248998:certificate/f285dc12-6f64-4d9b-8309-043d5e90f354',
  // Milestone 7 (ADR 0007).
  pricingPlan: { tier: 'FREE' },
  github: {
    ownerName: 'zachdavids',
    ownerId: 43345768,
    repoName: 'zachverse',
    repoId: 1414719760,
    environment: 'production',
    deployRef: 'refs/heads/main',
    deployRoleName: 'zachverse-github-site-deploy',
  },
};
