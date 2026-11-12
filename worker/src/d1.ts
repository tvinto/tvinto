/**
 * The part of D1 this service uses, written out rather than imported.
 *
 * `@cloudflare/workers-types` would give the whole runtime, and the whole
 * runtime is not what is wanted here: naming exactly the four calls this
 * depends on is what makes it possible to run the handlers against a plain
 * SQLite database in a test, and what stops a use of something more exotic
 * creeping in unnoticed.
 *
 * D1 is SQLite, so the SQL is the same SQL the Express backend runs. What is
 * different is that every call is asynchronous, and that there is a budget.
 */

export interface D1Meta {
  changes?: number;
  last_row_id?: number;
}

export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: D1Meta;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  /**
   * Several statements as one round trip, in one implicit transaction.
   *
   * The reason the push path is written the way it is. A batch of changes
   * applied one statement at a time would be one round trip each, and on the
   * free plan there are only fifty per request to spend.
   */
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

/** What the Worker is given at runtime. */
export interface Env {
  DB: D1Database;

  /**
   * The secret behind the salts handed out for names with no account.
   *
   * Set with `wrangler secret put ACCOUNT_SALT_SECRET`. Losing it is harmless:
   * real accounts carry their own salts and only the disguises change.
   */
  ACCOUNT_SALT_SECRET?: string;

  /** `closed` or `first-only` to shut the door. Open otherwise. */
  ACCOUNT_REGISTRATION?: string;

  /**
   * The application's OpenSubtitles key. A secret:
   * `wrangler secret put OPENSUBTITLES_API_KEY`. Handed to signed-in apps,
   * never logged. Without it the apps say subtitles are not set up.
   */
  OPENSUBTITLES_API_KEY?: string;

  /**
   * The application's TMDB key, for descriptions. A secret:
   * `wrangler secret put TMDB_API_KEY`. Handed to signed-in apps, never
   * logged. Without it the apps say descriptions from TMDB are not set up.
   */
  TMDB_API_KEY?: string;

  /** Origins allowed to call this, comma separated. */
  ALLOWED_ORIGINS?: string;

  /**
   * The bucket the desktop installers are served out of, if there is one.
   *
   * Optional, and deliberately: the account service has to keep working on a
   * deployment with no bucket bound, or adding updates would be able to take
   * signing in down with it. See `updates.ts`.
   */
  UPDATES?: import('./updates').UpdateBucket;
}

/** Rows come back with SQLite's own spelling, which is not the API's. */
export type Row = Record<string, unknown>;

export const text = (value: unknown): string => (value === null ? '' : String(value));

export const maybeText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

export const number = (value: unknown): number => Number(value ?? 0);

export const maybeNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);
