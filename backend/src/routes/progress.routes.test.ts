import request from 'supertest';
import { createTestApp } from '../test-utils/testApp';
import { sessionStore } from '../utils/sessions';
import { TEST_USER, TEST_USER_ID, resetDatabase } from '../test-utils/seed';
import { progressService } from '../services/progress.service';
import { accountsService } from '../services/accounts.service';
import { WatchProgressInput } from '../../../shared/types';

const app = createTestApp();
let token: string;

beforeEach(() => {
  resetDatabase();
  attachSubscription(TEST_USER_ID);
  token = sessionStore.createForUser(TEST_USER_ID);
});

/**
 * Gives the account a subscription, since requireSession refuses a caller who
 * has no provider to answer with.
 */
const attachSubscription = (userId: number) =>
  accountsService.addProviderAccount(userId, {
    serverUrl: 'http://provider.example',
    username: TEST_USER,
    password: 'hunter2'
  });

const authed = (method: 'get' | 'post' | 'delete', path: string) =>
  request(app)[method](path).set('Authorization', `Bearer ${token}`);

const movie = (over: Partial<WatchProgressInput> = {}): WatchProgressInput => ({
  type: 'vod',
  itemId: '100',
  name: 'The Movie',
  positionSeconds: 600,
  durationSeconds: 5400,
  ...over
});

const episode = (over: Partial<WatchProgressInput> = {}): WatchProgressInput => ({
  type: 'series',
  itemId: '900',
  seriesId: '42',
  season: 2,
  episodeNum: 4,
  name: 'The Show',
  episodeTitle: 'A Title',
  containerExtension: 'mkv',
  positionSeconds: 300,
  durationSeconds: 2700,
  ...over
});

describe('authentication', () => {
  it('refuses every progress endpoint without a session', async () => {
    const routes: Array<['get' | 'post' | 'delete', string]> = [
      ['get', '/api/streams/progress/recent'],
      ['get', '/api/streams/progress/series/42'],
      ['post', '/api/streams/progress/lookup'],
      ['post', '/api/streams/progress'],
      ['delete', '/api/streams/progress']
    ];

    for (const [method, path] of routes) {
      const res = await request(app)[method](path).send({});
      expect([path, res.status]).toEqual([path, 401]);
    }
  });
});

describe('POST /api/streams/progress', () => {
  it('records a position and reads it back', async () => {
    const res = await authed('post', '/api/streams/progress').send(movie());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      type: 'vod',
      itemId: '100',
      name: 'The Movie',
      positionSeconds: 600,
      durationSeconds: 5400,
      completed: false
    });
  });

  it('replaces the entry for something watched again rather than adding a second', async () => {
    await authed('post', '/api/streams/progress').send(movie({ positionSeconds: 600 }));
    await authed('post', '/api/streams/progress').send(movie({ positionSeconds: 1800 }));

    const recent = await authed('get', '/api/streams/progress/recent?type=vod');

    expect(recent.body.data).toHaveLength(1);
    expect(recent.body.data[0].positionSeconds).toBe(1800);
  });

  it('marks something watched to the end as complete, whatever the client claims', async () => {
    const res = await authed('post', '/api/streams/progress').send(
      movie({ positionSeconds: 5300, durationSeconds: 5400, completed: false })
    );

    expect(res.body.data.completed).toBe(true);
  });

  it('clamps a position past the end, which providers report short of', async () => {
    const res = await authed('post', '/api/streams/progress').send(
      movie({ positionSeconds: 5500, durationSeconds: 5400 })
    );

    expect(res.body.data.positionSeconds).toBe(5400);
  });

  it('stores a live channel with no duration, since there is nothing to resume', async () => {
    const res = await authed('post', '/api/streams/progress').send({
      type: 'live',
      itemId: '7',
      name: 'News 24',
      positionSeconds: 0,
      durationSeconds: 0
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ durationSeconds: 0, completed: false });
  });

  it('discards a position that is not a usable number', async () => {
    const res = await authed('post', '/api/streams/progress').send(
      movie({ positionSeconds: Number.NaN as unknown as number, durationSeconds: -5 })
    );

    expect(res.body.data).toMatchObject({ positionSeconds: 0, durationSeconds: 0 });
  });

  it('rejects an unknown stream type', async () => {
    const res = await authed('post', '/api/streams/progress').send(
      movie({ type: 'audiobook' as never })
    );

    expect(res.status).toBe(400);
  });

  it('rejects an entry with no item', async () => {
    const res = await authed('post', '/api/streams/progress').send(movie({ itemId: '' }));

    expect(res.status).toBe(400);
  });
});

describe('GET /api/streams/progress/recent', () => {
  it('returns the most recent first', async () => {
    progressService.record(TEST_USER_ID, movie({ itemId: '1', name: 'First' }));
    progressService.record(TEST_USER_ID, movie({ itemId: '2', name: 'Second' }));

    const res = await authed('get', '/api/streams/progress/recent?type=vod');

    expect(res.body.data.map((p: { name: string }) => p.name)).toEqual(['Second', 'First']);
  });

  it('lists a show once however many of its episodes were watched', async () => {
    progressService.record(TEST_USER_ID, episode({ itemId: '901', episodeNum: 1 }));
    progressService.record(TEST_USER_ID, episode({ itemId: '902', episodeNum: 2 }));
    progressService.record(TEST_USER_ID, episode({ itemId: '903', episodeNum: 3 }));

    const res = await authed('get', '/api/streams/progress/recent?type=series');

    expect(res.body.data).toHaveLength(1);
    // The entry carries the episode last watched, which is what to resume.
    expect(res.body.data[0]).toMatchObject({ seriesId: '42', itemId: '903', episodeNum: 3 });
  });

  it('keeps shows apart from each other', async () => {
    progressService.record(TEST_USER_ID, episode({ itemId: '901', seriesId: '42', name: 'Show A' }));
    progressService.record(TEST_USER_ID, episode({ itemId: '801', seriesId: '43', name: 'Show B' }));

    const res = await authed('get', '/api/streams/progress/recent?type=series');

    expect(res.body.data.map((p: { name: string }) => p.name)).toEqual(['Show B', 'Show A']);
  });

  it('honours the limit, and defaults to ten', async () => {
    for (let i = 0; i < 14; i++) {
      progressService.record(TEST_USER_ID, movie({ itemId: String(i) }));
    }

    const capped = await authed('get', '/api/streams/progress/recent?type=vod&limit=3');
    const defaulted = await authed('get', '/api/streams/progress/recent?type=vod');

    expect(capped.body.data).toHaveLength(3);
    expect(defaulted.body.data).toHaveLength(10);
  });

  it('keeps one account history out of another', async () => {
    const otherAccountId = (await accountsService.register('someone-else', 'a-good-long-password')).id;
    progressService.record(otherAccountId, movie({ itemId: '1', name: 'Theirs' }));
    progressService.record(TEST_USER_ID, movie({ itemId: '2', name: 'Mine' }));

    const res = await authed('get', '/api/streams/progress/recent?type=vod');

    expect(res.body.data.map((p: { name: string }) => p.name)).toEqual(['Mine']);
  });

  it('keeps each section to its own type', async () => {
    progressService.record(TEST_USER_ID, movie());
    progressService.record(TEST_USER_ID, episode());

    const vod = await authed('get', '/api/streams/progress/recent?type=vod');

    expect(vod.body.data.map((p: { itemId: string }) => p.itemId)).toEqual(['100']);
  });

  it('rejects a request with no usable type', async () => {
    const res = await authed('get', '/api/streams/progress/recent?type=nonsense');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/streams/progress/series/:seriesId', () => {
  it('returns every episode position for the show, keyed by episode', async () => {
    progressService.record(
      TEST_USER_ID,
      episode({ itemId: '901', episodeNum: 1, positionSeconds: 2650 })
    );
    progressService.record(
      TEST_USER_ID,
      episode({ itemId: '902', episodeNum: 2, positionSeconds: 120 })
    );
    progressService.record(TEST_USER_ID, episode({ itemId: '801', seriesId: '43' }));

    const res = await authed('get', '/api/streams/progress/series/42');

    expect(Object.keys(res.body.data).sort()).toEqual(['901', '902']);
    expect(res.body.data['901'].completed).toBe(true);
    expect(res.body.data['902'].positionSeconds).toBe(120);
  });
});

describe('POST /api/streams/progress/lookup', () => {
  it('returns positions only for the items asked about', async () => {
    progressService.record(TEST_USER_ID, movie({ itemId: '1' }));
    progressService.record(TEST_USER_ID, movie({ itemId: '2' }));

    const res = await authed('post', '/api/streams/progress/lookup').send({
      type: 'vod',
      itemIds: ['1', '3']
    });

    expect(Object.keys(res.body.data)).toEqual(['1']);
  });

  it('answers an empty list without a query', async () => {
    const res = await authed('post', '/api/streams/progress/lookup').send({
      type: 'vod',
      itemIds: []
    });

    expect(res.body.data).toEqual({});
  });

  it('rejects a lookup with no itemIds array', async () => {
    const res = await authed('post', '/api/streams/progress/lookup').send({ type: 'vod' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/streams/progress', () => {
  it('forgets a film', async () => {
    progressService.record(TEST_USER_ID, movie());

    const res = await authed('delete', '/api/streams/progress').send({ type: 'vod', itemId: '100' });

    expect(res.body.data.removed).toBe(1);
    expect(progressService.recent(TEST_USER_ID, 'vod')).toHaveLength(0);
  });

  it('forgetting a show forgets every episode of it', async () => {
    progressService.record(TEST_USER_ID, episode({ itemId: '901' }));
    progressService.record(TEST_USER_ID, episode({ itemId: '902' }));

    // The id in the list is the show's, not the episode's.
    const res = await authed('delete', '/api/streams/progress').send({
      type: 'series',
      itemId: '42'
    });

    expect(res.body.data.removed).toBe(2);
    expect(progressService.forSeries(TEST_USER_ID, '42')).toEqual({});
  });

  it('forgets a single episode when given that episode id', async () => {
    progressService.record(TEST_USER_ID, episode({ itemId: '901' }));
    progressService.record(TEST_USER_ID, episode({ itemId: '902' }));

    await authed('delete', '/api/streams/progress').send({ type: 'series', itemId: '901' });

    expect(Object.keys(progressService.forSeries(TEST_USER_ID, '42'))).toEqual(['902']);
  });

  it('rejects a request with no item', async () => {
    const res = await authed('delete', '/api/streams/progress').send({ type: 'vod' });
    expect(res.status).toBe(400);
  });
});
