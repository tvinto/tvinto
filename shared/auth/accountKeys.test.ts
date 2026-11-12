import {
  AccountKeys,
  CURRENT_KDF,
  KEY_BYTES,
  KdfPrimitives,
  MASTER_BYTES,
  SALT_BYTES,
  StoredVerifier,
  deriveAccountKeys,
  disguisedSalt,
  formatVerifier,
  fromBase64,
  parseVerifier,
  sameVerifier,
  toBase64,
  verifierFor
} from './accountKeys';

/**
 * The decisions, tested against primitives that only record what they were
 * asked for.
 *
 * Real crypto is tested next door in `backend/src/utils/nodeKdf.test.ts`. What
 * is checked here is the part that cannot be seen from the outside once real
 * hashing is involved: that the two keys are separated by different labels,
 * that the expensive step runs once, and that a stored record says enough
 * about itself to be remade.
 */

const utf8 = new TextEncoder();
const decoder = new TextDecoder();

/** Bytes that say what produced them, so a test can read them back. */
const label = (text: string, length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  bytes.set(utf8.encode(text).slice(0, length));
  return bytes;
};

const read = (bytes: Uint8Array): string => decoder.decode(bytes).replace(/\0+$/, '');

/**
 * The part of a label that distinguishes it.
 *
 * The labels share a prefix and differ near their ends, so a stub that wrote
 * them out in full would return the same first sixteen bytes for two different
 * keys, and the tests would be asserting nothing.
 */
const tail = (info: string): string => info.split('/').slice(2).join('/');

interface Recording extends KdfPrimitives {
  calls: string[];
}

const recording = (): Recording => {
  const calls: string[] = [];

  return {
    calls,
    scrypt: async (password, salt, params, length) => {
      calls.push(`scrypt ${read(password)} ${read(salt)} ${params.cost}`);
      return label(`master(${read(password)})`, length);
    },
    hkdf: async (key, info, length) => {
      calls.push(`hkdf ${info}`);
      return label(`${tail(info)}<-${read(key)}`, length);
    },
    sha256: async data => {
      calls.push('sha256');
      return label(`sha256(${read(data)})`, 32);
    }
  };
};

const derive = (password = 'hunter2', primitives = recording()): Promise<AccountKeys> =>
  deriveAccountKeys(password, utf8.encode('a-salt'), CURRENT_KDF, primitives);

describe('deriveAccountKeys', () => {
  it('runs the expensive step once and splits what it produced', async () => {
    const primitives = recording();
    await derive('hunter2', primitives);

    expect(primitives.calls.filter(call => call.startsWith('scrypt'))).toEqual([
      'scrypt hunter2 a-salt 65536'
    ]);
    expect(primitives.calls.filter(call => call.startsWith('hkdf'))).toHaveLength(2);
  });

  it('separates the two keys by different labels', async () => {
    const keys = await derive();

    // Neither key can be derived from the other, which is what makes it safe
    // to send one of them.
    expect(read(keys.auth)).toContain('auth');
    expect(read(keys.enc)).toContain('enc');
    expect(read(keys.auth)).not.toEqual(read(keys.enc));
  });

  it('versions the labels, so a future change cannot be mistaken for this one', async () => {
    const primitives = recording();
    await derive('hunter2', primitives);

    expect(primitives.calls).toContain('hkdf xtream/account/auth/v1');
    expect(primitives.calls).toContain('hkdf xtream/account/enc/v1');
  });

  it('asks for a master long enough to split', async () => {
    const primitives = recording();
    let asked = 0;
    await deriveAccountKeys('hunter2', utf8.encode('a-salt'), CURRENT_KDF, {
      ...primitives,
      scrypt: async (password, salt, params, length) => {
        asked = length;
        return primitives.scrypt(password, salt, params, length);
      }
    });

    expect(asked).toBe(MASTER_BYTES);
    expect(MASTER_BYTES).toBeGreaterThanOrEqual(2 * KEY_BYTES);
  });

  it('normalises the password, so a phone and a desktop agree', async () => {
    const primitives = recording();
    // The same word twice: `cafe` followed by U+0301, then `caf` followed by
    // U+00E9. A keyboard can produce either, and an account that will not open
    // on the television is not a subtle bug.
    //
    // Built from code points rather than typed as characters, because the two
    // forms look identical in every editor and one that normalises this file
    // on save would make them the same -- leaving a test that passes without
    // testing anything.
    const salt = utf8.encode('a-salt');

    await deriveAccountKeys(`cafe${String.fromCharCode(0x0301)}`, salt, CURRENT_KDF, primitives);
    const composed = primitives.calls[0];

    const second = recording();
    await deriveAccountKeys(`caf${String.fromCharCode(0x00e9)}`, salt, CURRENT_KDF, second);

    expect(second.calls[0]).toEqual(composed);
  });

  it('refuses a missing password or salt rather than deriving from nothing', async () => {
    await expect(
      deriveAccountKeys('', utf8.encode('a-salt'), CURRENT_KDF, recording())
    ).rejects.toThrow('password');
    await expect(
      deriveAccountKeys('hunter2', new Uint8Array(0), CURRENT_KDF, recording())
    ).rejects.toThrow('salt');
  });
});

describe('verifierFor', () => {
  it('is the hash of what was sent, not of what was kept', async () => {
    const primitives = recording();
    const keys = await derive('hunter2', primitives);
    const verifier = await verifierFor(keys.auth, primitives);

    expect(read(verifier)).toContain('auth');
    expect(read(verifier)).not.toContain('enc');
  });
});

describe('the stored record', () => {
  const record: StoredVerifier = {
    kdf: 'scrypt',
    params: CURRENT_KDF,
    salt: new Uint8Array([1, 2, 3, 4]),
    verifier: new Uint8Array([9, 8, 7, 6])
  };

  it('survives a round trip', () => {
    const parsed = parseVerifier(formatVerifier(record));

    expect(parsed).toEqual(record);
  });

  it('carries the cost, so raising it later strands nobody', () => {
    const older = formatVerifier({ ...record, params: { ...CURRENT_KDF, cost: 16384 } });

    expect(parseVerifier(older)?.params.cost).toBe(16384);
    expect(formatVerifier(record)).toContain('$65536$');
  });

  it('is told apart from a password hash at a glance', () => {
    expect(formatVerifier(record).startsWith('dk1$')).toBe(true);
    // What `passwords.ts` writes. The same function, a different thing.
    expect(parseVerifier('scrypt$65536$8$1$c2FsdA==$aGFzaA==')).toBeNull();
  });

  it('refuses anything it cannot remake a key from', () => {
    expect(parseVerifier('')).toBeNull();
    expect(parseVerifier('dk1$scrypt$65536$8$1$c2FsdA==')).toBeNull();
    expect(parseVerifier('dk1$argon2$65536$8$1$c2FsdA==$aGFzaA==')).toBeNull();
    expect(parseVerifier('dk1$scrypt$0$8$1$c2FsdA==$aGFzaA==')).toBeNull();
    expect(parseVerifier('dk1$scrypt$65536$8$1$$aGFzaA==')).toBeNull();
    expect(parseVerifier('dk1$scrypt$nope$8$1$c2FsdA==$aGFzaA==')).toBeNull();
    expect(parseVerifier(null as unknown as string)).toBeNull();
  });
});

describe('sameVerifier', () => {
  it('accepts a match and rejects everything else', () => {
    expect(sameVerifier(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(sameVerifier(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(sameVerifier(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
    expect(sameVerifier(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  it('looks at every byte, however early they differ', () => {
    // The property this exists for. A comparison that stopped at the first
    // wrong byte would say which guess was closer.
    const seen: number[] = [];
    const watched = new Proxy(new Uint8Array([1, 2, 3, 4]), {
      get(target, key) {
        const index = Number(key);
        if (Number.isInteger(index)) {
          seen.push(index);
        }
        return Reflect.get(target, key);
      }
    });

    sameVerifier(watched, new Uint8Array([9, 9, 9, 9]));

    expect(seen).toEqual([0, 1, 2, 3]);
  });
});

describe('disguisedSalt', () => {
  const secret = utf8.encode('server-secret');

  it('gives an unknown name a salt of the right size', async () => {
    const salt = await disguisedSalt('nobody', secret, recording());

    expect(salt).toHaveLength(SALT_BYTES);
  });

  it('gives the same name the same answer twice', async () => {
    // A real salt does not change between two asks, so a fake one must not
    // either -- that difference alone would answer the question the disguise
    // exists to refuse.
    const once = await disguisedSalt('nobody', secret, recording());
    const again = await disguisedSalt('nobody', secret, recording());

    expect(read(once)).toEqual(read(again));
  });

  it('gives different names different answers', async () => {
    const one = await disguisedSalt('nobody', secret, recording());
    const other = await disguisedSalt('someone-else', secret, recording());

    expect(read(one)).not.toEqual(read(other));
  });

  it('is made from the server secret, which is what makes it unguessable', async () => {
    const primitives = recording();
    await disguisedSalt('nobody', secret, primitives);

    // That the secret is what makes it unguessable is a claim about real
    // HKDF, and is tested against real HKDF in nodeKdf.test.ts. What can be
    // seen from here is that the secret and the name are what go in.
    expect(primitives.calls).toEqual(['hkdf xtream/account/salt/v1/nobody']);
  });
});

describe('base64', () => {
  it('carries bytes that are not text', () => {
    const bytes = new Uint8Array([0, 255, 128, 10, 13]);

    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it('returns null rather than throwing on something that is not base64', () => {
    expect(fromBase64('not base64 at all !!')).toBeNull();
  });
});
