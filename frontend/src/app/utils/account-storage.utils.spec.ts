import { accountStorageKey, adoptableLegacyValue, legacyAccountKeys } from './account-storage.utils';

/**
 * The bug this exists because of: a device moved to a second service looked
 * for its favourites under the account id that service had just invented,
 * found nothing, and offered the new service an empty account. Nothing failed.
 * An empty drawer is what a new account looks like.
 */

const PREFIX = 'xtream_local_data';

describe('accountStorageKey', () => {
  it('names the drawer after the person, not after a number a server chose', () => {
    // The whole fix. The same person is user 2 on one service and user 1 on
    // the next; the username is what they type into both.
    expect(accountStorageKey(PREFIX, 'AnaMaria')).toBe(accountStorageKey(PREFIX, 'AnaMaria'));
  });

  it('treats a name as the same however it was capitalised', () => {
    expect(accountStorageKey(PREFIX, 'AnaMaria')).toBe(accountStorageKey(PREFIX, 'anamaria'));
    expect(accountStorageKey(PREFIX, '  AnaMaria  ')).toBe(accountStorageKey(PREFIX, 'anamaria'));
  });

  it('keeps two people apart', () => {
    expect(accountStorageKey(PREFIX, 'petar')).not.toBe(accountStorageKey(PREFIX, 'luigi'));
  });

  it('has an answer for nobody signed in', () => {
    expect(accountStorageKey(PREFIX, null)).toBe(`${PREFIX}:none`);
    expect(accountStorageKey(PREFIX, '   ')).toBe(`${PREFIX}:none`);
  });
});

describe('legacyAccountKeys', () => {
  it('finds what an older build wrote', () => {
    expect(
      legacyAccountKeys(PREFIX, ['unrelated', `${PREFIX}:2`, 'xtream_sync_cursor:2'])
    ).toEqual([`${PREFIX}:2`]);
  });

  it('finds all of them, because more than one is the ordinary case', () => {
    // A device that had already signed in to the new service has a drawer
    // under the id that service assigned, empty, beside the full one from the
    // old service.
    expect(legacyAccountKeys(PREFIX, [`${PREFIX}:2`, `${PREFIX}:1`])).toEqual([
      `${PREFIX}:1`,
      `${PREFIX}:2`
    ]);
  });

  it('finds nothing when there is nothing to find', () => {
    expect(legacyAccountKeys(PREFIX, ['unrelated'])).toEqual([]);
  });

  it('does not mistake a new key for an old one', () => {
    // The new form is named after a person, so it must not match the pattern
    // that hunts for a number -- or a move would keep adopting itself.
    expect(legacyAccountKeys(PREFIX, [accountStorageKey(PREFIX, 'petar')])).toEqual([]);
    expect(legacyAccountKeys(PREFIX, [`${PREFIX}:none`])).toEqual([]);
  });

  it('does not match a longer prefix that starts the same way', () => {
    expect(legacyAccountKeys(PREFIX, [`${PREFIX}_extra:2`])).toEqual([]);
  });
});

describe('adoptableLegacyValue', () => {
  const store: Record<string, string> = {
    [`${PREFIX}:1`]: '{"favourites":{}}',
    [`${PREFIX}:2`]: '{"favourites":{"live:101":{}}}',
    [`${PREFIX}:none`]: '{"favourites":{"live:999":{}}}'
  };

  const read = (key: string) => store[key] ?? null;
  const hasContent = (raw: string) => Object.keys(JSON.parse(raw).favourites ?? {}).length > 0;

  it('skips the empty drawer and takes the full one', () => {
    // The failure this exists for. The empty one is the drawer the new service
    // caused to be created; the full one is the account.
    const found = adoptableLegacyValue(PREFIX, Object.keys(store), read, hasContent);

    expect(found?.key).toBe(`${PREFIX}:2`);
    expect(found?.raw).toBe(store[`${PREFIX}:2`]);
  });

  it('takes nothing when every drawer is empty', () => {
    expect(
      adoptableLegacyValue(PREFIX, [`${PREFIX}:1`], read, hasContent)
    ).toBeNull();
  });

  it('ignores the new form entirely', () => {
    // `:none` holds something, but it is not a legacy key and adopting it
    // would be a device taking its own signed-out scratch copy as an account.
    expect(adoptableLegacyValue(PREFIX, [`${PREFIX}:none`], read, hasContent)).toBeNull();
  });

  it('survives a drawer holding something that is not JSON', () => {
    expect(
      adoptableLegacyValue(PREFIX, [`${PREFIX}:3`], () => 'not json', hasContent)
    ).toBeNull();
  });
});
