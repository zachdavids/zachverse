import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pages } from '../src/content/index.ts';
import { type Lhr, report, type Run } from './lighthouse-lib.ts';

type Flags = { port: number; logLevel: string; onlyCategories: string[] };

const lib = vi.hoisted(() => ({
  serve: vi.fn<(dir: string) => Promise<{ origin: string; close: () => Promise<void> }>>(),
}));
// The browser the script launches for Lighthouse to connect to.
const browser = vi.hoisted(() => ({ close: vi.fn(async () => {}) }));
const playwright = vi.hoisted(() => ({ chromium: { launch: vi.fn() } }));
const lighthouse = vi.hoisted(() => ({
  default: vi.fn<(url: string, flags: Flags, config?: object) => Promise<{ lhr: Lhr } | undefined>>(),
  desktopConfig: { extends: 'lighthouse:default', settings: { formFactor: 'desktop' } },
}));
vi.mock('./browser-check-lib.ts', () => lib);
vi.mock('playwright', () => playwright);
vi.mock('lighthouse', () => lighthouse);

const ORIGIN = 'http://127.0.0.1:4173';

// Every page with an address, in the table's order; the 404 page has none.
const paths = pages.flatMap(({ path }) => (path === null ? [] : [path]));

// A result within every limit, for the form factor Lighthouse emulated, with lcp as its largest contentful paint.
const lhrFor = (formFactor: string, lcp = 1200): Lhr => ({
  configSettings: { formFactor, throttlingMethod: 'simulate' },
  categories: Object.fromEntries(
    ['performance', 'accessibility', 'best-practices', 'seo'].map((id) => [
      id,
      { score: 1, auditRefs: [{ id: 'document-title', weight: 1 }] },
    ]),
  ),
  audits: {
    'document-title': { score: 1, scoreDisplayMode: 'binary' },
    'largest-contentful-paint': { score: 1, scoreDisplayMode: 'numeric', numericValue: lcp },
    'cumulative-layout-shift': { score: 1, scoreDisplayMode: 'numeric', numericValue: 0 },
    'total-blocking-time': { score: 1, scoreDisplayMode: 'numeric', numericValue: 0 },
    'first-contentful-paint': { score: 1, scoreDisplayMode: 'numeric', numericValue: 900 },
  },
});

describe('Lighthouse script', () => {
  let summaryDir: string;
  const argv = process.argv;
  const close = vi.fn(async () => {});

  beforeEach(() => {
    vi.resetModules();
    summaryDir = mkdtempSync(join(tmpdir(), 'lighthouse-test-'));
    vi.stubEnv('GITHUB_STEP_SUMMARY', join(summaryDir, 'summary.md'));
    lib.serve.mockResolvedValue({ origin: ORIGIN, close });
    playwright.chromium.launch.mockResolvedValue(browser);
    // Lighthouse emulates the form factor its config asks for: a desktop with the desktop config, or else a phone.
    lighthouse.default.mockImplementation(async (_url, _flags, config) => ({
      lhr: lhrFor(config === undefined ? 'mobile' : 'desktop'),
    }));
  });

  afterEach(() => {
    process.argv = argv;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const mock of [lib.serve, playwright.chromium.launch, lighthouse.default, browser.close, close]) {
      mock.mockReset();
    }
    rmSync(summaryDir, { recursive: true, force: true });
  });

  // Each import runs the script once, as `node scripts/lighthouse.ts ...` does; throwing stops it where process.exit
  // would.
  const run = async (...args: string[]) => {
    process.argv = ['node', 'scripts/lighthouse.ts', ...args];
    const output = {
      exit: vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
      }),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    };
    await import('./lighthouse.ts').catch((error: unknown) => {
      if (!(error instanceof Error && error.message.startsWith('process.exit('))) throw error;
    });
    return output;
  };

  it('serves a build, then measures each page with an address as a phone and a desktop, a run at a time', async () => {
    // What the script asks of Lighthouse, in order.
    const calls: string[] = [];
    // The runs in progress at once, which must never be more than one.
    let running = 0;
    let most = 0;
    lighthouse.default.mockImplementation(async (url, _flags, config) => {
      const formFactor = config === undefined ? 'mobile' : 'desktop';
      calls.push(`measure ${url} as ${formFactor}`);
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return { lhr: lhrFor(formFactor) };
    });
    const { exit, error, log } = await run('dist');

    expect(lib.serve).toHaveBeenCalledExactlyOnceWith('dist');
    // Lighthouse connects to the browser the script launched, through the DevTools port it opened there.
    const { port } = lighthouse.default.mock.calls[0]![1];
    expect(Number.isInteger(port) && port > 0 && port < 65536, String(port)).toBe(true);
    expect(playwright.chromium.launch).toHaveBeenCalledExactlyOnceWith({ args: [`--remote-debugging-port=${port}`] });
    expect(paths).toContain('/');
    // Only the categories the checks read.
    const onlyCategories = ['performance', 'accessibility', 'best-practices', 'seo'];
    const flags = { port, logLevel: 'error', onlyCategories };
    expect(lighthouse.default.mock.calls).toEqual(
      paths.flatMap((path) => [
        [`${ORIGIN}${path}`, flags, undefined],
        [`${ORIGIN}${path}`, flags, lighthouse.desktopConfig],
      ]),
    );
    expect(most).toBe(1);
    expect(calls).toEqual(
      paths.flatMap((path) => [`measure ${ORIGIN}${path} as mobile`, `measure ${ORIGIN}${path} as desktop`]),
    );
    const runs = paths.flatMap((path): Run[] => [
      { path, formFactor: 'mobile', lhr: lhrFor('mobile') },
      { path, formFactor: 'desktop', lhr: lhrFor('desktop') },
    ]);
    const output = [
      '### Lighthouse lab results (dist)',
      '',
      ...report(runs),
      '',
      ...paths.flatMap((path) => [`- Passed: ${path} (mobile)`, `- Passed: ${path} (desktop)`]),
    ].join('\n');
    expect(output).toContain('\n| / | mobile | 100 | 100 | 100 | 100 | 1200 ms | 0 | 0 ms | 900 ms |\n');
    expect(log).toHaveBeenCalledExactlyOnceWith(output);
    expect(readFileSync(join(summaryDir, 'summary.md'), 'utf8')).toBe(`${output}\n\n`);
    expect(browser.close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('fails with an annotation per problem, writing no summary when there is no summary file', async () => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    // The home page is slow as a phone.
    lighthouse.default.mockImplementation(async (url, _flags, config) => {
      const formFactor = config === undefined ? 'mobile' : 'desktop';
      return { lhr: lhrFor(formFactor, url === `${ORIGIN}/` && formFactor === 'mobile' ? 3100 : 1200) };
    });
    const { exit, error, log } = await run('dist');

    expect(error.mock.calls).toEqual([['::error::/ (mobile): LCP 3100 ms, over 2500 ms']]);
    const [[printed]] = log.mock.calls as [[string]];
    expect(printed).toContain('\n| / | mobile | 100 | 100 | 100 | 100 | 3100 ms | 0 | 0 ms | 900 ms |\n');
    expect(printed).toMatch(/\n- \*\*Failed:\*\* \/ \(mobile\): LCP 3100 ms, over 2500 ms$/);
    expect(existsSync(join(summaryDir, 'summary.md'))).toBe(false);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(browser.close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('fails on a wrong command, serving nothing', async () => {
    for (const args of [[], ['dist', 'extra']]) {
      const { exit, error } = await run(...args);
      expect(error, args.join(' ')).toHaveBeenCalledExactlyOnceWith('::error::Usage: node scripts/lighthouse.ts <dir>');
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      vi.restoreAllMocks();
      vi.resetModules();
    }
    expect(lib.serve).not.toHaveBeenCalled();
  });

  it('fails when the browser will not start, and still stops the server', async () => {
    playwright.chromium.launch.mockRejectedValue('no browser installed');
    const { exit, error } = await run('dist');
    expect(error).toHaveBeenCalledExactlyOnceWith('::error::no browser installed');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(lighthouse.default).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('names a run that fails or returns nothing by its page and form factor, and still makes and reports the others', async () => {
    const first = paths[0]!;
    // The first page's run as a phone fails, and its run as a desktop returns nothing.
    lighthouse.default
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:9222'))
      .mockResolvedValueOnce(undefined);
    let output = await run('dist');

    expect(output.error.mock.calls).toEqual([
      [`::error::${first} (mobile): connect ECONNREFUSED 127.0.0.1:9222`],
      [`::error::${first} (desktop): Lighthouse returned no result`],
    ]);
    expect(lighthouse.default).toHaveBeenCalledTimes(paths.length * 2);
    const others = paths.slice(1);
    const runs: Run[] = [
      { path: first, formFactor: 'mobile', error: 'connect ECONNREFUSED 127.0.0.1:9222' },
      { path: first, formFactor: 'desktop', error: 'Lighthouse returned no result' },
      ...others.flatMap((path): Run[] => [
        { path, formFactor: 'mobile', lhr: lhrFor('mobile') },
        { path, formFactor: 'desktop', lhr: lhrFor('desktop') },
      ]),
    ];
    const expected = [
      '### Lighthouse lab results (dist)',
      '',
      ...report(runs),
      '',
      ...others.flatMap((path) => [`- Passed: ${path} (mobile)`, `- Passed: ${path} (desktop)`]),
      `- **Failed:** ${first} (mobile): connect ECONNREFUSED 127.0.0.1:9222`,
      `- **Failed:** ${first} (desktop): Lighthouse returned no result`,
    ].join('\n');
    // A run that failed shows in the table as dashes.
    expect(expected).toContain(`\n| ${first} | mobile | — | — | — | — | — | — | — | — |\n`);
    expect(output.log).toHaveBeenCalledExactlyOnceWith(expected);
    expect(readFileSync(join(summaryDir, 'summary.md'), 'utf8')).toBe(`${expected}\n\n`);
    expect(output.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(browser.close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();

    // A rejection with something other than an Error is reported as it is.
    vi.restoreAllMocks();
    vi.resetModules();
    lighthouse.default.mockRejectedValueOnce('Chrome closed the connection');
    output = await run('dist');
    expect(output.error).toHaveBeenCalledExactlyOnceWith(`::error::${first} (mobile): Chrome closed the connection`);
    expect(output.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
