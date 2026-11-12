-- The sync service's schema, for D1.
--
-- What is here is what one person made: their account, their favourites, their
-- arranging, their history, their settings. What is not here is the catalogue.
-- Half a million stream rows come from the provider and every device fetches
-- its own; nothing about them needs to be hosted, and the tables that used to
-- hold them have no counterpart in this file.
--
-- Two things are conspicuously missing from `users`, and both are the point:
--
--   * No password hash. The device derives the key and sends a verifier; a
--     Worker gets 10 ms of CPU per request and scrypt wants a hundred, so
--     hashing a password here was never possible. See
--     shared/auth/accountKeys.ts.
--   * No provider password. `provider_accounts.payload` is ciphertext the
--     device made under a key this service has never seen. A copy of this
--     database is not a copy of anyone's subscription.
--
-- Applied with:
--   wrangler d1 execute xtream --file=./schema.sql            (local)
--   wrangler d1 execute xtream --file=./schema.sql --remote   (the real one)

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  -- Names are unique without regard to case, so "Petar" cannot quietly become
  -- a second account beside "petar", while `username` keeps what was typed.
  username_folded TEXT NOT NULL UNIQUE,
  -- dk1$scrypt$N$r$p$salt$sha256(auth). Self-describing, so the cost can be
  -- raised later without stranding accounts made before the change.
  auth_verifier TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- The family. An account with no
  -- manager is at the top of its own; every account made before families is.
  role TEXT NOT NULL DEFAULT 'admin',
  manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Shown as a profile to pick on its managers' own devices.
  household INTEGER NOT NULL DEFAULT 0,
  -- Its profile picture (shared/profilePicture.ts): `animal:fox` or a small
  -- image as a data address; null for the animal worked out from the name.
  picture TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_manager ON users(manager_id);

-- Whoever holds a token is signed in, so a copy of this table should not hand
-- out live sessions: the token is stored hashed. No salt and a plain digest is
-- right here where it would be wrong for a password -- the token is 256 bits
-- of randomness, so there is nothing to guess and nobody to slow down.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  -- 'full', or 'setup' for a manager setting this account up: its setup and
  -- never its favourites or history (shared/family.ts); 'tool' or
  -- 'tool-history' for the tvinto CLI.
  scope TEXT NOT NULL DEFAULT 'full',
  -- What a tool session is called where the account lists it: "Tool on
  -- DESKTOP-1". Null for every other session.
  label TEXT,
  -- A tool's changes this minute, as "<minute>|<count>" (chargeToolChanges).
  tool_window TEXT,
  -- Who made this session, when it is not the account's own sign-in: the
  -- account and the public id of its session (a manager's setup or profile
  -- session, or a tool's), and whether that was a tool's. It lives only as
  -- long as that session does (sessions.ts, MintedBy).
  minted_by INTEGER,
  minted_by_session TEXT,
  minted_by_tool INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_idle ON sessions(last_used_at);

-- A tool asking to be let in, until a device of the account allows or refuses
-- it (worker/src/toolRequests.ts). Ten minutes at most; the sealed parts are
-- sealed for the tool's own public key and opened only by it.
CREATE TABLE IF NOT EXISTS tool_requests (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  history INTEGER NOT NULL DEFAULT 0,
  public_key TEXT NOT NULL,
  code TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  sealed_token TEXT,
  sealed_enc TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- The confirmation the app shows once it is allowed, hashed, and how many
  -- times a wrong one was sent (toolRequests.ts).
  confirm_hash TEXT,
  confirm_tries INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tool_requests_user ON tool_requests(user_id, status);

-- What a tool asked for and only a person may do, waiting for the app
-- (worker/src/toolActions.ts): add or remove a member, reset a member's
-- password, take the lock off. Ten minutes at most.
CREATE TABLE IF NOT EXISTS tool_actions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  details TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_actions_user ON tool_actions(user_id, status);

-- Wrong sign-ins and invite codes, counted for a quarter of an hour
-- (src/signInLimit.ts). The key is a hash of the address, or of the address
-- and the name: no address is kept in the clear, and nothing past its window.
CREATE TABLE IF NOT EXISTS sign_in_failures (
  key TEXT PRIMARY KEY,
  since TEXT NOT NULL,
  count INTEGER NOT NULL
);

-- Invite codes, the one way through a closed registration (src/invites.ts).
-- Hashed like a session token: a copy of this table is not a way in.
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_invites_creator ON invites(created_by);

-- An account's key pair (shared/auth/keyPair.ts): the public half in the
-- clear, the private half sealed under the account's own enc. What lets a
-- manager's device and a member's device seal things for each other.
CREATE TABLE IF NOT EXISTS account_keys (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  sealed_private_key TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- An account's enc, sealed for the public key of one of the accounts above
-- it. Holding it is what lets a manager set up the member's subscription and
-- guides, which are sealed under that enc; nothing here can open it.
CREATE TABLE IF NOT EXISTS managed_keys (
  member_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  manager_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sealed_enc TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (member_id, manager_id)
);

CREATE INDEX IF NOT EXISTS idx_managed_keys_manager ON managed_keys(manager_id);

-- A subscription, as an opaque blob.
--
-- The id is the device's, worked out from the server and the provider username
-- so that renewing credentials updates a row rather than adding one. It cannot
-- be worked out here: the label, the address and the username are all inside
-- the ciphertext, and this service can read none of them.
CREATE TABLE IF NOT EXISTS provider_accounts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_providers_user ON provider_accounts(user_id, active);

-- The two clocks, on every table below.
--
--   updated_at is intent: when the person did the thing. It is what
--     last-write-wins compares, and it comes from the device that made it.
--   synced_at is arrival: when this service wrote it down. It is what a pull
--     cursor moves along, and it always comes from here.
--
-- Keeping them apart is what lets a device that was offline for a week push
-- changes stamped last Tuesday and still have them delivered to everyone else
-- as new.

CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  name TEXT,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (user_id, type, stream_id)
);

CREATE INDEX IF NOT EXISTS idx_favorites_since ON favorites(user_id, synced_at);

-- One row per scope, holding the whole ordering as JSON.
--
-- The Express backend stores a row per position, because it also reads an
-- arrangement to apply it. This service never does: an arrangement is
-- something it carries between devices and never looks inside.
--
-- The shape follows from the budget. A Worker gets fifty queries per request
-- on the free plan, and this account has 830 live categories -- so a row per
-- position would mean 830 statements to save one drag of one category, and the
-- request would fail. It is also the more honest shape: an arrangement only
-- means anything entire, and half an ordering is not a smaller ordering, it is
-- a wrong one.
CREATE TABLE IF NOT EXISTS sort_order (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  -- A JSON array of ids, in order.
  item_ids TEXT NOT NULL,
  -- A JSON object of id to name, for the ids that have one.
  names TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (user_id, scope)
);

CREATE INDEX IF NOT EXISTS idx_sort_order_since ON sort_order(user_id, synced_at);

CREATE TABLE IF NOT EXISTS watch_progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  series_id TEXT,
  season INTEGER,
  episode_num INTEGER,
  name TEXT NOT NULL,
  episode_title TEXT,
  icon TEXT,
  container_extension TEXT,
  position_seconds INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,

  -- The tracks this was last watched with, or NULL for "nobody has said".
  --
  -- Nullable on purpose. A device whose player cannot report its tracks still
  -- sends progress, and the upsert keeps what is here rather than replacing it
  -- with emptiness -- so one device forgetting does not make every device
  -- forget. Languages rather than track numbers, which mean nothing to a
  -- different player.
  audio_language TEXT,
  subtitle_language TEXT,

  -- The track's own name, because a language does not identify one: a film
  -- here offers "English (forced)", "English" and "English (SDH)", and
  -- remembering only the language selected the first of the three every time.
  audio_title TEXT,
  subtitle_title TEXT,

  subtitles_enabled INTEGER,

  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (user_id, type, item_id)
);

CREATE INDEX IF NOT EXISTS idx_progress_since ON watch_progress(user_id, synced_at);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_settings_since ON user_settings(user_id, synced_at);

-- A guide the account uses, as a sealed blob.
--
-- Signing in on a new device should offer the guides you already use rather
-- than send you hunting for the URL again. What each device has actually
-- downloaded is its own business and stays there: a guide is tens of megabytes
-- and a phone on mobile data should get a choice.
--
-- The label, the URL and whether it is enabled are all inside `payload`. An
-- Xtream guide URL is `xmltv.php?username=...&password=...`, so it is a
-- credential whatever it looks like, and this service can read none of it. The
-- id is a hash of the URL and carries none of it either, which is what lets it
-- be the key of a row on a server that can read nothing else.
CREATE TABLE IF NOT EXISTS guide_sources (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_guide_sources_since ON guide_sources(user_id, synced_at);

-- One stream tied by hand to one guide channel.
--
-- In the clear, unlike a source: a stream id, a guide id and a channel id like
-- `HTV1.hr` are not credentials and nothing is learned from them.
--
-- A row per mapping rather than one blob, because this is work a person did by
-- hand -- nearly half a real line-up carries no channel id at all -- and two
-- devices editing it must not silently discard each other's.
CREATE TABLE IF NOT EXISTS channel_mappings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stream_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (user_id, stream_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_mappings_since ON channel_mappings(user_id, synced_at);

-- A subtitle an account added from OpenSubtitles.
--
-- Kept so the account's other devices play with it without spending another
-- of the day's downloads; never shared between accounts. Not in the change
-- feed: a device asks for the subtitles of the one item about to play, and
-- `body` (WebVTT, at most 512 KB) is too big to ride along on every sync.
-- The same OpenSubtitles file for the same item is one row, not two.
CREATE TABLE IF NOT EXISTS subtitles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  series_id TEXT,
  season INTEGER,
  episode_num INTEGER,
  name TEXT,
  language TEXT NOT NULL,
  release TEXT NOT NULL,
  file_id INTEGER NOT NULL,
  hearing_impaired INTEGER NOT NULL DEFAULT 0,
  offset_ms INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, type, item_id, file_id)
);

CREATE INDEX IF NOT EXISTS idx_subtitles_item ON subtitles(user_id, type, item_id);

-- The account's OpenSubtitles login, as a sealed blob.
--
-- Sealed on the device under the account's own key, like the subscription:
-- the username and password are inside and this service can read neither.
-- Kept so every device can sign in again when OpenSubtitles' 24-hour token
-- runs out, rather than asking the person to link again each day.
CREATE TABLE IF NOT EXISTS subtitle_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A record that something was deleted.
--
-- Needed because absence does not travel. Without one of these, a device still
-- holding a favourite you removed elsewhere would re-add it on its next push,
-- and unstarring anything would be impossible to make stick.
CREATE TABLE IF NOT EXISTS sync_tombstones (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  item_key TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (user_id, kind, item_key)
);

CREATE INDEX IF NOT EXISTS idx_tombstones_since ON sync_tombstones(user_id, synced_at);
