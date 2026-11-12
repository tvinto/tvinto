/**
 * What went wrong, in words about the viewer's situation.
 *
 * A player reports ERROR_CODE_IO_BAD_HTTP_STATUS, or "no decoder on this device
 * managed dolby-vision 3840x1600 (ERROR_CODE_DECODING_FAILED)"; a provider
 * request fails with a status or with nothing. Those were shown as they came,
 * or not at all. These turn them into a title that says what happened and a
 * line that says what, if anything, can be done about it.
 */
import { t } from './i18n';

export interface FailureMessage {
  title: string;
  message: string;
  /**
   * What the player or the server said, for the error dialog's Details:
   * the words above are about the viewer's situation, and these are for
   * finding out what happened (5 October).
   */
  detail?: string;
}

/**
 * Anything that looks like an address, taken out: a provider's addresses carry
 * the subscription's username and password in their path or query, and an
 * error repeats the address it failed on.
 */
export const withoutAddresses = (text: string): string =>
  text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[address removed]');

/**
 * A failure's technical side, as lines: the HTTP status, what the server said
 * in its body, and the error's own message. Empty when there is nothing.
 */
export function technicalDetail(error: unknown): string {
  if (error === null || error === undefined) {
    return '';
  }
  if (typeof error === 'string') {
    return withoutAddresses(error).trim();
  }
  const lines: string[] = [];
  const failure = error as { status?: unknown; statusText?: unknown; error?: unknown; message?: unknown; name?: unknown };
  if (typeof failure.status === 'number') {
    lines.push(`HTTP ${failure.status}${typeof failure.statusText === 'string' && failure.statusText ? ' ' + failure.statusText : ''}`);
  }
  const said = serverSaid(failure.error);
  if (said) {
    lines.push(said);
  }
  if (typeof failure.message === 'string' && failure.message && !lines.some(line => line.includes(failure.message as string))) {
    lines.push(typeof failure.name === 'string' && failure.name !== 'Error' ? `${failure.name}: ${failure.message}` : failure.message);
  }
  return withoutAddresses(lines.join('\n')).slice(0, 2000).trim();
}

/** The body of a failed response: the sync service's `{ error }`, or text. */
const serverSaid = (body: unknown): string => {
  if (typeof body === 'string') {
    return body.slice(0, 600);
  }
  if (body && typeof body === 'object') {
    const named = (body as { error?: unknown; message?: unknown }).error ?? (body as { message?: unknown }).message;
    if (typeof named === 'string') {
      return named;
    }
    try {
      return JSON.stringify(body).slice(0, 600);
    } catch {
      return '';
    }
  }
  return '';
};

/** A picture this big is more than any TV box decodes in software. */
const BEYOND_SOFTWARE = { width: 2560, height: 1440 };

/** The size a player named in its failure, if it named one. */
export const failedPictureSize = (errorCode: string | null): { width: number; height: number } | null => {
  const match = errorCode ? /(\d{3,5})x(\d{3,5})/.exec(errorCode) : null;
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
};

/** Whether decoding failed on a picture no software decoder on a TV box could keep up with. */
export const tooBigToDecodeInSoftware = (errorCode: string | null): boolean => {
  const size = failedPictureSize(errorCode);
  return !!size && (size.width >= BEYOND_SOFTWARE.width || size.height >= BEYOND_SOFTWARE.height);
};

export const isDecodingFailure = (errorCode: string | null): boolean =>
  !!errorCode && /decod|format_exceeds|format_unsupported|no decoder/i.test(errorCode);

/** A film, an episode or a channel that would not play. */
export const describePlaybackFailure = (errorCode: string, what = t('playback.this')): FailureMessage => ({
  ...playbackWords(errorCode, what),
  detail: withoutAddresses(errorCode)
});

const playbackWords = (errorCode: string, what: string): FailureMessage => {
  if (errorCode === 'RECORDING_HOLDS_CONNECTION') {
    return { title: t('playback.recordingHolds'), message: t('playback.recordingHoldsHelp') };
  }
  if (isDecodingFailure(errorCode)) {
    const size = failedPictureSize(errorCode);
    const hdr = /dolby|vision|hdr|bt2020|10.?bit/i.test(errorCode);
    const big = tooBigToDecodeInSoftware(errorCode);
    const format = [big ? '4K' : size ? `${size.height}p` : null, hdr ? 'HDR' : null, /hevc|h265|dolby/i.test(errorCode) ? 'HEVC' : null]
      .filter(Boolean)
      .join(' ');
    return {
      title: format ? t('playback.cannotPlayFormat', { format }) : t('playback.cannotPlayThisFormat'),
      message: big
        ? `${t('playback.noDecoder', { what: capitalise(what) })} ${t('playback.lowerQualityWillPlay')}`
        : t('playback.noDecoder', { what: capitalise(what) })
    };
  }
  if (/BAD_HTTP_STATUS|FILE_NOT_FOUND|refused|403|404/i.test(errorCode)) {
    return {
      title: t('playback.refused'),
      message: t('playback.refusedHelp')
    };
  }
  if (/NETWORK|TIMEOUT|CONNECTION|UNREACHABLE/i.test(errorCode)) {
    return {
      title: t('playback.unreachable'),
      message: t('playback.unreachableHelp')
    };
  }
  if (/PARSING|MALFORMED|CONTAINER/i.test(errorCode)) {
    return {
      title: t('playback.damaged'),
      message: t('playback.damagedHelp')
    };
  }
  if (/BEHIND_LIVE_WINDOW/i.test(errorCode)) {
    return { title: t('playback.behind'), message: t('playback.behindHelp') };
  }
  return { title: t('playback.couldNotPlay', { what }), message: t('playback.couldNotPlayHelp') };
};

/** A request to the IPTV provider -- categories, channels, films -- that failed. */
export const describeProviderError = (error: unknown, loading: string): FailureMessage => ({
  ...providerWords(error, loading),
  detail: technicalDetail(error)
});

const providerWords = (error: unknown, loading: string): FailureMessage => {
  // Read off the error rather than tested for with `instanceof HttpErrorResponse`,
  // which would tie this to Angular for the sake of one number.
  const status = readStatus(error);
  const timedOut = error instanceof Error && /timeout/i.test(error.name + error.message);

  if (timedOut || status === 0) {
    return {
      title: t('provider.couldNotLoad', { what: loading }),
      message: t('provider.noAnswer')
    };
  }
  if (status === 401 || status === 403) {
    return {
      title: t('provider.refusedSignIn'),
      message: t('provider.refusedSignInHelp')
    };
  }
  if (status === 404) {
    return { title: t('provider.couldNotLoad', { what: loading }), message: t('provider.gone') };
  }
  if (status !== null && status >= 500) {
    return {
      title: t('provider.couldNotLoad', { what: loading }),
      message: t('provider.troubled')
    };
  }
  return { title: t('provider.couldNotLoad', { what: loading }), message: t('provider.somethingWrong') };
};

const readStatus = (error: unknown): number | null => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
};

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
