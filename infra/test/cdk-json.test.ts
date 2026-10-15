import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { CURRENTLY_RECOMMENDED_FLAGS } from 'aws-cdk-lib/cx-api';
import { describe, expect, it } from 'vitest';

const cdkJson = JSON.parse(readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'));

describe('cdk.json', () => {
  it('runs the entry point with the installed tsx', () => {
    // node --import fails when tsx is missing, where npx would download whatever version is latest.
    expect(cdkJson.app).toBe('node --import tsx bin/zachverse.ts');
  });

  it('runs no build step, so a signed-in CLI loads only itself and the app', () => {
    // ADR 0004's runbook typechecks and runs the tests before the administrator signs in, so no test code runs beside
    // the session. The CLI refuses a build key in ~/.cdk.json, so only --build or CDK_BUILD could add one, and the
    // runbook rules both out.
    expect(cdkJson).not.toHaveProperty('build');
  });

  it('keeps version reporting on', () => {
    // AWS uses the reported versions to contact users of CDK releases with serious security or reliability issues.
    // The CLI then adds AWS::CDK::Metadata, and support/synth.ts adds it to the test templates too. Set here, as the
    // CLI's default is not enough: the user's ~/.cdk.json, which the CLI reads under cdk.json, could turn it off.
    expect(cdkJson.versionReporting).toBe(true);
  });

  it('loads no CLI plugins', () => {
    // The CLI replaces lists when it merges settings, so this empty one also drops any list in the user's ~/.cdk.json.
    expect(cdkJson.plugin).toEqual([]);
  });

  it('sets every feature flag the installed CDK recommends', () => {
    // Presence only, so a flag can still be turned off deliberately.
    const missing = Object.keys(CURRENTLY_RECOMMENDED_FLAGS).filter((flag) => !(flag in cdkJson.context));
    expect(missing).toEqual([]);
  });
});
