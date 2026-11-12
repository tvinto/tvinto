import { StalkerPortal } from '@shared/stalker/client';
import { StalkerSource } from '@shared/stalker/stalkerSource';
import { stalkerSendFor } from './native/stalkerSend';
import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Catalogue, CatalogueStore } from '@shared/xtream/catalogue';
import { XtreamClient } from '@shared/xtream/client';
import { fnv1aHex, subscriptionId } from '@shared/xtream/guideSourceId';
import { API_URL } from './api-url';
import { DeviceDatabaseService } from './device-database.service';
import { PlatformService } from './platform.service';
import { CapacitorCatalogueStore } from './native/capacitorCatalogueStore';
import { IndexedDbCatalogueStore } from './native/indexedDbCatalogueStore';
import { MemoryCatalogueStore } from './native/memoryCatalogueStore';
import { CapacitorTransport } from './native/capacitorTransport';
import { FetchTransport } from './native/fetchTransport';
import { AccountKeysService } from './account-keys.service';
import { ServiceKindService } from './service-kind.service';
import { LocalProfileService } from './local-profile.service';
import { M3uSource } from '@shared/m3u/m3uSource';
import { m3uItems } from '@shared/m3u/m3uReader';
import { MergedCatalogue } from '@shared/providers/mergedCatalogue';
import { ProviderRecord, readProviderRecord, untagged } from '@shared/providers/providerRecord';
import { XtreamTransport } from '@shared/xtream/transport';
import { ProviderSlot, RoutedClient } from './routed-client';
import { downloadedGuideBytes, guideDownloadPlugin } from './native/guideDownload';

/**
 * Where the credentials are kept between launches.
 *
 * localStorage rather than a plugin, because in a packaged app it is not the
 * browser's shared storage at all -- it is a file inside the app's own private
 * data directory, readable by this app and nothing else. On a browser build
 * this is never written, because a browser never fetches them.
 */
const CREDENTIALS_KEY = 'xtream_provider_credentials';

/**
 * Every provider on the account, opened, kept beside the credentials for the
 * same reason: a device has to work with the sync service out of reach.
 */
const RECORDS_KEY = 'xtream_provider_records';

/** How long a playlist's host has to start answering. */
const PLAYLIST_CONNECT_MS = 15_000;

interface ProviderCredentials {
  serverUrl: string;
  username: string;
  password: string;
}

/**
 * Everything needed to talk to the providers without a backend in between.
 *
 * Every switched-on provider on the account, as one: the catalogue answers
 * over all of them and the client sends each id to the provider it names.
 * With one provider, that provider.
 */
export interface DirectProvider {
  client: RoutedClient;
  catalogue: MergedCatalogue;
  /** The first slot's Xtream username, which caches about the account are kept under. */
  providerUsername: string;
  slots: ProviderSlot[];
}

/**
 * Whether this device can reach the provider itself, and how.
 *
 * The runtime switch the native adapters were written for. A packaged build
 * gets a client over CapacitorHttp and a catalogue over the device's own
 * SQLite; a browser build gets nothing and carries on through the backend.
 *
 * The browser is not a lesser case to be filled in later -- it genuinely cannot
 * do this. The provider is HTTP-only with no TLS listener, and a page served
 * over HTTPS may not load HTTP content; a page served over HTTP still cannot
 * read a cross-origin response. Both rules are the browser's own and neither
 * has a way round from inside it. A native request is made by the platform
 * underneath, where neither applies.
 *
 * Everything here degrades to null rather than throwing. If the plugin is
 * missing, the database will not open or the account has no subscription
 * stored, the app should quietly go on working the way it did yesterday.
 */
@Injectable({ providedIn: 'root' })
export class ProviderAccessService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = inject(API_URL);
  private readonly keys = inject(AccountKeysService);
  private readonly serviceKind = inject(ServiceKindService);
  private readonly localProfile = inject(LocalProfileService);

  /** Whether the platform could support it, before anything is attempted. */
  private readonly platform = inject(PlatformService);

  /** Whether the platform could support it, before anything is attempted. */
  readonly supported = this.platform.canReachProviderDirectly;

  /** Whether it is actually working, for anything that wants to say so. */
  readonly active = signal(false);

  /** Set once the first attempt has settled, successfully or not. */
  private attempt: Promise<DirectProvider | null> | null = null;

  /** Every provider on the account, switched off ones included, as last read. */
  readonly records = signal<ProviderRecord[]>([]);

  /** Each switched-on provider's name by slot tag, while there are several; otherwise none. */
  private readonly namesWhenSeveral = computed<Record<string, string>>(() => {
    const on = this.records().filter(record => record.enabled);
    return on.length > 1 ? Object.fromEntries(on.map(record => [record.tag, record.label])) : {};
  });

  /** The name of the provider an id belongs to, or '' with only one provider. */
  providerNameOf(id: string | number): string {
    return this.namesWhenSeveral()[untagged(id).tag] ?? '';
  }

  /**
   * Counts the times the providers changed under a running app -- one added or
   * replaced on another device and heard about here -- for screens to load
   * their lists again.
   */
  readonly revision = signal(0);

  private readonly database = inject(DeviceDatabaseService);

  /**
   * The direct path, or null to go through the backend.
   *
   * Memoised on the promise rather than the result, so that several callers
   * arriving at once during startup share one attempt instead of each opening
   * their own database connection.
   */
  async direct(): Promise<DirectProvider | null> {
    if (!this.supported) {
      return null;
    }

    this.attempt ??= this.build().catch(error => {
      console.warn('Direct provider access unavailable; using the backend', error);
      return null;
    });

    return this.attempt;
  }

  /**
   * Forgets the direct path, so the next call builds it again.
   *
   * What a sign-out and a renewed subscription both need: the credentials in
   * hand are no longer the ones to use, and a client built from them would go
   * on using them until the app was restarted.
   */
  async reset(): Promise<void> {
    this.attempt = null;
    this.active.set(false);
    // Held in memory too, and drawn from: Account -> Family offered a
    // previous person's providers for sharing until this was cleared.
    this.records.set([]);

    try {
      localStorage.removeItem(CREDENTIALS_KEY);
      localStorage.removeItem(RECORDS_KEY);
    } catch {
      // Nothing depends on the removal succeeding; the memoised promise is
      // already cleared, which is what actually stops it being used.
    }

    await this.database.close();

    // The desktop's catalogues are these subscriptions', so a sign-out or a
    // renewal takes them with them rather than leaving them for the next person.
    const desktop = this.desktopCatalogues;
    this.desktopCatalogues = [];
    for (const store of desktop) {
      try {
        await store.clear();
        store.close();
      } catch {
        // Nothing depends on it: the rows are a cache, and they are keyed by
        // subscription, so another one cannot read them anyway.
      }
    }
  }

  /**
   * Gives a new sync service the subscription this device is already using.
   *
   * The rest of the account travels through the change feed; a subscription
   * does not, and would otherwise be the one thing left behind by a move.
   * The device would go on working -- it holds the credentials -- and the next
   * device to sign in would find an account with nothing to watch.
   *
   * Only when the service has none. Overwriting one that is already there
   * would mean an old device with stale credentials undoing a renewal done
   * somewhere else.
   *
   * Best effort throughout. A subscription that fails to travel is one to
   * enter again on the other device, which is a nuisance rather than a loss.
   */
  async offerSubscription(): Promise<boolean> {
    if (!(await this.serviceKind.encryptsSubscriptions())) {
      return false;
    }

    const credentials = this.readStoredCredentials();
    if (!credentials) {
      return false;
    }

    try {
      await firstValueFrom(
        this.http.get<unknown>(`${this.apiUrl}/accounts/providers/active`)
      );
      // It answered, so there is one there already.
      return false;
    } catch (error) {
      // 409 is "no subscription on this account", which is what is being
      // looked for. Anything else -- an unreachable service, a refused
      // session -- is not an invitation to write.
      if (!(error instanceof HttpErrorResponse) || error.status !== 409) {
        return false;
      }
    }

    try {
      const payload = await this.keys.seal(JSON.stringify(credentials));

      await firstValueFrom(
        this.http.post(`${this.apiUrl}/accounts/providers`, {
          id: subscriptionId(credentials.serverUrl, credentials.username),
          payload,
          active: true
        })
      );

      return true;
    } catch (error) {
      console.warn('Could not give the sync service this subscription', error);
      return false;
    }
  }

  // --- Internals ----------------------------------------------------------

  /** The desktop's catalogues, kept so a sign-out can clear them. */
  private desktopCatalogues: IndexedDbCatalogueStore[] = [];

  private async build(): Promise<DirectProvider | null> {
    const records = await this.loadRecords();
    this.records.set(records);
    const enabled = records.filter(record => record.enabled);
    if (enabled.length === 0) {
      // Said out loud. Returning null quietly here is indistinguishable from
      // working, and the difference -- whether the catalogue comes from the
      // provider or from a backend that has to be running -- is the whole
      // point of this class.
      console.warn('No subscription credentials available; using the backend');
      return null;
    }

    // Android must hand the request to the platform underneath, because a
    // WebView request is a browser request. Electron is already underneath,
    // and plain fetch does what the browser would have refused.
    const transport =
      this.platform.platform === 'electron' ? new FetchTransport() : new CapacitorTransport();
    const slots = await Promise.all(enabled.map(record => this.slot(record, transport)));

    this.active.set(true);
    const first = enabled.find(record => record.tag === '');
    return {
      client: new RoutedClient(slots),
      catalogue: new MergedCatalogue(
        slots.map(slot => ({ tag: slot.tag, catalogue: slot.catalogue })),
        // Screens load again once a provider that was not waited for arrives.
        { waitMs: 3_000, onLate: () => this.revision.update(count => count + 1) }
      ),
      providerUsername: first?.kind === 'xtream' ? first.username : '',
      slots
    };
  }

  /**
   * One provider, ready to ask.
   *
   * The first slot's catalogue is kept under its Xtream username, as it always
   * was, so a device updating into this keeps the catalogue it has. The others
   * are kept under their tag.
   */
  private async slot(record: ProviderRecord, transport: XtreamTransport): Promise<ProviderSlot> {
    const storeKey =
      record.kind === 'xtream'
        ? record.tag
          ? `${record.tag}:${record.username}`
          : record.username
        : record.kind === 'stalker'
          ? // By address and MAC: another portal, or another box on it, is another line-up.
            `portal:${record.tag || 'first'}:${fnv1aHex(`${record.portalUrl}|${record.mac.toUpperCase()}`)}`
          : // By address too: a replaced playlist is a different line-up, and
            // must not be served the old one's rows under the same slot.
            `m3u:${record.tag || 'first'}:${fnv1aHex(record.url)}`;
    const store = await this.store(storeKey);

    if (record.kind === 'xtream') {
      const xtream = new XtreamClient(transport, record);
      return { record, tag: record.tag, xtream, m3u: null, stalker: null, catalogue: new Catalogue(xtream, store), storeKey };
    }

    if (record.kind === 'stalker') {
      const login = record.username ? { login: { username: record.username, password: record.password ?? '' } } : {};
      // Where the API turned out to be, kept on the device under the slot's
      // key (a hash: no MAC in storage), so the next session goes straight there.
      const endpointKey = `tvinto_portal_endpoint:${storeKey}`;
      const remembered = (() => {
        try {
          return localStorage.getItem(endpointKey);
        } catch {
          return null;
        }
      })();
      const stalker = new StalkerSource(
        new StalkerPortal(stalkerSendFor(this.platform.platform), record.portalUrl, record.mac, {
          ...login,
          knownEndpoint: remembered,
          foundEndpoint: endpoint => {
            try {
              localStorage.setItem(endpointKey, endpoint);
            } catch {
              // Found again next time.
            }
          }
        })
      );
      return { record, tag: record.tag, xtream: null, m3u: null, stalker, catalogue: new Catalogue(stalker, store), storeKey };
    }

    const m3u = new M3uSource(() => m3uItems(this.playlistBytes(record.url)));
    return { record, tag: record.tag, xtream: null, m3u, stalker: null, catalogue: new Catalogue(m3u, store), storeKey };
  }

  /**
   * A playlist's bytes as they arrive. On Android through the download
   * plugin, to a file and back a chunk at a time -- a playlist with films held
   * whole would be the out-of-memory the guide download was built to avoid.
   */
  private async *playlistBytes(url: string): AsyncIterable<Uint8Array> {
    const plugin = this.platform.platform === 'electron' ? null : guideDownloadPlugin();
    if (plugin) {
      yield* downloadedGuideBytes(plugin, url, { connectTimeoutMs: PLAYLIST_CONNECT_MS, idleTimeoutMs: 60_000 });
      return;
    }
    // Without a limit, a playlist host that does not answer is waited on for
    // as long as the platform's own connect timeout -- measured on the
    // desktop at about fifty seconds, with every list held up behind it.
    const abort = new AbortController();
    const limit = setTimeout(() => abort.abort(), PLAYLIST_CONNECT_MS);
    const response = await fetch(url, { signal: abort.signal }).finally(() => clearTimeout(limit));
    if (!response.ok || !response.body) {
      throw new Error(`The playlist answered ${response.status}`);
    }
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  }

  // --- The account's providers -------------------------------------------

  /**
   * Every provider on the account: what this device kept, checked against
   * the sync service behind it; read from the service when nothing is kept;
   * and the one subscription's credentials when it has no records at all --
   * which is every device the first time it runs this, and the old backend.
   */
  private async loadRecords(): Promise<ProviderRecord[]> {
    const kept = this.readStoredRecords();
    // Without an account, what is kept here is all there is.
    if (this.localProfile.active()) {
      return kept ?? [];
    }
    if (kept) {
      void this.checkRecords(kept);
      return kept;
    }

    const fetched = await this.fetchRecords().catch(() => null);
    if (fetched && fetched.length > 0) {
      this.storeRecords(fetched);
      return fetched;
    }

    const credentials = await this.credentials();
    return credentials ? [{ kind: 'xtream', tag: '', label: '', enabled: true, ...credentials }] : [];
  }

  /**
   * Puts a changed list of providers into use here: kept, and the providers
   * built again on the next request, with screens told to load again.
   */
  useRecords(records: ProviderRecord[]): void {
    this.storeRecords(records);
    this.records.set(records);
    this.attempt = null;
    this.revision.update(count => count + 1);
  }

  /** Whether this device keeps any provider, read before anything is built. */
  hasStoredRecords(): boolean {
    return (this.readStoredRecords()?.length ?? 0) > 0;
  }

  /** The account's providers, read if they have not been yet. */
  async loadedRecords(): Promise<ProviderRecord[]> {
    await this.direct();
    return this.records();
  }

  /**
   * Hears about providers added, changed or removed on another device. The
   * next request builds the providers again, and screens holding lists are
   * told (`revision`).
   */
  private async checkRecords(kept: ProviderRecord[]): Promise<void> {
    const fetched = await this.fetchRecords().catch(() => null);
    if (!fetched || fetched.length === 0 || JSON.stringify(fetched) === JSON.stringify(kept)) {
      return;
    }
    this.storeRecords(fetched);
    this.records.set(fetched);
    this.attempt = null;
    this.revision.update(count => count + 1);
  }

  /**
   * The account's providers from the sync service, each opened with this
   * device's key. A row in the old shape (one subscription, no slot) counts
   * only while it is the active one: the server keeps the ones it replaced.
   * Null when there is nothing here that could be opened.
   */
  private async fetchRecords(): Promise<ProviderRecord[] | null> {
    if (!(await this.serviceKind.encryptsSubscriptions())) {
      return null;
    }
    const records = await this.readAccountRecords();
    return records.length ? records : null;
  }

  /**
   * The account's providers as the sync service holds them, none being an
   * answer: for a device bringing its own to an account (SyncStartService),
   * which must not take "could not read them" for "there are none". Throws
   * for the first.
   */
  async accountRecords(): Promise<ProviderRecord[]> {
    if (!(await this.serviceKind.encryptsSubscriptions())) {
      throw new Error('This server does not keep providers');
    }
    return this.readAccountRecords();
  }

  /** What this device keeps, read straight from storage. */
  storedRecords(): ProviderRecord[] {
    return this.readStoredRecords() ?? [];
  }

  private async readAccountRecords(): Promise<ProviderRecord[]> {
    const response = await firstValueFrom(
      this.http.get<{ success: boolean; data: { id: string; payload: string; active: boolean }[] }>(
        `${this.apiUrl}/accounts/providers`
      )
    );

    const records: ProviderRecord[] = [];
    for (const row of response.data ?? []) {
      const opened = row.payload ? await this.keys.open(row.payload) : null;
      const record = readProviderRecord(opened);
      if (!record || (!opened!.includes('"kind"') && !row.active)) {
        continue;
      }
      // Newest first from the server, so a slot's latest record wins.
      if (!records.some(existing => existing.tag === record.tag)) {
        records.push(record);
      }
    }
    // The first slot first, the rest in the order the server gave them.
    records.sort((a, b) => (a.tag === '' ? -1 : b.tag === '' ? 1 : 0));
    return records;
  }

  private readStoredRecords(): ProviderRecord[] | null {
    try {
      const raw = localStorage.getItem(RECORDS_KEY);
      const list = raw ? (JSON.parse(raw) as unknown[]) : null;
      if (!Array.isArray(list)) {
        return null;
      }
      const records = list
        .map(item => readProviderRecord(JSON.stringify(item)))
        .filter((record): record is ProviderRecord => record !== null);
      return records.length ? records : null;
    } catch {
      return null;
    }
  }

  private storeRecords(records: ProviderRecord[]): void {
    try {
      localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
      const first = records.find(record => record.tag === '' && record.kind === 'xtream');
      if (first?.kind === 'xtream') {
        const { serverUrl, username, password } = first;
        localStorage.setItem(CREDENTIALS_KEY, JSON.stringify({ serverUrl, username, password }));
      } else {
        // The first provider removed, or never an Xtream login: its copy must
        // go too. With nothing in the list, loading falls back to this copy --
        // and brought a removed subscription straight back.
        localStorage.removeItem(CREDENTIALS_KEY);
      }
    } catch {
      // Usable for this launch even if it cannot be kept for the next.
    }
  }

  /**
   * Where this platform keeps the catalogue it has seen.
   *
   * A phone gets a database, because it has one and because a catalogue that
   * survives a restart is what lets it open instantly away from any network.
   * The desktop gets memory: the plugin that would give Electron a database
   * wants a native module rebuilt against Electron's own ABI, which is a great
   * deal of machinery for a cache the provider will refill on request. The cost
   * is one request per category per launch, and the lazy policy above still
   * decides when that happens.
   */
  private async store(providerUsername: string): Promise<CatalogueStore> {
    if (this.platform.platform === 'electron') {
      // IndexedDB rather than memory, because one thing in the catalogue is
      // not per category: the whole-library index behind search. In memory its
      // freshness mark died with the window, so the first search of every
      // launch rebuilt the index -- "once a day" in practice meant once a
      // session. A store that cannot keep it is a store that cannot honour it.
      try {
        const store = new IndexedDbCatalogueStore(providerUsername);
        await store.initialise();
        this.desktopCatalogues.push(store);
        return store;
      } catch {
        // A browser that will not open IndexedDB (a private window, or storage
        // refused) still gets a working app, one launch at a time.
        return new MemoryCatalogueStore();
      }
    }

    const db = await this.database.connect();
    const store = new CapacitorCatalogueStore(db, providerUsername);
    await store.initialise();
    return store;
  }

  /**
   * What the Subscription page shows in its fields: the address, username and
   * password this device uses, or null where it has none (a browser build, or
   * a subscription this device cannot open). Shown, never logged.
   */
  async currentCredentials(): Promise<Readonly<ProviderCredentials> | null> {
    try {
      return await this.credentials();
    } catch {
      return null;
    }
  }

  /**
   * The subscription's credentials, from disk if they are there.
   *
   * Asked for once and kept, because the point of holding them is to work when
   * the backend cannot be reached -- fetching them on every launch would put
   * the backend back on the critical path it is being taken off.
   */
  private async credentials(): Promise<ProviderCredentials | null> {
    const stored = this.readStoredCredentials();
    if (stored) {
      return stored;
    }

    const fetched = (await this.serviceKind.encryptsSubscriptions())
      ? await this.sealedCredentials()
      : await this.backendCredentials();

    if (!fetched?.username) {
      return null;
    }

    const credentials = {
      serverUrl: fetched.serverUrl,
      username: fetched.username,
      password: fetched.password
    };

    try {
      localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(credentials));
    } catch {
      // Usable for this launch even if it cannot be kept for the next.
    }

    return credentials;
  }

  /**
   * From the backend, which decrypts them with a key sitting beside its
   * database and hands them over.
   */
  private async backendCredentials(): Promise<ProviderCredentials | null> {
    const response = await firstValueFrom(
      this.http.get<{ success: boolean; data: ProviderCredentials }>(
        `${this.apiUrl}/accounts/providers/active/credentials`
      )
    );

    return response.success ? response.data : null;
  }

  /**
   * From the sync service, which hands over a sealed blob and cannot do more.
   *
   * The asymmetry is the whole design. There is no endpoint there that returns
   * credentials, because there is nothing there that could produce them: the
   * key is derived from the account password and never left this device.
   */
  private async sealedCredentials(): Promise<ProviderCredentials | null> {
    const response = await firstValueFrom(
      this.http.get<{ success: boolean; data: { payload: string } }>(
        `${this.apiUrl}/accounts/providers/active`
      )
    );

    const opened = response.data?.payload
      ? await this.keys.open(response.data.payload)
      : null;

    if (!opened) {
      // Either there is no key on this device, or the account password was
      // changed elsewhere and this one still holds the old one. Both mean the
      // subscription has to be entered again here.
      console.warn('The stored subscription could not be opened with this account key');
      return null;
    }

    try {
      return JSON.parse(opened) as ProviderCredentials;
    } catch {
      return null;
    }
  }

  private readStoredCredentials(): ProviderCredentials | null {
    try {
      const raw = localStorage.getItem(CREDENTIALS_KEY);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw) as Partial<ProviderCredentials>;
      // A half-written entry is worse than none: it would build a client that
      // authenticates as nobody and fails every request.
      if (!parsed.serverUrl || !parsed.username || !parsed.password) {
        return null;
      }

      return parsed as ProviderCredentials;
    } catch {
      return null;
    }
  }
}
