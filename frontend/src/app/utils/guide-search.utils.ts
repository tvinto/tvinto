import { Stream } from '@shared/types';
import { GuideHit } from '@shared/xtream/guide';
import { MatchedChannel, normaliseChannelId } from '@shared/xtream/guideMatching';

/**
 * Guide search: programmes found by title, each
 * put on a channel that can be watched here. Plain functions, so the rules
 * can be tested without a guide or a page.
 */

/** As many as a results row is worth. */
export const GUIDE_SEARCH_LIMIT = 40;

/** How far ahead to look: a week of guide and a day to spare. */
export const GUIDE_SEARCH_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;

/** A programme found, on the channel it can be watched on. */
export interface GuideFind {
  title: string;
  description: string;
  start: number;
  stop: number;
  stream: Stream;
  onNow: boolean;
}

/**
 * The hits on channels here, once each: on now first, then soonest.
 *
 * A guide channel can be several streams -- HD, SD, a RAW copy -- and the
 * programme is offered once, on the first of them. Two guides describing one
 * channel give the same programme twice; once is enough. A hit on a channel
 * nothing here matches has nowhere to be watched and is left out.
 */
export function linkGuideHits(
  hits: readonly GuideHit[],
  streamsByChannel: ReadonlyMap<string, MatchedChannel>,
  streamsById: ReadonlyMap<string, Stream>,
  now: number,
  limit = GUIDE_SEARCH_LIMIT
): GuideFind[] {
  // Compared in the normalised form, as the guide timeline does: the map is
  // keyed by the ids as one guide spells them, and the other may differ in case.
  const byChannel = new Map<string, string[]>();
  for (const [channel, matched] of streamsByChannel) {
    byChannel.set(normaliseChannelId(channel), matched.streamIds);
  }

  const seen = new Set<string>();
  const found: GuideFind[] = [];
  for (const hit of hits) {
    if (hit.stop <= now) {
      continue;
    }
    const stream = (byChannel.get(normaliseChannelId(hit.channel)) ?? [])
      .map(id => streamsById.get(id))
      .find((candidate): candidate is Stream => !!candidate);
    if (!stream) {
      continue;
    }
    const key = `${stream.stream_id}@${hit.start}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    found.push({
      title: hit.title,
      description: hit.description,
      start: hit.start,
      stop: hit.stop,
      stream,
      onNow: hit.start <= now
    });
  }

  return found
    .sort((left, right) => Number(right.onNow) - Number(left.onNow) || left.start - right.start)
    .slice(0, limit);
}
