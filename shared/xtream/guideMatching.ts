import { ChannelRef, GuideProgramme, KnownChannel } from './guide';
import { channelCountry, nameWords, streamCountry } from './channelNames';

/**
 * Joining what the provider sells to what the guide describes.
 *
 * A guide names channels by XMLTV's own ids and a provider names them by
 * stream id, and the only thing connecting the two is `epg_channel_id` on the
 * stream. Where a provider fills that in honestly this is the whole of the
 * problem; where it does not, it is the half that can be done automatically,
 * and matching a channel to a guide by hand is the other half.
 *
 * Kept apart from the service that uses it because it is the part with
 * decisions in it, and because the manual mapping will be layered on top of
 * exactly this.
 */

/** The fields of a stream this needs, so callers need not bring the whole type. */
export interface MatchableStream {
  stream_id: string | number;
  epg_channel_id?: string;
  /** Only consulted when the id matches nothing. See `resolveGuideChannelByName`. */
  name?: string;
}

/**
 * Which streams each guide channel speaks for.
 *
 * One to many, deliberately. The same broadcaster sold in two qualities is two
 * streams carrying one `epg_channel_id`, and both should show the programme.
 *
 * Matching ignores case and surrounding space. Providers are inconsistent
 * about both, and `HRT1.hr` failing to match `hrt1.hr` would be a guide that
 * is mysteriously missing rather than one that is absent.
 */
export interface MatchedChannel {
  /** The guide and the channel within it, which is what the store is asked for. */
  ref: ChannelRef;
  streamIds: string[];
}

export const streamsByGuideChannel = (
  streams: readonly MatchableStream[],
  index: GuideChannelIndex
): Map<string, MatchedChannel> => {
  const byChannel = new Map<string, MatchedChannel>();

  for (const stream of streams) {
    const channel = resolveGuideChannel(index, stream.epg_channel_id, stream.name);
    if (!channel) {
      continue;
    }

    // Keyed by the guide's id exactly as the guide writes it, because that is
    // what the store holds programmes under and what comes back on them.
    // Normalising the key would produce one nothing can be looked up by.
    const existing = byChannel.get(channel.id);
    if (existing) {
      existing.streamIds.push(String(stream.stream_id));
    } else {
      byChannel.set(channel.id, {
        ref: { sourceId: channel.sourceId, channelId: channel.id },
        streamIds: [String(stream.stream_id)]
      });
    }
  }

  return byChannel;
};

/** The form channel ids are compared in. */
export const normaliseChannelId = (value: string | undefined | null): string =>
  (value ?? '').trim().toLowerCase();

/**
 * Words that describe the picture rather than the channel.
 *
 * A feed and a provider routinely disagree about whether the quality belongs
 * in the id -- `Htv1.hr` against `HTV1.HD.hr` is the same channel written two
 * ways -- and that disagreement alone is enough to match nothing.
 */
const QUALITY_WORDS = new Set(['hd', 'fhd', 'uhd', 'sd', '4k', 'hq']);

/**
 * A looser form, for when the exact ids do not agree.
 *
 * Splits on anything that is not a letter or a digit, drops the words above,
 * and joins what is left with nothing between. So `Htv1.hr`, `HTV1.HD.hr` and
 * `htv 1 hr` all become `htv1hr`, while two genuinely different channels stay
 * different.
 *
 * Joining rather than keeping separators is what makes `DomaTv.hr` meet
 * `Doma.TV.HD.hr`: the two disagree about where the words divide as well as
 * about the quality.
 *
 * A quality word is only dropped when at least two words survive it. `HD.hr`
 * is a channel called HD in Croatia, not Croatia -- reducing it to `hr` would
 * have it answer for whatever else reduced to that, and every real pairing
 * this is for keeps two words anyway: `HTV1.HD.hr` still has `htv1` and `hr`.
 */
export const looseChannelId = (value: string | undefined | null): string => {
  const normalised = normaliseChannelId(value);
  if (!normalised) {
    return '';
  }

  const words = normalised.split(/[^a-z0-9]+/).filter(Boolean);
  const kept = words.filter(word => !QUALITY_WORDS.has(word));

  return (kept.length >= 2 ? kept : words).join('');
};

/**
 * The feed's channels, indexed both ways.
 *
 * Built once per read rather than per stream, because a provider line-up runs
 * to tens of thousands of channels and this is asked about every one of them.
 */
export interface GuideChannelIndex {
  /** Normalised id to the channel, in whichever guide answered first. */
  exact: Map<string, KnownChannel>;
  /**
   * Loose id to the channel, and **only where exactly one reduces to it**.
   *
   * Where two do, the loose form cannot tell them apart, and attaching one
   * channel's schedule to another is worse than showing none: a guide that is
   * absent is obviously absent, and a guide that is wrong is believed.
   */
  loose: Map<string, KnownChannel>;
  /**
   * A channel's name reduced to its identifying words, to every guide channel
   * that reduces to it. A list, not a single answer: several countries sell a
   * channel called Sport 1, and choosing between them is the resolver's job.
   */
  byName: Map<string, KnownChannel[]>;
  /** Loose id to every channel that reduces to it, ambiguous or not. */
  byLoose: Map<string, KnownChannel[]>;
}

/**
 * Indexes the guide channels, keeping which source each came from.
 *
 * The source travels with the answer because a channel id means nothing
 * without one. Two guides describing the same channel use the same id, and
 * asking both for its programmes puts two schedules on one row.
 *
 * Where several guides describe a channel, the first wins and the rest are
 * ignored. Which is arbitrary, and is exactly why the picker exists: an
 * arbitrary choice a person can change beats a merged one they cannot.
 */
export const indexGuideChannels = (guideChannels: readonly KnownChannel[]): GuideChannelIndex => {
  const exact = new Map<string, KnownChannel>();
  const looseCounts = new Map<string, KnownChannel[]>();
  const byName = new Map<string, KnownChannel[]>();

  for (const channel of guideChannels) {
    const nameKey = nameWords(channel.name ?? '').join(' ');
    if (nameKey) {
      const named = byName.get(nameKey);
      if (named) {
        named.push(channel);
      } else {
        byName.set(nameKey, [channel]);
      }
    }

    const normalised = normaliseChannelId(channel.id);
    if (!normalised) {
      continue;
    }

    if (!exact.has(normalised)) {
      exact.set(normalised, channel);
    }

    const loose = looseChannelId(channel.id);
    if (loose) {
      const existing = looseCounts.get(loose);
      if (existing) {
        existing.push(channel);
      } else {
        looseCounts.set(loose, [channel]);
      }
    }
  }

  const loose = new Map<string, KnownChannel>();
  for (const [key, channels] of looseCounts) {
    // Several entries for one loose key are only ambiguous when they are
    // different channels. The same channel offered by two guides is not a
    // reason to refuse -- it is a reason to pick one.
    const distinct = new Set(channels.map(channel => normaliseChannelId(channel.id)));
    if (distinct.size === 1) {
      loose.set(key, channels[0]);
    }
  }

  return { exact, loose, byName, byLoose: looseCounts };
};

/**
 * Which feed channel a stream's id refers to, or null.
 *
 * Exact first, always. The looser form is a guess, and a good one, but it is
 * still a guess -- so it is only reached when the ids genuinely do not agree.
 */
export const resolveGuideChannel = (
  index: GuideChannelIndex,
  epgChannelId: string | undefined | null,
  streamName?: string | null
): KnownChannel | null => {
  const normalised = normaliseChannelId(epgChannelId);
  const byId = normalised
    ? index.exact.get(normalised) ?? index.loose.get(looseChannelId(normalised)) ?? null
    : null;

  return byId ?? resolveGuideChannelByName(index, streamName);
};

/**
 * The guide channel a stream's name identifies, when exactly one does.
 *
 * Reached only when the id matched nothing, which on this provider is most of
 * the line-up: a stream arrives with no `epg_channel_id` at all, or one no feed
 * has heard of, while the provider's own guide lists the very same channel by
 * name. Ids alone left every row of a Croatian category reading "No guide --
 * choose a channel" beside a guide that held HRT 2 the whole time.
 *
 * It decides without asking anyone, so it is strict where the picker is
 * generous. The picker ranks likely candidates for a person who knows which
 * channel they meant; this attaches a schedule that will be believed. A guide
 * that is absent is obviously absent, and a guide that is wrong is watched.
 * So, in order:
 *
 * - **The names must be the same**, once each is reduced to the words that
 *   identify a channel -- the country tag, quality words and the provider's
 *   superscript marks gone. Containing is not enough: "Sport" is inside
 *   "Sport Klub 2", and the picker is where that gets judged.
 * - **The countries must not disagree.** A guide id ending in a different
 *   country code is a different channel with the same name -- RTL 2 in Croatia
 *   is not RTL II in Germany. An id with no country code is not a disagreement.
 * - **Where some candidates agree on country, only those count.**
 * - **Exactly one channel may remain.** Two different ids still standing is a
 *   coin toss, and this does not toss coins. Ids that agree once loosened --
 *   the same channel as two guides spell it -- are one channel, and the first
 *   wins, as it does for ids.
 * - **A name must say something.** One made only of digits -- "24/7 24" -- is
 *   not a name anyone could match by.
 */
/**
 * The country a guide channel belongs to, from its id or failing that its name.
 *
 * The name as a fallback because the provider's own guide writes the country
 * where it writes it for streams: `PL| E! ENTERTAINMENT FHD`, under an id that
 * names no country at all. Reading only the id let that Polish schedule attach
 * itself to a Croatian E! -- found by checking every name match on a real line-up,
 * which is the only reason it did not ship.
 */
/**
 * The same channel as described by other guides.
 *
 * Two guides on one device routinely describe one channel, and describe it
 * unevenly: on a real pair, the provider's guide listed HBO, HBO 2, HBO 3,
 * Nick Jr, Doku TV and more with no programmes at all, while epgshare carried
 * the same channels with a full evening. The row matched the provider's copy
 * first and drew nothing.
 *
 * A twin agrees once ids are loosened -- `HBO.hr` and `HBO.HD.hr` -- or has the
 * same identifying name with no disagreement about country. The channel itself
 * is never its own twin. Which twin to use is `chooseTwin`'s decision.
 */
export const guideTwins = (index: GuideChannelIndex, channel: KnownChannel): KnownChannel[] => {
  const isSelf = (other: KnownChannel) =>
    other.sourceId === channel.sourceId &&
    normaliseChannelId(other.id) === normaliseChannelId(channel.id);

  const found = new Map<string, KnownChannel>();
  const add = (other: KnownChannel) => {
    if (!isSelf(other)) {
      found.set(`${other.sourceId}|${normaliseChannelId(other.id)}`, other);
    }
  };

  const looseKey = looseChannelId(channel.id);
  for (const other of looseKey ? index.byLoose.get(looseKey) ?? [] : []) {
    add(other);
  }

  const nameKey = nameWords(channel.name ?? '').join(' ');
  if (nameKey && nameWords(channel.name ?? '').some(word => /[a-z]/.test(word))) {
    const mine = guideChannelCountry(channel);
    for (const other of index.byName.get(nameKey) ?? []) {
      const theirs = guideChannelCountry(other);
      if (!mine || !theirs || mine === theirs) {
        add(other);
      }
    }
  }

  return [...found.values()];
};

/**
 * The one twin to draw from, or null.
 *
 * Only twins that actually have programmes count, and exactly one channel may
 * remain once their ids are loosened -- the same refusal as matching by name.
 * On the real pair that fills the three HBOs and declines Nova TV, whose three
 * candidates (NovaTv.hr, Nova.TV.HD.hr, TV.Nova.hr) are very probably one
 * channel and are not provably so.
 */
export const chooseTwin = (
  twins: readonly KnownChannel[],
  hasProgrammes: (channel: KnownChannel) => boolean
): KnownChannel | null => {
  const useful = twins.filter(hasProgrammes);
  const distinct = new Set(
    useful.map(channel => looseChannelId(channel.id) || normaliseChannelId(channel.id))
  );
  return distinct.size === 1 ? useful[0] : null;
};

const guideChannelCountry = (channel: KnownChannel): string | null =>
  channelCountry(channel.id) ?? streamCountry(channel.name);

export const resolveGuideChannelByName = (
  index: GuideChannelIndex,
  streamName: string | undefined | null
): KnownChannel | null => {
  const words = nameWords(streamName ?? '');
  if (!words.some(word => /[a-z]/.test(word))) {
    return null;
  }

  const candidates = index.byName.get(words.join(' '));
  if (!candidates?.length) {
    return null;
  }

  const country = streamCountry(streamName);
  const notDisagreeing = country
    ? candidates.filter(channel => {
        const theirs = guideChannelCountry(channel);
        return !theirs || theirs === country;
      })
    : candidates;

  const agreeing = country
    ? notDisagreeing.filter(channel => guideChannelCountry(channel) === country)
    : [];
  const pool = agreeing.length ? agreeing : notDisagreeing;

  // Distinct by the loose id, not the exact one. Two guides describing the same
  // channel routinely spell its id differently -- RtlCrime.hr from the
  // provider, RTL.Crime.hr from epgshare -- and counting those as two channels
  // refused every channel that both guides carried, which on the real pair was
  // most of the ones worth having. The loose form is the one ids are already
  // trusted to agree in.
  const distinct = new Set(
    pool.map(channel => looseChannelId(channel.id) || normaliseChannelId(channel.id))
  );
  return distinct.size === 1 ? pool[0] : null;
};

/**
 * Spreads programmes across the streams their channel speaks for.
 *
 * Returns a plain record keyed by stream id, which is the shape the guide
 * timeline already reads. Programmes on channels nothing matches are dropped
 * rather than kept under their own id: a guide row exists for a stream or it
 * does not, and a channel with no stream has nowhere to be drawn.
 */
export const programmesByStream = (
  programmes: readonly GuideProgramme[],
  streamsByChannel: Map<string, MatchedChannel>
): Record<string, GuideProgramme[]> => {
  const byStream: Record<string, GuideProgramme[]> = {};

  // Compared in the normalised form, while the map itself is keyed as the
  // guide writes its ids. Doing it here rather than at the key means the map
  // stays usable for asking the store, which knows only its own spelling.
  const byNormalised = new Map<string, string[]>();
  for (const [channel, matched] of streamsByChannel) {
    byNormalised.set(normaliseChannelId(channel), matched.streamIds);
  }

  for (const programme of programmes) {
    const streamIds = byNormalised.get(normaliseChannelId(programme.channel));
    if (!streamIds) {
      continue;
    }

    for (const streamId of streamIds) {
      (byStream[streamId] ??= []).push(programme);
    }
  }

  return byStream;
};

/**
 * How many of these streams a guide could say anything about.
 *
 * The number worth showing a person who has just added a source: "matched 412
 * of 830 channels" is the difference between a guide that works and one that
 * needs its channels mapping by hand, and it is not otherwise visible --
 * without it, an unmatched channel looks exactly like one the guide has
 * nothing scheduled for.
 */
export const countMatched = (
  streams: readonly MatchableStream[],
  guideChannels: readonly KnownChannel[]
): { matched: number; unmatched: number; loosely: number } => {
  const index = indexGuideChannels(guideChannels);
  let matched = 0;
  let loosely = 0;

  for (const stream of streams) {
    const normalised = normaliseChannelId(stream.epg_channel_id);
    if (!normalised) {
      continue;
    }

    if (index.exact.has(normalised)) {
      matched += 1;
    } else if (index.loose.has(looseChannelId(normalised))) {
      matched += 1;
      loosely += 1;
    }
  }

  return { matched, unmatched: streams.length - matched, loosely };
};

/**
 * What a stream must have to resolve to one of these guide channels, as SQL
 * can test it, so a guide search reads those streams and not the whole live
 * library: every channel's on a user's TV took 8-19 s to read, the plugin
 * carrying about 5 us a byte (27 November). A superset, since
 * `resolveGuideChannel` decides afterwards:
 *
 * - by id, an exact or loose match means the stream's loose id is the
 *   channel's (`looseIds`; `looseIdSql` reads a stream's);
 * - by name, every one of the channel's name words is in the stream's
 *   lower-cased name (`names`, for a LIKE each).
 */
export const guideCandidates = (channels: readonly KnownChannel[]): { looseIds: string[]; names: string[][] } => {
  const looseIds = new Set<string>();
  const names = new Map<string, string[]>();
  for (const channel of channels) {
    const loose = looseChannelId(channel.id);
    if (loose) {
      looseIds.add(loose);
    }
    const words = nameWords(channel.name ?? '');
    if (words.some(word => /[a-z]/.test(word))) {
      names.set(words.join(' '), words);
    }
  }
  return { looseIds: [...looseIds], names: [...names.values()] };
};

/** What `looseChannelId` splits ids on, as far as SQL is told. */
const ID_SEPARATORS = ['.', ' ', '-', '_', ':', '|', '/', '+', '(', ')', '&', "'", ',', '!', '[', ']', '#', '*', '@'];

/**
 * `looseChannelId` of a column, in SQL: both its forms, with the quality
 * words and without, as `looseChannelId` keeps them only when one word
 * would be left. A row's id is matched when either is in a list.
 *
 * shortcut: an id holding a separator not in ID_SEPARATORS (a letter
 * outside ASCII, say) reads as one word here; no guide id seen has one.
 */
export const looseIdSql = (column: string): { all: string; kept: string } => {
  const dotted = `'.' || ${ID_SEPARATORS.reduce(
    (sql, separator) => `REPLACE(${sql}, '${separator === "'" ? "''" : separator}', '.')`,
    `LOWER(TRIM(${column}))`
  )} || '.'`;
  // Twice, for two quality words side by side: REPLACE does not see the second.
  const unqualified = [...QUALITY_WORDS, ...QUALITY_WORDS].reduce((sql, word) => `REPLACE(${sql}, '.${word}.', '.')`, dotted);
  return { all: `REPLACE(${dotted}, '.', '')`, kept: `REPLACE(${unqualified}, '.', '')` };
};
