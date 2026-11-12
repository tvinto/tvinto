import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { Account } from '@shared/types';
import { OpenSubtitlesFetch } from '@shared/opensubtitles/client';
import { API_URL } from './api-url';
import { AccountKeysService } from './account-keys.service';
import { AccountService } from './account.service';
import { OpenSubtitlesService } from './opensubtitles.service';
import { ServiceKindService } from './service-kind.service';

/**
 * Linking an OpenSubtitles account from a device: the login checked with
 * OpenSubtitles before anything is kept, kept only sealed, and signed in again
 * with the kept login when the day-long token runs out -- but never retried
 * when OpenSubtitles says the password is wrong.
 */

const ACCOUNT: Account = { id: 1, username: 'AnaMaria', createdAt: '2026-08-30T10:00:00.000Z' };
const PASSWORD = 'tajna-lozinka';
const SEALED = 'sb1$sealed$blob';

const LOGIN = {
  user: { allowed_downloads: 20, level: 'Sub leecher', vip: false },
  base_url: 'api.opensubtitles.com',
  token: 'token-1',
  status: 200
};
const USER = { data: { allowed_downloads: 20, remaining_downloads: 14, downloads_count: 6, level: 'Sub leecher', vip: false } };

describe('OpenSubtitlesService', () => {
  const account = signal<Account | null>(ACCOUNT);

  let http: { get: jest.Mock; post: jest.Mock; delete: jest.Mock };
  let keys: { seal: jest.Mock; open: jest.Mock };
  let sync: boolean;
  let kept: { payload: string; updatedAt: string } | null;
  let apiKey: string | null;
  let api: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => { status: number; body: unknown };
  let calls: { url: string; method: string; body?: string; headers: Record<string, string> }[];

  const build = (): OpenSubtitlesService => {
    http = {
      get: jest.fn((url: string) => {
        if (url.endsWith('/subtitles/config')) {
          return of({ success: true, data: { apiKey } });
        }
        if (url.endsWith('/subtitles/account')) {
          return of({ success: true, data: kept });
        }
        return throwError(() => new HttpErrorResponse({ status: 404 }));
      }),
      post: jest.fn(() => of({ success: true, data: {} })),
      delete: jest.fn(() => of({ success: true, data: null }))
    };
    keys = {
      seal: jest.fn().mockResolvedValue(SEALED),
      open: jest.fn().mockResolvedValue(JSON.stringify({ username: 'marko.hr', password: PASSWORD, linkedAt: '' }))
    };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: HttpClient, useValue: http },
        { provide: API_URL, useValue: 'https://sync.example/api' },
        { provide: AccountKeysService, useValue: keys },
        { provide: AccountService, useValue: { account, localProfile: { active: () => false } } },
        { provide: ServiceKindService, useValue: { isSyncService: async () => sync } }
      ]
    });

    const service = TestBed.inject(OpenSubtitlesService);
    TestBed.flushEffects();

    const fake: OpenSubtitlesFetch = async (url, init) => {
      calls.push({ url, method: init.method, body: init.body, headers: init.headers });
      const { status, body } = api(url, init);
      return { status, text: async () => JSON.stringify(body) };
    };
    service.fetchImpl = fake;
    return service;
  };

  beforeEach(() => {
    account.set(ACCOUNT);
    sync = true;
    kept = null;
    apiKey = 'app-key';
    calls = [];
    api = url => (url.endsWith('/login') ? { status: 200, body: LOGIN } : { status: 200, body: USER });
  });

  it('has nothing to offer on a server without subtitles', async () => {
    sync = false;
    const service = build();

    await service.load();

    expect(service.state()).toBe('unavailable');
    expect(http.get).not.toHaveBeenCalled();
  });

  it('has nothing to offer when no key is set', async () => {
    apiKey = null;
    const service = build();

    await service.load();

    expect(service.state()).toBe('unavailable');
  });

  it('is unlinked when the account keeps no login', async () => {
    const service = build();

    await service.load();

    expect(service.state()).toBe('unlinked');
  });

  it('checks the login with OpenSubtitles, then keeps it sealed and shows the allowance', async () => {
    const service = build();
    await service.load();

    expect(await service.linkAccount(' marko.hr ', PASSWORD)).toBe(true);

    expect(calls[0]).toMatchObject({ url: 'https://api.opensubtitles.com/api/v1/login', method: 'POST' });
    expect(calls[0].headers['X-User-Agent']).toMatch(/^Xtream v\d+\.\d+\.\d+$/);
    // Sealed before it leaves, and what is posted is the box, not the password.
    expect(JSON.parse(keys.seal.mock.calls[0][0])).toMatchObject({ username: 'marko.hr', password: PASSWORD });
    expect(http.post).toHaveBeenCalledWith('https://sync.example/api/subtitles/account', { payload: SEALED });
    expect(JSON.stringify(http.post.mock.calls)).not.toContain(PASSWORD);

    expect(service.state()).toBe('linked');
    expect(service.username()).toBe('marko.hr');
    expect(service.allowance()).toMatchObject({ remaining: 14, allowed: 20 });
    // The allowance was asked for with the token just obtained, not a second login.
    expect(calls.filter(call => call.url.endsWith('/login'))).toHaveLength(1);
    expect(calls[1].headers['Authorization']).toBe('Bearer token-1');
  });

  it('keeps nothing when OpenSubtitles refuses the login, and says so without the password', async () => {
    api = () => ({ status: 401, body: { message: 'invalid username/password' } });
    const service = build();
    await service.load();

    expect(await service.linkAccount('marko.hr', PASSWORD)).toBe(false);

    expect(http.post).not.toHaveBeenCalled();
    expect(keys.seal).not.toHaveBeenCalled();
    expect(service.state()).toBe('unlinked');
    expect(service.error()).toContain('did not accept');
    expect(service.error()).not.toContain(PASSWORD);
  });

  it('asks for the username when given an email, without calling OpenSubtitles', async () => {
    const service = build();
    await service.load();

    expect(await service.linkAccount('marko@example.com', PASSWORD)).toBe(false);

    expect(calls).toHaveLength(0);
    expect(service.error()).toContain('not your email');
  });

  it('opens a kept login, signs in once, and reuses the token', async () => {
    kept = { payload: SEALED, updatedAt: '2026-09-15T20:00:00.000Z' };
    const service = build();
    await service.load();
    expect(service.state()).toBe('linked');
    expect(keys.open).toHaveBeenCalledWith(SEALED);

    await service.withSession(async (client, token) => token);
    await service.withSession(async (client, token) => token);

    expect(calls.filter(call => call.url.endsWith('/login'))).toHaveLength(1);
  });

  it('signs in again once when the token has expired', async () => {
    kept = { payload: SEALED, updatedAt: '' };
    let logins = 0;
    api = url => {
      if (url.endsWith('/login')) {
        logins += 1;
        return { status: 200, body: { ...LOGIN, token: `token-${logins}` } };
      }
      return { status: 200, body: USER };
    };
    const service = build();
    await service.load();

    const tokens: string[] = [];
    const result = await service.withSession(async (client, token) => {
      tokens.push(token);
      if (tokens.length === 1) {
        // What OpenSubtitles answers for an expired token: a 500 saying so.
        const { problemFor } = await import('@shared/opensubtitles/client');
        throw problemFor(500, { message: 'invalid token' }, false);
      }
      return 'done';
    });

    expect(result).toBe('done');
    expect(tokens).toEqual(['token-1', 'token-2']);
  });

  it('stops using a kept login OpenSubtitles refuses, instead of trying it again and again', async () => {
    kept = { payload: SEALED, updatedAt: '' };
    api = () => ({ status: 401, body: { message: 'invalid username/password' } });
    const service = build();
    await service.load();

    await expect(service.withSession(async () => 'x')).rejects.toMatchObject({ problem: 'bad-login' });
    await expect(service.withSession(async () => 'x')).rejects.toMatchObject({ problem: 'bad-login' });

    expect(service.state()).toBe('refused');
    expect(calls.filter(call => call.url.endsWith('/login'))).toHaveLength(1);
  });

  it('asks to link again when the account key no longer opens the kept login', async () => {
    kept = { payload: SEALED, updatedAt: '' };
    const service = build();
    keys.open.mockResolvedValue(null);

    await service.load();

    expect(service.state()).toBe('unreadable');
  });

  it('unlinks on every device by forgetting the kept login', async () => {
    kept = { payload: SEALED, updatedAt: '' };
    const service = build();
    await service.load();

    await service.unlink();

    expect(http.delete).toHaveBeenCalledWith('https://sync.example/api/subtitles/account');
    expect(service.state()).toBe('unlinked');
    expect(service.username()).toBeNull();
  });

  it('forgets the login and token when the app account changes', async () => {
    kept = { payload: SEALED, updatedAt: '' };
    const service = build();
    await service.load();
    await service.withSession(async (client, token) => token);

    account.set(null);
    TestBed.flushEffects();

    expect(service.state()).toBe('checking');
    expect(service.username()).toBeNull();
  });
});
