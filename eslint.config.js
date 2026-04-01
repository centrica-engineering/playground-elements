import path from 'node:path';
import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import importPlugin from 'eslint-plugin-import';
import noOnlyTests from 'eslint-plugin-no-only-tests';
import globals from 'globals';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const baseGlobals = {
  ...globals.es2021,
  ...globals.browser,
  ...globals.node,
  ...globals.worker,
  ...globals.serviceworker,
};

/** @type {import('eslint').Linter.FlatConfig[]} */
export default [
  {
    ignores: [
      '**/_codemirror/**',
      '**/.wireit/**',
      '**/*.d.ts',
      // Generated JS build outputs live at repo root.
      '*.js',
      'configurator/**',
      'demo/**',
      'examples/**',
      'internal/**',
      'service-worker/**',
      'shared/**',
      'src/themes/**',
      'test/**',
      'themes/**',
      'typescript-worker/**',
    ],
  },

  js.configs.recommended,

  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: baseGlobals,
    },
    plugins: {
      import: importPlugin,
      'no-only-tests': noOnlyTests,
    },
    rules: {
      'no-only-tests/no-only-tests': 'error',
      'import/extensions': ['error', 'always'],
    },
  },

  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: baseGlobals,
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: __dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      import: importPlugin,
      'no-only-tests': noOnlyTests,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // TypeScript handles global types (DOM, Node, etc); this rule mostly
      // produces false positives under TS.
      'no-undef': 'off',
      'no-only-tests/no-only-tests': 'error',
      'import/extensions': ['error', 'always'],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },

  {
    files: ['src/playground-styles.ts'],
    rules: {
      'no-var': 'off',
    },
  },

  {
    files: ['src/typescript-worker/**'],
    languageOptions: {
      parserOptions: {
        project: ['./src/typescript-worker/tsconfig.json'],
        tsconfigRootDir: __dirname,
      },
    },
  },

  {
    files: ['src/service-worker/**'],
    languageOptions: {
      parserOptions: {
        project: ['./src/service-worker/tsconfig.json'],
        tsconfigRootDir: __dirname,
      },
    },
  },

  {
    files: ['src/shared/**'],
    languageOptions: {
      parserOptions: {
        project: ['./src/shared/tsconfig.json'],
        tsconfigRootDir: __dirname,
      },
    },
  },

  {
    // These files aren't imported into Google so we don't care about floating
    // promises.
    files: ['scripts/**', 'playwright.config.ts', 'src/configurator/**', 'src/test/**'],
    languageOptions: {
      parserOptions: {
        project: null,
      },
      globals: {
        ...baseGlobals,
        ...globals.mocha,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
];
