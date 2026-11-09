import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'ui',
    // `.test.tsx`: the shell's suites, moved here from the desktop app with the shell (ADR 0022).
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.ts', 'src/**/__tests__/**/*.test.tsx'],
    environment: 'jsdom',
  },
});
