import { SeriesInfo, StreamType } from '@shared/types';
import { XtreamClient } from '@shared/xtream/client';
import { Catalogue } from '@shared/xtream/catalogue';
import { M3uSource } from '@shared/m3u/m3uSource';
import { M3uStream } from '@shared/m3u/m3uPlaylist';
import { m3uCatchUpUrl } from '@shared/m3u/m3uCatchUp';
import { ProviderRecord, tagged, untagged } from '@shared/providers/providerRecord';
import { StalkerSource } from '@shared/stalker/stalkerSource';

/** One provider on this device: its record, and what talks to it. */
export interface ProviderSlot {
  record: ProviderRecord;
  tag: string;
  /** For an Xtream login; null for a playlist. */
  xtream: XtreamClient | null;
  /** For a playlist; null otherwise. */
  m3u: M3uSource | null;
  /** For a Stalker portal; null otherwise. */
  stalker: StalkerSource | null;
  catalogue: Catalogue;
  /** What the slot's catalogue is kept under on the device. */
  storeKey: string;
}

/**
 * The provider calls the app makes by id, sent to the provider the id names.
 *
 * Ids of every slot but the first are `tag~id` (see shared/providers); this
 * takes the tag off, asks that slot in its own terms, and tags what comes back
 * that carries ids of its own -- a show's episodes. What only an Xtream
 * provider can answer (a film's details, the sign-in that reads the clock) is
 * refused for a playlist, which never had it.
 *
 * With one Xtream provider every call goes to it unchanged, which is what
 * `direct.client` was before there could be more than one.
 */
export class RoutedClient {
  constructor(private readonly slots: ProviderSlot[]) {}

  /**
   * An Xtream client for what is about the account rather than an item: the
   * first slot's, or with that one removed, the first Xtream provider there is.
   */
  get primary(): XtreamClient | null {
    return this.slots.find(slot => slot.tag === '')?.xtream ?? this.slots.find(slot => slot.xtream)?.xtream ?? null;
  }

  slotFor(id: string | number): { slot: ProviderSlot; id: string } {
    const parts = untagged(id);
    const slot = this.slots.find(candidate => candidate.tag === parts.tag);
    if (!slot) {
      throw new Error('That provider is not on this device');
    }
    return { slot, id: parts.id };
  }

  async playbackUrl(type: StreamType, streamId: string, extension?: string): Promise<string> {
    const { slot, id } = this.slotFor(streamId);
    if (slot.xtream) {
      return slot.xtream.playbackUrl(type, id, extension);
    }
    if (slot.stalker) {
      // Asked of the portal now: its addresses often work once, or for a minute.
      return slot.stalker.playbackUrl(type, id, () => slot.catalogue.allStreams(type));
    }
    const row = await this.playlistRow(slot, type, id);
    if (!row?.source_url) {
      throw new Error('That entry is no longer in the playlist');
    }
    return row.source_url;
  }

  async getVodContainerExtension(streamId: string): Promise<string | null> {
    const { slot, id } = this.slotFor(streamId);
    return slot.xtream ? slot.xtream.getVodContainerExtension(id) : null;
  }

  async getVodInfo(streamId: string, timeoutMs?: number): Promise<unknown> {
    const { slot, id } = this.slotFor(streamId);
    if (!slot.xtream) {
      throw new Error('A playlist has no film details');
    }
    return slot.xtream.getVodInfo(id, timeoutMs);
  }

  /** A show and its episodes, the episode ids tagged like the show's. */
  async getSeriesInfo(seriesId: string, timeoutMs?: number): Promise<SeriesInfo> {
    const { slot, id } = this.slotFor(seriesId);
    let info: SeriesInfo;
    if (slot.xtream) {
      info = await slot.xtream.getSeriesInfo(id, timeoutMs);
    } else if (slot.stalker) {
      const show = (await slot.catalogue.allStreams('series')).find(stream => String(stream.stream_id) === id);
      info = await slot.stalker.seriesInfo(show ?? { stream_id: id, name: '', icon: '' });
    } else {
      throw new Error('A playlist has no shows');
    }
    if (!slot.tag || !info.episodes) {
      return info;
    }
    const episodes = Object.fromEntries(
      Object.entries(info.episodes).map(([season, list]) => [
        season,
        list.map(episode => ({ ...episode, id: tagged(slot.tag, episode.id) }))
      ])
    );
    return { ...info, id: tagged(slot.tag, info.id ?? id), episodes };
  }

  /**
   * Where a stretch of a channel's past plays from. An Xtream provider is
   * asked in its own clock (`providerTime`, worked out by the caller for that
   * slot); a playlist in UTC, as its placeholders are defined.
   */
  async catchUpUrl(
    streamId: string,
    startMs: number,
    minutes: number,
    providerTime: (slot: ProviderSlot) => Promise<string>
  ): Promise<string> {
    const { slot, id } = this.slotFor(streamId);
    if (slot.xtream) {
      return slot.xtream.catchUpUrl(id, await providerTime(slot), minutes);
    }
    if (slot.stalker) {
      throw new Error('Catch-up from a portal is not there yet');
    }
    const row = await this.playlistRow(slot, 'live', id);
    const url = row ? m3uCatchUpUrl(row, startMs, minutes) : null;
    if (!url) {
      throw new Error('This channel has no catch-up in its playlist');
    }
    return url;
  }

  /**
   * A playlist entry by id: from what the catalogue kept of its category if
   * that is in hand, and from the playlist itself otherwise (read once a
   * session).
   */
  private async playlistRow(slot: ProviderSlot, type: StreamType, id: string): Promise<M3uStream | null> {
    const all = (await slot.m3u?.getStreams(type)) ?? [];
    return (all.find(stream => String(stream.stream_id) === id) as M3uStream | undefined) ?? null;
  }
}
