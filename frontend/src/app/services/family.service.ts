import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { fromBase64, toBase64 } from '@shared/auth/accountKeys';
import { makeKeyPair, openPrivateKey, openWith, sealFor, sealPrivateKey } from '@shared/auth/keyPair';
import { FamilyMember, FamilyRole, FamilyView, ManagedKey } from '@shared/family';
import { ProviderRecord, newTag, readProviderRecord, recordId, tagged } from '@shared/providers/providerRecord';
import {
  FamilyLink,
  FamilyLinks,
  HeldMapping,
  MatchByName,
  fingerprint,
  readFamilyLinks,
  resolveByName,
  translateMappings
} from '@shared/providers/familySetup';
import { ChangeSet, emptyChangeSet, splitChangeSet } from '@shared/sync';
import { SETTING_KEYS } from '@shared/types';
import { guideSourceId } from '@shared/xtream/guideSourceId';
import { API_URL } from './api-url';
import { AccountService } from './account.service';
import { AccountKeysService } from './account-keys.service';
import { ProviderAccessService } from './provider-access.service';
import { GuideSourcesService } from './guide-sources.service';
import { SettingsService } from './settings.service';
import { fold, readVault, writeVault } from '../utils/profile-vault.utils';

/** What the Family page asks for when adding somebody. */
export interface NewMember {
  username: string;
  password: string;
  role: FamilyRole;
  household: boolean;
}

/** A setup session for one member, kept for the launch. */
interface SetupSession {
  token: string;
  enc: Uint8Array;
}

/** Set after a password change, until every manager holds the new `enc`. */
const HAND_KEY_UP_AGAIN = 'xtream_family_hand_key_up_again';

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, at) => byte === b[at]);

/** Where a device remembers that it already made the matches a manager handed over. */
const MATCHES_APPLIED_KEY = 'xtream_family_matches_applied';

/**
 * The family, from this device.
 *
 * Three jobs. For every account: make its key pair once, and hand its `enc`
 * up to the accounts above it, sealed for each -- which is what lets them set
 * it up. For an admin: add, change and remove the accounts below it, share
 * its own subscription and copy its guides into theirs, and keep both in step
 * when it changes them. And for a member a manager handed guides to: make the
 * channel matches that could only be made by name, once its own catalogue is
 * on the device.
 *
 * Everything here that touches a member's subscription or guides seals it
 * with the member's `enc`, opened on this device from `managed_keys`; the
 * sync service carries it and can read none of it.
 */
@Injectable({ providedIn: 'root' })
export class FamilyService {
  private readonly http = inject(HttpClient);
  // Read at each use: a server chosen at sign-in takes effect without a restart.
  private readonly syncServer = inject(API_URL);
  private get apiUrl(): string {
    return this.syncServer();
  }
  private readonly accounts = inject(AccountService);
  private readonly keys = inject(AccountKeysService);
  private readonly access = inject(ProviderAccessService);
  private readonly guides = inject(GuideSourcesService);
  private readonly settings = inject(SettingsService);

  /** The family as last read, for the account in use. */
  readonly view = signal<FamilyView | null>(null);

  /** The account's private key, opened, once known. */
  private privateKey: string | null = null;

  private readonly sessions = new Map<number, SetupSession>();
  private started = false;
  private stepTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Keeping members in step follows the manager's own changes: a renewed
    // login, a guide added, a channel matched. Debounced, since matching a
    // dozen channels is a dozen changes and one hand-over.
    effect(() => {
      this.access.records();
      this.guides.sources();
      this.guides.mappings();
      untracked(() => {
        if (!this.started) {
          return;
        }
        if (this.stepTimer) {
          clearTimeout(this.stepTimer);
        }
        this.stepTimer = setTimeout(() => void this.keepInStep().catch(() => undefined), 5000);
      });
    });
  }

  // --- At start ------------------------------------------------------------

  /**
   * Everything a device does about the family when it starts. Quiet: none of
   * it is worth a failed launch, and all of it is tried again next time.
   */
  async start(): Promise<void> {
    if (!this.accounts.getToken() || this.accounts.profileScope() !== 'full') {
      return;
    }
    try {
      const view = await this.load();
      await this.ensureKeyPair(view);
      await this.handKeyUp(this.view() ?? view, this.handKeyUpAgain());
      if (this.accounts.managesFamily()) {
        this.started = true;
        await this.keepInStep();
      }
      await this.makeHandedMatches();
    } catch (error) {
      console.warn('The family could not be brought up to date', error instanceof Error ? error.message : '');
    }
  }

  async load(): Promise<FamilyView> {
    const view = await this.get<FamilyView>('/family');
    this.view.set(view);
    this.accounts.adoptFamilyPlace(view.me.role, view.me.managerId, view.me.household);
    // Whoever is in the household now is who "Who's watching?" offers.
    this.rememberHousehold(view);
    return view;
  }

  /** The account's key pair: opened if it has one, made if it has none. */
  private async ensureKeyPair(view: FamilyView): Promise<void> {
    const enc = this.keys.sealingKey();
    if (!enc) {
      return;
    }
    if (view.me.publicKey && view.me.sealedPrivateKey) {
      this.privateKey = await openPrivateKey(view.me.sealedPrivateKey, enc);
      if (this.privateKey) {
        return;
      }
      // Sealed under an `enc` this account no longer has -- a password was
      // replaced. A new pair, and the keys sealed for the old one go.
    }
    const pair = await makeKeyPair();
    await this.post('/family/key', {
      publicKey: pair.publicKey,
      sealedPrivateKey: await sealPrivateKey(pair, enc)
    });
    this.privateKey = pair.privateKey;
    await this.load();
  }

  /**
   * Seals this account's `enc` for every account above it that does not hold
   * it yet -- or for every one, after a password change made the copies they
   * hold open nothing.
   */
  private async handKeyUp(view: FamilyView, everyone = false): Promise<void> {
    const enc = this.keys.sealingKey();
    if (!enc) {
      return;
    }
    const keys: ManagedKey[] = [];
    for (const manager of view.managers) {
      if (manager.publicKey && (everyone || !manager.holdsMyKey)) {
        keys.push({ memberId: view.me.id, managerId: manager.id, sealedEnc: await sealFor(toBase64(enc), manager.publicKey) });
      }
    }
    if (keys.length) {
      await this.post('/family/managed-keys', { keys });
    }
    if (everyone) {
      try {
        localStorage.removeItem(HAND_KEY_UP_AGAIN);
      } catch {
        // Asked again next start, which does no harm.
      }
    }
  }

  /** Who this device offers in "Who's watching?", for when there is no network. */
  private rememberHousehold(view: FamilyView): void {
    try {
      const vault = readVault(localStorage);
      if (!vault || vault.home !== fold(view.me.username) || vault.active !== vault.home) {
        return;
      }
      writeVault(localStorage, {
        ...vault,
        household: view.members
          .filter(member => member.household)
          .map(member => ({ id: member.id, username: member.username, role: member.role, picture: member.picture ?? null }))
      });
    } catch {
      // The picker then offers what it offered last time.
    }
  }

  // --- Accounts ------------------------------------------------------------

  /**
   * Makes an account below this one, with a first password chosen here.
   *
   * Its keys are derived on this device, its key pair made here, and its
   * `enc` sealed for every account that will be above it -- so it can be set
   * up at once, before its owner has signed in anywhere.
   */
  async addMember(input: NewMember): Promise<number> {
    const view = this.view() ?? (await this.load());
    if (!this.privateKey) {
      await this.ensureKeyPair(view);
    }
    const mine = this.view() ?? view;

    const { keys, enc } = await this.keys.deriveDetached(input.password, this.keys.freshSalt());
    const pair = await makeKeyPair();
    const managedKeys = await this.sealForManagers(enc, [
      { id: mine.me.id, publicKey: mine.me.publicKey },
      ...mine.managers
    ]);

    const created = await this.post<{ id: number }>('/family/members', {
      username: input.username.trim(),
      keys,
      role: input.role,
      household: input.household,
      publicKey: pair.publicKey,
      sealedPrivateKey: await sealPrivateKey(pair, enc),
      managedKeys
    });
    await this.load();
    return created.id;
  }

  async changeMember(member: FamilyMember, change: { role?: FamilyRole; household?: boolean; picture?: string | null }): Promise<void> {
    await this.post(`/family/members/${member.id}`, change);
    await this.load();
  }

  /** Out of the family: it keeps its account, and what was shared with it stays shared until withdrawn. */
  async release(member: FamilyMember): Promise<void> {
    await this.post(`/family/members/${member.id}/release`, {});
    this.dropLink(member.id);
    this.sessions.delete(member.id);
    await this.load();
  }

  async deleteMember(member: FamilyMember): Promise<void> {
    await firstValueFrom(this.http.delete(`${this.apiUrl}/family/members/${member.id}`));
    this.dropLink(member.id);
    this.sessions.delete(member.id);
    await this.load();
  }

  async leave(): Promise<void> {
    await this.post('/family/leave', {});
    await this.load();
  }

  async join(invite: string): Promise<void> {
    await this.post('/family/join', { invite: invite.trim() });
    const view = await this.load();
    await this.handKeyUp(view);
  }

  /**
   * A new password for a member who forgot theirs.
   *
   * Their subscriptions, guides and OpenSubtitles login are sealed under the
   * old `enc`, which this device holds; they are sealed again under the new one
   * first, through a setup session, and only then is the password replaced --
   * which ends that session along with every other the member had.
   */
  async resetPassword(member: FamilyMember, password: string): Promise<void> {
    const view = this.view() ?? (await this.load());
    const old = await this.setupSession(member);
    const { keys, enc } = await this.keys.deriveDetached(password, this.keys.freshSalt());

    const undo = await this.reseal(old.enc, enc, old.token);
    const pair = await makeKeyPair();
    try {
      await this.post(`/family/members/${member.id}/password`, {
        keys,
        publicKey: pair.publicKey,
        sealedPrivateKey: await sealPrivateKey(pair, enc),
        managedKeys: await this.sealForManagers(enc, this.managersOf(member, view))
      });
    } catch (error) {
      await undo();
      throw error;
    }
    this.sessions.delete(member.id);
    await this.load();
  }

  /**
   * This account's own new password (Account -> Password).
   *
   * Checked against the key this device holds, so a mistyped current
   * password is said at once and nothing is sent. Then everything sealed under
   * the old `enc` is sealed again under the new -- subscriptions, guides, the
   * OpenSubtitles login, the account's private key, and the copies of `enc`
   * its managers hold -- and only then is the password replaced, which signs
   * the account's other devices out (worker/src/accounts.ts, `replaceKeys`).
   * If that last step fails, what was sealed again is put back as it was.
   */
  async changePassword(current: string, next: string): Promise<void> {
    const oldEnc = this.keys.sealingKey();
    const username = this.accounts.account()?.username;
    if (!oldEnc || !username) {
      throw new Error('sign-in-again');
    }
    const checked = await this.keys.deriveDetached(current, await this.keys.saltFor(username));
    if (!sameBytes(checked.enc, oldEnc)) {
      throw new Error('wrong-current');
    }

    const { keys, enc } = await this.keys.deriveDetached(next, this.keys.freshSalt());
    const view = await this.load().catch(() => null);

    const undo = await this.reseal(oldEnc, enc);
    const keptPrivate = view?.me.sealedPrivateKey ?? null;
    if (view?.me.publicKey && keptPrivate) {
      const opened = await openPrivateKey(keptPrivate, oldEnc);
      if (opened) {
        await this.post('/family/key', {
          publicKey: view.me.publicKey,
          sealedPrivateKey: await this.keys.sealFor(opened, enc)
        });
      }
    }

    try {
      await firstValueFrom(this.http.post(`${this.apiUrl}/accounts/keys`, keys));
    } catch (error) {
      await undo();
      if (view?.me.publicKey && keptPrivate) {
        await this.post('/family/key', { publicKey: view.me.publicKey, sealedPrivateKey: keptPrivate }).catch(() => undefined);
      }
      throw error;
    }

    this.keys.useSealingKey(enc);
    // The managers' copies of the old `enc` open nothing now. Sealed again for
    // each, and asked again at the next start if this does not get through.
    try {
      localStorage.setItem(HAND_KEY_UP_AGAIN, '1');
    } catch {
      // Then it is only tried now.
    }
    if (view) {
      await this.handKeyUp(view, true).catch(() => undefined);
    }
  }

  /**
   * Seals an account's sealed things again under a new `enc`: its
   * subscriptions, guide sources and OpenSubtitles login. Through a setup
   * session's token for a member, or this device's own session. Hands back
   * the way to put them back as they were.
   */
  private async reseal(oldEnc: Uint8Array, newEnc: Uint8Array, token?: string): Promise<() => Promise<void>> {
    const auth = token ? this.headers(token) : {};
    const undo: Array<() => Promise<unknown>> = [];

    const providers = await firstValueFrom(
      this.http.get<{ data: Array<{ id: string; payload: string; active: boolean }> }>(`${this.apiUrl}/accounts/providers`, auth)
    );
    for (const row of providers.data) {
      const opened = await this.keys.openFor(row.payload, oldEnc);
      if (opened) {
        await firstValueFrom(
          this.http.post(`${this.apiUrl}/accounts/providers`, { id: row.id, payload: await this.keys.sealFor(opened, newEnc), active: row.active }, auth)
        );
        undo.push(() =>
          firstValueFrom(this.http.post(`${this.apiUrl}/accounts/providers`, { id: row.id, payload: row.payload, active: row.active }, auth))
        );
      }
    }

    const pulled = await firstValueFrom(this.http.get<{ data: ChangeSet }>(`${this.apiUrl}/devices/changes`, auth));
    const sealedAgain = emptyChangeSet();
    const asBefore = emptyChangeSet();
    const at = new Date().toISOString();
    for (const source of pulled.data.guideSources ?? []) {
      const opened = await this.keys.openFor(source.payload, oldEnc);
      if (opened) {
        sealedAgain.guideSources.push({ id: source.id, payload: await this.keys.sealFor(opened, newEnc), updatedAt: at });
        asBefore.guideSources.push({ id: source.id, payload: source.payload, updatedAt: '' });
      }
    }
    await this.push(sealedAgain, token);
    undo.push(() => {
      // A later stamp than the one just written, or the service keeps that.
      const later = new Date(Date.now() + 1000).toISOString();
      asBefore.guideSources.forEach(source => (source.updatedAt = later));
      return this.push(asBefore, token);
    });

    const subtitles = await firstValueFrom(
      this.http.get<{ data: { payload?: string } | null }>(`${this.apiUrl}/subtitles/account`, auth)
    ).catch(() => null);
    const subtitlePayload = subtitles?.data?.payload;
    if (subtitlePayload) {
      const opened = await this.keys.openFor(subtitlePayload, oldEnc);
      if (opened) {
        await firstValueFrom(
          this.http.post(`${this.apiUrl}/subtitles/account`, { payload: await this.keys.sealFor(opened, newEnc) }, auth)
        );
        undo.push(() => firstValueFrom(this.http.post(`${this.apiUrl}/subtitles/account`, { payload: subtitlePayload }, auth)));
      }
    }

    return async () => {
      for (const step of undo) {
        await step().catch(() => undefined);
      }
    };
  }

  // --- Setting a member up -------------------------------------------------

  /** The member's `enc`, opened with this account's private key, or null if it has not been handed up yet. */
  async memberEnc(member: FamilyMember): Promise<Uint8Array | null> {
    if (!this.privateKey) {
      const view = this.view() ?? (await this.load());
      await this.ensureKeyPair(view);
    }
    const fresh = this.view()?.members.find(candidate => candidate.id === member.id) ?? member;
    if (!this.privateKey || !fresh.sealedEnc) {
      return null;
    }
    const opened = await openWith(fresh.sealedEnc, this.privateKey);
    return opened ? fromBase64(opened) : null;
  }

  /** A session for setting this member up, and its `enc`; refused if it has not been handed up yet. */
  async setupSession(member: FamilyMember): Promise<SetupSession> {
    const held = this.sessions.get(member.id);
    if (held) {
      return held;
    }
    const enc = await this.memberEnc(member);
    if (!enc) {
      throw new Error('not-ready');
    }
    const { token } = await this.post<{ token: string }>(`/family/members/${member.id}/session`, { scope: 'setup' });
    const session = { token, enc };
    this.sessions.set(member.id, session);
    return session;
  }

  /** The member's providers, opened. */
  async providersOf(member: FamilyMember): Promise<ProviderRecord[]> {
    const session = await this.setupSession(member);
    const rows = await firstValueFrom(
      this.http.get<{ data: Array<{ id: string; payload: string }> }>(`${this.apiUrl}/accounts/providers`, this.headers(session.token))
    );
    const records: ProviderRecord[] = [];
    for (const row of rows.data) {
      const record = readProviderRecord(await this.keys.openFor(row.payload, session.enc));
      if (record) {
        records.push(record);
      }
    }
    return records;
  }

  /** The links this manager keeps, from its own settings. */
  links(): FamilyLinks {
    return readFamilyLinks(this.settings.get(SETTING_KEYS.familyLinks));
  }

  linkFor(memberId: number): FamilyLink {
    return this.links()[String(memberId)] ?? { providers: {}, guides: false, handed: {} };
  }

  /**
   * Gives a member one of this account's providers, or takes it back.
   *
   * It lands as one of their providers, with this account named as where it
   * came from: their first one if they have none, otherwise beside their own.
   */
  async shareProvider(member: FamilyMember, record: ProviderRecord, on: boolean): Promise<void> {
    const session = await this.setupSession(member);
    const theirs = await this.providersOf(member);
    const link = this.linkFor(member.id);
    const mine = recordId(record);

    if (on) {
      const tag =
        link.providers[mine] ?? (theirs.some(existing => existing.tag === '') ? newTag(theirs.map(existing => existing.tag)) : '');
      await this.handProvider(session, record, tag);
      link.providers[mine] = tag;
      link.handed = { ...link.handed, [`p:${mine}`]: fingerprint(record) };
    } else {
      const tag = link.providers[mine];
      const given = theirs.find(existing => existing.tag === tag && existing.sharedBy);
      if (given) {
        await firstValueFrom(
          this.http.delete(`${this.apiUrl}/accounts/providers/${encodeURIComponent(recordId(given))}`, this.headers(session.token))
        );
      }
      delete link.providers[mine];
      delete link.handed?.[`p:${mine}`];
    }

    this.saveLink(member.id, link);
    if (link.guides) {
      await this.handGuides(member, link);
    }
  }

  private async handProvider(session: SetupSession, record: ProviderRecord, tag: string): Promise<void> {
    const me = this.view()?.me.username ?? this.accounts.account()?.username ?? '';
    const given: ProviderRecord = { ...record, tag, enabled: true, sharedBy: me };
    await firstValueFrom(
      this.http.post(
        `${this.apiUrl}/accounts/providers`,
        { id: recordId(given), payload: await this.keys.sealFor(JSON.stringify(given), session.enc), active: tag === '' },
        this.headers(session.token)
      )
    );
  }

  /** The member's guides as this account's, kept in step -- or no longer kept in step. */
  async setGuidesShared(member: FamilyMember, on: boolean): Promise<void> {
    const link = this.linkFor(member.id);
    link.guides = on;
    if (on) {
      await this.handGuides(member, link);
    }
    this.saveLink(member.id, link);
  }

  /**
   * Hands this account's guides to a member: the sources, sealed for them,
   * and the channel matches, translated onto their channels -- exactly through
   * a provider shared with them, by name for the rest (familySetup.ts).
   */
  private async handGuides(member: FamilyMember, link: FamilyLink): Promise<void> {
    const session = await this.setupSession(member);
    const { sources, mappings } = await this.guidesToHand(link);
    const names = await this.namesByMatch(link, mappings);
    const translated = translateMappings(mappings, this.sharedSlots(link), id => names.get(id));
    const at = new Date().toISOString();

    const batch = emptyChangeSet();
    for (const source of sources) {
      batch.guideSources.push({
        id: source.id,
        payload: await this.keys.sealFor(
          JSON.stringify({ label: source.label, url: source.url, enabled: source.enabled, addedAt: source.addedAt }),
          session.enc
        ),
        updatedAt: at
      });
    }
    for (const mapping of translated.direct) {
      batch.channelMappings.push({ ...mapping, updatedAt: at });
    }
    batch.settings.push({
      key: SETTING_KEYS.familyGuideMatches,
      value: JSON.stringify({ at, matches: translated.byName }),
      updatedAt: at
    });
    await this.push(batch, session.token);

    link.handed = { ...link.handed, guides: fingerprint({ sources, mappings }) };
  }

  /**
   * This account's guides as they are handed over: every source but a
   * provider's own guide for a provider not shared with the member -- that
   * address carries this account's provider password.
   */
  private async guidesToHand(link: FamilyLink): Promise<{
    sources: ReturnType<GuideSourcesService['sources']>;
    mappings: HeldMapping[];
  }> {
    const direct = await this.access.direct();
    const sharedTags = new Set(this.sharedSlots(link).keys());
    const withheld = new Set<string>();

    for (const slot of direct?.slots ?? []) {
      if (!sharedTags.has(slot.tag)) {
        try {
          const urls = slot.xtream ? [slot.xtream.guideUrl()] : ((await slot.m3u?.guideUrls()) ?? []);
          urls.forEach(url => withheld.add(guideSourceId(url)));
        } catch {
          // No guide to withhold.
        }
      }
    }

    const mappings = Object.values(this.guides.mappings()).map(mapping => ({
      streamId: String(mapping.streamId),
      sourceId: mapping.sourceId,
      channelId: mapping.channelId
    }));

    return {
      sources: this.guides.sources().filter(source => !withheld.has(source.id)),
      mappings
    };
  }

  /**
   * The names of the matched channels that will be matched by name: those of
   * providers the member does not share. Only when handing over -- it reads
   * every channel held, which on a television took 22 s with every other
   * read of the database waiting behind it, and ran at each start for each
   * member just to find nothing had changed (22 October).
   */
  private async namesByMatch(link: FamilyLink, mappings: HeldMapping[]): Promise<Map<string, string>> {
    const sharedTags = new Set(this.sharedSlots(link).keys());
    const names = new Map<string, string>();
    const needNames = new Set(
      mappings.map(mapping => mapping.streamId).filter(id => !sharedTags.has(this.tagOf(id)))
    );
    if (!needNames.size) {
      return names;
    }
    const direct = await this.access.direct();
    for (const slot of direct?.slots ?? []) {
      if (sharedTags.has(slot.tag)) {
        continue;
      }
      for (const stream of await slot.catalogue.allStreams('live').catch(() => [])) {
        const id = tagged(slot.tag, stream.stream_id);
        if (needNames.has(id)) {
          names.set(id, stream.name);
        }
      }
    }
    return names;
  }

  /** This account's slot tags shared with the member, and the member's tag for each. */
  private sharedSlots(link: FamilyLink): Map<string, string> {
    const shared = new Map<string, string>();
    for (const record of this.access.records()) {
      const theirs = link.providers[recordId(record)];
      if (theirs !== undefined) {
        shared.set(record.tag, theirs);
      }
    }
    return shared;
  }

  private tagOf(id: string): string {
    const at = id.indexOf('~');
    return at > 0 ? id.slice(0, at) : '';
  }

  /**
   * Hands over again whatever changed since it was last handed over: a
   * renewed login, a guide added or removed, a channel matched. Run at start
   * and after this account's own changes.
   */
  async keepInStep(): Promise<void> {
    if (!this.accounts.managesFamily()) {
      return;
    }
    const view = this.view();
    const links = this.links();
    for (const [id, link] of Object.entries(links)) {
      const member = view?.members.find(candidate => String(candidate.id) === id);
      if (!member || !member.sealedEnc) {
        continue;
      }
      let changed = false;
      try {
        for (const [mine, tag] of Object.entries(link.providers)) {
          const record = this.access.records().find(candidate => recordId(candidate) === mine);
          if (record && link.handed?.[`p:${mine}`] !== fingerprint(record)) {
            await this.handProvider(await this.setupSession(member), record, tag);
            link.handed = { ...link.handed, [`p:${mine}`]: fingerprint(record) };
            changed = true;
          }
        }
        if (link.guides) {
          const { sources, mappings } = await this.guidesToHand(link);
          if (link.handed?.['guides'] !== fingerprint({ sources, mappings })) {
            await this.handGuides(member, link);
            changed = true;
          }
        }
      } catch (error) {
        console.warn(`Could not bring ${member.username} up to date`, error instanceof Error ? error.message : '');
      }
      if (changed) {
        this.saveLink(member.id, link);
      }
    }
  }

  private saveLink(memberId: number, link: FamilyLink): void {
    const links = this.links();
    const empty = !link.guides && Object.keys(link.providers).length === 0;
    if (empty) {
      delete links[String(memberId)];
    } else {
      links[String(memberId)] = link;
    }
    this.settings.set(SETTING_KEYS.familyLinks, JSON.stringify(links));
  }

  private dropLink(memberId: number): void {
    const links = this.links();
    if (links[String(memberId)]) {
      delete links[String(memberId)];
      this.settings.set(SETTING_KEYS.familyLinks, JSON.stringify(links));
    }
  }

  // --- A member's side -----------------------------------------------------

  /**
   * Makes the channel matches a manager handed over by name, once this
   * account's own catalogue is on the device. Once per hand-over: a device
   * that has made them does not make them again, and never undoes a match
   * the member made.
   */
  async makeHandedMatches(): Promise<void> {
    const raw = this.settings.get(SETTING_KEYS.familyGuideMatches);
    if (!raw) {
      return;
    }
    let handed: { at: string; matches: MatchByName[] };
    try {
      handed = JSON.parse(raw) as { at: string; matches: MatchByName[] };
    } catch {
      return;
    }
    const marker = `${MATCHES_APPLIED_KEY}:${this.accounts.storageName() ?? ''}`;
    if (!handed.matches?.length || localStorage.getItem(marker) === handed.at) {
      return;
    }

    const direct = await this.access.direct();
    const streams: Array<{ id: string; name: string }> = [];
    for (const slot of direct?.slots ?? []) {
      for (const stream of await slot.catalogue.allStreams('live').catch(() => [])) {
        streams.push({ id: tagged(slot.tag, stream.stream_id), name: stream.name });
      }
    }
    if (!streams.length) {
      // Not downloaded yet; the next start tries again.
      return;
    }

    const already = new Set(Object.keys(this.guides.mappings()));
    for (const match of resolveByName(handed.matches, streams, already)) {
      this.guides.map(match.streamId, match.channelId, match.sourceId);
    }
    localStorage.setItem(marker, handed.at);
  }

  // --- Plumbing ------------------------------------------------------------

  /** The accounts above a member, each with the public key to seal its `enc` for. */
  private managersOf(member: FamilyMember, view: FamilyView): Array<{ id: number; publicKey: string | null }> {
    const byId = new Map(view.members.map(candidate => [candidate.id, candidate]));
    const chain: Array<{ id: number; publicKey: string | null }> = [];
    let current = byId.get(member.managerId);
    while (current) {
      chain.push({ id: current.id, publicKey: current.publicKey });
      current = byId.get(current.managerId);
    }
    return [...chain, { id: view.me.id, publicKey: view.me.publicKey }, ...view.managers];
  }

  private async sealForManagers(
    enc: Uint8Array,
    managers: Array<{ id: number; publicKey: string | null }>
  ): Promise<Array<{ managerId: number; sealedEnc: string }>> {
    const sealed: Array<{ managerId: number; sealedEnc: string }> = [];
    for (const manager of managers) {
      if (manager.publicKey) {
        sealed.push({ managerId: manager.id, sealedEnc: await sealFor(toBase64(enc), manager.publicKey) });
      }
    }
    return sealed;
  }

  private async push(batch: ChangeSet, token?: string): Promise<void> {
    for (const piece of splitChangeSet(batch)) {
      await firstValueFrom(this.http.post(`${this.apiUrl}/devices/changes`, piece, token ? this.headers(token) : {}));
    }
  }

  private handKeyUpAgain(): boolean {
    try {
      return localStorage.getItem(HAND_KEY_UP_AGAIN) === '1';
    } catch {
      return false;
    }
  }

  private headers(token: string): { headers: HttpHeaders } {
    return { headers: new HttpHeaders({ Authorization: `Bearer ${token}` }) };
  }

  private async get<T>(path: string): Promise<T> {
    const response = await firstValueFrom(this.http.get<{ data: T }>(`${this.apiUrl}${path}`));
    return response.data;
  }

  private async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const response = await firstValueFrom(this.http.post<{ data: T }>(`${this.apiUrl}${path}`, body));
    return response.data;
  }
}
