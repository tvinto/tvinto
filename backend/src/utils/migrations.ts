import type { Database } from 'better-sqlite3';

/**
 * Schema changes that the base definitions cannot express.
 *
 * The tables in database.ts are declared with CREATE TABLE IF NOT EXISTS, which
 * builds a missing table but never alters one that already exists. Adding a
 * column to a database that is already full of someone's data needs a step that
 * runs exactly once and is recorded as having run.
 *
 * Migrations are numbered, applied in order, and each runs inside a transaction
 * so a failure leaves nothing half-done.
 */

interface Migration {
  id: number;
  name: string;
  up: (db: Database) => void;
}

/** Whether a table already has a column, so a partial run can be resumed. */
const hasColumn = (db: Database, table: string, column: string): boolean => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some(c => c.name === column);
};

const addColumn = (db: Database, table: string, column: string, definition: string): void => {
  if (!hasColumn(db, table, column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
};

const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'accounts',
    up: db => {
      // An account of the user's own, independent of any subscription.
      //
      // username_folded exists so that names are unique without regard to case
      // -- signing up as "Petar" must not create a second account beside
      // "petar" -- while username keeps whatever capitalisation was typed.
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL,
          username_folded TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at DATETIME NOT NULL,
          updated_at DATETIME NOT NULL
        );

        -- A subscription, owned by a user and deliberately disposable. Xtream
        -- credentials expire and are reissued; when that happens this row is
        -- replaced and nothing keyed to the user moves.
        CREATE TABLE IF NOT EXISTS provider_accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          label TEXT,
          server_url TEXT NOT NULL,
          xtream_username TEXT NOT NULL,
          xtream_secret TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL,
          updated_at DATETIME NOT NULL,
          UNIQUE(user_id, server_url, xtream_username)
        );

        CREATE INDEX IF NOT EXISTS idx_provider_user ON provider_accounts(user_id, active);
      `);
    }
  },
  {
    id: 2,
    name: 'personal-data-belongs-to-a-user',
    up: db => {
      // The user's own work moves off the provider username and onto an id that
      // outlives it. The old column stays for now: rows still carrying only a
      // username are unclaimed, and are adopted when someone proves they hold
      // those credentials.
      for (const table of ['favorites', 'sort_order', 'watch_progress']) {
        addColumn(db, table, 'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
      }

      // A favourite or an arranged position points at a provider-issued id.
      // Those survive a renewal with the same provider and mean nothing after a
      // change of provider, so the name is kept beside the id -- it is what
      // lets a row be matched to its replacement rather than dropped.
      addColumn(db, 'favorites', 'name', 'TEXT');
      addColumn(db, 'sort_order', 'name', 'TEXT');

    }
  },
  {
    id: 3,
    name: 'ownership-moves-off-the-provider-username',
    up: db => {
      // Two things were still wrong, and the first hid the second.
      //
      // The username column was declared NOT NULL, so a row keyed only to a
      // user violated it -- and because favourites are added with INSERT OR
      // IGNORE, that violation was swallowed and the favourite simply never
      // appeared. Silence is the worst possible symptom for this.
      //
      // The UNIQUE declarations also still named username. They stop meaning
      // anything once it is null, because SQLite counts nulls as distinct from
      // each other, so the same favourite could be stored twice over.
      //
      // Neither a NOT NULL nor a UNIQUE table constraint can be altered away in
      // SQLite, so the tables are rebuilt. Small enough to be quick, and done
      // inside the migration's transaction.
      rebuild(db, {
        table: 'favorites',
        columns: [
          'id INTEGER PRIMARY KEY AUTOINCREMENT',
          'user_id INTEGER REFERENCES users(id) ON DELETE CASCADE',
          // Kept, and nullable: a row that still has one has not been claimed
          // yet, and that is exactly what claiming looks for.
          'username TEXT',
          'stream_id TEXT NOT NULL',
          'type TEXT NOT NULL',
          'name TEXT',
          'created_at DATETIME DEFAULT CURRENT_TIMESTAMP'
        ],
        copy: ['id', 'user_id', 'username', 'stream_id', 'type', 'name', 'created_at'],
        indexes: [
          'CREATE UNIQUE INDEX idx_favorites_unique ON favorites(user_id, stream_id, type)',
          'CREATE INDEX idx_favorites_user_type ON favorites(user_id, type)',
          'CREATE INDEX idx_favorites_unclaimed ON favorites(username) WHERE user_id IS NULL'
        ]
      });

      rebuild(db, {
        table: 'sort_order',
        columns: [
          'id INTEGER PRIMARY KEY AUTOINCREMENT',
          'user_id INTEGER REFERENCES users(id) ON DELETE CASCADE',
          'username TEXT',
          'scope TEXT NOT NULL',
          'item_id TEXT NOT NULL',
          'position INTEGER NOT NULL',
          'name TEXT',
          'updated_at DATETIME DEFAULT CURRENT_TIMESTAMP'
        ],
        copy: ['id', 'user_id', 'username', 'scope', 'item_id', 'position', 'name', 'updated_at'],
        indexes: [
          'CREATE UNIQUE INDEX idx_sort_order_unique ON sort_order(user_id, scope, item_id)',
          'CREATE INDEX idx_sort_order_scope ON sort_order(user_id, scope, position)',
          'CREATE INDEX idx_sort_order_unclaimed ON sort_order(username) WHERE user_id IS NULL'
        ]
      });

      rebuild(db, {
        table: 'watch_progress',
        columns: [
          'id INTEGER PRIMARY KEY AUTOINCREMENT',
          'user_id INTEGER REFERENCES users(id) ON DELETE CASCADE',
          'username TEXT',
          'type TEXT NOT NULL',
          'item_id TEXT NOT NULL',
          'series_id TEXT',
          'season INTEGER',
          'episode_num INTEGER',
          'name TEXT NOT NULL',
          'episode_title TEXT',
          'icon TEXT',
          'container_extension TEXT',
          'position_seconds REAL NOT NULL DEFAULT 0',
          'duration_seconds REAL NOT NULL DEFAULT 0',
          'completed INTEGER NOT NULL DEFAULT 0',
          'updated_at DATETIME NOT NULL'
        ],
        copy: [
          'id', 'user_id', 'username', 'type', 'item_id', 'series_id', 'season', 'episode_num',
          'name', 'episode_title', 'icon', 'container_extension', 'position_seconds',
          'duration_seconds', 'completed', 'updated_at'
        ],
        indexes: [
          'CREATE UNIQUE INDEX idx_progress_unique ON watch_progress(user_id, type, item_id)',
          'CREATE INDEX idx_progress_recent ON watch_progress(user_id, type, updated_at DESC)',
          'CREATE INDEX idx_progress_series ON watch_progress(user_id, series_id)',
          'CREATE INDEX idx_progress_unclaimed ON watch_progress(username) WHERE user_id IS NULL'
        ]
      });
    }
  },
  {
    id: 4,
    name: 'sync-bookkeeping',
    up: db => {
      // Sync needs two things the tables do not yet provide: a time on every row
      // so a device can ask what has changed since it last looked, and a record
      // of what has been removed. A deletion that leaves no trace is invisible
      // to a pull, so a second device would go on believing in a favourite that
      // was unstarred hours ago -- and would eventually push it back.
      addColumn(db, 'favorites', 'updated_at', 'DATETIME');

      // Existing rows have only a creation time, which is the best answer
      // available for when they last changed.
      db.prepare('UPDATE favorites SET updated_at = created_at WHERE updated_at IS NULL').run();

      // Two clocks, because they answer different questions and only one of
      // them can be trusted to a device.
      //
      // updated_at is when the user made the change, as their own device saw
      // it. That decides a conflict: a phone offline all morning still knows
      // its edit came before the laptop's afternoon one, and should lose.
      //
      // synced_at is when this server stored it, and is what a pull walks. It
      // must be the server's own never-repeating clock, because a device
      // running even slightly slow would otherwise file changes into the past
      // -- behind cursors the other devices have already moved beyond, where
      // nothing will ever look for them again.
      for (const table of ['favorites', 'sort_order', 'watch_progress']) {
        addColumn(db, table, 'synced_at', 'DATETIME');
        db.prepare(`UPDATE ${table} SET synced_at = updated_at WHERE synced_at IS NULL`).run();
      }

      // One table for every kind of deletion rather than a flag on each: the
      // rows themselves are then genuinely gone, and the record of their going
      // has one shape and one place to be pruned from.
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_tombstones (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          item_key TEXT NOT NULL,
          deleted_at DATETIME NOT NULL,
          synced_at DATETIME NOT NULL,
          UNIQUE(user_id, kind, item_key)
        );

        CREATE INDEX IF NOT EXISTS idx_tombstones_since
          ON sync_tombstones(user_id, synced_at);

        -- Preferences that used to live in one browser's localStorage: the sort
        -- you chose, the theme you picked. Keyed by the account like everything
        -- else the user made, so they follow you to the next device.
        CREATE TABLE IF NOT EXISTS user_settings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at DATETIME NOT NULL,
          synced_at DATETIME NOT NULL,
          UNIQUE(user_id, key)
        );

        CREATE INDEX IF NOT EXISTS idx_settings_since ON user_settings(user_id, synced_at);
        CREATE INDEX IF NOT EXISTS idx_favorites_since ON favorites(user_id, synced_at);
        CREATE INDEX IF NOT EXISTS idx_sort_order_since ON sort_order(user_id, synced_at);
        CREATE INDEX IF NOT EXISTS idx_progress_since ON watch_progress(user_id, synced_at);
      `);
    }
  },
  {
    id: 5,
    name: 'sessions-outlive-a-restart',
    up: db => {
      // Sessions were held in memory on the grounds that persisting them meant
      // writing provider passwords to disk. That was true when a session was a
      // copy of the credentials; it stopped being true when a session became
      // the name of an account. There is nothing secret left in one, so it can
      // survive a restart, and signing everybody out on every deploy stops
      // being the price of that caution.
      //
      // The token is stored hashed. It is a bearer credential -- whoever holds
      // it is signed in -- so a copy of this file should not hand out live
      // sessions. No salt and a plain digest is right here where it would be
      // wrong for a password: the token is 256 bits of randomness, so there is
      // no guessing it and nothing to slow an attacker down against.
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at DATETIME NOT NULL,
          last_used_at DATETIME NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_idle ON sessions(last_used_at);
      `);
    }
  },
  {
    id: 6,
    name: 'remember-which-categories-were-asked-about',
    up: db => {
      // A category with no rows is ambiguous: it might never have been fetched,
      // or it might have been fetched and be genuinely empty. The cache cannot
      // tell those apart, so it treats both as "go and ask" -- which means
      // every empty category costs a request on every single visit, forever.
      //
      // Recording the attempt separately from the result settles it. The same
      // shape as epg_fetch_attempts, which exists for exactly this reason: most
      // channels have no guide, and without a record of having asked, the ones
      // that have nothing are the ones asked about most.
      db.exec(`
        CREATE TABLE IF NOT EXISTS category_fetch_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL,
          type TEXT NOT NULL,
          category_id TEXT NOT NULL,
          attempted_at DATETIME NOT NULL,
          UNIQUE(username, type, category_id)
        );

        CREATE INDEX IF NOT EXISTS idx_category_attempts
          ON category_fetch_attempts(username, type, attempted_at);
      `);
    }
  },
  {
    id: 7,
    name: 'remember-what-container-a-film-is-in',
    up: db => {
      // Xtream serves a film at a path ending in its real container, so asking
      // for an .mkv as .mp4 is refused -- and this table had nowhere to record
      // what the container was. Every film not stored as .mp4 therefore failed
      // to open, while episodes played, because an episode carries its
      // container in the series info it arrives with and a film does not.
      //
      // Nullable, and filled in the first time a film is played rather than by
      // a sweep: the answer needs one request per film, and there are 200,000
      // of them. Never asking about the ones nobody watches is the point.
      const columns = db.prepare('PRAGMA table_info(streams)').all() as Array<{ name: string }>;
      if (columns.some(column => column.name === 'container_extension')) {
        return;
      }

      db.exec('ALTER TABLE streams ADD COLUMN container_extension TEXT');
    }
  },
  {
    id: 8,
    name: 'let-the-device-do-the-hashing',
    up: db => {
      // Where sign-in is going. The sync service is a Cloudflare Worker with
      // 10 ms of CPU per request, and scrypt at this app's cost wants about a
      // hundred, so the server will not be able to hash a password at all. The
      // device derives instead and sends a verifier; this column holds what
      // the server keeps, which is a hash of that.
      //
      // Nullable, and beside password_hash rather than replacing it. Accounts
      // move one device at a time: an account with no verifier signs in the
      // old way and enrols on the way through, and one with a verifier can
      // still do either until every device has been updated.
      addColumn(db, 'users', 'auth_verifier', 'TEXT');
    }
  },
  {
    id: 9,
    name: 'guides-follow-the-account',
    up: db => {
      // Which guides an account uses is account state, not device state.
      // Signing in somewhere new should offer the guides you already have
      // rather than send you hunting for the URL again; what each device has
      // actually downloaded stays on that device.
      //
      // The source is opaque here. Its label, URL and enabled flag are sealed
      // on the device under a key derived from the account password, because
      // an Xtream guide URL is `xmltv.php?username=...&password=...` and is a
      // credential whatever it looks like. This backend could decrypt nothing
      // even though it holds a key of its own -- the key is not its.
      //
      // The mapping is not opaque: a stream id, a guide id and a channel id
      // like `HTV1.hr` give nothing away. It is a row per mapping rather than
      // one blob because it is work a person did by hand -- nearly half a real
      // line-up carries no channel id at all -- and two devices editing it
      // must not silently discard each other's.
      db.exec(`
        CREATE TABLE IF NOT EXISTS guide_sources (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          id TEXT NOT NULL,
          payload TEXT NOT NULL,
          updated_at DATETIME NOT NULL,
          synced_at DATETIME NOT NULL,
          PRIMARY KEY (user_id, id)
        );

        CREATE INDEX IF NOT EXISTS idx_guide_sources_since
          ON guide_sources(user_id, synced_at);

        CREATE TABLE IF NOT EXISTS channel_mappings (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          stream_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          updated_at DATETIME NOT NULL,
          synced_at DATETIME NOT NULL,
          PRIMARY KEY (user_id, stream_id)
        );

        CREATE INDEX IF NOT EXISTS idx_channel_mappings_since
          ON channel_mappings(user_id, synced_at);
      `);
    }
  },
  {
    id: 10,
    name: 'remember-the-tracks-a-film-was-watched-with',
    up: db => {
      // Subtitles chosen for one film should be there the next time it is
      // opened. The account already carries a *preference* -- "Croatian if
      // there is one" -- which is the right answer for everything nobody has
      // decided about, and the wrong one for a foreign film somebody turned
      // subtitles on for. This is the per-item half.
      //
      // Nullable, and null means "nobody has said" rather than "no
      // subtitles". A device whose player cannot report its tracks still
      // sends its resume point, and the write keeps what is here rather than
      // replacing it with emptiness.
      //
      // Languages rather than track numbers: a track number means nothing to
      // a different player, or to the same one after a re-encode.
      const columns = db.prepare('PRAGMA table_info(watch_progress)').all() as Array<{
        name: string;
      }>;
      const has = (name: string) => columns.some(column => column.name === name);

      if (!has('audio_language')) {
        db.exec('ALTER TABLE watch_progress ADD COLUMN audio_language TEXT');
      }
      if (!has('subtitle_language')) {
        db.exec('ALTER TABLE watch_progress ADD COLUMN subtitle_language TEXT');
      }
      if (!has('subtitles_enabled')) {
        db.exec('ALTER TABLE watch_progress ADD COLUMN subtitles_enabled INTEGER');
      }
    }
  },
  {
    id: 11,
    name: 'a-language-does-not-identify-a-subtitle-track',
    up: db => {
      // Remembering the language was not enough, which use found within the
      // hour: a film here offers "English (forced)", "English" and "English
      // (SDH)". All three are `eng`, so asking for English and taking what
      // came back selected the forced one however carefully the SDH one had
      // been chosen.
      //
      // The title is what tells them apart. Matched rather than indexed: a
      // track number is exact for one file and meaningless for the same film
      // re-encoded, or on a player that numbers them differently.
      const columns = db.prepare('PRAGMA table_info(watch_progress)').all() as Array<{
        name: string;
      }>;
      const has = (name: string) => columns.some(column => column.name === name);

      if (!has('audio_title')) {
        db.exec('ALTER TABLE watch_progress ADD COLUMN audio_title TEXT');
      }
      if (!has('subtitle_title')) {
        db.exec('ALTER TABLE watch_progress ADD COLUMN subtitle_title TEXT');
      }
    }
  }
];

interface RebuildSpec {
  table: string;
  columns: string[];
  /** Columns carried over, by name, so the copy cannot depend on their order. */
  copy: string[];
  indexes: string[];
}

/**
 * Replaces a table's definition, keeping its rows.
 *
 * The only way to drop a NOT NULL or a UNIQUE in SQLite. Every index on the old
 * table goes with it, so they are declared here and recreated rather than being
 * left to survive by accident.
 */
function rebuild(db: Database, spec: RebuildSpec): void {
  const temporary = `${spec.table}__rebuilding`;
  const columnList = spec.copy.join(', ');

  db.exec(`
    CREATE TABLE ${temporary} (
      ${spec.columns.join(',\n      ')}
    );

    INSERT INTO ${temporary} (${columnList})
      SELECT ${columnList} FROM ${spec.table};

    DROP TABLE ${spec.table};
  `);

  db.exec(`ALTER TABLE ${temporary} RENAME TO ${spec.table};`);

  for (const index of spec.indexes) {
    db.exec(index + ';');
  }
}

/** Applies whatever has not run yet. Safe to call on every start. */
export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at DATETIME NOT NULL
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: number }>).map(r => r.id)
  );

  const record = db.prepare(
    'INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)'
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) {
      continue;
    }

    const apply = db.transaction(() => {
      migration.up(db);
      record.run(migration.id, migration.name, new Date().toISOString());
    });

    apply();
    console.info(`Applied migration ${migration.id}: ${migration.name}`);
  }
}
