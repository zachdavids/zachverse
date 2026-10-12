import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    // A run that selects no tests fails, even where `changed` would default this to true.
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      // Every source file counts, including ones no test imports, in any extension tsc, Vite or Node accepts.
      // tests/support is the repository policy suite's code, so the gate also fails if that suite stops running.
      // tests/repo-policy.test.ts requires these globs as written.
      include: [
        'src/**/*.{ts,tsx}',
        'scripts/**/*.ts',
        'src/**/*.{mts,cts,js,jsx,mjs,cjs}',
        'scripts/**/*.{tsx,mts,cts,js,jsx,mjs,cjs}',
        'tests/support/**/*.ts',
      ],
      exclude: ['**/*.test.{ts,tsx}'],
      reporter: ['text', 'json-summary'],
      thresholds: { 100: true },
    },
  },
});
