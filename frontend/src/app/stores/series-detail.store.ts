import { computed, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withMethods,
  withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { pipe, switchMap, tap, catchError, finalize, of } from 'rxjs';
import { XtreamService } from '../services/xtream.service';
import { SeriesInfo, Episode } from '@shared/types';
import { t } from '../utils/i18n';

interface SeriesDetailState {
  seriesInfo: SeriesInfo | null;
  /**
   * The episodes the page lists, by season key: the show's own, or its
   * seasons gathered from every copy (mergeCopySeasons) once the page has
   * other copies' answers.
   */
  episodes: Record<string, Episode[]>;
  /** Which show seriesInfo is, so a second answer for it keeps the season chosen. */
  loadedId: string;
  availableSeasons: string[];
  selectedSeason: string;
  currentSeasonEpisodes: Episode[];
  loading: boolean;
  /**
   * Whether the provider has yet to answer for the show, behind a kept answer
   * already shown: other copies are asked only after it (one request at a time).
   */
  asking: boolean;
  error: string;
}

const initialState: SeriesDetailState = {
  seriesInfo: null,
  episodes: {},
  loadedId: '',
  availableSeasons: [],
  selectedSeason: '',
  currentSeasonEpisodes: [],
  loading: false,
  asking: false,
  error: '',
};

/** The seasons in number order, and the one to show: `chosen` while it is still there, else the first. */
function listed(episodes: Record<string, Episode[]>, chosen: string) {
  const seasons = Object.keys(episodes).sort((a, b) => parseInt(a) - parseInt(b));
  const season = chosen && episodes[chosen] ? chosen : seasons[0] ?? '';
  return {
    episodes,
    availableSeasons: seasons,
    selectedSeason: season,
    currentSeasonEpisodes: season ? episodes[season] ?? [] : [],
  };
}

export const SeriesDetailStore = signalStore(
  withState(initialState),
  withComputed((store) => ({
    hasSeasons: computed(() => store.availableSeasons().length > 0),
    hasEpisodes: computed(() => store.currentSeasonEpisodes().length > 0),
  })),
  withMethods((store, xtreamService = inject(XtreamService), requests = { made: 0 }) => ({
    /** Says something went wrong that did not come from a request here. */
    setError: (message: string) => {
      patchState(store, { error: message });
    },

    // Load series info
    loadSeriesInfo: rxMethod<string>(
      pipe(
        tap(() => {
          patchState(store, {
            loading: true,
            asking: true,
            error: '',
          });
        }),
        switchMap((seriesId) => {
          // A request left for the next show must not say the next one's is done.
          const mine = ++requests.made;
          return xtreamService.getSeriesInfo(seriesId).pipe(
            tap((info) => {
              // The first season -- unless this is the provider's answer
              // arriving behind the one kept on the device, when the season
              // being looked at stays (XtreamService.getSeriesInfo), and so
              // do the seasons other copies add until the page gathers them
              // again: someone on a season only another copy has stays on it.
              const same = store.loadedId() === seriesId;
              const own = info.episodes ?? {};
              patchState(store, {
                seriesInfo: info,
                ...listed(same ? { ...store.episodes(), ...own } : own, same ? store.selectedSeason() : ''),
                loadedId: seriesId,
                loading: false,
              });
            }),
            finalize(() => mine === requests.made && patchState(store, { asking: false })),
            catchError((error) => {
              patchState(store, {
                error: t('errors.series'),
                loading: false,
              });
              console.error('Series info error:', error);
              return of(null);
            })
          );
        })
      )
    ),

    /**
     * Lists the show's seasons gathered from every copy instead of its own
     * (mergeCopySeasons), keeping the season being looked at.
     */
    setEpisodes(episodes: Record<string, Episode[]>) {
      patchState(store, listed(episodes, store.selectedSeason()));
    },

    // Select a season
    selectSeason(season: string) {
      const episodes = store.episodes()[season];
      if (episodes) {
        patchState(store, {
          selectedSeason: season,
          currentSeasonEpisodes: episodes,
        });
      }
    },

    // Reset state
    reset() {
      patchState(store, initialState);
    },
  }))
);
