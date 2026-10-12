import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Synthesizing CDK stacks is CPU-bound; the default 5 s is tight on CI runners.
    testTimeout: 30_000,
  },
});
