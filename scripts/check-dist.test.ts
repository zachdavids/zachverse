import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sizes } from './check-dist-lib.ts';

const sizes: Sizes = { javascript: 1, css: 2, html: 3, images: 4, fonts: 5 };
const checkDist = vi.hoisted(() => vi.fn<(rootDir: URL, release?: string) => string[]>());
const releaseProblems = vi.hoisted(() => vi.fn<(rootDir: URL) => string[]>(() => []));
const measureDist = vi.hoisted(() => vi.fn<(rootDir: URL) => Sizes>());
const sizeReport = vi.hoisted(() => vi.fn<(sizes: Sizes) => string>(() => 'sizes: as measured'));
vi.mock('./check-dist-lib.ts', () => ({ checkDist, measureDist, releaseProblems, sizeReport }));

describe('check-dist script', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('RELEASE_COMMIT', '');
    measureDist.mockReturnValue(sizes);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    checkDist.mockReset();
    measureDist.mockReset();
    sizeReport.mockClear();
  });

  // Captures the script's output; throwing stops it where process.exit would end it.
  const captureOutput = () => ({
    exit: vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    }),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
  });

  // Each import runs the script once, as `node scripts/check-dist.ts` does.
  const run = () => import('./check-dist.ts');

  it("checks the repository's build, reports success, then reports the build's sizes", async () => {
    checkDist.mockReturnValue([]);
    const { exit, error, log } = captureOutput();

    await run();

    expect(checkDist).toHaveBeenCalledExactlyOnceWith(new URL('../', import.meta.url), undefined);
    expect(releaseProblems).toHaveBeenCalledExactlyOnceWith(new URL('../', import.meta.url));
    expect(measureDist).toHaveBeenCalledExactlyOnceWith(new URL('../', import.meta.url));
    expect(sizeReport).toHaveBeenCalledExactlyOnceWith(sizes);
    expect(log.mock.calls).toEqual([
      [
        'dist check passed: prerendered content and head, link previews and structured data, 404 page, robots.txt, ' +
          'sitemap.xml, referenced files, hashed assets, release rules, size budgets',
      ],
      ['sizes: as measured'],
    ]);
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("checks the deploy build's release when RELEASE_COMMIT names one", async () => {
    const release = '0123456789abcdef0123456789abcdef01234567';
    vi.stubEnv('RELEASE_COMMIT', release);
    checkDist.mockReturnValue([]);
    const { exit, log } = captureOutput();

    await run();

    expect(checkDist).toHaveBeenCalledExactlyOnceWith(new URL('../', import.meta.url), release);
    expect(log.mock.calls).toEqual([
      [
        'dist check passed: prerendered content and head, link previews and structured data, 404 page, robots.txt, ' +
          `sitemap.xml, referenced files, hashed assets, release rules, size budgets, release ${release}`,
      ],
      ['sizes: as measured'],
    ]);
    expect(exit).not.toHaveBeenCalled();
  });

  it('fails on a single problem, and reports no sizes', async () => {
    checkDist.mockReturnValue(['missing dist/404.html']);
    const { exit, error, log } = captureOutput();

    await expect(run()).rejects.toThrow('process.exit(1)');

    expect(error).toHaveBeenCalledExactlyOnceWith('dist check failed:\n- missing dist/404.html');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(log).not.toHaveBeenCalled();
    expect(measureDist).not.toHaveBeenCalled();
    expect(sizeReport).not.toHaveBeenCalled();
  });

  it('prints every failure, the release rules\' and size budgets\' too, and exits with status 1', async () => {
    checkDist.mockReturnValue(['missing dist/404.html', 'dist/robots.txt does not contain "Sitemap"']);
    releaseProblems.mockReturnValueOnce([
      'dist/chunks/a.js is built outside assets/, so a release would publish it as a page',
      'dist/ is over a size budget (gzip where CloudFront compresses): fonts 2,048 bytes, more than the budget of 0 bytes',
    ]);
    const { exit, error, log } = captureOutput();

    await expect(run()).rejects.toThrow('process.exit(1)');

    expect(error).toHaveBeenCalledExactlyOnceWith(
      'dist check failed:\n- missing dist/404.html\n- dist/robots.txt does not contain "Sitemap"\n- dist/chunks/a.js is built outside assets/, so a release would publish it as a page\n- dist/ is over a size budget (gzip where CloudFront compresses): fonts 2,048 bytes, more than the budget of 0 bytes',
    );
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(log).not.toHaveBeenCalled();
    expect(measureDist).not.toHaveBeenCalled();
  });
});
