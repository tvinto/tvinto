import { KnownChannel } from './guide';
import { looseChannelId, normaliseChannelId } from './guideMatching';
import { nameWords } from './channelNames';

export { nameWords } from './channelNames';

/**
 * Offering the guide channels a stream is probably described by.
 *
 * For the case automatic matching cannot reach: a provider that fills in no
 * `epg_channel_id` at all, or fills in one no feed has ever heard of. Nearly
 * half a real line-up is in that state, so it is not an edge.
 *
 * What is left to go on is the name, which is written for people rather than
 * for matching: "HR| DOMA HD" against "Doma TV HD". So the comparison strips
 * what a person would ignore -- the country tag the provider prefixes, the
 * quality, punctuation -- and scores what remains.
 *
 * Ranked rather than decided. Suggestions are shown to someone who knows which
 * channel they meant, and being confidently wrong would be worse than being
 * usefully approximate.
 */

export interface ChannelSuggestion {
  channel: KnownChannel;
  /** 0 to 1. Only useful for ordering; the numbers have no meaning of their own. */
  score: number;
  /** Why it was offered, so a screen can say. */
  because: 'id' | 'name' | 'contains';
}

export interface SuggestOptions {
  /** How many to return. */
  limit?: number;
  /** Only consider channels from these sources. */
  sourceIds?: readonly string[];
  /** Free text from a search box, matched against name and id. */
  search?: string;

  /**
   * The weakest suggestion worth offering.
   *
   * Below about a third, a match is usually one incidental word in common --
   * "HR RADIO DUBROVNIK" and "Nick Jr HR" share only the country. Offering
   * those buries the real suggestions and teaches people to ignore the list.
   *
   * A search overrides it: someone typing a name has said what they want.
   */
  minScore?: number;
}

/**
 * The same search, with the parts no guide could ever contain taken out.
 *
 * Scoring a channel already ignores all of this -- `nameWords` throws
 * away the country tag and the noise words. Searching does not: it is a plain
 * substring test against the guide's own names, because someone typing has
 * asked for something particular and second-guessing them is worse than
 * finding nothing.
 *
 * The trouble is that the obvious thing to type is the channel's name as it
 * appears on screen, and this provider writes that as `HR| Sport Nord ⱽᴵᴾ ᴿᴬᵂ`.
 * The suffixes are Unicode modifier letters, the tag is a packaging label, and
 * no guide in the world carries either -- so the search that a person is most
 * likely to run is the one search that cannot possibly match. They are then
 * looking at "no guide channel matches" for a channel whose guide is sitting
 * in the list.
 *
 * This is what to offer them instead. Empty when there is nothing to repair,
 * so the caller can tell a fixable dead end from a real one.
 */
export const searchWithoutProviderNoise = (search: string): string => {
  const words = nameWords(search.replace(/\p{Lm}+/gu, ' '));
  const repaired = words.join(' ');

  return repaired && repaired !== search.trim().toLowerCase() ? repaired : '';
};

/** Dice's coefficient over two word sets: twice the overlap, over the total. */
const overlap = (left: string[], right: string[]): number => {
  if (!left.length || !right.length) {
    return 0;
  }

  const rightWords = new Set(right);
  let shared = 0;
  for (const word of new Set(left)) {
    if (rightWords.has(word)) {
      shared += 1;
    }
  }

  return (2 * shared) / (new Set(left).size + rightWords.size);
};

/** Whether every word of the shorter name appears in the longer. */
const isSubsetOf = (inner: string[], outer: string[]): boolean => {
  if (!inner.length) {
    return false;
  }
  const outerWords = new Set(outer);
  return inner.every(word => outerWords.has(word));
};

/**
 * Scores one guide channel against a stream.
 *
 * The order of the tests is the order of confidence: an id that agrees is not
 * a guess at all, an id that agrees once loosened is nearly as good, and after
 * that it is names, which is where judgement starts.
 */
const scoreAgainst = (
  streamName: string,
  streamChannelId: string | undefined,
  channel: KnownChannel
): { score: number; because: ChannelSuggestion['because'] } | null => {
  const wantedId = normaliseChannelId(streamChannelId);

  if (wantedId) {
    if (wantedId === normaliseChannelId(channel.id)) {
      return { score: 1, because: 'id' };
    }
    if (looseChannelId(wantedId) === looseChannelId(channel.id)) {
      return { score: 0.95, because: 'id' };
    }
  }

  const streamWords = nameWords(streamName);
  const channelWords = nameWords(channel.name);

  if (!streamWords.length || !channelWords.length) {
    return null;
  }

  if (streamWords.join(' ') === channelWords.join(' ')) {
    return { score: 0.9, because: 'name' };
  }

  // "Doma" inside "Doma TV Plus": everything the shorter name says, the longer
  // one says too. Scaled by how much else the longer one adds, so the closest
  // fit comes first.
  if (isSubsetOf(streamWords, channelWords) || isSubsetOf(channelWords, streamWords)) {
    const shorter = Math.min(streamWords.length, channelWords.length);
    const longer = Math.max(streamWords.length, channelWords.length);
    return { score: 0.6 + 0.25 * (shorter / longer), because: 'contains' };
  }

  const shared = overlap(streamWords, channelWords);
  return shared > 0 ? { score: shared * 0.6, because: 'name' } : null;
};

/**
 * The guide channels most likely to describe this stream, best first.
 *
 * The country hint is worth more than it looks. A line-up carries the same
 * channel names from a dozen countries, and a stream tagged `HR|` beside a
 * guide id ending `.hr` agree about something real.
 */
export const suggestGuideChannels = (
  stream: { name: string; epg_channel_id?: string },
  channels: readonly KnownChannel[],
  options: SuggestOptions = {}
): ChannelSuggestion[] => {
  const limit = options.limit ?? 20;
  const allowed = options.sourceIds?.length ? new Set(options.sourceIds) : null;
  const search = (options.search ?? '').trim().toLowerCase();
  const minScore = search ? 0 : options.minScore ?? 0.3;

  const countryTag = /^\s*([a-z]{2,3})\s*[|:-]/i.exec(stream.name)?.[1]?.toLowerCase();

  const scored: ChannelSuggestion[] = [];

  for (const channel of channels) {
    if (allowed && !allowed.has(channel.sourceId)) {
      continue;
    }

    // A search narrows what is offered rather than reordering it: someone
    // typing has a particular channel in mind.
    if (
      search &&
      !channel.name.toLowerCase().includes(search) &&
      !channel.id.toLowerCase().includes(search)
    ) {
      continue;
    }

    const judged = scoreAgainst(stream.name, stream.epg_channel_id, channel);
    if (!judged) {
      // With a search running, anything matching the text is worth offering
      // even when the name says nothing -- the person is telling us directly.
      if (search) {
        scored.push({ channel, score: 0.1, because: 'contains' });
      }
      continue;
    }

    // An id match is left exactly as scored. The country bonus is a tie-break
    // between names, and letting it reach an id lifted a loosened one level
    // with an exact one -- which then lost on alphabet.
    if (judged.because === 'id') {
      scored.push({ channel, score: judged.score, because: judged.because });
      continue;
    }

    const sameCountry = countryTag && normaliseChannelId(channel.id).endsWith(`.${countryTag}`);
    // Held below the weakest id match, so no name ever outranks an id.
    const score = Math.min(0.94, judged.score + (sameCountry ? 0.05 : 0));

    if (score >= minScore) {
      scored.push({ channel, score, because: judged.because });
    }
  }

  return scored
    .sort((left, right) => right.score - left.score || left.channel.name.localeCompare(right.channel.name))
    .slice(0, limit);
};
