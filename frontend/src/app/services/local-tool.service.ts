import { Injectable, computed, inject, signal } from '@angular/core';
import { fromBase64, toBase64 } from '@shared/auth/accountKeys';
import { sealFor } from '@shared/auth/keyPair';
import { open, seal } from '@shared/auth/secretBox';
import { recordId } from '@shared/providers/providerRecord';
import { ChangeSet, PullResult } from '@shared/sync';
import { SettingKey } from '@shared/types';
import { LocalProfileService } from './local-profile.service';
import { ProviderAccessService } from './provider-access.service';
import { SettingsService } from './settings.service';
import { LocalUserDataService } from './local-user-data.service';
import { GuideSourcesService } from './guide-sources.service';
import { ConfirmService } from './confirm.service';
import { t } from '../utils/i18n';

/** A request to the desktop's local address, as the main process hands it over (electron/src/localApi.ts). */
interface LocalRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
}

interface LocalResponse {
  status: number;
  body: unknown;
}

interface LocalApiBridge {
  onRequest(handler: (id: number, request: LocalRequest) => void): void;
  reply(id: number, response: LocalResponse): void;
}

const bridge = (): LocalApiBridge | null =>
  (window as { xtreamDesktop?: { localApi?: LocalApiBridge } }).xtreamDesktop?.localApi ?? null;

/** A tool let in here: its token, as a hash, and what it may see. */
interface LocalTool {
  id: string;
  tokenHash: string;
  name: string;
  history: boolean;
  createdAt: string;
  /** When it last asked anything, to the minute. */
  lastUsedAt?: string;
}

/** What is kept on this device for tvinto: the tools let in, and the key their copies are sealed under. */
interface LocalTools {
  enc: string;
  tools: LocalTool[];
}

const STORE_KEY = 'xtream_local_tools';

const ok = (data: unknown, status = 200): LocalResponse => ({ status, body: { success: true, data } });
const fail = (message: string, status: number): LocalResponse => ({ status, body: { success: false, message } });

const randomHex = (bytes: number): string =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');

const sha256Hex = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');

const newCode = (): string => {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return [...crypto.getRandomValues(new Uint8Array(4))].map(byte => alphabet[byte % alphabet.length]).join('');
};

/**
 * tvinto with no account at all: the desktop app answers
 * it itself, on 127.0.0.1, while it is used without an account.
 *
 * It speaks the sync service's own language -- health, signing in by
 * approval, the account's providers, the change feed -- so tvinto needs
 * nothing new: `tvinto sign-in --local`. What it reads and writes is what
 * this device keeps: its providers, settings, arrangements and guides.
 *
 * A tool is let in the same way as with an account: the app asks "Allow?"
 * with a code to compare. Providers and guides go out sealed under a key kept
 * here for the purpose, which the tool receives sealed for its own public
 * key -- the same shapes as the sync service, so the same code reads them.
 */
@Injectable({ providedIn: 'root' })
export class LocalToolService {
  private readonly localProfile = inject(LocalProfileService);
  private readonly providers = inject(ProviderAccessService);
  private readonly settings = inject(SettingsService);
  private readonly local = inject(LocalUserDataService);
  private readonly guides = inject(GuideSourcesService);
  private readonly confirm = inject(ConfirmService);

  /**
   * The tools let in here, for Account > Tools. A signal: the card shows a
   * tool the moment it is allowed, and allowing happens in a dialog's callback.
   */
  readonly tools = signal<LocalTool[]>(this.peek()?.tools ?? []);

  /** Whether this app answers tvinto: the desktop, used without an account. */
  readonly available = computed(() => bridge() !== null && this.localProfile.active());

  /** Signs a tool out here: its token stops working at once. */
  signOut(id: string): void {
    const stored = this.stored();
    this.store({ ...stored, tools: stored.tools.filter(tool => tool.id !== id) });
  }

  /** Sign-in requests waiting or answered, for the few minutes tvinto polls. */
  private readonly requests = new Map<
    string,
    { secretHash: string; status: 'pending' | 'approved' | 'denied'; sealedToken?: string; sealedEnc?: string; expiresAt: number }
  >();

  start(): void {
    const api = bridge();
    api?.onRequest((id, request) => {
      void this.handle(request)
        .catch(error => fail(error instanceof Error ? error.message : 'Something went wrong', 500))
        .then(response => api.reply(id, response));
    });
  }

  async handle(request: LocalRequest): Promise<LocalResponse> {
    const route = `${request.method} ${request.path.split('?')[0].replace(/\/+$/, '')}`;
    if (!this.localProfile.active()) {
      // With an account, tvinto signs in to the sync service instead.
      return fail('This app is signed in to a sync service. Sign tvinto in there instead.', 503);
    }
    if (route === 'GET /api/health') {
      return ok({ status: 'ok', service: 'sync', registration: 'open', tools: true, toolApproval: true, local: true });
    }
    if (route === 'POST /api/tools/requests') {
      return this.createRequest(request);
    }
    const poll = /^GET \/api\/tools\/requests\/([0-9a-f]{32})$/.exec(route);
    if (poll) {
      return this.pollRequest(poll[1], request.headers['x-tool-secret'] ?? '');
    }

    const tool = await this.caller(request);
    if (!tool) {
      return fail('Sign in to continue', 401);
    }
    switch (route) {
      case 'GET /api/accounts/me':
        return ok({ user: { id: 0, username: 'this device', role: 'admin' }, providers: await this.providerRows() });
      case 'GET /api/devices/changes':
        return ok(await this.pull());
      case 'POST /api/devices/changes':
        return ok(await this.push(JSON.parse(request.body ?? '{}') as Partial<ChangeSet>));
      case 'GET /api/family':
        return ok({
          me: { id: 0, username: 'this device', role: 'admin', managerId: null, household: false, publicKey: null, sealedPrivateKey: null },
          managers: [],
          members: []
        });
    }
    const signOut = /^DELETE \/api\/accounts\/tools\/([0-9a-f]{16})$/.exec(route);
    if (signOut && signOut[1] === tool.id) {
      this.signOut(tool.id);
      return ok({ signedOut: tool.id });
    }
    return fail('Not on this device: it has no account', 404);
  }

  // --- Letting a tool in ---------------------------------------------------------

  private async createRequest(request: LocalRequest): Promise<LocalResponse> {
    const body = JSON.parse(request.body ?? '{}') as { name?: unknown; history?: unknown; publicKey?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
    if (!name || typeof body.publicKey !== 'string' || fromBase64(body.publicKey)?.length !== 65) {
      return fail('A tool names itself and sends a public key', 400);
    }
    const id = randomHex(16);
    const secret = randomHex(32);
    const code = newCode();
    const publicKey = body.publicKey;
    this.requests.set(id, { secretHash: await sha256Hex(secret), status: 'pending', expiresAt: Date.now() + 10 * 60 * 1000 });

    // The app is right here: it asks at once, no link needed.
    void this.confirm
      .ask({
        title: t('tools.allowTitle', { name }),
        message: t(body.history === true ? 'tools.allowBodyHistory' : 'tools.allowBody', { code }),
        confirmLabel: t('tools.allow')
      })
      .then(async allow => {
        const waiting = this.requests.get(id);
        if (!waiting) {
          return;
        }
        if (!allow) {
          waiting.status = 'denied';
          return;
        }
        const token = randomHex(32);
        const stored = this.stored();
        this.store({
          ...stored,
          tools: [...stored.tools, { id: (await sha256Hex(token)).slice(0, 16), tokenHash: await sha256Hex(token), name, history: body.history === true, createdAt: new Date().toISOString() }]
        });
        // Approved only once both parts are ready: a poll in between must not
        // collect an answer it cannot open.
        waiting.sealedToken = await sealFor(token, publicKey);
        waiting.sealedEnc = await sealFor(stored.enc, publicKey);
        waiting.status = 'approved';
      });
    return ok({ id, code, secret, expiresInMinutes: 10 }, 201);
  }

  private async pollRequest(id: string, secret: string): Promise<LocalResponse> {
    const waiting = this.requests.get(id);
    if (!waiting || !secret || waiting.secretHash !== (await sha256Hex(secret)) || waiting.expiresAt < Date.now()) {
      return fail('No such request, or it ran out', 404);
    }
    if (waiting.status === 'pending') {
      return ok({ status: 'pending' });
    }
    this.requests.delete(id);
    return waiting.status === 'approved'
      ? ok({ status: 'approved', sealedToken: waiting.sealedToken, sealedEnc: waiting.sealedEnc, username: 'this device' })
      : ok({ status: 'denied' });
  }

  private async caller(request: LocalRequest): Promise<LocalTool | null> {
    const token = /^Bearer\s+(.+)$/i.exec(request.headers['authorization'] ?? '')?.[1]?.trim();
    if (!token) {
      return null;
    }
    const hash = await sha256Hex(token);
    const stored = this.stored();
    const tool = stored.tools.find(candidate => candidate.tokenHash === hash) ?? null;
    // Noted to the minute, as the sync service notes its tools' use.
    const now = new Date();
    if (tool && (!tool.lastUsedAt || now.getTime() - Date.parse(tool.lastUsedAt) > 60_000)) {
      this.store({ ...stored, tools: stored.tools.map(candidate => (candidate === tool ? { ...tool, lastUsedAt: now.toISOString() } : candidate)) });
    }
    return tool;
  }

  /** What is kept, without making it: a device that never answers tvinto keeps nothing. */
  private peek(): LocalTools | null {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as LocalTools | null;
      return parsed && typeof parsed.enc === 'string' && Array.isArray(parsed.tools) ? parsed : null;
    } catch {
      return null;
    }
  }

  private stored(): LocalTools {
    const kept = this.peek();
    if (kept) {
      return kept;
    }
    // Unreadable is the same as none.
    const fresh: LocalTools = { enc: toBase64(crypto.getRandomValues(new Uint8Array(32))), tools: [] };
    this.store(fresh);
    return fresh;
  }

  private store(value: LocalTools): void {
    localStorage.setItem(STORE_KEY, JSON.stringify(value));
    this.tools.set(value.tools);
  }

  private key(): Uint8Array {
    return fromBase64(this.stored().enc)!;
  }

  /** A guide as the account's devices seal it (GuideSourcesService.send). */
  private guideText(source: { label: string; url: string; enabled: boolean; addedAt: string }): string {
    return JSON.stringify({ label: source.label, url: source.url, enabled: source.enabled, addedAt: source.addedAt });
  }

  /** The same content sealed once and handed out the same: tvinto checks a guide has not changed by comparing what it was sent. */
  private readonly sealed = new Map<string, string>();

  private async sealOnce(text: string): Promise<string> {
    const kept = this.sealed.get(text);
    if (kept) {
      return kept;
    }
    const made = await seal(text, this.key());
    this.sealed.set(text, made);
    return made;
  }

  // --- What this device holds, in the sync service's shapes -------------------------

  private async providerRows(): Promise<{ id: string; payload: string; active: boolean }[]> {
    const key = this.key();
    return Promise.all(
      this.providers.records().map(async (record, i) => ({ id: recordId(record), payload: await seal(JSON.stringify(record), key), active: i === 0 }))
    );
  }

  private async pull(): Promise<PullResult> {
    const at = new Date().toISOString();
    return {
      serverTime: at,
      favourites: [],
      progress: [],
      settings: Object.entries(this.settings.all()).map(([name, value]) => ({ key: name, value, updatedAt: at })),
      arrangements: this.local.arrangements(),
      guideSources: await Promise.all(
        this.guides.sources().map(async source => ({
          id: source.id,
          payload: await this.sealOnce(this.guideText(source)),
          updatedAt: source.updatedAt ?? source.addedAt
        }))
      ),
      channelMappings: Object.values(this.guides.mappings()).map(mapping => ({
        streamId: mapping.streamId,
        sourceId: mapping.sourceId,
        channelId: mapping.channelId,
        updatedAt: mapping.mappedAt
      })),
      deletions: []
    };
  }

  /** Applies what tvinto sends to this device's own stores. Favourites and history are not a tool's here. */
  private async push(batch: Partial<ChangeSet>): Promise<{ applied: number; superseded: number }> {
    const key = this.key();
    let applied = 0;
    let superseded = (batch.favourites?.length ?? 0) + (batch.progress?.length ?? 0);

    for (const setting of batch.settings ?? []) {
      this.settings.set(setting.key as SettingKey, setting.value);
      applied++;
    }
    for (const arrangement of batch.arrangements ?? []) {
      this.local.saveManualOrder(arrangement.scope, arrangement.itemIds, arrangement.names ?? {});
      applied++;
    }
    for (const change of batch.guideSources ?? []) {
      const opened = await open(change.payload, key);
      const details = opened ? (JSON.parse(opened) as { label?: string; url?: string; enabled?: boolean }) : null;
      if (!details?.url) {
        superseded++;
        continue;
      }
      const here = this.guides.sources().find(source => source.id === change.id);
      if (!here || here.label !== details.label) {
        this.guides.add(details.url, details.label);
      }
      if ((here?.enabled ?? true) !== (details.enabled !== false)) {
        this.guides.setEnabled(change.id, details.enabled !== false);
      }
      // Handed back exactly as tvinto sent it, so its check that nothing
      // changed since (an undo's above all) sees its own write.
      const now = this.guides.sources().find(source => source.id === change.id);
      if (now) {
        this.sealed.set(this.guideText(now), change.payload);
      }
      applied++;
    }
    for (const mapping of batch.channelMappings ?? []) {
      this.guides.map(mapping.streamId, mapping.channelId, mapping.sourceId);
      applied++;
    }
    for (const deletion of batch.deletions ?? []) {
      switch (deletion.kind) {
        case 'setting':
          this.settings.remove(deletion.key);
          break;
        case 'arrangement':
          this.local.saveManualOrder(deletion.key, []);
          break;
        case 'guideSource':
          this.guides.remove(deletion.key);
          break;
        case 'channelMapping':
          this.guides.unmap(deletion.key);
          break;
        default:
          superseded++;
          continue;
      }
      applied++;
    }
    return { applied, superseded };
  }
}
