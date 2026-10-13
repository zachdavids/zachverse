import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prerender = vi.hoisted(() => vi.fn<(rootDir: URL) => Promise<void>>());
vi.mock('./prerender-lib.ts', () => ({ prerender }));

describe('prerender script', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    prerender.mockReset();
  });

  // Each import runs the script once, as `node scripts/prerender.ts` does.
  const run = () => import('./prerender.ts');

  it('prerenders into the repository root', async () => {
    prerender.mockResolvedValue();

    await run();

    expect(prerender).toHaveBeenCalledExactlyOnceWith(new URL('../', import.meta.url));
  });

  it('fails when prerendering fails, so the build fails', async () => {
    prerender.mockRejectedValue(new Error('Prerendered markup for "home" is empty'));

    await expect(run()).rejects.toThrow('Prerendered markup for "home" is empty');
  });
});
