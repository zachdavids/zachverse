import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // Every source file counts, including ones no test imports, in any
      // extension tsc, Vite or Node accepts. tests/repo-policy.test.ts requires
      // the first two globs as written.
      include: [
        'src/**/*.{ts,tsx}',
        'scripts/**/*.ts',
        'src/**/*.{mts,cts,js,jsx,mjs,cjs}',
        'scripts/**/*.{tsx,mts,cts,js,jsx,mjs,cjs}',
      ],
      exclude: ['**/*.test.{ts,tsx}'],
      reporter: ['text', 'json-summary'],
      thresholds: { 100: true },
    },
  },
});
