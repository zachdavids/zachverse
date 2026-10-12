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

  it('typechecks and runs the tests before every synth, diff, and deploy', () => {
    // tsx does not typecheck. The output goes to stderr so `cdk synth` still prints only the template.
    expect(cdkJson.build).toBe('npm run typecheck 1>&2 && npm test 1>&2');
  });

  it('keeps version reporting on', () => {
    // AWS uses the reported versions to contact users of CDK releases with serious security or reliability issues.
    // The CLI then adds AWS::CDK::Metadata, and support/synth.ts adds it to the test templates too.
    expect(cdkJson.versionReporting ?? true).toBe(true);
  });

  it('sets every feature flag the installed CDK recommends', () => {
    // Presence only, so a flag can still be turned off deliberately.
    const missing = Object.keys(CURRENTLY_RECOMMENDED_FLAGS).filter((flag) => !(flag in cdkJson.context));
    expect(missing).toEqual([]);
  });
});
