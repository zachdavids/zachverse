import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Synthesizing CDK stacks is CPU-bound; the default 5 s is tight on CI runners.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      // The guardrail checks in test/support are code under test too.
      include: ['lib/**/*.ts', 'bin/**/*.ts', 'functions/**/*.js', 'test/support/**/*.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { 100: true },
    },
  },
});
