import Database from 'better-sqlite3';
import { GuideProgramme, KnownChannel } from './guide';
import {
  countMatched,
  indexGuideChannels,
  looseChannelId,
  looseIdSql,
  normaliseChannelId,
  programmesByStream,
  resolveGuideChannel,
  chooseTwin,
  guideTwins,
  resolveGuideChannelByName,
  streamsByGuideChannel
} from './guideMatching';

/**
 * Real ids, taken from a real line-up beside a real feed.
 *
 * The provider and the feed describe the same Croatian channels and agree on
 * none of them exactly: the feed writes the quality into the id and divides
 * the words differently. Sixteen of nearly ten thousand channels matched
 * before this pairing was handled.
 */
const REAL_PAIRS: Array<[provider: string, feed: string]> = [
  ['Htv1.hr', 'HTV1.HD.hr'],
  ['Htv2.hr', 'HTV2.HD.hr'],
  ['Htv3.hr', 'HTV3.HD.hr'],
  ['DomaTv.hr', 'Doma.TV.HD.hr']
];

const stream = (id: string | number, epg?: string) => ({ stream_id: id, epg_channel_id: epg });

/** A guide channel, which carries the guide it came from. */
const known = (id: string, sourceId = 'feed'): KnownChannel => ({ id, name: id, sourceId });

/** Indexes a list of ids, all from one guide. */
const indexOf = (ids: string[], sourceId = 'feed') =>
  indexGuideChannels(ids.map(id => known(id, sourceId)));

const programme = (channel: string, title: string): GuideProgramme => ({
  channel,
  start: 1,
  stop: 2,
  title,
  description: '',
  category: ''
});

describe('streamsByGuideChannel', () => {
  it('maps a channel to the stream that carries it', () => {
    const byChannel = streamsByGuideChannel([stream(101, 'hrt1.hr')], indexOf(['hrt1.hr']));

    expect(byChannel.get('hrt1.hr')?.streamIds).toEqual(['101']);
  });

  // The same broadcaster sold in two qualities is two streams and one channel,
  // and the guide belongs on both.
  it('maps one channel to every stream carrying it', () => {
    const byChannel = streamsByGuideChannel(
      [stream(101, 'hrt1.hr'), stream(102, 'hrt1.hr'), stream(103, 'hrt2.hr')],
      indexOf(['hrt1.hr', 'hrt2.hr'])
    );

    expect(byChannel.get('hrt1.hr')?.streamIds).toEqual(['101', '102']);
    expect(byChannel.get('hrt2.hr')?.streamIds).toEqual(['103']);
  });

  // Providers are inconsistent about both, and a case difference would be a
  // guide that is mysteriously missing rather than plainly absent.
  it('ignores case and surrounding space', () => {
    const byChannel = streamsByGuideChannel([stream(101, '  HRT1.HR  ')], indexOf(['hrt1.hr']));

    expect(byChannel.get('hrt1.hr')?.streamIds).toEqual(['101']);
  });

  it('skips streams with no channel id at all', () => {
    const byChannel = streamsByGuideChannel(
      [stream(101), stream(102, ''), stream(103, '   '), stream(104, 'hrt1.hr')],
      indexOf(['hrt1.hr'])
    );

    expect(byChannel.size).toBe(1);
    expect(byChannel.get('hrt1.hr')?.streamIds).toEqual(['104']);
  });

  it('accepts numeric stream ids and gives back strings', () => {
    const byChannel = streamsByGuideChannel([stream(101, 'a')], indexOf(['a']));

    expect(byChannel.get('a')?.streamIds).toEqual(['101']);
  });

  // Keyed as the guide writes it, because the key is what the store gets asked
  // for and the store knows only its own spelling.
  it('keys streams by the guide id exactly as the guide writes it', () => {
    const byChannel = streamsByGuideChannel([stream(101, 'Htv1.hr')], indexOf(['HTV1.HD.hr']));

    expect([...byChannel.keys()]).toEqual(['HTV1.HD.hr']);
  });

  it('gathers streams that resolve to one guide channel, however they spell it', () => {
    const byChannel = streamsByGuideChannel(
      [stream(101, 'Htv1.hr'), stream(102, 'HTV1.HD.hr'), stream(103, 'htv 1 hr')],
      indexOf(['HTV1.HD.hr'])
    );

    expect(byChannel.get('HTV1.HD.hr')?.streamIds).toEqual(['101', '102', '103']);
  });

  it('leaves out streams nothing in the guide resembles', () => {
    const byChannel = streamsByGuideChannel([stream(101, 'sky.sports.uk')], indexOf(['HTV1.HD.hr']));

    expect(byChannel.size).toBe(0);
  });

  /**
   * The pair, which is what a store needs.
   *
   * A channel id on its own means nothing once two guides are loaded: both use
   * the same id for the same channel, and asking by id alone brings back both
   * schedules and draws them over one another.
   */
  it('says which guide the channel came from, not only which channel', () => {
    const byChannel = streamsByGuideChannel(
      [stream(101, 'Htv1.hr')],
      indexOf(['HTV1.HD.hr'], 'epgshare')
    );

    expect(byChannel.get('HTV1.HD.hr')?.ref).toEqual({
      sourceId: 'epgshare',
      channelId: 'HTV1.HD.hr'
    });
  });
});

describe('programmesByStream', () => {
  it('puts a programme under the stream its channel speaks for', () => {
    const byChannel = streamsByGuideChannel([stream(101, 'hrt1.hr')], indexOf(['hrt1.hr']));
    const byStream = programmesByStream([programme('hrt1.hr', 'Dnevnik')], byChannel);

    expect(byStream['101'].map(p => p.title)).toEqual(['Dnevnik']);
  });

  it('puts it under every stream sharing the channel', () => {
    const byChannel = streamsByGuideChannel(
      [stream(101, 'hrt1.hr'), stream(102, 'hrt1.hr')],
      indexOf(['hrt1.hr'])
    );
    const byStream = programmesByStream([programme('hrt1.hr', 'Dnevnik')], byChannel);

    expect(byStream['101']).toHaveLength(1);
    expect(byStream['102']).toHaveLength(1);
  });

  it('matches regardless of case on either side', () => {
    const byChannel = streamsByGuideChannel([stream(101, 'hrt1.hr')], indexOf(['hrt1.hr']));
    const byStream = programmesByStream([programme('HRT1.HR', 'Dnevnik')], byChannel);

    expect(byStream['101']).toHaveLength(1);
  });

  // A channel nothing carries has nowhere to be drawn, so keeping it under its
  // own id would only put rows in a list that has no room for them.
  it('drops programmes for channels no stream carries', () => {
    const byChannel = streamsByGuideChannel([stream(101, 'hrt1.hr')], indexOf(['hrt1.hr']));
    const byStream = programmesByStream(
      [programme('hrt1.hr', 'Kept'), programme('sky.uk', 'Dropped')],
      byChannel
    );

    expect(Object.keys(byStream)).toEqual(['101']);
  });

  it('keeps several programmes for one stream, in the order given', () => {
    const byChannel = streamsByGuideChannel([stream(101, 'hrt1.hr')], indexOf(['hrt1.hr']));
    const byStream = programmesByStream(
      [programme('hrt1.hr', 'First'), programme('hrt1.hr', 'Second')],
      byChannel
    );

    expect(byStream['101'].map(p => p.title)).toEqual(['First', 'Second']);
  });

  it('finds programmes stored under the guide id', () => {
    const byChannel = streamsByGuideChannel([stream(101, 'Htv1.hr')], indexOf(['HTV1.HD.hr']));
    const byStream = programmesByStream([programme('HTV1.HD.hr', 'Dnevnik')], byChannel);

    expect(byStream['101'].map(p => p.title)).toEqual(['Dnevnik']);
  });

  /**
   * The round trip, which is where the keys can be wrong in a way that still
   * looks right. The refs go to a store that knows only exact ids; whatever
   * comes back is matched against the map. Keying by a normalised id passes
   * every test that does not do both halves, and finds nothing at all.
   */
  it('produces refs a store holding the guide ids will actually answer', () => {
    const guideChannels = ['HTV1.HD.hr', 'Doma.TV.HD.hr'];
    const byChannel = streamsByGuideChannel(
      [stream(101, 'Htv1.hr'), stream(102, 'DomaTv.hr')],
      indexOf(guideChannels)
    );

    // A store that only knows the ids exactly as it was given them.
    const stored = new Map(guideChannels.map(id => [id, [programme(id, `On ${id}`)]]));
    const answered = [...byChannel.values()].flatMap(
      matched => stored.get(matched.ref.channelId) ?? []
    );

    expect(answered).toHaveLength(2);
    expect(Object.keys(programmesByStream(answered, byChannel)).sort()).toEqual(['101', '102']);
  });

  it('returns nothing when there is nothing to match', () => {
    expect(programmesByStream([], new Map())).toEqual({});
  });
});

describe('countMatched', () => {
  const guide = (...ids: string[]) => ids.map(id => known(id));

  // Without this an unmatched channel looks exactly like one the guide simply
  // has nothing scheduled for, which is the difference between "your feed is
  // fine" and "your channels need mapping by hand".
  it('says how many streams the guide can speak about', () => {
    const streams = [stream(1, 'hrt1.hr'), stream(2, 'hrt2.hr'), stream(3, 'nowhere.tv'), stream(4)];

    expect(countMatched(streams, guide('hrt1.hr', 'hrt2.hr', 'rtl.hr'))).toEqual({
      matched: 2,
      unmatched: 2,
      loosely: 0
    });
  });

  it('counts a stream with no channel id as unmatched', () => {
    expect(countMatched([stream(1)], guide('hrt1.hr'))).toMatchObject({ matched: 0, unmatched: 1 });
  });

  it('matches case-insensitively', () => {
    expect(countMatched([stream(1, 'HRT1.hr')], guide('hrt1.HR'))).toMatchObject({
      matched: 1,
      unmatched: 0
    });
  });

  it('reports nothing matched when the guide is empty', () => {
    expect(countMatched([stream(1, 'a'), stream(2, 'b')], [])).toMatchObject({
      matched: 0,
      unmatched: 2
    });
  });

  // Separated out because the two are worth different amounts of trust, and a
  // screen that says "412 matched, 300 of them loosely" is saying something
  // useful about whether the feed and the line-up really agree.
  it('says how many were matched only by the looser rule', () => {
    const streams = REAL_PAIRS.map(([provider], index) => stream(index, provider));

    expect(countMatched(streams, guide(...REAL_PAIRS.map(([, id]) => id)))).toEqual({
      matched: 4,
      unmatched: 0,
      loosely: 4
    });
  });

  it('counts an exact match as exact, not as loose', () => {
    expect(countMatched([stream(1, 'HTV1.HD.hr')], guide('HTV1.HD.hr'))).toEqual({
      matched: 1,
      unmatched: 0,
      loosely: 0
    });
  });
});

describe('looseChannelId', () => {
  it('reduces the real pairs to the same key', () => {
    for (const [provider, feed] of REAL_PAIRS) {
      expect(looseChannelId(provider)).toBe(looseChannelId(feed));
    }
  });

  it('drops the words that describe the picture rather than the channel', () => {
    expect(looseChannelId('HTV1.HD.hr')).toBe('htv1hr');
    expect(looseChannelId('Sport.UHD.uk')).toBe('sportuk');
    expect(looseChannelId('Film.4K.de')).toBe('filmde');
  });

  // Joining without separators is what lets DomaTv meet Doma.TV: the two
  // disagree about where the words divide as well as about the quality.
  it('ignores where the words were divided', () => {
    expect(looseChannelId('DomaTv.hr')).toBe(looseChannelId('Doma.TV.hr'));
    expect(looseChannelId('arena sport 5')).toBe(looseChannelId('Arena.Sport.5'));
  });

  it('keeps genuinely different channels different', () => {
    expect(looseChannelId('HTV1.hr')).not.toBe(looseChannelId('HTV2.hr'));
    expect(looseChannelId('Arena.Sport.1.hr')).not.toBe(looseChannelId('Arena.Sport.2.hr'));
    expect(looseChannelId('RTL.hr')).not.toBe(looseChannelId('RTL.2.hr'));
  });

  // A channel actually called "HD" should not reduce to its country and start
  // matching whatever else is in that country.
  it('does not reduce a channel to nothing when its name is a quality word', () => {
    expect(looseChannelId('HD.hr')).toBe('hdhr');
    expect(looseChannelId('4K')).toBe('4k');
  });

  it('gives an empty key for nothing', () => {
    expect(looseChannelId('')).toBe('');
    expect(looseChannelId(undefined)).toBe('');
  });
});

describe('indexGuideChannels and resolveGuideChannel', () => {
  it('resolves the real pairs to the guide channel', () => {
    const index = indexOf(REAL_PAIRS.map(([, feed]) => feed));

    for (const [provider, feed] of REAL_PAIRS) {
      expect(resolveGuideChannel(index, provider)?.id).toBe(feed);
    }
  });

  it('prefers an exact match over a loose one', () => {
    const index = indexOf(['HTV1.hr', 'HTV1.HD.hr']);

    expect(resolveGuideChannel(index, 'htv1.hr')?.id).toBe('HTV1.hr');
  });

  // The guard that makes loose matching safe. Attaching one channel's schedule
  // to another is worse than showing none: an absent guide is obviously
  // absent, and a wrong one is believed.
  it('refuses a loose match when two guide channels reduce to the same key', () => {
    const index = indexOf(['Sport.HD.hr', 'Sport.hr']);

    expect(index.loose.has('sporthr')).toBe(false);
    expect(resolveGuideChannel(index, 'SportHD.hr')).toBeNull();
  });

  it('still resolves the unambiguous ones alongside an ambiguous pair', () => {
    const index = indexOf(['Sport.HD.hr', 'Sport.hr', 'HTV1.HD.hr']);

    expect(resolveGuideChannel(index, 'Htv1.hr')?.id).toBe('HTV1.HD.hr');
  });

  /**
   * The same channel offered by two guides is not ambiguity.
   *
   * Ambiguity is two *different* channels reducing to one key, where picking
   * either could be wrong. One channel in two guides is a choice between
   * equally correct answers -- so one is taken, and the picker exists for
   * anyone who wants the other.
   */
  it('takes one when two guides describe the same channel', () => {
    const index = indexGuideChannels([
      known('HTV1.HD.hr', 'epgshare'),
      known('HTV1.HD.hr', 'provider')
    ]);

    const resolved = resolveGuideChannel(index, 'Htv1.hr');
    expect(resolved?.id).toBe('HTV1.HD.hr');
    expect(['epgshare', 'provider']).toContain(resolved?.sourceId);
  });

  it('returns null for a stream with no channel id', () => {
    const index = indexOf(['HTV1.HD.hr']);

    expect(resolveGuideChannel(index, undefined)).toBeNull();
    expect(resolveGuideChannel(index, '  ')).toBeNull();
  });

  it('returns null when nothing resembles it', () => {
    expect(resolveGuideChannel(indexOf(['HTV1.HD.hr']), 'sky.sports.uk')).toBeNull();
  });
});

describe('normaliseChannelId', () => {
  it('trims and lowercases', () => {
    expect(normaliseChannelId('  HRT1.hr ')).toBe('hrt1.hr');
  });

  it('treats absent and empty alike', () => {
    expect(normaliseChannelId(undefined)).toBe('');
    expect(normaliseChannelId(null)).toBe('');
    expect(normaliseChannelId('   ')).toBe('');
  });
});

describe('resolveGuideChannelByName', () => {
  /** A guide channel with a name of its own, as a real feed has. */
  const named = (id: string, name: string, sourceId = 'provider'): KnownChannel => ({
    id,
    name,
    sourceId
  });

  const index = (...channels: KnownChannel[]) => indexGuideChannels(channels);

  // The case this exists for, with the names exactly as they arrive.
  it('matches the provider name to the guide channel of the same name', () => {
    const guide = index(named('Htv2.hr', 'HR| HRT 2'), named('Htv3.hr', 'HR| HRT 3'));

    expect(resolveGuideChannelByName(guide, 'HR| HRT 2 ⱽᴵᴾ ᴿᴬᵂ')?.id).toBe('Htv2.hr');
  });

  it('is what resolveGuideChannel falls back to when the id says nothing', () => {
    const guide = index(named('Htv2.hr', 'HRT 2'));

    expect(resolveGuideChannel(guide, undefined, 'HR| HRT 2 ⱽᴵᴾ ᴿᴬᵂ')?.id).toBe('Htv2.hr');
  });

  it('never overrides an id that did match', () => {
    const guide = index(named('Htv1.hr', 'HRT 2'), named('Htv2.hr', 'HRT 2 Other'));

    expect(resolveGuideChannel(guide, 'Htv1.hr', 'HR| HRT 2')?.id).toBe('Htv1.hr');
  });

  it('wants the same name, not one inside the other', () => {
    const guide = index(named('SportKlub2.hr', 'Sport Klub 2'));

    expect(resolveGuideChannelByName(guide, 'HR| Sport')).toBeNull();
  });

  it('refuses a same-named channel from another country', () => {
    const guide = index(named('RTL2.de', 'RTL 2'));

    expect(resolveGuideChannelByName(guide, 'HR| RTL 2')).toBeNull();
  });

  it('prefers the one that agrees on country when several share the name', () => {
    const guide = index(named('RTL2.de', 'RTL 2'), named('Rtl2.hr', 'RTL 2'));

    expect(resolveGuideChannelByName(guide, 'HR| RTL 2')?.id).toBe('Rtl2.hr');
  });

  it('accepts an id that names no country, since that is not a disagreement', () => {
    const guide = index(named('HRT2', 'HRT 2'));

    expect(resolveGuideChannelByName(guide, 'HR| HRT 2')?.id).toBe('HRT2');
  });

  // Two different channels still standing is a coin toss.
  it('refuses when two different channels remain', () => {
    const guide = index(named('Sport1.hr', 'Sport 1'), named('Sport1Extra.hr', 'Sport 1'));

    expect(resolveGuideChannelByName(guide, 'HR| Sport 1')).toBeNull();
  });

  it('takes one when two guides describe the same channel', () => {
    const guide = index(named('Htv2.hr', 'HRT 2', 'provider'), named('Htv2.hr', 'HRT 2', 'epgshare'));

    expect(resolveGuideChannelByName(guide, 'HR| HRT 2')?.sourceId).toBe('provider');
  });

  it('refuses a name made only of digits', () => {
    const guide = index(named('TwentyFour.hr', '24/7 24'));

    expect(resolveGuideChannelByName(guide, '24/7 24')).toBeNull();
  });

  it('returns null for no name at all', () => {
    expect(resolveGuideChannelByName(index(named('Htv2.hr', 'HRT 2')), undefined)).toBeNull();
  });

  // The ids below are copied from the two guides on a real device, for the
  // rows of one real Croatian category.
  it('treats one channel spelled two ways by two guides as one channel', () => {
    const guide = index(
      named('RtlCrime.hr', 'HR| RTL CRIME', 'provider'),
      named('rtlcrime.nl', 'RTL Crime', 'provider'),
      named('RTL.Crime.hr', 'RTL Crime', 'epgshare')
    );

    expect(resolveGuideChannelByName(guide, 'HR| RTL CRIME')?.id).toBe('RtlCrime.hr');
  });

  it('keeps the Croatian channel when Slovenian and Serbian ones share the name', () => {
    const guide = index(
      named('ArenaSport1.hr', 'HR| ARENA SPORT 1'),
      named('ArenaSport1.si', 'SI| ARENA SPORT 1'),
      named('Arenasport1.rs', 'RS| ARENA SPORT 1'),
      named('Arena.Sport.1.HD.hr', 'Arena Sport 1 HD', 'epgshare')
    );

    expect(resolveGuideChannelByName(guide, 'HR| ARENA SPORT 1')?.id).toBe('ArenaSport1.hr');
  });

  it('still refuses when two genuinely different Croatian channels share the name', () => {
    const guide = index(
      named('NovaTv.hr', 'Nova TV'),
      named('TV.Nova.hr', 'Nova TV'),
      named('NovaHD.hr', 'Nova TV')
    );

    expect(resolveGuideChannelByName(guide, 'HR| NOVA TV')).toBeNull();
  });

  it('reads a country written at the front of the id', () => {
    const guide = index(named('mx.History 2', 'History 2'));

    expect(resolveGuideChannelByName(guide, 'HR| HISTORY 2')).toBeNull();
  });

  it('reads a provider tag carried into the id as a country', () => {
    const guide = index(named('LAT| HISTORY 2 HD', 'LAT| HISTORY 2 HD'));

    expect(resolveGuideChannelByName(guide, 'HR| HISTORY 2')).toBeNull();
  });

  it('reads the country from a guide channel name when its id names none', () => {
    const guide = index(named('E! Entertainment', 'PL| E! ENTERTAINMENT FHD'));

    expect(resolveGuideChannelByName(guide, 'HR| E! ENTERTAINMENT')).toBeNull();
  });

  it('refuses a same-named channel that exists only abroad', () => {
    const guide = index(named('FightBox.pl', 'FightBox'), named('fightbox.bg', 'FightBox'));

    expect(resolveGuideChannelByName(guide, 'HR| FIGHTBOX')).toBeNull();
  });

  it('lets streamsByGuideChannel match a stream that carries only a name', () => {
    const guide = index(named('Htv2.hr', 'HRT 2'));

    const matched = streamsByGuideChannel([{ stream_id: 7, name: 'HR| HRT 2 ⱽᴵᴾ ᴿᴬᵂ' }], guide);

    expect(matched.get('Htv2.hr')?.streamIds).toEqual(['7']);
  });
});

describe('guideTwins and chooseTwin', () => {
  const named = (id: string, name: string, sourceId: string): KnownChannel => ({ id, name, sourceId });

  // Ids and names copied from the two guides on a real device.
  const provider = [
    named('HBO.hr', 'HR| HBO ⱽᴵᴾ ᴿᴬᵂ', 'provider'),
    named('NovaHD.hr', 'HR| NOVA TV ⱽᴵᴾ ᴿᴬᵂ', 'provider'),
    named('NovaTv.hr', 'HR| NOVA TV', 'provider'),
    named('CinestarTV2.hr', 'HR| CINESTAR TV 2 ⱽᴵᴾ ᴿᴬᵂ', 'provider'),
    named('KlasikTv.hr', 'HR| CINESTAR TV 2', 'provider'),
    named('KanalRi.hr', 'HR| KANAL RI ⱽᴵᴾ ᴿᴬᵂ', 'provider'),
    named('HBO.de', 'HBO', 'provider')
  ];
  const epgshare = [
    named('HBO.HD.hr', 'HBO HD', 'epgshare'),
    named('Nova.TV.HD.hr', 'Nova TV', 'epgshare'),
    named('TV.Nova.hr', 'Nova TV', 'epgshare'),
    named('CineStar.TV.2.hr', 'CineStar TV 2', 'epgshare'),
    named('KanalRi.hr', 'Kanal Ri', 'epgshare')
  ];
  const index = indexGuideChannels([...provider, ...epgshare]);
  const find = (id: string, sourceId: string) =>
    [...provider, ...epgshare].find(c => c.id === id && c.sourceId === sourceId)!;
  const withProgrammes = (...ids: string[]) => (channel: KnownChannel) => ids.includes(`${channel.sourceId}:${channel.id}`);

  it('finds the same channel in the other guide by loosened id', () => {
    const twins = guideTwins(index, find('HBO.hr', 'provider'));

    expect(twins.map(c => `${c.sourceId}:${c.id}`)).toContain('epgshare:HBO.HD.hr');
  });

  it('never counts a channel as its own twin', () => {
    const twins = guideTwins(index, find('HBO.hr', 'provider'));

    expect(twins.some(c => c.sourceId === 'provider' && c.id === 'HBO.hr')).toBe(false);
  });

  it('finds a twin with the same id in another guide', () => {
    const twins = guideTwins(index, find('KanalRi.hr', 'provider'));

    expect(twins.map(c => `${c.sourceId}:${c.id}`)).toEqual(['epgshare:KanalRi.hr']);
  });

  it('does not count a same-named channel from another country', () => {
    const twins = guideTwins(index, find('HBO.hr', 'provider'));

    expect(twins.some(c => c.id === 'HBO.de')).toBe(false);
  });

  it('chooses the one twin that has programmes', () => {
    const twins = guideTwins(index, find('HBO.hr', 'provider'));

    expect(chooseTwin(twins, withProgrammes('epgshare:HBO.HD.hr'))?.id).toBe('HBO.HD.hr');
  });

  it('chooses nothing when no twin has programmes', () => {
    const twins = guideTwins(index, find('HBO.hr', 'provider'));

    expect(chooseTwin(twins, () => false)).toBeNull();
  });

  // Very probably one channel, not provably so.
  it('declines Nova TV, whose twins with programmes are three different ids', () => {
    const twins = guideTwins(index, find('NovaHD.hr', 'provider'));

    expect(
      chooseTwin(twins, withProgrammes('provider:NovaTv.hr', 'epgshare:Nova.TV.HD.hr', 'epgshare:TV.Nova.hr'))
    ).toBeNull();
  });

  it('declines Cinestar TV 2 when a differently named channel shares its name', () => {
    const twins = guideTwins(index, find('CinestarTV2.hr', 'provider'));

    expect(chooseTwin(twins, withProgrammes('provider:KlasikTv.hr', 'epgshare:CineStar.TV.2.hr'))).toBeNull();
  });
});

describe('looseIdSql', () => {
  it('reads an id as looseChannelId does, in one of its two forms', () => {
    const db = new Database(':memory:');
    const { all, kept } = looseIdSql('id');
    const ids = ['HRT1.hr', 'HTV1.HD.hr', ' htv 1 hr ', 'Doma.TV.HD.hr', 'HD.hr', 'hd', 'RTL-Crime (HD) | hr', 'Nova.TV.FHD.4K.hr', "Ocean's.uk", 'sport_klub_1/hr'];
    for (const id of ids) {
      const read = db.prepare(`SELECT ${all} AS a, ${kept} AS k FROM (SELECT ? AS id)`).get(id) as { a: string; k: string };
      expect([id, [read.a, read.k].includes(looseChannelId(id))]).toEqual([id, true]);
    }
  });
});
