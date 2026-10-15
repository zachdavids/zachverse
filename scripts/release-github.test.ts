import { describe, expect, it, vi } from 'vitest';
import { githubRepository } from './release-github.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('githubRepository', () => {
  it("compares two commits through GitHub's compare API with the token", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: 'ahead', ahead_by: 3 }));
    expect(await githubRepository('zachdavids/zachverse', 'token', fetchImpl).compare(A, B)).toBe('ahead');
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      `https://api.github.com/repos/zachdavids/zachverse/compare/${A}...${B}?per_page=1`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: 'Bearer token',
          'x-github-api-version': '2022-11-28',
        },
      },
    );
  });

  it('reports each relation GitHub knows', async () => {
    for (const status of ['ahead', 'behind', 'identical', 'diverged']) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status }));
      expect(await githubRepository('o/r', 't', fetchImpl).compare(A, B)).toBe(status);
    }
  });

  it('fails when GitHub cannot compare the commits, or answers with an unknown relation', async () => {
    const notFound = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 404 }));
    await expect(githubRepository('o/r', 't', notFound).compare(A, B)).rejects.toThrow(
      `GitHub could not compare ${A} with ${B}: HTTP 404.`,
    );
    const odd = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: 'unknown' }));
    await expect(githubRepository('o/r', 't', odd).compare(A, B)).rejects.toThrow(
      `GitHub compared ${A} with ${B} as "unknown".`,
    );
    const empty = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    await expect(githubRepository('o/r', 't', empty).compare(A, B)).rejects.toThrow('as undefined.');
  });

  it('uses the global fetch by default', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ status: 'identical' }));
    try {
      expect(await githubRepository('o/r', 't').compare(A, A)).toBe('identical');
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
});
