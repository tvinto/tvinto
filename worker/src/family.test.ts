import worker from './index';
import { Env } from './d1';
import { SALT_SECRET, keysFor } from './test-utils/keys';
import { TestD1, openTestD1 } from './test-utils/d1';
import { makeKeyPair } from '../../shared/auth/keyPair';
import { FamilyView } from '../../shared/family';

/**
 * The family, driven the way the apps drive it.
 *
 * Mostly about refusals. That a manager can set somebody up is easy to get
 * right; that a kid cannot change its settings, that a manager setting a
 * friend up never sees what the friend watched, and that nobody outside the
 * path above an account can touch it, are what make it safe to have.
 */

const PASSWORD = 'a-good-long-password';

let db: TestD1;
let env: Env;

beforeEach(() => {
  db = openTestD1();
  env = { DB: db, ACCOUNT_SALT_SECRET: SALT_SECRET };
});

afterEach(() => db.close());

const call = (method: string, path: string, options: { body?: unknown; token?: string } = {}) =>
  worker.fetch(
    new Request(`https://sync.example${path}`, {
      method,
      headers: {
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    }),
    env
  );

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data = async (response: Response): Promise<any> => ((await response.json()) as { data: unknown }).data;

/** A sealed value as far as the service can tell -- it never opens one. */
const SEALED_PRIVATE = 'sb1$aaaa$bbbb';
const SEALED_ENC = 'pk1$aaaa$sb1$cccc$dddd';

/** An account of its own, registered as any device registers one. */
const register = async (username: string, invite?: string) => {
  const response = await call('POST', '/api/accounts/register', {
    body: { username, keys: await keysFor(PASSWORD), ...(invite ? { invite } : {}) }
  });
  const payload = await data(response);
  return { token: payload.token as string, id: payload.user.id as number };
};

const signIn = async (username: string, password = PASSWORD) => {
  const response = await call('POST', '/api/accounts/login', {
    body: { username, auth: (await keysFor(password)).auth }
  });
  return { status: response.status, token: (await data(response))?.token as string | undefined };
};

const withKey = async (token: string) => {
  const pair = await makeKeyPair();
  await call('POST', '/api/family/key', { token, body: { publicKey: pair.publicKey, sealedPrivateKey: SEALED_PRIVATE } });
  return pair;
};

/** An account made by a manager, below it. */
const addMember = async (
  token: string,
  username: string,
  options: { role?: string; household?: boolean; managedKeys?: { managerId: number; sealedEnc: string }[] } = {}
) => {
  const pair = await makeKeyPair();
  const response = await call('POST', '/api/family/members', {
    token,
    body: {
      username,
      keys: await keysFor(PASSWORD),
      role: options.role ?? 'member',
      household: options.household ?? false,
      publicKey: pair.publicKey,
      sealedPrivateKey: SEALED_PRIVATE,
      managedKeys: options.managedKeys ?? []
    }
  });
  return { status: response.status, id: (await data(response))?.id as number };
};

const family = async (token: string): Promise<FamilyView> => data(await call('GET', '/api/family', { token }));

const setupSession = async (token: string, memberId: number, scope = 'setup') => {
  const response = await call('POST', `/api/family/members/${memberId}/session`, { token, body: { scope } });
  return { status: response.status, token: (await data(response))?.token as string | undefined };
};

const NOW = '2026-10-01T10:00:00.000Z';

describe('an account from before families', () => {
  it('is an admin with nobody above it', async () => {
    const petar = await register('petar');

    const me = await data(await call('GET', '/api/accounts/me', { token: petar.token }));
    expect(me.user).toMatchObject({ role: 'admin', managerId: null, household: false });

    const view = await family(petar.token);
    expect(view.me.role).toBe('admin');
    expect(view.managers).toEqual([]);
    expect(view.members).toEqual([]);
  });
});

describe('adding somebody', () => {
  it('makes an account below the admin that signs in with the password the admin chose', async () => {
    const petar = await register('petar');
    await withKey(petar.token);

    const added = await addMember(petar.token, 'ana', {
      household: true,
      managedKeys: [{ managerId: petar.id, sealedEnc: SEALED_ENC }]
    });
    expect(added.status).toBe(201);

    const view = await family(petar.token);
    expect(view.members).toEqual([
      expect.objectContaining({
        id: added.id,
        username: 'ana',
        role: 'member',
        managerId: petar.id,
        household: true,
        devices: 0,
        lastUsedAt: null,
        sealedEnc: SEALED_ENC
      })
    ]);

    const ana = await signIn('ana');
    expect(ana.status).toBe(200);
    const hers = await family(ana.token!);
    expect(hers.me).toMatchObject({ role: 'member', managerId: petar.id });
    expect(hers.managers).toEqual([expect.objectContaining({ id: petar.id, username: 'petar', holdsMyKey: true })]);
    // A member sees nobody below it, because it manages nobody.
    expect(hers.members).toEqual([]);
  });

  it('refuses a name already taken, whatever its case', async () => {
    const petar = await register('petar');
    await register('Ana');

    expect((await addMember(petar.token, 'ana')).status).toBe(409);
  });

  it('is only for admins', async () => {
    const petar = await register('petar');
    await addMember(petar.token, 'ana');
    const ana = await signIn('ana');

    expect((await addMember(ana.token!, 'luka')).status).toBe(403);
  });
});

describe('who may manage whom', () => {
  it('lets everyone above an account manage it, and nobody else', async () => {
    const petar = await register('petar');
    const ivan = await register('ivan');
    const ana = await addMember(petar.token, 'ana', { role: 'admin' });
    const anaToken = (await signIn('ana')).token!;
    const luka = await addMember(anaToken, 'luka', { role: 'kid' });

    // Petar is above Luka, two levels up.
    expect((await family(petar.token)).members.map(member => member.username)).toEqual(['ana', 'luka']);
    expect((await call('POST', `/api/family/members/${luka.id}`, { token: petar.token, body: { household: true } })).status).toBe(200);

    // Ana manages Luka but not Petar, who is above her.
    expect((await call('POST', `/api/family/members/${petar.id}`, { token: anaToken, body: { role: 'kid' } })).status).toBe(404);

    // Ivan, in no family with any of them, reaches nobody -- and is told
    // nothing about whether the account exists.
    for (const id of [ana.id, luka.id]) {
      expect((await call('POST', `/api/family/members/${id}`, { token: ivan.token, body: { role: 'kid' } })).status).toBe(404);
      expect((await setupSession(ivan.token, id)).status).toBe(404);
    }
  });

  it('changes a role, and the household flag', async () => {
    const petar = await register('petar');
    const ana = await addMember(petar.token, 'ana');

    await call('POST', `/api/family/members/${ana.id}`, { token: petar.token, body: { role: 'kid', household: true } });

    expect((await family(petar.token)).members[0]).toMatchObject({ role: 'kid', household: true });
    expect((await call('POST', `/api/family/members/${ana.id}`, { token: petar.token, body: { role: 'boss' } })).status).toBe(400);
  });
});

describe('setting somebody up', () => {
  const seed = async () => {
    const petar = await register('petar');
    const ana = await addMember(petar.token, 'ana');
    const anaToken = (await signIn('ana')).token!;

    // What Ana did herself: a favourite, some history, a setting.
    await call('POST', '/api/devices/changes', {
      token: anaToken,
      body: {
        favourites: [{ type: 'live', streamId: '7', name: 'HRT 1', updatedAt: NOW }],
        progress: [{ type: 'vod', itemId: '9', name: 'A film', positionSeconds: 60, durationSeconds: 600, completed: false, updatedAt: NOW }],
        settings: [{ key: 'theme', value: 'dark', updatedAt: NOW }]
      }
    });

    const setup = (await setupSession(petar.token, ana.id)).token!;
    return { petar, ana, anaToken, setup };
  };

  it("shows the setup and never what they watched", async () => {
    const { setup } = await seed();

    const pulled = await data(await call('GET', '/api/devices/changes', { token: setup }));
    expect(pulled.settings).toEqual([expect.objectContaining({ key: 'theme', value: 'dark' })]);
    expect(pulled.favourites).toEqual([]);
    expect(pulled.progress).toEqual([]);
  });

  it('changes the setup, and leaves favourites and history alone', async () => {
    const { setup, anaToken } = await seed();

    const pushed = await data(
      await call('POST', '/api/devices/changes', {
        token: setup,
        body: {
          settings: [{ key: 'hiddenCategories', value: '{"live":["3"]}', updatedAt: '2026-10-01T11:00:00.000Z' }],
          favourites: [{ type: 'live', streamId: '8', name: 'Planted', updatedAt: '2026-10-01T11:00:00.000Z' }],
          deletions: [{ kind: 'favourite', key: 'live:7', deletedAt: '2026-10-01T11:00:00.000Z' }]
        }
      })
    );
    expect(pushed).toMatchObject({ applied: 1, superseded: 2 });

    const hers = await data(await call('GET', '/api/devices/changes', { token: anaToken }));
    expect(hers.favourites.map((favourite: { streamId: string }) => favourite.streamId)).toEqual(['7']);
    expect(hers.settings.map((setting: { key: string }) => setting.key).sort()).toEqual(['hiddenCategories', 'theme']);
  });

  it('sets up a subscription, but not subtitles chosen for a film, a password or invites', async () => {
    const { setup } = await seed();

    expect((await call('POST', '/api/accounts/providers', { token: setup, body: { id: 'p1', payload: 'sb1$x$y' } })).status).toBe(201);
    expect((await call('GET', '/api/subtitles?type=vod&itemId=9', { token: setup })).status).toBe(403);
    expect((await call('POST', '/api/accounts/keys', { token: setup, body: await keysFor('x'.repeat(12)) })).status).toBe(403);
    expect((await call('POST', '/api/accounts/invites', { token: setup })).status).toBe(403);
    expect((await call('GET', '/api/family', { token: setup })).status).toBe(403);
  });

  it('switches to an account as a profile only when it is in the household', async () => {
    const { petar, ana } = await seed();

    expect((await setupSession(petar.token, ana.id, 'full')).status).toBe(403);

    await call('POST', `/api/family/members/${ana.id}`, { token: petar.token, body: { household: true } });
    const profile = await setupSession(petar.token, ana.id, 'full');
    expect(profile.status).toBe(200);

    // A profile is the person, sitting at the same television: all of it.
    const pulled = await data(await call('GET', '/api/devices/changes', { token: profile.token }));
    expect(pulled.favourites).toHaveLength(1);
  });

  it('is not something a member can do for anybody', async () => {
    const { petar } = await seed();
    const anaToken = (await signIn('ana')).token!;

    expect((await setupSession(anaToken, petar.id)).status).toBe(403);
  });
});

describe('a kid', () => {
  const kid = async () => {
    const petar = await register('petar');
    const luka = await addMember(petar.token, 'luka', { role: 'kid' });
    return { petar, luka, token: (await signIn('luka')).token! };
  };

  it('favourites and watches, and changes nothing else', async () => {
    const { token } = await kid();

    const pushed = await data(
      await call('POST', '/api/devices/changes', {
        token,
        body: {
          favourites: [{ type: 'live', streamId: '7', name: 'Cartoons', updatedAt: NOW }],
          settings: [{ key: 'hiddenCategories', value: '{}', updatedAt: NOW }],
          arrangements: [{ scope: 'live:categories', itemIds: ['1'], names: {}, updatedAt: NOW }]
        }
      })
    );
    expect(pushed).toMatchObject({ applied: 1, superseded: 2 });

    for (const [method, path, body] of [
      ['POST', '/api/accounts/providers', { id: 'p', payload: 'sb1$x$y' }],
      ['DELETE', '/api/accounts/providers/p', undefined],
      ['POST', '/api/devices/settings', { theme: 'light' }],
      ['POST', '/api/accounts/invites', {}],
      ['POST', '/api/subtitles/account', { payload: 'sb1$x$y' }],
      ['POST', '/api/family/leave', {}]
    ] as const) {
      expect([path, (await call(method, path, { token, body })).status]).toEqual([path, 403]);
    }
  });

  it('has its setup changed from above', async () => {
    const { petar, luka, token } = await kid();
    const setup = (await setupSession(petar.token, luka.id)).token!;

    await call('POST', '/api/devices/changes', {
      token: setup,
      body: { settings: [{ key: 'lockedCategories', value: '{"live":["9"]}', updatedAt: NOW }] }
    });

    const pulled = await data(await call('GET', '/api/devices/changes', { token }));
    expect(pulled.settings).toEqual([expect.objectContaining({ key: 'lockedCategories' })]);
  });

  it('has its subscription set up from above, though it cannot set one itself', async () => {
    const { petar, luka } = await kid();
    const setup = (await setupSession(petar.token, luka.id)).token!;

    expect((await call('POST', '/api/accounts/providers', { token: setup, body: { id: 'p1', payload: 'sb1$x$y' } })).status).toBe(201);
    expect((await call('POST', '/api/devices/settings', { token: setup, body: { theme: 'light' } })).status).toBe(200);
  });
});

describe('keys', () => {
  it("lets a member hand its enc only to the accounts above it", async () => {
    const petar = await register('petar');
    const ivan = await register('ivan');
    const ana = await addMember(petar.token, 'ana');
    const anaToken = (await signIn('ana')).token!;

    const mine = await call('POST', '/api/family/managed-keys', {
      token: anaToken,
      body: { keys: [{ memberId: ana.id, managerId: petar.id, sealedEnc: SEALED_ENC }] }
    });
    expect(mine.status).toBe(200);
    expect((await family(petar.token)).members[0].sealedEnc).toBe(SEALED_ENC);

    // Not to somebody outside the family...
    const outside = await call('POST', '/api/family/managed-keys', {
      token: anaToken,
      body: { keys: [{ memberId: ana.id, managerId: ivan.id, sealedEnc: SEALED_ENC }] }
    });
    expect(outside.status).toBe(400);

    // ...and nobody hands over a key that is not theirs to give.
    const theirs = await call('POST', '/api/family/managed-keys', {
      token: ivan.token,
      body: { keys: [{ memberId: ana.id, managerId: petar.id, sealedEnc: SEALED_ENC }] }
    });
    expect(theirs.status).toBe(404);
  });

  it('forgets what was sealed for a public key once the key is replaced', async () => {
    const petar = await register('petar');
    await withKey(petar.token);
    await addMember(petar.token, 'ana', { managedKeys: [{ managerId: petar.id, sealedEnc: SEALED_ENC }] });

    await withKey(petar.token);

    expect((await family(petar.token)).members[0].sealedEnc).toBeNull();
  });
});

describe('joining and leaving', () => {
  it('puts somebody who registers with an admin\'s invite below that admin', async () => {
    const petar = await register('petar');
    const { code } = await data(await call('POST', '/api/accounts/invites', { token: petar.token }));

    const ana = await register('ana', code);

    expect((await family(petar.token)).members).toEqual([
      expect.objectContaining({ id: ana.id, role: 'member', managerId: petar.id })
    ]);
  });

  it('lets an account that already exists join with a code, and not its own family', async () => {
    const petar = await register('petar');
    const ivan = await register('ivan');
    const { code } = await data(await call('POST', '/api/accounts/invites', { token: petar.token }));

    expect((await call('POST', '/api/family/join', { token: ivan.token, body: { invite: code } })).status).toBe(200);
    expect((await family(ivan.token)).me).toMatchObject({ role: 'member', managerId: petar.id });

    // Petar joining Ivan's family now would make each the other's manager.
    await call('POST', `/api/family/members/${ivan.id}`, { token: petar.token, body: { role: 'admin' } });
    const ivanToken = (await signIn('ivan')).token!;
    const back = await data(await call('POST', '/api/accounts/invites', { token: ivanToken }));
    expect((await call('POST', '/api/family/join', { token: petar.token, body: { invite: back.code } })).status).toBe(409);
  });

  it('lets a member leave, keeping its account, and takes its key from the managers', async () => {
    const petar = await register('petar');
    await addMember(petar.token, 'ana', { managedKeys: [{ managerId: petar.id, sealedEnc: SEALED_ENC }] });
    const anaToken = (await signIn('ana')).token!;

    expect((await call('POST', '/api/family/leave', { token: anaToken, body: {} })).status).toBe(200);

    expect((await family(anaToken)).me).toMatchObject({ role: 'admin', managerId: null });
    expect((await family(petar.token)).members).toEqual([]);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM managed_keys').get()).toEqual({ n: 0 });
  });

  it('ends the sessions a manager held for setting it up when it is released', async () => {
    const petar = await register('petar');
    const ana = await addMember(petar.token, 'ana');
    const setup = (await setupSession(petar.token, ana.id)).token!;

    await call('POST', `/api/family/members/${ana.id}/release`, { token: petar.token, body: {} });

    expect((await call('GET', '/api/devices/changes', { token: setup })).status).toBe(401);
  });

  it('deletes an account and moves anybody below it up', async () => {
    const petar = await register('petar');
    const ana = await addMember(petar.token, 'ana', { role: 'admin' });
    const anaToken = (await signIn('ana')).token!;
    const luka = await addMember(anaToken, 'luka', { role: 'kid' });

    expect((await call('DELETE', `/api/family/members/${ana.id}`, { token: petar.token })).status).toBe(200);

    expect((await family(petar.token)).members).toEqual([expect.objectContaining({ id: luka.id, managerId: petar.id })]);
    expect((await signIn('ana')).status).toBe(401);
  });
});

describe('a forgotten password', () => {
  it('is replaced from above, ending every session it had', async () => {
    const petar = await register('petar');
    await withKey(petar.token);
    const ana = await addMember(petar.token, 'ana', { managedKeys: [{ managerId: petar.id, sealedEnc: SEALED_ENC }] });
    const before = (await signIn('ana')).token!;

    const pair = await makeKeyPair();
    const reset = await call('POST', `/api/family/members/${ana.id}/password`, {
      token: petar.token,
      body: {
        keys: await keysFor('a-new-long-password'),
        publicKey: pair.publicKey,
        sealedPrivateKey: SEALED_PRIVATE,
        managedKeys: [{ managerId: petar.id, sealedEnc: 'pk1$new$sb1$x$y' }]
      }
    });
    expect(reset.status).toBe(200);

    expect((await call('GET', '/api/family', { token: before })).status).toBe(401);
    expect((await signIn('ana')).status).toBe(401);
    expect((await signIn('ana', 'a-new-long-password')).status).toBe(200);
    expect((await family(petar.token)).members[0]).toMatchObject({ publicKey: pair.publicKey, sealedEnc: 'pk1$new$sb1$x$y' });
  });
});

describe('profile pictures', () => {
  const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

  it('lets an account choose its own, and its family see it', async () => {
    const petar = await register('petar');
    const ana = await addMember(petar.token, 'ana', { role: 'kid', household: true });

    const kid = await signIn('ana');
    expect((await call('POST', '/api/accounts/picture', { token: kid.token!, body: { picture: PHOTO } })).status).toBe(200);
    expect((await call('POST', '/api/accounts/picture', { token: petar.token, body: { picture: 'animal:fox' } })).status).toBe(200);

    const view = await family(petar.token);
    expect(view.me.picture).toBe('animal:fox');
    expect(view.members[0]).toMatchObject({ id: ana.id, picture: PHOTO });
    expect((await data(await call('GET', '/api/accounts/me', { token: kid.token! }))).user.picture).toBe(PHOTO);
  });

  it('lets an admin set a member\'s, and clear it', async () => {
    const petar = await register('petar');
    const ana = await addMember(petar.token, 'ana');

    await call('POST', `/api/family/members/${ana.id}`, { token: petar.token, body: { picture: 'animal:koala' } });
    expect((await family(petar.token)).members[0].picture).toBe('animal:koala');

    await call('POST', `/api/family/members/${ana.id}`, { token: petar.token, body: { picture: null } });
    expect((await family(petar.token)).members[0].picture).toBeNull();
  });

  it('refuses what is not a picture', async () => {
    const petar = await register('petar');
    for (const picture of ['animal:dragon', 'https://example.com/me.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,' + 'A'.repeat(70_000)]) {
      expect((await call('POST', '/api/accounts/picture', { token: petar.token, body: { picture } })).status).toBe(400);
    }
    expect((await call('POST', '/api/accounts/picture', { token: petar.token, body: {} })).status).toBe(400);
  });

  it('is not a member\'s to change for somebody else', async () => {
    const petar = await register('petar');
    const ana = await addMember(petar.token, 'ana');
    const ivan = await addMember(petar.token, 'ivan');
    const her = await signIn('ana');
    expect((await call('POST', `/api/family/members/${ivan.id}`, { token: her.token!, body: { picture: 'animal:cat' } })).status).toBe(403);
    expect(ana.id).toBeGreaterThan(0);
  });
});
