/**
 * Recording a live channel (private plan: recording): what is decided before
 * a recorder starts. The recording itself is native (RecordingService on
 * Android), since a web app in the background cannot keep a stream open.
 */

/** Programmes overrun: a recording goes on this long after the guide says it ends. */
export const AFTER_END_MS = 2 * 60 * 1000;
/** With no guide to say when it ends, a recording lasts this long. */
export const UNKNOWN_LENGTH_MS = 60 * 60 * 1000;
/** And never longer than this, whatever the guide says: a wrong stop time must not record all night. */
export const LONGEST_MS = 6 * 60 * 60 * 1000;

/** When to stop recording what is on air now: the programme's end and a little more (`afterMs`), else an hour. */
export function recordUntil(onAirStopMs: number | null | undefined, nowMs: number, afterMs = AFTER_END_MS): number {
  const stop = onAirStopMs && Number.isFinite(onAirStopMs) && onAirStopMs > nowMs ? onAirStopMs + afterMs : nowMs + UNKNOWN_LENGTH_MS;
  return Math.min(stop, nowMs + LONGEST_MS);
}

/** An id for a recording, as the recorder takes them (letters, digits, - and _). */
export function newRecordingId(nowMs: number, random: () => number = Math.random): string {
  return `r${nowMs.toString(36)}${Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0')}`;
}

/** A recording as the device lists it. */
export interface Recording {
  id: string;
  title: string;
  channel: string;
  /** The app's id for the channel (tagged), so watching it can use the recording. */
  channelId: string;
  startedAt: number;
  endsAt: number;
  state: 'recording' | 'done' | 'failed';
  bytes: number;
  /** Where the player opens it: a file on this device. */
  path: string;
  failure?: string;
}

/** What the recorder's list says, kept to what is well formed, newest first. */
export function readRecordings(value: unknown): Recording[] {
  const list = Array.isArray(value) ? value : [];
  return list
    .filter((one): one is Record<string, unknown> => !!one && typeof one === 'object')
    .map(one => ({
      id: String(one['id'] ?? ''),
      title: String(one['title'] ?? ''),
      channel: String(one['channel'] ?? ''),
      channelId: String(one['channelId'] ?? ''),
      startedAt: Number(one['startedAt']) || 0,
      endsAt: Number(one['endsAt']) || 0,
      state: (one['state'] === 'recording' || one['state'] === 'done' ? one['state'] : 'failed') as Recording['state'],
      bytes: Number(one['bytes']) || 0,
      path: String(one['path'] ?? ''),
      ...(typeof one['failure'] === 'string' ? { failure: one['failure'] } : {})
    }))
    .filter(one => /^[A-Za-z0-9_-]{1,64}$/.test(one.id) && one.path.startsWith('file://'))
    .sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Whether another stream may open while recordings run: every recording holds
 * a connection, and the new stream needs one more. With one allowed -- most
 * subscriptions -- nothing else opens while a recording runs, not even the
 * channel being recorded, until it can be watched from the recording itself.
 */
export function mayOpenStream(recordingsRunning: number, connectionsAllowed: number): boolean {
  return recordingsRunning + 1 <= Math.max(1, connectionsAllowed);
}

/** How many streams a subscription allows at once, from its user_info; one when it does not say. */
export function connectionsAllowedFrom(userInfo: unknown): number {
  const said = Number((userInfo as { max_connections?: unknown } | null)?.max_connections);
  return Number.isFinite(said) && said >= 1 ? Math.floor(said) : 1;
}

/** Where a provider's allowance is kept on the device, by its slot tag. */
export const connectionsKey = (tag: string): string => `tvinto_connections:${tag || 'first'}`;

/** A stretch of time a recording holds a connection for. */
export interface RecordingWindow {
  title: string;
  startMs: number;
  endsAt: number;
}

/**
 * What a new recording would clash with: the recordings and bookings whose
 * time overlaps it, when together they would need more connections than the
 * subscription allows. Empty when it fits. Refused when booked, not
 * discovered when the second one fails.
 */
export function clashesWith(existing: readonly RecordingWindow[], wanted: RecordingWindow, connectionsAllowed: number): RecordingWindow[] {
  const overlapping = existing.filter(one => one.startMs < wanted.endsAt && wanted.startMs < one.endsAt);
  return overlapping.length + 1 > Math.max(1, connectionsAllowed) ? overlapping : [];
}

/** A booking as the recorder lists it, without its address. */
export interface Booking extends RecordingWindow {
  id: string;
  channel: string;
  channelId: string;
}

export function readBookings(value: unknown): Booking[] {
  return (Array.isArray(value) ? value : [])
    .filter((one): one is Record<string, unknown> => !!one && typeof one === 'object')
    .map(one => ({
      id: String(one['id'] ?? ''),
      title: String(one['title'] ?? ''),
      channel: String(one['channel'] ?? ''),
      channelId: String(one['channelId'] ?? ''),
      startMs: Number(one['startMs']) || 0,
      endsAt: Number(one['endsAt']) || 0
    }))
    .filter(one => /^[A-Za-z0-9_-]{1,64}$/.test(one.id) && one.endsAt > one.startMs)
    .sort((a, b) => a.startMs - b.startMs);
}

/** A drive recordings can go to, as the recorder lists them. */
export interface RecordingVolume {
  id: string;
  /** What Android calls it: "Internal shared storage", "SanDisk USB drive"; empty when it does not say. */
  label: string;
  removable: boolean;
  freeBytes: number;
  totalBytes: number;
  chosen: boolean;
}

export function readVolumes(value: unknown): RecordingVolume[] {
  return (Array.isArray(value) ? value : [])
    .filter((one): one is Record<string, unknown> => !!one && typeof one === 'object' && typeof one['id'] === 'string' && one['id'] !== '')
    .map(one => ({
      id: String(one['id']),
      label: String(one['label'] ?? ''),
      removable: one['removable'] === true,
      freeBytes: Math.max(0, Number(one['freeBytes']) || 0),
      totalBytes: Math.max(0, Number(one['totalBytes']) || 0),
      chosen: one['chosen'] === true
    }));
}
