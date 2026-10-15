// Entry for the deploy and restore workflows (ADR 0006):
//   node scripts/release.ts publish <dir>            publishes the build in <dir> as the release of $GITHUB_SHA
//   node scripts/release.ts restore <release> <dir>  restores the verified release with that commit SHA, and
//                                                    writes its files to <dir> for the smoke test
//   node scripts/release.ts verified                 records this run's release as verified, after its smoke test
//   node scripts/release.ts rollback <dir>           after this run's release failed, restores the last verified one
//                                                    before it, writes its files to <dir>, and sets the step's
//                                                    output release to its commit (empty if nothing was rolled back)
// $BUCKET and $DISTRIBUTION_ID name the site; GitHub sets the run's variables.
import { appendFileSync } from 'node:fs';
import { cloudfrontCdn, s3Store } from './release-aws.ts';
import { githubRepository } from './release-github.ts';
import { type Outcome, publish, recordVerified, restore, rollBack } from './release-lib.ts';

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

function outcomeLines(title: string, { release, uploaded, replaced, kept, removed, invalidated }: Outcome): string[] {
  return [
    `### ${title} ${release}`,
    '',
    `- Assets uploaded: ${uploaded.length === 0 ? 'none' : uploaded.join(', ')}`,
    `- Assets replaced, and invalidated: ${replaced.length === 0 ? 'none' : replaced.join(', ')}`,
    `- Assets already in place: ${kept.length === 0 ? 'none' : kept.join(', ')}`,
    `- Pages removed: ${removed.length === 0 ? 'none' : removed.join(', ')}`,
    `- Paths invalidated: ${invalidated.join(', ')}`,
  ];
}

async function main(command: string | undefined, args: string[]): Promise<void> {
  const usage = 'Usage: node scripts/release.ts publish <dir> | restore <release> <dir> | verified | rollback <dir>';
  const arity = new Map([
    ['publish', 1],
    ['restore', 2],
    ['verified', 0],
    ['rollback', 1],
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
    // Set by a Deploy run started by hand to publish over a restore, which otherwise holds deploys.
    const resume = process.env.RESUME_DEPLOYS === 'true';
    report(outcomeLines('Published', await publish(args[0]!, required('GITHUB_SHA'), repository, context, resume)));
  } else if (command === 'restore') {
    report([
      ...outcomeLines('Restored', await restore(args[0]!, args[1]!, context)),
      '',
      'Deploys are held: pushes to main publish nothing until the Deploy workflow is run on main by hand with "Publish over a restore" checked.',
    ]);
  } else if (command === 'rollback') {
    const outcome = await rollBack(args[0]!, context);
    // The workflow smoke-tests and records the rolled-back release only when this names one.
    const output = process.env.GITHUB_OUTPUT;
    if (output) appendFileSync(output, `release=${outcome?.release ?? ''}\n`);
    if (outcome === undefined) console.log('::warning::Nothing was rolled back; the log above says why.');
    else report(outcomeLines('Rolled back to', outcome));
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
