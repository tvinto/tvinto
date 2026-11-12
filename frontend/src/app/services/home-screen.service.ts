import { Injectable, Injector, effect, inject, untracked } from '@angular/core';
import { catchError, firstValueFrom, forkJoin, of } from 'rxjs';
import { SETTING_KEYS, Stream, WatchProgress } from '@shared/types';
import { XtreamService } from './xtream.service';
import { SettingsService } from './settings.service';
import { ParentalLockService } from './parental-lock.service';
import { NativePlayerService } from './native-player.service';
import { homeScreen } from './native/homeScreenPlugin';
import { channelRow, playNext } from '../utils/home-screen.utils';
import { readHiddenShows } from '../utils/for-you.utils';
import { t } from '../utils/i18n';

/** Long enough for the first screen's own requests to go first. */
const FIRST_AFTER_MS = 20 * 1000;
/** A television left on for days still catches up with what was watched elsewhere. */
const EVERY_MS = 60 * 60 * 1000;
/** After the player closes: its position has been saved by then. */
const AFTER_PLAYING_MS = 5 * 1000;

/**
 * Keeps the television's home screen in step with the app: the favourite channels as a row, and what is half watched in
 * "Play next" (home-screen.utils.ts says what goes there).
 *
 * Published when the app starts, each time the player closes -- which is
 * when what is half watched changes -- and hourly. Everything is read from
 * what the app already keeps; nothing extra is asked of the provider.
 */
@Injectable({ providedIn: 'root' })
export class HomeScreenService {
  private readonly xtream = inject(XtreamService);
  private readonly settings = inject(SettingsService);
  private readonly lock = inject(ParentalLockService);
  private readonly player = inject(NativePlayerService);
  private readonly injector = inject(Injector);

  private started = false;
  private publishing = false;

  start(): void {
    const device = homeScreen();
    if (this.started || !device) {
      return;
    }
    this.started = true;

    setTimeout(() => void this.publish(), FIRST_AFTER_MS);
    setInterval(() => void this.publish(), EVERY_MS);

    let wasPlaying = this.player.active();
    effect(() => {
      const playing = this.player.active();
      if (wasPlaying && !playing) {
        untracked(() => setTimeout(() => void this.publish(), AFTER_PLAYING_MS));
      }
      wasPlaying = playing;
    }, { injector: this.injector });
  }

  private async publish(): Promise<void> {
    const device = homeScreen();
    if (!device || this.publishing) {
      return;
    }
    this.publishing = true;
    try {
      const { favourites, live, films, episodes } = await firstValueFrom(
        forkJoin({
          favourites: this.xtream.getFavorites('live').pipe(catchError(() => of([] as Stream[]))),
          live: this.xtream.getRecentlyWatched('live').pipe(catchError(() => of([] as WatchProgress[]))),
          films: this.xtream.getRecentlyWatched('vod').pipe(catchError(() => of([] as WatchProgress[]))),
          episodes: this.xtream.getRecentlyWatched('series', 60).pipe(catchError(() => of([] as WatchProgress[])))
        })
      );
      const keptOut = (category: string | number | null | undefined) =>
        category != null && (this.lock.isHidden('live', String(category)) || this.lock.isLocked('live', String(category)));
      const row = channelRow({
        favourites,
        recent: live,
        keptOut,
        anyKeptOut: this.lock.hidden().live.length > 0 || this.lock.locked().live.length > 0
      });
      await device.publish({
        rowName: t(row.from === 'favourites' ? 'home.favouriteChannels' : 'home.watchedLately'),
        channels: row.items,
        playNext: playNext(films, episodes, readHiddenShows(this.settings.get(SETTING_KEYS.continueHidden)))
      });
    } catch (failure) {
      console.warn('Could not update the home screen', failure instanceof Error ? failure.message : failure);
    } finally {
      this.publishing = false;
    }
  }
}
