// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'artifacts/**',
      'docs/vendor/**',
      '**/storybook-static/**',
      // Lane worktrees (execution plan §0 rule 2) live inside the main checkout and are
      // gitignored; flat config does not read .gitignore, and type-checked linting of five
      // extra checkouts OOMs the default heap.
      '.worktrees/**',
      // Deliberately non-compliant inputs for scripts/electron-security-lint.mjs and csp-sri.mjs.
      'scripts/__fixtures__/**',
      // Cargo build output of the Rust crates (ADR 0021).
      'crates/**/target/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['vitest.config.ts', 'packages/*/vitest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Money-path hygiene: nothing in this repo logs by accident.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // Contracts are interfaces only. No runtime logic is allowed to live here.
    files: ['packages/core/src/contracts/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'FunctionDeclaration',
          message: 'contracts/ is interfaces only (execution plan §0 rule 1)',
        },
        {
          selector: 'ClassDeclaration',
          message: 'contracts/ is interfaces only (execution plan §0 rule 1)',
        },
      ],
    },
  },
  {
    files: ['**/*.{test,spec}.ts', '**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  {
    files: [
      'eslint.config.js',
      'vitest.config.ts',
      'scripts/**/*.{js,mjs}',
      'spikes/**/*.{js,mjs}',
    ],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Spike harnesses (spikes/, e.g. S-D's iroh helper checks): plain ESM that CI runs under Node
    // or Bare, never shipped and never imported by a package; they print their results.
    files: ['spikes/**/*.{js,mjs}'],
    languageOptions: {
      globals: {
        Bare: 'readonly',
        Buffer: 'readonly',
        TextDecoder: 'readonly',
        WebSocket: 'readonly',
        clearInterval: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        performance: 'readonly',
        process: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  {
    // Storybook config + stories (L4/L5): excluded from the package tsconfigs (not emitted to
    // dist), so they are linted with the non-type-aware rule set only.
    files: ['packages/*/.storybook/**/*.{ts,tsx,js,mjs}', 'packages/*/src/**/*.stories.tsx'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // The e2e preload (`-r`, packages/app-desktop/e2e/hold-ready.cjs): plain CommonJS that the
    // Electron main process loads before the app, so no TS project and no type-aware rules.
    files: ['packages/app-desktop/e2e/**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      sourceType: 'commonjs',
      globals: { require: 'readonly' },
    },
    // `-r` loads CommonJS: `require('electron')` is the only way in.
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Zero-dependency Node CLIs in scripts/ (lane L9): plain ESM with JSDoc, no TS
    // annotations to require, and Node's Buffer global.
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: { globals: { Buffer: 'readonly', fetch: 'readonly' } },
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
);
