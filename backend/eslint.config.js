// @ts-check
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const globals = require('globals');

module.exports = tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'eslint.config.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
      parserOptions: {
        // The test config, which extends the build one and additionally covers
        // the test files the build deliberately excludes.
        project: './tsconfig.test.json',
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // The server's log: info for what an operator wants to see, debug for
      // detail, log for debugging left behind. Never a provider's address,
      // username or password.
      'no-console': ['warn', { allow: ['debug', 'info', 'warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // A leading underscore marks a name kept for its place: Express knows an
      // error handler by its four parameters, whether it uses `next` or not.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    // Scripts run by hand with node, in CommonJS.
    files: ['scripts/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      // `const crypto = require('crypto')` is the usual way to write it, global or not.
      'no-redeclare': ['error', { builtinGlobals: false }],
    },
  },
  {
    // Tests reach past the public surface on purpose: stubbing a provider
    // response or asserting a private map is the point.
    files: ['**/*.test.ts', 'src/test-utils/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  }
);
