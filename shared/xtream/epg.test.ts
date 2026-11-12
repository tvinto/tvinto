import {
  decodeBase64,
  decodeBase64Text,
  decodeHtmlEntities,
  isBase64,
  processEPGListings
} from './epg';

/**
 * Encodes with the same web APIs the module decodes with, rather than with
 * Buffer. This code now runs where Buffer does not exist, and a test helper
 * that quietly relies on Node would hide exactly the failure being guarded
 * against.
 */
const b64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

/** The same, for raw bytes that are not text at all. */
const b64Bytes = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

describe('decodeBase64Text', () => {
  it('decodes the Base64 titles Xtream returns', () => {
    expect(decodeBase64Text(b64('Evening News'))).toBe('Evening News');
  });

  it('leaves plain prose alone', () => {
    expect(decodeBase64Text('Evening News')).toBe('Evening News');
  });

  it('leaves short strings alone, where a false positive is most likely', () => {
    expect(decodeBase64Text('News')).toBe('News');
  });

  it('leaves a non-Base64 alphabet alone', () => {
    expect(decodeBase64Text('Not-Base64-Here!')).toBe('Not-Base64-Here!');
  });

  it('passes through empty and non-string input unchanged', () => {
    expect(decodeBase64Text('')).toBe('');
    expect(decodeBase64Text(null as unknown as string)).toBeNull();
    expect(decodeBase64Text(42 as unknown as string)).toBe(42);
  });

  it('leaves a payload that decodes to binary alone', () => {
    // Valid Base64 by shape, but the bytes are not text.
    const binary = b64Bytes([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(decodeBase64Text(binary)).toBe(binary);
  });
});

describe('isBase64', () => {
  it('recognises an encoded title', () => {
    expect(isBase64(b64('Evening News At Ten'))).toBe(true);
  });

  it('declines a title that merely looks like Base64', () => {
    // From a real feed: matches the Base64 alphabet and length, but is a title.
    expect(isBase64('Peataichean')).toBe(false);
  });

  it('declines anything containing a space', () => {
    expect(isBase64('Evening News')).toBe(false);
  });

  it('declines strings that are too short to judge', () => {
    expect(isBase64('abc')).toBe(false);
    expect(isBase64('')).toBe(false);
  });

  it('declines a string whose length is not a multiple of four', () => {
    expect(isBase64('QWJjZGVmZ2g')).toBe(false);
  });

  it('declines a payload that decodes to mostly non-letters', () => {
    expect(isBase64(b64('1234567890123456'))).toBe(false);
  });
});

describe('decodeBase64', () => {
  it('decodes a payload', () => {
    expect(decodeBase64(b64('Nachrichten'))).toBe('Nachrichten');
  });

  it('round-trips multi-byte text', () => {
    expect(decodeBase64(b64('¡Alto! Frontera Chile'))).toBe('¡Alto! Frontera Chile');
  });

  // The reason this module could not simply be moved. atob returns one
  // character per byte, so without a TextDecoder every one of these arrives
  // as two wrong characters -- which, for this provider, is most of the guide.
  it('round-trips the Croatian characters a WebView would otherwise mangle', () => {
    expect(decodeBase64(b64('Dnevnik — Čudnovate zgode šegrta Hlapića'))).toBe(
      'Dnevnik — Čudnovate zgode šegrta Hlapića'
    );
    expect(decodeBase64(b64('Đuro i Žarko'))).toBe('Đuro i Žarko');
  });

  it('leaves a payload alone when it is not Base64 at all', () => {
    expect(decodeBase64('not base64 !!')).toBe('not base64 !!');
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes the named entities XMLTV escaping leaves behind', () => {
    expect(decodeHtmlEntities('Cops &amp; Robbers')).toBe('Cops & Robbers');
    expect(decodeHtmlEntities('&lt;b&gt;bold&lt;/b&gt;')).toBe('<b>bold</b>');
    expect(decodeHtmlEntities('&quot;quoted&quot;')).toBe('"quoted"');
    expect(decodeHtmlEntities('it&#39;s')).toBe("it's");
    expect(decodeHtmlEntities('it&apos;s')).toBe("it's");
  });

  it('decodes decimal and hexadecimal references', () => {
    expect(decodeHtmlEntities('caf&#233;')).toBe('café');
    expect(decodeHtmlEntities('caf&#xE9;')).toBe('café');
  });

  it('handles several entities in one string', () => {
    expect(decodeHtmlEntities('A &amp; B &lt; C &amp; D')).toBe('A & B < C & D');
  });

  it('returns an empty string for empty input', () => {
    expect(decodeHtmlEntities('')).toBe('');
    expect(decodeHtmlEntities(null as unknown as string)).toBe('');
  });
});

describe('processEPGListings', () => {
  it('decodes every listing in place', () => {
    const result = processEPGListings({
      epg_listings: [
        { id: 1, title: b64('Morning Show'), description: b64('A show in the morning'), lang: 'en' },
        { id: 2, title: 'Already Readable', description: 'Plain text here', lang: 'en' }
      ]
    });

    expect(result.epg_listings[0].title).toBe('Morning Show');
    expect(result.epg_listings[0].description).toBe('A show in the morning');
    expect(result.epg_listings[1].title).toBe('Already Readable');
  });

  it('preserves fields it does not touch', () => {
    const result = processEPGListings({
      epg_listings: [{ id: 7, start: '2026-01-01', title: b64('Show Time'), description: '', lang: '' }]
    });

    expect(result.epg_listings[0].id).toBe(7);
    expect(result.epg_listings[0].start).toBe('2026-01-01');
  });

  it('passes through payloads with no listings', () => {
    expect(processEPGListings(null)).toBeNull();
    expect(processEPGListings({ other: 1 })).toEqual({ other: 1 });
  });
});
