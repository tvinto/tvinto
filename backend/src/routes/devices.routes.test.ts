import request from 'supertest';
import { createTestApp } from '../test-utils/testApp';
import { resetDatabase } from '../test-utils/seed';
import { accountsService } from '../services/accounts.service';
import { sessionStore } from '../utils/sessions';
import { xtreamService } from '../services/xtream.service';

const app = createTestApp();
const PASSWORD = 'a-good-long-password';

let userId: number;
let token: string;

beforeEach(async () => {
  resetDatabase({ withAccount: false });
  userId = (await accountsService.register('petar', PASSWORD)).id;
  token = sessionStore.createForUser(userId);
});

const authed = (method: 'get' | 'post', path: string) =>
  request(app)[method](path).set('Authorization', `Bearer ${token}`);

describe('authentication', () => {
  it('refuses every endpoint without a session', async () => {
    for (const [method, path] of [
      ['get', '/api/devices/changes'],
      ['post', '/api/devices/changes'],
      ['get', '/api/devices/settings'],
      ['post', '/api/devices/settings']
    ] as Array<['get' | 'post', string]>) {
      const res = await request(app)[method](path).send({});
      expect([path, res.status]).toEqual([path, 401]);
    }
  });

  it('works without a subscription, since an expired one is when you need it most', async () => {
    // No provider account has been added at all.
    const res = await authed('get', '/api/devices/changes');
    expect(res.status).toBe(200);
  });
});

describe('GET /api/devices/changes', () => {
  it('returns everything for a device that has never synced', async () => {
    xtreamService.addFavorite(userId, 'live', '42', 'Channel 42');

    const res = await authed('get', '/api/devices/changes');

    expect(res.status).toBe(200);
    expect(res.body.data.favourites).toHaveLength(1);
    expect(res.body.data.serverTime).toMatch(/^\d{4}-/);
  });

  it('returns only what is new when given a cursor', async () => {
    xtreamService.addFavorite(userId, 'live', '42');
    const first = await authed('get', '/api/devices/changes');

    const second = await authed(
      'get',
      `/api/devices/changes?since=${encodeURIComponent(first.body.data.serverTime)}`
    );

    expect(second.body.data.favourites).toHaveLength(0);
  });

  it('rejects a cursor that is not a timestamp, rather than comparing it as text', async () => {
    const res = await authed('get', '/api/devices/changes?since=yesterday');

    expect(res.status).toBe(400);
  });

  it('shows one account nothing of another\'s', async () => {
    const other = (await accountsService.register('someone', PASSWORD)).id;
    xtreamService.addFavorite(other, 'live', '42');

    const res = await authed('get', '/api/devices/changes');

    expect(res.body.data.favourites).toHaveLength(0);
  });
});

describe('POST /api/devices/changes', () => {
  it('accepts a batch and says how much of it landed', async () => {
    const res = await authed('post', '/api/devices/changes').send({
      favourites: [
        { type: 'live', streamId: '42', name: 'Channel 42', updatedAt: new Date().toISOString() }
      ]
    });

    expect(res.status).toBe(200);
    expect(res.body.data.applied).toBe(1);
    expect(res.body.data.serverTime).toMatch(/^\d{4}-/);
  });

  it('accepts an empty batch, which is what an idle device sends', async () => {
    const res = await authed('post', '/api/devices/changes').send({});

    expect(res.status).toBe(200);
    expect(res.body.data.applied).toBe(0);
  });

  it('rejects a field that is not a list', async () => {
    const res = await authed('post', '/api/devices/changes').send({ favourites: 'not-a-list' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/favourites must be an array/);
  });

  it('rejects a body that is not an object', async () => {
    const res = await authed('post', '/api/devices/changes')
      .set('Content-Type', 'application/json')
      .send('[]');

    expect(res.status).toBe(400);
  });
});

describe('settings', () => {
  it('round-trips preferences', async () => {
    await authed('post', '/api/devices/settings').send({ theme: 'dark' });

    const res = await authed('get', '/api/devices/settings');

    expect(res.body.data).toEqual({ theme: 'dark' });
  });

  it('rejects a value that is not a string, naming the one at fault', async () => {
    const res = await authed('post', '/api/devices/settings').send({ theme: { nested: true } });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/"theme"/);
  });

  it('rejects a body that is not an object of settings', async () => {
    const res = await authed('post', '/api/devices/settings')
      .set('Content-Type', 'application/json')
      .send('["dark"]');

    expect(res.status).toBe(400);
  });
});

describe('a round trip between two devices', () => {
  it('carries a change made on one to the other, and no further', async () => {
    // Device A stars something.
    await authed('post', '/api/devices/changes').send({
      favourites: [
        { type: 'live', streamId: '42', name: 'Channel 42', updatedAt: new Date().toISOString() }
      ]
    });

    // Device B, which has never synced, pulls and sees it.
    const bFirst = await authed('get', '/api/devices/changes');
    expect(bFirst.body.data.favourites.map((f: { streamId: string }) => f.streamId)).toEqual(['42']);

    // Device B pulls again and is not handed the same thing twice.
    const bSecond = await authed(
      'get',
      `/api/devices/changes?since=${encodeURIComponent(bFirst.body.data.serverTime)}`
    );
    expect(bSecond.body.data.favourites).toHaveLength(0);
    expect(bSecond.body.data.deletions).toHaveLength(0);
  });
});
