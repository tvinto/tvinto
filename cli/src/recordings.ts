import { PullResult } from '../../shared/sync';
import {
  PlannedRecording,
  RECORDING_SETTINGS_KEY,
  RecordingSettings,
  RecorderDevice,
  RecordingRule,
  bookingKey,
  readRules,
  ruleKey,
  ruleOf,
  writeRule,
  readPlanned,
  readRecorders,
  readRecordingSettings,
  recorderNamed,
  writePlanned,
  writeRecordingSettings
} from '../../shared/recording/plan';
import { newRecordingId } from '../../shared/recording/recording';
import { untrusted } from './account';
import { Change } from './changes';
import { withBefore } from './edits';

/**
 * Recordings from the command line (private plan: recording): what is booked
 * for the account and on which device, booking and cancelling, and how
 * recordings are made. A booking reaches its device when that device next
 * looks; the recordings themselves stay on the devices that made them, so
 * there is nothing here to play or delete.
 */

const settingsOf = (pulled: PullResult): Record<string, string> =>
  Object.fromEntries((pulled.settings ?? []).map(setting => [setting.key, setting.value]));

export interface RecordingsView {
  booked: PlannedRecording[];
  every: RecordingRule[];
  recorders: RecorderDevice[];
  options: RecordingSettings;
}

export function recordingsView(pulled: PullResult): RecordingsView {
  const all = settingsOf(pulled);
  return { booked: readPlanned(all), every: readRules(all), recorders: readRecorders(all), options: readRecordingSettings(all[RECORDING_SETTINGS_KEY]) };
}

/** "Tue 11 Nov 20:15", in this computer's time. */
export const when = (ms: number): string =>
  new Date(ms).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Cancels a booking on every device, by the id `tvinto recordings` gives. */
export function cancelRecording(pulled: PullResult, id: string): Change {
  const found = recordingsView(pulled).booked.find(one => one.id === id);
  if (!found) {
    throw new Error(`No booking "${id}". tvinto recordings lists them.`);
  }
  // One airing of a title recorded every time: skipped, or it would be booked again.
  const rule = recordingsView(pulled).every.find(one => one.id === ruleOf(id));
  return {
    lines: [['Cancels recording ', untrusted(found.title), ` (${when(found.startMs)}).`]],
    ...withBefore(pulled, [
      { kind: 'setting', key: bookingKey(id), value: null },
      ...(rule ? [{ kind: 'setting' as const, key: ruleKey(rule.id), value: writeRule({ ...rule, skip: [...rule.skip, id] }) }] : [])
    ])
  };
}

/**
 * Records every airing of a title on a channel: the channel's id, the guide's
 * id for it (tvinto channels shows both), the device, and the title as the
 * guide writes it.
 */
export function recordEvery(pulled: PullResult, args: string[], nowMs = Date.now()): Change {
  const [channelId, guideId, deviceSaid, ...titleWords] = args;
  const title = titleWords.join(' ').trim();
  if (!channelId || !guideId || !deviceSaid || !title) {
    throw new Error('tvinto recordings every <channel id> <guide channel id> <device> <title>');
  }
  const view = recordingsView(pulled);
  const device = recorderNamed(view.recorders, deviceSaid);
  if (!device) {
    throw new Error(`No single device "${deviceSaid}". tvinto recordings lists the devices that record.`);
  }
  const rule: RecordingRule = { id: newRecordingId(nowMs), device: device.key, channelId, channel: `Channel ${channelId}`, guideId, title, skip: [] };
  return {
    lines: [['Records every ', untrusted(title), ` on channel ${channelId}, on `, untrusted(device.name), ', as the guide shows it airing.']],
    ...withBefore(pulled, [{ kind: 'setting', key: ruleKey(rule.id), value: writeRule(rule) }])
  };
}

/** Stops recording a title every time; its airings not yet begun are cancelled with it. */
export function stopEvery(pulled: PullResult, id: string, nowMs = Date.now()): Change {
  const view = recordingsView(pulled);
  const rule = view.every.find(one => one.id === id);
  if (!rule) {
    throw new Error(`Nothing "${id}" is recorded every time. tvinto recordings lists them.`);
  }
  const airings = view.booked.filter(one => ruleOf(one.id) === id && one.startMs > nowMs);
  return {
    lines: [['Stops recording every ', untrusted(rule.title), airings.length ? `, and cancels the ${airings.length} booked.` : '.']],
    ...withBefore(pulled, [
      { kind: 'setting', key: ruleKey(id), value: null },
      ...airings.map(one => ({ kind: 'setting' as const, key: bookingKey(one.id), value: null }))
    ])
  };
}

/**
 * Books a programme: a channel by its id (tvinto channels lists them), when
 * it starts as YYYY-MM-DDTHH:MM in this computer's time, how many minutes it
 * lasts, the device that records it by name or key, and a title.
 */
export function bookRecording(pulled: PullResult, args: string[], nowMs = Date.now()): Change {
  const [channelId, start, length, deviceSaid, ...titleWords] = args;
  if (!channelId || !start || !length || !deviceSaid) {
    throw new Error('tvinto recordings book <channel id> <YYYY-MM-DDTHH:MM> <minutes> <device> [title]');
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(start) || Number.isNaN(new Date(start).getTime())) {
    throw new Error('The start is YYYY-MM-DDTHH:MM, like 2026-11-11T20:15, in this computer\'s time.');
  }
  const startMs = new Date(start).getTime();
  const minutes = Number(length);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 360) {
    throw new Error('How long, in minutes: 1 to 360.');
  }
  if (startMs <= nowMs) {
    throw new Error('That has started already: only programmes still to come can be booked.');
  }
  const view = recordingsView(pulled);
  const device = recorderNamed(view.recorders, deviceSaid);
  if (!device) {
    const names = view.recorders.map(one => one.name).join(', ');
    throw new Error(names ? `No single device "${deviceSaid}". The devices that record: ${names}.` : 'No device of this account records yet: open Tvinto on an Android TV, a phone or the desktop app first.');
  }
  const stopMs = startMs + minutes * 60_000;
  const clash = view.booked.find(one => one.startMs < stopMs && startMs < one.stopMs);
  if (clash) {
    throw new Error(`That overlaps "${clash.title}" (${when(clash.startMs)}), and most subscriptions allow one stream. Cancel that one first.`);
  }
  const title = titleWords.join(' ').trim() || `Channel ${channelId}`;
  const booking: PlannedRecording = { id: newRecordingId(nowMs), device: device.key, channelId, channel: `Channel ${channelId}`, title, startMs, stopMs };
  return {
    lines: [['Records ', untrusted(title), ` on channel ${channelId}, ${when(startMs)} for ${minutes} minutes, on `, untrusted(device.name), '.']],
    ...withBefore(pulled, [{ kind: 'setting', key: bookingKey(booking.id), value: writePlanned(booking) }])
  };
}

/** Minutes before (`before`), minutes after (`after`), or days kept (`keep`, or `forever`). */
export function recordingOption(pulled: PullResult, name: string, word: string): Change {
  const now = recordingsView(pulled).options;
  let next: RecordingSettings;
  let line: string;
  if (name === 'before' || name === 'after') {
    const n = Number(word);
    if (!Number.isInteger(n) || n < 0 || n > 60) {
      throw new Error('Minutes: 0 to 60.');
    }
    next = { ...now, [name === 'before' ? 'beforeMin' : 'afterMin']: n };
    line = name === 'before' ? `Starts recordings ${n} minutes early.` : `Goes on recording ${n} minutes after the guide's end.`;
  } else if (name === 'keep') {
    const n = Number(word);
    if (word !== 'forever' && (!Number.isInteger(n) || n < 1 || n > 365)) {
      throw new Error('Days, 1 to 365, or forever.');
    }
    next = { ...now, keepDays: word === 'forever' ? null : n };
    line = word === 'forever' ? 'Keeps recordings until they are deleted.' : `Deletes recordings ${n} days after they were made.`;
  } else {
    throw new Error('tvinto recordings <before|after> <minutes>, or tvinto recordings keep <days|forever>');
  }
  if (JSON.stringify(next) === JSON.stringify(now)) {
    throw new Error('That is how it is already.');
  }
  return { lines: [[`${line} On every device.`]], ...withBefore(pulled, [{ kind: 'setting', key: RECORDING_SETTINGS_KEY, value: writeRecordingSettings(next) }]) };
}
