import { computed, inject } from '@angular/core';
import {
  patchState,
  signalStore,
  withComputed,
  withMethods,
  withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { pipe, switchMap, tap, catchError, of } from 'rxjs';
import { XtreamService } from '../services/xtream.service';
import { SeriesInfo, Episode } from '@shared/types';
import { t } from '../utils/i18n';

interface SeriesDetailState {
  seriesInfo: SeriesInfo | null;
  /** Which show seriesInfo is, so a second answer for it keeps the season chosen. */
  loadedId: string;
  availableSeasons: string[];
  selectedSeason: string;
  currentSeasonEpisodes: Episode[];
  loading: boolean;
  error: string;
}

const initialState: SeriesDetailState = {
  seriesInfo: null,
  loadedId: '',
  availableSeasons: [],
  selectedSeason: '',
  currentSeasonEpisodes: [],
  loading: false,
  error: '',
};

export const SeriesDetailStore = signalStore(
  withState(initialState),
  withComputed((store) => ({
    hasSeasons: computed(() => store.availableSeasons().length > 0),
    hasEpisodes: computed(() => store.currentSeasonEpisodes().length > 0),
  })),
  withMethods((store, xtreamService = inject(XtreamService)) => ({
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
            error: '',
          });
        }),
        switchMap((seriesId) =>
          xtreamService.getSeriesInfo(seriesId).pipe(
            tap((info) => {
              // Get available seasons and sort them
              const seasons = Object.keys(info.episodes || {}).sort(
                (a, b) => parseInt(a) - parseInt(b)
              );

              // The first season -- unless this is the provider's answer
              // arriving behind the one kept on the device, when the season
              // being looked at stays (XtreamService.getSeriesInfo).
              const chosen = store.selectedSeason();
              const season =
                store.loadedId() === seriesId && chosen && info.episodes?.[chosen]
                  ? chosen
                  : seasons.length > 0 ? seasons[0] : '';
              const episodes = season && info.episodes?.[season] ? info.episodes[season] : [];

              patchState(store, {
                seriesInfo: info,
                loadedId: seriesId,
                availableSeasons: seasons,
                selectedSeason: season,
                currentSeasonEpisodes: episodes,
                loading: false,
              });
            }),
            catchError((error) => {
              patchState(store, {
                error: t('errors.series'),
                loading: false,
              });
              console.error('Series info error:', error);
              return of(null);
            })
          )
        )
      )
    ),

    // Select a season
    selectSeason(season: string) {
      const info = store.seriesInfo();
      const episodes = info?.episodes?.[season];
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
