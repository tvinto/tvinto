import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { makeKeyPair, openWith } from '@shared/auth/keyPair';
import { LocalToolService } from './local-tool.service';
import { LocalProfileService } from './local-profile.service';
import { ProviderAccessService } from './provider-access.service';
import { SettingsService } from './settings.service';
import { LocalUserDataService } from './local-user-data.service';
import { GuideSourcesService } from './guide-sources.service';
import { ConfirmService } from './confirm.service';
import { webcrypto } from 'crypto';

// jsdom has no SubtleCrypto; the app's targets all do.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

/**
 * tvinto with no account: what the desktop app answers on
 * its local address. Mostly the refusals -- signed in elsewhere, no token,
 * the wrong secret -- and that a tool let in reads and changes this device.
 */
describe('LocalToolService', () => {
  const local = signal(true);
  const settings = { values: {} as Record<string, string>, set: jest.fn(), remove: jest.fn(), all: () => settings.values };
  const ask = jest.fn();

  const build = () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: LocalProfileService, useValue: { active: local } },
        { provide: ProviderAccessService, useValue: { records: signal([]) } },
        { provide: SettingsService, useValue: settings },
        { provide: LocalUserDataService, useValue: { arrangements: () => [], saveManualOrder: jest.fn() } },
        { provide: GuideSourcesService, useValue: { sources: signal([]), mappings: signal({}) } },
        { provide: ConfirmService, useValue: { ask } }
      ]
    });
    return TestBed.inject(LocalToolService);
  };

  const request = (method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}) => ({
    method,
    path,
    headers: options.headers ?? {},
    body: options.body === undefined ? null : JSON.stringify(options.body)
  });

  /** Lets a tool in, as tvinto does it: asks, the person allows, tvinto collects. */
  const letIn = async (service: LocalToolService) => {
    const pair = await makeKeyPair();
    const asked = (await service.handle(request('POST', '/api/tools/requests', { body: { name: 'Tool on PC', publicKey: pair.publicKey } })))
      .body as { data: { id: string; code: string; secret: string } };
    // Polled as tvinto polls, until the person has answered.
    let answered: { data: { status: string; sealedToken: string; sealedEnc: string } };
    do {
      await new Promise(resolve => setTimeout(resolve, 5));
      answered = (await service.handle(
        request('GET', `/api/tools/requests/${asked.data.id}`, { headers: { 'x-tool-secret': asked.data.secret } })
      )).body as typeof answered;
    } while (answered.data.status === 'pending');
    return { asked: asked.data, answered: answered.data, token: await openWith(answered.data.sealedToken, pair.privateKey) };
  };

  beforeEach(() => {
    localStorage.clear();
    local.set(true);
    settings.values = { theme: 'dark' };
    settings.set.mockClear();
    ask.mockReset().mockResolvedValue(true);
  });

  it('answers only while the app is used without an account', async () => {
    local.set(false);
    expect((await build().handle(request('GET', '/api/health'))).status).toBe(503);
    local.set(true);
    expect((await build().handle(request('GET', '/api/health'))).body).toEqual(
      expect.objectContaining({ data: expect.objectContaining({ service: 'sync', tools: true, toolApproval: true }) })
    );
  });

  it('asks the person with the code, and lets the tool in only when allowed', async () => {
    const service = build();
    const { asked, answered, token } = await letIn(service);

    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(asked.code) }));
    expect(answered.status).toBe('approved');
    const me = await service.handle(request('GET', '/api/accounts/me', { headers: { authorization: `Bearer ${token}` } }));
    expect(me.status).toBe(200);
  });

  it('keeps out a tool that was refused, has no token, or has the wrong secret', async () => {
    const service = build();
    expect((await service.handle(request('GET', '/api/devices/changes'))).status).toBe(401);
    expect((await service.handle(request('GET', '/api/accounts/me', { headers: { authorization: 'Bearer made-up' } }))).status).toBe(401);
    expect((await service.handle(request('GET', '/api/tools/requests/0123456789abcdef0123456789abcdef', { headers: { 'x-tool-secret': 'x' } }))).status).toBe(404);

    ask.mockResolvedValue(false);
    expect((await letIn(service)).answered.status).toBe('denied');
  });

  it("reads and changes this device's settings for a tool let in", async () => {
    const service = build();
    const { token } = await letIn(service);
    const authorization = `Bearer ${token}`;

    const pulled = (await service.handle(request('GET', '/api/devices/changes', { headers: { authorization } }))).body as {
      data: { settings: { key: string; value: string }[] };
    };
    expect(pulled.data.settings).toEqual([expect.objectContaining({ key: 'theme', value: 'dark' })]);

    const pushed = await service.handle(
      request('POST', '/api/devices/changes', {
        headers: { authorization },
        body: { settings: [{ key: 'theme', value: 'light', updatedAt: '2026-10-12T10:00:00.000Z' }], favourites: [{ streamId: '1' }] }
      })
    );
    expect(pushed.body).toEqual({ success: true, data: { applied: 1, superseded: 1 } });
    expect(settings.set).toHaveBeenCalledWith('theme', 'light');
  });
});
