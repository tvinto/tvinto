import { open, seal } from '../../shared/auth/secretBox';
import { CATEGORY_SORTS, SETTING_KEYS, STREAM_SORTS, StreamType } from '../../shared/types';
import { hashPin, readCategorySets, readLockSettings, withCategory, writeCategorySets } from '../../shared/categoryLock';
import { hostOf } from '../../shared/providers/providerRecord';
import { PullResult } from '../../shared/sync';
import { Session, untrusted } from './account';
import { Change, Line, Op, currentOf } from './changes';
import { CategoryView } from './provider';
import { FamilyView, isFamilyRole } from '../../shared/family';
import { DESKTOP_PLAYERS, PlayerPreferences, SUBTITLE_SCALES, readPlayerPreferences, writePlayerPreferences } from '../../shared/player';
import { DESCRIPTION_LANGUAGES } from '../../shared/tmdb/describe';
import { openLastChannelValue } from '../../shared/startup';
import { errorReportsValue } from '../../shared/errorReports';
import { LANGUAGES_MAX, LANGUAGE_CHOICES, writeLanguages } from '../../shared/languages';
import { AGE_COUNTRIES, AGE_LIMITS, AgeLock, loosens, readAgeLock, writeAgeLock } from '../../shared/tmdb/age';
import { categoryScope } from '../../shared/xtream/ordering';
import { guideSourceId } from '../../shared/xtream/guideSourceId';
import { isGuideAddress, labelFor } from '../../shared/xtream/guideSources';
import { PROFILE_ANIMALS, isProfilePicture } from '../../shared/profilePicture';

/**
 * The changes tvinto can make, each worked out
 * against what the account holds now and returned for previewing. Nothing
 * here writes anything; `changes.ts` does, with a code.
 */

/** The words a person types for a kind of category. */
export const TYPE_WORDS: Record<string, StreamType> = { live: 'live', movies: 'vod', vod: 'vod', series: 'series', shows: 'series' };

const TYPE_NAMES: Record<StreamType, string> = { live: 'live', vod: 'movie', series: 'series' };

/** The sorts that can be set for the account. "closest" belongs to search, not to a list. */
export const SORTS = {
  categories: CATEGORY_SORTS as readonly string[],
  channels: STREAM_SORTS.filter(sort => sort !== 'closest') as readonly string[]
};

const settingOf = (pulled: PullResult, key: string): string | null => {
  const now = currentOf(pulled, { kind: 'setting', key, value: null });
  return now.kind === 'setting' ? now.value : null;
};

/** A sort for every device of the account, or `default` to leave each device its own. */
export function sortChange(pulled: PullResult, list: 'categories' | 'channels', sort: string, now = Date.now()): Change {
  if (sort !== 'default' && !SORTS[list].includes(sort)) {
    throw new Error(`No sort "${sort}" for ${list}. One of: ${[...SORTS[list], 'default'].join(', ')}`);
  }
  const key = list === 'categories' ? SETTING_KEYS.setUpCategorySort : SETTING_KEYS.setUpStreamSort;
  const value = sort === 'default' ? null : JSON.stringify({ sort, at: new Date(now).toISOString() });
  return {
    lines: [[sort === 'default' ? `Lets each device sort ${list} its own way.` : `Sorts ${list} by ${sort} on every device.`]],
    ops: [{ kind: 'setting', key, value }],
    before: [{ kind: 'setting', key, value: settingOf(pulled, key) }]
  };
}

/** The categories asked for, found in the provider's list, or an error naming the ones not found. */
function find(known: CategoryView[], ids: string[]): CategoryView[] {
  const byId = new Map(known.map(category => [category.id, category]));
  const missing = ids.filter(id => !byId.has(id));
  if (missing.length) {
    throw new Error(`No such category: ${missing.join(', ')}. tvinto categories lists them with their ids.`);
  }
  return ids.map(id => byId.get(id)!);
}

/** The names, quoted, for a line: the first five, and how many more. */
function named(found: CategoryView[]): Line {
  const line: Line = [];
  found.slice(0, 5).forEach((category, i) => {
    line.push(i ? ', ' : '', category.name);
  });
  if (found.length > 5) {
    line.push(`, and ${found.length - 5} more`);
  }
  return line;
}

/**
 * Hides or shows categories. Hiding never needs the PIN; showing one again
 * does whenever there is a PIN (`pinChecked`), so no agent can open up what
 * was kept from somebody.
 */
export function hideChange(
  pulled: PullResult,
  type: StreamType,
  known: CategoryView[],
  ids: string[],
  hide: boolean,
  pinChecked: boolean
): Change {
  if (!hide && readLockSettings(settingOf(pulled, SETTING_KEYS.parentalLock)) && !pinChecked) {
    throw new Error('Showing a hidden category again needs the PIN.');
  }
  const found = find(known, ids);
  const key = SETTING_KEYS.hiddenCategories;
  const before = settingOf(pulled, key);
  let sets = readCategorySets(before);
  const changing = found.filter(category => sets[type].includes(category.id) !== hide);
  if (!changing.length) {
    throw new Error(hide ? 'Those categories are already hidden.' : 'None of those categories is hidden.');
  }
  for (const category of changing) {
    sets = withCategory(sets, type, category.id, hide);
  }
  return {
    lines: [[`${hide ? 'Hides' : 'Shows again'} ${changing.length} ${TYPE_NAMES[type]} ${changing.length === 1 ? 'category' : 'categories'}: `, ...named(changing)]],
    ops: [{ kind: 'setting', key, value: writeCategorySets(sets) }],
    before: [{ kind: 'setting', key, value: before }]
  };
}

/** Locks or unlocks categories behind the PIN, which must exist and have been typed. */
export function lockChange(pulled: PullResult, type: StreamType, known: CategoryView[], ids: string[], lock: boolean, pinChecked: boolean): Change {
  if (!readLockSettings(settingOf(pulled, SETTING_KEYS.parentalLock))) {
    throw new Error('There is no PIN. Choose one in the app first: Account, Parental lock.');
  }
  if (!pinChecked) {
    throw new Error('Locking and unlocking need the PIN.');
  }
  const found = find(known, ids);
  const key = SETTING_KEYS.lockedCategories;
  const before = settingOf(pulled, key);
  let sets = readCategorySets(before);
  const changing = found.filter(category => sets[type].includes(category.id) !== lock);
  if (!changing.length) {
    throw new Error(lock ? 'Those categories are already locked.' : 'None of those categories is locked.');
  }
  for (const category of changing) {
    sets = withCategory(sets, type, category.id, lock);
  }
  return {
    lines: [[`${lock ? 'Locks' : 'Unlocks'} ${changing.length} ${TYPE_NAMES[type]} ${changing.length === 1 ? 'category' : 'categories'}: `, ...named(changing)]],
    ops: [{ kind: 'setting', key, value: writeCategorySets(sets) }],
    before: [{ kind: 'setting', key, value: before }]
  };
}

/** Whether a typed PIN is the account's. */
export async function pinMatches(pulled: PullResult, pin: string): Promise<boolean> {
  const lock = readLockSettings(settingOf(pulled, SETTING_KEYS.parentalLock));
  return Boolean(lock) && (await hashPin(pin, lock!.salt)) === lock!.hash;
}

/** Switches a guide on or off: its sealed payload opened, changed, and sealed again. */
export async function guideChange(current: Session, pulled: PullResult, id: string, enabled: boolean): Promise<Change> {
  const source = (pulled.guideSources ?? []).find(candidate => candidate.id === id);
  if (!source) {
    throw new Error(`No guide ${id}. tvinto guides lists them with their ids.`);
  }
  const opened = await open(source.payload, current.enc);
  const details = opened ? (JSON.parse(opened) as { label?: string; url?: string; enabled?: boolean }) : null;
  if (!details || typeof details.url !== 'string') {
    throw new Error('That guide does not open with this sign-in\'s key.');
  }
  if ((details.enabled !== false) === enabled) {
    throw new Error(`That guide is already ${enabled ? 'on' : 'off'}.`);
  }
  const payload = await seal(JSON.stringify({ ...details, enabled }), current.enc);
  const op: Op = { kind: 'guideSource', id, payload };
  return {
    lines: [[`Switches ${enabled ? 'on' : 'off'} the guide `, untrusted(details.label || hostOf(details.url)), ` (${hostOf(details.url)}).`]],
    ops: [op],
    before: [{ kind: 'guideSource', id, payload: source.payload }]
  };
}

/** Both sides of an op: what it writes, and what is there now. */
export const withBefore = (pulled: PullResult, ops: Op[]): Pick<Change, 'ops' | 'before'> => ({
  ops,
  before: ops.map(op => currentOf(pulled, op))
});

/**
 * Puts categories first, in the order given, ahead of the rest in the order
 * they had. The category sort becomes manual on every device, or the order
 * would not show.
 */
export function orderChange(pulled: PullResult, type: StreamType, known: CategoryView[], ids: string[], now = Date.now()): Change {
  const found = find(known, ids);
  if (new Set(ids).size !== ids.length) {
    throw new Error('A category is named twice.');
  }
  const scope = categoryScope(type);
  const current = currentOf(pulled, { kind: 'arrangement', scope, order: null });
  const was = current.kind === 'arrangement' && current.order ? current.order.itemIds : known.map(category => category.id);
  const rest = [...was, ...known.map(category => category.id)].filter((id, i, all) => !ids.includes(id) && all.indexOf(id) === i);
  const names = Object.fromEntries(known.map(category => [category.id, category.name.untrusted]));
  const ops: Op[] = [{ kind: 'arrangement', scope, order: { itemIds: [...ids, ...rest], names } }];
  const lines: Line[] = [[`Puts first among ${TYPE_NAMES[type]} categories, in this order: `, ...named(found)]];

  const sort = settingOf(pulled, SETTING_KEYS.setUpCategorySort);
  if (!sort || (JSON.parse(sort) as { sort?: string }).sort !== 'manual') {
    ops.push({ kind: 'setting', key: SETTING_KEYS.setUpCategorySort, value: JSON.stringify({ sort: 'manual', at: new Date(now).toISOString() }) });
    lines.push(['Sorts categories by hand (manual) on every device, so the order shows.']);
  }
  return { lines, ...withBefore(pulled, ops) };
}

/** What `tvinto player` can set, and how a word becomes a value. */
const PLAYER_FIELDS: Record<string, { field: keyof PlayerPreferences; read(word: string): PlayerPreferences[keyof PlayerPreferences]; help: string }> = {
  subtitles: { field: 'subtitlesEnabled', read: onOffWord, help: 'on|off' },
  'subtitle-size': {
    field: 'subtitleScale',
    read: word => {
      const size = Number(word.replace(/%$/, ''));
      if (!SUBTITLE_SCALES.includes(size)) {
        throw new Error(`Subtitle size is one of ${SUBTITLE_SCALES.join(', ')}.`);
      }
      return size;
    },
    help: SUBTITLE_SCALES.join('|')
  },
  'subtitle-language': { field: 'subtitleLanguage', read: languageWord, help: 'a code like hr or en, or any' },
  'audio-language': { field: 'audioLanguage', read: languageWord, help: 'a code like hr or en, or any' },
  'subtitle-colour': {
    field: 'subtitleColour',
    read: word => {
      if (!/^#[0-9a-f]{6}$/i.test(word)) {
        throw new Error('Subtitle colour is #rrggbb, like #ffff00.');
      }
      return word.toLowerCase();
    },
    help: '#rrggbb'
  },
  'subtitle-background': { field: 'subtitleBackground', read: word => oneOfWord(word, ['none', 'translucent', 'solid']), help: 'none|translucent|solid' },
  'subtitle-edge': { field: 'subtitleEdge', read: word => oneOfWord(word, ['none', 'outline', 'shadow']), help: 'none|outline|shadow' },
  'frame-rate': { field: 'matchFrameRate', read: onOffWord, help: 'on|off' },
  'skip-intros': { field: 'skipIntros', read: word => oneOfWord(word, ['button', 'auto', 'off']), help: 'button|auto|off' },
  // Where the desktop app plays: inside its window, or mpv's own (shared/player.ts).
  desktop: { field: 'desktopPlayer', read: word => oneOfWord(word, [...DESKTOP_PLAYERS]), help: DESKTOP_PLAYERS.join('|') }
};

export const PLAYER_HELP = Object.entries(PLAYER_FIELDS)
  .map(([name, field]) => `${name} ${field.help}`)
  .join('; ');

function onOffWord(word: string): boolean {
  if (word !== 'on' && word !== 'off') {
    throw new Error('Say on or off.');
  }
  return word === 'on';
}

function languageWord(word: string): string {
  if (word === 'any') {
    return '';
  }
  if (!/^[a-z]{2,3}$/.test(word)) {
    throw new Error('A language is a two- or three-letter code, like hr or en, or any.');
  }
  return word;
}

function oneOfWord(word: string, allowed: string[]): string {
  if (!allowed.includes(word)) {
    throw new Error(`One of: ${allowed.join(', ')}.`);
  }
  return word;
}

/** One of the player's preferences, for every device of the account. */
export function playerChange(pulled: PullResult, name: string, word: string): Change {
  const field = PLAYER_FIELDS[name];
  if (!field) {
    throw new Error(`No player setting "${name}". One of: ${Object.keys(PLAYER_FIELDS).join(', ')}.`);
  }
  const key = SETTING_KEYS.player;
  const now = readPlayerPreferences(settingOf(pulled, key));
  const value = field.read(word);
  if (now[field.field] === value) {
    throw new Error(`The player's ${name} is already ${word}.`);
  }
  return {
    lines: [[`Sets the player's ${name} to ${word} on every device.`]],
    ...withBefore(pulled, [{ kind: 'setting', key, value: writePlayerPreferences({ ...now, [field.field]: value }) }])
  };
}

/** Whose words describe films and shows: the provider's, or TMDB's in a language. */
export function descriptionsChange(pulled: PullResult, language: string): Change {
  if (!(DESCRIPTION_LANGUAGES as readonly string[]).includes(language)) {
    throw new Error(`Descriptions: one of ${DESCRIPTION_LANGUAGES.join(', ')}.`);
  }
  return {
    lines: [[language === 'provider' ? "Shows the provider's own descriptions." : `Shows descriptions from TMDB in ${language}.`]],
    ...withBefore(pulled, [{ kind: 'setting', key: SETTING_KEYS.descriptionLanguage, value: language }])
  };
}

/** Whether a television opens into the last channel watched. */
export function lastChannelChange(pulled: PullResult, on: boolean): Change {
  return {
    lines: [[on ? 'Televisions open into the last channel watched.' : 'Televisions open on For You.']],
    ...withBefore(pulled, [{ kind: 'setting', key: SETTING_KEYS.openLastChannel, value: openLastChannelValue(on) }])
  };
}

/** Whether this account's devices send error reports (shared/errorReports.ts). */
export function errorReportsChange(pulled: PullResult, on: boolean): Change {
  return {
    lines: [
      [
        on
          ? 'Your devices send a report when something goes wrong: the error, the app version and the device, nothing personal.'
          : 'Your devices stop sending error reports.'
      ]
    ],
    ...withBefore(pulled, [{ kind: 'setting', key: SETTING_KEYS.errorReports, value: errorReportsValue(on) }])
  };
}

/**
 * Locks films and shows by age rating (TV-31). Like the locked categories it
 * needs a PIN to exist; tightening it does not need the PIN typed, opening
 * anything up does -- so no agent can loosen what was kept from somebody.
 */
export function ageLockChange(pulled: PullResult, limit: string, country: string | undefined, pinChecked: boolean): Change {
  const age = limit === 'off' ? 0 : Number(limit);
  if (!(AGE_LIMITS as readonly number[]).includes(age)) {
    throw new Error(`Age lock: off, or one of ${AGE_LIMITS.filter(Boolean).join(', ')}.`);
  }
  const before = readAgeLock(settingOf(pulled, SETTING_KEYS.ageLock));
  const code = (country ?? before.country).toUpperCase();
  if (!(AGE_COUNTRIES as readonly string[]).includes(code)) {
    throw new Error(`Ratings from: one of ${AGE_COUNTRIES.join(', ')}.`);
  }
  if (age > 0 && !readLockSettings(settingOf(pulled, SETTING_KEYS.parentalLock))) {
    throw new Error('There is no PIN. Choose one in the app first: Account, Parental lock.');
  }
  const next: AgeLock = { limit: age, country: age > 0 ? code : before.country };
  if (next.limit === before.limit && (next.limit === 0 || next.country === before.country)) {
    throw new Error(age ? `Titles rated ${age} and over are already locked, by ${code}'s ratings.` : 'The age lock is already off.');
  }
  if (loosens(before, next) && !pinChecked) {
    throw new Error('Opening anything up needs the PIN.');
  }
  return {
    lines: [[age ? `Locks films and shows rated ${age} and over, by ${code}'s ratings, then Germany's and the United States'. Unrated titles stay open.` : 'Takes the age lock off.']],
    ...withBefore(pulled, [{ kind: 'setting', key: SETTING_KEYS.ageLock, value: writeAgeLock(next) }])
  };
}

/** Whether a television plays the channel in focus above the guide. */
export function previewChange(pulled: PullResult, on: boolean): Change {
  return {
    lines: [[on ? 'Televisions play the channel in focus above the guide.' : 'Televisions show no channel preview above the guide.']],
    ...withBefore(pulled, [{ kind: 'setting', key: SETTING_KEYS.channelPreview, value: on ? 'on' : 'off' }])
  };
}

/** The languages copies and trailers are offered in, first first; 'default' for the app's language, then English. */
export function languagesChange(pulled: PullResult, codes: string[]): Change {
  const reset = codes.length === 1 && codes[0] === 'default';
  const list = reset ? [] : codes.map(code => code.toLowerCase());
  const unknown = list.filter(code => !(LANGUAGE_CHOICES as readonly string[]).includes(code));
  if (unknown.length) {
    throw new Error(`Not a language here: ${unknown.join(', ')}. One of ${LANGUAGE_CHOICES.join(', ')}.`);
  }
  if (new Set(list).size !== list.length || list.length > LANGUAGES_MAX) {
    throw new Error(`Up to ${LANGUAGES_MAX} languages, each once.`);
  }
  return {
    lines: [[reset ? "Copies and trailers in the app's language, then English." : `Copies and trailers in this order: ${list.join(', ')}.`]],
    ...withBefore(pulled, [{ kind: 'setting', key: SETTING_KEYS.languages, value: writeLanguages(list) }])
  };
}

/** Whether a change to the age lock would open anything up, for asking the PIN first. */
export function ageLockLoosens(pulled: PullResult, limit: string, country: string | undefined): boolean {
  const before = readAgeLock(settingOf(pulled, SETTING_KEYS.ageLock));
  const age = limit === 'off' ? 0 : Number(limit);
  return loosens(before, { limit: Number.isFinite(age) ? age : 0, country: (country ?? before.country).toUpperCase() });
}

/**
 * Adds a guide, sealed under the account's key. The address arrives from a
 * person at a terminal (cli.ts): an Xtream guide's address holds the login.
 */
export async function guideAddChange(current: Session, pulled: PullResult, url: string, label?: string): Promise<Change> {
  const address = url.trim();
  if (!isGuideAddress(address)) {
    throw new Error('That is not a guide address: it starts with http:// or https://.');
  }
  const id = guideSourceId(address);
  if ((pulled.guideSources ?? []).some(source => source.id === id)) {
    throw new Error('The account already has that guide.');
  }
  const name = label?.trim() || labelFor(address);
  const at = new Date().toISOString();
  const payload = await seal(JSON.stringify({ label: name, url: address, enabled: true, addedAt: at }), current.enc);
  return {
    lines: [['Adds the guide ', untrusted(name), ` (${hostOf(address)}). Each device offers to load it.`]],
    ...withBefore(pulled, [{ kind: 'guideSource', id, payload }])
  };
}

/** Removes a guide, and every channel matched to it by hand -- all of it put back by an undo. */
export async function guideRemoveChange(current: Session, pulled: PullResult, id: string): Promise<Change> {
  const source = (pulled.guideSources ?? []).find(candidate => candidate.id === id);
  if (!source) {
    throw new Error(`No guide ${id}. tvinto guides lists them with their ids.`);
  }
  const opened = await open(source.payload, current.enc);
  const details = opened ? (JSON.parse(opened) as { label?: string; url?: string }) : {};
  const host = typeof details.url === 'string' ? hostOf(details.url) : 'unknown host';
  const matches = (pulled.channelMappings ?? []).filter(mapping => mapping.sourceId === id);
  const ops: Op[] = [
    { kind: 'guideSource', id, payload: null },
    ...matches.map(mapping => ({ kind: 'channelMapping' as const, streamId: mapping.streamId, match: null }))
  ];
  return {
    lines: [
      ['Removes the guide ', untrusted(details.label || host), ` (${host})${matches.length ? `, and the ${matches.length} channels matched to it by hand` : ''}.`]
    ],
    ...withBefore(pulled, ops)
  };
}

/** A family member's role, or whether it is a profile on its managers' devices. */
export function memberChange(
  pulled: PullResult,
  family: FamilyView,
  name: string,
  change: { role?: string; household?: boolean }
): Change {
  const member = family.members.find(candidate => candidate.username.toLowerCase() === name.trim().toLowerCase());
  if (!member) {
    throw new Error(`Nobody called ${JSON.stringify(name)} in the family below this account.`);
  }
  if (change.role !== undefined && !isFamilyRole(change.role)) {
    throw new Error('A role is admin, member or kid.');
  }
  const role = change.role ?? member.role;
  const household = change.household ?? member.household;
  if (role === member.role && household === member.household) {
    throw new Error('Nothing would change.');
  }
  const who = untrusted(member.username);
  const line: Line =
    change.role !== undefined
      ? ['Makes ', who, role === 'admin' ? ' an admin.' : ` a ${role}.`]
      : household
        ? ['Shows ', who, " as a profile on this account's own devices."]
        : ['Stops showing ', who, " as a profile on this account's own devices."];
  return {
    lines: [line],
    ops: [{ kind: 'member', memberId: member.id, role, household }],
    before: [currentOf(pulled, { kind: 'member', memberId: member.id, role, household }, family)]
  };
}

/**
 * A profile picture: `auto` (the animal from the name), one of the animals,
 * or an image already made small -- JPEG, PNG or WebP, under about 45 KB,
 * square looks best (256 pixels across). tvinto does not resize: the app
 * does, from a photo of any size. For this account, or for a member named.
 */
export function pictureChange(pulled: PullResult, family: FamilyView, choice: string, memberName?: string): Change {
  const member =
    memberName === undefined
      ? null
      : family.members.find(candidate => candidate.username.toLowerCase() === memberName.trim().toLowerCase());
  if (memberName !== undefined && !member) {
    throw new Error(`Nobody called ${JSON.stringify(memberName)} in the family below this account.`);
  }
  const picture = choice === 'auto' ? null : choice.startsWith('data:') ? choice : `animal:${choice}`;
  if (!isProfilePicture(picture)) {
    throw new Error(`A picture is auto, one of ${PROFILE_ANIMALS.join(', ')}, or a small JPEG, PNG or WebP file.`);
  }
  const memberId = member ? member.id : null;
  const now = member ? (member.picture ?? null) : (family.me.picture ?? null);
  if (now === picture) {
    throw new Error('Nothing would change.');
  }
  const whose: Line = member ? ["Sets ", untrusted(member.username), "'s picture to "] : ['Sets your picture to '];
  const what =
    picture === null ? 'the animal from the name.' : picture.startsWith('animal:') ? `the ${picture.slice('animal:'.length)}.` : 'the image given.';
  return {
    lines: [[...whose, what]],
    ops: [{ kind: 'picture', memberId, picture }],
    before: [currentOf(pulled, { kind: 'picture', memberId, picture }, family)]
  };
}

/** One channel to tie to one channel of a guide: its id, and its name when tvinto has listed it. */
export interface MatchPair {
  channelId: string;
  channelName: string | null;
  guideChannelId: string;
  guideChannelName: string;
}

/**
 * Ties channels to a guide's channels by hand, for where the provider's own
 * guide ids reach nothing. One code for the lot; an undo puts back whatever
 * each one had, a match by hand or the automatic one.
 */
export function matchChange(pulled: PullResult, guide: { id: string; label: string }, pairs: MatchPair[]): Change {
  if (!pairs.length) {
    throw new Error('Nothing to match.');
  }
  const seen = new Set<string>();
  for (const pair of pairs) {
    if (seen.has(pair.channelId)) {
      throw new Error(`Channel ${pair.channelId} is given twice.`);
    }
    seen.add(pair.channelId);
  }
  const ops: Op[] = pairs.map(pair => ({
    kind: 'channelMapping',
    streamId: pair.channelId,
    match: { sourceId: guide.id, channelId: pair.guideChannelId }
  }));
  return {
    lines: [
      ['In the guide ', untrusted(guide.label), ', matches by hand:'],
      ...pairs.map((pair): Line => [
        '  ',
        pair.channelName ? untrusted(pair.channelName) : pair.channelId,
        ' to ',
        untrusted(pair.guideChannelName),
        ` (${pair.guideChannelId})`
      ])
    ],
    ...withBefore(pulled, ops)
  };
}

/** Puts channels back to automatic matching: the provider's own guide ids, or the name. */
export function unmatchChange(pulled: PullResult, channels: { id: string; name: string | null }[]): Change {
  const matched = new Set((pulled.channelMappings ?? []).map(mapping => mapping.streamId));
  const missing = channels.filter(channel => !matched.has(channel.id));
  if (missing.length) {
    throw new Error(`Not matched by hand: ${missing.map(channel => channel.id).join(', ')}.`);
  }
  const ops: Op[] = channels.map(channel => ({ kind: 'channelMapping', streamId: channel.id, match: null }));
  return {
    lines: [
      ['Matches these automatically again:'],
      ...channels.map((channel): Line => ['  ', channel.name ? untrusted(channel.name) : channel.id])
    ],
    ...withBefore(pulled, ops)
  };
}
