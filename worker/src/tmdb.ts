import { Env } from './d1';
import { ok } from './http';

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
