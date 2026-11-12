/**
 * Which copy of a film or show comes first (design round 6, TV-28): the
 * person's languages in their order, then the best picture, and a cinema
 * recording never first unless it is the only copy. Play uses the first.
 *
 * Everything is read from what the provider wrote -- the copy's name, and
 * the category it is filed in -- because that is all a library holds.
 */

/** A provider's tag in front of a name or category: "|EN| ", "[DE] ", "AR - ", "EX-YU: ". */
const LEADING_TAG = /^\s*(?:\|\s*([A-Za-z-]{2,6})\s*\||\[\s*([A-Za-z-]{2,6})\s*\]|([A-Za-z-]{2,6})\s*[-:|]\s)/;

/**
 * Tags as languages. The ex-Yugoslav tags are Croatian here: what a provider
 * files under EX-YU is in the languages a Croatian viewer reads.
 */
const TAG_LANGUAGES: Record<string, string> = {
  EN: 'en', UK: 'en', US: 'en', GB: 'en', ENG: 'en',
  HR: 'hr', CRO: 'hr', EX: 'hr', EXYU: 'hr', 'EX-YU': 'hr', YU: 'hr', BALKAN: 'hr', BA: 'hr', RS: 'hr', SRB: 'hr',
  DE: 'de', GER: 'de', AT: 'de', CH: 'de',
  AR: 'ar', NL: 'nl', FR: 'fr', ES: 'es', IT: 'it', TR: 'tr', PL: 'pl', PT: 'pt', AL: 'sq', HI: 'hi', IN: 'hi', SE: 'sv', RU: 'ru',
  GR: 'el', IR: 'fa', RO: 'ro', BG: 'bg', HU: 'hu', CZ: 'cs', SK: 'sk', SI: 'sl', SLO: 'sl', MK: 'mk',
  UA: 'uk', JP: 'ja', KR: 'ko', CN: 'zh', IL: 'he', DK: 'da', NO: 'nb', FI: 'fi', BR: 'pt', LAT: 'es', LATAM: 'es'
};

/** The language a copy is in, from its name or else its category; '' when neither says. */
export function copyLanguage(name: string, category = ''): string {
  for (const text of [name, category]) {
    const match = LEADING_TAG.exec(text);
    const tag = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').toUpperCase();
    if (TAG_LANGUAGES[tag]) {
      return TAG_LANGUAGES[tag];
    }
  }
  return '';
}

/** How good the picture is: 3 for 4K, 2 for full HD, 1 for HD, 0 when nothing says. */
export function copyQuality(name: string, category = ''): number {
  const text = `${name} ${category}`;
  if (/\b(?:4k|uhd|2160p?)\b/i.test(text)) return 3;
  if (/\b(?:fhd|1080p?)\b/i.test(text)) return 2;
  if (/\b(?:hd|720p?)\b/i.test(text)) return 1;
  return 0;
}

/** Whether a copy was filmed in a cinema: poorer picture and sound. */
export function isCinemaRecording(name: string, category = ''): boolean {
  return /\b(?:cam|hdcam|camrip|ts|hdts|telesync)\b/i.test(`${name} ${category}`);
}

/**
 * The copies in the order Play should try them. `languages` is the person's
 * own, first preferred; copies in none of them come after, then cinema
 * recordings, each group best picture first and otherwise as given.
 */
export function orderCopies<T>(copies: readonly T[], languages: readonly string[], read: (copy: T) => { name: string; category?: string }): T[] {
  const ranked = copies.map((copy, index) => {
    const { name, category = '' } = read(copy);
    const language = languages.indexOf(copyLanguage(name, category));
    return {
      copy,
      index,
      cinema: isCinemaRecording(name, category) ? 1 : 0,
      language: language < 0 ? languages.length : language,
      quality: copyQuality(name, category)
    };
  });
  ranked.sort((a, b) => a.cinema - b.cinema || a.language - b.language || b.quality - a.quality || a.index - b.index);
  return ranked.map(entry => entry.copy);
}

/** The quality as a copy row shows it in its box (TV-28): "4K", "HD", or nothing. */
export function copyQualityLabel(name: string, category = ''): string {
  const quality = copyQuality(name, category);
  return quality >= 3 ? '4K' : quality >= 1 ? 'HD' : '';
}
