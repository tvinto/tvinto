import { hashPassword, needsRehash, verifyPassword } from './passwords';

describe('hashPassword', () => {
  it('produces a self-describing hash carrying its own parameters', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  });

  it('never stores the password itself', async () => {
    const hash = await hashPassword('hunter2');

    expect(hash).not.toContain('hunter2');
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [first, second] = await Promise.all([hashPassword('same'), hashPassword('same')]);

    expect(first).not.toEqual(second);
  });

  it('refuses an empty password rather than hashing nothing', async () => {
    await expect(hashPassword('')).rejects.toThrow('Password is required');
  });
});

describe('verifyPassword', () => {
  it('accepts the right password', async () => {
    const hash = await hashPassword('s3cret-passphrase');

    await expect(verifyPassword('s3cret-passphrase', hash)).resolves.toBe(true);
  });

  it('rejects the wrong one', async () => {
    const hash = await hashPassword('s3cret-passphrase');

    await expect(verifyPassword('s3cret-passphras', hash)).resolves.toBe(false);
    await expect(verifyPassword('S3cret-passphrase', hash)).resolves.toBe(false);
    await expect(verifyPassword('', hash)).resolves.toBe(false);
  });

  it('treats unicode consistently, so a password typed the same way matches', async () => {
    // The same character composed two ways: e + combining acute, and precomposed.
    const hash = await hashPassword('café latte');

    await expect(verifyPassword('café latte', hash)).resolves.toBe(true);
  });

  it('refuses a corrupt hash instead of throwing', async () => {
    const cases = [
      '',
      'not-a-hash',
      'scrypt$16384$8$1$onlyfiveparts',
      'bcrypt$16384$8$1$c2FsdA==$aGFzaA==',
      'scrypt$0$8$1$c2FsdA==$aGFzaA==',
      'scrypt$16384$8$1$$aGFzaA==',
      'scrypt$abc$8$1$c2FsdA==$aGFzaA=='
    ];

    for (const stored of cases) {
      await expect(verifyPassword('anything', stored)).resolves.toBe(false);
    }
  });

  it('rejects a hash whose digest length was tampered with', async () => {
    const hash = await hashPassword('correct');
    const truncated = hash.split('$').slice(0, 5).join('$') + '$' + Buffer.from('short').toString('base64');

    await expect(verifyPassword('correct', truncated)).resolves.toBe(false);
  });
});

describe('needsRehash', () => {
  it('leaves a hash made with the current parameters alone', async () => {
    const hash = await hashPassword('current');

    expect(needsRehash(hash)).toBe(false);
  });

  it('flags one made with a weaker cost', () => {
    expect(needsRehash('scrypt$1024$8$1$c2FsdA==$aGFzaA==')).toBe(true);
  });

  it('flags anything it cannot read, so a bad row is replaced on next login', () => {
    expect(needsRehash('rubbish')).toBe(true);
  });
});
