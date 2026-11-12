import { Injectable, inject } from '@angular/core';
import { SETTING_KEYS } from '@shared/types';
import { bringProviders } from '@shared/providers/bringProviders';
import { AccountService } from './account.service';
import { LOCAL_STORAGE_NAME } from './local-profile.service';
import { ProviderAccessService } from './provider-access.service';
import { ProvidersService } from './providers.service';
import { SettingsService } from './settings.service';
import { ConfirmService } from './confirm.service';
import { t } from '../utils/i18n';
import { fold } from '../utils/profile-vault.utils';
import { moveDrawers } from '../utils/local-drawers.utils';
import { TagMoves, retagCategoryLists, retagDrawers, retagId } from '../utils/local-retag.utils';
import { CATEGORY_OPENS_KEY, retaggedOpens } from '../utils/category-opens.utils';

/** Where each library remembers the category it was left on (section component). */
const LAST_CATEGORY_KEYS = ['live', 'vod', 'series'].map(type => `xtream_last_category_${type}`);
const OPENS_KEYS = ['vod', 'series'].map(type => `${CATEGORY_OPENS_KEY}${type}`);

/**
 * Starting to sync a device that was used without an account.
 *
 * Once the sign-in has gone through, what the device kept becomes the
 * account's: its providers join the account's (bringProviders), anything
 * filed under a provider whose tag changed on the way is filed under the new
 * one (local-retag.utils.ts), and its favourites, history, guides and
 * reminders move under the account's name (local-drawers.utils.ts). Then the
 * device stops being used without an account, and syncing starts as it does
 * for any device meeting a server it has not sent to -- everything queued
 * and sent, then everything the account had fetched and merged, newest
 * change winning.
 *
 * Nothing is moved before the account's providers have been read: without
 * them it cannot be known what the device's would clash with.
 *
 * What was kept from one account at a sign-out is not somebody else's to
 * take: signing in as another person asks first. Without asking, a girlfriend
 * signing in after a user chose "Keep on this device" got his history and
 * favourites in her new account (2 November). Left out, the kept
 * copy goes back under its own account's name on this device, and the
 * account signing in starts with its own.
 */
@Injectable({ providedIn: 'root' })
export class SyncStartService {
  private readonly accounts = inject(AccountService);
  private readonly access = inject(ProviderAccessService);
  private readonly providers = inject(ProvidersService);
  private readonly settings = inject(SettingsService);
  private readonly confirm = inject(ConfirmService);

  /**
   * After any sign-in. A device that was not used without an account has
   * nothing to bring. Throws when the account's providers could not be read
   * or the device's could not be handed over; nothing on the device has been
   * moved then, and the caller takes the sign-in back.
   */
  async afterSignIn(): Promise<void> {
    const username = this.accounts.account()?.username;
    if (!this.accounts.localProfile.active() || !username) {
      return;
    }
    const from = this.accounts.localProfile.keptFrom();
    if (from && from !== fold(username) && !(await this.bringFromAnother(from, username))) {
      this.settings.dropKept();
      moveDrawers(localStorage, LOCAL_STORAGE_NAME, from);
      this.access.useRecords(await this.access.accountRecords());
      this.accounts.hasSubscription.set(this.access.storedRecords().length > 0);
      this.accounts.localProfile.leave();
      return;
    }

    const device = this.access.storedRecords();
    const account = await this.access.accountRecords();
    const { all, added, moves } = bringProviders(account, device);
    for (const record of added) {
      await this.providers.sendToAccount(record, all);
    }

    // From here on nothing asks the network: the device's own storage, put
    // under the account's name -- its settings too, held until now.
    this.settings.bringKept();
    retagDrawers(localStorage, LOCAL_STORAGE_NAME, moves);
    this.retagSettings(moves);
    moveDrawers(localStorage, LOCAL_STORAGE_NAME, fold(username));

    this.access.useRecords(all);
    this.accounts.hasSubscription.set(all.length > 0);
    this.accounts.localProfile.leave();
  }

  /** Whether what the device kept from `from` goes into `name`'s account too. */
  private bringFromAnother(from: string, name: string): Promise<boolean> {
    return this.confirm.ask({
      title: t('local.bringTitle', { name }),
      message: t('local.bringBody', { from, name }),
      confirmLabel: t('local.bring', { name }),
      cancelLabel: t('local.startFresh')
    });
  }

  private retagSettings(moves: TagMoves): void {
    if (!moves.size) {
      return;
    }
    for (const key of [SETTING_KEYS.hiddenCategories, SETTING_KEYS.lockedCategories]) {
      const raw = this.settings.get(key);
      if (raw) {
        try {
          this.settings.set(key, retagCategoryLists(raw, moves));
        } catch {
          // Unreadable: left as it was.
        }
      }
    }
    try {
      for (const key of LAST_CATEGORY_KEYS) {
        const id = localStorage.getItem(key);
        if (id) {
          localStorage.setItem(key, retagId(id, moves));
        }
      }
      for (const key of OPENS_KEYS) {
        const raw = localStorage.getItem(key);
        if (raw) {
          localStorage.setItem(key, retaggedOpens(raw, id => retagId(id, moves)));
        }
      }
    } catch {
      // Only where a library opens and the order of its rows; they start afresh instead.
    }
  }
}
