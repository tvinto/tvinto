import { channelDisplay } from './channel-display.utils';

/**
 * What the show detail page says about a show (TV-6).
 *
 * The provider's `get_series_info` nests the facts under `info` beside
 * `episodes`, while the Express backend flattens them; both shapes turn up, so
 * both are read here rather than in the template.
 */

/** The facts beside the poster. Every field may be empty; the page leaves out what is. */
export interface SeriesFacts {
  cover: string;
  plot: string;
  year: string;
  genre: string;
  /** Out of five, whole dots; 0 when the provider gave no rating. */
  rating: number;
}

type Loose = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

export function seriesFacts(raw: unknown): SeriesFacts {
  const outer = (raw && typeof raw === 'object' ? raw : {}) as Loose;
  const info = (outer['info'] && typeof outer['info'] === 'object' ? outer['info'] : outer) as Loose;

  const released = text(info['releaseDate']) || text(info['release_date']) || text(info['year']);
  const year = /\b(19|20)\d{2}\b/.exec(released)?.[0] ?? '';

  const fiveBased = Number(info['rating_5based']);
  const tenBased = Number(info['rating']);
  const outOfFive = fiveBased > 0 ? fiveBased : tenBased > 0 ? tenBased / 2 : 0;

  return {
    cover: text(info['cover']) || text(info['cover_big']) || text(info['movie_image']),
    plot: text(info['plot']) || text(info['description']),
    year,
    // "Drama, Crime, Mystery" is one line on a television only up to a point.
    genre: text(info['genre']).split(/\s*[,/]\s*/).filter(Boolean).slice(0, 2).join(' · '),
    rating: Math.min(5, Math.max(0, Math.round(outOfFive)))
  };
}

/**
 * An episode's running time in whole minutes, or null when the provider did
 * not say. Reads `duration_secs` first, then an "HH:MM:SS" `duration`.
 */
export function episodeMinutes(info: unknown): number | null {
  const fields = (info && typeof info === 'object' ? info : {}) as Loose;

  const seconds = Number(fields['duration_secs']);
  if (seconds > 0) {
    return Math.max(1, Math.round(seconds / 60));
  }

  const clock = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(text(fields['duration']));
  if (!clock) {
    return null;
  }
  const [hours, minutes, secs] = clock[3] === undefined
    ? [0, Number(clock[1]), Number(clock[2])]
    : [Number(clock[1]), Number(clock[2]), Number(clock[3])];
  const total = hours * 3600 + minutes * 60 + secs;
  return total > 0 ? Math.max(1, Math.round(total / 60)) : null;
}

/** A film's or show's name as a poster card writes it (TV-5, TV-13). */
export interface PosterTitle {
  /** Without the country tag, the packaging tags or the year. */
  title: string;
  /** The superscript tags, drawn small beside the title. */
  tags: string;
  /** The year the provider wrote into the name, or an empty string. */
  year: string;
}

/** A year in brackets, and whatever the provider wrote after it: "(2026) (MULTI SUB)". */
const BRACKETED_YEAR = /\s*[([]\s*((?:19|20)\d{2})\s*[)\]].*$/;

/** A year after a dash at the very end: "Zora Mrak - 2019". */
const DASHED_YEAR = /\s+-\s+((?:19|20)\d{2})\s*$/;

/** A provider's short prefix with a spaced dash after it: "EN - ", "A+ - ". */
const PREFIX = /^\s*[A-Za-z0-9+]{1,4}\s+[-|:]\s+/;

/**
 * The provider's prefix itself, "FR" of "FR - Supernatural", or ''. What tells
 * two copies of one show apart when the title is the same.
 */
export function namePrefix(name: string | null | undefined): string {
  return /^\s*([A-Za-z0-9+]{1,4})\s+[-|:]\s+/.exec(name ?? '')?.[1].toUpperCase() ?? '';
}

/**
 * "EX - 3 Body Problem (2024)" is "3 Body Problem", from 2024.
 *
 * The catalogue keeps no year of its own -- asking the provider for one is a
 * request per title, which is a sweep -- so the name is the only place it is.
 * Anything after the bracketed year is the provider's own labelling ("(MULTI
 * SUB)", a cast name) and goes with it.
 */
export function posterTitle(name: string | null | undefined): PosterTitle {
  const { title: cleaned, tags } = channelDisplay(name);
  const title = cleaned.replace(PREFIX, '') || cleaned;
  const match = BRACKETED_YEAR.exec(title) ?? DASHED_YEAR.exec(title);
  if (!match) {
    return { title, tags, year: '' };
  }
  const stripped = title.slice(0, match.index).trim();
  return { title: stripped || title, tags, year: stripped ? match[1] : '' };
}
