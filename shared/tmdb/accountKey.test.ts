import { openTmdbKey, sealCheckedTmdbKey } from './accountKey';
import { TmdbError } from './client';

const ENC = new Uint8Array(32).fill(7);
const OTHER = new Uint8Array(32).fill(9);
const MADE_UP = 'deadbeefdeadbeefdeadbeefdeadbeef';

const answering = (status: number) => async () => ({ ok: status === 200, status, json: async () => ({}) });

describe("an account's TMDB key", () => {
  it('is checked with TMDB, tidied, and sealed so only the account opens it', async () => {
    const { key, payload } = await sealCheckedTmdbKey(` "${MADE_UP}" \n`, ENC, answering(200));

    expect(key).toBe(MADE_UP);
    expect(payload).not.toContain(MADE_UP);
    expect(await openTmdbKey(payload, ENC)).toBe(MADE_UP);
    expect(await openTmdbKey(payload, OTHER)).toBeNull();
  });

  it('is not sealed when TMDB refuses it', async () => {
    await expect(sealCheckedTmdbKey(MADE_UP, ENC, answering(401))).rejects.toBeInstanceOf(TmdbError);
  });
});
