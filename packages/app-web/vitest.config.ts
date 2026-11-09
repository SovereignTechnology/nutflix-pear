import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'app-web',
    // Helpers under __tests__/support are not suites. The site build's tests run under Node
    // (`// @vitest-environment node` in each file).
    include: [
      'src/**/__tests__/**/*.test.ts',
      'src/**/__tests__/**/*.test.tsx',
      'scripts/__tests__/**/*.test.ts',
    ],
    environment: 'jsdom',
  },
});
