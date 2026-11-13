/**
 * EPG Share (epgshare01.online): free XMLTV guides, one or more files per
 * country, suggested in onboarding, on the Guides page and by
 * `tvinto guide suggest`.
 *
 * The list is kept here rather than read from their site. They publish a
 * plain directory listing and no index meant for programs, and the files
 * are a third party's: the app fetches a file only when somebody adds it.
 * Read by hand from https://epgshare01.online/epgshare01/ on 13 November
 * 2026; files for services rather than countries (PLEX1, BEIN1, ...) and
 * ALL_SOURCES1, too large for a television, are left out.
 *
 * Where a country has several files the one suggested is first: the largest
 * of them on that day, since IN2, PH1 and SA1 held almost nothing.
 */

export const EPG_SHARE_BASE = 'https://epgshare01.online/epgshare01/';
export const EPG_SHARE_HOST = 'epgshare01.online';

/** Each country EPG Share covers: its English name, and its files, the suggested one first. */
export const EPG_SHARE_COUNTRIES: Readonly<Record<string, { name: string; files: readonly string[] }>> = {
  AE: { name: 'United Arab Emirates', files: ['AE1'] },
  AL: { name: 'Albania', files: ['AL1'] },
  AR: { name: 'Argentina', files: ['AR1'] },
  AT: { name: 'Austria', files: ['AT1'] },
  AU: { name: 'Australia', files: ['AU1'] },
  BA: { name: 'Bosnia and Herzegovina', files: ['BA1'] },
  BB: { name: 'Barbados', files: ['BB1'] },
  BE: { name: 'Belgium', files: ['BE2'] },
  BG: { name: 'Bulgaria', files: ['BG1'] },
  BR: { name: 'Brazil', files: ['BR1', 'BR2'] },
  CA: { name: 'Canada', files: ['CA2'] },
  CH: { name: 'Switzerland', files: ['CH1'] },
  CL: { name: 'Chile', files: ['CL1'] },
  CO: { name: 'Colombia', files: ['CO1'] },
  CR: { name: 'Costa Rica', files: ['CR1'] },
  CY: { name: 'Cyprus', files: ['CY1'] },
  CZ: { name: 'Czechia', files: ['CZ1'] },
  DE: { name: 'Germany', files: ['DE1'] },
  DK: { name: 'Denmark', files: ['DK1'] },
  DO: { name: 'Dominican Republic', files: ['DO1'] },
  EC: { name: 'Ecuador', files: ['EC1'] },
  EG: { name: 'Egypt', files: ['EG1'] },
  ES: { name: 'Spain', files: ['ES1'] },
  FI: { name: 'Finland', files: ['FI1'] },
  FR: { name: 'France', files: ['FR1'] },
  GB: { name: 'United Kingdom', files: ['UK1'] },
  GR: { name: 'Greece', files: ['GR1'] },
  HK: { name: 'Hong Kong', files: ['HK1'] },
  HR: { name: 'Croatia', files: ['HR1'] },
  HU: { name: 'Hungary', files: ['HU1'] },
  ID: { name: 'Indonesia', files: ['ID1'] },
  IE: { name: 'Ireland', files: ['IE1'] },
  IL: { name: 'Israel', files: ['IL1'] },
  IN: { name: 'India', files: ['IN1', 'IN4', 'IN2'] },
  IT: { name: 'Italy', files: ['IT1'] },
  JM: { name: 'Jamaica', files: ['JM1'] },
  JP: { name: 'Japan', files: ['JP1', 'JP2'] },
  KE: { name: 'Kenya', files: ['KE1'] },
  KR: { name: 'South Korea', files: ['KR1'] },
  KZ: { name: 'Kazakhstan', files: ['KZ1'] },
  LT: { name: 'Lithuania', files: ['LT1'] },
  LU: { name: 'Luxembourg', files: ['LU1'] },
  LV: { name: 'Latvia', files: ['LV1'] },
  MN: { name: 'Mongolia', files: ['MN1'] },
  MT: { name: 'Malta', files: ['MT1'] },
  MX: { name: 'Mexico', files: ['MX1'] },
  MY: { name: 'Malaysia', files: ['MY1'] },
  NG: { name: 'Nigeria', files: ['NG1'] },
  NL: { name: 'Netherlands', files: ['NL1'] },
  NO: { name: 'Norway', files: ['NO1'] },
  NZ: { name: 'New Zealand', files: ['NZ1'] },
  PA: { name: 'Panama', files: ['PA1'] },
  PE: { name: 'Peru', files: ['PE1'] },
  PH: { name: 'Philippines', files: ['PH2', 'PH1'] },
  PK: { name: 'Pakistan', files: ['PK1'] },
  PL: { name: 'Poland', files: ['PL1'] },
  PT: { name: 'Portugal', files: ['PT1'] },
  RO: { name: 'Romania', files: ['RO1', 'RO2'] },
  RS: { name: 'Serbia', files: ['RS1'] },
  SA: { name: 'Saudi Arabia', files: ['SA2', 'SA1'] },
  SE: { name: 'Sweden', files: ['SE1'] },
  SG: { name: 'Singapore', files: ['SG1'] },
  SK: { name: 'Slovakia', files: ['SK1'] },
  SV: { name: 'El Salvador', files: ['SV1'] },
  TH: { name: 'Thailand', files: ['TH1'] },
  TR: { name: 'Turkey', files: ['TR3', 'TR1'] },
  UA: { name: 'Ukraine', files: ['UA1'] },
  US: { name: 'United States', files: ['US2', 'US_LOCALS1', 'US_SPORTS1'] },
  UY: { name: 'Uruguay', files: ['UY1'] },
  VN: { name: 'Vietnam', files: ['VN1'] },
  ZA: { name: 'South Africa', files: ['ZA1'] }
};

/** A file's address: `HR1` → https://epgshare01.online/epgshare01/epg_ripper_HR1.xml.gz. */
export function epgShareUrl(file: string): string {
  return `${EPG_SHARE_BASE}epg_ripper_${file}.xml.gz`;
}

/** What is suggested for one country. */
export interface EpgShareSuggestion {
  /** ISO 3166 code, upper case: `HR`. */
  country: string;
  /** The country's English name, for the stored label. */
  name: string;
  /** The guide suggested: its file and address. */
  file: string;
  url: string;
  /**
   * The label a guide added from it is stored under (`EPG Share · Croatia`):
   * in English because it is stored and synced, and shown in the language in
   * use through `epgShareCountryOfLabel`. Croatia's is the label onboarding
   * gave before there were other countries, so guides added then keep their
   * name.
   */
  label: string;
  /** Every file EPG Share has for the country, the suggested one first. */
  files: readonly string[];
}

/** The suggestion for a country, or null when EPG Share has nothing for it. */
export function epgShareFor(country: string | null | undefined): EpgShareSuggestion | null {
  const code = normaliseRegion(country ?? '');
  const entry = code ? EPG_SHARE_COUNTRIES[code] : undefined;
  if (!code || !entry) {
    return null;
  }
  return {
    country: code,
    name: entry.name,
    file: entry.files[0],
    url: epgShareUrl(entry.files[0]),
    label: `EPG Share · ${entry.name}`,
    files: entry.files
  };
}

/** Every country covered, by code. */
export function epgShareCountries(): string[] {
  return Object.keys(EPG_SHARE_COUNTRIES);
}

/** The country a stored label names (`EPG Share · Croatia` → `HR`), or null for any other label. */
export function epgShareCountryOfLabel(label: string): string | null {
  const match = /^EPG Share · (.+)$/.exec(label);
  if (!match) {
    return null;
  }
  return Object.keys(EPG_SHARE_COUNTRIES).find(code => EPG_SHARE_COUNTRIES[code].name === match[1]) ?? null;
}

/** The country an EPG Share address is for (`.../epg_ripper_UK1.xml.gz` → `GB`), or null. */
export function epgShareCountryOfUrl(url: string): string | null {
  const match = /^https?:\/\/epgshare01\.online\/epgshare01\/epg_ripper_([A-Za-z0-9_]+)\.xml\.gz$/.exec(url.trim());
  if (!match) {
    return null;
  }
  return Object.keys(EPG_SHARE_COUNTRIES).find(code => EPG_SHARE_COUNTRIES[code].files.includes(match[1])) ?? null;
}

/** `uk` → `GB`, `hr` → `HR`; null for anything that is not a two-letter region. */
function normaliseRegion(region: string): string | null {
  const code = region.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    return null;
  }
  return code === 'UK' ? 'GB' : code;
}

/**
 * The region a locale names: `hr-HR` → `HR`, `sr-Latn-RS` → `RS`,
 * `en_GB.UTF-8` (a POSIX LANG) → `GB`; null for `hr` or `en-001`.
 */
export function regionOf(locale: string): string | null {
  const tag = locale.split(/[.@]/)[0];
  const [, ...rest] = tag.split(/[-_]/);
  for (const subtag of rest) {
    if (/^[A-Za-z]{2}$/.test(subtag)) {
      return normaliseRegion(subtag);
    }
    // A script (`Latn`) comes before the region; anything else ends the search.
    if (!/^[A-Za-z]{4}$/.test(subtag)) {
      return null;
    }
  }
  return null;
}

/**
 * The country to suggest a guide for: the first region the device's locales
 * name, and without one the region of the language in use (`hr-HR`, as the
 * app's languages are written). The country may have no guide: then
 * `epgShareFor` gives null and nothing is suggested.
 */
export function suggestedCountry(deviceLocales: readonly string[], languageLocale: string | null): string | null {
  for (const locale of deviceLocales) {
    const region = locale ? regionOf(locale) : null;
    if (region) {
      return region;
    }
  }
  return languageLocale ? regionOf(languageLocale) : null;
}
