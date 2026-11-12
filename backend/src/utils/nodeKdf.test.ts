import {
  KdfParams,
  SALT_BYTES,
  deriveAccountKeys,
  disguisedSalt,
  formatVerifier,
  parseVerifier,
  sameVerifier,
  toBase64,
  verifierFor
} from '../../../shared/auth/accountKeys';
import { nodeKdf } from './nodeKdf';

/**
 * The derivation against real crypto.
 *
 * The shared tests use primitives that only record what they were asked for,
 * which proves the decisions and nothing about the arithmetic. This proves the
 * arithmetic, and pins it: the vectors below are what a device must produce,
 * and any implementation that disagrees cannot open the accounts this one
 * makes.
 *
 * A low cost throughout. What is being tested is the shape of the derivation,
 * not how long scrypt takes, and 2^16 in a test suite is a tenth of a second
 * per call for no information at all.
 */

const cheap: KdfParams = { cost: 1024, blockSize: 8, parallelism: 1 };
const salt = new TextEncoder().encode('a-fixed-salt');
const password = 'correct horse battery staple';

describe('the derivation, against real crypto', () => {
  it('produces the same keys every time, from the same password and salt', async () => {
    const keys = await deriveAccountKeys(password, salt, cheap, nodeKdf);

    // Fixed vectors, not a round trip. A round trip stays green when both
    // sides change together; this catches a label, a length or a cost being
    // altered by something that did not realise every account depends on it.
    expect(toBase64(keys.auth)).toBe('5LvBPAJzSjLN0sXV8IFcXA6y70FIhhFX+fFwrvo1Sek=');
    expect(toBase64(keys.enc)).toBe('QolrIG8UgQX9eLCIPVteKjWnUPpIq+SoGs9IzsgYx2M=');
    expect(toBase64(await verifierFor(keys.auth, nodeKdf))).toBe(
      '61xp205xZuB0QK8BQuGM/FHMXXqzRKRMr+E6eGBdQQw='
    );
  });

  it('keeps the two keys unrelated', async () => {
    const keys = await deriveAccountKeys(password, salt, cheap, nodeKdf);

    expect(keys.auth).toHaveLength(32);
    expect(keys.enc).toHaveLength(32);
    expect(toBase64(keys.auth)).not.toBe(toBase64(keys.enc));
  });

  it('changes everything when the password changes', async () => {
    const one = await deriveAccountKeys(password, salt, cheap, nodeKdf);
    const other = await deriveAccountKeys(`${password}!`, salt, cheap, nodeKdf);

    expect(toBase64(one.auth)).not.toBe(toBase64(other.auth));
    expect(toBase64(one.enc)).not.toBe(toBase64(other.enc));
  });

  it('changes everything when the salt changes', async () => {
    const one = await deriveAccountKeys(password, salt, cheap, nodeKdf);
    const other = await deriveAccountKeys(
      password,
      new TextEncoder().encode('a-different-salt'),
      cheap,
      nodeKdf
    );

    expect(toBase64(one.auth)).not.toBe(toBase64(other.auth));
  });

  it('changes everything when the cost changes', async () => {
    const one = await deriveAccountKeys(password, salt, cheap, nodeKdf);
    const other = await deriveAccountKeys(password, salt, { ...cheap, cost: 2048 }, nodeKdf);

    // Which is why the cost is stored beside the verifier rather than assumed.
    expect(toBase64(one.auth)).not.toBe(toBase64(other.auth));
  });

  it('reads the same password whether it arrives composed or decomposed', async () => {
    // Built from code points rather than typed as characters. The two forms
    // look identical in every editor, and one that normalised this file on
    // save would make them the same, leaving a test that passes without
    // testing anything.
    const composed = await deriveAccountKeys(
      `caf${String.fromCharCode(0x00e9)}`,
      salt,
      cheap,
      nodeKdf
    );
    const decomposed = await deriveAccountKeys(
      `cafe${String.fromCharCode(0x0301)}`,
      salt,
      cheap,
      nodeKdf
    );

    expect(toBase64(composed.auth)).toBe(toBase64(decomposed.auth));
  });
});

describe('signing in against a stored verifier', () => {
  /** What registration would store. */
  const enrol = async (chosen: string) => {
    const keys = await deriveAccountKeys(chosen, salt, cheap, nodeKdf);
    return formatVerifier({
      kdf: 'scrypt',
      params: cheap,
      salt,
      verifier: await verifierFor(keys.auth, nodeKdf)
    });
  };

  /** What the server would do with what a device sends. */
  const check = async (stored: string, attempt: string) => {
    const record = parseVerifier(stored);
    if (!record) {
      return false;
    }

    // The device derives; the server only hashes what it was handed. That is
    // the whole reason this fits in a Worker.
    const keys = await deriveAccountKeys(attempt, record.salt, record.params, nodeKdf);
    return sameVerifier(await verifierFor(keys.auth, nodeKdf), record.verifier);
  };

  it('accepts the right password', async () => {
    expect(await check(await enrol(password), password)).toBe(true);
  });

  it('refuses the wrong one', async () => {
    expect(await check(await enrol(password), 'hunter2')).toBe(false);
  });

  it('refuses a row it cannot read, rather than throwing', async () => {
    expect(await check('nonsense', password)).toBe(false);
  });
});

describe('the salt handed out for an unknown name', () => {
  const secret = new TextEncoder().encode('a-server-secret');

  it('is the size of a real one', async () => {
    expect(await disguisedSalt('nobody', secret, nodeKdf)).toHaveLength(SALT_BYTES);
  });

  it('is the same on every ask, as a real one would be', async () => {
    const once = await disguisedSalt('nobody', secret, nodeKdf);
    const again = await disguisedSalt('nobody', secret, nodeKdf);

    expect(toBase64(once)).toBe(toBase64(again));
  });

  it('differs between names, as real ones would', async () => {
    const one = await disguisedSalt('nobody', secret, nodeKdf);
    const other = await disguisedSalt('someone-else', secret, nodeKdf);

    expect(toBase64(one)).not.toBe(toBase64(other));
  });

  it('cannot be produced without the server secret', async () => {
    const one = await disguisedSalt('nobody', secret, nodeKdf);
    const forged = await disguisedSalt(
      'nobody',
      new TextEncoder().encode('a-guess-at-the-secret'),
      nodeKdf
    );

    // Which is what stops the endpoint being a list of who has an account.
    expect(toBase64(one)).not.toBe(toBase64(forged));
  });
});
