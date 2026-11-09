import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'app-web',
    // Helpers under __tests__/support are not suites.
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.tsx'],
    environment: 'jsdom',
  },
});
