/**
 * A show's seasons gathered from every copy the provider has of it (22
 * November). A provider lists one show several times -- a 4K copy, an HD one,
 * other languages -- each with its own `get_series_info` and its own seasons,
 * and one copy can be a season behind another. This works out one list of
 * seasons for the show and which copy each season and episode comes from.
 *
 * The rules:
 * - a season the copy in use has comes from that copy, as it always did;
 * - a season it lacks comes from the first other copy that has it, in the
 *   order given (the person's languages, then the best picture);
 * - an episode missing from a season (a gap, or one newer than the copy has)
 *   comes from the first other copy that has it -- but only from a copy whose
 *   numbering for that season agrees, sharing at least one episode number with
 *   the episodes already there. A copy that numbers a season's episodes 11 to
 *   20 where another numbers them 1 to 10 would otherwise double the season.
 */

/** As much of a provider's episode as the merging reads. */
export interface NumberedEpisode {
  season?: number | string | null;
  episode_num?: number | string | null;
}

/** One copy's answer: its episodes by season key, or nothing when it has not answered or had none. */
export interface CopyEpisodes<E> {
  copyId: string;
  episodes: Record<string, E[] | null | undefined> | null | undefined;
}

/** An episode in the merged list, and the copy it plays from. */
export interface MergedEpisode<E> {
  episode: E;
  copyId: string;
}

/** A season in the merged list. */
export interface MergedSeason<E> {
  /** The season's key: the copy in use's own when it has the season, else the copy's it came from. */
  key: string;
  /** The season's number, or null for a key that is no number. */
  number: number | null;
  /** The copy the season comes from: the one its first episodes are in. */
  copyId: string;
  /** Its episodes in order, each with the copy it plays from. */
  episodes: MergedEpisode<E>[];
}

/** A season or an episode number as a number, or null when it is none. */
function numberOf(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

interface CopySeason<E> {
  key: string;
  number: number | null;
  episodes: E[];
}

/** A copy's seasons by number ("1", "01" and "Season 1" are one season), or by key when there is no number. */
function seasonsOf<E extends NumberedEpisode>(copy: CopyEpisodes<E>): Map<string, CopySeason<E>> {
  const seasons = new Map<string, CopySeason<E>>();
  for (const [key, list] of Object.entries(copy.episodes ?? {})) {
    if (!Array.isArray(list) || !list.length) {
      continue;
    }
    const number = numberOf(key) ?? numberOf(/\d+/.exec(key)?.[0]);
    const id = number === null ? `key:${key}` : String(number);
    const held = seasons.get(id) ?? { key, number, episodes: [] };
    held.episodes.push(...list);
    seasons.set(id, held);
  }
  return seasons;
}

/**
 * One list of seasons from every copy. `copies` is in order of preference with
 * the copy in use first; a copy with no answer yet, or an empty one, adds
 * nothing. Seasons come back in number order, any without a number last.
 */
export function mergeCopySeasons<E extends NumberedEpisode>(copies: readonly CopyEpisodes<E>[]): MergedSeason<E>[] {
  const merged = new Map<string, MergedSeason<E>>();
  for (const copy of copies) {
    for (const [id, season] of seasonsOf(copy)) {
      const held = merged.get(id);
      if (!held) {
        merged.set(id, {
          key: season.key,
          number: season.number,
          copyId: copy.copyId,
          episodes: season.episodes.map(episode => ({ episode, copyId: copy.copyId }))
        });
        continue;
      }
      fillGaps(held, season.episodes, copy.copyId);
    }
  }
  return [...merged.values()]
    .map(season => ({ ...season, episodes: inOrder(season.episodes) }))
    .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity));
}

/** Adds another copy's episodes the season lacks, when that copy numbers the season the same way. */
function fillGaps<E extends NumberedEpisode>(season: MergedSeason<E>, offered: E[], copyId: string): void {
  const held = new Set(season.episodes.map(one => numberOf(one.episode.episode_num)).filter((n): n is number => n !== null));
  const numbered = offered.filter(episode => numberOf(episode.episode_num) !== null);
  const agrees = numbered.some(episode => held.has(numberOf(episode.episode_num) as number));
  if (!agrees) {
    return;
  }
  for (const episode of numbered) {
    const number = numberOf(episode.episode_num) as number;
    if (!held.has(number)) {
      held.add(number);
      season.episodes.push({ episode, copyId });
    }
  }
}

function inOrder<E extends NumberedEpisode>(episodes: MergedEpisode<E>[]): MergedEpisode<E>[] {
  return [...episodes].sort((a, b) => (numberOf(a.episode.episode_num) ?? Infinity) - (numberOf(b.episode.episode_num) ?? Infinity));
}

/** Whether the merged seasons have an episode: for "ready to play" on a show's news line. */
export function hasEpisode<E extends NumberedEpisode>(seasons: readonly MergedSeason<E>[], season: number, episode: number): boolean {
  return !!findEpisode(seasons, season, episode);
}

/** The episode with this season and number, and the copy it plays from, if any copy has it. */
export function findEpisode<E extends NumberedEpisode>(seasons: readonly MergedSeason<E>[], season: number, episode: number): MergedEpisode<E> | null {
  const found = seasons.find(one => one.number === season);
  return found?.episodes.find(one => numberOf(one.episode.episode_num) === episode) ?? null;
}

/**
 * Which of the season's episodes come from a copy other than the one in use,
 * by copy: for the line "From the HD copy" over a season's episodes. `season`
 * for the copy the season itself comes from, when it is not the one in use;
 * the others fill its gaps.
 */
export function otherCopiesIn<E extends NumberedEpisode>(
  season: MergedSeason<E> | null | undefined,
  inUse: string
): Array<{ copyId: string; season: boolean; episodes: number[] }> {
  if (!season) {
    return [];
  }
  const byCopy = new Map<string, number[]>();
  for (const { episode, copyId } of season.episodes) {
    if (copyId !== inUse) {
      byCopy.set(copyId, [...(byCopy.get(copyId) ?? []), numberOf(episode.episode_num) ?? 0]);
    }
  }
  return [...byCopy]
    .map(([copyId, episodes]) => ({ copyId, season: copyId === season.copyId, episodes }))
    .sort((a, b) => Number(b.season) - Number(a.season));
}

/**
 * What TMDB says the show has that the merged seasons do not: the numbers of
 * aired seasons missing, and the newest episode when it is missing. The page
 * asks other copies only for a reason, and this is the reason.
 */
export function missingFromCopies<E extends NumberedEpisode>(
  seasons: readonly MergedSeason<E>[],
  tmdb: { seasons: number; latest: { season: number; episode: number } | null }
): { seasons: number[]; episode: { season: number; episode: number } | null } {
  const have = new Set(seasons.map(season => season.number));
  const missing: number[] = [];
  // A season that has not started is not missing: the newest aired one is the limit.
  const aired = tmdb.latest ? Math.min(tmdb.seasons, tmdb.latest.season) : tmdb.seasons;
  for (let number = 1; number <= aired; number++) {
    if (!have.has(number)) {
      missing.push(number);
    }
  }
  const episode = tmdb.latest && !hasEpisode(seasons, tmdb.latest.season, tmdb.latest.episode) ? tmdb.latest : null;
  return { seasons: missing, episode };
}
