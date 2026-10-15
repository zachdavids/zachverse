import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, Outcome } from './release-lib.ts';

const lib = vi.hoisted(() => ({
  publish: vi.fn<(dir: string, release: string, repository: unknown, context: Context, resume?: boolean) => Promise<Outcome>>(),
  restore: vi.fn<(requested: string, outDir: string, context: Context) => Promise<Outcome>>(),
  recordVerified: vi.fn<(context: Context) => Promise<{ release: string; run: string }>>(),
  rollBack: vi.fn<(outDir: string, context: Context) => Promise<Outcome | undefined>>(),
}));
const aws = vi.hoisted(() => ({ s3Store: vi.fn(), cloudfrontCdn: vi.fn() }));
const github = vi.hoisted(() => ({ githubRepository: vi.fn() }));
vi.mock('./release-lib.ts', () => lib);
vi.mock('./release-aws.ts', () => aws);
vi.mock('./release-github.ts', () => github);

const SHA = 'a'.repeat(40);
const OUTCOME: Outcome = {
  release: SHA,
  uploaded: ['assets/index-AbCd1234.js'],
  replaced: [],
  kept: [],
  removed: ['about/index.html'],
  invalidated: ['/', '/index.html'],
};

describe('release script', () => {
  let summaryDir: string;
  const argv = process.argv;

  beforeEach(() => {
    vi.resetModules();
    summaryDir = mkdtempSync(join(tmpdir(), 'release-test-'));
    vi.stubEnv('BUCKET', 'site-bucket');
    vi.stubEnv('DISTRIBUTION_ID', 'E3R8NEUOW8Z97U');
    vi.stubEnv('GITHUB_RUN_ID', '7');
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '2');
    vi.stubEnv('GITHUB_SHA', SHA);
    vi.stubEnv('GITHUB_REPOSITORY', 'zachdavids/zachverse');
    vi.stubEnv('GITHUB_TOKEN', 'token');
    vi.stubEnv('GITHUB_STEP_SUMMARY', join(summaryDir, 'summary.md'));
    aws.s3Store.mockReturnValue('store');
    aws.cloudfrontCdn.mockReturnValue('cdn');
    github.githubRepository.mockReturnValue('repository');
  });

  afterEach(() => {
    process.argv = argv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const mock of [...Object.values(lib), ...Object.values(aws), ...Object.values(github)]) mock.mockReset();
    rmSync(summaryDir, { recursive: true, force: true });
  });

  // Each import runs the script once, as `node scripts/release.ts ...` does; throwing stops it where process.exit would.
  const run = async (...args: string[]) => {
    process.argv = ['node', 'scripts/release.ts', ...args];
    const output = {
      exit: vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      }),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    };
    await import('./release.ts').catch((error: unknown) => {
      if (!(error instanceof Error && error.message.startsWith('process.exit('))) throw error;
    });
    return output;
  };
  const summary = () => readFileSync(join(summaryDir, 'summary.md'), 'utf8');

  it("publishes a directory as this commit's release, comparing through GitHub, and reports it", async () => {
    lib.publish.mockImplementation(async (_dir, _release, _repository, context) => {
      context.log('a message');
      expect(context.now()).toMatch(/^\d{4}-\d\d-\d\dT/);
      return OUTCOME;
    });
    const { exit, error, log } = await run('publish', 'site');

    expect(aws.s3Store).toHaveBeenCalledExactlyOnceWith('site-bucket');
    expect(aws.cloudfrontCdn).toHaveBeenCalledExactlyOnceWith('E3R8NEUOW8Z97U');
    expect(github.githubRepository).toHaveBeenCalledExactlyOnceWith('zachdavids/zachverse', 'token');
    expect(lib.publish).toHaveBeenCalledExactlyOnceWith(
      'site',
      SHA,
      'repository',
      expect.objectContaining({ store: 'store', cdn: 'cdn', run: '7-2' }),
      false,
    );
    const report = [
      `### Published ${SHA}`,
      '',
      '- Assets uploaded: assets/index-AbCd1234.js',
      '- Assets replaced, and invalidated: none',
      '- Assets already in place: none',
      '- Pages removed: about/index.html',
      '- Paths invalidated: /, /index.html',
    ].join('\n');
    expect(log.mock.calls).toEqual([['a message'], [report]]);
    expect(summary()).toBe(`${report}\n\n`);
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('restores a release into a directory and reports it, without a summary file when GitHub sets none', async () => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    lib.restore.mockResolvedValue({
      ...OUTCOME,
      uploaded: [],
      replaced: ['assets/index-AbCd1234.js'],
      kept: ['assets/index-EfGh5678.css'],
      removed: [],
    });
    const { exit, log } = await run('restore', SHA, 'restored');

    expect(lib.restore).toHaveBeenCalledExactlyOnceWith(SHA, 'restored', expect.objectContaining({ run: '7-2' }));
    expect(github.githubRepository).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith(
      [
        `### Restored ${SHA}`,
        '',
        '- Assets uploaded: none',
        '- Assets replaced, and invalidated: assets/index-AbCd1234.js',
        '- Assets already in place: assets/index-EfGh5678.css',
        '- Pages removed: none',
        '- Paths invalidated: /, /index.html',
        '',
        'Deploys are held: pushes to main publish nothing until the Deploy workflow is run on main by hand with "Publish over a restore" checked.',
      ].join('\n'),
    );
    expect(exit).not.toHaveBeenCalled();
  });

  it("rolls back, names the release it rolled back to in the step's output, and reports it", async () => {
    vi.stubEnv('GITHUB_OUTPUT', join(summaryDir, 'output'));
    lib.rollBack.mockResolvedValue(OUTCOME);
    const { exit, log } = await run('rollback', 'rolled-back');

    expect(lib.rollBack).toHaveBeenCalledExactlyOnceWith('rolled-back', expect.objectContaining({ run: '7-2' }));
    expect(readFileSync(join(summaryDir, 'output'), 'utf8')).toBe(`release=${SHA}\n`);
    expect(String(log.mock.calls[0]?.[0])).toMatch(new RegExp(`^### Rolled back to ${SHA}\n`));
    expect(exit).not.toHaveBeenCalled();
  });

  it('leaves the output empty, and warns, when there was nothing to roll back', async () => {
    vi.stubEnv('GITHUB_OUTPUT', join(summaryDir, 'output'));
    lib.rollBack.mockResolvedValue(undefined);
    const { exit, log } = await run('rollback', 'rolled-back');

    expect(readFileSync(join(summaryDir, 'output'), 'utf8')).toBe('release=\n');
    expect(log).toHaveBeenCalledExactlyOnceWith('::warning::Nothing was rolled back; the log above says why.');
    expect(exit).not.toHaveBeenCalled();

    // Outside GitHub there is no output file to write.
    vi.stubEnv('GITHUB_OUTPUT', '');
    vi.resetModules();
    vi.restoreAllMocks();
    expect((await run('rollback', 'rolled-back')).exit).not.toHaveBeenCalled();
  });

  it('publishes over a restore when a run started by hand asks to resume', async () => {
    vi.stubEnv('RESUME_DEPLOYS', 'true');
    lib.publish.mockResolvedValue(OUTCOME);
    await run('publish', 'site');
    expect(lib.publish.mock.calls[0]?.[4]).toBe(true);
  });

  it('records the release as verified', async () => {
    lib.recordVerified.mockResolvedValue({ release: SHA, run: '7-2' });
    const { exit } = await run('verified');
    expect(lib.recordVerified).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ run: '7-2' }));
    expect(summary()).toBe(`### Verified ${SHA}\n\nThe smoke test passed, and run 7-2 recorded the release as verified.\n\n`);
    expect(exit).not.toHaveBeenCalled();
  });

  it('fails with the usage for another command or the wrong number of arguments, before reading anything', async () => {
    for (const args of [[], ['deploy', 'site'], ['publish'], ['restore', SHA], ['verified', 'now'], ['rollback'], ['constructor']]) {
      const { exit, error } = await run(...args);
      expect(error, args.join(' ')).toHaveBeenCalledExactlyOnceWith(
        '::error::Usage: node scripts/release.ts publish <dir> | restore <release> <dir> | verified | rollback <dir>',
      );
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      vi.restoreAllMocks();
      vi.resetModules();
    }
    expect(aws.s3Store).not.toHaveBeenCalled();
  });

  it('fails, as an error annotation, when a variable is missing or a step fails', async () => {
    vi.stubEnv('GITHUB_TOKEN', '');
    let output = await run('publish', 'site');
    expect(output.error).toHaveBeenCalledExactlyOnceWith('::error::GITHUB_TOKEN is not set.');
    expect(output.exit).toHaveBeenCalledExactlyOnceWith(1);

    vi.resetModules();
    vi.restoreAllMocks();
    lib.recordVerified.mockRejectedValue(new Error('Run 7-2 did not publish the current release'));
    output = await run('verified');
    expect(output.error).toHaveBeenCalledExactlyOnceWith('::error::Run 7-2 did not publish the current release');

    vi.resetModules();
    vi.restoreAllMocks();
    lib.recordVerified.mockRejectedValue('not an Error');
    output = await run('verified');
    expect(output.error).toHaveBeenCalledExactlyOnceWith('::error::not an Error');
  });
});
