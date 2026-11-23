import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import {
  Observable,
  Subject,
  catchError,
  concatMap,
  firstValueFrom,
  from,
  of,
  switchMap,
  tap,
  timeout,
  toArray
} from 'rxjs';
import {
  ChangeSet,
  MAX_CHANGES_PER_PUSH,
  countChanges,
  PullResult,
  isEmptyChangeSet,
  splitChangeSet
} from '@shared/sync';
import { LocalUserDataService } from './local-user-data.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AccountService } from './account.service';
import { SettingsService } from './settings.service';
import { GuideSourcesService } from './guide-sources.service';
import { ProviderAccessService } from './provider-access.service';
import { fnv1aHex } from '@shared/xtream/guideSourceId';
import { syncCursorKey } from '../utils/sync-queue.utils';
import { API_URL } from './api-url';
import { technicalDetail } from '../utils/failure-messages.utils';
import { reportFailure } from '../utils/failure-reports';

/** A sync that failed, by endpoint and HTTP status; not while the device itself is offline. */
function reportSync(error: unknown, endpoint: 'push' | 'pull'): void {
  const status = syncStatus(error);
  if (status !== 'offline') {
    reportFailure('sync', status, { endpoint });
  }
}

/** A sync's failure by its HTTP status: 0 for no answer, `timeout` for one too slow. */
const syncStatus = (error: unknown): string | number =>
  error instanceof HttpErrorResponse && error.status === 0 && typeof navigator !== 'undefined' && !navigator.onLine
    ? 'offline'
    : error instanceof HttpErrorResponse ? error.status : error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'error';

/*
 * What a pull brings back is `PullResult` from the shared module now. It used
 * to be a local interface with the payloads typed as unknown[], which was
 * honest while this only counted them -- it applies them now, and guessing at
 * the field names of something the server builds is exactly how a favourite
 * goes missing without anything failing.
 */

const CURSOR_KEY = 'xtream_sync_cursor';

/** Whether this device has offered a given server everything it holds. */
const OFFERED_KEY = 'xtream_sync_offered';

/** How often to look, when the tab is in front and doing nothing. */
const POLL_INTERVAL_MS = 60_000;

/**
 * How long a sync may take before it is abandoned until the next tick.
 *
 * An unreachable backend does not reliably refuse a connection -- blackholed,
 * it answers nothing at all -- and a push that never returns is a pull that
 * never runs, since one waits on the other. Generous, because a slow answer is
 * still an answer and there is no user waiting on this.
 */
const SYNC_TIMEOUT_MS = 15_000;

/**
 * How soon a change made here is sent. It used to wait for the minute's poll,
 * and an account left within that minute -- leaving a family member's setup,
 * signing out -- lost what was still queued: a member's channel order,
 * arranged and then gone (5 October).
 */
const SEND_AFTER_MS = 2_000;

/** How many times sending what is waiting goes round while the queue keeps shrinking. */
const SEND_ROUNDS = 3;

/** Before anything, for the one read that wants the account's whole history. */
const EPOCH = '1970-01-01T00:00:00.000Z';

/**
 * Notices what the account's other devices have done.
 *
 * The browser writes straight to the server, so its own changes need no
 * syncing -- what it lacks is any way of hearing about a favourite starred on
 * the phone. This asks, on a slow timer and whenever the tab is brought back
 * to the front, which is when a stale screen is about to be looked at.
 *
 * It deliberately does not try to merge anything. Everything it needs is one
 * request away, so it applies the settings it was given and announces that
 * something else moved; the views that care refetch. A merge engine here would
 * be a second implementation of what the server already does, kept in step by
 * hope.
 */
@Injectable({ providedIn: 'root' })
export class DeviceSyncService {
  private readonly http = inject(HttpClient);
  private readonly accounts = inject(AccountService);
  private readonly settings = inject(SettingsService);
  private readonly destroyRef = inject(DestroyRef);
  // Read at each use: a server chosen at sign-in takes effect without a restart.
  private readonly syncServer = inject(API_URL);
  private get apiUrl(): string {
    return this.syncServer();
  }
  private readonly local = inject(LocalUserDataService);
  private readonly guideSources = inject(GuideSourcesService);
  private readonly providerAccess = inject(ProviderAccessService);

  private readonly trigger = new Subject<void>();

  /** Whether the guides have already been looked over this launch. */
  private auditedGuides = false;

  /**
   * Bumped when a pull found something the user made elsewhere.
   *
   * Views watch this and reload; it carries no payload because what changed
   * matters less than that anything did.
   */
  readonly remoteChanges = signal(0);

  readonly lastSyncedAt = signal<string | null>(null);
  readonly syncing = signal(false);

  /**
   * Whether this device is waiting on its first sync with the account: signed
   * in, and nothing read from the service yet. A device that has just signed
   * in holds none of the account's history or favourites until it lands, and
   * For You reads that as an account with no history at all -- the four
   * day-one doors on a device whose account had plenty (12 November). Cleared
   * when the first pull answers or fails; one that failed is not waited on.
   */
  readonly firstSync = signal(false);

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.trigger
      .pipe(
        // Push before pulling, always. The other order would fetch the
        // server's view, apply it over local writes that had not been sent
        // yet, and take the newer local change for an older remote one.
        switchMap(() => this.push()),
        switchMap(() => this.pull()),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe();

    // A change made here goes out soon after, not at the next poll -- except
    // in a family member's setup, which keeps everything until Save.
    effect(() => {
      if (this.local.hasPending() && !this.holding()) {
        untracked(() => this.sendSoon());
      }
    });

    // Runs only while somebody is signed in, and stops when they are not --
    // nor while a device used without an account is still moving its work
    // onto the account it has just signed in to (SyncStartService).
    effect(() => {
      const signedIn = this.accounts.account() !== null && !this.accounts.localProfile.active();
      untracked(() => (signedIn ? this.start() : this.stop()));
    });
  }

  private sendTimer: ReturnType<typeof setTimeout> | null = null;

  /** Why the last send failed, for an error's Details; empty after one that went. */
  lastFailure = '';

  private sendSoon(): void {
    if (this.sendTimer) {
      clearTimeout(this.sendTimer);
    }
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      this.syncNow();
    }, SEND_AFTER_MS);
  }

  /**
   * Sends what is waiting, now, and says whether anything is still left
   * waiting. For leaving an account on this device: what is queued then is
   * thrown away with the rest of its storage.
   */
  async sendPending(): Promise<boolean> {
    if (!this.local.enabled || isEmptyChangeSet(this.local.pending())) {
      return true;
    }
    this.lastFailure = '';
    // Again while it gets somewhere: a change can join the queue while the
    // last went out -- a guide source is queued once it has been sealed.
    for (let round = 0; round < SEND_ROUNDS; round++) {
      const before = countChanges(this.local.pending());
      await firstValueFrom(this.push(true));
      const left = countChanges(this.local.pending());
      if (left === 0 || this.lastFailure || left >= before) {
        break;
      }
    }
    const left = countChanges(this.local.pending());
    if (left > 0 && !this.lastFailure) {
      // Never "not sent" with nothing to show for it.
      this.lastFailure = `${left} change(s) still waiting to be sent`;
    }
    return left === 0;
  }

  /** Asks now, rather than waiting for the timer. */
  syncNow(): void {
    if (this.accounts.getToken() && !this.accounts.localProfile.active()) {
      this.trigger.next();
    }
  }

  /**
   * The cursor and the offered mark of the account being synced, named when
   * syncing starts: by the time it stops the account is gone, and the names
   * read then were nobody's -- a device signed out and back in kept a cursor
   * past everything it had just thrown away, and never fetched it again.
   */
  private keysInUse: string[] = [];

  private start(): void {
    if (this.timer) {
      return;
    }
    this.keysInUse = [this.cursorKey(), this.offeredKey()];
    this.firstSync.set(this.readCursor() === null);

    this.timer = setInterval(() => {
      // A hidden tab is not being read, and a phone with the screen off should
      // not be making requests at all.
      if (document.visibilityState === 'visible') {
        this.syncNow();
      }
    }, POLL_INTERVAL_MS);

    document.addEventListener('visibilitychange', this.onVisible);
    this.syncNow();
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    document.removeEventListener('visibilitychange', this.onVisible);
    this.firstSync.set(false);
    // Signed out, whether keeping what the device has or not: the next
    // sign-in reads the account from the start and offers it everything
    // the device has then.
    try {
      for (const key of this.keysInUse) {
        localStorage.removeItem(key);
      }
    } catch {
      // Nothing depends on this succeeding.
    }
    this.keysInUse = [];
  }

  /** Coming back to the tab is the moment a stale screen is about to be read. */
  private readonly onVisible = () => {
    if (document.visibilityState === 'visible') {
      this.syncNow();
    }
  };

  /**
   * Sends what this device has written and the server has not yet seen.
   *
   * Only a device has a queue -- a browser writes straight to the server, so
   * there is never anything waiting. What is sent is snapshotted first and
   * only that snapshot is cleared on success, so a star made while the request
   * was in flight is still queued afterwards rather than silently dropped.
   *
   * A failure leaves the queue exactly as it was. That is the whole point of
   * it: the backend being unreachable is the normal case this exists for, not
   * an error to report.
   */
  /**
   * Whether this device is keeping its changes back: setting up a family
   * member, where nothing reaches their account until Save (a user,
   * 5 October) -- FamilyProfilesService.saveSetUp sends it all then.
   */
  private holding(): boolean {
    return this.accounts.profileScope() === 'setup';
  }

  private push(explicit = false): Observable<unknown> {
    if (!this.local.enabled || (this.holding() && !explicit)) {
      return of(null);
    }

    // "How far have I read?" and "have I told this server what I hold?" are
    // different questions, and using the cursor for both got the second one
    // wrong. A pull writes a cursor whether or not the push before it sent
    // anything, so an adoption that failed -- or that found nothing because it
    // was looking in the wrong place -- was never tried again. The account sat
    // on the device and the service stayed empty.
    //
    // Never in a family member's setup. Its storage is new to this device, so
    // it looked like a device meeting a new server: everything was queued
    // again, the guide sources a moment later once sealed, and Save & Close
    // found them still waiting after sending the rest -- "Not saved yet", with
    // nothing to say why, and the second press went through (a user,
    // 8 October). The member's account already holds what their own
    // devices gave it; the setup only adds what was changed in it.
    const adopting = !this.holding() && !this.hasOffered();
    if (adopting) {
      this.adoptServer();
    }

    const batch = this.local.pending();
    if (isEmptyChangeSet(batch)) {
      // Nothing to offer, which is a complete answer rather than a failure:
      // this device has nothing the service has not got.
      if (adopting) {
        this.markOffered();
      }
      return of(null);
    }

    // The sync service takes a limited number of changes per request, because
    // it has a limited number of database queries per request. A first sync
    // after a long time offline is exactly the batch that exceeds it.
    //
    // Sent one piece at a time and accepted one piece at a time, so a failure
    // half way through keeps what got through and leaves the rest queued --
    // which is the same promise the whole queue makes, at a finer grain. The
    // order does not matter: reconciliation is last-write-wins on timestamps
    // the device wrote, not on arrival.
    return from(splitChangeSet(batch, MAX_CHANGES_PER_PUSH)).pipe(
      concatMap(piece =>
        this.http
          .post<{ success: boolean; data: { applied: number; superseded: number } }>(
            `${this.apiUrl}/devices/changes`,
            piece satisfies ChangeSet
          )
          .pipe(
            timeout({ each: SYNC_TIMEOUT_MS }),
            tap(() => this.local.accept(piece))
          )
      ),
      toArray(),
      // Only once every piece has been accepted. A push abandoned half way
      // leaves this unmarked, so the next tick offers the rest rather than
      // deciding the job was done.
      tap(() => {
        if (adopting) {
          this.markOffered();
        }
      }),
      catchError((error: unknown) => {
        this.lastFailure = technicalDetail(error);
        reportSync(error, 'push');
        return of(null);
      })
    );
  }

  /** Whether this device has already offered this server what it holds. */
  private hasOffered(): boolean {
    try {
      return localStorage.getItem(this.offeredKey()) !== null;
    } catch {
      // Without storage it offers again on every tick, which is wasteful and
      // harmless: the batch is rebuilt rather than added to, and a re-sent
      // change is a no-op at the far end.
      return false;
    }
  }

  private markOffered(): void {
    try {
      localStorage.setItem(this.offeredKey(), new Date().toISOString());
    } catch {
      // See above.
    }
  }

  private offeredKey(): string {
    return syncCursorKey(OFFERED_KEY, this.accounts.storageName(), this.apiUrl, fnv1aHex);
  }

  /**
   * Offers a new server everything this device holds.
   *
   * The whole migration, and it needs no export, no import and no second copy
   * of anything: a device already keeps the account's favourites, history,
   * arranging, guides and mappings, because that is what lets it work with no
   * server in reach. Moving to a different service is therefore not a transfer
   * between servers -- it is one device saying what it knows to somewhere that
   * does not know it yet.
   *
   * Idempotent. The queue is rebuilt from what is held rather than added to,
   * so running it twice queues the same things twice over rather than twice as
   * many. That matters because a first push against an unreachable service
   * leaves the cursor unwritten, and the next tick comes straight back here.
   *
   * Settings go separately, because they were never queued -- they are written
   * to the server as they are changed.
   */
  private adoptServer(): void {
    this.local.requeueEverything();
    this.guideSources.requeueEverything();
    this.settings.resend();
    // Told, rather than left to be discovered on the next launch. The
    // subscription screen is where a device that has just moved is parked, and
    // it will not leave until the account is known to have one.
    void this.providerAccess.offerSubscription().then(stored => {
      if (stored) {
        this.accounts.hasSubscription.set(true);
      }
    });
  }

  private pull() {
    // Changes kept back for Save are not to be written over by the account's
    // own copy of the same things in the meantime.
    if (this.holding() && (this.local.hasPending() || this.settings.holding())) {
      this.firstSync.set(false);
      return of(null);
    }
    const cursor = this.readCursor();
    // Built explicitly rather than as an object literal: a union of "has since"
    // and "does not" leaves HttpClient unable to pick an overload, and it
    // silently falls back to the one that returns an ArrayBuffer.
    const params = cursor ? new HttpParams().set('since', cursor) : new HttpParams();

    this.syncing.set(true);

    return this.http
      .get<{ success: boolean; data: PullResult }>(`${this.apiUrl}/devices/changes`, { params })
      .pipe(
        timeout({ each: SYNC_TIMEOUT_MS }),
        tap(response => {
          const changes = response.data;
          this.writeCursor(changes.serverTime);
          this.lastSyncedAt.set(changes.serverTime);
          this.syncing.set(false);

          const settings: Record<string, string> = {};
          for (const setting of changes.settings ?? []) {
            settings[setting.key] = setting.value;
          }
          this.settings.applyIncoming(settings);
          this.settings.applyRemoved((changes.deletions ?? []).filter(deletion => deletion.kind === 'setting').map(deletion => deletion.key));

          // A device keeps its own copy, so what another device did has to be
          // folded into it. A browser has nothing to fold it into: it reads
          // everything from the server anyway, and only needs telling to look
          // again.
          this.local.applyIncoming(changes);

          // Guides are folded in by the service that owns them, and that one
          // has to open a sealed payload to do it, so it is asynchronous where
          // nothing else here is. Not awaited: a pull that finished is a pull
          // that finished, and a guide arriving a moment later is fine.
          //
          // On the first sync, the account's guides are then downloaded here
          // too: a new device would otherwise have no guide until somebody
          // found the offer (`loadFirstTimeHere` says when it does not).
          const guides = this.guideSources.applyIncoming(changes);
          if (!cursor) {
            void this.guideSources.loadFirstTimeHereAfter(guides);
          }

          const moved = countChanges(changes);

          if (moved > 0) {
            this.remoteChanges.update(n => n + 1);
          }
          this.firstSync.set(false);

          void this.auditGuides();
        }),
        catchError((error: unknown) => {
          reportSync(error, 'pull');
          this.syncing.set(false);
          this.firstSync.set(false);
          // Nothing to recover: the cursor is untouched, so the next attempt
          // asks for the same window again.
          return of(null);
        })
      );
  }

  /**
   * Reads the account's guides once a launch, to see whether they can still be
   * opened.
   *
   * The ordinary pull cannot do this. It asks for what has changed since the
   * cursor, so a guide sealed under a key the account no longer has is a row
   * nobody will ever be sent again -- and the only device that could mend it
   * is one that has long since synced past it. That is exactly how two guides
   * sat unreadable on the service for a week: every device that had them kept
   * its own readable copy, and the one device that noticed, a phone signing in
   * for the first time, had nothing to mend them with.
   *
   * So the device that *can* mend them goes and looks. Once a launch, and only
   * when this device holds guides in the clear, which is the only case where
   * looking could lead to anything.
   */
  private async auditGuides(): Promise<void> {
    if (this.auditedGuides || !this.guideSources.sources().length) {
      return;
    }
    this.auditedGuides = true;

    try {
      const everything = await firstValueFrom(
        this.http
          .get<{
            success: boolean;
            data: PullResult;
          }>(`${this.apiUrl}/devices/changes`, { params: new HttpParams().set('since', EPOCH) })
          .pipe(timeout({ each: SYNC_TIMEOUT_MS }))
      );

      // Repair only. Deliberately not `applyIncoming`: this is a second reading
      // of changes already applied, and folding them in again would be work
      // done twice for nothing.
      this.guideSources.repairUnreadable(everything.data.guideSources ?? []);
    } catch {
      // An audit that could not run is not a failure worth reporting. It
      // happens again on the next launch, and nothing depends on it having
      // happened.
    }
  }

  /**
   * The cursor is per account.
   *
   * Signing in as somebody else and inheriting the previous account's cursor
   * would skip everything that happened before this moment -- and since a new
   * account has no history to speak of, the miss would be total and silent.
   */
  private cursorKey(): string {
    // Scoped to the server as well as the account. A cursor means "everything
    // up to here has reached that server", and pointing the app at a different
    // one makes it a claim about somewhere else -- the device would ask a
    // service that has never heard of it for changes since last Tuesday, be
    // told there are none, and never send it anything. Hashed rather than
    // spelled out because an API URL can carry a port, a path and a subdomain.
    return syncCursorKey(CURSOR_KEY, this.accounts.storageName(), this.apiUrl, fnv1aHex);
  }

  private readCursor(): string | null {
    try {
      return localStorage.getItem(this.cursorKey());
    } catch {
      return null;
    }
  }

  private writeCursor(serverTime: string): void {
    try {
      localStorage.setItem(this.cursorKey(), serverTime);
    } catch {
      // Without it every pull asks from the beginning, which still works.
    }
  }
}
