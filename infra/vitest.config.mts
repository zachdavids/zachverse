import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // A run that selects no tests fails, even where `changed` would default this to true.
    passWithNoTests: false,
    // Synthesizing CDK stacks is CPU-bound; the default 5 s is tight on CI runners.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      // The template guardrails (lib/guardrails/), and test/support's DNS batch checks and synthesis helpers, are code
      // under test too.
      include: ['lib/**/*.ts', 'bin/**/*.ts', 'functions/**/*.js', 'test/support/**/*.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { 100: true },
    },
  },
});
