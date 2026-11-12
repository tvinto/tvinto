/**
 * A film's or a show's trailers, from TMDB's videos (round 6, TV-33, D-22,
 * P-21): YouTube's only, trailers before teasers, the official ones in the
 * person's language first, then English, then the rest.
 */

export interface TmdbTrailer {
  /** YouTube's id for the video. */
  key: string;
  name: string;
  /** 'Trailer' or 'Teaser'. */
  type: string;
  official: boolean;
  /** "hr", "en", or '' when TMDB does not say. */
  language: string;
}

type Loose = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** The trailers and teasers on YouTube among what TMDB's `videos` lists. */
export function trailersFrom(raw: unknown): TmdbTrailer[] {
  const results = (raw as Loose | undefined)?.['results'];
  return (Array.isArray(results) ? (results as Loose[]) : [])
    .filter(video => text(video['site']) === 'YouTube' && /^(Trailer|Teaser)$/.test(text(video['type'])) && /^[\w-]{6,20}$/.test(text(video['key'])))
    .map(video => ({
      key: text(video['key']),
      name: text(video['name']),
      type: text(video['type']),
      official: video['official'] === true,
      language: text(video['iso_639_1']).toLowerCase()
    }));
}

/** In the order to offer them: the first is what the Trailer button opens. */
export function orderTrailers(trailers: readonly TmdbTrailer[], languages: readonly string[]): TmdbTrailer[] {
  const rank = (trailer: TmdbTrailer): number => {
    const language = languages.indexOf(trailer.language);
    return (
      (trailer.type === 'Trailer' ? 0 : 100) +
      (language >= 0 ? language * 10 : 50) +
      (trailer.official ? 0 : 5)
    );
  };
  const seen = new Set<string>();
  return [...trailers]
    .map((trailer, index) => ({ trailer, index }))
    .sort((a, b) => rank(a.trailer) - rank(b.trailer) || a.index - b.index)
    .map(({ trailer }) => trailer)
    .filter(trailer => !seen.has(trailer.key) && !!seen.add(trailer.key));
}

/** Where YouTube plays a trailer: inside a page, without its tracking cookies, or in its own app. */
export const trailerEmbed = (key: string): string => `https://www.youtube-nocookie.com/embed/${encodeURIComponent(key)}?autoplay=1&rel=0&modestbranding=1`;
export const trailerWatch = (key: string): string => `https://www.youtube.com/watch?v=${encodeURIComponent(key)}`;

/** The languages to ask TMDB for videos in: the person's, English, and those in no language. */
export const videoLanguages = (languages: readonly string[]): string => [...new Set([...languages, 'en'])].join(',') + ',null';
