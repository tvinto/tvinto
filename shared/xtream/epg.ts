/**
 * Reading what a provider says is on television.
 *
 * Lifted out of the backend so a device can do it. Xtream Base64-encodes
 * titles and descriptions, XMLTV escapes them as HTML entities, and both are
 * pure text work with nothing server-shaped about them -- the only reason this
 * lived on the server is that it was written with `Buffer`, which a WebView
 * has not got.
 *
 * Everything here uses `atob` and `TextDecoder`, which exist in a browser, in
 * a WebView, in Electron and in Node. The pair matters: `atob` alone returns
 * one character per byte, so a two-byte character arrives as two wrong ones
 * and every Croatian title comes back mangled. Decoding those bytes as UTF-8
 * is the whole job.
 */

/**
 * Base64 to text, as UTF-8.
 *
 * `atob` gives a string of character codes 0-255 -- the raw bytes, one per
 * character. Reading them back out into a byte array and letting TextDecoder
 * interpret them is what turns `Å¾` back into `ž`.
 */
const decodeBase64ToUtf8 = (value: string): string => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder('utf-8').decode(bytes);
};

/** How much of a decoded string is printable, as a fraction. */
const printableFraction = (text: string): number => {
  if (!text.length) {
    return 0;
  }

  let printable = 0;
  for (const character of text) {
    const code = character.charCodeAt(0);
    if ((code >= 32 && code <= 126) || code >= 128) {
      printable += 1;
    }
  }

  return printable / text.length;
};

const BASE64_ALPHABET = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decodes text that appears to be Base64, and leaves everything else alone.
 *
 * Xtream returns some fields encoded and some not, with nothing to say which,
 * so this has to guess. It guesses conservatively: anything short, anything
 * outside the alphabet, and anything that decodes to something unreadable is
 * returned untouched, because showing a title unchanged is a much smaller
 * failure than showing one turned into rubbish.
 */
export const decodeBase64Text = (text: string): string => {
  if (!text || typeof text !== 'string') {
    return text;
  }

  // Below eight characters a false positive is likelier than a real payload.
  if (text.length < 8) {
    return text;
  }

  if (text.length % 4 !== 0 || !BASE64_ALPHABET.test(text)) {
    return text;
  }

  try {
    const decoded = decodeBase64ToUtf8(text);

    if (printableFraction(decoded) > 0.8 && decoded.length > 3 && /[a-zA-Z\s]/.test(decoded)) {
      // Not logged: this runs per title and per description, and a guide
      // covers thousands of channels.
      return decoded;
    }
  } catch {
    // Not Base64 after all, which the alphabet check cannot rule out on its own.
  }

  return text;
};

/**
 * Whether a string is a Base64 payload rather than prose.
 *
 * Stricter than the guess `decodeBase64Text` makes, because XMLTV fields are
 * free-form: anything already readable is left alone.
 */
export const isBase64 = (value: string): boolean => {
  if (!value || value.length < 8) {
    return false;
  }

  // Already-readable text -- containing a space, or opening like a word -- is
  // never treated as Base64.
  if (/\s/.test(value) || /^[A-Z][a-z]+/.test(value)) {
    return false;
  }

  if (!BASE64_ALPHABET.test(value) || value.length % 4 !== 0) {
    return false;
  }

  try {
    const decoded = decodeBase64ToUtf8(value);

    if (printableFraction(decoded) < 0.9 || decoded.length < 5) {
      return false;
    }

    const letters = (decoded.match(/[a-zA-Z]/g) || []).length;
    const spaces = (decoded.match(/\s/g) || []).length;

    return letters / decoded.length > 0.5 && (spaces > 0 || decoded.length < 20);
  } catch {
    return false;
  }
};

/** Decodes a Base64 string, returning the original when it will not decode. */
export const decodeBase64 = (text: string): string => {
  try {
    return decodeBase64ToUtf8(text);
  } catch {
    return text;
  }
};

/** Decodes the HTML entities that commonly survive XMLTV escaping. */
export const decodeHtmlEntities = (text: string): string => {
  if (!text) {
    return '';
  }

  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCharCode(parseInt(decimal, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
};

/** One programme as Xtream's short guide returns it. */
interface RawListing {
  title?: string;
  description?: string;
  lang?: string;
  [key: string]: unknown;
}

/**
 * Decodes the encoded fields of an Xtream guide response, in place.
 *
 * Deliberately permissive about what it is given. This sits directly on a
 * provider response, and providers return absent fields, null, and shapes
 * nobody documented; anything it does not recognise it hands straight back.
 * The type flows through unchanged so callers keep whatever they knew.
 */
export const processEPGListings = <T>(epgData: T): T => {
  const data = epgData as { epg_listings?: RawListing[] } | null | undefined;

  if (!data || !data.epg_listings) {
    return epgData;
  }

  data.epg_listings = data.epg_listings.map(listing => ({
    ...listing,
    title: decodeBase64Text(listing.title as string),
    description: decodeBase64Text(listing.description as string),
    lang: decodeBase64Text(listing.lang as string)
  }));

  return epgData;
};
