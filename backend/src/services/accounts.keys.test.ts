import {
  CURRENT_KDF,
  KdfParams,
  SALT_BYTES,
  deriveAccountKeys,
  disguisedSalt,
  fromBase64,
  parseVerifier,
  toBase64
} from '../../../shared/auth/accountKeys';
import { SubmittedKeys, accountsService } from './accounts.service';
import { nodeKdf } from '../utils/nodeKdf';
import { accountSaltSecret } from '../utils/serverSecret';
import { db } from '../utils/database';
import { resetDatabase } from '../test-utils/seed';

/**
 * Signing in with a key the device derived, rather than a password.
 *
 * Its own file rather than another five hundred lines in
 * `accounts.service.test.ts`: this is a second way of proving who you are,
 * living beside the first until every device has been moved, and the two are
 * easier to read apart than together.
 *
 * The floor cost throughout. These tests are about what the server accepts and
 * stores, not about how long scrypt takes, and the real cost would add a
 * tenth of a second to every case for nothing.
 */

const PASSWORD = 'a-good-long-password';
const FLOOR: KdfParams = { cost: 16384, blockSize: 8, parallelism: 1 };

/** Sixteen bytes, which is the shortest salt the server will take. */
const SALT = toBase64(new TextEncoder().encode('0123456789abcdef'));

beforeEach(() => {
  resetDatabase({ withAccount: false });
});

const keysFor = async (
  password: string,
  overrides: Partial<SubmittedKeys> = {}
): Promise<SubmittedKeys> => {
  const salt = overrides.salt ?? SALT;
  const params = {
    cost: overrides.cost ?? FLOOR.cost,
    blockSize: overrides.blockSize ?? FLOOR.blockSize,
    parallelism: overrides.parallelism ?? FLOOR.parallelism
  };

  const { auth } = await deriveAccountKeys(password, fromBase64(salt)!, params, nodeKdf);

  return { salt, auth: toBase64(auth), ...params, ...overrides };
};

const enrol = async (username = 'petar', password = PASSWORD) => {
  const user = await accountsService.register(username, password);
  await accountsService.setAccountKeys(user.id, await keysFor(password));
  return user;
};

describe('the salt handed out before sign-in', () => {
  it('gives an enrolled account the salt and cost it was enrolled with', async () => {
    await enrol();

    expect(await accountsService.saltFor('petar')).toEqual({ salt: SALT, ...FLOOR });
  });

  it('finds the account whatever case the name is typed in', async () => {
    await enrol('Petar');

    expect((await accountsService.saltFor('PETAR')).salt).toBe(SALT);
  });

  it('answers for a name with no account at all', async () => {
    const answer = await accountsService.saltFor('nobody-here');

    expect(fromBase64(answer.salt)).toHaveLength(SALT_BYTES);
    expect(answer.cost).toBe(CURRENT_KDF.cost);
  });

  it('gives the same answer every time, as a real salt would', async () => {
    const once = await accountsService.saltFor('nobody-here');
    const again = await accountsService.saltFor('nobody-here');

    // A salt that changed between two asks would answer, on its own, the
    // question this whole arrangement refuses.
    expect(once).toEqual(again);
  });

  it('gives different names different answers', async () => {
    const one = await accountsService.saltFor('nobody-here');
    const other = await accountsService.saltFor('nor-here');

    expect(one.salt).not.toBe(other.salt);
  });

  it('disguises an account that exists but has never enrolled', async () => {
    await accountsService.register('petar', PASSWORD);

    const answer = await accountsService.saltFor('petar');
    const asIfUnknown = await disguisedSalt('petar', accountSaltSecret(), nodeKdf);

    // Byte for byte what a stranger's name would get. Telling "no such
    // account" apart from "not moved over yet" is the same leak wearing a
    // different hat.
    expect(answer).toEqual({ salt: toBase64(asIfUnknown), ...CURRENT_KDF });
  });
});

describe('signing in with a derived key', () => {
  it('accepts the key derived from the right password', async () => {
    await enrol();

    const { auth } = await keysFor(PASSWORD);
    const user = await accountsService.authenticateWithVerifier('petar', auth);

    expect(user?.username).toBe('petar');
  });

  it('refuses a key derived from the wrong password', async () => {
    await enrol();

    const { auth } = await keysFor('some-other-password');

    expect(await accountsService.authenticateWithVerifier('petar', auth)).toBeNull();
  });

  it('refuses a key derived with a different salt', async () => {
    await enrol();

    const { auth } = await keysFor(PASSWORD, {
      salt: toBase64(new TextEncoder().encode('fedcba9876543210'))
    });

    expect(await accountsService.authenticateWithVerifier('petar', auth)).toBeNull();
  });

  it('refuses an account that has never enrolled', async () => {
    await accountsService.register('petar', PASSWORD);

    const { auth } = await keysFor(PASSWORD);

    expect(await accountsService.authenticateWithVerifier('petar', auth)).toBeNull();
  });

  it('refuses an unknown name, and says nothing more about it', async () => {
    const { auth } = await keysFor(PASSWORD);

    expect(await accountsService.authenticateWithVerifier('nobody-here', auth)).toBeNull();
  });

  it('refuses nonsense in place of a key rather than throwing', async () => {
    await enrol();

    expect(await accountsService.authenticateWithVerifier('petar', '')).toBeNull();
    expect(await accountsService.authenticateWithVerifier('petar', 'not base64 !!')).toBeNull();
    // The right encoding, the wrong length.
    expect(await accountsService.authenticateWithVerifier('petar', toBase64(new Uint8Array(16))))
      .toBeNull();
  });
});

describe('what the server keeps', () => {
  it('stores a hash of the key, not the key', async () => {
    const user = await enrol();
    const sent = await keysFor(PASSWORD);

    const row = db.prepare('SELECT auth_verifier FROM users WHERE id = ?').get(user.id) as {
      auth_verifier: string;
    };
    const stored = parseVerifier(row.auth_verifier);

    // The difference between a table of verifiers and a table of passwords: a
    // copy of this row cannot be sent back as a sign-in.
    expect(toBase64(stored!.verifier)).not.toBe(sent.auth);
    expect(await accountsService.authenticateWithVerifier('petar', toBase64(stored!.verifier)))
      .toBeNull();
  });

  it('keeps the password hash as well, so the old way still works', async () => {
    await enrol();

    const row = db.prepare('SELECT password_hash FROM users').get() as { password_hash: string };
    expect(row.password_hash.startsWith('scrypt$')).toBe(true);
    expect((await accountsService.authenticate('petar', PASSWORD))?.username).toBe('petar');
  });

  it('says whether an account has been enrolled', async () => {
    const plain = await accountsService.register('plain', PASSWORD);
    const moved = await enrol('moved');

    expect(accountsService.hasAccountKeys(plain.id)).toBe(false);
    expect(accountsService.hasAccountKeys(moved.id)).toBe(true);
  });
});

describe('what the server refuses to record', () => {
  const rejects = async (overrides: Partial<SubmittedKeys>, message: string) => {
    const user = await accountsService.register(`u${Date.now() % 100000}`, PASSWORD);
    const keys = { ...(await keysFor(PASSWORD)), ...overrides };

    await expect(accountsService.setAccountKeys(user.id, keys)).rejects.toThrow(message);
    expect(accountsService.hasAccountKeys(user.id)).toBe(false);
  };

  it('refuses a cost below the floor', async () => {
    // A verifier made at N=2 is a password sitting in the database under
    // another name, and the device is the one choosing the number.
    await rejects({ cost: 1024 }, 'weaker than this server accepts');
  });

  it('refuses a cost above the ceiling', async () => {
    // Not to protect the server, which never runs it, but to stop one device
    // locking the phone out by picking a cost it cannot finish.
    await rejects({ cost: 1 << 24 }, 'more expensive than this server accepts');
  });

  it('refuses a salt too short to be worth having', async () => {
    await rejects({ salt: toBase64(new TextEncoder().encode('short')) }, 'salt must be at least');
  });

  it('refuses a key of the wrong length', async () => {
    await rejects({ auth: toBase64(new Uint8Array(16)) }, 'auth key must be');
  });

  it('refuses parameters that are not numbers', async () => {
    await rejects({ cost: 'lots' as unknown as number }, 'whole numbers');
  });

  it('refuses nothing at all', async () => {
    const user = await accountsService.register('petar', PASSWORD);

    await expect(
      accountsService.setAccountKeys(user.id, undefined as unknown as SubmittedKeys)
    ).rejects.toThrow('Account keys are required');
  });

  it('refuses to enrol an account that does not exist', async () => {
    await expect(accountsService.setAccountKeys(9999, await keysFor(PASSWORD))).rejects.toThrow(
      'No such account'
    );
  });
});

describe('enrolling as part of registration', () => {
  it('takes keys in the same request, so making an account is one round trip', async () => {
    const user = await accountsService.register('petar', PASSWORD, await keysFor(PASSWORD));

    expect(accountsService.hasAccountKeys(user.id)).toBe(true);
    expect((await accountsService.saltFor('petar')).salt).toBe(SALT);
  });

  it('leaves no account behind when the keys are refused', async () => {
    await expect(
      accountsService.register('petar', PASSWORD, await keysFor(PASSWORD, { cost: 1024 }))
    ).rejects.toThrow('weaker than this server accepts');

    // Checked before the row is written, so a rejected enrolment is not an
    // account somebody now has to delete.
    expect(accountsService.findByUsername('petar')).toBeNull();
  });
});

describe('changing the password', () => {
  const NEW_PASSWORD = 'an-even-better-password';

  it('re-keys when the device sends new keys', async () => {
    const user = await enrol();

    await accountsService.changePassword(
      user.id,
      PASSWORD,
      NEW_PASSWORD,
      await keysFor(NEW_PASSWORD)
    );

    const stale = await keysFor(PASSWORD);
    const fresh = await keysFor(NEW_PASSWORD);

    expect(await accountsService.authenticateWithVerifier('petar', stale.auth)).toBeNull();
    expect((await accountsService.authenticateWithVerifier('petar', fresh.auth))?.id).toBe(user.id);
  });

  it('removes the keys when the device sends none', async () => {
    const user = await enrol();

    await accountsService.changePassword(user.id, PASSWORD, NEW_PASSWORD);

    // The verifier came from the old password and could never match again.
    // Removing it puts the account back on password sign-in rather than
    // leaving one that refuses everybody.
    expect(accountsService.hasAccountKeys(user.id)).toBe(false);
    expect((await accountsService.authenticate('petar', NEW_PASSWORD))?.id).toBe(user.id);
  });

  it('changes nothing when the new keys are refused', async () => {
    const user = await enrol();

    await expect(
      accountsService.changePassword(
        user.id,
        PASSWORD,
        NEW_PASSWORD,
        await keysFor(NEW_PASSWORD, { cost: 1024 })
      )
    ).rejects.toThrow('weaker than this server accepts');

    // Checked before anything is written, so a refused set of keys does not
    // leave the password already changed and the account half moved.
    expect((await accountsService.authenticate('petar', PASSWORD))?.id).toBe(user.id);
    expect(accountsService.hasAccountKeys(user.id)).toBe(true);
  });

  it('still requires the current password', async () => {
    const user = await enrol();

    await expect(
      accountsService.changePassword(user.id, 'not-the-password', NEW_PASSWORD)
    ).rejects.toThrow('Current password is incorrect');
    expect(accountsService.hasAccountKeys(user.id)).toBe(true);
  });
});
