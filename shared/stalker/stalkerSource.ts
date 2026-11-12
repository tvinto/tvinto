import { CatalogueSource } from '../xtream/source';
import { Category, Episode, SeriesInfo, Stream, StreamType } from '../types';
import { StalkerChannel, StalkerItem, StalkerPortal, StalkerSeason } from './client';

/**
 * A Stalker portal as a catalogue source (shared/xtream/source.ts), so the
 * catalogue, search, the guide and every list keep and show it as they do an
 * Xtream provider or an M3U playlist.
 *
 * What only a portal needs is kept on the stream as `portal_cmd`: what
 * create_link turns into an address when the stream is played
 * (`StalkerPortal.link`). The stores keep it with the playlist fields
 * (capacitorCatalogueStore's EXTRA_FIELDS).
 *
 * Gentle with the portal: the channels are one request, read once a session;
 * films and shows a category at a time, page by page, as the catalogue asks.
 */
export class StalkerSource implements CatalogueSource {
  private connecting: Promise<unknown> | null = null;
  private channelList: Promise<StalkerChannel[]> | null = null;
  /** Every command handed out this session, by type and id: what playing needs without asking again. */
  private readonly commands = new Map<string, string>();
  private readonly seasonsKept = new Map<string, Promise<StalkerSeason[]>>();

  constructor(private readonly portal: StalkerPortal) {}

  private connected(): Promise<unknown> {
    this.connecting ??= this.portal.connect().catch(error => {
      this.connecting = null;
      throw error;
    });
    return this.connecting;
  }

  async getCategories(type: StreamType): Promise<Category[]> {
    await this.connected();
    const found = type === 'live' ? await this.portal.liveGenres() : await this.portal.categories(type);
    return found.map(one => ({ category_id: one.id, category_name: one.title, parent_id: '0' }));
  }

  async getStreams(type: StreamType, categoryId?: string): Promise<Stream[]> {
    await this.connected();
    if (type === 'live') {
      this.channelList ??= this.portal.channels().catch(error => {
        this.channelList = null;
        throw error;
      });
      const channels = await this.channelList;
      return this.remembered(channels.filter(one => !categoryId || one.genreId === categoryId).map(channelStream));
    }
    const categories = categoryId ? [categoryId] : (await this.portal.categories(type)).map(one => one.id);
    const streams: Stream[] = [];
    for (const category of categories) {
      streams.push(...(await this.portal.items(type, category)).map(item => itemStream(item, type, category)));
    }
    return this.remembered(streams);
  }

  private remembered(streams: Stream[]): Stream[] {
    streams.forEach(stream => stream.portal_cmd && this.commands.set(`${stream.type}:${stream.stream_id}`, stream.portal_cmd));
    return streams;
  }

  /**
   * The address to play a stream at, asked of the portal just before it
   * plays. The command is the one handed out this session, else the one the
   * device's catalogue kept (`kept`), else -- once -- the portal's list. An
   * episode's id carries what is needed with the show's seasons.
   */
  async playbackUrl(type: StreamType, id: string, kept: () => Promise<Stream[]>): Promise<string> {
    await this.connected();
    if (type === 'series') {
      const showId = /^portal:([^:]*):/.exec(id)?.[1];
      const found = showId ? episodeCommand(id, await this.seasonsOf(showId)) : null;
      if (!found) {
        throw new Error('That episode is no longer on the portal');
      }
      return this.portal.link('series', found.cmd, found.episode);
    }
    const key = `${type}:${id}`;
    let cmd = this.commands.get(key);
    if (!cmd) {
      this.remembered((await kept()).filter(stream => stream.portal_cmd).map(stream => ({ ...stream, type })));
      cmd = this.commands.get(key);
    }
    if (!cmd) {
      await this.getStreams(type);
      cmd = this.commands.get(key);
    }
    if (!cmd) {
      throw new Error('That is no longer on the portal');
    }
    return this.portal.link(type === 'live' ? 'itv' : 'vod', cmd);
  }

  private seasonsOf(showId: string): Promise<StalkerSeason[]> {
    let seasons = this.seasonsKept.get(showId);
    if (!seasons) {
      seasons = this.portal.seasons(showId);
      this.seasonsKept.set(showId, seasons);
      seasons.catch(() => this.seasonsKept.delete(showId));
    }
    return seasons;
  }

  /** A show's seasons and episodes, in the shape a show's page reads from an Xtream provider. */
  async seriesInfo(show: Stream): Promise<SeriesInfo> {
    await this.connected();
    return seriesInfoFrom(show, await this.seasonsOf(String(show.stream_id)));
  }
}

function channelStream(channel: StalkerChannel): Stream {
  return {
    stream_id: channel.id,
    name: channel.name,
    icon: channel.logo,
    stream_icon: channel.logo,
    type: 'live',
    stream_type: 'live',
    category_id: channel.genreId,
    epg_channel_id: channel.xmltvId,
    num: channel.number || null,
    // A portal says hours; Xtream, and the rest of the app, days.
    tv_archive: channel.archiveHours > 0 ? 1 : 0,
    tv_archive_duration: channel.archiveHours > 0 ? Math.ceil(channel.archiveHours / 24) : 0,
    portal_cmd: channel.cmd
  };
}

function itemStream(item: StalkerItem, type: StreamType, categoryId: string): Stream {
  return {
    stream_id: item.id,
    name: item.name,
    icon: item.poster,
    stream_icon: item.poster,
    type,
    stream_type: type === 'vod' ? 'movie' : 'series',
    category_id: item.categoryId || categoryId,
    added: item.added,
    portal_cmd: item.cmd
  };
}

/**
 * An episode's id carries its show, season and number, so playing it needs
 * nothing kept elsewhere: the season's cmd and the episode's number are what
 * create_link asks for (`episodeCommand`).
 */
export function episodeId(showId: string, season: StalkerSeason, episode: number): string {
  return `portal:${showId}:${season.id}:${episode}`;
}

/** What create_link needs for an episode, from its id and the show's seasons; null when it is not one. */
export function episodeCommand(id: string, seasons: StalkerSeason[]): { cmd: string; episode: number } | null {
  const found = /^portal:[^:]*:(.+):(\d+)$/.exec(id);
  const season = found ? seasons.find(one => one.id === found[1]) : undefined;
  return season && found ? { cmd: season.cmd, episode: Number(found[2]) } : null;
}

export function seriesInfoFrom(show: Stream, seasons: StalkerSeason[]): SeriesInfo {
  const episodes: Record<string, Episode[]> = {};
  seasons.forEach((season, index) => {
    const number = Number(/(\d+)\s*$/.exec(season.name)?.[1]) || index + 1;
    episodes[String(number)] = season.episodes.map(episode => ({
      id: episodeId(String(show.stream_id), season, episode),
      episode_num: episode,
      title: `${season.name} · ${episode}`,
      container_extension: 'ts',
      info: { video: { duration: '' }, movie_image: show.stream_icon },
      season: number
    }));
  });
  return {
    id: String(show.stream_id),
    name: show.name,
    plot: '',
    cast: '',
    director: '',
    genre: '',
    releaseDate: '',
    last_modified: '',
    rating: 0,
    rating_5based: 0,
    backdrop_path: [],
    youtube_trailer: '',
    episode_run_time: '',
    category_id: show.category_id ?? '',
    episodes
  };
}
