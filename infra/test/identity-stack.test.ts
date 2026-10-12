import { describe, expect, it } from 'vitest';
import { githubOidcSubject, production } from '../lib/config';
import { synthesizeAll } from './support/synth';

const PROVIDER = 'GitHubOidcProvider7EBF861F';
const ROLE = 'SiteDeployRoleE4618DD6';

describe('identity stack', () => {
  const identity = synthesizeAll().find((s) => s.stack.stackName === 'ZachverseIdentity')!;
  const resources = identity.json.Resources;

  it('uses the immutable-ID subject GitHub issues for this repository', () => {
    // Verified 2026-10-11: GET repos/zachdavids/zachverse/actions/oidc/customization/sub returned
    // use_immutable_subject=true, sub_claim_prefix "repo:zachdavids@43345768/zachverse@1414719760".
    expect(githubOidcSubject(production.github)).toBe(
      'repo:zachdavids@43345768/zachverse@1414719760:environment:production',
    );
  });

  it('registers GitHub as an OIDC provider with the STS audience and no pinned thumbprints', () => {
    expect(resources[PROVIDER]!.Type).toBe('AWS::IAM::OIDCProvider');
    expect(resources[PROVIDER]!.Properties).toEqual({
      Url: 'https://token.actions.githubusercontent.com',
      ClientIdList: ['sts.amazonaws.com'],
      Tags: [{ Key: 'project', Value: 'zachverse' }],
    });
  });

  it('lets only production-environment jobs on main in this repository assume the deploy role', () => {
    expect(resources[ROLE]!.Properties!.AssumeRolePolicyDocument).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'sts:AssumeRoleWithWebIdentity',
          Principal: { Federated: { Ref: PROVIDER } },
          Condition: {
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              'token.actions.githubusercontent.com:sub':
                'repo:zachdavids@43345768/zachverse@1414719760:environment:production',
              // The environment subject names no branch, so the ref is checked separately.
              'token.actions.githubusercontent.com:ref': 'refs/heads/main',
            },
          },
        },
      ],
    });
  });

  it('gives the deploy role a fixed name, a one-hour session limit, and no permissions of its own', () => {
    const props = resources[ROLE]!.Properties!;
    expect(props.RoleName).toBe('zachverse-github-site-deploy');
    expect(props.MaxSessionDuration).toBe(3600);
    expect(props.Policies).toBeUndefined();
    expect(props.ManagedPolicyArns).toBeUndefined();
    expect(Object.values(resources).filter((r) => r.Type.startsWith('AWS::IAM::') && r.Type.endsWith('Policy'))).toEqual([]);
  });

  it('exports the provider and role ARNs', () => {
    expect(Object.keys(identity.json.Outputs ?? {}).sort()).toEqual(['GitHubOidcProviderArn', 'SiteDeployRoleArn']);
  });
});
