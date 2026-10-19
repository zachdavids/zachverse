import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pages } from '../src/content/index.ts';
import type { Open, Result, SitePage, Target } from './browser-check-lib.ts';

const lib = vi.hoisted(() => ({
  browserCheck: vi.fn<(target: Target, pages: readonly SitePage[], open: Open) => Promise<Result>>(),
  open: vi.fn(),
  serve: vi.fn<(dir: string) => Promise<{ origin: string; close: () => Promise<void> }>>(),
}));
const browser = vi.hoisted(() => ({ close: vi.fn(async () => {}) }));
const playwright = vi.hoisted(() => ({ chromium: { launch: vi.fn() } }));
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('./browser-check-lib.ts', () => lib);
vi.mock('playwright', () => playwright);
vi.mock('node:dns/promises', () => dns);

const RELEASE = '0123456789abcdef0123456789abcdef01234567';

describe('browser check script', () => {
  let summaryDir: string;
  const argv = process.argv;
  const close = vi.fn(async () => {});

  beforeEach(() => {
    vi.resetModules();
    summaryDir = mkdtempSync(join(tmpdir(), 'browser-check-test-'));
    vi.stubEnv('RELEASE_COMMIT', '');
    vi.stubEnv('BROWSER_CHECK_SCREENSHOTS', '');
    vi.stubEnv('CLOUDFRONT_DOMAIN', 'd111111abcdef8.cloudfront.net');
    vi.stubEnv('GITHUB_STEP_SUMMARY', join(summaryDir, 'summary.md'));
    lib.serve.mockResolvedValue({ origin: 'http://127.0.0.1:4173', close });
    lib.browserCheck.mockResolvedValue({ passed: ['check one'], failures: [] });
    playwright.chromium.launch.mockResolvedValue(browser);
    dns.lookup.mockResolvedValue({ address: '192.0.2.10', family: 4 });
  });

  afterEach(() => {
    process.argv = argv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const mock of [...Object.values(lib), playwright.chromium.launch, dns.lookup, browser.close, close]) mock.mockReset();
    rmSync(summaryDir, { recursive: true, force: true });
  });

  // Each import runs the script once, as `node scripts/browser-check.ts ...` does; throwing stops it where process.exit
  // would.
  const run = async (...args: string[]) => {
    process.argv = ['node', 'scripts/browser-check.ts', ...args];
    const output = {
      exit: vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      }),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    };
    await import('./browser-check.ts').catch((error: unknown) => {
      if (!(error instanceof Error && error.message.startsWith('process.exit('))) throw error;
    });
    return output;
  };

  it('serves a local build, checks every page with no release named, reports it, and closes the browser and the server', async () => {
    const { exit, error, log } = await run('local', 'dist');

    expect(lib.serve).toHaveBeenCalledExactlyOnceWith('dist');
    // With scrollbars shown, which Playwright hides by default.
    expect(playwright.chromium.launch).toHaveBeenCalledExactlyOnceWith({
      args: [],
      ignoreDefaultArgs: ['--hide-scrollbars'],
    });
    const [target, checked, open] = lib.browserCheck.mock.calls[0]!;
    // Served locally, the pages still name their canonical URLs at the site's origin.
    expect(target).toEqual({
      origin: 'http://127.0.0.1:4173',
      canonicalOrigin: 'https://zachdavids.com',
      release: null,
      probe: expect.stringMatching(/^browser-check-[0-9a-f-]{36}$/),
    });
    // Every page in the site's table, the 404 page included.
    expect(checked).toEqual(pages);
    // The check opens pages in the browser the script launched.
    await open('http://127.0.0.1:4173/', 320, { tab: true, axe: true });
    expect(lib.open).toHaveBeenCalledExactlyOnceWith(browser, 'http://127.0.0.1:4173/', 320, { tab: true, axe: true });
    const report = '### Browser check (dist)\n\n- Passed: check one';
    expect(log).toHaveBeenCalledExactlyOnceWith(report);
    expect(readFileSync(join(summaryDir, 'summary.md'), 'utf8')).toBe(`${report}\n\n`);
    expect(browser.close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('keeps screenshots in the directory BROWSER_CHECK_SCREENSHOTS names, as CI asks', async () => {
    vi.stubEnv('BROWSER_CHECK_SCREENSHOTS', 'screenshots');
    await run('local', 'dist');
    expect(lib.browserCheck.mock.calls[0]![0]).toMatchObject({ screenshots: 'screenshots' });
    // Unset or empty, as in the deploy workflow, it takes none.
    vi.restoreAllMocks();
    vi.resetModules();
    lib.browserCheck.mockClear();
    vi.stubEnv('BROWSER_CHECK_SCREENSHOTS', '');
    await run('local', 'dist');
    expect(lib.browserCheck.mock.calls[0]![0].screenshots).toBeUndefined();
  });

  it('checks the live site through the distribution, for the release it must name', async () => {
    vi.stubEnv('RELEASE_COMMIT', RELEASE);
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    const { exit, log } = await run('live');

    expect(dns.lookup).toHaveBeenCalledExactlyOnceWith('d111111abcdef8.cloudfront.net', { family: 4 });
    expect(playwright.chromium.launch).toHaveBeenCalledExactlyOnceWith({
      args: ['--host-resolver-rules=MAP zachdavids.com 192.0.2.10, MAP www.zachdavids.com 192.0.2.10'],
      ignoreDefaultArgs: ['--hide-scrollbars'],
    });
    const [target, checked] = lib.browserCheck.mock.calls[0]!;
    expect(target).toMatchObject({
      origin: 'https://zachdavids.com',
      canonicalOrigin: 'https://zachdavids.com',
      release: RELEASE,
    });
    expect(checked).toEqual(pages);
    expect(lib.serve).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '### Browser check (https://zachdavids.com, through the distribution)\n\n- Passed: check one',
    );
    expect(exit).not.toHaveBeenCalled();
  });

  it('fails with an annotation per failed check', async () => {
    lib.browserCheck.mockResolvedValue({ passed: [], failures: ['check one: a script threw: boom', 'check two: status 500'] });
    const { exit, error } = await run('local', 'dist');
    expect(error.mock.calls).toEqual([['::error::check one: a script threw: boom'], ['::error::check two: status 500']]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(browser.close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('writes the tags and ampersands a problem names to the summary as entities, which Markdown shows as written, and to the log as they are', async () => {
    const failure = 'check one: the focused <a> "Q&A" shows no focus indicator';
    lib.browserCheck.mockResolvedValue({ passed: [], failures: [failure] });
    const { error, log } = await run('local', 'dist');
    expect(log).toHaveBeenCalledExactlyOnceWith(`### Browser check (dist)\n\n- **Failed:** ${failure}`);
    expect(error).toHaveBeenCalledExactlyOnceWith(`::error::${failure}`);
    expect(readFileSync(join(summaryDir, 'summary.md'), 'utf8')).toBe(
      '### Browser check (dist)\n\n' +
        '- **Failed:** check one: the focused &lt;a&gt; "Q&amp;A" shows no focus indicator\n\n',
    );
  });

  it('fails on a wrong command, a live check without its release or distribution, or a browser that will not start', async () => {
    for (const args of [[], ['local'], ['local', 'a', 'b'], ['live', 'x'], ['remote']]) {
      const { exit, error } = await run(...args);
      expect(error, args.join(' ')).toHaveBeenCalledExactlyOnceWith(
        '::error::Usage: node scripts/browser-check.ts local <dir> | live',
      );
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      vi.restoreAllMocks();
      vi.resetModules();
    }

    let output = await run('live');
    expect(output.error).toHaveBeenCalledExactlyOnceWith('::error::RELEASE_COMMIT is not set.');

    vi.restoreAllMocks();
    vi.resetModules();
    vi.stubEnv('RELEASE_COMMIT', RELEASE);
    vi.stubEnv('CLOUDFRONT_DOMAIN', '');
    output = await run('live');
    expect(output.error).toHaveBeenCalledExactlyOnceWith('::error::CLOUDFRONT_DOMAIN is not set.');

    vi.restoreAllMocks();
    vi.resetModules();
    playwright.chromium.launch.mockRejectedValue('no browser installed');
    output = await run('local', 'dist');
    expect(output.error).toHaveBeenCalledExactlyOnceWith('::error::no browser installed');
    // The server still stops.
    expect(close).toHaveBeenCalledOnce();
  });
});
