import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CapacitorHttp } from '@capacitor/core';
import { firstValueFrom } from 'rxjs';
import { SubtitleResult, SubtitleSearch } from '@shared/opensubtitles/client';
import { SubtitleIdentity, searchFor } from '@shared/opensubtitles/identify';
import { toWebVtt } from '@shared/opensubtitles/vtt';
import { NewSubtitle, SavedSubtitle, SavedSubtitleWithText, SubtitleItemType } from '@shared/subtitles';
import { API_URL } from './api-url';
import { OpenSubtitlesService } from './opensubtitles.service';
import { PlatformService } from './platform.service';
import { LocalProfileService } from './local-profile.service';

/** The film or episode a subtitle is being added to. */
export interface SubtitleItem {
  type: SubtitleItemType;
  itemId: string;
  seriesId?: string | null;
  season?: number | null;
  episodeNum?: number | null;
  /** The film's or show's name, for the Account page's list. */
  name?: string | null;
}

interface Envelope<T> {
  success: boolean;
  data: T;
}

/**
 * Searching OpenSubtitles, and what the account has already added.
 *
 * The three steps of adding one are deliberately separate, because they fail
 * differently and only the middle one costs anything: the search is free, the
 * download spends one of the day's allowance the moment the link is asked for,
 * and saving it to the account is this service's own business.
 *
 * **The file is fetched natively.** OpenSubtitles' API allows cross-origin
 * requests; the temporary link it answers with does not, so a `fetch` from the
 * page is refused by the browser engine with no way round from inside it.
 * Android asks CapacitorHttp and the desktop asks its main process, both of
 * which make the request outside the page.
 */
@Injectable({ providedIn: 'root' })
export class SubtitleLibraryService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = inject(API_URL);
  private readonly subtitles = inject(OpenSubtitlesService);
  private readonly platform = inject(PlatformService);
  private readonly localProfile = inject(LocalProfileService);

  /** How many of the account's subtitles are known, for the Account page. */
  readonly lastRemaining = signal<number | null>(null);

  /** Searching costs nothing against the allowance, and needs no token. */
  async search(
    identity: SubtitleIdentity,
    languages: string[],
    options: { query?: string; page?: number } = {}
  ): Promise<SubtitleSearch> {
    const query = { ...searchFor(identity, languages, options.query), page: options.page };
    return this.subtitles.withSession((client, token) => client.search(query, token));
  }

  /** What this account has already added for one film or episode. */
  async saved(type: SubtitleItemType, itemId: string): Promise<SavedSubtitle[]> {
    // Kept on the account, so without one there are none to ask for.
    if (this.localProfile.active()) {
      return [];
    }
    const response = await firstValueFrom(
      this.http.get<Envelope<SavedSubtitle[]>>(`${this.apiUrl}/subtitles`, { params: { type, itemId } })
    );
    return response.data ?? [];
  }

  /** One subtitle with its text, for a player about to use it. */
  async withText(id: string): Promise<SavedSubtitleWithText> {
    const response = await firstValueFrom(
      this.http.get<Envelope<SavedSubtitleWithText>>(`${this.apiUrl}/subtitles/${id}`)
    );
    return response.data;
  }

  /**
   * Spends a download, fetches the file and keeps it on the account.
   *
   * The allowance is reported before the file is fetched, because that is when
   * it was spent -- and if the fetch then fails, the link is good for three
   * hours and a retry costs nothing more.
   */
  async add(identity: SubtitleIdentity, item: SubtitleItem, result: SubtitleResult): Promise<SavedSubtitle> {
    const download = await this.subtitles.withSession((client, token) => client.download(result.fileId, token));
    this.lastRemaining.set(download.remaining);
    void this.subtitles.refreshAllowance();

    const text = toWebVtt(await this.fetchFile(download.link));
    if (!text) {
      throw new Error('OpenSubtitles sent something that is not a subtitle file. Try another one.');
    }

    const body: NewSubtitle = {
      type: item.type,
      itemId: String(item.itemId),
      seriesId: item.seriesId ?? null,
      season: item.season ?? null,
      episodeNum: item.episodeNum ?? null,
      name: item.name ?? identity.title,
      language: result.language,
      release: result.release || download.fileName || result.fileName,
      fileId: result.fileId,
      hearingImpaired: result.hearingImpaired,
      text
    };

    const saved = await firstValueFrom(this.http.post<Envelope<SavedSubtitle>>(`${this.apiUrl}/subtitles`, body));
    void this.subtitles.refreshSavedCount();
    return saved.data;
  }

  async remove(id: string): Promise<void> {
    await firstValueFrom(this.http.delete(`${this.apiUrl}/subtitles/${id}`));
    void this.subtitles.refreshSavedCount();
  }

  /** Stage 6 uses this; the endpoint is here because the rest of the row is. */
  async setOffset(id: string, offsetMs: number): Promise<SavedSubtitle> {
    const response = await firstValueFrom(
      this.http.post<Envelope<SavedSubtitle>>(`${this.apiUrl}/subtitles/${id}`, { offsetMs })
    );
    return response.data;
  }

  /** A seam for tests, and the one thing that differs between platforms. */
  fetchFile = async (link: string): Promise<string> => {
    const userAgent = this.subtitles.userAgent;

    if (this.platform.platform === 'android') {
      const response = await CapacitorHttp.get({
        url: link,
        responseType: 'text',
        headers: { 'User-Agent': userAgent, Accept: 'text/plain, */*' },
        connectTimeout: 20_000,
        readTimeout: 20_000
      });
      if (response.status !== 200) {
        throw new Error(`The subtitle file could not be fetched (${response.status}).`);
      }
      return typeof response.data === 'string' ? response.data : String(response.data ?? '');
    }

    const desktop = (window as unknown as { xtreamDesktop?: { subtitles?: { fetchText(url: string, userAgent: string): Promise<string> } } })
      .xtreamDesktop;
    if (this.platform.platform === 'electron') {
      if (!desktop?.subtitles) {
        throw new Error('This version of the desktop app cannot fetch subtitle files. Update it first.');
      }
      return desktop.subtitles.fetchText(link, userAgent);
    }

    throw new Error('Adding subtitles needs the phone, television or desktop app.');
  };
}
