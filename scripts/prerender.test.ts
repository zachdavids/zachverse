import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prerender = vi.hoisted(() => vi.fn<(rootDir: URL, release?: string) => Promise<void>>());
vi.mock('./prerender-lib.ts', () => ({ prerender }));

describe('prerender script', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('RELEASE_COMMIT', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    prerender.mockReset();
  });

  // Each import runs the script once, as `node scripts/prerender.ts` does.
  const run = () => import('./prerender.ts');

  it('prerenders into the repository root', async () => {
    prerender.mockResolvedValue();

    await run();

    expect(prerender).toHaveBeenCalledExactlyOnceWith(new URL('../', import.meta.url), undefined);
  });

  it('names the release RELEASE_COMMIT gives, as the deploy build sets it', async () => {
    vi.stubEnv('RELEASE_COMMIT', '0123456789abcdef0123456789abcdef01234567');
    prerender.mockResolvedValue();

    await run();

    expect(prerender).toHaveBeenCalledExactlyOnceWith(
      new URL('../', import.meta.url),
      '0123456789abcdef0123456789abcdef01234567',
    );
  });

  it('fails when prerendering fails, so the build fails', async () => {
    prerender.mockRejectedValue(new Error('Prerendered markup for "home" is empty'));

    await expect(run()).rejects.toThrow('Prerendered markup for "home" is empty');
  });
});
