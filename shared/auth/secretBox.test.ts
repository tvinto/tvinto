import { isSealed, open, seal } from './secretBox';

/**
 * The box the subscription travels in.
 *
 * What is being tested is mostly what it refuses. Opening something is easy to
 * get right; refusing to open a payload somebody edited, or one sealed under a
 * different password, is the part that decides whether a copy of the hosted
 * database is worth anything.
 */

const key = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

const SUBSCRIPTION = JSON.stringify({
  serverUrl: 'http://provider.example:8080',
  username: 'c0ffee',
  password: 'provider-secret'
});

describe('sealing and opening', () => {
  it('gives back exactly what went in', async () => {
    const sealed = await seal(SUBSCRIPTION, key(1));

    expect(await open(sealed, key(1))).toBe(SUBSCRIPTION);
  });

  it('shows none of it to anyone reading the sealed form', async () => {
    const sealed = await seal(SUBSCRIPTION, key(1));

    // The whole point. This is what sits in D1, and what a copy of D1 yields.
    expect(sealed).not.toContain('provider-secret');
    expect(sealed).not.toContain('c0ffee');
    expect(sealed).not.toContain('provider.example');
  });

  it('carries characters that are not ASCII', async () => {
    // A label can be anything a person types, and this app is used in
    // Croatian. Sealing bytes and opening text is where an encoding bug lives.
    const text = `Doma TV ${String.fromCharCode(0x010c)}udnovate`;

    expect(await open(await seal(text, key(1)), key(1))).toBe(text);
  });

  it('carries an empty string, rather than mistaking it for nothing', async () => {
    expect(await open(await seal('', key(1)), key(1))).toBe('');
  });

  it('looks different every time, from the same text and the same key', async () => {
    const once = await seal(SUBSCRIPTION, key(1));
    const again = await seal(SUBSCRIPTION, key(1));

    // A fresh nonce each time. Reusing one with GCM gives away the difference
    // between two messages and, worse, the ability to forge.
    expect(once).not.toBe(again);
    expect(await open(again, key(1))).toBe(SUBSCRIPTION);
  });
});

describe('what it refuses', () => {
  it('refuses a key that is not the one it was sealed with', async () => {
    const sealed = await seal(SUBSCRIPTION, key(1));

    expect(await open(sealed, key(2))).toBeNull();
  });

  it('refuses a payload somebody edited', async () => {
    const sealed = await seal(SUBSCRIPTION, key(1));
    const [version, iv, ciphertext] = sealed.split('$');

    // One byte of the ciphertext turned into a different byte.
    const tampered = [
      version,
      iv,
      ciphertext.slice(0, -2) + (ciphertext.endsWith('A=') ? 'B=' : 'A=')
    ].join('$');

    expect(await open(tampered, key(1))).toBeNull();
  });

  it('refuses a payload with a different nonce than it was sealed under', async () => {
    const sealed = await seal(SUBSCRIPTION, key(1));
    const other = await seal(SUBSCRIPTION, key(1));

    const swapped = [sealed.split('$')[0], other.split('$')[1], sealed.split('$')[2]].join('$');

    expect(await open(swapped, key(1))).toBeNull();
  });

  it('refuses anything that is not a box, rather than throwing', async () => {
    for (const value of ['', 'nonsense', 'sb1$only-two', 'sb2$aXY=$Y2lwaGVy', 'sb1$$Y2lwaGVy']) {
      expect(await open(value, key(1))).toBeNull();
    }

    expect(await open(null as unknown as string, key(1))).toBeNull();
  });

  it('refuses a key of the wrong size, loudly', async () => {
    // Not a null: a caller passing a 16-byte key has a bug, and silently
    // failing to open would send it looking in the wrong place.
    await expect(seal('x', new Uint8Array(16))).rejects.toThrow('32 bytes');
  });
});

describe('isSealed', () => {
  it('tells a box from a plain string', async () => {
    expect(isSealed(await seal('x', key(1)))).toBe(true);
    expect(isSealed('provider-secret')).toBe(false);
    expect(isSealed(undefined)).toBe(false);
  });
});
