// @ts-check
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const angular = require('@angular-eslint/eslint-plugin');
const angularTemplate = require('@angular-eslint/eslint-plugin-template');
const templateParser = require('@angular-eslint/template-parser');
const globals = require('globals');

module.exports = tseslint.config(
  {
    ignores: [
      'projects/**/*',
      'dist/**',
      '.angular/**',
      'node_modules/**',
      'coverage/**',
      // The Android build's copy of the app. `cap copy` puts the compiled
      // bundle here and Gradle copies it again, so linting it means linting
      // this app's own output as though it were source -- three times over,
      // and reporting rule failures at line 78190 of a minified file.
      'android/**',
      // Vendored spartan/ui components. Generated third-party code with its own
      // conventions -- hlm* selectors do not follow this app's prefix rule, and
      // reformatting them to suit would only make the next CLI update conflict.
      'libs/ui/**',
      'eslint.config.js',
      'jest.config.js',
      // The desktop build's output and its copy of the web app.
      'electron/build/**',
      'electron/dist/**',
      'electron/app/**',
      'electron/node_modules/**',
      // Capacitor's own runtime for Electron, as `cap` writes it.
      'electron/src/rt/**',
      'electron/live-runner.js',
    ],
  },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: {
      '@angular-eslint': angular,
    },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        project: ['tsconfig.json'],
        tsconfigRootDir: __dirname,
      },
    },
    processor: angularTemplate.processors['extract-inline-html'],
    rules: {
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'app', style: 'kebab-case' },
      ],
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'app', style: 'camelCase' },
      ],
      // Members are public unless marked otherwise, as Angular's style guide has it:
      // `public` is left out, and `private` or `protected` said where meant.
      '@typescript-eslint/explicit-member-accessibility': ['warn', { accessibility: 'no-public' }],
      // info is a line meant to be kept (a guide reloaded, an update found);
      // log is debugging left behind.
      'no-console': ['warn', { allow: ['info', 'warn', 'error'] }],
      // A leading underscore marks a name kept for its place: a parameter before
      // one that is used, a key taken out of an object.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-inferrable-types': 'off',
    },
  },
  {
    // Electron's preload runs as CommonJS and loads with require().
    files: ['electron/**/*.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // A test reaches for a module afresh, or before the one it sets up.
    files: ['**/*.spec.ts', 'src/test-setup.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['**/*.html'],
    plugins: {
      '@angular-eslint/template': angularTemplate,
    },
    languageOptions: {
      parser: templateParser,
    },
    rules: {
      ...angularTemplate.configs.recommended.rules,
    },
  }
);
