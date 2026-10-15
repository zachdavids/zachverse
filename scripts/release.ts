// Entry for the deploy and restore workflows (ADR 0006):
//   node scripts/release.ts publish <dir>            publishes the build in <dir> as the release of $GITHUB_SHA
//   node scripts/release.ts restore <release> <dir>  restores a verified release ("previous" or a commit SHA) and
//                                                    writes its files to <dir> for the smoke test
//   node scripts/release.ts verified                 records this run's release as verified, after its smoke test
// $BUCKET and $DISTRIBUTION_ID name the site; GitHub sets the run's variables.
import { appendFileSync } from 'node:fs';
import { cloudfrontCdn, s3Store } from './release-aws.ts';
import { githubRepository } from './release-github.ts';
import { type Outcome, publish, recordVerified, restore } from './release-lib.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

// Printed to the log and added to the run's summary page.
function report(lines: string[]): void {
  console.log(lines.join('\n'));
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `${lines.join('\n')}\n\n`);
}

function outcomeLines(title: string, { release, uploaded, kept, invalidated }: Outcome): string[] {
  return [
    `### ${title} ${release}`,
    '',
    `- Assets uploaded: ${uploaded.length === 0 ? 'none' : uploaded.join(', ')}`,
    `- Assets already in place: ${kept.length === 0 ? 'none' : kept.join(', ')}`,
    `- Paths invalidated: ${invalidated.join(', ')}`,
  ];
}

async function main(command: string | undefined, args: string[]): Promise<void> {
  const usage = 'Usage: node scripts/release.ts publish <dir> | restore <release> <dir> | verified';
  const arity = new Map([
    ['publish', 1],
    ['restore', 2],
    ['verified', 0],
  ]);
  if (arity.get(command ?? '') !== args.length) throw new Error(usage);
  const context = {
    store: s3Store(required('BUCKET')),
    cdn: cloudfrontCdn(required('DISTRIBUTION_ID')),
    run: `${required('GITHUB_RUN_ID')}-${required('GITHUB_RUN_ATTEMPT')}`,
    now: () => new Date().toISOString(),
    log: (message: string) => console.log(message),
  };
  if (command === 'publish') {
    const repository = githubRepository(required('GITHUB_REPOSITORY'), required('GITHUB_TOKEN'));
    report(outcomeLines('Published', await publish(args[0]!, required('GITHUB_SHA'), repository, context)));
  } else if (command === 'restore') {
    report(outcomeLines('Restored', await restore(args[0]!, args[1]!, context)));
  } else {
    const { release, run } = await recordVerified(context);
    report([`### Verified ${release}`, '', `The smoke test passed, and run ${run} recorded the release as verified.`]);
  }
}

try {
  await main(process.argv[2], process.argv.slice(3));
} catch (error) {
  // An ::error:: line shows on the run's summary page as well as in the log.
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
