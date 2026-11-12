import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, of } from 'rxjs';
import { API_URL } from './api-url';
import { AccountService } from './account.service';
import { SettingsService } from './settings.service';

/**
 * Settings a device kept at a "Keep on this device" sign-out, meeting the
 * next account to sign in: held back until the person signing in says
 * whether what was kept comes along (SyncStartService), so a parent's PIN
 * and locks never go into somebody else's account on "Start fresh".
 */

const KEPT = { parentalLock: '{"salt":"s","hash":"h"}', lockedCategories: '{"live":["9"],"vod":[],"series":[]}' };

describe('SettingsService and what a device kept', () => {
  let posted: Record<string, string>[];

  const build = (theirs: Record<string, string>) => {
    posted = [];
    localStorage.clear();
    localStorage.setItem('xtream_settings', JSON.stringify(KEPT));
    const http = {
      get: () => of({ success: true, data: theirs }),
      post: (_url: string, body: Record<string, string>) => {
        posted.push(body);
        return of({ success: true, data: { ...theirs, ...body } });
      }
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: HttpClient, useValue: http },
        { provide: API_URL, useValue: () => 'https://sync.example/api' },
        {
          provide: AccountService,
          useValue: {
            account: signal(null),
            getToken: () => 'token',
            localProfile: { active: () => true },
            deliberateSignOuts: signal(0)
          }
        }
      ]
    });
    return TestBed.inject(SettingsService);
  };

  it('sends nothing kept, and uses only the account’s own, when the person starts fresh', async () => {
    const settings = build({});
    await firstValueFrom(settings.load());
    settings.dropKept();

    expect(posted).toEqual([]);
    expect(settings.get('parentalLock')).toBeNull();
    expect(settings.get('lockedCategories')).toBeNull();
  });

  it('brings what was kept into the account when told to', async () => {
    const settings = build({});
    await firstValueFrom(settings.load());
    settings.bringKept();

    expect(posted).toEqual([KEPT]);
    expect(settings.get('parentalLock')).toBe(KEPT.parentalLock);
  });

  it('acts on the answer whichever arrives first', async () => {
    const settings = build({});
    const loading = firstValueFrom(settings.load());
    settings.bringKept();
    await loading;

    expect(posted).toEqual([KEPT]);
  });
});

describe('SettingsService and records deleted for the account', () => {
  const build = (theirs: Record<string, string>, mine: Record<string, string>) => {
    const posted: Array<{ url: string; body: unknown }> = [];
    localStorage.clear();
    localStorage.setItem('xtream_settings', JSON.stringify(mine));
    const http = {
      get: () => of({ success: true, data: theirs }),
      post: (url: string, body: unknown) => {
        posted.push({ url, body });
        return of({ success: true });
      }
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: HttpClient, useValue: http },
        { provide: API_URL, useValue: () => 'https://sync.example/api' },
        {
          provide: AccountService,
          useValue: {
            account: signal(null),
            getToken: () => 'token',
            localProfile: { active: () => false },
            deliberateSignOuts: signal(0),
            profileScope: () => 'own'
          }
        }
      ]
    });
    return { settings: TestBed.inject(SettingsService), posted };
  };

  it('sends a deletion as a tombstone, and drops it here', () => {
    const { settings, posted } = build({}, { 'recording:b1': '{}' });
    settings.delete('recording:b1');

    expect(settings.all()['recording:b1']).toBeUndefined();
    expect(posted).toEqual([
      { url: 'https://sync.example/api/devices/changes', body: expect.objectContaining({ deletions: [expect.objectContaining({ kind: 'setting', key: 'recording:b1' })] }) }
    ]);
  });

  it('drops what another device deleted', () => {
    const { settings } = build({}, { 'recording:b1': '{}', player: '{}' });
    settings.applyRemoved(['recording:b1']);
    expect(Object.keys(settings.all())).toEqual(['player']);
  });

  it('does not hand a booking the account no longer has back up when it loads', async () => {
    const { settings, posted } = build({ player: '{}' }, { 'recording:gone': '{}', 'recorder:me': '{}' });
    await firstValueFrom(settings.load());

    expect(settings.all()['recording:gone']).toBeUndefined();
    expect(posted).toEqual([{ url: 'https://sync.example/api/devices/settings', body: { 'recorder:me': '{}' } }]);
  });
});
