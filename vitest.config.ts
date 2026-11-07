import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/*',
      {
        // Black-box tests for the repo tooling in scripts/ (lane L9).
        test: {
          name: 'scripts',
          include: ['scripts/__tests__/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/__tests__/**', '**/*.test.ts', '**/contracts/**'],
      // CI's `test` job runs with --coverage (as rbitcoin-org/rbitcoin's coverage job gates line
      // coverage): a summary in the log, json-summary and lcov as the job's artifact.
      reporter: ['text-summary', 'json-summary', 'lcov'],
      // POSITIVE CONTROL (this commit only): a floor no run can meet, so the gate must fail.
      thresholds: { lines: 99, statements: 88, branches: 83, functions: 87 },
    },
  },
});
