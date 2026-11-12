import { Injectable, inject } from '@angular/core';
import {
  EpisodeIdentity,
  FilmIdentity,
  episodeIdentity,
  filmIdentity
} from '@shared/opensubtitles/identify';
import {
  IdentityStore,
  RememberedIds,
  identityKey,
  readIdentityStore,
  recall,
  remember,
  subscriptionKey
} from '@shared/opensubtitles/identityCache';
import { posterTitle } from '../utils/series-display.utils';
import { AccountService } from './account.service';
import { ProviderAccessService } from './provider-access.service';

const STORE_KEY = 'xtream.subtitleIdentity.v1';

/** Details asked of the provider are given this long; a slow answer falls back to the title. */
const DETAILS_TIMEOUT_MS = 8000;

/**
 * Which film or episode "Add subtitles" is for.
 *
 * The provider is asked for one title's details only when a person opens the
 * picker for it, and the ids it gave are remembered on this device, so the
 * next time costs nothing. When the provider cannot be reached, or has no id,
 * the answer is the cleaned-up title -- which a person can still search by.
 *
 * Nothing here plays anything or opens a stream: `get_vod_info` and
 * `get_series_info` are catalogue requests.
 */
@Injectable({ providedIn: 'root' })
export class SubtitleIdentityService {
  private readonly provider = inject(ProviderAccessService);
  private readonly accounts = inject(AccountService);

  /** A seam for tests. */
  now: () => number = () => Date.now();

  /** A film, from its stream id and the name the catalogue shows. */
  async film(streamId: string | number, name: string): Promise<FilmIdentity> {
    const display = posterTitle(name);
    const direct = await this.provider.direct();
    if (!direct) {
      return filmIdentity(null, display);
    }

    const key = identityKey(this.subscription(direct.providerUsername), 'vod', streamId);
    const known = recall(this.read(), key, this.now());
    if (known) {
      return filmIdentity(asDetails(known), display);
    }

    let details: unknown;
    try {
      details = await direct.client.getVodInfo(String(streamId), DETAILS_TIMEOUT_MS);
    } catch {
      // Not remembered: the next attempt may reach the provider.
      return filmIdentity(null, display);
    }

    const identity = filmIdentity(details, display);
    this.keep(key, identity);
    return identity;
  }

  /**
   * An episode, from the show's id and name and the episode's numbers.
   *
   * The show page already holds `get_series_info`; handing it over saves a
   * request and refreshes what is remembered.
   */
  async episode(
    seriesId: string | number,
    showName: string,
    numbers: { season: number; episode: number },
    seriesInfo?: unknown
  ): Promise<EpisodeIdentity> {
    const display = posterTitle(showName);
    const direct = await this.provider.direct();
    const key = direct ? identityKey(this.subscription(direct.providerUsername), 'series', seriesId) : null;

    if (seriesInfo !== undefined && seriesInfo !== null) {
      const identity = episodeIdentity(seriesInfo, numbers, display);
      if (key) {
        this.keep(key, identity);
      }
      return identity;
    }
    if (!direct || !key) {
      return episodeIdentity(null, numbers, display);
    }

    const known = recall(this.read(), key, this.now());
    if (known) {
      return episodeIdentity(asDetails(known).info, numbers, display);
    }

    let info: unknown;
    try {
      info = await direct.client.getSeriesInfo(String(seriesId), DETAILS_TIMEOUT_MS);
    } catch {
      return episodeIdentity(null, numbers, display);
    }

    const identity = episodeIdentity(info, numbers, display);
    this.keep(key, identity);
    return identity;
  }

  private subscription(providerUsername: string): string {
    return subscriptionKey(String(this.accounts.account()?.id ?? ''), providerUsername);
  }

  private keep(key: string, identity: FilmIdentity | EpisodeIdentity): void {
    const ids =
      identity.kind === 'film'
        ? { tmdbId: identity.tmdbId, imdbId: identity.imdbId }
        : { tmdbId: identity.parentTmdbId, imdbId: identity.parentImdbId };
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify(remember(this.read(), key, { ...ids, originalTitle: identity.originalTitle, year: identity.year }, this.now()))
      );
    } catch {
      // Only saves a request next time.
    }
  }

  private read(): IdentityStore {
    try {
      return readIdentityStore(localStorage.getItem(STORE_KEY));
    } catch {
      return {};
    }
  }
}

/** Remembered ids in the shape the identify functions read. */
const asDetails = (known: RememberedIds) => ({
  info: {
    tmdb_id: known.tmdbId ?? '',
    imdb_id: known.imdbId ?? '',
    o_name: known.originalTitle ?? '',
    year: known.year ?? ''
  }
});
