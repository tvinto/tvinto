import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  ChannelMapping,
  GuideSource,
  GuideSourceState,
  addSource,
  emptyGuideSources,

  enabledSources,
  mapChannel,
  removeSource,
  mergeIncoming,
  setSourceEnabled,
  sourceStamp,
  touchSource,
  unmapChannel
} from '@shared/xtream/guideSources';
import { ChangeSet } from '@shared/sync';
import { guideSourceId } from '@shared/xtream/guideSourceId';
import { accountStorageKey, adoptableLegacyValue } from '../utils/account-storage.utils';
import { takeBrought } from '../utils/local-drawers.utils';
import { AccountService } from './account.service';
import { AccountKeysService } from './account-keys.service';
import { GuideService } from './guide.service';
import { LocalUserDataService } from './local-user-data.service';
import { ProviderAccessService } from './provider-access.service';
import { isMeteredConnection } from '../utils/connection.utils';
import { technicalDetail } from '../utils/failure-messages.utils';
import { wasLoadedHere } from './guide-loaded-here';
import { t } from '../utils/i18n';

/**
 * Where the account's guide sources and channel mappings are kept.
 *
 * In localStorage beside the favourites and watch history, and for the same
 * reasons: it is small, it is the account's rather than the device's, and it
 * is work a person did by hand that must survive a restart.
 *
 * Not in the guide store. That holds the downloaded guide, which is large and
 * disposable and on the desktop lives only as long as the window -- exactly
 * the wrong place for the one thing here that cannot be fetched again.
 *
 * Keyed by account, as LocalUserDataService is, because inheriting someone
 * else's guides would be as wrong as inheriting their favourites. When the
 * sync service exists this is what travels, encrypted.
 */

const STORAGE_PREFIX = 'xtream_guide_sources';

/** What the first provider's guide is called in the list, as it always has been. */
export const PROVIDER_GUIDE_LABEL = 'Your provider';

/** The name onboarding gives EPG Share's Croatian guide. */
export const EPG_SHARE_LABEL = 'EPG Share · Croatia';

/**
 * A guide's name as shown. The two the app names itself are kept in English,
 * since the name is stored and synced, and shown in the language in use; a
 * name somebody typed is shown as typed. Onboarding, a channel's guide
 * picker and For You showed them in English until 12 November.
 */
export function guideName(label: string): string {
  if (label === PROVIDER_GUIDE_LABEL) {
    return t('guides.yourProvider');
  }
  return label === EPG_SHARE_LABEL ? t('guides.epgShare') : label;
}

/** A provider's own guide, ready to add. The address is a credential. */
export interface ProviderGuide {
  id: string;
  label: string;
  url: string;
  /** The provider it belongs to (its slot's tag; '' for the first). */
  tag: string;
}

/** Whether stored text is a set of guides rather than an empty shell. */
const holdsSomething = (raw: string): boolean => {
  try {
    const parsed = JSON.parse(raw) as Partial<GuideSourceState>;
    return (parsed.sources ?? []).length > 0 || Object.keys(parsed.mappings ?? {}).length > 0;
  } catch {
    return false;
  }
};

@Injectable({ providedIn: 'root' })
export class GuideSourcesService {
  private readonly accounts = inject(AccountService);
  private readonly provider = inject(ProviderAccessService);
  private readonly keys = inject(AccountKeysService);
  private readonly guide = inject(GuideService);
  private readonly local = inject(LocalUserDataService);

  private readonly state = signal<GuideSourceState>(emptyGuideSources());
  private loadedFor: string | null = null;

  /**
   * Guides mended once already, this launch.
   *
   * A bound on `reseal`. Without it, a device whose own key is the stale one
   * would answer every unreadable copy with another unreadable copy, for as
   * long as it was running.
   */
  private readonly resealed = new Set<string>();

  /**
   * These read the signal and nothing else.
   *
   * Reading storage from inside a computed is what NG0600 forbids, and rightly:
   * a computed that loads is a computed that writes, and Angular cannot tell
   * when it is safe to re-run. Loading happens in the effect below and in
   * `ensureLoaded`, both of which are outside any reactive read.
   */
  readonly sources = computed(() => this.state().sources);
  readonly enabled = computed(() => enabledSources(this.state()));
  readonly mappings = computed(() => this.state().mappings);

  /** How many channels have been tied to a guide by hand. */
  readonly mappedCount = computed(() => Object.keys(this.state().mappings).length);

  /**
   * Guides this account uses that this device has not downloaded.
   *
   * The one thing about a guide that is device state rather than account
   * state, and the reason the account keeps the address at all: signing in on
   * a new machine should offer what you already use rather than send you
   * looking for a URL again.
   *
   * Offered rather than fetched, except on the first sync of a device on an
   * unmetered connection (`loadFirstTimeHere`). A guide is tens of megabytes
   * and a phone on mobile data should get a choice -- and a device that
   * declines is not out of step with the others, it simply has no local copy.
   *
   * A signal rather than a call, because two places ask: the screen that lists
   * guides, and the badge that gets somebody to open it.
   */
  readonly missingHere = signal<GuideSource[]>([]);

  constructor() {
    // Whose data this holds changes when the account does, and inheriting the
    // previous account's guides would be as wrong as inheriting their
    // favourites. Untracked so that reading storage cannot itself become a
    // dependency of the effect.
    effect(() => {
      this.accounts.storageName();
      untracked(() => {
        this.loadFor();
        void this.refreshMissing();
      });
    });
  }

  /**
   * Works out which of the account's guides are absent from this device.
   *
   * Asked of the guide store rather than remembered, because "have I got this"
   * is a question only the store can answer -- and on the desktop the answer
   * changed the day the store started surviving a restart.
   */
  async refreshMissing(): Promise<void> {
    const sources = this.ensureLoaded().sources.filter(source => source.enabled);

    if (!sources.length) {
      this.missingHere.set([]);
      return;
    }

    const absent = new Set(await this.guide.missing(sources.map(source => source.id)));
    this.missingHere.set(sources.filter(source => absent.has(source.id)));
  }

  add(url: string, label?: string): void {
    const next = this.mutate(state => addSource(state, url, { label }));
    this.send(guideSourceId(url), next);
  }

  remove(sourceId: string): void {
    this.mutate(state => removeSource(state, sourceId));
    this.local.queueGuideSourceRemoval(sourceId);
  }

  setEnabled(sourceId: string, enabled: boolean): void {
    const next = this.mutate(state => setSourceEnabled(state, sourceId, enabled));
    this.send(sourceId, next);
  }

  map(streamId: string, channelId: string, sourceId: string): void {
    const next = this.mutate(state => mapChannel(state, streamId, channelId, sourceId));
    const stored = next.mappings[String(streamId)];

    // The queued stamp is the one just written locally, not a fresh one. Two
    // different stamps for one act would have this device reconcile against
    // its own write.
    this.local.queueChannelMapping(
      { streamId: String(streamId), sourceId, channelId },
      stored.mappedAt
    );
  }

  unmap(streamId: string): void {
    this.mutate(state => unmapChannel(state, streamId));
    this.local.queueChannelMappingRemoval(String(streamId));
  }

  /**
   * Queues every guide and mapping, for a server that has never seen them.
   *
   * The mappings are the reason this matters more than it looks. Nearly half a
   * real line-up carries no channel id, so those were tied to a guide by hand,
   * one at a time -- the most expensive thing in the account to lose and the
   * least visible when it goes.
   */
  requeueEverything(): void {
    const state = this.ensureLoaded();

    for (const source of state.sources) {
      this.send(source.id, state);
    }

    for (const mapping of Object.values(state.mappings)) {
      this.local.queueChannelMapping(
        {
          streamId: mapping.streamId,
          sourceId: mapping.sourceId,
          channelId: mapping.channelId
        },
        mapping.mappedAt
      );
    }
  }

  /**
   * Queues a source for the account's other devices, sealed.
   *
   * Nothing is awaited by the caller. The local state is already written, so
   * the guide works on this device either way, and a source that failed to
   * seal is a source that does not travel rather than one that is lost -- said
   * out loud, because the alternative is a silence that looks like success.
   *
   * The mappings need none of this: a stream id and `HTV1.hr` are not secrets,
   * so they are queued directly above.
   */
  private send(sourceId: string, state: GuideSourceState): void {
    const source = state.sources.find(candidate => candidate.id === sourceId);
    // Without an account there is nothing to seal with and nowhere to send
    // it; signing in to sync sends every guide then (requeueEverything).
    if (!source || this.accounts.localProfile.active()) {
      return;
    }

    void this.keys
      .seal(
        JSON.stringify({
          label: source.label,
          url: source.url,
          enabled: source.enabled,
          addedAt: source.addedAt
        })
      )
      .then(payload => this.local.queueGuideSource(sourceId, payload, sourceStamp(source)))
      .catch(error =>
        console.warn('This guide is saved here but will not reach your other devices', error)
      );
  }

  /**
   * Folds in what the account's other devices have done.
   *
   * Last-write-wins on the same timestamps the servers compare, so both ends
   * reach the same answer from the same facts rather than one deferring to the
   * other.
   *
   * A source that will not open is skipped rather than shown broken. It means
   * the account password was changed on another device and this one still
   * holds the old key; the honest reading is "there is nothing here for you".
   */
  async applyIncoming(incoming: Partial<ChangeSet>): Promise<void> {
    const sources = incoming.guideSources ?? [];
    const mappings = incoming.channelMappings ?? [];
    const deletions = (incoming.deletions ?? []).filter(
      deletion => deletion.kind === 'guideSource' || deletion.kind === 'channelMapping'
    );

    if (!sources.length && !mappings.length && !deletions.length) {
      return;
    }

    const opened = new Map<string, GuideSource>();
    const unreadable: string[] = [];

    for (const change of sources) {
      const text = await this.keys.open(change.payload);
      if (!text) {
        console.warn('A guide from another device could not be opened with this account key');
        unreadable.push(change.id);
        continue;
      }

      try {
        const details = JSON.parse(text) as Omit<GuideSource, 'id'>;
        opened.set(change.id, {
          id: change.id,
          label: details.label,
          url: details.url,
          enabled: details.enabled !== false,
          addedAt: details.addedAt ?? change.updatedAt
        });
      } catch {
        console.warn('A guide from another device opened into something unreadable');
      }
    }

    this.mutate(state =>
      mergeIncoming(state, {
        sources: sources.map(change => ({ change, source: opened.get(change.id) })),
        mappings,
        deletions
      })
    );

    this.reseal(unreadable);

    // A guide that just arrived from another device is, by definition, one
    // this device has not downloaded. Working that out here is what turns a
    // sync into an offer.
    await this.refreshMissing();
  }

  /**
   * Looks over the account's guides as the service holds them, and mends the
   * ones this device can still read but the account can no longer open.
   *
   * Called with everything rather than with what has changed, because what is
   * wrong with these is that they have *not* changed: a guide sealed under a
   * key the account no longer has sits there, in a window every device has
   * already synced past. See `DeviceSyncService.auditGuides`.
   */
  async repairUnreadable(sources: Array<{ id: string; payload: string }>): Promise<void> {
    const unreadable: string[] = [];

    for (const source of sources) {
      if (!(await this.keys.open(source.payload))) {
        unreadable.push(source.id);
      }
    }

    this.reseal(unreadable);
  }

  /**
   * Sends back, under the current key, a guide the service holds sealed under
   * a dead one.
   *
   * This is repair, not sync, and it exists because the failure it repairs was
   * found on a real account. Two guides sat on the service sealed under a key
   * no device had any more -- a key changes when an account is enrolled or its
   * password is -- and every device that could read them held them locally
   * anyway, so nothing ever noticed. A device signing in for the first time
   * got the mappings, which travel in the clear, and none of the guides they
   * point at.
   *
   * Only a device holding the plaintext can mend it, and it is exactly the
   * device that cannot tell there is anything wrong: it never needs to open
   * the copy on the service. So being unable to open one is treated as the
   * signal.
   *
   * Two things keep it from becoming a fight. The re-seal uses the key this
   * device has now, so once it lands every device that can sign in can read it
   * -- there is nothing left to repair. And each id is mended once per launch,
   * so a device whose own key is the stale one gives up rather than trading
   * unreadable copies for ever.
   */
  private reseal(ids: string[]): void {
    // Loaded rather than read: the audit can reach here before anything else
    // has touched storage, and an empty state would look exactly like a device
    // with nothing to mend anything with.
    const state = this.ensureLoaded();

    for (const id of ids) {
      if (this.resealed.has(id)) {
        continue;
      }

      const held = state.sources.find(source => source.id === id);
      if (!held) {
        // Nothing to mend it with. This is the ordinary case on a new device,
        // and the guide is simply not available to it.
        continue;
      }

      this.resealed.add(id);
      console.warn(`Re-sending "${held.label}" sealed under this account's current key`);

      // A fresh stamp, unlike every other queued change. Those carry the time
      // of the write they describe, so a device cannot lose to its own older
      // writes; this is a new write, and it has to beat the copy it replaces.
      this.send(id, this.mutate(current => touchSource(current, id)));
    }
  }

  mappingFor(streamId: string | number): ChannelMapping | undefined {
    return this.ensureLoaded().mappings[String(streamId)];
  }

  /**
   * The subscription's own guide, if there is one to offer.
   *
   * Xtream serves XMLTV at `xmltv.php` on the same host, authenticated the
   * same way, so a provider guide is not a special kind of source -- it is an
   * ordinary one whose URL can be worked out rather than typed. Which matters
   * on a television, where typing anything is a chore.
   *
   * Null when no subscription is stored, or when this build cannot reach a
   * provider directly and therefore has no credentials to build it from.
   */
  async providerGuideUrl(): Promise<string | null> {
    const direct = await this.provider.direct();
    if (!direct) {
      return null;
    }

    try {
      // Asked of the client rather than assembled here: the credentials are
      // its own, and code that could build this URL would be code holding the
      // password. The first provider's: the others' guides are offered as
      // their own.
      return direct.client.primary?.guideUrl() ?? null;
    } catch {
      return null;
    }
  }

  /** Adds the subscription's own guide, and says whether there was one. */
  async addProviderGuide(): Promise<boolean> {
    const url = await this.providerGuideUrl();
    if (!url) {
      return false;
    }

    this.add(url, PROVIDER_GUIDE_LABEL);
    return true;
  }

  /**
   * Every provider's own guide: an Xtream login's, and what a playlist names
   * in its header (`x-tvg-url`) -- one per address, since a playlist may name
   * several. The first provider's keeps the label it always had, which is
   * how the Guides page has found it since before there could be others.
   *
   * The addresses carry credentials: for adding, never for showing.
   */
  async providerGuides(): Promise<ProviderGuide[]> {
    const direct = await this.provider.direct();
    if (!direct) {
      return [];
    }

    const guides: ProviderGuide[] = [];
    for (const slot of direct.slots) {
      try {
        const urls = slot.xtream ? [slot.xtream.guideUrl()] : ((await slot.m3u?.guideUrls()) ?? []);
        urls.forEach((url, index) =>
          guides.push({
            id: guideSourceId(url),
            url,
            tag: slot.tag,
            label:
              slot.tag === ''
                ? PROVIDER_GUIDE_LABEL
                : urls.length > 1
                  ? `${slot.record.label} ${index + 1}`
                  : slot.record.label
          })
        );
      } catch {
        // A playlist that cannot be read offers no guide this time.
      }
    }
    return guides;
  }

  /**
   * Adds a provider's own guide when the account does not have it yet --
   * what a subscription brings with it (5 October 2026: a friend
   * set up from somebody else's device had no way of knowing to press "Use my
   * provider's guide"). Only the provider named, just added or replaced: a
   * guide somebody removed stays removed until its provider changes.
   *
   * Then loaded on this device, as the Guides page's own button does, but in
   * the background -- except in a family member's setup, whose guide is for
   * their devices, and on a metered connection, where the Guides page offers
   * it instead. Says how many were added.
   */
  async addGuidesOf(tag: string): Promise<number> {
    const missing = (await this.providerGuides()).filter(
      guide => guide.tag === tag && !this.sources().some(source => source.id === guide.id)
    );
    for (const guide of missing) {
      this.add(guide.url, guide.label);
    }
    if (missing.length && this.accounts.profileScope() !== 'setup' && !isMeteredConnection()) {
      void (async () => {
        for (const guide of missing) {
          // One at a time, as the guide store allows; the addresses carry the
          // provider's password, so a failure is logged without them.
          await this.guide
            .load(guide.id, guide.url)
            .catch((error: unknown) => console.warn('Could not load a provider guide', technicalDetail(error)));
        }
      })();
    }
    return missing.length;
  }

  /**
   * The account's guides, downloaded on a device that has just signed in to
   * it, in the background, one at a time -- as `addGuidesOf` does for a
   * provider's own guide, and with the same exceptions: not in a family
   * member's setup, and not on a metered connection, where "No guide on this
   * device yet" offers them instead.
   *
   * Only those this device has never loaded. A guide it once had and lost is
   * GuideReloadService's (`guide-loaded-here.ts`), and a guide added later on
   * another device stays an offer: this is for the first sync, when a device
   * with an account's history and favourites and no guide at all is a For You
   * with nothing on now (12 November).
   */
  async loadFirstTimeHere(): Promise<void> {
    if (this.accounts.profileScope() === 'setup' || isMeteredConnection() || !this.guide.supported) {
      return;
    }
    const owner = this.accounts.storageName();
    await this.refreshMissing();
    const fresh = this.missingHere().filter(source => !wasLoadedHere(source.id));
    for (const source of fresh) {
      // The guide store takes one at a time; one somebody started waits its turn.
      while (this.guide.isLoading()) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      // Signed out, or somebody else, while waiting.
      if (this.accounts.storageName() !== owner) {
        return;
      }
      await this.guide
        .load(source.id, source.url)
        .catch((error: unknown) => console.warn('Could not load a guide from the account', technicalDetail(error)));
    }
    if (fresh.length) {
      await this.refreshMissing();
    }
  }

  /** Throws it all away, for a sign-out. */
  forget(): void {
    this.loadedFor = null;
    this.state.set(emptyGuideSources());
    try {
      localStorage.removeItem(this.storageKey());
    } catch {
      // The in-memory state is already cleared, which is what stops it being used.
    }
  }

  private storageKey(): string {
    return accountStorageKey(STORAGE_PREFIX, this.accounts.storageName());
  }

  /**
   * What is stored for this account, adopting an older build's copy once.
   *
   * The mappings are the reason this is worth the care. They are the one thing
   * here that cannot be fetched again from anywhere: somebody tied streams to
   * guide channels by hand, one at a time.
   */
  private readStored(): string | null {
    const key = this.storageKey();

    try {
      const held = localStorage.getItem(key);

      // An empty drawer under the right name counts as no drawer at all: see
      // the same guard in LocalUserDataService, and for the same reason.
      if (held !== null && holdsSomething(held)) {
        return held;
      }

      const carried = adoptableLegacyValue(
        STORAGE_PREFIX,
        Object.keys(localStorage),
        name => localStorage.getItem(name),
        holdsSomething
      );

      if (carried) {
        // Moved rather than copied. A drawer left behind is one that signing out
        // does not know to remove, and that the next read adopts straight back.
        localStorage.setItem(key, carried.raw);
        localStorage.removeItem(carried.key);
        return carried.raw;
      }

      return held;
    } catch {
      return null;
    }
  }

  /**
   * The state, loading it first if this is the first ask.
   *
   * Called only from places that are not inside a reactive read -- an event
   * handler, or the effect above. Everything a template reads goes through the
   * computed signals, which never load.
   */
  private ensureLoaded(): GuideSourceState {
    this.loadFor();
    return this.state();
  }

  /** Reads this account's state from storage, unless it is already in hand. */
  private loadFor(): void {
    const owner = this.storageKey();
    if (this.loadedFor === owner) {
      return;
    }

    this.loadedFor = owner;

    try {
      const raw = this.readStored();
      const parsed = raw ? (JSON.parse(raw) as Partial<GuideSourceState>) : null;
      this.state.set({
        sources: parsed?.sources ?? [],
        mappings: parsed?.mappings ?? {}
      });
      this.mergeBrought();
    } catch {
      // A half-written entry is not worth trying to rescue; the sources can be
      // added again and the mappings redone, which is better than an app that
      // will not start.
      this.state.set(emptyGuideSources());
    }
  }

  /**
   * Guides a device kept without an account, brought into an account that
   * had guides of its own here (local-drawers.utils.ts): the device's are
   * added beside them, and a channel match the account lacks is taken. Then
   * everything is queued, so the account's other devices get them too.
   */
  private mergeBrought(): void {
    const brought = takeBrought(localStorage, 'xtream_guide_sources', this.accounts.storageName());
    if (!brought) {
      return;
    }
    const theirs = JSON.parse(brought) as Partial<GuideSourceState>;
    this.mutate(state => {
      const known = new Set(state.sources.map(source => source.id));
      return {
        sources: [...state.sources, ...(theirs.sources ?? []).filter(source => !known.has(source.id))],
        mappings: { ...(theirs.mappings ?? {}), ...state.mappings }
      };
    });
    this.requeueEverything();
  }

  /** Applies a change and hands back what it produced, for queueing it. */
  private mutate(change: (state: GuideSourceState) => GuideSourceState): GuideSourceState {
    const next = change(this.ensureLoaded());
    this.state.set(next);

    try {
      localStorage.setItem(this.storageKey(), JSON.stringify(next));
    } catch {
      // Usable for this session even if it cannot be kept for the next.
    }

    return next;
  }
}

export type { GuideSource };
