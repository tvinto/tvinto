import { KnownChannel } from './guide';
import {
  nameWords,
  searchWithoutProviderNoise,
  suggestGuideChannels
} from './guideSuggestions';

const channel = (id: string, name: string, sourceId = 'feed'): KnownChannel => ({
  id,
  name,
  sourceId
});

/** Channels as two real feeds actually name them. */
const CROATIAN = [
  channel('Doma.TV.HD.hr', 'Doma TV HD', 'epgshare'),
  channel('HTV1.HD.hr', 'HTV1 HD', 'epgshare'),
  channel('HTV2.HD.hr', 'HTV2 HD', 'epgshare'),
  channel('Nova.TV.HD.hr', 'Nova TV HD', 'epgshare'),
  channel('RTL.HD.hr', 'RTL HD', 'epgshare'),
  channel('DomaTv.hr', 'Doma TV', 'provider'),
  channel('Htv1.hr', 'HRT 1', 'provider'),
  channel('doma.tv.rs', 'Doma TV', 'serbian')
];

describe('nameWords', () => {
  // Providers prefix a country tag and suffix the quality; both are noise, and
  // leaving them in makes every channel from one country look alike.
  it('drops the country tag a provider prefixes', () => {
    expect(nameWords('HR| DOMA TV')).toEqual(['doma']);
    expect(nameWords('BA| FEDERALNA TV HD')).toEqual(['federalna']);
    expect(nameWords('US-CNN')).toEqual(['cnn']);
  });

  it('drops words that say nothing about which channel this is', () => {
    expect(nameWords('Doma TV HD')).toEqual(['doma']);
    expect(nameWords('HR| TUBI RAW')).toEqual(['tubi']);
    expect(nameWords('HR| CROATIA VIP RAW')).toEqual(['croatia']);
  });

  it('keeps the digits that distinguish one channel from the next', () => {
    expect(nameWords('HR| HRT 1')).toEqual(['hrt', '1']);
    expect(nameWords('Arena Sport 5 HD')).toEqual(['arena', 'sport', '5']);
  });

  it('returns nothing for a name that is all noise', () => {
    expect(nameWords('HD')).toEqual([]);
  });
});

describe('suggestGuideChannels', () => {
  it('puts an exact channel id first, above any name', () => {
    const suggestions = suggestGuideChannels(
      { name: 'HR| SOMETHING ELSE', epg_channel_id: 'HTV1.HD.hr' },
      CROATIAN
    );

    expect(suggestions[0].channel.id).toBe('HTV1.HD.hr');
    expect(suggestions[0].because).toBe('id');
  });

  it('puts a loosely matching id near the top', () => {
    const suggestions = suggestGuideChannels(
      { name: 'HR| HRT 1', epg_channel_id: 'Htv1.hr' },
      CROATIAN
    );

    expect(suggestions[0].because).toBe('id');
    expect(suggestions[0].score).toBeGreaterThan(0.9);
  });

  // The case this exists for: no channel id at all, only a name a person wrote.
  it('suggests by name when the stream has no channel id', () => {
    const suggestions = suggestGuideChannels({ name: 'HR| DOMA HD' }, CROATIAN);

    expect(suggestions.map(s => s.channel.name)).toContain('Doma TV');
    expect(suggestions[0].channel.name).toMatch(/Doma/);
  });

  // What was asked for: the same channel from several guides, all offered, so
  // the choice of which guide is the person's.
  it('offers the same channel from every source that has it', () => {
    const suggestions = suggestGuideChannels({ name: 'HR| DOMA TV' }, CROATIAN);
    const doma = suggestions.filter(s => s.channel.name.startsWith('Doma'));

    expect(doma.map(s => s.channel.sourceId).sort()).toEqual(['epgshare', 'provider', 'serbian']);
  });

  // A line-up carries the same names from a dozen countries, and the tag on
  // the stream agrees with the suffix on the id about something real.
  it('prefers the channel from the country the stream is tagged with', () => {
    const suggestions = suggestGuideChannels({ name: 'HR| DOMA TV' }, CROATIAN);
    const croatian = suggestions.findIndex(s => s.channel.id.endsWith('.hr'));
    const serbian = suggestions.findIndex(s => s.channel.id.endsWith('.rs'));

    expect(croatian).toBeLessThan(serbian);
  });

  it('does not offer channels from a source that was filtered out', () => {
    const suggestions = suggestGuideChannels({ name: 'HR| DOMA TV' }, CROATIAN, {
      sourceIds: ['serbian']
    });

    expect(suggestions.every(s => s.channel.sourceId === 'serbian')).toBe(true);
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it('narrows to what a search names, rather than reordering', () => {
    const suggestions = suggestGuideChannels({ name: 'HR| ANYTHING' }, CROATIAN, {
      search: 'htv'
    });

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every(s => /htv/i.test(s.channel.name + s.channel.id))).toBe(true);
  });

  // Someone typing a name the scorer would never have suggested is telling us
  // directly, and should not be second-guessed.
  it('offers a searched channel even when the name resembles nothing', () => {
    const suggestions = suggestGuideChannels({ name: 'HR| ZZZ UNKNOWN' }, CROATIAN, {
      search: 'rtl'
    });

    expect(suggestions.map(s => s.channel.id)).toContain('RTL.HD.hr');
  });

  it('honours the limit', () => {
    expect(suggestGuideChannels({ name: 'HR| DOMA TV' }, CROATIAN, { limit: 2 })).toHaveLength(2);
  });

  it('returns nothing when there are no channels to offer', () => {
    expect(suggestGuideChannels({ name: 'HR| DOMA TV' }, [])).toEqual([]);
  });

  it('offers nothing rather than everything for a name that says nothing', () => {
    expect(suggestGuideChannels({ name: 'HD' }, CROATIAN)).toEqual([]);
  });

  it('does not confuse channels that differ only by a number', () => {
    const suggestions = suggestGuideChannels({ name: 'HR| HRT 2' }, [
      channel('HTV1.HD.hr', 'HTV1 HD'),
      channel('HTV2.HD.hr', 'HTV2 HD')
    ]);

    // Neither is a strong match by name alone -- HRT and HTV are different
    // words -- so what matters is that nothing is offered confidently.
    for (const suggestion of suggestions) {
      expect(suggestion.score).toBeLessThan(0.9);
    }
  });

  // Real data: "HR RADIO DUBROVNIK" and "Nick Jr HR" share only the country,
  // and offering that buries the real suggestions.
  it('leaves out matches that rest on one incidental word', () => {
    const suggestions = suggestGuideChannels({ name: 'HR| HR RADIO DUBROVNIK' }, [
      channel('Nick.Jr.HR.hr', 'Nick Jr HR')
    ]);

    expect(suggestions).toEqual([]);
  });

  it('keeps a weak but real match above the floor', () => {
    const suggestions = suggestGuideChannels({ name: 'HR| RADIO BANOVINA' }, [
      channel('RTV.Banovina.hr', 'RTV Banovina')
    ]);

    expect(suggestions.map(s => s.channel.name)).toEqual(['RTV Banovina']);
  });

  it('lets a search reach past the floor, since the person named it', () => {
    const suggestions = suggestGuideChannels({ name: 'HR| HR RADIO DUBROVNIK' }, [
      channel('Nick.Jr.HR.hr', 'Nick Jr HR')
    ], { search: 'nick' });

    expect(suggestions.map(s => s.channel.name)).toEqual(['Nick Jr HR']);
  });

  it('ranks the closer fit above the looser one', () => {
    const suggestions = suggestGuideChannels({ name: 'HR| ARENA SPORT 1' }, [
      channel('Arena.Sport.1.hr', 'Arena Sport 1'),
      channel('Arena.Sport.1.Plus.Extra.hr', 'Arena Sport 1 Plus Extra')
    ]);

    expect(suggestions[0].channel.name).toBe('Arena Sport 1');
  });
});

describe('searchWithoutProviderNoise', () => {
  // The exact name this provider puts on screen, and the exact search a person
  // types because it is what they can see.
  it('takes off the superscript suffixes no guide carries', () => {
    expect(searchWithoutProviderNoise('Sport Nord ⱽᴵᴾ ᴿᴬᵂ')).toBe('sport nord');
  });

  it('takes off the country tag as well', () => {
    expect(searchWithoutProviderNoise('HR| ARENA SPORT 1 ⱽᴵᴾ')).toBe('arena sport 1');
  });

  it('takes off spelled-out packaging words', () => {
    expect(searchWithoutProviderNoise('HRT 2 HD RAW')).toBe('hrt 2');
  });

  // Empty means "nothing to repair", which is how the caller tells a fixable
  // dead end from a real one. Offering "search X instead" where X is what was
  // already searched is a button that does nothing.
  it('gives nothing back when there was nothing to take off', () => {
    expect(searchWithoutProviderNoise('arena sport 1')).toBe('');
  });

  it('gives nothing back for a search that is all noise', () => {
    expect(searchWithoutProviderNoise('ⱽᴵᴾ ᴿᴬᵂ')).toBe('');
  });

  it('ignores case, so a shouted name still repairs', () => {
    expect(searchWithoutProviderNoise('RTL KOCKICA ᴿᴬᵂ')).toBe('rtl kockica');
  });
});
