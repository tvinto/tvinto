import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ChangeSet, PullResult, Tombstone, emptyChangeSet } from '../../shared/sync';
import { Session, Untrusted } from './account';
import { FamilyView } from '../../shared/family';
import { homeDir } from './store';

/**
 * Changing an account: previewed, applied with a code, and undoable.
 *
 * A command never changes anything by itself. It answers with what it would
 * do and a short code good for five minutes; `tvinto apply <code>` does
 * exactly that change and nothing else -- the change is kept here with the
 * code, so a different one cannot ride on it. Before applying, what the
 * preview saw is checked again: a change made since on another device is
 * not silently overwritten. Every change applied goes into a local log with
 * what it replaced, and `tvinto undo` previews putting that back.
 *
 * Changes go through the change feed like any device's edits, so every
 * device follows, and the sync service holds a tool to what it may change.
 */

/**
 * One thing to write -- a setting, a guide's sealed payload, an arrangement
 * of a list, or one channel tied to a guide -- and null to remove it.
 */
export type Op =
  | { kind: 'setting'; key: string; value: string | null }
  | { kind: 'guideSource'; id: string; payload: string | null }
  | { kind: 'arrangement'; scope: string; order: { itemIds: string[]; names: Record<string, string> } | null }
  | { kind: 'channelMapping'; streamId: string; match: { sourceId: string; channelId: string } | null }
  /** A family member's role and household: written to the family, not the feed. */
  | { kind: 'member'; memberId: number; role: string; household: boolean }
  /** A profile picture (shared/profilePicture.ts): this account's own (memberId null), or a member's. */
  | { kind: 'picture'; memberId: number | null; picture: string | null };

/** What the account holds now: the feed, and the family when a change touches it. */
export interface Now {
  pulled: PullResult;
  family?: FamilyView;
}

/** A line of a change's description: plain text and untrusted pieces, in order. */
export type Line = (string | Untrusted)[];

export interface Change {
  /** What it does, for a person to read before applying. */
  lines: Line[];
  ops: Op[];
  /** The same keys as they are now: what the check before applying and the undo restore. */
  before: Op[];
}

/** A change waiting for its code. */
interface Pending {
  code: string;
  account: string;
  expiresAt: number;
  change: Change;
  /** Set when this is the undo of a logged change. */
  undoes?: string;
}

/** An applied change, in the log. */
interface Logged {
  id: string;
  account: string;
  at: string;
  lines: Line[];
  ops: Op[];
  before: Op[];
  /** Set on an undo: the change it put back. */
  undoes?: string;
}

const CODE_TTL_MS = 5 * 60 * 1000;

const pendingFile = (): string => path.join(homeDir(), 'pending.json');
const logFile = (): string => path.join(homeDir(), 'log.jsonl');

const accountOf = (current: Session): string => `${current.config.username}@${current.config.server}`;

/** Six letters and digits, without the ones that read alike (0/O, 1/I/L). */
const newCode = (): string => {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  return [...bytes].map(byte => alphabet[byte % alphabet.length]).join('');
};

/** What the same thing holds now, from a pull. */
export function currentOf(pulled: PullResult, op: Op, family?: FamilyView): Op {
  switch (op.kind) {
    case 'member': {
      const found = family?.members.find(member => member.id === op.memberId);
      // A member gone from the family matches nothing, so a change to it is refused.
      return { kind: 'member', memberId: op.memberId, role: found?.role ?? '', household: found?.household ?? false };
    }
    case 'picture': {
      const owner = op.memberId === null ? family?.me : family?.members.find(member => member.id === op.memberId);
      return { kind: 'picture', memberId: op.memberId, picture: owner?.picture ?? null };
    }
    case 'setting': {
      const found = (pulled.settings ?? []).find(setting => setting.key === op.key);
      return { kind: 'setting', key: op.key, value: found ? found.value : null };
    }
    case 'guideSource': {
      const found = (pulled.guideSources ?? []).find(source => source.id === op.id);
      return { kind: 'guideSource', id: op.id, payload: found ? found.payload : null };
    }
    case 'arrangement': {
      const found = (pulled.arrangements ?? []).find(arrangement => arrangement.scope === op.scope);
      return { kind: 'arrangement', scope: op.scope, order: found ? { itemIds: found.itemIds, names: found.names ?? {} } : null };
    }
    case 'channelMapping': {
      const found = (pulled.channelMappings ?? []).find(mapping => mapping.streamId === op.streamId);
      return {
        kind: 'channelMapping',
        streamId: op.streamId,
        match: found ? { sourceId: found.sourceId, channelId: found.channelId } : null
      };
    }
  }
}

/** Which thing an op writes, and what it writes, as comparable text. */
function identity(op: Op): string {
  switch (op.kind) {
    case 'setting':
      return `setting:${op.key}`;
    case 'guideSource':
      return `guide:${op.id}`;
    case 'arrangement':
      return `arrangement:${op.scope}`;
    case 'channelMapping':
      return `mapping:${op.streamId}`;
    case 'member':
      return `member:${op.memberId}`;
    case 'picture':
      return `picture:${op.memberId ?? 'me'}`;
  }
}

function content(op: Op): string {
  switch (op.kind) {
    case 'setting':
      return JSON.stringify(op.value);
    case 'guideSource':
      return JSON.stringify(op.payload);
    case 'arrangement':
      return JSON.stringify(op.order && { itemIds: op.order.itemIds, names: Object.fromEntries(Object.entries(op.order.names).sort()) });
    case 'channelMapping':
      return JSON.stringify(op.match && { sourceId: op.match.sourceId, channelId: op.match.channelId });
    case 'member':
      return JSON.stringify({ role: op.role, household: op.household });
    case 'picture':
      return JSON.stringify(op.picture);
  }
}

const sameOp = (a: Op, b: Op): boolean => identity(a) === identity(b) && content(a) === content(b);

/** The ops as a change set, stamped now; a null is a tombstone. */
function toChangeSet(ops: Op[], at: string): ChangeSet {
  const set = emptyChangeSet();
  const remove = (kind: Tombstone['kind'], key: string) => set.deletions.push({ kind, key, deletedAt: at });
  for (const op of ops) {
    switch (op.kind) {
      case 'setting':
        if (op.value === null) {
          remove('setting', op.key);
        } else {
          set.settings.push({ key: op.key, value: op.value, updatedAt: at });
        }
        break;
      case 'guideSource':
        if (op.payload === null) {
          remove('guideSource', op.id);
        } else {
          set.guideSources.push({ id: op.id, payload: op.payload, updatedAt: at });
        }
        break;
      case 'arrangement':
        if (op.order === null) {
          remove('arrangement', op.scope);
        } else {
          set.arrangements.push({ scope: op.scope, itemIds: op.order.itemIds, names: op.order.names, updatedAt: at });
        }
        break;
      case 'channelMapping':
        if (op.match === null) {
          remove('channelMapping', op.streamId);
        } else {
          set.channelMappings.push({ streamId: op.streamId, sourceId: op.match.sourceId, channelId: op.match.channelId, updatedAt: at });
        }
        break;
    }
  }
  return set;
}

/** What the account holds now, for these ops: the family read only when one touches it. */
async function nowFor(current: Session, ops: Op[]): Promise<Now> {
  const pulled = await current.service.pull();
  return { pulled, ...(ops.some(op => op.kind === 'member' || op.kind === 'picture') ? { family: await current.service.family() } : {}) };
}

/** Which account the change waiting is for -- `petar`, or `petar/ana` when set up for a member -- or null. */
export function waitingFor(): string | null {
  try {
    const pending = JSON.parse(fs.readFileSync(pendingFile(), 'utf8')) as Pending;
    return pending.account.split('@')[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * What the change waiting for a code does, as plain lines for a person, or
 * null when no change waits for it. Names others wrote are quoted, so they
 * read as names and not as part of the sentence.
 */
export function pendingLines(code: string, now = Date.now()): string[] | null {
  try {
    const pending = JSON.parse(fs.readFileSync(pendingFile(), 'utf8')) as Pending;
    if (pending.code !== code.trim().toUpperCase() || pending.expiresAt < now) {
      return null;
    }
    return pending.change.lines.map(line =>
      line.map(piece => (typeof piece === 'string' ? piece : JSON.stringify(piece.untrusted))).join('')
    );
  } catch {
    return null;
  }
}

/** Keeps a change for its code, replacing any other waiting. Returns the code. */
export function propose(current: Session, change: Change, undoes?: string, now = Date.now()): string {
  const code = newCode();
  const pending: Pending = { code, account: accountOf(current), expiresAt: now + CODE_TTL_MS, change, ...(undoes ? { undoes } : {}) };
  fs.mkdirSync(homeDir(), { recursive: true });
  fs.writeFileSync(pendingFile(), JSON.stringify(pending));
  return code;
}

/**
 * Applies the change a code was given for.
 *
 * Refused for a wrong or expired code, for a change made on another account,
 * and when what the preview saw has changed since.
 */
export async function apply(current: Session, code: string, now = Date.now()): Promise<{ lines: Line[]; undo: boolean }> {
  let pending: Pending;
  try {
    pending = JSON.parse(fs.readFileSync(pendingFile(), 'utf8')) as Pending;
  } catch {
    throw new Error('Nothing is waiting to be applied. Preview the change first.');
  }
  if (pending.code !== code.trim().toUpperCase()) {
    throw new Error('That code is not the one for the change waiting. Preview the change again.');
  }
  if (pending.expiresAt < now) {
    fs.rmSync(pendingFile(), { force: true });
    throw new Error('That code has run out (five minutes). Preview the change again.');
  }
  if (pending.account !== accountOf(current)) {
    throw new Error('That change was previewed for another account.');
  }

  const { pulled, family } = await nowFor(current, pending.change.before);
  const moved = pending.change.before.some(before => !sameOp(currentOf(pulled, before, family), before));
  if (moved) {
    fs.rmSync(pendingFile(), { force: true });
    throw new Error('The account changed since the preview, on another device. Preview the change again.');
  }

  const at = new Date(now).toISOString();
  const feed = pending.change.ops.filter(op => op.kind !== 'member' && op.kind !== 'picture');
  fs.rmSync(pendingFile(), { force: true });
  if (feed.length) {
    const result = await current.service.push(toChangeSet(feed, at));
    if (result.applied < feed.length) {
      throw new Error(
        `The sync service took ${result.applied} of ${feed.length} parts of the change. ` +
          'This sign-in may not be allowed to change that.'
      );
    }
  }
  for (const op of pending.change.ops) {
    if (op.kind === 'member') {
      await current.service.changeMember(op.memberId, { role: op.role, household: op.household });
    } else if (op.kind === 'picture') {
      await (op.memberId === null
        ? current.service.setPicture(op.picture)
        : current.service.changeMember(op.memberId, { picture: op.picture }));
    }
  }

  const logged: Logged = {
    id: crypto.randomBytes(6).toString('hex'),
    account: pending.account,
    at,
    lines: pending.change.lines,
    ops: pending.change.ops,
    before: pending.change.before,
    ...(pending.undoes ? { undoes: pending.undoes } : {})
  };
  fs.appendFileSync(logFile(), `${JSON.stringify(logged)}\n`);
  return { lines: pending.change.lines, undo: Boolean(pending.undoes) };
}

/** The account's applied changes, newest first. */
export function history(current: Session): Logged[] {
  let text = '';
  try {
    text = fs.readFileSync(logFile(), 'utf8');
  } catch {
    return [];
  }
  const account = accountOf(current);
  return text
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line) as Logged;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Logged => entry !== null && entry.account === account)
    .reverse();
}

/**
 * The newest change not yet undone, as a change that puts it back -- or null.
 *
 * Only while the account still holds what that change wrote: anything changed
 * since, on any device, would be overwritten by putting the old values back.
 */
export async function undoLast(current: Session): Promise<{ change: Change; undoes: string } | null> {
  const entries = history(current);
  const undone = new Set(entries.flatMap(entry => (entry.undoes ? [entry.undoes] : [])));
  const last = entries.find(entry => !entry.undoes && !undone.has(entry.id));
  if (!last) {
    return null;
  }
  const { pulled, family } = await nowFor(current, last.ops);
  if (last.ops.some(op => !sameOp(currentOf(pulled, op, family), op))) {
    throw new Error('The account changed since that change was made, so putting it back would undo something newer.');
  }
  return {
    undoes: last.id,
    change: { lines: [['Put back: '], ...last.lines], ops: last.before, before: last.ops }
  };
}
