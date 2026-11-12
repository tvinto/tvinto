import { Skip } from '@shared/tmdb/introdb';
import { posterTitle } from './series-display.utils';

/**
 * What the Android player's own controls say about a film or an episode
 * (design section 5b, PL-TV-5): the title the library shows rather than the
 * provider's "EN - X-Men [UHD] (2000)", the year, the show above an episode,
 * and the poster. The player adds the runtime and the tracks itself, because
 * only it knows them.
 */
export interface FilmPresentation {
  kind: 'film' | 'episode';
  /** An episode's show, drawn small above its title. */
  heading?: string;
  /** "Dune: Part Two", or "S1 E3 · Long, Long Time". */
  title: string;
  /** "2024", when the name carries one. */
  meta?: string;
  poster?: string | null;
  /** What it is about, for the screen a long pause brings up (PX-TV-8); the film's or episode's, else the show's. */
  description?: string;
}

/**
 * The episodes that follow the one being opened, handed to the player in
 * advance so it can go on to the next by itself (PL-TV-6b). Asking the web app
 * at the moment of the switch failed: while the player has the screen the
 * page behind it runs in the background, and its answer took 20 s to come
 * (The Last Bus, 25 September).
 */
export interface EpisodesAhead {
  /** In playing order; the first is what the card offers. Carries addresses: never logged. */
  ahead: AheadEpisode[];
  /** "The Last of Us · end of season 1", when the list reaches the season's end. */
  end?: string;
}

export interface AheadEpisode {
  itemId: string;
  url: string;
  /** The show, above the title in the controls. */
  showName: string;
  /** "S1 E4 · Please Hold to My Hand", as the controls name it. */
  title: string;
  /** "The Last of Us · S1" and "E4 · Please Hold to My Hand", as the card names it. */
  cardHeading: string;
  cardTitle: string;
  /** "E4", beside the Next episode button. */
  label: string;
  poster?: string | null;
  /** What it is about, for the screen a long pause brings up (PX-TV-8). */
  description?: string;
  /** Its intro, recap and credits, for Skip intro, when they are known. */
  skips?: Skip[];
}

/**
 * Every episode of the show, by season, for the player's Episodes (PX-TV-3,
 * PX-P-2): handed over before the player opens, for the same reason as
 * EpisodesAhead -- nothing the player does while it has the screen may wait
 * on the page behind it.
 */
export interface ShowSeasons {
  seasons: SeasonOfShow[];
}

export interface SeasonOfShow {
  /** "Season 1", as its chip says. */
  label: string;
  /** What the next-episode card says after its last episode, as EpisodesAhead's `end`. */
  end: string;
  episodes: ListedEpisode[];
}

/** One episode in the player's list: what the card names it, and where OK starts it. */
export interface ListedEpisode extends AheadEpisode {
  /** "3", or empty when the provider gives no number. */
  number: string;
  /** The episode's own name, without its number. */
  name: string;
  /** "57 min", or empty. */
  length: string;
  /** How much of it has been watched, from 0 to 1. */
  watched: number;
  /** Where OK starts it: where it was left, unless it was finished. */
  startAtSeconds: number;
}

/**
 * Episodes in playing order (flattenEpisodes), split where the season
 * changes. A provider that gives no season puts them all in one.
 */
export function bySeason<E extends Numbered>(episodes: readonly E[]): { season: number | null; episodes: E[] }[] {
  const seasons: { season: number | null; episodes: E[] }[] = [];
  for (const episode of episodes) {
    const season = seasonOf(episode);
    const last = seasons[seasons.length - 1];
    if (last && last.season === season) {
      last.episodes.push(episode);
    } else {
      seasons.push({ season, episodes: [episode] });
    }
  }
  return seasons;
}

/**
 * Up to `limit` episodes after `currentId` in the same season, and whether
 * they reach its end. Within a season only, as the board has it: after a
 * season's last episode nothing starts by itself.
 */
export function episodesAfter<E extends Numbered>(
  episodes: readonly E[],
  currentId: string,
  limit: number
): { next: E[]; endOfSeason: number | null | undefined } {
  const next: E[] = [];
  let id = currentId;
  while (next.length < limit) {
    const step = nextInSeason(episodes, id);
    if (!step) {
      return { next, endOfSeason: undefined };
    }
    if ('endOfSeason' in step) {
      return { next, endOfSeason: step.endOfSeason };
    }
    next.push(step.next);
    id = String(step.next.id);
  }
  // The limit came first: whether the season ends after these is not known yet.
  const after = nextInSeason(episodes, id);
  return { next, endOfSeason: after && 'endOfSeason' in after ? after.endOfSeason : undefined };
}

/** The fields of an episode this reads. */
interface Numbered {
  id: string | number;
  season?: number | string | null;
  episode_num?: number | string | null;
}

/**
 * The episode after `currentId` in the same season, or the season it ended.
 *
 * Within a season only, as the board has it: after a season's last episode the
 * card says so and nothing starts by itself, because a new season is a choice
 * rather than the next thing. `episodes` in playing order (flattenEpisodes).
 */
export function nextInSeason<E extends Numbered>(
  episodes: readonly E[],
  currentId: string
): { next: E } | { endOfSeason: number | null } | null {
  const index = episodes.findIndex(episode => String(episode.id) === String(currentId));
  if (index < 0) {
    return null;
  }
  const season = seasonOf(episodes[index]);
  const following = episodes[index + 1];
  if (following && seasonOf(following) === season) {
    return { next: following };
  }
  return { endOfSeason: season };
}

const seasonOf = (episode: Numbered): number | null => {
  const season = Number(episode.season);
  return Number.isFinite(season) && episode.season !== null && episode.season !== undefined && episode.season !== '' ? season : null;
};

/** A film, from the name the provider lists it under. */
export function filmPresentation(name: string, poster?: string | null): FilmPresentation {
  const { title, year } = posterTitle(name);
  return { kind: 'film', title: title || name, meta: year || undefined, poster: poster || null };
}

/** An episode: its show, and its number and title. */
export function episodePresentation(
  show: string,
  label: string,
  title: string,
  poster?: string | null
): FilmPresentation {
  const shown = posterTitle(show).title || show;
  const named = [label, title].filter(Boolean).join(' · ');
  return { kind: 'episode', heading: shown || undefined, title: named || shown, poster: poster || null };
}
