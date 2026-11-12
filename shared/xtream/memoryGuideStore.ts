import {
  ChannelRef,
  GuideChannel,
  GuideHit,
  GuideLoadSummary,
  GuideProgramme,
  GuideStore,
  GuideTotals,
  KnownChannel
} from './guide';
import { titleMatches } from './guideSearch';
import { whenRunningOut } from './guideReload';

/**
 * A guide that lasts as long as the window does.
 *
 * The desktop's counterpart to MemoryCatalogueStore, and for the same reason:
 * the plugin that would give Electron a database wants a native module rebuilt
 * against Electron's own ABI, which is a great deal of machinery for something
 * that can be fetched again.
 *
 * The cost is different here, though, and worth being honest about. A
 * catalogue refills one category at a time as you browse; a guide is one large
 * download, so losing it on exit means paying for the whole thing at the next
 * launch. Acceptable because the desktop is on a real connection, and because
 * a guide is loaded when asked for rather than on startup -- but it is the
 * reason a file-backed store on the desktop is worth doing later.
 *
 * It lives in shared rather than beside the other desktop adapters because
 * none of it is desktop-specific, and because the window query below is real
 * logic that ought to be tested rather than merely written.
 */
export class MemoryGuideStore implements GuideStore {
  private readonly channelsBySource = new Map<string, GuideChannel[]>();
  private readonly programmesBySource = new Map<string, GuideProgramme[]>();
  private readonly loadedAt = new Map<string, string>();
  private readonly summaries = new Map<string, GuideLoadSummary>();

  /** A load in progress, held apart until it finishes. */
  private readonly incoming = new Map<
    string,
    { channels: GuideChannel[]; programmes: GuideProgramme[] }
  >();

  /**
   * Starts collecting a new copy beside the current one.
   *
   * The current copy stays exactly as readable as it was: a reload that fails
   * must leave the guide it was replacing, not an empty source.
   */
  async beginLoad(sourceId: string): Promise<void> {
    this.incoming.set(sourceId, { channels: [], programmes: [] });
  }

  async writeChannels(sourceId: string, channels: GuideChannel[]): Promise<void> {
    this.pending(sourceId).channels.push(...channels);
  }

  async writeProgrammes(sourceId: string, programmes: GuideProgramme[]): Promise<void> {
    this.pending(sourceId).programmes.push(...programmes);
  }

  async finishLoad(sourceId: string, at: string, totals?: GuideTotals): Promise<void> {
    const arrived = this.pending(sourceId);
    this.incoming.delete(sourceId);
    this.channelsBySource.set(sourceId, arrived.channels);
    this.programmesBySource.set(sourceId, arrived.programmes);
    this.loadedAt.set(sourceId, at);
    this.summaries.set(sourceId, {
      loadedAt: at,
      channels: totals?.channels ?? (this.channelsBySource.get(sourceId)?.length ?? 0),
      programmes: totals?.programmes ?? (this.programmesBySource.get(sourceId)?.length ?? 0)
    });
  }

  /** Writes with no beginLoad before them still land somewhere. */
  private pending(sourceId: string) {
    let found = this.incoming.get(sourceId);
    if (!found) {
      found = { channels: [], programmes: [] };
      this.incoming.set(sourceId, found);
    }
    return found;
  }

  async lastLoadedAt(sourceId: string): Promise<string | null> {
    return this.loadedAt.get(sourceId) ?? null;
  }

  async loadSummary(sourceId: string): Promise<GuideLoadSummary | null> {
    return this.summaries.get(sourceId) ?? null;
  }

  async runsOutAt(sourceId: string): Promise<number | null> {
    const last = new Map<string, number>();
    for (const programme of this.programmesBySource.get(sourceId) ?? []) {
      last.set(programme.channel, Math.max(last.get(programme.channel) ?? -Infinity, programme.stop));
    }
    const loaded = Date.parse(this.loadedAt.get(sourceId) ?? '');
    return whenRunningOut([...last.values()], Number.isFinite(loaded) ? loaded : null);
  }

  async channels(sourceId: string): Promise<GuideChannel[]> {
    return this.channelsBySource.get(sourceId) ?? [];
  }

  /**
   * Every channel from every finished load.
   *
   * The same channel appearing in two sources is kept twice, deliberately.
   * Choosing between them is the point once there is more than one guide, and
   * collapsing them here would take the choice away.
   */
  async allChannels(): Promise<KnownChannel[]> {
    const found: KnownChannel[] = [];

    for (const [sourceId, channels] of this.channelsBySource) {
      if (!this.loadedAt.has(sourceId)) {
        continue;
      }
      for (const channel of channels) {
        found.push({ ...channel, sourceId });
      }
    }

    return found;
  }

  /**
   * Programmes overlapping the window, across every loaded source.
   *
   * Overlapping rather than contained within: the programme on now started
   * before the window did, and asking for what is on at this moment would
   * otherwise return nothing at all. That is the mistake this query exists to
   * not make.
   */
  async programmesFor(refs: ChannelRef[], from: number, to: number): Promise<GuideProgramme[]> {
    // Grouped by source, because a channel id means nothing without one: two
    // guides describing the same channel use the same id for it.
    const wantedBySource = new Map<string, Set<string>>();
    for (const ref of refs) {
      const existing = wantedBySource.get(ref.sourceId);
      if (existing) {
        existing.add(ref.channelId);
      } else {
        wantedBySource.set(ref.sourceId, new Set([ref.channelId]));
      }
    }

    const found: GuideProgramme[] = [];

    for (const [sourceId, wanted] of wantedBySource) {
      if (!this.loadedAt.has(sourceId)) {
        continue;
      }

      for (const programme of this.programmesBySource.get(sourceId) ?? []) {
        if (wanted.has(programme.channel) && programme.start < to && programme.stop > from) {
          found.push(programme);
        }
      }
    }

    return found.sort((left, right) => left.start - right.start);
  }

  async searchProgrammes(query: string, from: number, to: number, limit: number): Promise<GuideHit[]> {
    const found: GuideHit[] = [];
    for (const [sourceId, programmes] of this.programmesBySource) {
      if (!this.loadedAt.has(sourceId)) {
        continue;
      }
      for (const programme of programmes) {
        if (programme.start < to && programme.stop > from && titleMatches(programme.title, query)) {
          found.push({ ...programme, sourceId });
        }
      }
    }
    return found.sort((left, right) => left.start - right.start).slice(0, limit);
  }

  async prune(before: number): Promise<void> {
    for (const [sourceId, programmes] of this.programmesBySource) {
      this.programmesBySource.set(
        sourceId,
        programmes.filter(programme => programme.stop >= before)
      );
    }
  }

  /** Throws the lot away, for a sign-out or a change of subscription. */
  async forget(): Promise<void> {
    this.channelsBySource.clear();
    this.programmesBySource.clear();
    this.loadedAt.clear();
    this.summaries.clear();
  }
}

