import {
  isOwnNetwork,
  isSyncServiceHealth,
  normaliseServerAddress,
  registrationOf,
  serverAddressCandidates,
  serverName
} from './server';

describe('normaliseServerAddress', () => {
  it('takes a host alone, as most people will type it', () => {
    expect(normaliseServerAddress('my-sync.example.workers.dev')).toBe('https://my-sync.example.workers.dev/api');
  });

  it('takes the address a browser shows, and the API address itself', () => {
    expect(normaliseServerAddress('https://my-sync.example.workers.dev/')).toBe('https://my-sync.example.workers.dev/api');
    expect(normaliseServerAddress('https://my-sync.example.workers.dev/api')).toBe('https://my-sync.example.workers.dev/api');
    expect(normaliseServerAddress('https://my-sync.example.workers.dev/api/')).toBe('https://my-sync.example.workers.dev/api');
  });

  it('keeps http and a port when somebody says so, for a service on their own network', () => {
    expect(normaliseServerAddress('http://192.168.1.20:8787')).toBe('http://192.168.1.20:8787/api');
  });

  it('keeps a path the service is under', () => {
    expect(normaliseServerAddress('https://example.org/tvinto')).toBe('https://example.org/tvinto/api');
  });

  it('drops a query and a fragment', () => {
    expect(normaliseServerAddress('https://example.org/?x=1#top')).toBe('https://example.org/api');
  });

  it('refuses what cannot be a server', () => {
    expect(normaliseServerAddress('')).toBeNull();
    expect(normaliseServerAddress('   ')).toBeNull();
    expect(normaliseServerAddress('not a server')).toBeNull();
    expect(normaliseServerAddress('ftp://example.org')).toBeNull();
    expect(normaliseServerAddress('javascript:alert(1)')).toBeNull();
  });

  it('refuses an address carrying a login, which has no business being kept', () => {
    expect(normaliseServerAddress('https://user:secret@example.org')).toBeNull();
  });
});

describe('isSyncServiceHealth', () => {
  it('knows the sync service by its own answer', () => {
    expect(isSyncServiceHealth({ success: true, data: { status: 'ok', service: 'sync' } })).toBe(true);
  });

  it('is not fooled by another server that answers the path', () => {
    expect(isSyncServiceHealth({ success: true, data: { status: 'ok' } })).toBe(false);
    expect(isSyncServiceHealth({ ok: true })).toBe(false);
    expect(isSyncServiceHealth(null)).toBe(false);
    expect(isSyncServiceHealth('<html>')).toBe(false);
  });
});

describe('serverName', () => {
  it('is the host, port and all', () => {
    expect(serverName('https://my-sync.example.workers.dev/api')).toBe('my-sync.example.workers.dev');
    expect(serverName('http://192.168.1.20:8787/api')).toBe('192.168.1.20:8787');
  });
});

describe('serverAddressCandidates', () => {
  it('tries plain http too for a host alone on the person’s own network', () => {
    expect(serverAddressCandidates('192.168.1.20:8787')).toEqual([
      'https://192.168.1.20:8787/api',
      'http://192.168.1.20:8787/api'
    ]);
    expect(serverAddressCandidates('nas.local')).toEqual(['https://nas.local/api', 'http://nas.local/api']);
    expect(serverAddressCandidates('127.0.0.1:8787')).toEqual(['https://127.0.0.1:8787/api', 'http://127.0.0.1:8787/api']);
  });

  it('never for a public host, which keeps to https', () => {
    expect(serverAddressCandidates('my-sync.example.workers.dev')).toEqual(['https://my-sync.example.workers.dev/api']);
    expect(serverAddressCandidates('8.8.8.8')).toEqual(['https://8.8.8.8/api']);
  });

  it('never when a scheme was typed: https asked for is https meant', () => {
    expect(serverAddressCandidates('https://192.168.1.20')).toEqual(['https://192.168.1.20/api']);
    expect(serverAddressCandidates('http://192.168.1.20')).toEqual(['http://192.168.1.20/api']);
  });

  it('is nothing for what cannot be an address', () => {
    expect(serverAddressCandidates('not a server')).toEqual([]);
  });
});

describe('isOwnNetwork', () => {
  it('knows the private ranges and local names', () => {
    for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '172.16.4.1', '172.31.255.1', '192.168.0.1', '169.254.1.1', 'nas.local', 'box.lan', 'pi.home.arpa', '[::1]']) {
      expect([host, isOwnNetwork(host)]).toEqual([host, true]);
    }
  });

  it('and nothing else', () => {
    for (const host of ['8.8.8.8', '172.32.0.1', '192.169.0.1', 'example.com', 'local.example.com', '10.0.0']) {
      expect([host, isOwnNetwork(host)]).toEqual([host, false]);
    }
  });
});

describe('registrationOf', () => {
  it('reads whether an account there needs an invite', () => {
    expect(registrationOf({ success: true, data: { service: 'sync', registration: 'open' } })).toBe('open');
    expect(registrationOf({ success: true, data: { service: 'sync', registration: 'invite' } })).toBe('invite');
  });

  it('is null for a server that does not say, or says something else', () => {
    expect(registrationOf({ success: true, data: { service: 'sync' } })).toBeNull();
    expect(registrationOf({ success: true, data: { registration: 'whatever' } })).toBeNull();
    expect(registrationOf(null)).toBeNull();
  });
});
