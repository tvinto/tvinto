import { normaliseMac } from '@shared/stalker/client';
import { t } from '../utils/i18n';
import { recordAddress } from '@shared/providers/providerRecord';
import { Injectable, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ProviderRecord, hostOf, newTag, recordId } from '@shared/providers/providerRecord';
import { API_URL } from './api-url';
import { AccountKeysService } from './account-keys.service';
import { ProviderAccessService } from './provider-access.service';
import { GuideSourcesService } from './guide-sources.service';
import { CarryOverService } from './carry-over.service';
import { AccountService } from './account.service';

/** What the form on the Account page hands over for a provider. */
export type ProviderInput =
  | { kind: 'xtream'; label: string; serverUrl: string; username: string; password: string }
  | { kind: 'm3u'; label: string; url: string }
  | { kind: 'stalker'; label: string; portalUrl: string; mac: string };

/**
 * The account's providers: added, replaced, switched off and removed.
 *
 * Without an account they are kept on the device and nowhere else
 * (LocalProfileService). With one, each is a sealed record in a
 * `provider_accounts` row. One row is saved
 * `active` -- the server counts an account as having a subscription by it, and
 * an older app reads it as the subscription -- and when that provider is
 * removed another takes the flag.
 */
@Injectable({ providedIn: 'root' })
export class ProvidersService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = inject(API_URL);
  private readonly keys = inject(AccountKeysService);
  private readonly access = inject(ProviderAccessService);
  private readonly carry = inject(CarryOverService);
  private readonly guides = inject(GuideSourcesService);
  private readonly accounts = inject(AccountService);

  /**
   * Every provider, alike: each can be switched off, replaced and removed,
   * the one added first included (9 October: "just add as many you
   * want, and delete whatever you want"). There used to be a "main
   * subscription" that could only be replaced -- a leftover of the app having
   * had one provider -- and a free playlist added first could not make way for
   * a paid subscription added after it.
   *
   * The first keeps its empty tag, which is only what its ids are written
   * with; nothing depends on there being one.
   */
  readonly all = computed(() => this.access.records());

  /** Every provider but the one with the empty tag, for the old Subscription panel's list. */
  readonly others = computed(() => this.access.records().filter(record => record.tag !== ''));

  /** The server ids of the providers the Subscription panel should leave alone. */
  readonly otherIds = computed(() => new Set(this.others().map(recordId)));

  /** Whether this build keeps providers itself -- not a browser, which goes through the backend. */
  readonly supported = this.access.supported;

  load(): Promise<ProviderRecord[]> {
    return this.access.loadedRecords();
  }

  async add(input: ProviderInput): Promise<void> {
    // A tag of its own whenever there is anything here already. Not the empty
    // tag a removed first provider left: its favourites and history stay on
    // the account, and a newcomer under the same tag would take them over.
    const taken = this.access.records().map(record => record.tag);
    const tag = taken.length ? newTag([...taken, '']) : '';
    await this.save({ ...this.recordFrom(input), tag, enabled: true });
    this.accounts.hasSubscription.set(true);
    // Its own guide comes with it (GuideSourcesService.addGuidesOf).
    await this.guides.addGuidesOf(tag).catch(() => 0);
  }

  /**
   * A new login or address for a provider that already has a slot -- what an
   * expired subscription needs. The slot's tag stays, and with it everything
   * the account has stored under it.
   */
  async replace(record: ProviderRecord, input: ProviderInput): Promise<number> {
    // Read before the switch: afterwards the old provider's catalogue is no
    // longer the one this slot is built from.
    const snapshot = await this.carry.snapshot(record.tag).catch(() => null);
    const next: ProviderRecord = { ...this.recordFrom(input), tag: record.tag, enabled: record.enabled };
    await this.save(next);
    if (recordId(next) !== recordId(record)) {
      await this.deleteRow(recordId(record));
    }
    await this.guides.addGuidesOf(record.tag).catch(() => 0);
    return snapshot ? this.carry.carryOver(snapshot).catch(() => 0) : 0;
  }

  setEnabled(record: ProviderRecord, enabled: boolean): Promise<void> {
    return this.save({ ...record, enabled });
  }

  async remove(record: ProviderRecord): Promise<void> {
    const wasActive = activeTag(this.access.records()) === record.tag;
    await this.deleteRow(recordId(record));
    const rest = this.access.records().filter(existing => existing.tag !== record.tag);
    this.access.useRecords(rest);
    // The service counts an account as having a subscription by its active
    // row. The first provider's going must not leave an account with a paid
    // one looking as if it had none -- and every device sending it back to
    // "add a subscription" -- so another takes the flag.
    const next = rest.find(existing => existing.tag === activeTag(rest));
    if (wasActive && next) {
      await this.save(next);
    }
    this.accounts.hasSubscription.set(rest.length > 0);
  }

  private async save(record: ProviderRecord): Promise<void> {
    const records = this.access.records();
    const at = records.findIndex(existing => existing.tag === record.tag);
    const after = at < 0 ? [...records, record] : records.map((existing, i) => (i === at ? record : existing));
    if (this.accounts.localProfile.active()) {
      this.access.useRecords(after);
      return;
    }
    await this.sendToAccount(record, after);
    this.access.useRecords(after);
  }

  /**
   * One provider, sealed, onto the account, among `all` it will have: also
   * how a device's own providers join the account it signs in to
   * (SyncStartService).
   */
  async sendToAccount(record: ProviderRecord, all: readonly ProviderRecord[]): Promise<void> {
    const payload = await this.keys.seal(JSON.stringify(record));
    await firstValueFrom(
      this.http.post(`${this.apiUrl}/accounts/providers`, {
        id: recordId(record),
        payload,
        // One row is the account's subscription to the service, and to an
        // older app: the empty-tagged one while there is one, else the first.
        active: activeTag(all) === record.tag
      })
    );
  }

  private deleteRow(id: string): Promise<unknown> {
    if (this.accounts.localProfile.active()) {
      return Promise.resolve();
    }
    return firstValueFrom(this.http.delete(`${this.apiUrl}/accounts/providers/${encodeURIComponent(id)}`));
  }

  private recordFrom(input: ProviderInput): ProviderRecord {
    const label = input.label.trim() || hostOf(recordAddress(input));
    if (input.kind === 'stalker') {
      const mac = normaliseMac(input.mac);
      if (!mac) {
        throw new Error(t('providers.macInvalid'));
      }
      return { kind: 'stalker', tag: '', enabled: true, label, portalUrl: input.portalUrl.trim(), mac };
    }
    return input.kind === 'xtream'
      ? {
          kind: 'xtream',
          tag: '',
          enabled: true,
          label,
          serverUrl: input.serverUrl.trim(),
          username: input.username.trim(),
          password: input.password
        }
      : { kind: 'm3u', tag: '', enabled: true, label, url: input.url.trim() };
  }
}

/** The tag of the provider the service keeps as the account's subscription: the empty one while there is one, else the first. */
const activeTag = (records: readonly ProviderRecord[]): string | null =>
  records.some(record => record.tag === '') ? '' : (records[0]?.tag ?? null);
