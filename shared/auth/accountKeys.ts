/**
 * Deriving an account's keys on the device that knows the password.
 *
 * The arrangement `credentialCipher.ts` describes as the better one and says
 * is blocked: "the key comes from your account password and the store cannot
 * read the secrets at all -- needs the provider calls to happen on your own
 * device". Every remaining client makes its own provider calls now, so the
 * condition is met.
 *
 * There is also a plainer reason. A Cloudflare Worker gets 10 ms of CPU per
 * request, and scrypt at the cost this app uses wants about a hundred. Hashing
 * a password server-side is simply not something a Worker can do. The device,
 * which is idle and waiting for the user anyway, can.
 *
 * What comes out is two keys that cannot be derived from one another:
 *
 * - `auth` is sent. The server keeps `sha256(auth)`, which costs microseconds
 *   to check. It is already 32 bytes of scrypt output, so a stolen copy of
 *   that hash is not worth attacking.
 * - `enc` never leaves the device. It encrypts the subscription and the guide
 *   sources, so a copy of the hosted database yields no provider password and
 *   no guide URL -- and a guide URL is a credential, whatever it looks like:
 *   `xmltv.php?username=...&password=...`.
 *
 * The primitives are injected rather than imported. This module has to run in
 * three places that share no crypto library: Node on the backend, a Worker,
 * and a WebView with only SubtleCrypto. What is shared is the decisions --
 * which cost, which info strings, what the stored record looks like -- and
 * those are exactly what must not drift between them.
 */

/** scrypt's cost parameters, as they are stored and sent. */
export interface KdfParams {
  /** scrypt's N. */
  cost: number;
  /** scrypt's r. */
  blockSize: number;
  /** scrypt's p. */
  parallelism: number;
}

/**
 * What new accounts are made with.
 *
 * The same numbers `passwords.ts` uses, deliberately: this is the same work
 * moving to a different machine, not a weakening of it. 2^16 is about a tenth
 * of a second and 64 MB in a native implementation.
 */
export const CURRENT_KDF: KdfParams = { cost: 65536, blockSize: 8, parallelism: 1 };

/** How much scrypt output to split. */
export const MASTER_BYTES = 64;

/** How long each derived key is. */
export const KEY_BYTES = 32;

/** How long a salt is, when one is generated. */
export const SALT_BYTES = 16;

/**
 * The labels the two keys are separated by.
 *
 * Versioned in the string itself. If either derivation ever changes, the
 * labels change with it, and a key made under the old rule cannot be mistaken
 * for one made under the new.
 */
const AUTH_INFO = 'xtream/account/auth/v1';
const ENC_INFO = 'xtream/account/enc/v1';

/** The label the disguised salt for an unknown username is made under. */
const DISGUISE_INFO = 'xtream/account/salt/v1';

/** What the device ends up with. */
export interface AccountKeys {
  /** Proof of identity. Sent to the server, which stores only its hash. */
  auth: Uint8Array;
  /** The encryption key. Never sent, never stored anywhere but this device. */
  enc: Uint8Array;
}

/**
 * The three operations this needs, from whatever the platform has.
 *
 * `hkdf` extracts and expands with SHA-256 and an empty salt, which RFC 5869
 * allows and which is right here: the input is already scrypt output, so there
 * is no low entropy for a salt to help with.
 */
export interface KdfPrimitives {
  scrypt(
    password: Uint8Array,
    salt: Uint8Array,
    params: KdfParams,
    length: number
  ): Promise<Uint8Array>;
  hkdf(key: Uint8Array, info: string, length: number): Promise<Uint8Array>;
  sha256(data: Uint8Array): Promise<Uint8Array>;
}

const utf8 = new TextEncoder();

/**
 * Turns a password into bytes the same way everywhere.
 *
 * NFKC because the same password typed on a phone and on a desktop keyboard
 * can be different sequences of code points for the same characters, and an
 * account that will not open on the television is not a subtle bug.
 */
const passwordBytes = (password: string): Uint8Array => utf8.encode(password.normalize('NFKC'));

/**
 * The account's two keys.
 *
 * The expensive step happens once. Splitting it afterwards is free, which is
 * the reason for splitting rather than running scrypt twice with different
 * salts.
 */
export const deriveAccountKeys = async (
  password: string,
  salt: Uint8Array,
  params: KdfParams,
  primitives: KdfPrimitives
): Promise<AccountKeys> => {
  if (!password) {
    throw new Error('A password is required');
  }
  if (!salt.length) {
    throw new Error('A salt is required');
  }

  const master = await primitives.scrypt(passwordBytes(password), salt, params, MASTER_BYTES);

  const [auth, enc] = await Promise.all([
    primitives.hkdf(master, AUTH_INFO, KEY_BYTES),
    primitives.hkdf(master, ENC_INFO, KEY_BYTES)
  ]);

  return { auth, enc };
};

/**
 * What the server stores and compares against: the hash of what it was sent.
 *
 * Asks for only the one operation it uses. The server side of this never runs
 * scrypt -- that is the entire point -- and a Worker supplying a fake one to
 * satisfy a type would be a lie waiting to be called.
 */
export const verifierFor = (
  auth: Uint8Array,
  primitives: Pick<KdfPrimitives, 'sha256'>
): Promise<Uint8Array> => primitives.sha256(auth);

/** A stored verifier, with everything needed to make another one like it. */
export interface StoredVerifier {
  /**
   * Which function made it.
   *
   * Named rather than assumed, so the day a device turns out to be too slow
   * for scrypt there is somewhere to say so, and accounts made before that day
   * still open.
   */
  kdf: 'scrypt';
  params: KdfParams;
  salt: Uint8Array;
  verifier: Uint8Array;
}

/**
 * The stored form: `dk1$scrypt$N$r$p$salt$verifier`, the last two base64.
 *
 * Self-describing, like the hashes in `passwords.ts`, and for the same reason:
 * the cost can be raised without stranding every account made before the
 * change. `dk1` distinguishes it at a glance from a `scrypt$...` password
 * hash, which is a different thing that happens to use the same function.
 */
export const formatVerifier = (record: StoredVerifier): string =>
  [
    'dk1',
    record.kdf,
    record.params.cost,
    record.params.blockSize,
    record.params.parallelism,
    toBase64(record.salt),
    toBase64(record.verifier)
  ].join('$');

/**
 * Reads a stored verifier, or null when it cannot be read.
 *
 * Null rather than a throw. These come from a database row, not from a caller,
 * and a corrupt row should refuse one sign-in rather than take the endpoint
 * down for everyone.
 */
export const parseVerifier = (stored: string): StoredVerifier | null => {
  if (typeof stored !== 'string') {
    return null;
  }

  const parts = stored.split('$');
  if (parts.length !== 7 || parts[0] !== 'dk1' || parts[1] !== 'scrypt') {
    return null;
  }

  const [, , cost, blockSize, parallelism, salt, verifier] = parts;
  const params = {
    cost: Number(cost),
    blockSize: Number(blockSize),
    parallelism: Number(parallelism)
  };

  const positive = (value: number) => Number.isInteger(value) && value > 0;
  if (!positive(params.cost) || !positive(params.blockSize) || !positive(params.parallelism)) {
    return null;
  }

  const decoded = { salt: fromBase64(salt), verifier: fromBase64(verifier) };
  if (!decoded.salt || !decoded.verifier || !decoded.salt.length || !decoded.verifier.length) {
    return null;
  }

  return { kdf: 'scrypt', params, salt: decoded.salt, verifier: decoded.verifier };
};

/**
 * Whether two verifiers match, without leaking how far the comparison got.
 *
 * Cheap enough to be worth doing even though both sides are hashes: a
 * comparison that returns on the first wrong byte tells an attacker which
 * guess was closer, and that is the whole game.
 */
export const sameVerifier = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }

  return difference === 0;
};

/**
 * A salt for a username that has no account.
 *
 * Signing in needs the salt before anything can be derived from the password,
 * so the endpoint that hands it out cannot be behind the session. Answering
 * "no such user" would turn it into a list of who has an account here.
 *
 * So an unknown name gets a salt anyway: deterministic, so asking twice gives
 * the same answer the way a real one would, and unguessable without the
 * server's secret, so it cannot be told apart from a real one. The sign-in
 * then fails at the verifier, exactly as a wrong password does.
 */
export const disguisedSalt = (
  username: string,
  serverSecret: Uint8Array,
  primitives: Pick<KdfPrimitives, 'hkdf'>
): Promise<Uint8Array> =>
  primitives.hkdf(serverSecret, `${DISGUISE_INFO}/${username}`, SALT_BYTES);

/**
 * The weakest derivation a server should record.
 *
 * The cost is the device's choice, because the point of moving the work there
 * was to let a television pick something it can afford. But a client that
 * chooses its own cost can choose a useless one, and a verifier made at N=2 is
 * a password sitting in the database under another name.
 */
export const MIN_KDF: KdfParams = { cost: 16384, blockSize: 8, parallelism: 1 };

/**
 * The most expensive derivation a server should record.
 *
 * Not to protect the server, which never runs it. To stop one device choosing
 * a cost the others cannot finish, and locking the account out of the phone
 * from the desktop.
 */
export const MAX_COST = 1048576;

/**
 * Refuses derivation parameters outside MIN_KDF..MAX_COST, for a device about
 * to derive with what a server told it.
 *
 * The same limits servers apply to what they record, applied the other way:
 * a sync service the person chose, or somebody between the device and one
 * reached over plain http, could otherwise name N=2, have the device send an
 * auth key derived at no cost, and guess the password from it at hash speed --
 * and with the password, the key that opens the provider logins.
 */
export const checkKdfParams = (params: KdfParams): void => {
  const whole = (value: unknown) => Number.isInteger(value) && (value as number) > 0;
  if (!whole(params.cost) || !whole(params.blockSize) || !whole(params.parallelism)) {
    throw new Error('The sync service sent derivation settings that are not whole numbers');
  }
  if (
    params.cost < MIN_KDF.cost ||
    params.blockSize < MIN_KDF.blockSize ||
    params.parallelism < MIN_KDF.parallelism ||
    params.cost > MAX_COST ||
    params.blockSize > 32 ||
    params.parallelism > 16
  ) {
    throw new Error('The sync service asked for a key derivation outside what Tvinto accepts; not signing in there');
  }
};

/** What a device sends to enrol or to sign in. */
export interface SubmittedKeys {
  /** The device's own salt, base64. */
  salt: string;
  /** The auth key, base64. Never the verifier: a server hashes what it gets. */
  auth: string;
  cost: number;
  blockSize: number;
  parallelism: number;
}

export type KeyCheck =
  | { ok: true; salt: Uint8Array; auth: Uint8Array; params: KdfParams }
  | { ok: false; reason: string };

/**
 * Whether a server should accept what a device sent.
 *
 * Shared rather than written twice. The Express backend and the Worker both
 * decide this, and two servers disagreeing about which derivations are
 * acceptable would mean an account that can be enrolled on one and not the
 * other -- discovered by a person, on a device, at the worst moment.
 *
 * Returns a reason rather than throwing, because the two callers turn a refusal
 * into different things: an `AccountError` with a status, and an `HttpError`
 * with one.
 */
export const checkSubmittedKeys = (keys: SubmittedKeys | undefined | null): KeyCheck => {
  if (!keys || typeof keys !== 'object') {
    return { ok: false, reason: 'Account keys are required' };
  }

  const salt = typeof keys.salt === 'string' ? fromBase64(keys.salt) : null;
  const auth = typeof keys.auth === 'string' ? fromBase64(keys.auth) : null;

  if (!salt || salt.length < SALT_BYTES) {
    return { ok: false, reason: `The salt must be at least ${SALT_BYTES} bytes` };
  }
  if (!auth || auth.length !== KEY_BYTES) {
    return { ok: false, reason: `The auth key must be ${KEY_BYTES} bytes` };
  }

  const params: KdfParams = {
    cost: Number(keys.cost),
    blockSize: Number(keys.blockSize),
    parallelism: Number(keys.parallelism)
  };

  const whole = (value: number) => Number.isInteger(value) && value > 0;
  if (!whole(params.cost) || !whole(params.blockSize) || !whole(params.parallelism)) {
    return { ok: false, reason: 'The derivation parameters must be whole numbers' };
  }

  if (
    params.cost < MIN_KDF.cost ||
    params.blockSize < MIN_KDF.blockSize ||
    params.parallelism < MIN_KDF.parallelism
  ) {
    return { ok: false, reason: 'That derivation is weaker than this server accepts' };
  }
  if (params.cost > MAX_COST) {
    return { ok: false, reason: 'That derivation is more expensive than this server accepts' };
  }

  return { ok: true, salt, auth, params };
};

/** Bytes as base64, without Buffer, which the Worker and the WebView lack. */
export const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

/** Base64 back to bytes, or null when the text is not base64 at all. */
export const fromBase64 = (text: string): Uint8Array | null => {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
};
