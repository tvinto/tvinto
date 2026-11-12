import { inject } from '@angular/core';
import { signalStore, withState, withComputed, withMethods, patchState } from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { EMPTY, defer, merge, of, pipe, forkJoin } from 'rxjs';
import { tap, catchError, switchMap, map, ignoreElements, endWith } from 'rxjs/operators';
import { XtreamService } from '../services/xtream.service';
import { ToastService } from '../services/toast.service';
import { describeProviderError } from '../utils/failure-messages.utils';
import { GUIDE_GRID_BACK_MS } from '../utils/guide.utils';
import { Category, Stream, StreamType } from '@shared/types';
import { t } from '../utils/i18n';
import { GuideByStream, LooseProgramme } from '../utils/guide.utils';

interface SearchParams {
  query: string;
  types: StreamType[];
}

interface DashboardState {
  categories: Category[];
  /** Whether the categories have been read once: until then "0 categories" would be a guess. */
  categoriesLoaded: boolean;
  streams: Stream[];
  allStreams: Stream[];
  loading: boolean;
  error: string;
  isGlobalSearch: boolean;
  selectedType: StreamType | '';
  selectedCategory: string;
  searchTerm: string;
  nowEpgByStreamId: Record<string, LooseProgramme>;
  shortEpgByStreamId: GuideByStream;
}

const initialState: DashboardState = {
  categories: [],
  categoriesLoaded: false,
  streams: [],
  allStreams: [],
  loading: false,
  error: '',
  isGlobalSearch: false,
  selectedType: '',
  selectedCategory: '',
  searchTerm: '',
  nowEpgByStreamId: {}
  ,
  shortEpgByStreamId: {}
};

export const DashboardStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withComputed((store) => ({
    hasStreams: () => store.streams().length > 0,
    hasCategories: () => store.categories().length > 0,
  })),
  withMethods((store) => {
    const xtreamService = inject(XtreamService);
    const toasts = inject(ToastService);

    /**
     * The guide for these streams, and the backend's "now" strip, each put on
     * screen as it arrives. Never one waiting for the other: together in a
     * forkJoin, the device's own guide -- read in milliseconds -- sat finished
     * and unshown until a request to a backend that was not there gave up,
     * and on the TV emulator that was every category, half a minute at a time
     * (8 November). Either failing shows it empty, never an error.
     */
    const guideOnScreen = (streams: Stream[], backMs?: number) => {
      const ids = streams.map(stream => String(stream.stream_id));
      return merge(
        defer(() => xtreamService.guideForStreams(streams, backMs)).pipe(
          catchError((error: unknown) => {
            console.warn('Guide unavailable; showing streams without it', error);
            return of({} as GuideByStream);
          }),
          tap(db => patchState(store, { shortEpgByStreamId: db }))
        ),
        defer(() => xtreamService.getNowEPGForStreams(ids)).pipe(
          catchError(() => of({} as Record<string, LooseProgramme>)),
          tap(now => patchState(store, { nowEpgByStreamId: now }))
        )
      ).pipe(
        ignoreElements(),
        endWith(null)
      );
    };

    /**
     * A request to the provider failed: said in a toast as well as recorded.
     *
     * The page's line of red said "Failed to load streams" whatever the
     * reason, and it was easy to take for an empty category. The toast says
     * which of the likely reasons it was -- no answer, a refused sign-in, the
     * provider's own trouble -- and what to do about it (24
     * September).
     */
    const providerFailed = (error: unknown, loading: string) => {
      const said = describeProviderError(error, loading);
      toasts.error(said.title, said.message, { detail: said.detail });
      return said.title;
    };

    return {
      // Setters for UI selections
      setSelectedType: (type: StreamType | '') => {
        patchState(store, { selectedType: type });
      },
      setSelectedCategory: (categoryId: string) => {
        patchState(store, { selectedCategory: categoryId });
      },
      setSearchTerm: (term: string) => {
        patchState(store, { searchTerm: term });
      },
      /** Says something went wrong that did not come from a request here. */
      setError: (message: string) => {
        patchState(store, { error: message });
      },
      /**
       * Places an externally fetched list into the same state the category
       * listing uses, so favourites render and carry EPG like any other list.
       */
      setStreams: (streams: Stream[]) => {
        patchState(store, {
          streams,
          allStreams: streams,
          loading: false,
          error: '',
          isGlobalSearch: false,
        });
      },
      // Load categories by type
      loadCategories: rxMethod<StreamType>(
        pipe(
          tap(() => {
            patchState(store, {
              loading: true,
              categoriesLoaded: false,
              error: '',
              // keep current streams until new selection triggers load
              isGlobalSearch: false,
            });
          }),
          switchMap((type) =>
            xtreamService.getCategories(type).pipe(
              tap((categories) => {
                patchState(store, {
                  categories,
                  categoriesLoaded: true,
                  loading: false,
                });
              }),
              catchError((error) => {
                console.error('Error loading categories:', error);
                patchState(store, {
                  error: providerFailed(error, t('provider.categories')),
                  categoriesLoaded: true,
                  loading: false,
                });
                return of([]);
              })
            )
          )
        )
      ),

      // Load streams by category
      loadStreams: rxMethod<{ type: StreamType; categoryId: string; quietly?: boolean }>(
        pipe(
          tap(({ quietly }) => {
            // Quietly: the list is already on screen and is only read again.
            patchState(store, {
              loading: !quietly,
              error: '',
            });
          }),
          switchMap(({ type, categoryId }) => {
            const streamType: StreamType = type as StreamType; // Ensure type is StreamType
            return xtreamService.getStreams(categoryId, streamType).pipe(
              switchMap((streams) => {
                patchState(store, {
                  streams,
                  allStreams: streams,
                  loading: false,
                  isGlobalSearch: false,
                  selectedType: type,
                  selectedCategory: categoryId,
                });
                if (!streams.length) return of(streams);
                // The timeline is given the streams rather than their ids: a
                // guide names channels by XMLTV's ids, so joining the two
                // needs epg_channel_id, which only the streams carry.
                //
                // The guide is writing on top of a list that has already
                // arrived and already been shown, so its failure never reaches
                // the handler below: that reported "Failed to load streams"
                // over a screen full of working streams.
                return guideOnScreen(streams, GUIDE_GRID_BACK_MS).pipe(map(() => streams));
              }),
              catchError((error) => {
                console.error('Error loading streams:', error);
                patchState(store, {
                  error: providerFailed(error, t('provider.thisCategory')),
                  loading: false
                });
                return of([]);
              })
            )
          }
          )
        )
      ),

      // Load NOW EPG for given streams and store mapping
      loadNowEPGForStreams: rxMethod<string[]>(
        pipe(
          switchMap((ids) =>
            ids.length
              ? xtreamService.getNowEPGForStreams(ids).pipe(
                  tap((mapping) => patchState(store, { nowEpgByStreamId: mapping })),
                  catchError((error) => {
                    console.error('Failed to load NOW EPG for streams', error);
                    return of({});
                  })
                )
              : of({})
          )
        )
      ),

      

      // Search streams
      searchStreams: rxMethod<SearchParams>(
        pipe(
          tap(() => {
            patchState(store, {
              loading: true,
              error: '',
              isGlobalSearch: true,
            });
          }),
          switchMap(({ query, types }) => {
            if (!query.trim()) {
              patchState(store, {
                streams: store.allStreams(),
                isGlobalSearch: false,
                loading: false,
              });
              return of([]);
            }

            // Make network requests for each type
            const searchObservables = types.map(type => 
              xtreamService.searchStreams(query, type).pipe(
                catchError((error) => {
                  console.error(`Error searching ${type} streams:`, error);
                  return of([]);
                })
              )
            );

            return searchObservables.length > 0 
              ? forkJoin(searchObservables).pipe(
                  map(results => results.flat())
                )
              : of([]);
          }),
          switchMap((searchResults) => {
            patchState(store, {
              streams: searchResults,
              loading: false,
              searchTerm: store.searchTerm(),
            });
            if (!searchResults.length) return of(null);
            // As in loadStreams: the results are already on screen, and a
            // guide that could not be fetched must not report them missing.
            return guideOnScreen(searchResults);
          }),
          catchError((error) => {
            console.error('Error in global search:', error);
            patchState(store, {
              error: providerFailed(error, t('provider.searchResults')),
              loading: false,
            });
            return of([]);
          })
        )
      ),

      // Filter streams by search term
      filterStreams: (searchTerm: string) => {
        const term = searchTerm.toLowerCase();
        const filtered = store.allStreams().filter(stream =>
          stream.name.toLowerCase().includes(term)
        );

        patchState(store, {
          streams: filtered,
          isGlobalSearch: true,
        });
      },

      // Clear search and show all streams
      clearSearch: () => {
        patchState(store, {
          isGlobalSearch: false,
          streams: store.allStreams(),
          nowEpgByStreamId: {}
          ,
          shortEpgByStreamId: {}
        });
      },

      // Reset state
      reset: () => {
        patchState(store, initialState);
      },

      // Refresh now EPG for visible streams (no short EPG auto fetch)
      // "Refresh guide", and now also what runs after a guide finishes loading.
      //
      // It used to read the timeline from getEPGFromDb, which is the Express
      // backend's copy of the guide. Against the sync service that answers an
      // empty object -- and this wrote the empty object over the table, so on a
      // device the refresh button blanked a guide that was working. It reads
      // the device's own guide now, exactly as opening a category does, so the
      // two can never show different things.
      /**
       * The guide of the channels on screen read again from what the device
       * holds, after a channel was matched to a guide by hand. Nothing else:
       * reloading the list put it back at the top every time somebody
       * matched a channel half way down it (10 October), and
       * nothing is asked of the provider.
       */
      rereadGuideForVisible: rxMethod<void>(
        pipe(
          switchMap(() => {
            const streams = store.streams();
            if (!streams.length) return of(null);
            return guideOnScreen(streams, GUIDE_GRID_BACK_MS);
          })
        )
      ),

      refreshNowEPGForVisible: rxMethod<void>(
        pipe(
          switchMap(() => {
            const streams = store.streams();
            const ids = streams.map(s => String(s.stream_id));
            if (!ids.length) return of(null);
            // The device's guide at once; a backend's, if there is one, again
            // once it has refreshed. Read only after that refresh, the device's
            // waited on a backend that, with no server, was never going to answer.
            return merge(
              guideOnScreen(streams, GUIDE_GRID_BACK_MS),
              defer(() => xtreamService.refreshEPGForStreams(ids)).pipe(
                catchError(() => of(null)),
                switchMap(refreshed => (refreshed?.refreshed.length ? guideOnScreen(streams, GUIDE_GRID_BACK_MS) : EMPTY))
              )
            );
          })
        )
      )
    }
  }
  ));