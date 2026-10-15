import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Get, Result, Target } from './smoke-lib.ts';

const lib = vi.hoisted(() => ({
  smokeTest: vi.fn<(dir: string, target: Target, get: Get) => Promise<Result>>(),
  retrying: vi.fn<(get: Get, sleep: (ms: number) => Promise<unknown>) => Get>(),
}));
const http = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('./smoke-lib.ts', () => lib);
vi.mock('./smoke-http.ts', () => http);

describe('smoke script', () => {
  let summaryDir: string;
  const argv = process.argv;

  beforeEach(() => {
    vi.resetModules();
    summaryDir = mkdtempSync(join(tmpdir(), 'smoke-test-'));
    vi.stubEnv('CLOUDFRONT_DOMAIN', 'd111111abcdef8.cloudfront.net');
    vi.stubEnv('BUCKET', 'site-bucket');
    vi.stubEnv('GITHUB_STEP_SUMMARY', join(summaryDir, 'summary.md'));
    lib.retrying.mockImplementation((get, sleep) => {
      void sleep(0);
      return get;
    });
  });

  afterEach(() => {
    process.argv = argv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    lib.smokeTest.mockReset();
    lib.retrying.mockReset();
    rmSync(summaryDir, { recursive: true, force: true });
  });

  // Each import runs the script once, as `node scripts/smoke.ts <dir>` does; throwing stops it where process.exit would.
  const run = async (...args: string[]) => {
    process.argv = ['node', 'scripts/smoke.ts', ...args];
    const output = {
      exit: vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      }),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    };
    await import('./smoke.ts').catch((error: unknown) => {
      if (!(error instanceof Error && error.message.startsWith('process.exit('))) throw error;
    });
    return output;
  };

  it("tests the release in the directory against the site's origin, through the distribution, and reports it", async () => {
    lib.smokeTest.mockResolvedValue({ passed: ['check one', 'check two'], failures: [] });
    const { exit, error, log } = await run('site');

    const [dir, target, get] = lib.smokeTest.mock.calls[0]!;
    expect(dir).toBe('site');
    expect(target).toEqual({
      origin: 'https://zachdavids.com',
      cloudfront: 'd111111abcdef8.cloudfront.net',
      bucket: 'site-bucket',
      probe: expect.stringMatching(/^smoke-test-[0-9a-f-]{36}$/),
    });
    // The retried request is the one from smoke-http.
    expect(lib.retrying).toHaveBeenCalledExactlyOnceWith(http.request, expect.any(Function));
    expect(get).toBe(http.request);
    const report = '### Smoke test\n\n- Passed: check one\n- Passed: check two';
    expect(log).toHaveBeenCalledExactlyOnceWith(report);
    expect(readFileSync(join(summaryDir, 'summary.md'), 'utf8')).toBe(`${report}\n\n`);
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('fails with an annotation per failed check, and still reports what passed', async () => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    lib.smokeTest.mockResolvedValue({ passed: ['check one'], failures: ['check two: status 500', 'check three: reset'] });
    const { exit, error, log } = await run('restored');

    expect(log).toHaveBeenCalledExactlyOnceWith(
      '### Smoke test\n\n- Passed: check one\n- **Failed:** check two: status 500\n- **Failed:** check three: reset',
    );
    expect(error.mock.calls).toEqual([['::error::check two: status 500'], ['::error::check three: reset']]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('fails without exactly one directory, without its variables, or when the test cannot run', async () => {
    for (const [args, message] of [
      [[], 'Usage: node scripts/smoke.ts <dir>'],
      [['a', 'b'], 'Usage: node scripts/smoke.ts <dir>'],
    ] as const) {
      const { exit, error } = await run(...args);
      expect(error).toHaveBeenCalledExactlyOnceWith(`::error::${message}`);
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      vi.restoreAllMocks();
      vi.resetModules();
    }

    vi.stubEnv('CLOUDFRONT_DOMAIN', '');
    let output = await run('site');
    expect(output.error).toHaveBeenCalledExactlyOnceWith('::error::CLOUDFRONT_DOMAIN is not set.');

    vi.restoreAllMocks();
    vi.resetModules();
    vi.stubEnv('CLOUDFRONT_DOMAIN', 'd111111abcdef8.cloudfront.net');
    lib.smokeTest.mockRejectedValue('site has no index.html');
    output = await run('site');
    expect(output.error).toHaveBeenCalledExactlyOnceWith('::error::site has no index.html');
    expect(output.exit).toHaveBeenCalledExactlyOnceWith(1);

    vi.restoreAllMocks();
    vi.resetModules();
    lib.smokeTest.mockRejectedValue(new Error('site has no 404.html'));
    output = await run('site');
    expect(output.error).toHaveBeenCalledExactlyOnceWith('::error::site has no 404.html');
  });
});
