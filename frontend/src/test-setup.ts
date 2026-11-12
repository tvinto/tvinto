import { setupZoneTestEnv } from 'jest-preset-angular/setup-env/zone';

/**
 * What the Angular half of the suite needs before any test runs.
 *
 * Zone-based rather than zoneless, because the app is: zone.js is in its
 * dependencies and its change detection assumes it. A test environment that
 * disagreed with the application about that would be testing a different app.
 */
setupZoneTestEnv();

/**
 * jsdom has no structuredClone; every runtime this app actually runs in does.
 *
 * Node's own is used rather than a hand-rolled deep copy, so a test is not
 * quietly exercising different cloning semantics from the app.
 */
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = <T>(value: T): T =>
    (require('node:v8') as { deserialize(b: Buffer): T; serialize(v: T): Buffer }).deserialize(
      (require('node:v8') as { serialize(v: T): Buffer }).serialize(value)
    );
}
