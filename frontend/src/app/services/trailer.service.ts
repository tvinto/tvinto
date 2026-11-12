import { Injectable, inject, signal } from '@angular/core';
import { TmdbTrailer, trailerWatch } from '@shared/tmdb/trailers';
import { TvNavigationService } from './tv-navigation.service';
import { ToastService } from './toast.service';
import { t } from '../utils/i18n';

/** What the trailer dialog shows: whose trailers, and which is playing. */
export interface TrailerRequest {
  title: string;
  trailers: TmdbTrailer[];
  current: TmdbTrailer;
}

/** How long a television is given to hand the link to YouTube before it is taken as not there. */
const HAND_OFF_MS = 4000;

/**
 * Trailers (round 6, TV-33, D-22, P-21). On a desktop and a phone, a dialog
 * with YouTube's player in it. On a television, YouTube's own app: an
 * embedded player cannot be driven with a remote. Trailers are YouTube's,
 * not the provider's, so the one-connection rule has nothing to do with them.
 */
@Injectable({ providedIn: 'root' })
export class TrailerService {
  private readonly tv = inject(TvNavigationService);
  private readonly toasts = inject(ToastService);

  /** The dialog's job, for the one TrailerDialogComponent the app holds. */
  readonly request = signal<TrailerRequest | null>(null);

  /** "Opening the trailer in YouTube", for the moment a television takes to hand it over. */
  readonly opening = signal<{ title: string; name: string } | null>(null);

  open(title: string, trailers: readonly TmdbTrailer[]): void {
    const first = trailers[0];
    if (!first) {
      return;
    }
    if (this.tv.isTelevision()) {
      void this.handOff(title, first);
      return;
    }
    this.request.set({ title, trailers: [...trailers], current: first });
  }

  choose(trailer: TmdbTrailer): void {
    this.request.update(request => (request ? { ...request, current: trailer } : request));
  }

  close(): void {
    this.request.set(null);
  }

  /**
   * Hands the trailer to whatever plays YouTube links -- the YouTube app on
   * an Android TV. The WebView passes a link to another site to Android
   * rather than opening it, and the page goes to the background; if it is
   * still in front after a few seconds, nothing took it.
   */
  private async handOff(title: string, trailer: TmdbTrailer): Promise<void> {
    const url = trailerWatch(trailer.key);
    this.opening.set({ title, name: trailer.name });
    let left = false;
    const onHidden = () => (left = left || document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onHidden);
    try {
      window.location.href = url;
      await new Promise(resolve => setTimeout(resolve, HAND_OFF_MS));
    } finally {
      document.removeEventListener('visibilitychange', onHidden);
      this.opening.set(null);
    }
    if (!left && document.visibilityState === 'visible') {
      this.toasts.error(t('trailer.noYouTube'), t('trailer.noYouTubeBody'), {
        detail: `${url.replace('https://www.', '')} · ${t('trailer.noHandler')} · ${new Date().toLocaleTimeString()}`
      });
    }
  }
}
