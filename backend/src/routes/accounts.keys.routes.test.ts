import request from 'supertest';
import {
  KdfParams,
  deriveAccountKeys,
  fromBase64,
  toBase64
} from '../../../shared/auth/accountKeys';
import { SubmittedKeys } from '../services/accounts.service';
import { nodeKdf } from '../utils/nodeKdf';
import { createTestApp } from '../test-utils/testApp';
import { resetDatabase } from '../test-utils/seed';

/**
 * The endpoints an account moves across on.
 *
 * The order they are used in matters more than any one of them: ask for the
 * salt, derive, sign in with the key. A device that has not been updated still
 * sends a password, and the same endpoint still answers it -- which is the
 * only reason this can be rolled out one device at a time.
 */

const app = createTestApp();

const PASSWORD = 'a-good-long-password';
const FLOOR: KdfParams = { cost: 16384, blockSize: 8, parallelism: 1 };
const SALT = toBase64(new TextEncoder().encode('0123456789abcdef'));

beforeEach(() => {
  resetDatabase({ withAccount: false });
  delete process.env.ACCOUNT_REGISTRATION;
});

const keysFor = async (password: string, salt = SALT): Promise<SubmittedKeys> => {
  const { auth } = await deriveAccountKeys(password, fromBase64(salt)!, FLOOR, nodeKdf);
  return { salt, auth: toBase64(auth), ...FLOOR };
};

describe('GET /api/accounts/salt', () => {
  it('hands out what a device needs before it can derive anything', async () => {
    await request(app)
      .post('/api/accounts/register')
      .send({ username: 'petar', password: PASSWORD, keys: await keysFor(PASSWORD) });

    const res = await request(app).get('/api/accounts/salt').query({ username: 'petar' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ salt: SALT, ...FLOOR });
  });

  it('answers a name with no account exactly as fully', async () => {
    const res = await request(app).get('/api/accounts/salt').query({ username: 'nobody-here' });

    // The property the whole endpoint hangs on. A 404 here, or a shorter
    // answer, would turn this into a list of who has an account.
    expect(res.status).toBe(200);
    expect(fromBase64(res.body.data.salt)).toHaveLength(16);
    expect(res.body.data.cost).toBeGreaterThan(0);
  });

  it('needs a name to answer about', async () => {
    const res = await request(app).get('/api/accounts/salt');

    expect(res.status).toBe(400);
  });
});

describe('POST /api/accounts/login', () => {
  const registerEnrolled = async () =>
    request(app)
      .post('/api/accounts/register')
      .send({ username: 'petar', password: PASSWORD, keys: await keysFor(PASSWORD) });

  it('signs in with the derived key, and the password never leaves the device', async () => {
    await registerEnrolled();
    const keys = await keysFor(PASSWORD);

    const res = await request(app)
      .post('/api/accounts/login')
      .send({ username: 'petar', auth: keys.auth });

    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.enrolled).toBe(true);
  });

  it('refuses a key from the wrong password, in the same words as always', async () => {
    await registerEnrolled();
    const wrong = await keysFor('some-other-password');

    const res = await request(app)
      .post('/api/accounts/login')
      .send({ username: 'petar', auth: wrong.auth });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Incorrect username or password');
  });

  it('says the same thing about a name with no account', async () => {
    const keys = await keysFor(PASSWORD);

    const res = await request(app)
      .post('/api/accounts/login')
      .send({ username: 'nobody-here', auth: keys.auth });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Incorrect username or password');
  });

  it('says the same thing about an account that has not moved over', async () => {
    await request(app)
      .post('/api/accounts/register')
      .send({ username: 'petar', password: PASSWORD });

    const keys = await keysFor(PASSWORD);
    const res = await request(app)
      .post('/api/accounts/login')
      .send({ username: 'petar', auth: keys.auth });

    // Not "this account has no keys", which would be a fact about the account
    // told to somebody who has proved nothing.
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Incorrect username or password');
  });

  it('still takes a password from a device that has not been updated', async () => {
    await registerEnrolled();

    const res = await request(app)
      .post('/api/accounts/login')
      .send({ username: 'petar', password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.enrolled).toBe(true);
  });

  it('needs one or the other', async () => {
    const res = await request(app).post('/api/accounts/login').send({ username: 'petar' });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/accounts/keys', () => {
  it('is how an account moves over: password in, key out', async () => {
    // The upgrade path in full. An existing account, a device that has just
    // learned to derive, and no second password prompt anywhere in it.
    await request(app)
      .post('/api/accounts/register')
      .send({ username: 'petar', password: PASSWORD });

    const signedIn = await request(app)
      .post('/api/accounts/login')
      .send({ username: 'petar', password: PASSWORD });

    expect(signedIn.body.data.enrolled).toBe(false);

    const salt = await request(app).get('/api/accounts/salt').query({ username: 'petar' });
    const keys = await keysFor(PASSWORD, salt.body.data.salt);

    const enrolled = await request(app)
      .post('/api/accounts/keys')
      .set('Authorization', `Bearer ${signedIn.body.data.token}`)
      .send(keys);

    expect(enrolled.status).toBe(200);

    const again = await request(app)
      .post('/api/accounts/login')
      .send({ username: 'petar', auth: keys.auth });

    expect(again.status).toBe(200);
    expect(again.body.data.enrolled).toBe(true);
  });

  it('refuses a derivation weaker than the server accepts', async () => {
    await request(app)
      .post('/api/accounts/register')
      .send({ username: 'petar', password: PASSWORD });

    const signedIn = await request(app)
      .post('/api/accounts/login')
      .send({ username: 'petar', password: PASSWORD });

    const res = await request(app)
      .post('/api/accounts/keys')
      .set('Authorization', `Bearer ${signedIn.body.data.token}`)
      .send({ ...(await keysFor(PASSWORD)), cost: 1024 });

    expect(res.status).toBe(400);
  });

  it('is not open to a stranger', async () => {
    const res = await request(app)
      .post('/api/accounts/keys')
      .send(await keysFor(PASSWORD));

    expect(res.status).toBe(401);
  });
});
