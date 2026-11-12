/**
 * Recordings planned for the account (private plan: recording): booked on any
 * device, recorded by the one named. Each travels as a setting of its own,
 * `recording:<id>`, so two devices booking at once cannot lose each other's,
 * and a booking is cancelled by deleting its key. The devices that can record
 * say so under `recorder:<key>`, which is how a phone knows the television is
 * there to book for.
 *
 * No address travels: a booking names the channel, and the device that
 * records it asks its own provider for the stream when the booking reaches
 * it (RecordingsService.reconcile).
 */

import { SETTING_KEYS } from '../types';

export const BOOKING_PREFIX = 'recording:';
export const RECORDER_PREFIX = 'recorder:';
/** How recordings are made, for the account: minutes before and after, and how long they are kept. */
export const RECORDING_SETTINGS_KEY = SETTING_KEYS.recordingSettings;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A recording booked for a device, as every device sees it. */
export interface PlannedRecording {
  id: string;
  /** The key of the device that records it (`RecorderDevice.key`). */
  device: string;
  channelId: string;
  channel: string;
  title: string;
  /** The programme's own times, from the guide. */
  startMs: number;
  stopMs: number;
}

export const bookingKey = (id: string): `${typeof BOOKING_PREFIX}${string}` => `${BOOKING_PREFIX}${id}`;

export function writePlanned(one: PlannedRecording): string {
  const { id, device, channelId, channel, title, startMs, stopMs } = one;
  return JSON.stringify({ id, device, channelId, channel, title, startMs, stopMs });
}

/** Every well-formed booking among an account's settings, soonest first. */
export function readPlanned(settings: Record<string, string>): PlannedRecording[] {
  const found: PlannedRecording[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (!key.startsWith(BOOKING_PREFIX)) {
      continue;
    }
    try {
      const one = JSON.parse(value) as Record<string, unknown>;
      const planned: PlannedRecording = {
        id: String(one['id'] ?? ''),
        device: String(one['device'] ?? ''),
        channelId: String(one['channelId'] ?? ''),
        channel: String(one['channel'] ?? ''),
        title: String(one['title'] ?? ''),
        startMs: Number(one['startMs']) || 0,
        stopMs: Number(one['stopMs']) || 0
      };
      if (ID.test(planned.id) && key === bookingKey(planned.id) && planned.device && planned.channelId && planned.stopMs > planned.startMs) {
        found.push(planned);
      }
    } catch {
      // Not a booking anyone could act on.
    }
  }
  return found.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
}

/** A device that records, as it announces itself. */
export interface RecorderDevice {
  key: string;
  name: string;
  kind: 'tv' | 'phone' | 'desktop';
  /** When it last said so: a device not heard from in a long while is offered last. */
  seenAt: number;
}

export const recorderKey = (deviceKey: string): `${typeof RECORDER_PREFIX}${string}` => `${RECORDER_PREFIX}${deviceKey}`;

export function writeRecorder(device: RecorderDevice): string {
  return JSON.stringify({ name: device.name, kind: device.kind, seenAt: device.seenAt });
}

/** The devices that record, most recently heard from first. */
export function readRecorders(settings: Record<string, string>): RecorderDevice[] {
  const found: RecorderDevice[] = [];
  for (const [key, value] of Object.entries(settings)) {
    const deviceKey = key.slice(RECORDER_PREFIX.length);
    if (!key.startsWith(RECORDER_PREFIX) || !ID.test(deviceKey)) {
      continue;
    }
    try {
      const one = JSON.parse(value) as Record<string, unknown>;
      const kind = one['kind'] === 'tv' || one['kind'] === 'phone' || one['kind'] === 'desktop' ? one['kind'] : 'desktop';
      found.push({ key: deviceKey, name: String(one['name'] ?? '').slice(0, 60) || 'A device', kind, seenAt: Number(one['seenAt']) || 0 });
    } catch {
      // Left out.
    }
  }
  return found.sort((a, b) => b.seenAt - a.seenAt);
}

/** The recorder a name or key on the command line means, ignoring case; null for none or more than one. */
export function recorderNamed(recorders: readonly RecorderDevice[], said: string): RecorderDevice | null {
  const wanted = said.trim().toLowerCase();
  const byKey = recorders.find(one => one.key.toLowerCase() === wanted);
  if (byKey) {
    return byKey;
  }
  const byName = recorders.filter(one => one.name.toLowerCase() === wanted);
  return byName.length === 1 ? byName[0] : null;
}

export interface RecordingSettings {
  /** Minutes recording starts before the programme does. */
  beforeMin: number;
  /** Minutes it goes on after the guide says the programme ends: programmes overrun. */
  afterMin: number;
  /** Days a finished recording is kept; null for until it is deleted. */
  keepDays: number | null;
}

export const RECORDING_DEFAULTS: RecordingSettings = { beforeMin: 1, afterMin: 2, keepDays: null };
const MOST_MINUTES = 60;
const MOST_DAYS = 365;

const minutes = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return value != null && value !== '' && Number.isFinite(n) ? Math.min(MOST_MINUTES, Math.max(0, Math.round(n))) : fallback;
};

export function readRecordingSettings(value: string | null | undefined): RecordingSettings {
  let held: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(value ?? '{}') as unknown;
    held = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    // The defaults.
  }
  const days = Number(held['keepDays']);
  return {
    beforeMin: minutes(held['beforeMin'], RECORDING_DEFAULTS.beforeMin),
    afterMin: minutes(held['afterMin'], RECORDING_DEFAULTS.afterMin),
    keepDays: held['keepDays'] != null && Number.isFinite(days) && days >= 1 ? Math.min(MOST_DAYS, Math.round(days)) : null
  };
}

export function writeRecordingSettings(settings: RecordingSettings): string {
  return JSON.stringify(readRecordingSettings(JSON.stringify(settings)));
}

/** When a booking's recorder starts and stops, with the account's minutes before and after. */
export function recordingWindow(planned: Pick<PlannedRecording, 'startMs' | 'stopMs'>, settings: RecordingSettings): { startMs: number; endsAt: number } {
  return { startMs: planned.startMs - settings.beforeMin * 60_000, endsAt: planned.stopMs + settings.afterMin * 60_000 };
}

/**
 * What a recording device does with the account's bookings, given what it
 * has booked itself and what it has recorded:
 *
 * - `book`: bookings for it that it has not booked yet;
 * - `cancel`: its own bookings the account no longer has (cancelled elsewhere);
 * - `forget`: account bookings that are finished with -- recorded already,
 *   or over -- whose keys it deletes. Only the device a booking is for
 *   forgets it while it might still record; anyone forgets one long over.
 */
export function reconcile(
  planned: readonly PlannedRecording[],
  device: string,
  booked: readonly { id: string }[],
  recorded: readonly { id: string }[],
  nowMs: number,
  settings: RecordingSettings
): { book: PlannedRecording[]; cancel: string[]; forget: string[] } {
  const bookedIds = new Set(booked.map(one => one.id));
  const recordedIds = new Set(recorded.map(one => one.id));
  const plannedIds = new Set(planned.map(one => one.id));
  const book: PlannedRecording[] = [];
  const forget: string[] = [];
  for (const one of planned) {
    const over = recordingWindow(one, settings).endsAt <= nowMs;
    const mine = one.device === device;
    if ((mine && (over || recordedIds.has(one.id))) || (!mine && over && nowMs - one.stopMs > LONG_OVER_MS)) {
      forget.push(one.id);
    } else if (mine && !bookedIds.has(one.id)) {
      book.push(one);
    }
  }
  const cancel = booked.map(one => one.id).filter(id => !plannedIds.has(id) && !recordedIds.has(id));
  return { book, cancel, forget };
}

/** How long past its end another device waits before clearing a booking away: its own device may have been off. */
const LONG_OVER_MS = 24 * 60 * 60 * 1000;

/**
 * The finished recordings the account no longer keeps: made more than
 * `keepDays` days ago. None while the setting is "until deleted", and never
 * one still recording.
 */
export function expiredRecordings<T extends { id: string; state: string; startedAt: number }>(recordings: readonly T[], keepDays: number | null, nowMs: number): T[] {
  if (keepDays === null) {
    return [];
  }
  const before = nowMs - keepDays * 24 * 60 * 60 * 1000;
  return recordings.filter(one => one.state !== 'recording' && one.startedAt > 0 && one.startedAt < before);
}

// --- every episode -----------------------------------------------------------

/**
 * Recording every airing of a title on a channel: a rule kept for the account,
 * `recordingRule:<id>`. The device it names books each airing it finds in the
 * guide ahead (`episodesToBook`), as ordinary bookings whose ids say which rule
 * made them; cancelling one of those skips it, rather than having it booked
 * again at the next look.
 */
export const RULE_PREFIX = 'recordingRule:';

export interface RecordingRule {
  id: string;
  device: string;
  channelId: string;
  channel: string;
  /** What the channel calls itself in a guide (its epg_channel_id), to find its programmes. */
  guideId: string | null;
  title: string;
  /** Airings cancelled one by one (`episodeId`s): not booked again. */
  skip: string[];
}

export const ruleKey = (id: string): `${typeof RULE_PREFIX}${string}` => `${RULE_PREFIX}${id}`;

/** The id of one airing a rule books: the rule's, and when it starts. */
export const episodeId = (ruleId: string, startMs: number): string => `${ruleId}_${Math.floor(startMs / 1000).toString(36)}`;

/** The rule a booking was made by, if it was. */
export const ruleOf = (bookingId: string): string | null => (bookingId.includes('_') ? bookingId.slice(0, bookingId.indexOf('_')) : null);

/** Skips are only worth keeping while their airing might still be in the guide. */
const MOST_SKIPS = 50;

export function writeRule(rule: RecordingRule): string {
  const { id, device, channelId, channel, guideId, title, skip } = rule;
  return JSON.stringify({ id, device, channelId, channel, guideId, title, skip: skip.slice(-MOST_SKIPS) });
}

export function readRules(settings: Record<string, string>): RecordingRule[] {
  const found: RecordingRule[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (!key.startsWith(RULE_PREFIX)) {
      continue;
    }
    try {
      const one = JSON.parse(value) as Record<string, unknown>;
      const rule: RecordingRule = {
        id: String(one['id'] ?? ''),
        device: String(one['device'] ?? ''),
        channelId: String(one['channelId'] ?? ''),
        channel: String(one['channel'] ?? ''),
        guideId: typeof one['guideId'] === 'string' && one['guideId'] ? one['guideId'] : null,
        title: String(one['title'] ?? ''),
        skip: Array.isArray(one['skip']) ? one['skip'].filter((id): id is string => typeof id === 'string') : []
      };
      // A rule's id has no underscore: an episode's id is the rule's and a time after one.
      if (/^[A-Za-z0-9-]{1,40}$/.test(rule.id) && key === ruleKey(rule.id) && rule.device && rule.channelId && normalTitle(rule.title)) {
        found.push(rule);
      }
    } catch {
      // Left out.
    }
  }
  return found.sort((a, b) => a.title.localeCompare(b.title));
}

const normalTitle = (title: string): string => title.trim().replace(/\s+/g, ' ').toLowerCase();

/** Whether a programme is the rule's title: the same words, whatever the case and spacing. */
export function sameTitle(a: string, b: string): boolean {
  return normalTitle(a) !== '' && normalTitle(a) === normalTitle(b);
}

/**
 * The airings of a rule's title still to come in the programmes given (the
 * guide ahead for its channel), not skipped and not booked already.
 */
export function episodesToBook(
  rule: RecordingRule,
  programmes: readonly { title: string; start: number; stop: number }[],
  planned: readonly { id: string }[],
  nowMs: number
): PlannedRecording[] {
  const known = new Set([...planned.map(one => one.id), ...rule.skip]);
  return programmes
    .filter(one => one.start > nowMs && one.stop > one.start && sameTitle(one.title, rule.title))
    .map(one => ({
      id: episodeId(rule.id, one.start),
      device: rule.device,
      channelId: rule.channelId,
      channel: rule.channel,
      title: one.title.trim(),
      startMs: one.start,
      stopMs: one.stop
    }))
    .filter((one, index, all) => !known.has(one.id) && all.findIndex(other => other.id === one.id) === index);
}
