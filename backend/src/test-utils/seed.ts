import { db } from '../utils/database';
import type { Viewer } from '../services/xtream.service';

/** The provider username: whose catalogue the fixtures belong to. */
export const TEST_USER = 'tester';

/**
 * The account id the fixtures belong to.
 *
 * Reassigned by resetDatabase, which recreates the row -- SQLite reuses
 * AUTOINCREMENT ids after a delete, but nothing should depend on that.
 */
export let TEST_USER_ID = 1;

/** The pair every browse needs: an account, and a subscription to read. */
export function testViewer(overrides: Partial<Viewer> = {}): Viewer {
  return {
    userId: TEST_USER_ID,
    providerUsername: TEST_USER,
    providerPassword: 'hunter2',
    serverUrl: 'http://provider.example',
    ...overrides
  };
}

export interface SeedStream {
  stream_id: number;
  name: string;
  type?: string;
  category_id?: string;
  epg_channel_id?: string | null;
  added?: string | null;
  num?: number | null;
  stream_icon?: string;
}

/**
 * Empties every table so each test starts from a known state, and creates the
 * account the fixtures belong to.
 *
 * Pass `withAccount: false` for tests about registration itself, which need to
 * observe a server with nobody on it.
 */
export function resetDatabase({ withAccount = true }: { withAccount?: boolean } = {}): void {
  for (const table of [
    'streams',
    'categories',
    'sync_status',
    'epg_listings',
    'epg_fetch_attempts',
    'category_fetch_attempts',
    'favorites',
    'sort_order',
    'watch_progress',
    'provider_accounts',
    'users'
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }

  if (!withAccount) {
    return;
  }

  // Personal data is keyed to an account now, so every suite needs one to own
  // the fixtures it seeds.
  const now = new Date().toISOString();
  const created = db
    .prepare(
      `INSERT INTO users (username, username_folded, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run('tester-account', 'tester-account', 'scrypt$65536$8$1$c2FsdA==$aGFzaA==', now, now);

  TEST_USER_ID = Number(created.lastInsertRowid);
}

export function seedCategories(
  categories: Array<{ category_id: string; category_name: string }>,
  type = 'live',
  username = TEST_USER
): void {
  const insert = db.prepare(
    'INSERT OR REPLACE INTO categories (category_id, category_name, type, parent_id, username) VALUES (?, ?, ?, ?, ?)'
  );
  for (const c of categories) {
    insert.run(c.category_id, c.category_name, type, 0, username);
  }
}

export function seedStreams(streams: SeedStream[], username = TEST_USER): void {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO streams
       (stream_id, name, stream_type, stream_icon, epg_channel_id, category_id, type, username, added, num)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const s of streams) {
    insert.run(
      s.stream_id,
      s.name,
      s.type ?? 'live',
      s.stream_icon ?? '',
      s.epg_channel_id === undefined ? `chan.${s.stream_id}` : s.epg_channel_id,
      s.category_id ?? '1',
      s.type ?? 'live',
      username,
      s.added ?? null,
      s.num ?? null
    );
  }
}

/** A guide entry for a channel, positioned relative to now. */
export function seedEPG(
  channelId: string,
  opts: { startsInHours: number; endsInHours: number; title?: string },
  username = TEST_USER
): void {
  const at = (hours: number) => new Date(Date.now() + hours * 3600 * 1000).toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO epg_listings (epg_channel_id, start, stop, title, description, lang, username)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    channelId,
    at(opts.startsInHours),
    at(opts.endsInHours),
    opts.title ?? 'Programme',
    '',
    'en',
    username
  );
}

export function seedEPGAttempt(channelId: string, hoursAgo: number, username = TEST_USER): void {
  db.prepare(
    'INSERT OR REPLACE INTO epg_fetch_attempts (username, epg_channel_id, attempted_at) VALUES (?, ?, ?)'
  ).run(username, channelId, new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString());
}
