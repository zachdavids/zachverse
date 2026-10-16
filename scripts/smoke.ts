// Entry for the release smoke test (ADR 0006): node scripts/smoke.ts <dir>, where <dir> holds the release's files.
// $CLOUDFRONT_DOMAIN is the distribution's own hostname and $BUCKET its bucket.
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { SITE_ORIGIN } from './site-origin.ts';
import { request } from './smoke-http.ts';
import { retrying, smokeTest } from './smoke-lib.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

async function main(args: string[]): Promise<string[]> {
  if (args.length !== 1) throw new Error('Usage: node scripts/smoke.ts <dir>');
  const target = {
    origin: SITE_ORIGIN,
    cloudfront: required('CLOUDFRONT_DOMAIN'),
    bucket: required('BUCKET'),
    probe: `smoke-test-${randomUUID()}`,
  };
  const { passed, failures } = await smokeTest(args[0]!, target, retrying(request, (ms) => sleep(ms)));
  const lines = [
    '### Smoke test',
    '',
    ...passed.map((check) => `- Passed: ${check}`),
    ...failures.map((failure) => `- **Failed:** ${failure}`),
  ];
  console.log(lines.join('\n'));
  // Added to the run's summary page as well.
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `${lines.join('\n')}\n\n`);
  return failures;
}

let failures: string[];
try {
  failures = await main(process.argv.slice(2));
} catch (error) {
  failures = [error instanceof Error ? error.message : String(error)];
}
// An ::error:: line shows on the run's summary page as well as in the log.
for (const failure of failures) console.error(`::error::${failure}`);
if (failures.length > 0) process.exit(1);
