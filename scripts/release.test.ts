import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, Outcome } from './release-lib.ts';

const lib = vi.hoisted(() => ({
  publish: vi.fn<(dir: string, release: string, repository: unknown, context: Context) => Promise<Outcome>>(),
  restore: vi.fn<(requested: string, outDir: string, context: Context) => Promise<Outcome>>(),
  recordVerified: vi.fn<(context: Context) => Promise<{ release: string; run: string }>>(),
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
  kept: [],
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
    );
    const report = [
      `### Published ${SHA}`,
      '',
      '- Assets uploaded: assets/index-AbCd1234.js',
      '- Assets already in place: none',
      '- Paths invalidated: /, /index.html',
    ].join('\n');
    expect(log.mock.calls).toEqual([['a message'], [report]]);
    expect(summary()).toBe(`${report}\n\n`);
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('restores a release into a directory and reports it, without a summary file when GitHub sets none', async () => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    lib.restore.mockResolvedValue({ ...OUTCOME, uploaded: [], kept: ['assets/index-AbCd1234.js'] });
    const { exit, log } = await run('restore', 'previous', 'restored');

    expect(lib.restore).toHaveBeenCalledExactlyOnceWith('previous', 'restored', expect.objectContaining({ run: '7-2' }));
    expect(github.githubRepository).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith(
      [
        `### Restored ${SHA}`,
        '',
        '- Assets uploaded: none',
        '- Assets already in place: assets/index-AbCd1234.js',
        '- Paths invalidated: /, /index.html',
      ].join('\n'),
    );
    expect(exit).not.toHaveBeenCalled();
  });

  it('records the release as verified', async () => {
    lib.recordVerified.mockResolvedValue({ release: SHA, run: '7-2' });
    const { exit } = await run('verified');
    expect(lib.recordVerified).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ run: '7-2' }));
    expect(summary()).toBe(`### Verified ${SHA}\n\nThe smoke test passed, and run 7-2 recorded the release as verified.\n\n`);
    expect(exit).not.toHaveBeenCalled();
  });

  it('fails with the usage for another command or the wrong number of arguments, before reading anything', async () => {
    for (const args of [[], ['deploy', 'site'], ['publish'], ['restore', 'previous'], ['verified', 'now'], ['constructor']]) {
      const { exit, error } = await run(...args);
      expect(error, args.join(' ')).toHaveBeenCalledExactlyOnceWith(
        '::error::Usage: node scripts/release.ts publish <dir> | restore <release> <dir> | verified',
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
