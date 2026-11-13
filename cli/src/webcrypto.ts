import { webcrypto } from 'crypto';

/**
 * `crypto` as a global, for a Node that does not have it yet.
 *
 * The desktop app carries tvinto and runs it with its own runtime
 * (`ELECTRON_RUN_AS_NODE=1`), so nobody needs Node installed. Electron 26 is
 * Node 18, where `globalThis.crypto` exists only behind a flag -- and the
 * sealing in shared/ reaches for it. Imported first by main.ts; Node 20 and
 * later have it already and are left alone.
 */
if (!(globalThis as { crypto?: unknown }).crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
}
