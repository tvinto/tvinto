import {
  describePlaybackFailure,
  describeProviderError,
  failedPictureSize,
  technicalDetail,
  tooBigToDecodeInSoftware
} from './failure-messages.utils';

// What the Media3 player reported for X-Men [UHD] on the TV emulator.
const FOUR_K_DOLBY = 'no decoder on this device managed dolby-vision 3840x1600 (ERROR_CODE_DECODING_FAILED)';

describe('describing a playback failure', () => {
  it('names a 4K HDR film the device cannot decode, and says a smaller one will play', () => {
    const said = describePlaybackFailure(FOUR_K_DOLBY, 'this film');

    expect(said.title).toBe("This device can't play 4K HDR HEVC");
    expect(said.message).toContain('lower-quality version');
  });

  it('reads the picture size out of the report', () => {
    expect(failedPictureSize(FOUR_K_DOLBY)).toEqual({ width: 3840, height: 1600 });
    expect(tooBigToDecodeInSoftware(FOUR_K_DOLBY)).toBe(true);
    expect(tooBigToDecodeInSoftware('no decoder on this device managed hevc 1920x1080 (ERROR_CODE_DECODING_FAILED)')).toBe(false);
    expect(tooBigToDecodeInSoftware('ERROR_CODE_DECODING_FAILED')).toBe(false);
  });

  it('tells a refused stream from an unreachable provider', () => {
    expect(describePlaybackFailure('ERROR_CODE_IO_BAD_HTTP_STATUS').title).toBe('Your provider refused this stream');
    expect(describePlaybackFailure('ERROR_CODE_IO_NETWORK_CONNECTION_FAILED').title).toBe("Couldn't reach your provider");
  });

  it('says something even for a code it has never seen', () => {
    expect(describePlaybackFailure('VLC could not play this', 'this episode').title).toBe("Couldn't play this episode");
  });
});

describe('describing a provider request that failed', () => {
  // The shape of Angular's HttpErrorResponse, as far as this reads it.
  const failed = (status: number) => ({ status, name: 'HttpErrorResponse', message: '' });

  it('says the provider did not answer when nothing came back', () => {
    expect(describeProviderError(failed(0), 'categories').message).toContain("didn't answer");
  });

  it('points at the subscription when the sign-in is refused', () => {
    expect(describeProviderError(failed(401), 'channels').title).toBe('Your provider refused the sign-in');
  });

  it('blames the provider for its own errors', () => {
    expect(describeProviderError(failed(502), 'channels').message).toContain('having problems');
  });
});

describe('the details behind a failure', () => {
  it("keep the player's own words", () => {
    expect(describePlaybackFailure(FOUR_K_DOLBY).detail).toBe(FOUR_K_DOLBY);
  });

  it("give the status and what the server said", () => {
    const failure = { status: 409, statusText: 'Conflict', name: 'HttpErrorResponse', message: 'Http failure', error: { error: 'That username is taken' } };
    expect(technicalDetail(failure)).toBe('HTTP 409 Conflict\nThat username is taken\nHttpErrorResponse: Http failure');
  });

  it('never carry an address, which for a provider holds the password', () => {
    const failure = { status: 0, message: 'Http failure response for http://host.example:8080/player_api.php?username=u&password=p: 0 Unknown Error' };
    const detail = describeProviderError(failure, 'channels').detail ?? '';
    expect(detail).not.toContain('password');
    expect(detail).toContain('[address removed]');
  });

  it('are empty when there is nothing to say', () => {
    expect(technicalDetail(null)).toBe('');
  });
});
