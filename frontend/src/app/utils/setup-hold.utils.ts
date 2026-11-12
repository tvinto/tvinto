/**
 * Requests a family member's setup keeps back until Save & Close (a user,
 * 5 October 2026: "everything should be saved only on Save"). The sync queue
 * and settings are held by their own services; these are the writes that go
 * straight to the sync service instead -- a subscription added, replaced or
 * removed, and the OpenSubtitles login -- and the reads that have to show
 * them while they wait.
 *
 * Plain functions, so the rules can be tested without a page.
 */

/** A write kept back, as it would have been sent. */
export interface HeldRequest {
  method: 'POST' | 'DELETE';
  /** Below the API address: `/accounts/providers`, `/accounts/providers/<id>`, `/subtitles/account`. */
  path: string;
  body: unknown;
}

/** Where they wait: with the setup's own storage, so forgotten with it. */
export const HELD_REQUESTS_KEY = 'xtream_setup_held_requests';

const PROVIDERS = '/accounts/providers';
const SUBTITLE_LOGIN = '/subtitles/account';

/** Whether a write is one a setup keeps back. */
export function isHeldWrite(method: string, path: string): method is 'POST' | 'DELETE' {
  if (method === 'POST') {
    return path === PROVIDERS || path === SUBTITLE_LOGIN;
  }
  if (method === 'DELETE') {
    return path.startsWith(`${PROVIDERS}/`) || path === SUBTITLE_LOGIN;
  }
  return false;
}

interface ProviderRow {
  id: string;
  payload: string;
  active: boolean;
  [key: string]: unknown;
}

/**
 * What a read answers with the held writes laid over it, so the setup shows
 * what was changed. Untouched when nothing held bears on it.
 */
export function withHeld(path: string, body: unknown, held: readonly HeldRequest[]): unknown {
  if (path === PROVIDERS) {
    return providersWithHeld(body, held);
  }
  if (path === `${PROVIDERS}/active`) {
    // The latest subscription made active while held is the active one.
    const active = [...held].reverse().find(
      request => request.method === 'POST' && request.path === PROVIDERS && (request.body as ProviderRow | null)?.active
    );
    return active ? { ...(body as object), data: active.body } : body;
  }
  if (path === SUBTITLE_LOGIN) {
    const last = [...held].reverse().find(request => request.path === SUBTITLE_LOGIN);
    if (!last) {
      return body;
    }
    if (last.method === 'DELETE') {
      return { ...(body as object), data: null };
    }
    const payload = (last.body as { payload?: unknown } | null)?.payload;
    return { ...(body as object), data: { payload, updatedAt: new Date().toISOString() } };
  }
  return body;
}

function providersWithHeld(body: unknown, held: readonly HeldRequest[]): unknown {
  const envelope = body && typeof body === 'object' ? (body as { data?: unknown }) : {};
  let rows: ProviderRow[] = Array.isArray(envelope.data) ? [...(envelope.data as ProviderRow[])] : [];
  for (const request of held) {
    if (request.method === 'POST' && request.path === PROVIDERS) {
      const row = request.body as ProviderRow;
      if (row.active) {
        rows = rows.map(existing => ({ ...existing, active: false }));
      }
      // Newest first, as the server answers.
      rows = [{ ...row }, ...rows.filter(existing => existing.id !== row.id)];
    } else if (request.method === 'DELETE' && request.path.startsWith(`${PROVIDERS}/`)) {
      const id = decodeURIComponent(request.path.slice(PROVIDERS.length + 1));
      rows = rows.filter(existing => existing.id !== id);
    }
  }
  return { ...envelope, data: rows };
}

export function readHeldRequests(raw: string | null): HeldRequest[] {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is HeldRequest =>
            !!item && typeof item === 'object' && isHeldWrite((item as HeldRequest).method, (item as HeldRequest).path)
        )
      : [];
  } catch {
    return [];
  }
}
