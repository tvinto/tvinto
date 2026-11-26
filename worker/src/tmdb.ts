import { Env, Row, text } from './d1';
import { ok } from './http';
import { now } from './clock';
import { readSealed } from './subtitles';

/**
 * The key, for a signed-in app to ask TMDB for descriptions with.
 *
 * The same arrangement as OpenSubtitles' (`subtitlesConfig`): each sync
 * service's own configuration, handed to its signed-in apps, which call TMDB
 * themselves -- so what somebody looks at never passes through here. Null
 * rather than an error when none is set, so an app can say descriptions from
 * TMDB are not set up. Never logged.
 */
export const tmdbConfig = async (env: Env): Promise<Response> => ok({ apiKey: env.TMDB_API_KEY?.trim() || null });

/**
 * The account's own TMDB key, sealed on a device under the account's key, or
 * null. What a device typed in Settings or the first launch, so every device
 * of the account uses it; `tmdbConfig` is the fallback when there is none.
 * Per account: each family member or profile has its own, like the
 * OpenSubtitles login.
 */
export const getTmdbKey = async (env: Env, userId: number): Promise<Response> => {
  const row = await env.DB.prepare('SELECT payload, updated_at FROM tmdb_keys WHERE user_id = ?').bind(userId).first<Row>();
  return ok(row ? { payload: text(row['payload']), updatedAt: text(row['updated_at']) } : null);
};

/** Keeps a sealed key, replacing any before it. Refuses anything not sealed. */
export const saveTmdbKey = async (request: Request, env: Env, userId: number): Promise<Response> => {
  const payload = await readSealed(request);
  const at = now();
  await env.DB.prepare(
    `INSERT INTO tmdb_keys (user_id, payload, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
  )
    .bind(userId, payload, at)
    .run();
  return ok({ payload, updatedAt: at });
};

export const forgetTmdbKey = async (env: Env, userId: number): Promise<Response> => {
  await env.DB.prepare('DELETE FROM tmdb_keys WHERE user_id = ?').bind(userId).run();
  return ok(null);
};
