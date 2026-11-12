import { fingerprint, readFamilyLinks, resolveByName, translateMappings } from './familySetup';

describe("handing a manager's channel matches to a member", () => {
  const mappings = [
    // The manager's first provider, shared with the member as their first too.
    { streamId: '101', sourceId: 'g1', channelId: 'HRT1.hr' },
    // The manager's second provider, shared under a tag of the member's own.
    { streamId: 'pabc~7', sourceId: 'g1', channelId: 'Nova.hr' },
    // A provider the member does not have: by name.
    { streamId: 'pzzz~9', sourceId: 'g2', channelId: 'RTL.hr' },
    // Nothing known about its name: dropped rather than guessed at.
    { streamId: 'pzzz~10', sourceId: 'g2', channelId: 'Doma.hr' }
  ];
  const shared = new Map([
    ['', ''],
    ['pabc', 'p9x1']
  ]);
  const names: Record<string, string> = { 'pzzz~9': ' RTL ' };

  it('keeps ids exact through a shared provider, under the member\'s tag', () => {
    const { direct } = translateMappings(mappings, shared, id => names[id]);

    expect(direct).toEqual([
      { streamId: '101', sourceId: 'g1', channelId: 'HRT1.hr' },
      { streamId: 'p9x1~7', sourceId: 'g1', channelId: 'Nova.hr' }
    ]);
  });

  it('leaves the rest to be matched by name, and only where there is a name', () => {
    const { byName } = translateMappings(mappings, shared, id => names[id]);

    expect(byName).toEqual([{ name: 'RTL', sourceId: 'g2', channelId: 'RTL.hr' }]);
  });
});

describe("matching by name on the member's side", () => {
  const pending = [
    { name: 'RTL', sourceId: 'g2', channelId: 'RTL.hr' },
    { name: 'Sport 1', sourceId: 'g2', channelId: 'Sport1.hr' },
    { name: 'HBO', sourceId: 'g2', channelId: 'HBO.hr' },
    { name: 'Kids', sourceId: 'g2', channelId: 'Kids.hr' }
  ];
  const streams = [
    { id: '5', name: 'rtl' },
    // Two channels of one name: a guess would be wrong half the time.
    { id: '6', name: 'Sport 1' },
    { id: '7', name: 'Sport 1' },
    { id: '8', name: 'HBO' },
    { id: '9', name: 'Kids' }
  ];

  it('matches a name that means one channel, ignoring case', () => {
    expect(resolveByName(pending, streams, new Set(['9']))).toEqual([
      { streamId: '5', sourceId: 'g2', channelId: 'RTL.hr' },
      { streamId: '8', sourceId: 'g2', channelId: 'HBO.hr' }
    ]);
  });

  it("never replaces a match the member made", () => {
    expect(resolveByName(pending, streams, new Set(['5', '8', '9']))).toEqual([]);
  });

  it('refuses a name it was handed twice', () => {
    const twice = [...pending, { name: 'rtl', sourceId: 'g3', channelId: 'RTL2.hr' }];

    expect(resolveByName(twice, streams, new Set()).map(match => match.streamId)).toEqual(['8', '9']);
  });
});

describe('the links a manager keeps', () => {
  it('reads what was written, and nothing else', () => {
    const raw = JSON.stringify({
      '12': { providers: { 'abc': '', 'm3u-pz': 'p1x2', bad: 4 }, guides: true, handed: { guides: 'aa' } },
      ana: { providers: {}, guides: true },
      '13': 'nonsense'
    });

    expect(readFamilyLinks(raw)).toEqual({
      '12': { providers: { abc: '', 'm3u-pz': 'p1x2' }, guides: true, handed: { guides: 'aa' } }
    });
    expect(readFamilyLinks('{not json')).toEqual({});
    expect(readFamilyLinks(null)).toEqual({});
  });

  it('fingerprints what was handed over, the same for the same', () => {
    expect(fingerprint({ a: 1 })).toBe(fingerprint({ a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});
