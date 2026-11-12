import { copiesWorthTrying, copyFailure, isHighResolution, nextCopy, otherVersions, qualityOf, searchWordsFor, versionKey } from './other-versions.utils';

// As this provider lists X-Men, on the TV emulator (22 September).
const LIBRARY = [
  { stream_id: 1, name: 'EN - X-Men [UHD] (2000)' },
  { stream_id: 2, name: 'EN - X-Men 4K (2000) X-Men 01' },
  { stream_id: 3, name: 'FR - X-Men (2000)' },
  { stream_id: 4, name: 'EN - X-Men (2000)' },
  { stream_id: 5, name: 'EN - X-Men: Apocalypse (2016)' },
  { stream_id: 6, name: 'EN - X-Men (2011)' }
];

describe('other versions of a film', () => {
  it('knows two versions of one film for the same film', () => {
    expect(versionKey('EN - X-Men [UHD] (2000)')).toBe(versionKey('FR - X-Men (2000)'));
    expect(versionKey('EN - X-Men 4K (2000) X-Men 01')).toBe('xmen|2000');
  });

  it('tells a 4K version from the rest', () => {
    expect(isHighResolution('EN - X-Men [UHD] (2000)')).toBe(true);
    expect(isHighResolution('EN - X-Men 4K (2000)')).toBe(true);
    expect(isHighResolution('FR - X-Men (2000)')).toBe(false);
  });

  it('offers the versions that are not 4K, in the same language first', () => {
    const offered = otherVersions(LIBRARY[0], LIBRARY).map(version => version.stream_id);

    expect(offered).toEqual([4, 3]);
  });

  it('does not offer a different film with the same name, or a sequel', () => {
    const offered = otherVersions(LIBRARY[0], LIBRARY).map(version => version.stream_id);

    expect(offered).not.toContain(5);
    expect(offered).not.toContain(6);
  });

  it('searches with the title alone', () => {
    expect(searchWordsFor('EN - X-Men [UHD] (2000)')).toBe('X-Men');
  });
});

describe('the next copy to try when one fails', () => {
  // One film as a provider might list it: two languages, four sizes.
  const COPIES = [
    { stream_id: 10, name: 'EN - Dune [4K] (2021)' },
    { stream_id: 11, name: 'EN - Dune FHD (2021)' },
    { stream_id: 12, name: 'EN - Dune 1080p (2021)' },
    { stream_id: 13, name: 'DE - Dune FHD (2021)' },
    { stream_id: 14, name: 'EN - Dune HD (2021)' },
    { stream_id: 15, name: 'EN - Dune SD (2021)' },
    { stream_id: 16, name: 'EN - Dune: Part Two FHD (2024)' }
  ];
  const none = new Set<string>();
  const id = (copy: { stream_id: number } | null) => copy?.stream_id ?? null;

  it('reads the size of a picture from the name, Full HD when it does not say', () => {
    expect(COPIES.map(copy => qualityOf(copy.name))).toEqual([4, 3, 3, 3, 2, 1, 3]);
    expect(qualityOf('EN - Dune (2021)')).toBe(3);
  });

  it('tries one of the same size after a dead link, in the same language', () => {
    expect(id(nextCopy(COPIES[1], COPIES, none, 'copy'))).toBe(12);
  });

  it('goes to a smaller one once the same size has been tried', () => {
    expect(id(nextCopy(COPIES[1], COPIES, new Set(['12', '13']), 'copy'))).toBe(14);
  });

  it('prefers the same size in another language to a smaller one in the same', () => {
    expect(id(nextCopy(COPIES[1], COPIES, new Set(['12']), 'copy'))).toBe(13);
  });

  it('wants a smaller picture first when this device could not decode one', () => {
    expect(id(nextCopy(COPIES[1], COPIES, none, 'decode'))).toBe(14);
  });

  it('never goes to 4K after a decoder gave up, even from 4K', () => {
    expect(id(nextCopy(COPIES[0], COPIES, none, 'decode'))).toBe(11);
  });

  it('never tries a bigger picture', () => {
    expect(id(nextCopy(COPIES[4], COPIES, none, 'copy'))).toBe(15);
    expect(nextCopy(COPIES[5], COPIES, none, 'copy')).toBeNull();
  });

  it('never tries a different film', () => {
    const tried = new Set(['11', '12', '13', '14', '15']);
    expect(nextCopy(COPIES[0], COPIES, tried, 'copy')).toBeNull();
  });

  it('tries nothing when the provider refused the account or could not be reached', () => {
    expect(nextCopy(COPIES[1], COPIES, none, 'account')).toBeNull();
    expect(nextCopy(COPIES[1], COPIES, none, 'network')).toBeNull();
  });
});

describe('what a failure says about trying another copy', () => {
  it('blames the copy for a missing file', () => {
    expect(copyFailure('ERROR_CODE_IO_BAD_HTTP_STATUS (HTTP 404)')).toBe('copy');
    expect(copyFailure('ERROR_CODE_IO_FILE_NOT_FOUND')).toBe('copy');
    expect(copyFailure('ERROR_CODE_PARSING_CONTAINER_MALFORMED')).toBe('copy');
  });

  it('blames the account for a refusal', () => {
    expect(copyFailure('ERROR_CODE_IO_BAD_HTTP_STATUS (HTTP 403)')).toBe('account');
    expect(copyFailure('ERROR_CODE_IO_BAD_HTTP_STATUS (HTTP 509)')).toBe('account');
  });

  it('blames the network when nothing answered', () => {
    expect(copyFailure('ERROR_CODE_IO_NETWORK_CONNECTION_FAILED')).toBe('network');
    expect(copyFailure('ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT')).toBe('network');
  });

  it('knows a decoder failure', () => {
    expect(copyFailure('no decoder on this device managed hevc 3840x2160 (ERROR_CODE_DECODING_FAILED)')).toBe('decode');
  });

  it('tries three copies at most, one when a refusal did not say why, none for the account', () => {
    expect(copiesWorthTrying('ERROR_CODE_IO_BAD_HTTP_STATUS (HTTP 404)')).toBe(3);
    expect(copiesWorthTrying('ERROR_CODE_IO_BAD_HTTP_STATUS')).toBe(1);
    expect(copiesWorthTrying('ERROR_CODE_IO_BAD_HTTP_STATUS (HTTP 403)')).toBe(0);
    expect(copiesWorthTrying('ERROR_CODE_IO_NETWORK_CONNECTION_FAILED')).toBe(0);
  });

  it('tries one copy when the player did not say what went wrong', () => {
    expect(copiesWorthTrying('mpv exited with code 2')).toBe(1);
    expect(copiesWorthTrying('ERROR_CODE_IO_FILE_NOT_FOUND')).toBe(3);
    expect(copiesWorthTrying('no decoder on this device managed hevc 3840x2160 (ERROR_CODE_DECODING_FAILED)')).toBe(3);
  });
});
