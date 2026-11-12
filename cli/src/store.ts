import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Where tvinto keeps what it knows between runs.
 *
 * Two places, on purpose. The session token and `enc` --
 * the key that opens the account's subscriptions and guides -- go in the
 * operating system's credential store, never a file: an agent that can read
 * files on the machine should not find them lying there. What is not secret,
 * which server and which account, goes in `~/.tvinto/config.json`.
 */

/** What signing in leaves behind, kept secret. */
export interface Credentials {
  token: string;
  /** base64. */
  enc: string;
}

/** Which account the next command is about. Not secret. */
export interface Config {
  /** The API address, as `normaliseServerAddress` gives it. */
  server: string;
  username: string;
}

export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/** The service name every entry is filed under, in Credential Manager and the like. */
const SERVICE = 'tvinto';

/**
 * The operating system's store: Windows Credential Manager, the macOS
 * Keychain, the Secret Service on Linux.
 *
 * Loaded only when first used, so the tests -- and a `tvinto --help` -- never
 * need the native module.
 */
export class KeyringStore implements SecretStore {
  private entry(name: string): {
    getPassword(): string | null | undefined;
    setPassword(value: string): void;
    deletePassword(): boolean | void;
  } {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Entry } = require('@napi-rs/keyring') as {
      Entry: new (service: string, account: string) => ReturnType<KeyringStore['entry']>;
    };
    return new Entry(SERVICE, name);
  }

  async get(name: string): Promise<string | null> {
    try {
      return this.entry(name).getPassword() ?? null;
    } catch {
      return null;
    }
  }

  async set(name: string, value: string): Promise<void> {
    this.entry(name).setPassword(value);
  }

  async delete(name: string): Promise<void> {
    try {
      this.entry(name).deletePassword();
    } catch {
      // Nothing there is the same as removed.
    }
  }
}

/** For the tests. */
export class MemoryStore implements SecretStore {
  readonly entries = new Map<string, string>();

  async get(name: string): Promise<string | null> {
    return this.entries.get(name) ?? null;
  }

  async set(name: string, value: string): Promise<void> {
    this.entries.set(name, value);
  }

  async delete(name: string): Promise<void> {
    this.entries.delete(name);
  }
}

/** The entry an account's credentials are filed under: one per server and account. */
export const entryName = (config: Config): string => `${config.username}@${config.server}`;

/** `~/.tvinto`, or `TVINTO_HOME` when set (the tests set it). */
export const homeDir = (): string => process.env['TVINTO_HOME'] || path.join(os.homedir(), '.tvinto');

const configFile = (): string => path.join(homeDir(), 'config.json');

export function readConfig(): Config | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile(), 'utf8')) as Partial<Config>;
    return typeof parsed.server === 'string' && typeof parsed.username === 'string'
      ? { server: parsed.server, username: parsed.username }
      : null;
  } catch {
    return null;
  }
}

export function writeConfig(config: Config | null): void {
  if (!config) {
    fs.rmSync(configFile(), { force: true });
    return;
  }
  fs.mkdirSync(homeDir(), { recursive: true });
  fs.writeFileSync(configFile(), `${JSON.stringify(config, null, 2)}\n`);
}

export async function readCredentials(store: SecretStore, config: Config): Promise<Credentials | null> {
  const stored = await store.get(entryName(config));
  if (!stored) {
    return null;
  }
  try {
    const parsed = JSON.parse(stored) as Partial<Credentials>;
    return typeof parsed.token === 'string' && typeof parsed.enc === 'string'
      ? { token: parsed.token, enc: parsed.enc }
      : null;
  } catch {
    return null;
  }
}

export const writeCredentials = (store: SecretStore, config: Config, credentials: Credentials): Promise<void> =>
  store.set(entryName(config), JSON.stringify(credentials));
