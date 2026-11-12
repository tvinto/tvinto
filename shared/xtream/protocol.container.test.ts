import { containerExtensionOf } from './protocol';

describe('containerExtensionOf', () => {
  it('reads the container from where most providers put it', () => {
    expect(containerExtensionOf({ movie_data: { container_extension: 'mkv' } })).toBe('mkv');
  });

  it('reads it from the top level, where some put it instead', () => {
    expect(containerExtensionOf({ container_extension: 'avi' })).toBe('avi');
  });

  it('prefers movie_data when both are present', () => {
    // The nested one is the film's own; a top-level field on this response has
    // been seen carrying the container of something else entirely.
    expect(
      containerExtensionOf({ container_extension: 'mp4', movie_data: { container_extension: 'mkv' } })
    ).toBe('mkv');
  });

  it('strips a leading dot and lowercases', () => {
    expect(containerExtensionOf({ movie_data: { container_extension: '.MKV' } })).toBe('mkv');
  });

  it('rejects anything that would build a URL pointing elsewhere', () => {
    // Not a whitelist -- an unknown container is still fine -- but a value with
    // a slash or a query in it did not come from this field.
    for (const bad of ['../../etc', 'mp4?x=1', 'a/b', '', ' ', 'waytoolongforacontainer']) {
      expect(containerExtensionOf({ movie_data: { container_extension: bad } })).toBeNull();
    }
  });

  it('returns null rather than throwing on a response of the wrong shape', () => {
    for (const bad of [null, undefined, 'text', 42, [], {}, { movie_data: null }]) {
      expect(containerExtensionOf(bad)).toBeNull();
    }
  });

  it('returns null when the field is present but not a string', () => {
    expect(containerExtensionOf({ movie_data: { container_extension: 4 } })).toBeNull();
  });
});
