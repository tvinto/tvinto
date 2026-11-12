import { toBase64 } from './accountKeys';
import { makeKeyPair, openPrivateKey, openWith, sealFor, sealPrivateKey } from './keyPair';

/**
 * Sealing for another account. As with secretBox, most of what matters is
 * what it refuses: a box meant for one member must be nothing to another,
 * and nothing to the service that carries it.
 */

const ENC = toBase64(new Uint8Array(32).fill(7));

describe('sealing for a public key', () => {
  it('opens with the matching private key', async () => {
    const member = await makeKeyPair();
    const sealed = await sealFor(ENC, member.publicKey);

    expect(await openWith(sealed, member.privateKey)).toBe(ENC);
  });

  it('shows nothing of what is inside', async () => {
    const member = await makeKeyPair();
    const sealed = await sealFor('provider-secret', member.publicKey);

    expect(sealed).not.toContain('provider-secret');
    expect(sealed.startsWith('pk1$')).toBe(true);
  });

  it('is nothing to anybody else', async () => {
    const member = await makeKeyPair();
    const stranger = await makeKeyPair();
    const sealed = await sealFor(ENC, member.publicKey);

    expect(await openWith(sealed, stranger.privateKey)).toBeNull();
  });

  it('never seals the same thing the same way twice', async () => {
    const member = await makeKeyPair();

    expect(await sealFor(ENC, member.publicKey)).not.toBe(await sealFor(ENC, member.publicKey));
  });

  it('refuses a box somebody changed', async () => {
    const member = await makeKeyPair();
    const sealed = await sealFor(ENC, member.publicKey);
    const last = sealed.slice(-2, -1);
    const tampered = `${sealed.slice(0, -2)}${last === 'A' ? 'B' : 'A'}${sealed.slice(-1)}`;

    expect(await openWith(tampered, member.privateKey)).toBeNull();
  });

  it('returns null rather than throwing for things that are not boxes', async () => {
    const member = await makeKeyPair();

    expect(await openWith('sb1$abc$def', member.privateKey)).toBeNull();
    expect(await openWith('pk1$not-base64!$x', member.privateKey)).toBeNull();
    expect(await openWith(await sealFor(ENC, member.publicKey), 'nonsense')).toBeNull();
  });

  it('refuses to seal for something that is not a public key', async () => {
    await expect(sealFor(ENC, toBase64(new Uint8Array(12)))).rejects.toThrow();
  });
});

describe('keeping the private half', () => {
  it('comes back under the same enc, and not under another', async () => {
    const pair = await makeKeyPair();
    const enc = new Uint8Array(32).fill(1);
    const sealed = await sealPrivateKey(pair, enc);

    expect(await openPrivateKey(sealed, enc)).toBe(pair.privateKey);
    expect(await openPrivateKey(sealed, new Uint8Array(32).fill(2))).toBeNull();
  });
});
