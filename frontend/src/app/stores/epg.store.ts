import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { catchError, of, pipe, switchMap, tap } from 'rxjs';
import { XtreamService } from '../services/xtream.service';
import { EPGProgram, Stream } from '@shared/types';
import { asEpgPrograms, onNow } from '../utils';
import { t } from '../utils/i18n';
import { archiveDays } from '@shared/xtream/catchUp';

/** How far back the panel reads for a channel without catch-up: the programme already on. */
const PANEL_BACK_MS = 60 * 60 * 1000;

interface EpgState {
  programs: EPGProgram[];
  currentProgram: EPGProgram | null;
  nextProgram: EPGProgram | null;
  loading: boolean;
  error: string;
}

const initialState: EpgState = {
  programs: [],
  currentProgram: null,
  nextProgram: null,
  loading: false,
  error: ''
};

/**
 * The guide for one channel, as the Programme guide panel shows it.
 *
 * **It asks the device, and that is the whole of the repair.** This used to
 * call `/streams/epg-short/<id>` on the backend, which is an endpoint the sync
 * service does not have and never will -- it keeps accounts and what a person
 * made, not catalogues and not guides. So from the day the account moved, every
 * opening of this panel produced a 404 and the words "Failed to load EPG data",
 * on a screen whose own channel list, two inches behind the dialog, was drawing
 * the same guide correctly from the device's own store.
 *
 * `guideForStreams` is that working path. It matches the channel against the
 * loaded XMLTV sources -- including any mapping chosen by hand -- and falls
 * back to the backend by itself on a device that has no guide of its own, so
 * nothing here has to know which kind of server it is talking to.
 *
 * A channel the guide says nothing about is not an error. It is the ordinary
 * case for half a line-up, and the panel has an empty state that says so and
 * offers the way to fix it.
 */
export const EpgStore = signalStore(
  withState(initialState),
  withComputed(store => ({
    hasPrograms: computed(() => store.programs().length > 0),
    hasCurrentProgram: computed(() => store.currentProgram() !== null)
  })),
  withMethods((store, xtreamService = inject(XtreamService)) => ({
    loadForStream: rxMethod<Stream>(
      pipe(
        tap(() => patchState(store, { loading: true, error: '' })),
        switchMap(stream =>
          // As far back as the channel's catch-up reaches, so its past can be
          // listed and played; the guide keeps finished programmes that long.
          xtreamService.guideForStreams([stream], Math.max(PANEL_BACK_MS, archiveDays(stream) * 24 * 60 * 60 * 1000)).pipe(
            tap(byStream => {
              const programs = asEpgPrograms(byStream[String(stream.stream_id)] ?? []);
              const { current, next } = onNow(programs);

              patchState(store, {
                programs,
                currentProgram: current,
                nextProgram: next,
                loading: false
              });
            }),
            catchError(error => {
              console.error('EPG error:', error);
              patchState(store, { error: t('errors.epg'), loading: false });
              return of(null);
            })
          )
        )
      )
    ),

    reset() {
      patchState(store, initialState);
    }
  }))
);
