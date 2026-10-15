import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const checkDist = vi.hoisted(() => vi.fn<(rootDir: URL, release?: string) => string[]>());
const releaseProblems = vi.hoisted(() => vi.fn<(rootDir: URL) => string[]>(() => []));
vi.mock('./check-dist-lib.ts', () => ({ checkDist, releaseProblems }));

describe('check-dist script', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('RELEASE_COMMIT', '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    checkDist.mockReset();
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

  it("checks the repository's build and reports success", async () => {
    checkDist.mockReturnValue([]);
    const { exit, error, log } = captureOutput();

    await run();

    expect(checkDist).toHaveBeenCalledExactlyOnceWith(new URL('../', import.meta.url), undefined);
    expect(releaseProblems).toHaveBeenCalledExactlyOnceWith(new URL('../', import.meta.url));
    expect(log).toHaveBeenCalledExactlyOnceWith(
      'dist check passed: prerendered content and head, 404 page, robots.txt, sitemap.xml, referenced files, hashed assets, release rules',
    );
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
    expect(log).toHaveBeenCalledExactlyOnceWith(
      `dist check passed: prerendered content and head, 404 page, robots.txt, sitemap.xml, referenced files, hashed assets, release rules, release ${release}`,
    );
    expect(exit).not.toHaveBeenCalled();
  });

  it('fails on a single problem', async () => {
    checkDist.mockReturnValue(['missing dist/404.html']);
    const { exit, error, log } = captureOutput();

    await expect(run()).rejects.toThrow('process.exit(1)');

    expect(error).toHaveBeenCalledExactlyOnceWith('dist check failed:\n- missing dist/404.html');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('prints every failure, the release rules\' too, and exits with status 1', async () => {
    checkDist.mockReturnValue(['missing dist/404.html', 'dist/robots.txt does not contain "Sitemap"']);
    releaseProblems.mockReturnValueOnce(['dist/chunks/a.js is built outside assets/, so a release would publish it as a page']);
    const { exit, error, log } = captureOutput();

    await expect(run()).rejects.toThrow('process.exit(1)');

    expect(error).toHaveBeenCalledExactlyOnceWith(
      'dist check failed:\n- missing dist/404.html\n- dist/robots.txt does not contain "Sitemap"\n- dist/chunks/a.js is built outside assets/, so a release would publish it as a page',
    );
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(log).not.toHaveBeenCalled();
  });
});
