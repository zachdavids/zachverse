import * as iam from 'aws-cdk-lib/aws-iam';
import { CfnOutput, Duration, RemovalPolicies, Stack, type StackProps, Tags } from 'aws-cdk-lib/core';
import type { Construct } from 'constructs';
import { githubOidcSubject, type SiteConfig } from './config';

export const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';
export const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com';

export interface IdentityStackProps extends StackProps {
  readonly config: SiteConfig;
}

/**
 * GitHub OIDC provider and the website deploy role. The role has no
 * permissions here: the site stack grants it access to its own bucket and
 * distribution (ADR 0004), so permissions exist only once those resources do.
 */
export class IdentityStack extends Stack {
  readonly siteDeployRole: iam.Role;

  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, props);
    const { github } = props.config;

    // No thumbprints: IAM validates GitHub's endpoint against its own trusted CAs.
    const provider = new iam.OidcProviderNative(this, 'GitHubOidcProvider', {
      url: GITHUB_OIDC_URL,
      clientIds: [GITHUB_OIDC_AUDIENCE],
    });

    this.siteDeployRole = new iam.Role(this, 'SiteDeployRole', {
      roleName: github.deployRoleName,
      description: `GitHub Actions website deploys: ${github.ownerName}/${github.repoName}, environment ${github.environment}`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': GITHUB_OIDC_AUDIENCE,
          'token.actions.githubusercontent.com:sub': githubOidcSubject(github),
          'token.actions.githubusercontent.com:ref': github.deployRef,
        },
      }),
    });

    RemovalPolicies.of(this).retain();
    Tags.of(this).add('project', 'zachverse');

    new CfnOutput(this, 'GitHubOidcProviderArn', { value: provider.oidcProviderArn });
    new CfnOutput(this, 'SiteDeployRoleArn', { value: this.siteDeployRole.roleArn });
  }
}
