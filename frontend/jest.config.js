/**
 * Jest for the frontend, in two halves.
 *
 * The split is not tidiness. Most of this code is plain TypeScript that needs
 * no Angular at all, and running it under the Angular preset would make every
 * test pay for a TestBed it does not use. The services do need one, and until
 * now that cost meant they had no tests -- which is how a migration shipped
 * with four separate faults in Angular code that nothing could exercise: local
 * data keyed by a server-assigned id, an empty drawer counting as a drawer, a
 * cursor doing double duty, and a background service that only existed while
 * one particular screen was open.
 */
module.exports = {
  projects: [
    {
      // Plain TypeScript: utilities, and the platform adapters, which
      // implement a shared interface and inject nothing.
      displayName: 'plain',
      preset: 'ts-jest',
      testEnvironment: 'node',
      roots: [
        '<rootDir>/src/app/utils',
        '<rootDir>/src/app/services/native',
        // The release tooling, which is small and fails silently when it is
        // wrong: an archive that opens with a file missing, a manifest naming
        // a version that was never built.
        '<rootDir>/scripts',
        // The desktop's rules that need no Electron to check -- when an update
        // may install itself. The rest of the main process needs a real app.
        '<rootDir>/electron/src'
      ],
      testMatch: [
        '<rootDir>/src/app/utils/**/*.spec.ts',
        '<rootDir>/src/app/services/native/**/*.spec.ts',
        '<rootDir>/electron/src/**/*.spec.ts',
        '<rootDir>/scripts/**/*.spec.js'
      ],
      transform: {
        '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
        // @noble/ciphers ships ES modules only; translated to CommonJS for
        // Jest like the app's own code (phone-form.utils.ts).
        '[\\\\/]@noble[\\\\/].+\\.js$': ['ts-jest', { tsconfig: { allowJs: true, module: 'commonjs' } }]
      },
      transformIgnorePatterns: ['[\\\\/]node_modules[\\\\/](?!@noble[\\\\/])'],
      moduleNameMapper: {
        '^@shared/(.*)$': '<rootDir>/../shared/$1'
      }
    },
    {
      // Anything that has to be injected, or built into a real template, to be
      // worth testing.
      displayName: 'angular',
      preset: 'jest-preset-angular',
      testEnvironment: 'jsdom',
      roots: ['<rootDir>/src/app/services', '<rootDir>/src/app/stores', '<rootDir>/src/app/directives', '<rootDir>/src/app/components', '<rootDir>/src/app/ui'],
      testMatch: [
        '<rootDir>/src/app/services/**/*.ng.spec.ts',
        '<rootDir>/src/app/stores/**/*.ng.spec.ts',
        '<rootDir>/src/app/directives/**/*.ng.spec.ts',
        '<rootDir>/src/app/components/**/*.ng.spec.ts',
        // The pieces every screen is built from (round 14).
        '<rootDir>/src/app/ui/**/*.ng.spec.ts'
      ],
      setupFilesAfterEnv: ['<rootDir>/src/test-setup.ts'],
      transform: {
        // @noble/ciphers, ES modules only, for the screens that offer the phone form (as above). First: the first match wins.
        '[\\\\/]@noble[\\\\/].+\\.js$': ['ts-jest', { tsconfig: { allowJs: true, module: 'commonjs' } }],
        '^.+\\.(ts|mjs|js|html)$': [
          'jest-preset-angular',
          { tsconfig: '<rootDir>/tsconfig.spec.json', stringifyContentPathRegex: '\\.(html|svg)$' }
        ]
      },
      // The preset's own, and @noble.
      transformIgnorePatterns: ['node_modules/(?!(.*\\.mjs$|@angular/common/locales/.*\\.js$|@noble/))'],
      moduleNameMapper: {
        '^@shared/(.*)$': '<rootDir>/../shared/$1',
        // The UI kit lives in the app (libs/ui), as tsconfig.json maps it.
        '^@spartan-ng/helm/(.*)$': '<rootDir>/libs/ui/$1/src/index.ts'
      }
    }
  ],
  collectCoverageFrom: [
    'src/app/utils/**/*.ts',
    '!src/app/utils/index.ts',
    // Only the adapters that have tests. The Capacitor ones need a device.
    'src/app/services/native/indexedDbGuideStore.ts',
    'src/app/services/native/webKdf.ts'
  ]
};
