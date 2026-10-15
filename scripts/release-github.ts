// The order check's view of the repository's history: GitHub's compare API, called with the job's read-only token.
import type { Repository } from './release-lib.ts';

const RELATIONS = ['ahead', 'behind', 'identical', 'diverged'] as const;

export function githubRepository(repository: string, token: string, fetchImpl: typeof fetch = fetch): Repository {
  return {
    async compare(base, head) {
      // One commit per page: only the status is read.
      const response = await fetchImpl(`https://api.github.com/repos/${repository}/compare/${base}...${head}?per_page=1`, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
        },
      });
      if (!response.ok) throw new Error(`GitHub could not compare ${base} with ${head}: HTTP ${response.status}.`);
      const { status } = (await response.json()) as { status?: unknown };
      const relation = RELATIONS.find((known) => known === status);
      if (relation === undefined) throw new Error(`GitHub compared ${base} with ${head} as ${JSON.stringify(status)}.`);
      return relation;
    },
  };
}
