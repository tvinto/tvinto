import { bringProviders } from './bringProviders';
import { ProviderRecord } from './providerRecord';

const xtream = (tag: string, serverUrl: string, username = 'someone'): ProviderRecord => ({
  kind: 'xtream',
  tag,
  enabled: true,
  label: serverUrl,
  serverUrl,
  username,
  password: 'not-a-real-one'
});
const m3u = (tag: string, url: string): ProviderRecord => ({ kind: 'm3u', tag, enabled: true, label: url, url });

const fixed = () => 0.5;

describe('bringProviders', () => {
  it('takes every provider as it is into an account with none', () => {
    const device = [xtream('', 'http://a.example'), m3u('pabc', 'http://b.example/list.m3u')];

    const brought = bringProviders([], device, fixed);

    expect(brought.all).toEqual(device);
    expect(brought.added).toEqual(device);
    expect(brought.moves.size).toBe(0);
  });

  it('does not double a subscription the account already has', () => {
    const account = [xtream('', 'http://a.example')];
    const brought = bringProviders(account, [xtream('', 'http://a.example/')], fixed);

    expect(brought.all).toEqual(account);
    expect(brought.added).toEqual([]);
    expect(brought.moves.size).toBe(0);
  });

  it("files the device's copy of one under the account's tag", () => {
    const account = [m3u('', 'http://free.example/list.m3u'), xtream('pq1', 'http://paid.example')];
    const brought = bringProviders(account, [xtream('', 'http://paid.example')], fixed);

    expect(brought.added).toEqual([]);
    expect(brought.moves.get('')).toBe('pq1');
  });

  it("gives a different first provider a tag of its own beside the account's", () => {
    const account = [xtream('', 'http://a.example')];
    const brought = bringProviders(account, [m3u('', 'http://b.example/list.m3u')], fixed);

    const joined = brought.added[0];
    expect(joined.tag).not.toBe('');
    expect(brought.all).toEqual([...account, joined]);
    expect(brought.moves.get('')).toBe(joined.tag);
  });

  it('never gives the empty tag to a device provider when the account has others', () => {
    // The account's first was removed; its favourites are still filed under no tag.
    const account = [xtream('pq1', 'http://a.example')];
    const brought = bringProviders(account, [m3u('', 'http://b.example/list.m3u')], fixed);

    expect(brought.added[0].tag).not.toBe('');
  });

  it('keeps a device tag the account does not use', () => {
    const account = [xtream('', 'http://a.example')];
    const brought = bringProviders(account, [m3u('pzz', 'http://b.example/list.m3u')], fixed);

    expect(brought.added[0].tag).toBe('pzz');
    expect(brought.moves.size).toBe(0);
  });

  it('chooses new tags that clash with no device tag either', () => {
    const account = [xtream('', 'http://a.example')];
    let calls = 0;
    // The first tag it would pick is one the device already uses.
    const random = () => (calls++ === 0 ? 0 : 0.9);
    const brought = bringProviders(account, [m3u('', 'http://b.example/x.m3u'), m3u('p000', 'http://c.example/y.m3u')], random);

    const tags = brought.all.map(record => record.tag);
    expect(new Set(tags).size).toBe(tags.length);
  });
});
