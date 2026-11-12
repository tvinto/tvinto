import {
  MAX_SUBTITLE_BYTES,
  MAX_SUBTITLE_OFFSET_MS,
  MAX_SUBTITLES_PER_ACCOUNT,
  MAX_SUBTITLES_PER_ITEM,
  NewSubtitle,
  SavedSubtitle,
  SavedSubtitleWithText,
  isWebVtt
} from '../../shared/subtitles';
import { Env, Row, maybeNumber, maybeText, number, text } from './d1';
import { HttpError, ok, readJson } from './http';
import { now } from './clock';

/**
 * Subtitles from OpenSubtitles: the application's key, and what each account
 * added.
 *
 * Deliberately not a proxy. Devices call OpenSubtitles themselves, so an
 * account's OpenSubtitles password and token never pass through here, and each
 * home is its own IP against their per-IP limits rather than every account
 * sharing Cloudflare's. What is left for this service is the two things a
 * device cannot keep on its own: the key, which belongs in no file, and the
 * files already downloaded, which the account's other devices should not have
 * to spend a download on again.
 */

/** Subtitle ids are ours, made here; nothing else is accepted in a path. */
export const SUBTITLE_ROUTE = /^(GET|POST|DELETE) \/api\/subtitles\/([A-Za-z0-9-]{8,64})$/;

const COLUMNS = `id, type, item_id, series_id, season, episode_num, name, language, release,
  file_id, hearing_impaired, offset_ms, created_at, updated_at`;

/**
 * The key, for a signed-in app to call OpenSubtitles with.
 *
 * Null rather than an error when none is set, so an app can say "subtitles are
 * not set up yet" instead of failing. Never logged. A device holds it in
 * memory; that is the most any app that carries a key can do, and
 * OpenSubtitles' own model -- one key per application, replaceable if it
 * leaks -- expects exactly that.
 */
export const subtitlesConfig = async (env: Env): Promise<Response> =>
  ok({ apiKey: env.OPENSUBTITLES_API_KEY?.trim() || null });

/**
 * The account's OpenSubtitles login, sealed, or null when none is linked.
 *
 * Ciphertext the device made under a key this service has never seen. Nothing
 * here can tell a username from a password inside it, which is the point.
 */
export const getSubtitleAccount = async (env: Env, userId: number): Promise<Response> => {
  const row = await env.DB.prepare('SELECT payload, updated_at FROM subtitle_accounts WHERE user_id = ?')
    .bind(userId)
    .first<Row>();

  return ok(row ? { payload: text(row['payload']), updatedAt: text(row['updated_at']) } : null);
};

/** Keeps a sealed login, replacing any before it. Refuses anything not sealed. */
export const saveSubtitleAccount = async (request: Request, env: Env, userId: number): Promise<Response> => {
  const { payload } = await readJson<{ payload?: unknown }>(request);

  // The shape of a box from shared/auth/secretBox.ts. Checked so that a device
  // with a bug can never leave a password here in the clear.
  if (typeof payload !== 'string' || !/^sb1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(payload) || payload.length > 4096) {
    throw new HttpError('A sealed payload is required', 400);
  }

  const at = now();
  await env.DB.prepare(
    `INSERT INTO subtitle_accounts (user_id, payload, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
  )
    .bind(userId, payload, at)
    .run();

  return ok({ payload, updatedAt: at });
};

export const forgetSubtitleAccount = async (env: Env, userId: number): Promise<Response> => {
  await env.DB.prepare('DELETE FROM subtitle_accounts WHERE user_id = ?').bind(userId).run();
  return ok(null);
};

/** What an account keeps, without the text: every subtitle, or one item's. */
export const listSubtitles = async (request: Request, env: Env, userId: number): Promise<Response> => {
  const query = new URL(request.url).searchParams;
  const type = query.get('type');
  const itemId = query.get('itemId');

  if ((type === null) !== (itemId === null)) {
    throw new HttpError('type and itemId go together', 400);
  }

  const rows =
    type === null
      ? await env.DB.prepare(
          `SELECT ${COLUMNS} FROM subtitles WHERE user_id = ? ORDER BY updated_at DESC`
        )
          .bind(userId)
          .all()
      : await env.DB.prepare(
          `SELECT ${COLUMNS} FROM subtitles WHERE user_id = ? AND type = ? AND item_id = ?
            ORDER BY updated_at DESC`
        )
          .bind(userId, itemType(type), itemId)
          .all();

  return ok(rows.results.map(row => toSubtitle(row as Row)));
};

/** One subtitle with its text, for a device about to play with it. */
export const getSubtitle = async (env: Env, userId: number, id: string): Promise<Response> => {
  const row = await env.DB.prepare(`SELECT ${COLUMNS}, body FROM subtitles WHERE user_id = ? AND id = ?`)
    .bind(userId, id)
    .first<Row>();

  if (!row) {
    throw new HttpError('No such subtitle', 404);
  }

  const withText: SavedSubtitleWithText = { ...toSubtitle(row), text: text(row['body']) };
  return ok(withText);
};

/**
 * Keeps a downloaded subtitle for the account.
 *
 * The same OpenSubtitles file for the same item replaces the row it had,
 * keeping its id and offset unless a new offset was sent, so choosing a
 * subtitle twice is not two subtitles.
 */
export const addSubtitle = async (request: Request, env: Env, userId: number): Promise<Response> => {
  const input = validNew(await readJson<Partial<NewSubtitle>>(request));

  const counts = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN type = ? AND item_id = ? THEN 1 ELSE 0 END) AS for_item,
       MAX(CASE WHEN type = ? AND item_id = ? AND file_id = ? THEN id END) AS existing
     FROM subtitles WHERE user_id = ?`
  )
    .bind(input.type, input.itemId, input.type, input.itemId, input.fileId, userId)
    .first<Row>();

  const existing = maybeText(counts?.['existing']);
  if (!existing) {
    if (number(counts?.['total']) >= MAX_SUBTITLES_PER_ACCOUNT) {
      throw new HttpError(
        `An account can keep ${MAX_SUBTITLES_PER_ACCOUNT} subtitles. Remove some first.`,
        409
      );
    }
    if (number(counts?.['for_item']) >= MAX_SUBTITLES_PER_ITEM) {
      throw new HttpError(
        `One title can keep ${MAX_SUBTITLES_PER_ITEM} subtitles. Remove one first.`,
        409
      );
    }
  }

  const id = existing ?? crypto.randomUUID();
  const at = now();

  await env.DB.prepare(
    `INSERT INTO subtitles (
       user_id, id, type, item_id, series_id, season, episode_num, name, language, release,
       file_id, hearing_impaired, offset_ms, body, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, type, item_id, file_id) DO UPDATE SET
       series_id = excluded.series_id,
       season = excluded.season,
       episode_num = excluded.episode_num,
       name = excluded.name,
       language = excluded.language,
       release = excluded.release,
       hearing_impaired = excluded.hearing_impaired,
       offset_ms = ${input.offsetMs === undefined ? 'subtitles.offset_ms' : 'excluded.offset_ms'},
       body = excluded.body,
       updated_at = excluded.updated_at`
  )
    .bind(
      userId,
      id,
      input.type,
      input.itemId,
      input.seriesId ?? null,
      input.season ?? null,
      input.episodeNum ?? null,
      input.name ?? null,
      input.language,
      input.release,
      input.fileId,
      input.hearingImpaired ? 1 : 0,
      input.offsetMs ?? 0,
      input.text,
      at,
      at
    )
    .run();

  return readBack(env, userId, id, existing ? 200 : 201);
};

/** Changes what can change after adding: the offset. */
export const updateSubtitle = async (
  request: Request,
  env: Env,
  userId: number,
  id: string
): Promise<Response> => {
  const input = await readJson<{ offsetMs?: unknown }>(request);
  const offsetMs = validOffset(input.offsetMs);
  if (offsetMs === undefined) {
    throw new HttpError('offsetMs is required', 400);
  }

  const result = await env.DB.prepare(
    'UPDATE subtitles SET offset_ms = ?, updated_at = ? WHERE user_id = ? AND id = ?'
  )
    .bind(offsetMs, now(), userId, id)
    .run();

  if (!result.meta.changes) {
    throw new HttpError('No such subtitle', 404);
  }

  return readBack(env, userId, id, 200);
};

export const removeSubtitle = async (env: Env, userId: number, id: string): Promise<Response> => {
  const result = await env.DB.prepare('DELETE FROM subtitles WHERE user_id = ? AND id = ?')
    .bind(userId, id)
    .run();

  if (!result.meta.changes) {
    throw new HttpError('No such subtitle', 404);
  }

  return ok({ removed: id });
};

const readBack = async (env: Env, userId: number, id: string, status: number): Promise<Response> => {
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM subtitles WHERE user_id = ? AND id = ?`)
    .bind(userId, id)
    .first<Row>();

  if (!row) {
    throw new HttpError('No such subtitle', 404);
  }
  return ok(toSubtitle(row), status);
};

const toSubtitle = (row: Row): SavedSubtitle => ({
  id: text(row['id']),
  type: itemType(text(row['type'])),
  itemId: text(row['item_id']),
  seriesId: maybeText(row['series_id']),
  season: maybeNumber(row['season']),
  episodeNum: maybeNumber(row['episode_num']),
  name: maybeText(row['name']),
  language: text(row['language']),
  release: text(row['release']),
  fileId: number(row['file_id']),
  hearingImpaired: number(row['hearing_impaired']) === 1,
  offsetMs: number(row['offset_ms']),
  createdAt: text(row['created_at']),
  updatedAt: text(row['updated_at'])
});

const itemType = (value: string): 'vod' | 'series' => {
  if (value !== 'vod' && value !== 'series') {
    throw new HttpError('type must be vod or series', 400);
  }
  return value;
};

const shortText = (value: unknown, field: string, max: number, required: boolean): string | null => {
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new HttpError(`${field} is required`, 400);
    }
    return null;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new HttpError(`${field} must be text`, 400);
  }
  const trimmed = String(value).trim();
  if (required && !trimmed) {
    throw new HttpError(`${field} is required`, 400);
  }
  if (trimmed.length > max) {
    throw new HttpError(`${field} is too long`, 400);
  }
  return trimmed || null;
};

const smallInteger = (value: unknown, field: string): number | null => {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 100_000) {
    throw new HttpError(`${field} must be a whole number`, 400);
  }
  return value as number;
};

const validOffset = (value: unknown): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || Math.abs(value as number) > MAX_SUBTITLE_OFFSET_MS) {
    throw new HttpError(`offsetMs must be whole milliseconds within ${MAX_SUBTITLE_OFFSET_MS / 1000} s`, 400);
  }
  return value as number;
};

const validNew = (input: Partial<NewSubtitle>): NewSubtitle & { offsetMs?: number } => {
  const type = itemType(String(input.type ?? ''));
  const itemId = shortText(input.itemId, 'itemId', 64, true) as string;
  const language = shortText(input.language, 'language', 16, true) as string;
  const release = shortText(input.release, 'release', 300, true) as string;

  if (!/^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(language)) {
    throw new HttpError('language must be a language code', 400);
  }
  if (!Number.isInteger(input.fileId) || (input.fileId as number) <= 0) {
    throw new HttpError('fileId must be an OpenSubtitles file id', 400);
  }
  if (typeof input.text !== 'string' || !isWebVtt(input.text)) {
    throw new HttpError('text must be WebVTT', 400);
  }
  if (new TextEncoder().encode(input.text).length > MAX_SUBTITLE_BYTES) {
    throw new HttpError(`A subtitle can be at most ${MAX_SUBTITLE_BYTES / 1024} KB`, 413);
  }

  return {
    type,
    itemId,
    seriesId: shortText(input.seriesId, 'seriesId', 64, false),
    season: smallInteger(input.season, 'season'),
    episodeNum: smallInteger(input.episodeNum, 'episodeNum'),
    name: shortText(input.name, 'name', 300, false),
    language: language.toLowerCase(),
    release,
    fileId: input.fileId as number,
    hearingImpaired: input.hearingImpaired === true,
    offsetMs: validOffset(input.offsetMs),
    text: input.text
  };
};
