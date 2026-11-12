/**
 * Stream URL Building Utilities
 */

import { StreamType } from '@shared/types';

/*
 * buildStreamUrl used to live here. It embedded the Xtream username and
 * password directly in the <video> src, putting them in the DOM, in page
 * source and in any Referer header. In a browser, playback URLs are issued by
 * the backend via XtreamService.getPlaybackUrl and carry an opaque ticket
 * instead.
 *
 * A packaged app builds one locally again, and that is not the same mistake:
 * there is no page source to read, no third-party script, and it is the only
 * way for a device to play anything without the backend proxying the video.
 * What does still apply is that such a URL must never be written down --
 * a log line survives long after the frame it described, which is what
 * safeToLog below is for.
 */

/**
 * A playback URL with the credentials taken out, for logging.
 *
 * Xtream puts the username and password in the path -- `/live/user/pass/1.m3u8`
 * -- so a URL is a credential, and Android's log buffer is readable by anything
 * that can take a bug report. This is called at every point one would otherwise
 * be printed.
 *
 * Anything unrecognised is reported as its origin alone. Guessing wrong here
 * means printing a password, so the failure mode is deliberately to say less.
 */
export function safeToLog(url: string | undefined | null): string {
  if (!url) {
    return '(none)';
  }

  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);

    // The Xtream playback shape: a kind, then the two secrets, then the id.
    const kind = segments[0];
    if (segments.length >= 4 && ['live', 'movie', 'series'].includes(kind)) {
      const rest = segments.slice(3).join('/');
      return `${parsed.origin}/${kind}/***/***/${rest}`;
    }

    // A backend ticket URL, which carries no credentials, is safe as it is.
    if (parsed.pathname.includes('/api/streams/play/')) {
      return `${parsed.origin}${parsed.pathname}`;
    }

    // A guide URL keeps its credentials in the query string rather than the
    // path -- `xmltv.php?username=...&password=...` is the usual shape. The
    // names of the parameters are worth seeing and their values never are, and
    // the path stays hidden for the same reason it always did.
    if (parsed.search) {
      const names = [...new Set(parsed.searchParams.keys())].join(', ');
      return `${parsed.origin} (path hidden, query: ${names})`;
    }

    return `${parsed.origin} (path hidden)`;
  } catch {
    return '(unparseable url)';
  }
}

/**
 * Extract stream type from stream object
 * @param stream Stream object with optional type property
 * @param fallbackType Fallback stream type
 * @returns Stream type
 */
export function getStreamType(stream: { type?: string; stream_type?: string }, fallbackType?: StreamType): StreamType | null {
  const type = stream.type || stream.stream_type || fallbackType;
  
  // Map "movie" to "vod" for consistency
  if (type === 'movie') {
    return 'vod';
  }
  
  // A provider's own stream_type is passed on as it came, as it always was.
  return (type as StreamType | undefined) || null;
}

/**
 * Validate stream URL
 * @param url Stream URL to validate
 * @returns True if URL is valid
 */
export function isValidStreamUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
  } catch {
    return false;
  }
}
