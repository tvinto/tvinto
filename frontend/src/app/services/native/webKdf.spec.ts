import {
  KdfParams,
  SALT_BYTES,
  deriveAccountKeys,
  disguisedSalt,
  toBase64,
  verifierFor
} from '@shared/auth/accountKeys';
import { createWebKdf, webKdf } from './webKdf';

/**
 * The device's derivation, against the same fixed vectors the backend's is.
 *
 * This is the test that matters most in the whole arrangement. The device and
 * the server never run the same code -- one has Node, the other SubtleCrypto
 * and a JavaScript scrypt -- and if they disagree by one byte then every
 * account made on one is unopenable on the other. The vectors below are
 * duplicated from `backend/src/utils/nodeKdf.test.ts` on purpose: shared
 * constants would let both sides drift together, which is exactly the failure
 * being guarded against.
 */

const cheap: KdfParams = { cost: 1024, blockSize: 8, parallelism: 1 };
const salt = new TextEncoder().encode('a-fixed-salt');
const password = 'correct horse battery staple';

describe('the device derivation', () => {
  it('agrees with the backend, byte for byte', async () => {
    const keys = await deriveAccountKeys(password, salt, cheap, webKdf);

    expect(toBase64(keys.auth)).toBe('5LvBPAJzSjLN0sXV8IFcXA6y70FIhhFX+fFwrvo1Sek=');
    expect(toBase64(keys.enc)).toBe('QolrIG8UgQX9eLCIPVteKjWnUPpIq+SoGs9IzsgYx2M=');
    expect(toBase64(await verifierFor(keys.auth, webKdf))).toBe(
      '61xp205xZuB0QK8BQuGM/FHMXXqzRKRMr+E6eGBdQQw='
    );
  });

  it('agrees about the salt handed out for an unknown name', async () => {
    // The server makes this one and the device never does, but a device that
    // computed it differently would be a device that could tell a real salt
    // from a disguised one -- which is the property being protected.
    const secret = new TextEncoder().encode('a-server-secret');
    const disguised = await disguisedSalt('nobody', secret, webKdf);

    expect(disguised).toHaveLength(SALT_BYTES);
    expect(toBase64(disguised)).toBe('SzjKt9maXmsw/2JfkOl2xQ==');
  });

  it('reports progress, because the slow step is slow enough to need it', async () => {
    const seen: number[] = [];
    // Written the obvious way on purpose: `push` returns a length, and
    // scrypt-js abandons the derivation on a truthy return. A caller should
    // not have to know that.
    const watched = createWebKdf(fraction => seen.push(fraction));

    await deriveAccountKeys(password, salt, cheap, watched);

    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeCloseTo(1);
    expect(seen.every(fraction => fraction >= 0 && fraction <= 1)).toBe(true);
  });
});
