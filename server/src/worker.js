// Generated from worker/ by worker/scripts/build-server.mjs.
// Do not edit: change worker/ and build again.

// src/http.ts
var HttpError = class extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
  status;
};
var DEFAULT_ORIGINS = [
  "https://localhost",
  "http://localhost",
  "capacitor://localhost",
  "app://-"
];
var allowed = (env) => env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean) : DEFAULT_ORIGINS;
var corsHeaders = (request, env) => {
  const origin = request.headers.get("Origin");
  const permitted = origin && allowed(env).includes(origin);
  return {
    // An app with no Origin at all -- a native fetch, or curl -- is not a
    // browser and has nothing to be protected from.
    ...permitted ? { "Access-Control-Allow-Origin": origin } : {},
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
};
var json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json", ...headers }
});
var ok = (data, status = 200, headers) => json({ success: true, data }, status, headers);
var fail = (message, status, headers) => json({ success: false, message, timestamp: (/* @__PURE__ */ new Date()).toISOString() }, status, headers);
var MAX_BODY_CHARS = 1024 * 1024;
var readJson = async (request) => {
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY_CHARS) {
    throw new HttpError("That is more than this service takes in one request", 413);
  }
  let parsed;
  let body;
  try {
    body = await request.text();
  } catch {
    throw new HttpError("The body must be JSON", 400);
  }
  if (body.length > MAX_BODY_CHARS) {
    throw new HttpError("That is more than this service takes in one request", 413);
  }
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new HttpError("The body must be JSON", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError("The body must be a JSON object", 400);
  }
  return parsed;
};

// src/clock.ts
var CURSOR_LAG_MS = 1e3;
var now = () => (/* @__PURE__ */ new Date()).toISOString();
var cursorNow = () => new Date(Date.now() - CURSOR_LAG_MS).toISOString();

// ../shared/family.ts
var FAMILY_ROLES = ["admin", "member", "kid"];
var isFamilyRole = (value) => typeof value === "string" && FAMILY_ROLES.includes(value);
var isToolScope = (scope) => scope === "tool" || scope === "tool-history";
var SETUP_KINDS = ["arrangement", "setting", "guideSource", "channelMapping"];
var KID_KINDS = ["favourite", "progress"];
var CHANGE_FIELDS = {
  favourite: "favourites",
  arrangement: "arrangements",
  progress: "progress",
  setting: "settings",
  guideSource: "guideSources",
  channelMapping: "channelMappings"
};
var kindsVisible = (scope) => scope === "setup" || scope === "tool" ? SETUP_KINDS : null;
var kindsAllowed = (role, scope) => {
  if (scope === "setup") {
    return SETUP_KINDS;
  }
  if (scope === "tool") {
    return role === "kid" ? [] : SETUP_KINDS;
  }
  return role === "kid" ? KID_KINDS : null;
};
var LOCK_SETTINGS = ["parentalLock", "lockedCategories", "ageLock"];
var touchesLock = (batch) => (batch.settings ?? []).some((setting) => LOCK_SETTINGS.includes(setting?.key)) || (batch.deletions ?? []).some((deletion) => deletion?.kind === "setting" && LOCK_SETTINGS.includes(deletion.key));
var onlyKinds = (batch, allowed2) => {
  if (!allowed2) {
    return { batch, dropped: 0 };
  }
  let dropped = 0;
  const kept = {};
  for (const [kind, field] of Object.entries(CHANGE_FIELDS)) {
    const list = batch[field] ?? [];
    if (allowed2.includes(kind)) {
      kept[field] = list;
    } else {
      dropped += list.length;
    }
  }
  const deletions = batch.deletions ?? [];
  kept.deletions = deletions.filter((deletion) => allowed2.includes(deletion.kind));
  dropped += deletions.length - kept.deletions.length;
  return { batch: kept, dropped };
};

// src/sessions.ts
var IDLE_TTL_MS = 365 * 24 * 60 * 60 * 1e3;
var TOOL_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
var REFRESH_AFTER_MS = 5 * 60 * 1e3;
var encoder = new TextEncoder();
var hashToken = async (token) => {
  const digest2 = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return [...new Uint8Array(digest2)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
var mintToken = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
var createSession = async (db, userId, scope = "full", label = null, mintedBy = null) => {
  const token = mintToken();
  const at = now();
  await db.prepare(
    `INSERT OR REPLACE INTO sessions
         (token_hash, user_id, created_at, last_used_at, scope, label, minted_by, minted_by_session, minted_by_tool)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    await hashToken(token),
    userId,
    at,
    at,
    scope,
    label,
    mintedBy?.userId ?? null,
    mintedBy?.sessionId ?? null,
    mintedBy?.tool ? 1 : 0
  ).run();
  return token;
};
var createSignInSession = async (db, userId, verifier, scope = "full", label = null) => {
  const token = mintToken();
  const at = now();
  const result = await db.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, last_used_at, scope, label)
       SELECT ?, id, ?, ?, ?, ? FROM users WHERE id = ? AND auth_verifier = ?`
  ).bind(await hashToken(token), at, at, scope, label, userId, verifier).run();
  return (result.meta?.changes ?? 0) > 0 ? token : null;
};
var sessionId = (tokenHash) => tokenHash.slice(0, 16);
var listToolSessions = async (db, userId, currentHash2) => {
  const rows = await db.prepare(
    `SELECT token_hash, label, created_at, last_used_at, scope FROM sessions
        WHERE user_id = ? AND scope IN ('tool', 'tool-history')
        ORDER BY last_used_at DESC`
  ).bind(userId).all();
  return (rows.results ?? []).map((row) => ({
    id: sessionId(row.token_hash),
    name: row.label ?? "Tool",
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    history: row.scope === "tool-history",
    current: row.token_hash === currentHash2
  }));
};
var TOOL_CHANGES_PER_MINUTE = 30;
var chargeToolChanges = async (db, sessionPrefix, changes, at = now()) => {
  const minute = at.slice(0, 16);
  const row = await db.prepare("SELECT tool_window FROM sessions WHERE substr(token_hash, 1, 16) = ?").bind(sessionPrefix).first();
  const [stored, count] = (row?.tool_window ?? "").split("|");
  const used = stored === minute ? Number(count) || 0 : 0;
  if (used + changes > TOOL_CHANGES_PER_MINUTE) {
    throw new HttpError(`A tool may make ${TOOL_CHANGES_PER_MINUTE} changes a minute. Wait a minute and try again.`, 429);
  }
  await db.prepare("UPDATE sessions SET tool_window = ? WHERE substr(token_hash, 1, 16) = ?").bind(`${minute}|${used + changes}`, sessionPrefix).run();
};
var endToolSession = async (db, userId, id) => {
  if (!/^[0-9a-f]{16}$/.test(id)) {
    return false;
  }
  const result = await db.prepare(
    `DELETE FROM sessions
        WHERE user_id = ? AND scope IN ('tool', 'tool-history') AND substr(token_hash, 1, 16) = ?`
  ).bind(userId, id).run();
  await db.prepare("DELETE FROM sessions WHERE minted_by = ? AND minted_by_session = ?").bind(userId, id).run();
  return (result.meta?.changes ?? 0) > 0;
};
var endSessionsMintedBy = async (db, userId) => {
  await db.prepare("DELETE FROM sessions WHERE minted_by = ?").bind(userId).run();
};
var bearerToken = (request) => {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
};
var scopeOf = (stored) => stored === "full" || stored === "tool" || stored === "tool-history" ? stored : "setup";
var resolveSession = async (db, request) => {
  const token = bearerToken(request);
  if (!token) {
    return null;
  }
  const hash = await hashToken(token);
  const row = await db.prepare(
    // So does whether the session that made this one is still there: a
    // session made by another lives only as long as its maker.
    `SELECT sessions.user_id, sessions.last_used_at, sessions.scope, users.role,
              sessions.minted_by, sessions.minted_by_session, sessions.minted_by_tool,
              (SELECT COUNT(*) FROM sessions maker
                WHERE maker.user_id = sessions.minted_by
                  AND substr(maker.token_hash, 1, 16) = sessions.minted_by_session) AS maker_alive
         FROM sessions JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ?`
  ).bind(hash).first();
  if (!row) {
    return null;
  }
  const scope = scopeOf(row.scope);
  const mintedBy = row.minted_by === null || row.minted_by === void 0 ? null : { userId: Number(row.minted_by), sessionId: String(row.minted_by_session ?? ""), tool: Number(row.minted_by_tool) === 1 };
  const ttl = scope === "tool" || scope === "tool-history" ? TOOL_IDLE_TTL_MS : IDLE_TTL_MS;
  const idle = Date.now() - Date.parse(row.last_used_at);
  if (!Number.isFinite(idle) || idle > ttl || mintedBy && Number(row.maker_alive) === 0) {
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run();
    return null;
  }
  if (idle > REFRESH_AFTER_MS) {
    await db.prepare("UPDATE sessions SET last_used_at = ? WHERE token_hash = ?").bind(now(), hash).run();
  }
  return {
    userId: Number(row.user_id),
    // Anything unexpected reads as the least it could be, not the most.
    role: isFamilyRole(row.role) ? row.role : "kid",
    scope,
    sessionId: sessionId(hash),
    mintedBy
  };
};
var destroySessionsFor = async (db, userId) => {
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
};
var actsAsTool = (caller) => caller.scope === "tool" || caller.scope === "tool-history" || caller.mintedBy?.tool === true;
var toolChargeId = (caller) => caller.mintedBy?.tool ? caller.mintedBy.sessionId : caller.sessionId;

// ../shared/auth/accountKeys.ts
var CURRENT_KDF = { cost: 65536, blockSize: 8, parallelism: 1 };
var KEY_BYTES = 32;
var SALT_BYTES = 16;
var DISGUISE_INFO = "xtream/account/salt/v1";
var utf8 = new TextEncoder();
var verifierFor = (auth, primitives) => primitives.sha256(auth);
var formatVerifier = (record) => [
  "dk1",
  record.kdf,
  record.params.cost,
  record.params.blockSize,
  record.params.parallelism,
  toBase64(record.salt),
  toBase64(record.verifier)
].join("$");
var parseVerifier = (stored) => {
  if (typeof stored !== "string") {
    return null;
  }
  const parts = stored.split("$");
  if (parts.length !== 7 || parts[0] !== "dk1" || parts[1] !== "scrypt") {
    return null;
  }
  const [, , cost, blockSize, parallelism, salt, verifier] = parts;
  const params = {
    cost: Number(cost),
    blockSize: Number(blockSize),
    parallelism: Number(parallelism)
  };
  const positive = (value) => Number.isInteger(value) && value > 0;
  if (!positive(params.cost) || !positive(params.blockSize) || !positive(params.parallelism)) {
    return null;
  }
  const decoded = { salt: fromBase64(salt), verifier: fromBase64(verifier) };
  if (!decoded.salt || !decoded.verifier || !decoded.salt.length || !decoded.verifier.length) {
    return null;
  }
  return { kdf: "scrypt", params, salt: decoded.salt, verifier: decoded.verifier };
};
var sameVerifier = (left, right) => {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
};
var disguisedSalt = (username, serverSecret, primitives) => primitives.hkdf(serverSecret, `${DISGUISE_INFO}/${username}`, SALT_BYTES);
var MIN_KDF = { cost: 16384, blockSize: 8, parallelism: 1 };
var MAX_COST = 1048576;
var checkSubmittedKeys = (keys) => {
  if (!keys || typeof keys !== "object") {
    return { ok: false, reason: "Account keys are required" };
  }
  const salt = typeof keys.salt === "string" ? fromBase64(keys.salt) : null;
  const auth = typeof keys.auth === "string" ? fromBase64(keys.auth) : null;
  if (!salt || salt.length < SALT_BYTES) {
    return { ok: false, reason: `The salt must be at least ${SALT_BYTES} bytes` };
  }
  if (!auth || auth.length !== KEY_BYTES) {
    return { ok: false, reason: `The auth key must be ${KEY_BYTES} bytes` };
  }
  const params = {
    cost: Number(keys.cost),
    blockSize: Number(keys.blockSize),
    parallelism: Number(keys.parallelism)
  };
  const whole = (value) => Number.isInteger(value) && value > 0;
  if (!whole(params.cost) || !whole(params.blockSize) || !whole(params.parallelism)) {
    return { ok: false, reason: "The derivation parameters must be whole numbers" };
  }
  if (params.cost < MIN_KDF.cost || params.blockSize < MIN_KDF.blockSize || params.parallelism < MIN_KDF.parallelism) {
    return { ok: false, reason: "That derivation is weaker than this server accepts" };
  }
  if (params.cost > MAX_COST) {
    return { ok: false, reason: "That derivation is more expensive than this server accepts" };
  }
  return { ok: true, salt, auth, params };
};
var toBase64 = (bytes) => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};
var fromBase64 = (text2) => {
  try {
    const binary = atob(text2);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
};

// ../shared/profilePicture.ts
var PROFILE_ANIMALS = ["dog", "cat", "fox", "panda", "lion", "tiger", "koala", "rabbit"];
var PICTURE_MAX_LENGTH = 6e4;
var IMAGE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
var isProfileAnimal = (value) => typeof value === "string" && PROFILE_ANIMALS.includes(value);
function isProfilePicture(value) {
  if (value === null) {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  if (value.startsWith("animal:")) {
    return isProfileAnimal(value.slice("animal:".length));
  }
  return value.length <= PICTURE_MAX_LENGTH && IMAGE.test(value);
}

// src/invites.ts
var ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
var LENGTH = 8;
var VALID_FOR_MS = 7 * 24 * 60 * 60 * 1e3;
var MOST_OPEN = 5;
var encoder2 = new TextEncoder();
var normaliseInvite = (typed) => typed.toUpperCase().replace(/[^A-Z0-9]/g, "");
var hashInvite = async (code) => {
  const digest2 = await crypto.subtle.digest("SHA-256", encoder2.encode(normaliseInvite(code)));
  return [...new Uint8Array(digest2)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
var mintInvite = () => {
  const limit = 256 - 256 % ALPHABET.length;
  let code = "";
  while (code.length < LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(LENGTH * 2))) {
      if (byte < limit && code.length < LENGTH) {
        code += ALPHABET[byte % ALPHABET.length];
      }
    }
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
};
var createInvite = async (env, userId) => {
  const at = now();
  const open2 = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM invites WHERE created_by = ? AND used_at IS NULL AND expires_at > ?"
  ).bind(userId, at).first();
  if ((open2?.n ?? 0) >= MOST_OPEN) {
    throw new HttpError(`You already have ${MOST_OPEN} unused invite codes; cancel one first`, 409);
  }
  const code = mintInvite();
  const expiresAt = new Date(Date.parse(at) + VALID_FOR_MS).toISOString();
  const created = await env.DB.prepare(
    "INSERT INTO invites (code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?) RETURNING id"
  ).bind(await hashInvite(code), userId, at, expiresAt).first();
  return ok({ id: created?.id, code, createdAt: at, expiresAt }, 201);
};
var listInvites = async (env, userId) => {
  const { results } = await env.DB.prepare(
    `SELECT invites.id, invites.created_at, invites.expires_at, invites.used_at, users.username AS used_by
     FROM invites LEFT JOIN users ON users.id = invites.used_by
     WHERE invites.created_by = ?
     ORDER BY invites.created_at DESC
     LIMIT 20`
  ).bind(userId).all();
  return ok(
    results.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      usedBy: row.used_by
    }))
  );
};
var revokeInvite = async (env, userId, id) => {
  await env.DB.prepare("DELETE FROM invites WHERE id = ? AND created_by = ? AND used_at IS NULL").bind(Number(id), userId).run();
  return ok({ revoked: true });
};
var claimInvite = async (db, typed) => {
  const at = now();
  const claimed = await db.prepare(
    "UPDATE invites SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING id, created_by"
  ).bind(at, await hashInvite(typed), at).first();
  return claimed ? { id: Number(claimed.id), createdBy: Number(claimed.created_by) } : null;
};
var releaseInvite = async (db, id) => {
  await db.prepare("UPDATE invites SET used_at = NULL WHERE id = ?").bind(id).run();
};
var recordInviteUse = async (db, id, userId) => {
  await db.prepare("UPDATE invites SET used_by = ? WHERE id = ?").bind(userId, id).run();
};

// src/kdf.ts
var workerKdf = {
  hkdf: async (key, info, length) => {
    const material = await crypto.subtle.importKey("raw", asOwned(key), "HKDF", false, [
      "deriveBits"
    ]);
    const bits = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        // Empty, matching both the device and the Express backend. The input
        // is already scrypt output, and the three must agree exactly or
        // nothing opens.
        salt: new Uint8Array(0),
        info: new TextEncoder().encode(info)
      },
      material,
      length * 8
    );
    return new Uint8Array(bits);
  },
  sha256: async (data) => new Uint8Array(await crypto.subtle.digest("SHA-256", asOwned(data)))
};
var asOwned = (bytes) => Uint8Array.from(bytes);

// src/signInLimit.ts
var TRIES_PER_NAME = 10;
var TRIES_PER_ADDRESS = 30;
var WINDOW_MINUTES = 15;
var hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
var digest = async (text2) => hex(await workerKdf.sha256(new TextEncoder().encode(text2))).slice(0, 32);
var tryKeys = async (request, name) => {
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
  return {
    address: await digest(`address ${address}`),
    name: await digest(`name ${address} ${name.trim().toLowerCase()}`)
  };
};
var windowStart = (at) => new Date(Date.parse(at) - WINDOW_MINUTES * 6e4).toISOString();
var refuseIfTooManyTries = async (db, keys, at) => {
  const rows = await db.prepare("SELECT key, count FROM sign_in_failures WHERE key IN (?, ?) AND since >= ?").bind(keys.address, keys.name, windowStart(at)).all();
  const used = new Map(rows.results.map((row) => [row.key, Number(row.count) || 0]));
  if ((used.get(keys.name) ?? 0) >= TRIES_PER_NAME || (used.get(keys.address) ?? 0) >= TRIES_PER_ADDRESS) {
    throw new HttpError(`Too many tries. Wait ${WINDOW_MINUTES} minutes and try again.`, 429);
  }
};
var countFailedTry = async (db, keys, at) => {
  const since = windowStart(at);
  const count = (key) => db.prepare(
    `INSERT INTO sign_in_failures (key, since, count) VALUES (?, ?, 1)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN sign_in_failures.since < ? THEN 1 ELSE sign_in_failures.count + 1 END,
           since = CASE WHEN sign_in_failures.since < ? THEN excluded.since ELSE sign_in_failures.since END`
  ).bind(key, at, since, since);
  await db.batch([
    count(keys.address),
    count(keys.name),
    // Whatever has outlived its window, so nothing is kept longer than that.
    db.prepare("DELETE FROM sign_in_failures WHERE since < ?").bind(since)
  ]);
};
var forgetFailedTries = async (db, keys) => {
  await db.prepare("DELETE FROM sign_in_failures WHERE key = ?").bind(keys.name).run();
};

// src/accounts.ts
var USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/i;
var fold = (username) => username.trim().toLowerCase();
var findUser = (db, username) => db.prepare("SELECT id, username, auth_verifier FROM users WHERE username_folded = ?").bind(fold(username ?? "")).first();
var saltSecret = (env) => {
  const configured = env.ACCOUNT_SALT_SECRET?.trim();
  const decoded = configured ? fromBase64(configured) : null;
  if (!decoded || decoded.length < 32) {
    throw new HttpError("This service is missing ACCOUNT_SALT_SECRET", 500);
  }
  return decoded;
};
var accountSalt = async (request, env) => {
  const username = (new URL(request.url).searchParams.get("username") ?? "").trim();
  if (!username) {
    throw new HttpError("A username is required", 400);
  }
  const user = await findUser(env.DB, username);
  const stored = user ? parseVerifier(user.auth_verifier) : null;
  if (stored) {
    return ok({ salt: toBase64(stored.salt), ...stored.params });
  }
  const salt = await disguisedSalt(fold(username), saltSecret(env), workerKdf);
  return ok({ salt: toBase64(salt), ...CURRENT_KDF });
};
var acceptKeys = (keys) => {
  const checked = checkSubmittedKeys(keys);
  if (!checked.ok) {
    throw new HttpError(checked.reason, 400);
  }
  return checked;
};
var registrationClosed = async (env) => {
  const setting = (env.ACCOUNT_REGISTRATION ?? "").trim().toLowerCase();
  if (setting === "closed") {
    return true;
  }
  if (setting !== "first-only") {
    return false;
  }
  const existing = await env.DB.prepare("SELECT 1 AS present FROM users LIMIT 1").first();
  return existing !== null;
};
var registrationMode = async (env) => {
  try {
    return await registrationClosed(env) ? "invite" : "open";
  } catch {
    return "invite";
  }
};
var register = async (request, env) => {
  const body = await readJson(request);
  const username = (body.username ?? "").trim();
  const invite = typeof body.invite === "string" ? body.invite.trim() : "";
  if (!invite && await registrationClosed(env)) {
    throw new HttpError("Accounts need an invite code here. Ask someone who has an account for one.", 403);
  }
  if (!USERNAME_PATTERN.test(username)) {
    throw new HttpError(
      "Username must be 3 to 32 characters, using letters, numbers, dot, dash or underscore",
      400
    );
  }
  const keys = acceptKeys(body.keys);
  const verifier = formatVerifier({
    kdf: "scrypt",
    params: keys.params,
    salt: keys.salt,
    // Hashed here, not on the device. What arrives is the key; what is kept is
    // a hash of it.
    verifier: await verifierFor(keys.auth, workerKdf)
  });
  const at = now();
  const tries = invite ? await tryKeys(request, "") : null;
  if (tries) {
    await refuseIfTooManyTries(env.DB, tries, at);
  }
  const claimed = invite ? await claimInvite(env.DB, invite) : null;
  const inviteId = claimed?.id ?? null;
  if (tries && inviteId === null) {
    await countFailedTry(env.DB, tries, at);
    throw new HttpError("That invite code is not valid. It may have been used, cancelled or run out.", 403);
  }
  const created = await env.DB.prepare(
    `INSERT INTO users (username, username_folded, auth_verifier, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(username_folded) DO NOTHING
     RETURNING id`
  ).bind(username, fold(username), verifier, at, at).first();
  if (!created) {
    if (inviteId !== null) {
      await releaseInvite(env.DB, inviteId);
    }
    throw new HttpError("That username is taken", 409);
  }
  if (claimed) {
    await recordInviteUse(env.DB, claimed.id, created.id);
    await env.DB.prepare(
      "UPDATE users SET manager_id = ?, role = 'member' WHERE id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND role = 'admin')"
    ).bind(claimed.createdBy, created.id, claimed.createdBy).run();
  }
  const token = await createSession(env.DB, created.id);
  return ok(
    {
      token,
      user: { id: created.id, username, createdAt: at },
      hasSubscription: false,
      enrolled: true
    },
    201
  );
};
var login = async (request, env) => {
  const body = await readJson(request);
  const username = (body.username ?? "").trim();
  if (!username) {
    throw new HttpError("A username is required", 400);
  }
  if (!body.auth) {
    throw new HttpError("This service signs in with a derived key, not a password", 400);
  }
  const tool = body.tool === void 0 ? null : toolSignIn(body.tool);
  const at = now();
  const tries = await tryKeys(request, username);
  await refuseIfTooManyTries(env.DB, tries, at);
  const user = await findUser(env.DB, username);
  const stored = user ? parseVerifier(user.auth_verifier) : null;
  const sent = typeof body.auth === "string" ? fromBase64(body.auth) : null;
  const refuse = async () => {
    await countFailedTry(env.DB, tries, at);
    throw new HttpError("Incorrect username or password", 401);
  };
  if (!user || !stored || !sent || sent.length !== KEY_BYTES) {
    return refuse();
  }
  const offered = await verifierFor(sent, workerKdf);
  if (!sameVerifier(offered, stored.verifier)) {
    return refuse();
  }
  await forgetFailedTries(env.DB, tries);
  const scope = tool ? tool.history ? "tool-history" : "tool" : "full";
  const token = await createSignInSession(env.DB, user.id, user.auth_verifier, scope, tool?.name ?? null);
  if (!token) {
    return refuse();
  }
  const subscription = await env.DB.prepare(
    "SELECT 1 AS present FROM provider_accounts WHERE user_id = ? AND active = 1 LIMIT 1"
  ).bind(user.id).first();
  return ok({
    token,
    user: { id: user.id, username: user.username },
    // Where to send them: the library, or straight to "add your subscription".
    hasSubscription: subscription !== null,
    enrolled: true,
    // What the session is: a tool checks it got the narrow one it asked for.
    scope
  });
};
var TOOL_NAME_LIMIT = 60;
var toolSignIn = (value) => {
  const asked = value;
  const name = typeof asked?.name === "string" ? asked.name.trim() : "";
  if (!name || name.length > TOOL_NAME_LIMIT || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new HttpError(`A tool names itself in up to ${TOOL_NAME_LIMIT} characters`, 400);
  }
  return { name, history: asked?.history === true };
};
var replaceKeys = async (request, env, userId) => {
  const keys = acceptKeys(await readJson(request));
  const verifier = formatVerifier({
    kdf: "scrypt",
    params: keys.params,
    salt: keys.salt,
    verifier: await verifierFor(keys.auth, workerKdf)
  });
  const token = bearerToken(request);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET auth_verifier = ?, updated_at = ? WHERE id = ?").bind(verifier, now(), userId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(
      userId,
      token ? await hashToken(token) : ""
    )
  ]);
  return ok({ enrolled: true });
};
var me = async (env, userId) => {
  const user = await env.DB.prepare(
    "SELECT id, username, created_at, role, manager_id, household, picture FROM users WHERE id = ?"
  ).bind(userId).first();
  if (!user) {
    throw new HttpError("No such account", 404);
  }
  return ok({
    user: {
      id: user.id,
      username: user.username,
      createdAt: user.created_at,
      // Where it stands in its family (shared/family.ts). An app from before
      // families ignores these, and an account outside one is an admin.
      role: user.role,
      managerId: user.manager_id ?? null,
      household: user.household === 1,
      picture: user.picture ?? null
    },
    providers: await listProviderRows(env.DB, userId)
  });
};
var setPicture = async (request, env, userId) => {
  const body = await readJson(request);
  if (body.picture === void 0 || !isProfilePicture(body.picture)) {
    throw new HttpError("A picture is an animal, a small JPEG, PNG or WebP, or null", 400);
  }
  await env.DB.prepare("UPDATE users SET picture = ?, updated_at = ? WHERE id = ?").bind(body.picture, (/* @__PURE__ */ new Date()).toISOString(), userId).run();
  return ok({ changed: true });
};
var listProviderRows = (db, userId) => db.prepare(
  "SELECT id, payload, active, created_at, updated_at FROM provider_accounts WHERE user_id = ? ORDER BY updated_at DESC"
).bind(userId).all().then(
  (result) => result.results.map((row) => ({
    id: row.id,
    payload: row.payload,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }))
);
var listProviders = async (env, userId) => ok(await listProviderRows(env.DB, userId));
var activeProvider = async (env, userId) => {
  const row = await env.DB.prepare(
    "SELECT id, payload, updated_at FROM provider_accounts WHERE user_id = ? AND active = 1 ORDER BY updated_at DESC LIMIT 1"
  ).bind(userId).first();
  if (!row) {
    throw new HttpError("No subscription is set up on this account", 409);
  }
  return ok({ id: row.id, payload: row.payload, updatedAt: row.updated_at });
};
var MAX_PROVIDER_PAYLOAD_CHARS = 64 * 1024;
var MAX_PROVIDERS_PER_ACCOUNT = 50;
var saveProvider = async (request, env, userId) => {
  const body = await readJson(request);
  const id = (body.id ?? "").trim();
  if (!id || id.length > 128) {
    throw new HttpError("A subscription id is required", 400);
  }
  if (typeof body.payload !== "string" || !body.payload) {
    throw new HttpError("An encrypted payload is required", 400);
  }
  if (body.payload.length > MAX_PROVIDER_PAYLOAD_CHARS) {
    throw new HttpError("That subscription is larger than this service keeps", 413);
  }
  const held = await env.DB.prepare(
    "SELECT COUNT(*) AS n, SUM(CASE WHEN id = ? THEN 1 ELSE 0 END) AS same FROM provider_accounts WHERE user_id = ?"
  ).bind(id, userId).first();
  if (!Number(held?.same) && Number(held?.n) >= MAX_PROVIDERS_PER_ACCOUNT) {
    throw new HttpError(`An account keeps at most ${MAX_PROVIDERS_PER_ACCOUNT} subscriptions`, 413);
  }
  const at = now();
  const active = body.active === false ? 0 : 1;
  await env.DB.prepare(
    `INSERT INTO provider_accounts (user_id, id, payload, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET
       payload = excluded.payload,
       active = excluded.active,
       updated_at = excluded.updated_at`
  ).bind(userId, id, body.payload, active, at, at).run();
  if (active === 1) {
    await env.DB.prepare(
      "UPDATE provider_accounts SET active = 0 WHERE user_id = ? AND id != ?"
    ).bind(userId, id).run();
  }
  return ok(await listProviderRows(env.DB, userId), 201);
};
var removeProvider = async (env, userId, id) => {
  await env.DB.prepare("DELETE FROM provider_accounts WHERE user_id = ? AND id = ?").bind(userId, id).run();
  return ok(await listProviderRows(env.DB, userId));
};

// ../shared/sync.ts
var CHANGE_KINDS = [
  "favourite",
  "arrangement",
  "progress",
  "setting",
  "guideSource",
  "channelMapping"
];
var LISTS = [
  "deletions",
  "favourites",
  "arrangements",
  "progress",
  "settings",
  "guideSources",
  "channelMappings"
];
function countChanges(batch) {
  return LISTS.reduce((total, kind) => total + (batch[kind]?.length ?? 0), 0);
}
var MAX_CHANGES_PER_PUSH = 20;

// src/d1.ts
var text = (value) => value === null ? "" : String(value);
var maybeText = (value) => value === null || value === void 0 ? null : String(value);
var number = (value) => Number(value ?? 0);
var maybeNumber = (value) => value === null || value === void 0 ? null : Number(value);

// ../shared/categoryLock.ts
var noCategories = () => ({ live: [], vod: [], series: [] });
var TYPES = ["live", "vod", "series"];
function readCategorySets(raw) {
  const sets = noCategories();
  if (!raw) {
    return sets;
  }
  try {
    const parsed = JSON.parse(raw);
    for (const type of TYPES) {
      const ids = parsed?.[type];
      if (Array.isArray(ids)) {
        sets[type] = [...new Set(ids.map(String))];
      }
    }
  } catch {
  }
  return sets;
}

// ../shared/tmdb/age.ts
var NO_AGE_LOCK = { limit: 0, country: "HR" };
function readAgeLock(raw) {
  try {
    const parsed = JSON.parse(raw || "null");
    const limit = Number(parsed?.limit);
    const country = typeof parsed?.country === "string" && /^[A-Z]{2}$/.test(parsed.country) ? parsed.country : NO_AGE_LOCK.country;
    return { limit: Number.isFinite(limit) && limit > 0 ? limit : 0, country };
  } catch {
    return NO_AGE_LOCK;
  }
}
function loosens(from, to) {
  if (from.limit <= 0) {
    return false;
  }
  return to.limit <= 0 || to.limit > from.limit || to.country !== from.country;
}

// src/sync.ts
var EPOCH = "1970-01-01T00:00:00.000Z";
var isNewer = (incoming, stored) => {
  if (!incoming) {
    return false;
  }
  return !stored || incoming > stored;
};
var noLaterThan = (received, at) => {
  const capped = (items) => items?.map((item) => {
    const change = item;
    const updatedAt = typeof change.updatedAt === "string" && change.updatedAt > at ? at : change.updatedAt;
    const deletedAt = typeof change.deletedAt === "string" && change.deletedAt > at ? at : change.deletedAt;
    return updatedAt === change.updatedAt && deletedAt === change.deletedAt ? item : { ...item, ...change.updatedAt !== void 0 ? { updatedAt } : {}, ...change.deletedAt !== void 0 ? { deletedAt } : {} };
  });
  return {
    ...received,
    favourites: capped(received.favourites),
    arrangements: capped(received.arrangements),
    progress: capped(received.progress),
    settings: capped(received.settings),
    guideSources: capped(received.guideSources),
    channelMappings: capped(received.channelMappings),
    deletions: capped(received.deletions)
  };
};
var favouriteKey = (type, streamId) => `${type}:${streamId}`;
var progressKey = (type, itemId) => `${type}:${itemId}`;
var splitKey = (key) => {
  const at = key.indexOf(":");
  return at === -1 ? ["", ""] : [key.slice(0, at), key.slice(at + 1)];
};
var parseJson = (value, fallback) => {
  try {
    const parsed = JSON.parse(text(value));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
};
var pullChanges = async (request, env, userId, allowed2 = null) => {
  const since = (new URL(request.url).searchParams.get("since") ?? "").trim();
  if (since && Number.isNaN(Date.parse(since))) {
    throw new HttpError("since must be an ISO timestamp", 400);
  }
  const from = since || EPOCH;
  const db = env.DB;
  const [favourites, arrangements, progress, settings, guideSources, channelMappings, deletions] = await Promise.all([
    favouritesSince(db, userId, from),
    arrangementsSince(db, userId, from),
    progressSince(db, userId, from),
    settingsSince(db, userId, from),
    guideSourcesSince(db, userId, from),
    channelMappingsSince(db, userId, from),
    deletionsSince(db, userId, from)
  ]);
  const result = {
    serverTime: cursorNow(),
    favourites,
    arrangements,
    progress,
    settings,
    guideSources,
    channelMappings,
    deletions
  };
  const narrowed = onlyKinds(result, allowed2).batch;
  return ok({ ...result, ...emptyLists(), ...narrowed, serverTime: result.serverTime });
};
var favouritesSince = async (db, userId, since) => {
  const rows = await db.prepare(
    `SELECT type, stream_id, name, updated_at FROM favorites
        WHERE user_id = ? AND synced_at > ? ORDER BY synced_at`
  ).bind(userId, since).all();
  return rows.results.map((row) => {
    const record = row;
    return {
      type: text(record["type"]),
      streamId: text(record["stream_id"]),
      name: maybeText(record["name"]),
      updatedAt: text(record["updated_at"])
    };
  });
};
var arrangementsSince = async (db, userId, since) => {
  const rows = await db.prepare(
    `SELECT scope, item_ids, names, updated_at FROM sort_order
        WHERE user_id = ? AND synced_at > ? ORDER BY synced_at`
  ).bind(userId, since).all();
  return rows.results.map((row) => {
    const record = row;
    return {
      scope: text(record["scope"]),
      itemIds: parseJson(record["item_ids"], []),
      names: parseJson(record["names"], {}),
      updatedAt: text(record["updated_at"])
    };
  });
};
var progressSince = async (db, userId, since) => {
  const rows = await db.prepare(
    `SELECT * FROM watch_progress WHERE user_id = ? AND synced_at > ? ORDER BY synced_at`
  ).bind(userId, since).all();
  return rows.results.map((row) => {
    const record = row;
    return {
      type: text(record["type"]),
      itemId: text(record["item_id"]),
      seriesId: maybeText(record["series_id"]),
      season: maybeNumber(record["season"]),
      episodeNum: maybeNumber(record["episode_num"]),
      name: text(record["name"]),
      episodeTitle: maybeText(record["episode_title"]),
      icon: maybeText(record["icon"]),
      containerExtension: maybeText(record["container_extension"]),
      positionSeconds: number(record["position_seconds"]),
      durationSeconds: number(record["duration_seconds"]),
      completed: number(record["completed"]) === 1,
      // Null rather than '' when nothing was ever recorded: a device merging
      // this has to tell "watched with no subtitles" from "nobody has said".
      audioLanguage: maybeText(record["audio_language"]),
      subtitleLanguage: maybeText(record["subtitle_language"]),
      audioTitle: maybeText(record["audio_title"]),
      subtitleTitle: maybeText(record["subtitle_title"]),
      subtitlesEnabled: record["subtitles_enabled"] === null || record["subtitles_enabled"] === void 0 ? null : number(record["subtitles_enabled"]) === 1,
      updatedAt: text(record["updated_at"])
    };
  });
};
var settingsSince = async (db, userId, since) => {
  const rows = await db.prepare(
    `SELECT key, value, updated_at FROM user_settings
        WHERE user_id = ? AND synced_at > ? ORDER BY synced_at`
  ).bind(userId, since).all();
  return rows.results.map((row) => {
    const record = row;
    return {
      key: text(record["key"]),
      value: text(record["value"]),
      updatedAt: text(record["updated_at"])
    };
  });
};
var guideSourcesSince = async (db, userId, since) => {
  const rows = await db.prepare(
    `SELECT id, payload, updated_at FROM guide_sources
        WHERE user_id = ? AND synced_at > ? ORDER BY synced_at`
  ).bind(userId, since).all();
  return rows.results.map((row) => {
    const record = row;
    return {
      id: text(record["id"]),
      payload: text(record["payload"]),
      updatedAt: text(record["updated_at"])
    };
  });
};
var channelMappingsSince = async (db, userId, since) => {
  const rows = await db.prepare(
    `SELECT stream_id, source_id, channel_id, updated_at FROM channel_mappings
        WHERE user_id = ? AND synced_at > ? ORDER BY synced_at`
  ).bind(userId, since).all();
  return rows.results.map((row) => {
    const record = row;
    return {
      streamId: text(record["stream_id"]),
      sourceId: text(record["source_id"]),
      channelId: text(record["channel_id"]),
      updatedAt: text(record["updated_at"])
    };
  });
};
var deletionsSince = async (db, userId, since) => {
  const rows = await db.prepare(
    `SELECT kind, item_key, deleted_at FROM sync_tombstones
        WHERE user_id = ? AND synced_at > ? ORDER BY synced_at`
  ).bind(userId, since).all();
  return rows.results.map((row) => {
    const record = row;
    return {
      kind: text(record["kind"]),
      key: text(record["item_key"]),
      deletedAt: text(record["deleted_at"])
    };
  });
};
var emptyLists = () => ({
  favourites: [],
  arrangements: [],
  progress: [],
  settings: [],
  guideSources: [],
  channelMappings: [],
  deletions: []
});
var pushChanges = async (request, env, userId, allowed2 = null, charge, lockRefused = false) => {
  const received = await readJson(request);
  if (lockRefused && touchesLock(received) && await loosensLock(env.DB, userId, received)) {
    throw new HttpError("A tool cannot loosen the parental lock; ask the app (pin-off)", 403);
  }
  refuseOversized(received);
  await refuseNewSettingsOverLimit(env.DB, userId, (received.settings ?? []).map((setting) => setting?.key));
  for (const field of [
    "favourites",
    "arrangements",
    "progress",
    "settings",
    "guideSources",
    "channelMappings",
    "deletions"
  ]) {
    const value = received[field];
    if (value !== void 0 && !Array.isArray(value)) {
      throw new HttpError(`${field} must be an array`, 400);
    }
  }
  const total = countChanges(received);
  if (total > MAX_CHANGES_PER_PUSH) {
    throw new HttpError(
      `A push may carry at most ${MAX_CHANGES_PER_PUSH} changes; this one had ${total}. Send it in pieces.`,
      413
    );
  }
  await charge?.(total);
  const at = now();
  const { batch, dropped } = onlyKinds(noLaterThan(received, at), allowed2);
  const db = env.DB;
  const stored = await readStored(db, userId, batch, at);
  const statements = [];
  let applied = 0;
  let superseded = dropped;
  const count = (accepted) => accepted ? applied += 1 : superseded += 1;
  for (const deletion of batch.deletions ?? []) {
    count(planDeletion(db, userId, deletion, stored, at, statements));
  }
  for (const favourite of batch.favourites ?? []) {
    count(planFavourite(db, userId, favourite, stored, at, statements));
  }
  for (const arrangement of batch.arrangements ?? []) {
    count(planArrangement(db, userId, arrangement, stored, at, statements));
  }
  for (const entry of batch.progress ?? []) {
    count(planProgress(db, userId, entry, stored, at, statements));
  }
  for (const setting of batch.settings ?? []) {
    count(planSetting(db, userId, setting, stored, at, statements));
  }
  for (const source of batch.guideSources ?? []) {
    count(planGuideSource(db, userId, source, stored, at, statements));
  }
  for (const mapping of batch.channelMappings ?? []) {
    count(planChannelMapping(db, userId, mapping, stored, at, statements));
  }
  if (statements.length) {
    await db.batch(statements);
  }
  return ok({ applied, superseded, serverTime: cursorNow() });
};
var readStored = async (db, userId, batch, at) => {
  const timestamps = async (wanted, query, column, key) => {
    if (!wanted) {
      return /* @__PURE__ */ new Map();
    }
    const rows = await db.prepare(query).bind(userId).all();
    return new Map(
      rows.results.map((row) => {
        const record = row;
        const stamp = text(record[column]);
        return [key(record), stamp > at ? "" : stamp];
      })
    );
  };
  const [favourites, arrangements, progress, settings, guideSources, channelMappings, tombstones] = await Promise.all([
    timestamps(
      !!batch.favourites?.length,
      "SELECT type, stream_id, updated_at FROM favorites WHERE user_id = ?",
      "updated_at",
      (row) => favouriteKey(text(row["type"]), text(row["stream_id"]))
    ),
    timestamps(
      !!batch.arrangements?.length,
      "SELECT scope, updated_at FROM sort_order WHERE user_id = ?",
      "updated_at",
      (row) => text(row["scope"])
    ),
    timestamps(
      !!batch.progress?.length,
      "SELECT type, item_id, updated_at FROM watch_progress WHERE user_id = ?",
      "updated_at",
      (row) => progressKey(text(row["type"]), text(row["item_id"]))
    ),
    timestamps(
      !!batch.settings?.length,
      "SELECT key, updated_at FROM user_settings WHERE user_id = ?",
      "updated_at",
      (row) => text(row["key"])
    ),
    timestamps(
      !!batch.guideSources?.length,
      "SELECT id, updated_at FROM guide_sources WHERE user_id = ?",
      "updated_at",
      (row) => text(row["id"])
    ),
    timestamps(
      !!batch.channelMappings?.length,
      "SELECT stream_id, updated_at FROM channel_mappings WHERE user_id = ?",
      "updated_at",
      (row) => text(row["stream_id"])
    ),
    timestamps(
      !!batch.deletions?.length || !!batch.favourites?.length || !!batch.guideSources?.length || !!batch.channelMappings?.length,
      "SELECT kind, item_key, deleted_at FROM sync_tombstones WHERE user_id = ?",
      "deleted_at",
      (row) => `${text(row["kind"])} ${text(row["item_key"])}`
    )
  ]);
  return {
    favourites,
    arrangements,
    progress,
    settings,
    guideSources,
    channelMappings,
    tombstones
  };
};
var planFavourite = (db, userId, change, stored, at, statements) => {
  const key = favouriteKey(change.type, String(change.streamId));
  const removed = stored.tombstones.get(`favourite ${key}`);
  if (removed && removed >= change.updatedAt) {
    return false;
  }
  if (!isNewer(change.updatedAt, stored.favourites.get(key))) {
    return false;
  }
  statements.push(
    db.prepare(
      `INSERT INTO favorites (user_id, type, stream_id, name, updated_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, type, stream_id) DO UPDATE SET
           name = excluded.name,
           updated_at = excluded.updated_at,
           synced_at = excluded.synced_at`
    ).bind(userId, change.type, String(change.streamId), change.name ?? null, change.updatedAt, at)
  );
  clearTombstone(db, userId, "favourite", key, stored, statements);
  return true;
};
var planArrangement = (db, userId, change, stored, at, statements) => {
  if (!isNewer(change.updatedAt, stored.arrangements.get(change.scope))) {
    return false;
  }
  statements.push(
    db.prepare(
      `INSERT INTO sort_order (user_id, scope, item_ids, names, updated_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, scope) DO UPDATE SET
           item_ids = excluded.item_ids,
           names = excluded.names,
           updated_at = excluded.updated_at,
           synced_at = excluded.synced_at`
    ).bind(
      userId,
      change.scope,
      JSON.stringify((change.itemIds ?? []).map(String)),
      JSON.stringify(change.names ?? {}),
      change.updatedAt,
      at
    )
  );
  clearTombstone(db, userId, "arrangement", change.scope, stored, statements);
  return true;
};
var planProgress = (db, userId, change, stored, at, statements) => {
  const key = progressKey(change.type, String(change.itemId));
  if (!isNewer(change.updatedAt, stored.progress.get(key))) {
    return false;
  }
  statements.push(
    db.prepare(
      `INSERT INTO watch_progress (
           user_id, type, item_id, series_id, season, episode_num, name, episode_title,
           icon, container_extension, position_seconds, duration_seconds, completed,
           audio_language, subtitle_language, audio_title, subtitle_title, subtitles_enabled,
           updated_at, synced_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, type, item_id) DO UPDATE SET
           series_id = excluded.series_id,
           season = excluded.season,
           episode_num = excluded.episode_num,
           name = excluded.name,
           episode_title = excluded.episode_title,
           icon = excluded.icon,
           container_extension = excluded.container_extension,
           position_seconds = excluded.position_seconds,
           duration_seconds = excluded.duration_seconds,
           completed = excluded.completed,
           -- Kept when the arriving change says nothing. A device whose player
           -- cannot report its tracks still sends progress, and it must not
           -- wipe what another device remembered about this film.
           audio_language = COALESCE(excluded.audio_language, watch_progress.audio_language),
           subtitle_language = COALESCE(excluded.subtitle_language, watch_progress.subtitle_language),
           audio_title = COALESCE(excluded.audio_title, watch_progress.audio_title),
           subtitle_title = COALESCE(excluded.subtitle_title, watch_progress.subtitle_title),
           subtitles_enabled = COALESCE(excluded.subtitles_enabled, watch_progress.subtitles_enabled),
           updated_at = excluded.updated_at,
           synced_at = excluded.synced_at`
    ).bind(
      userId,
      change.type,
      String(change.itemId),
      change.seriesId ?? null,
      change.season ?? null,
      change.episodeNum ?? null,
      change.name || "Unknown",
      change.episodeTitle ?? null,
      change.icon ?? null,
      change.containerExtension ?? null,
      Number(change.positionSeconds) || 0,
      Number(change.durationSeconds) || 0,
      change.completed ? 1 : 0,
      change.audioLanguage ?? null,
      change.subtitleLanguage ?? null,
      change.audioTitle ?? null,
      change.subtitleTitle ?? null,
      change.subtitlesEnabled === null || change.subtitlesEnabled === void 0 ? null : change.subtitlesEnabled ? 1 : 0,
      change.updatedAt,
      at
    )
  );
  clearTombstone(db, userId, "progress", key, stored, statements);
  return true;
};
var planSetting = (db, userId, change, stored, at, statements) => {
  if (!isNewer(change.updatedAt, stored.settings.get(change.key))) {
    return false;
  }
  statements.push(
    db.prepare(
      `INSERT INTO user_settings (user_id, key, value, updated_at, synced_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at,
           synced_at = excluded.synced_at`
    ).bind(userId, change.key, change.value, change.updatedAt, at)
  );
  return true;
};
var planGuideSource = (db, userId, change, stored, at, statements) => {
  if (!change.id || typeof change.payload !== "string" || !change.payload) {
    return false;
  }
  const removed = stored.tombstones.get(`guideSource ${change.id}`);
  if (removed && removed >= change.updatedAt) {
    return false;
  }
  if (!isNewer(change.updatedAt, stored.guideSources.get(change.id))) {
    return false;
  }
  statements.push(
    db.prepare(
      `INSERT INTO guide_sources (user_id, id, payload, updated_at, synced_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, id) DO UPDATE SET
           payload = excluded.payload,
           updated_at = excluded.updated_at,
           synced_at = excluded.synced_at`
    ).bind(userId, change.id, change.payload, change.updatedAt, at)
  );
  clearTombstone(db, userId, "guideSource", change.id, stored, statements);
  return true;
};
var planChannelMapping = (db, userId, change, stored, at, statements) => {
  const streamId = String(change.streamId ?? "");
  if (!streamId || !change.sourceId || !change.channelId) {
    return false;
  }
  const removed = stored.tombstones.get(`channelMapping ${streamId}`);
  if (removed && removed >= change.updatedAt) {
    return false;
  }
  if (!isNewer(change.updatedAt, stored.channelMappings.get(streamId))) {
    return false;
  }
  statements.push(
    db.prepare(
      `INSERT INTO channel_mappings (user_id, stream_id, source_id, channel_id, updated_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, stream_id) DO UPDATE SET
           source_id = excluded.source_id,
           channel_id = excluded.channel_id,
           updated_at = excluded.updated_at,
           synced_at = excluded.synced_at`
    ).bind(userId, streamId, change.sourceId, change.channelId, change.updatedAt, at)
  );
  clearTombstone(db, userId, "channelMapping", streamId, stored, statements);
  return true;
};
var planDeletion = (db, userId, tombstone, stored, at, statements) => {
  if (!CHANGE_KINDS.includes(tombstone.kind)) {
    return false;
  }
  const buried = stored.tombstones.get(`${tombstone.kind} ${tombstone.key}`);
  if (buried && buried >= tombstone.deletedAt) {
    return false;
  }
  statements.push(
    db.prepare(
      `INSERT INTO sync_tombstones (user_id, kind, item_key, deleted_at, synced_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, kind, item_key) DO UPDATE SET
           deleted_at = MAX(sync_tombstones.deleted_at, excluded.deleted_at),
           synced_at = excluded.synced_at`
    ).bind(userId, tombstone.kind, tombstone.key, tombstone.deletedAt, at)
  );
  stored.tombstones.set(`${tombstone.kind} ${tombstone.key}`, tombstone.deletedAt);
  planRowRemoval(db, userId, tombstone, at, statements);
  return true;
};
var planRowRemoval = (db, userId, tombstone, at, statements) => {
  const { kind, key, deletedAt } = tombstone;
  if (kind === "arrangement") {
    statements.push(
      db.prepare("DELETE FROM sort_order WHERE user_id = ? AND scope = ? AND (updated_at <= ? OR updated_at > ?)").bind(userId, key, deletedAt, at)
    );
    return;
  }
  if (kind === "setting") {
    statements.push(
      db.prepare("DELETE FROM user_settings WHERE user_id = ? AND key = ? AND (updated_at <= ? OR updated_at > ?)").bind(userId, key, deletedAt, at)
    );
    return;
  }
  if (kind === "guideSource") {
    statements.push(
      db.prepare("DELETE FROM guide_sources WHERE user_id = ? AND id = ? AND (updated_at <= ? OR updated_at > ?)").bind(userId, key, deletedAt, at)
    );
    return;
  }
  if (kind === "channelMapping") {
    statements.push(
      db.prepare(
        "DELETE FROM channel_mappings WHERE user_id = ? AND stream_id = ? AND (updated_at <= ? OR updated_at > ?)"
      ).bind(userId, key, deletedAt, at)
    );
    return;
  }
  const [type, id] = splitKey(key);
  if (!type || !id) {
    return;
  }
  if (kind === "favourite") {
    statements.push(
      db.prepare(
        "DELETE FROM favorites WHERE user_id = ? AND type = ? AND stream_id = ? AND (updated_at IS NULL OR updated_at <= ? OR updated_at > ?)"
      ).bind(userId, type, id, deletedAt, at)
    );
  } else if (kind === "progress") {
    statements.push(
      db.prepare(
        "DELETE FROM watch_progress WHERE user_id = ? AND type = ? AND item_id = ? AND (updated_at <= ? OR updated_at > ?)"
      ).bind(userId, type, id, deletedAt, at)
    );
  }
};
var clearTombstone = (db, userId, kind, key, stored, statements) => {
  if (!stored.tombstones.has(`${kind} ${key}`)) {
    return;
  }
  statements.push(
    db.prepare("DELETE FROM sync_tombstones WHERE user_id = ? AND kind = ? AND item_key = ?").bind(userId, kind, key)
  );
  stored.tombstones.delete(`${kind} ${key}`);
};
var getSettings = async (env, userId) => {
  const rows = await env.DB.prepare("SELECT key, value FROM user_settings WHERE user_id = ?").bind(userId).all();
  const settings = {};
  for (const row of rows.results) {
    const record = row;
    settings[text(record["key"])] = text(record["value"]);
  }
  return ok(settings);
};
var loosensLock = async (db, userId, batch) => {
  if ((batch.deletions ?? []).some((deletion) => deletion?.kind === "setting" && LOCK_SETTINGS.includes(deletion.key))) {
    return true;
  }
  const changed = (batch.settings ?? []).filter((setting) => LOCK_SETTINGS.includes(setting?.key));
  if (changed.some((setting) => setting.key === "parentalLock")) {
    return true;
  }
  const rows = await db.prepare("SELECT key, value FROM user_settings WHERE user_id = ? AND key IN ('lockedCategories', 'ageLock')").bind(userId).all();
  const stored = new Map((rows.results ?? []).map((row) => [row.key, row.value]));
  for (const setting of changed) {
    if (setting.key === "lockedCategories") {
      const before = readCategorySets(stored.get("lockedCategories"));
      const after = readCategorySets(setting.value);
      for (const type of Object.keys(before)) {
        if (before[type].some((id) => !after[type].includes(id))) {
          return true;
        }
      }
    }
    if (setting.key === "ageLock" && loosens(readAgeLock(stored.get("ageLock")), readAgeLock(setting.value))) {
      return true;
    }
  }
  return false;
};
var MAX_CHANGE_CHARS = 256 * 1024;
var MAX_SETTING_KEY_CHARS = 100;
var MAX_SETTINGS_PER_ACCOUNT = 400;
var refuseOversized = (batch) => {
  for (const list of Object.values(batch)) {
    for (const entry of Array.isArray(list) ? list : []) {
      if (JSON.stringify(entry ?? null).length > MAX_CHANGE_CHARS) {
        throw new HttpError("One of these changes is larger than this service keeps", 413);
      }
    }
  }
  for (const setting of batch.settings ?? []) {
    if (typeof setting?.key === "string" && setting.key.length > MAX_SETTING_KEY_CHARS) {
      throw new HttpError("A setting name is longer than this service keeps", 413);
    }
  }
};
var refuseNewSettingsOverLimit = async (db, userId, keys) => {
  const named = [...new Set(keys.filter((key) => typeof key === "string"))];
  if (!named.length) {
    return;
  }
  const held = await db.prepare("SELECT COUNT(*) AS n FROM user_settings WHERE user_id = ?").bind(userId).first();
  const known = await db.prepare(`SELECT COUNT(*) AS n FROM user_settings WHERE user_id = ? AND key IN (${named.map(() => "?").join(",")})`).bind(userId, ...named).first();
  if (Number(held?.n) + (named.length - Number(known?.n)) > MAX_SETTINGS_PER_ACCOUNT) {
    throw new HttpError("This account has as many settings as this service keeps", 413);
  }
};
var saveSettings = async (request, env, userId) => {
  const settings = await readJson(request);
  const offending = Object.entries(settings).find(([, value]) => typeof value !== "string");
  if (offending) {
    throw new HttpError(`Setting "${offending[0]}" must be a string`, 400);
  }
  const entries = Object.entries(settings);
  if (entries.length > MAX_CHANGES_PER_PUSH) {
    throw new HttpError(
      `At most ${MAX_CHANGES_PER_PUSH} settings may be saved at once; this had ${entries.length}.`,
      413
    );
  }
  refuseOversized({ settings: entries.map(([key, value]) => ({ key, value, updatedAt: "" })) });
  await refuseNewSettingsOverLimit(env.DB, userId, entries.map(([key]) => key));
  const at = now();
  const statements = entries.map(
    ([key, value]) => env.DB.prepare(
      `INSERT INTO user_settings (user_id, key, value, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at,
         synced_at = excluded.synced_at`
    ).bind(userId, key, value, at, at)
  );
  if (statements.length) {
    await env.DB.batch(statements);
  }
  return getSettings(env, userId);
};

// src/family.ts
var USERNAME_PATTERN2 = /^[a-z0-9._-]{3,32}$/i;
var fold2 = (username) => username.trim().toLowerCase();
var MOST_KEYS_PER_CALL = 20;
var ancestorsOf = async (db, userId) => {
  const { results } = await db.prepare(
    `WITH RECURSIVE up(id, manager_id, depth) AS (
         SELECT id, manager_id, 0 FROM users WHERE id = ?
         UNION ALL
         SELECT users.id, users.manager_id, up.depth + 1
           FROM users JOIN up ON users.id = up.manager_id
          WHERE up.depth < 32
       )
       SELECT id FROM up WHERE depth > 0 ORDER BY depth`
  ).bind(userId).all();
  return results.map((row) => number(row.id));
};
var descendantsOf = async (db, userId) => {
  const { results } = await db.prepare(
    `WITH RECURSIVE down(id, depth) AS (
         SELECT id, 1 FROM users WHERE manager_id = ?
         UNION ALL
         SELECT users.id, down.depth + 1 FROM users JOIN down ON users.manager_id = down.id
          WHERE down.depth < 32
       )
       SELECT id FROM down`
  ).bind(userId).all();
  return results.map((row) => number(row.id));
};
var requireManagerOf = async (db, caller, memberId) => {
  if (!Number.isInteger(memberId) || memberId === caller.userId) {
    throw new HttpError("No such account in your family", 404);
  }
  const above = await ancestorsOf(db, memberId);
  if (!above.includes(caller.userId)) {
    throw new HttpError("No such account in your family", 404);
  }
};
var requireOwnSession = (caller) => {
  if (caller.scope !== "full" && !isToolScope(caller.scope)) {
    throw new HttpError("Setting somebody up does not include their family", 403);
  }
};
var requireSignedInItself = (caller) => {
  requireOwnSession(caller);
  if (caller.mintedBy) {
    throw new HttpError("Only the account itself can leave or join a family", 403);
  }
};
var requireAdmin = (caller) => {
  requireOwnSession(caller);
  if (caller.role !== "admin") {
    throw new HttpError("Only an admin can add or change accounts in a family", 403);
  }
};
var getFamily = async (env, caller) => {
  requireOwnSession(caller);
  const db = env.DB;
  const me2 = await db.prepare(
    `SELECT users.id, users.username, users.role, users.manager_id, users.household, users.picture,
              account_keys.public_key, account_keys.sealed_private_key
         FROM users LEFT JOIN account_keys ON account_keys.user_id = users.id
        WHERE users.id = ?`
  ).bind(caller.userId).first();
  if (!me2) {
    throw new HttpError("No such account", 404);
  }
  const managerIds = await ancestorsOf(db, caller.userId);
  const managers = [];
  if (managerIds.length) {
    const { results } = await db.prepare(
      `SELECT users.id, users.username, account_keys.public_key,
                EXISTS (SELECT 1 FROM managed_keys
                         WHERE managed_keys.member_id = ? AND managed_keys.manager_id = users.id) AS holds
           FROM users LEFT JOIN account_keys ON account_keys.user_id = users.id
          WHERE users.id IN (${managerIds.map(() => "?").join(",")})`
    ).bind(caller.userId, ...managerIds).all();
    const byId = new Map(results.map((row) => [number(row["id"]), row]));
    for (const id of managerIds) {
      const row = byId.get(id);
      if (row) {
        managers.push({
          id,
          username: text(row["username"]),
          publicKey: maybeText(row["public_key"]),
          holdsMyKey: number(row["holds"]) === 1
        });
      }
    }
  }
  const members = [];
  if (me2["role"] === "admin") {
    const { results } = await db.prepare(
      `WITH RECURSIVE down(id, depth) AS (
           SELECT id, 1 FROM users WHERE manager_id = ?
           UNION ALL
           SELECT users.id, down.depth + 1 FROM users JOIN down ON users.manager_id = down.id
            WHERE down.depth < 32
         )
         SELECT users.id, users.username, users.role, users.manager_id, users.household, users.picture, users.created_at,
                account_keys.public_key,
                (SELECT sealed_enc FROM managed_keys
                  WHERE managed_keys.member_id = users.id AND managed_keys.manager_id = ?) AS sealed_enc,
                (SELECT MAX(last_used_at) FROM sessions
                  WHERE sessions.user_id = users.id AND sessions.scope = 'full') AS last_used_at,
                (SELECT COUNT(*) FROM sessions
                  WHERE sessions.user_id = users.id AND sessions.scope = 'full') AS devices
           FROM down JOIN users ON users.id = down.id
           LEFT JOIN account_keys ON account_keys.user_id = users.id
          ORDER BY down.depth, users.username_folded`
    ).bind(caller.userId, caller.userId).all();
    for (const row of results) {
      members.push({
        id: number(row["id"]),
        username: text(row["username"]),
        role: isFamilyRole(row["role"]) ? row["role"] : "kid",
        managerId: number(row["manager_id"]),
        household: number(row["household"]) === 1,
        picture: maybeText(row["picture"]),
        createdAt: text(row["created_at"]),
        lastUsedAt: maybeText(row["last_used_at"]),
        devices: number(row["devices"]),
        publicKey: maybeText(row["public_key"]),
        sealedEnc: maybeText(row["sealed_enc"])
      });
    }
  }
  const view = {
    me: {
      id: caller.userId,
      username: text(me2["username"]),
      role: isFamilyRole(me2["role"]) ? me2["role"] : "kid",
      managerId: me2["manager_id"] === null ? null : number(me2["manager_id"]),
      household: number(me2["household"]) === 1,
      picture: maybeText(me2["picture"]),
      publicKey: maybeText(me2["public_key"]),
      sealedPrivateKey: maybeText(me2["sealed_private_key"])
    },
    managers,
    members
  };
  return ok(view);
};
var isPublicKey = (value) => typeof value === "string" && fromBase64(value)?.length === 65;
var isSealedText = (value, prefix) => typeof value === "string" && value.startsWith(prefix) && value.length < 4096;
var saveOwnKey = async (request, env, caller) => {
  requireOwnSession(caller);
  const body = await readJson(request);
  if (!isPublicKey(body.publicKey) || !isSealedText(body.sealedPrivateKey, "sb1$")) {
    throw new HttpError("A public key and a sealed private key are required", 400);
  }
  await writeKeyPair(env.DB, caller.userId, body.publicKey, body.sealedPrivateKey);
  return ok({ saved: true });
};
var writeKeyPair = async (db, userId, publicKey, sealedPrivateKey) => {
  const existing = await db.prepare("SELECT public_key FROM account_keys WHERE user_id = ?").bind(userId).first();
  const statements = [
    db.prepare(
      `INSERT INTO account_keys (user_id, public_key, sealed_private_key, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           public_key = excluded.public_key,
           sealed_private_key = excluded.sealed_private_key,
           updated_at = excluded.updated_at`
    ).bind(userId, publicKey, sealedPrivateKey, now())
  ];
  if (existing && existing.public_key !== publicKey) {
    statements.push(db.prepare("DELETE FROM managed_keys WHERE manager_id = ?").bind(userId));
  }
  await db.batch(statements);
};
var managedKeyStatements = async (db, caller, keys) => {
  if (!Array.isArray(keys) || keys.length > MOST_KEYS_PER_CALL) {
    throw new HttpError(`Between 0 and ${MOST_KEYS_PER_CALL} keys at a time`, 400);
  }
  const above = /* @__PURE__ */ new Map();
  const statements = [];
  const at = now();
  for (const entry of keys) {
    const memberId = Number(entry?.memberId);
    const managerId = Number(entry?.managerId);
    if (!Number.isInteger(memberId) || !Number.isInteger(managerId) || !isSealedText(entry?.sealedEnc, "pk1$")) {
      throw new HttpError("Each key needs a member, a manager and a sealed key", 400);
    }
    if (!above.has(memberId)) {
      above.set(memberId, await ancestorsOf(db, memberId));
    }
    const managers = above.get(memberId) ?? [];
    if (memberId !== caller.userId && !managers.includes(caller.userId)) {
      throw new HttpError("No such account in your family", 404);
    }
    if (!managers.includes(managerId)) {
      throw new HttpError("That account does not manage this one", 400);
    }
    statements.push(
      db.prepare(
        `INSERT INTO managed_keys (member_id, manager_id, sealed_enc, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(member_id, manager_id) DO UPDATE SET
             sealed_enc = excluded.sealed_enc,
             updated_at = excluded.updated_at`
      ).bind(memberId, managerId, entry.sealedEnc, at)
    );
  }
  return statements;
};
var saveManagedKeys = async (request, env, caller) => {
  requireOwnSession(caller);
  const body = await readJson(request);
  const statements = await managedKeyStatements(env.DB, caller, body.keys);
  if (statements.length) {
    await env.DB.batch(statements);
  }
  return ok({ saved: statements.length });
};
var acceptKeys2 = (keys) => {
  const checked = checkSubmittedKeys(keys);
  if (!checked.ok) {
    throw new HttpError(checked.reason, 400);
  }
  return checked;
};
var verifierOf = async (keys) => {
  const checked = acceptKeys2(keys);
  return formatVerifier({
    kdf: "scrypt",
    params: checked.params,
    salt: checked.salt,
    verifier: await verifierFor(checked.auth, workerKdf)
  });
};
var addMember = async (request, env, caller) => {
  requireAdmin(caller);
  const body = await readJson(request);
  const username = (body.username ?? "").trim();
  if (!USERNAME_PATTERN2.test(username)) {
    throw new HttpError(
      "Username must be 3 to 32 characters, using letters, numbers, dot, dash or underscore",
      400
    );
  }
  const role = isFamilyRole(body.role) ? body.role : "member";
  if (!isPublicKey(body.publicKey) || !isSealedText(body.sealedPrivateKey, "sb1$")) {
    throw new HttpError("A public key and a sealed private key are required", 400);
  }
  const verifier = await verifierOf(body.keys);
  const at = now();
  const created = await env.DB.prepare(
    `INSERT INTO users (username, username_folded, auth_verifier, created_at, updated_at, role, manager_id, household)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(username_folded) DO NOTHING
     RETURNING id`
  ).bind(username, fold2(username), verifier, at, at, role, caller.userId, body.household === true ? 1 : 0).first();
  if (!created) {
    throw new HttpError("That username is taken", 409);
  }
  const memberId = number(created.id);
  await writeKeyPair(env.DB, memberId, body.publicKey, body.sealedPrivateKey);
  const keys = Array.isArray(body.managedKeys) ? body.managedKeys.map((entry) => ({ ...entry, memberId })) : [];
  const statements = await managedKeyStatements(env.DB, caller, keys);
  if (statements.length) {
    await env.DB.batch(statements);
  }
  return ok({ id: memberId, username, role, createdAt: at }, 201);
};
var changeMember = async (request, env, caller, memberId) => {
  requireAdmin(caller);
  await requireManagerOf(env.DB, caller, memberId);
  const body = await readJson(request);
  const sets = [];
  const values = [];
  if (body.role !== void 0) {
    if (!isFamilyRole(body.role)) {
      throw new HttpError("A role is admin, member or kid", 400);
    }
    sets.push("role = ?");
    values.push(body.role);
  }
  if (body.household !== void 0) {
    if (typeof body.household !== "boolean") {
      throw new HttpError("household is true or false", 400);
    }
    sets.push("household = ?");
    values.push(body.household ? 1 : 0);
  }
  if (body.picture !== void 0) {
    if (!isProfilePicture(body.picture)) {
      throw new HttpError("A picture is an animal, a small JPEG, PNG or WebP, or null", 400);
    }
    sets.push("picture = ?");
    values.push(body.picture);
  }
  if (!sets.length) {
    throw new HttpError("Nothing to change", 400);
  }
  await env.DB.prepare(`UPDATE users SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...values, now(), memberId).run();
  if (body.role !== void 0 && body.role !== "admin") {
    await endSessionsMintedBy(env.DB, memberId);
  }
  if (body.household === false) {
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND scope = 'full' AND minted_by IS NOT NULL").bind(memberId).run();
  }
  return ok({ changed: true });
};
var memberSession = async (request, env, caller, memberId) => {
  requireOwnSession(caller);
  if (caller.role !== "admin") {
    throw new HttpError("Only an admin can set up or switch to another account", 403);
  }
  await requireManagerOf(env.DB, caller, memberId);
  const body = await readJson(request);
  const scope = body.scope === "full" ? "full" : "setup";
  if (scope === "full" && isToolScope(caller.scope)) {
    throw new HttpError("A tool can set an account up, not sign in as it", 403);
  }
  if (scope === "full") {
    const row = await env.DB.prepare("SELECT household FROM users WHERE id = ?").bind(memberId).first();
    if (number(row?.household) !== 1) {
      throw new HttpError("Only an account in your household is a profile on your devices", 403);
    }
  }
  const token = await createSession(env.DB, memberId, scope, null, {
    userId: caller.userId,
    sessionId: caller.sessionId,
    tool: isToolScope(caller.scope)
  });
  return ok({ token, scope });
};
var resetMemberPassword = async (request, env, caller, memberId) => {
  requireAdmin(caller);
  await requireManagerOf(env.DB, caller, memberId);
  const body = await readJson(request);
  if (!isPublicKey(body.publicKey) || !isSealedText(body.sealedPrivateKey, "sb1$")) {
    throw new HttpError("A public key and a sealed private key are required", 400);
  }
  const verifier = await verifierOf(body.keys);
  const keys = Array.isArray(body.managedKeys) ? body.managedKeys.map((entry) => ({ ...entry, memberId })) : [];
  const keyStatements = await managedKeyStatements(env.DB, caller, keys);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET auth_verifier = ?, updated_at = ? WHERE id = ?").bind(verifier, now(), memberId),
    // The old enc, sealed for every manager, opens nothing any more.
    env.DB.prepare("DELETE FROM managed_keys WHERE member_id = ?").bind(memberId),
    ...keyStatements
  ]);
  await writeKeyPair(env.DB, memberId, body.publicKey, body.sealedPrivateKey);
  await destroySessionsFor(env.DB, memberId);
  return ok({ reset: true });
};
var release = async (db, memberId) => {
  const above = await ancestorsOf(db, memberId);
  const below = await descendantsOf(db, memberId);
  const affected = [memberId, ...below];
  const statements = [
    db.prepare("UPDATE users SET manager_id = NULL, role = 'admin', household = 0, updated_at = ? WHERE id = ?").bind(now(), memberId)
  ];
  if (above.length) {
    statements.push(
      db.prepare(
        `DELETE FROM managed_keys
            WHERE member_id IN (${affected.map(() => "?").join(",")})
              AND manager_id IN (${above.map(() => "?").join(",")})`
      ).bind(...affected, ...above)
    );
  }
  statements.push(
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND (scope = 'setup' OR minted_by IS NOT NULL)").bind(memberId)
  );
  await db.batch(statements);
};
var releaseMember = async (env, caller, memberId) => {
  requireAdmin(caller);
  await requireManagerOf(env.DB, caller, memberId);
  await release(env.DB, memberId);
  return ok({ released: true });
};
var leaveFamily = async (env, caller) => {
  requireSignedInItself(caller);
  if (caller.role === "kid") {
    throw new HttpError("Ask whoever set up this account", 403);
  }
  await release(env.DB, caller.userId);
  return ok({ released: true });
};
var deleteMember = async (env, caller, memberId) => {
  requireAdmin(caller);
  await requireManagerOf(env.DB, caller, memberId);
  const row = await env.DB.prepare("SELECT manager_id FROM users WHERE id = ?").bind(memberId).first();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET manager_id = ? WHERE manager_id = ?").bind(row?.manager_id ?? null, memberId),
    env.DB.prepare("DELETE FROM sessions WHERE minted_by = ?").bind(memberId),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(memberId)
  ]);
  return ok({ deleted: true });
};
var joinFamily = async (request, env, caller) => {
  requireSignedInItself(caller);
  if (caller.role === "kid") {
    throw new HttpError("Ask whoever set up this account", 403);
  }
  const body = await readJson(request);
  const typed = typeof body.invite === "string" ? body.invite.trim() : "";
  if (!typed) {
    throw new HttpError("An invite code is required", 400);
  }
  const claimed = await claimInvite(env.DB, typed);
  if (!claimed) {
    throw new HttpError("That invite code is not valid. It may have been used, cancelled or run out.", 403);
  }
  const inviter = claimed.createdBy;
  const inviterRow = await env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(inviter).first();
  if (inviterRow?.role !== "admin") {
    await releaseInvite(env.DB, claimed.id);
    throw new HttpError("That invite is not valid any more", 403);
  }
  const below = await descendantsOf(env.DB, caller.userId);
  if (inviter === caller.userId || below.includes(inviter)) {
    await releaseInvite(env.DB, claimed.id);
    throw new HttpError("That invite is from your own family", 409);
  }
  await release(env.DB, caller.userId);
  await env.DB.prepare("UPDATE users SET manager_id = ?, role = ?, updated_at = ? WHERE id = ?").bind(inviter, below.length ? "admin" : "member", now(), caller.userId).run();
  await recordInviteUse(env.DB, claimed.id, caller.userId);
  return ok({ joined: true, managerId: inviter });
};

// src/updates.ts
var NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var safeName = (name) => NAME.test(name) && !name.includes("..");
var isManifest = (name) => name.endsWith(".yml") || name.endsWith(".yaml") || name.endsWith(".json");
var contentType = (name) => {
  if (name.endsWith(".yml") || name.endsWith(".yaml")) {
    return "text/yaml; charset=utf-8";
  }
  if (name.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (name.endsWith(".apk")) {
    return "application/vnd.android.package-archive";
  }
  if (name.endsWith(".zip")) {
    return "application/zip";
  }
  return "application/octet-stream";
};
var cacheControl = (name) => isManifest(name) ? "public, max-age=60, must-revalidate" : "public, max-age=31536000, immutable";
var parseRange = (header, size) => {
  if (!header) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) {
    return null;
  }
  const [, from, to] = match;
  if (from === "" && to === "") {
    return null;
  }
  const offset = from === "" ? Math.max(0, size - Number(to)) : Number(from);
  const last = from === "" ? size - 1 : to === "" ? size - 1 : Math.min(Number(to), size - 1);
  if (offset >= size || last < offset) {
    return "unsatisfiable";
  }
  return { offset, length: last - offset + 1 };
};
var serveUpdate = async (request, env, path) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new HttpError("No such endpoint", 404);
  }
  const bucket = env.UPDATES;
  if (!bucket) {
    throw new HttpError("Updates are not configured on this service", 503);
  }
  const name = decodeURIComponent(path.slice("/updates/".length));
  if (!safeName(name)) {
    throw new HttpError("No such file", 404);
  }
  const headers = new Headers({
    "Content-Type": contentType(name),
    "Cache-Control": cacheControl(name),
    "Accept-Ranges": "bytes"
  });
  if (request.method === "HEAD") {
    const head = await bucket.head(name);
    if (!head) {
      throw new HttpError("No such file", 404);
    }
    headers.set("Content-Length", String(head.size));
    headers.set("ETag", head.httpEtag);
    return new Response(null, { status: 200, headers });
  }
  const wanted = request.headers.get("Range");
  if (wanted) {
    const head = await bucket.head(name);
    if (!head) {
      throw new HttpError("No such file", 404);
    }
    const range = parseRange(wanted, head.size);
    if (range === "unsatisfiable") {
      headers.set("Content-Range", `bytes */${head.size}`);
      return new Response(null, { status: 416, headers });
    }
    if (range) {
      const part = await bucket.get(name, { range });
      if (!part) {
        throw new HttpError("No such file", 404);
      }
      headers.set("Content-Length", String(range.length));
      headers.set(
        "Content-Range",
        `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`
      );
      headers.set("ETag", part.httpEtag);
      return new Response(part.body, { status: 206, headers });
    }
  }
  const object = await bucket.get(name);
  if (!object) {
    throw new HttpError("No such file", 404);
  }
  headers.set("Content-Length", String(object.size));
  headers.set("ETag", object.httpEtag);
  return new Response(object.body, { status: 200, headers });
};

// src/tmdb.ts
var tmdbConfig = async (env) => ok({ apiKey: env.TMDB_API_KEY?.trim() || null });

// ../shared/auth/secretBox.ts
var VERSION = "sb1";
var IV_BYTES = 12;
var utf82 = new TextEncoder();
var decoder = new TextDecoder();
var owned = (bytes) => Uint8Array.from(bytes);
var subtle = () => {
  const available = globalThis.crypto?.subtle;
  if (!available) {
    throw new Error("This build has no SubtleCrypto, so it cannot open the subscription");
  }
  return available;
};
var importKey = (key, usage) => {
  if (key.length !== 32) {
    throw new Error("A sealing key must be 32 bytes");
  }
  return subtle().importKey("raw", owned(key), "AES-GCM", false, [usage]);
};
var toBase642 = (bytes) => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};
var seal = async (plaintext, key) => {
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  const sealed = await subtle().encrypt(
    { name: "AES-GCM", iv },
    await importKey(key, "encrypt"),
    utf82.encode(plaintext)
  );
  return [VERSION, toBase642(iv), toBase642(new Uint8Array(sealed))].join("$");
};

// ../shared/auth/keyPair.ts
var VERSION2 = "pk1";
var CURVE = { name: "ECDH", namedCurve: "P-256" };
var INFO = new TextEncoder().encode("tvinto family seal v1");
var owned2 = (bytes) => Uint8Array.from(bytes);
var subtle2 = () => {
  const available = globalThis.crypto?.subtle;
  if (!available) {
    throw new Error("This build has no SubtleCrypto, so it cannot seal for another account");
  }
  return available;
};
var importPublic = (raw) => subtle2().importKey("raw", owned2(raw), CURVE, false, []);
var boxKey = async (privateKey, publicKey, ephemeral) => {
  const shared = await subtle2().deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256
  );
  const material = await subtle2().importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const bits = await subtle2().deriveBits(
    // The ephemeral public key as the salt, so two seals never share a key
    // even if HKDF's input were somehow the same.
    { name: "HKDF", hash: "SHA-256", salt: owned2(ephemeral), info: owned2(INFO) },
    material,
    256
  );
  return new Uint8Array(bits);
};
var sealFor = async (plaintext, publicKey) => {
  const recipient = fromBase64(publicKey);
  if (!recipient || recipient.length !== 65) {
    throw new Error("That is not a public key this can seal for");
  }
  const ephemeral = await subtle2().generateKey(CURVE, true, ["deriveBits"]);
  const ephemeralPublic = new Uint8Array(await subtle2().exportKey("raw", ephemeral.publicKey));
  const key = await boxKey(ephemeral.privateKey, await importPublic(recipient), ephemeralPublic);
  return `${VERSION2}$${toBase64(ephemeralPublic)}$${await seal(plaintext, key)}`;
};

// src/toolRequests.ts
var REQUEST_TTL_MS = 10 * 60 * 1e3;
var MAX_WAITING = 3;
var CONFIRM_TRIES = 5;
var CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
var CODE_LIMIT = 256 - 256 % CODE_ALPHABET.length;
var newCode = (length = 4) => {
  let code = "";
  while (code.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
      if (byte < CODE_LIMIT && code.length < length) {
        code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      }
    }
  }
  return code;
};
var encoder3 = new TextEncoder();
var hmacHex = async (secret, message) => {
  const key = await crypto.subtle.importKey("raw", encoder3.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder3.encode(message));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
var decoySecret = (env) => env.ACCOUNT_SALT_SECRET ?? "";
var makeDecoy = async (env) => {
  const until = Math.floor((Date.now() + REQUEST_TTL_MS) / 6e4).toString(16).padStart(8, "0");
  const head = randomHex(6) + until;
  const id = head + (await hmacHex(decoySecret(env), `tool-request-decoy:${head}`)).slice(0, 12);
  return { id, secret: (await hmacHex(decoySecret(env), `tool-request-decoy-secret:${id}`)).slice(0, 64) };
};
var isLiveDecoy = async (env, id, secret) => {
  if (!decoySecret(env) || id.length !== 32) {
    return false;
  }
  const head = id.slice(0, 20);
  const mark = (await hmacHex(decoySecret(env), `tool-request-decoy:${head}`)).slice(0, 12);
  if (mark !== id.slice(20)) {
    return false;
  }
  const expected = (await hmacHex(decoySecret(env), `tool-request-decoy-secret:${id}`)).slice(0, 64);
  return secret === expected && parseInt(head.slice(12), 16) * 6e4 > Date.now();
};
var randomHex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
var isPublicKey2 = (value) => typeof value === "string" && fromBase64(value)?.length === 65;
var TOOL_NAME_LIMIT2 = 60;
var toolName = (value) => {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > TOOL_NAME_LIMIT2 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new HttpError(`A tool names itself in up to ${TOOL_NAME_LIMIT2} characters`, 400);
  }
  return name;
};
var forgetExpired = (db) => db.prepare("DELETE FROM tool_requests WHERE expires_at < ?").bind(now()).run();
var createToolRequest = async (request, env) => {
  const body = await readJson(request);
  const username = typeof body.username === "string" ? body.username.trim() : "";
  if (!username) {
    throw new HttpError("Which account: a username is required", 400);
  }
  const name = toolName(body.name);
  if (!isPublicKey2(body.publicKey)) {
    throw new HttpError("A tool sends a public key to be sealed for", 400);
  }
  const db = env.DB;
  await forgetExpired(db);
  const user = await db.prepare("SELECT id FROM users WHERE username_folded = ?").bind(username.toLowerCase()).first();
  const code = newCode();
  const waiting = user ? await db.prepare("SELECT COUNT(*) AS n FROM tool_requests WHERE user_id = ? AND status = 'pending'").bind(user.id).first() : null;
  if (!user || Number(waiting?.n) >= MAX_WAITING) {
    const decoy = await makeDecoy(env);
    return ok({ id: decoy.id, code, secret: decoy.secret, expiresInMinutes: REQUEST_TTL_MS / 6e4 }, 201);
  }
  const id = randomHex(16);
  const secret = randomHex(32);
  {
    const at = now();
    await db.prepare(
      `INSERT INTO tool_requests (id, user_id, name, history, public_key, code, secret_hash, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).bind(
      id,
      user.id,
      name,
      body.history === true ? 1 : 0,
      body.publicKey,
      code,
      await hashToken(secret),
      at,
      new Date(Date.parse(at) + REQUEST_TTL_MS).toISOString()
    ).run();
  }
  return ok({ id, code, secret, expiresInMinutes: REQUEST_TTL_MS / 6e4 }, 201);
};
var pollToolRequest = async (request, env, id) => {
  const secret = request.headers.get("X-Tool-Secret") ?? "";
  const db = env.DB;
  const row = await db.prepare(
    `SELECT status, secret_hash, expires_at, sealed_enc, user_id, confirm_hash, confirm_tries, name, history, public_key
         FROM tool_requests WHERE id = ?`
  ).bind(id).first();
  if (!row && secret && await isLiveDecoy(env, id, secret)) {
    return ok({ status: "pending" });
  }
  if (!row || !secret || await hashToken(secret) !== row.secret_hash || row.expires_at < now()) {
    throw new HttpError("No such request, or it ran out", 404);
  }
  if (row.status === "pending") {
    return ok({ status: "pending" });
  }
  if (row.status === "approved") {
    const typed = (request.headers.get("X-Tool-Confirm") ?? "").trim().toUpperCase();
    if (!typed) {
      return ok({ status: "confirm" });
    }
    if (!row.confirm_hash || await hashToken(typed) !== row.confirm_hash) {
      const tries = Number(row.confirm_tries) + 1;
      if (tries >= CONFIRM_TRIES) {
        await db.prepare("DELETE FROM tool_requests WHERE id = ?").bind(id).run();
        return ok({ status: "denied" });
      }
      await db.prepare("UPDATE tool_requests SET confirm_tries = ? WHERE id = ?").bind(tries, id).run();
      return ok({ status: "confirm", wrong: true });
    }
  }
  await db.prepare("DELETE FROM tool_requests WHERE id = ?").bind(id).run();
  if (row.status !== "approved") {
    return ok({ status: "denied" });
  }
  const asked = await db.prepare("SELECT username FROM users WHERE id = ?").bind(row.user_id).first();
  const token = await createSession(db, row.user_id, row.history === 1 ? "tool-history" : "tool", row.name);
  return ok({
    status: "approved",
    sealedToken: await sealFor(token, row.public_key),
    sealedEnc: row.sealed_enc,
    username: asked?.username ?? ""
  });
};
var listToolRequests = async (env, caller) => {
  await forgetExpired(env.DB);
  const rows = await env.DB.prepare(
    "SELECT id, name, history, code, public_key, created_at FROM tool_requests WHERE user_id = ? AND status = 'pending' ORDER BY created_at"
  ).bind(caller.userId).all();
  return ok({
    requests: (rows.results ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      history: row.history === 1,
      code: row.code,
      // What the device seals the account's key for: only this tool opens it.
      publicKey: row.public_key,
      createdAt: row.created_at
    }))
  });
};
var answerToolRequest = async (request, env, caller, id) => {
  const body = await readJson(request);
  const db = env.DB;
  const row = await db.prepare("SELECT user_id, name, history, public_key, expires_at FROM tool_requests WHERE id = ? AND status = 'pending'").bind(id).first();
  if (!row || row.user_id !== caller.userId || row.expires_at < now()) {
    throw new HttpError("No such request, or it ran out", 404);
  }
  if (body.allow !== true) {
    await db.prepare("UPDATE tool_requests SET status = 'denied' WHERE id = ? AND status = 'pending'").bind(id).run();
    return ok({ allowed: false });
  }
  if (typeof body.sealedEnc !== "string" || !body.sealedEnc.startsWith("pk1$") || body.sealedEnc.length > 4096) {
    throw new HttpError("Allowing a tool hands it the account's key, sealed for it", 400);
  }
  const confirm = newCode(6);
  const result = await db.prepare(
    "UPDATE tool_requests SET status = 'approved', sealed_enc = ?, confirm_hash = ?, confirm_tries = 0 WHERE id = ? AND status = 'pending'"
  ).bind(body.sealedEnc, await hashToken(confirm), id).run();
  if ((result.meta?.changes ?? 0) === 0) {
    throw new HttpError("No such request, or it ran out", 404);
  }
  return ok({ allowed: true, confirm });
};

// src/toolActions.ts
var TOOL_ACTION_KINDS = ["add-member", "remove-member", "reset-password", "pin-off"];
var ACTION_TTL_MS = 10 * 60 * 1e3;
var MAX_WAITING2 = 5;
var randomHex2 = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
function readDetails(kind, details) {
  const given = details ?? {};
  switch (kind) {
    case "add-member": {
      const username = typeof given["username"] === "string" ? given["username"].trim() : "";
      if (!/^[\p{L}\p{N}._-]{2,40}$/u.test(username)) {
        throw new HttpError("A new member needs a username of 2 to 40 letters, digits, dots, dashes or underscores", 400);
      }
      if (!["admin", "member", "kid"].includes(given["role"])) {
        throw new HttpError("A role is admin, member or kid", 400);
      }
      return { username, role: given["role"], household: given["household"] === true };
    }
    case "remove-member":
    case "reset-password": {
      const memberId = Number(given["memberId"]);
      if (!Number.isInteger(memberId) || memberId <= 0) {
        throw new HttpError("Which member: memberId", 400);
      }
      return { memberId };
    }
    case "pin-off":
      return {};
  }
}
var createToolAction = async (request, env, caller) => {
  const body = await readJson(request);
  const kind = TOOL_ACTION_KINDS.find((candidate) => candidate === body.kind);
  if (!kind) {
    throw new HttpError(`A tool can ask for: ${TOOL_ACTION_KINDS.join(", ")}`, 400);
  }
  const details = readDetails(kind, body.details);
  const db = env.DB;
  await db.prepare("DELETE FROM tool_actions WHERE expires_at < ?").bind(now()).run();
  const waiting = await db.prepare("SELECT COUNT(*) AS n FROM tool_actions WHERE user_id = ? AND status = 'pending'").bind(caller.userId).first();
  if (Number(waiting?.n) >= MAX_WAITING2) {
    throw new HttpError("Too many requests are waiting in the app. Answer them there first.", 429);
  }
  const id = randomHex2(16);
  const at = now();
  const tool = await db.prepare("SELECT label FROM sessions WHERE substr(token_hash, 1, 16) = ?").bind(caller.sessionId).first();
  await db.prepare(
    `INSERT INTO tool_actions (id, user_id, tool_name, kind, details, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(id, caller.userId, tool?.label ?? "A tool", kind, JSON.stringify(details), at, new Date(Date.parse(at) + ACTION_TTL_MS).toISOString()).run();
  return ok({ id, expiresInMinutes: ACTION_TTL_MS / 6e4 }, 201);
};
var toolActionStatus = async (env, caller, id) => {
  const row = await env.DB.prepare("SELECT status, expires_at FROM tool_actions WHERE id = ? AND user_id = ?").bind(id, caller.userId).first();
  if (!row || row.status === "pending" && row.expires_at < now()) {
    throw new HttpError("No such request, or it ran out", 404);
  }
  return ok({ status: row.status });
};
var listToolActions = async (env, caller) => {
  await env.DB.prepare("DELETE FROM tool_actions WHERE expires_at < ?").bind(now()).run();
  const rows = await env.DB.prepare(
    "SELECT id, tool_name, kind, details, created_at FROM tool_actions WHERE user_id = ? AND status = 'pending' ORDER BY created_at"
  ).bind(caller.userId).all();
  return ok({
    actions: (rows.results ?? []).map((row) => ({
      id: row.id,
      toolName: row.tool_name,
      kind: row.kind,
      details: JSON.parse(row.details),
      createdAt: row.created_at
    }))
  });
};
var answerToolAction = async (request, env, caller, id) => {
  const body = await readJson(request);
  const result = await env.DB.prepare(
    "UPDATE tool_actions SET status = ? WHERE id = ? AND user_id = ? AND status = 'pending' AND expires_at >= ?"
  ).bind(body.done === true ? "done" : "refused", id, caller.userId, now()).run();
  if ((result.meta?.changes ?? 0) === 0) {
    throw new HttpError("No such request, or it ran out", 404);
  }
  return ok({ status: body.done === true ? "done" : "refused" });
};

// src/downloads.ts
var DESKTOP_MANIFEST = "latest.yml";
var ANDROID_MANIFEST = "android-apk.json";
var readText = async (bucket, name) => {
  const object = await bucket.get(name);
  return object && object.body ? new Response(object.body).text() : null;
};
var describe = async (bucket, found) => {
  if (!found) {
    return null;
  }
  const head = await bucket.head(found.file);
  return head ? { ...found, size: head.size, uploaded: head.uploaded } : null;
};
var desktopManifest = (text2) => {
  const version = /^version:\s*(.+)$/m.exec(text2);
  const file = /^\s*-?\s*url:\s*(.+)$/m.exec(text2);
  return version && file ? { version: version[1].trim(), file: file[1].trim() } : null;
};
var androidManifest = (text2) => {
  try {
    const parsed = JSON.parse(text2);
    return typeof parsed.version === "string" && typeof parsed.file === "string" ? { version: parsed.version, file: parsed.file } : null;
  } catch {
    return null;
  }
};
var desktop = async (bucket) => {
  const text2 = await readText(bucket, DESKTOP_MANIFEST);
  return describe(bucket, text2 ? desktopManifest(text2) : null);
};
var android = async (bucket) => {
  const text2 = await readText(bucket, ANDROID_MANIFEST);
  return describe(bucket, text2 ? androidManifest(text2) : null);
};
var RELEASES = "https://github.com/tvinto/tvinto/releases";
var FEED = `${RELEASES}/download/feed`;
var fromFeed = async (which) => {
  const response = await fetch(`${FEED}/${which === "android" ? ANDROID_MANIFEST : DESKTOP_MANIFEST}`);
  if (!response.ok) {
    return null;
  }
  const text2 = await response.text();
  const found = which === "android" ? androidManifest(text2) : desktopManifest(text2);
  return found && found.file.startsWith(`${RELEASES}/download/`) ? found.file : null;
};
var redirect = (location) => new Response(null, {
  status: 302,
  headers: {
    Location: location,
    // The same minute the manifests get. This address means "whichever is
    // current", and a cache holding it for longer would answer with a
    // version that no longer is.
    "Cache-Control": "public, max-age=60, must-revalidate"
  }
});
var MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];
var on = (date) => `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
var megabytes = (bytes) => `${(bytes / 1048576).toFixed(0)} MB`;
var escape = (text2) => text2.replace(/[&<>"]/g, (character) => {
  switch (character) {
    case "&":
      return "&amp;";
    case "<":
      return "&lt;";
    case ">":
      return "&gt;";
    default:
      return "&quot;";
  }
});
var card = (title, short, download, note, missing) => {
  if (!download) {
    return `    <section class="card missing">
      <h2>${escape(title)}</h2>
      <p>${escape(missing)}</p>
    </section>`;
  }
  return `    <section class="card">
      <h2>${escape(title)}</h2>
      <p class="what">Version ${escape(download.version)} &middot; ${megabytes(download.size)} &middot; ${on(download.uploaded)}</p>
      <p><a class="get" href="/updates/${encodeURIComponent(download.file)}">Download</a></p>
      <p class="note">${escape(note)}</p>
      <p class="short">Or type <code>${escape(short)}</code></p>
    </section>`;
};
var page = (host, apk, exe) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Download the Xtream app for Android phones, tablets and TV, or the Windows installer.">
<title>Xtream &mdash; downloads</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 2.5rem 1.25rem 4rem;
    background: #14161a; color: #e8eaed;
    font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 34rem; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  .lede { margin: 0 0 2rem; color: #9aa0a6; }
  .card {
    background: #1e2126; border: 1px solid #2c3037; border-radius: .6rem;
    padding: 1.25rem 1.25rem 1rem; margin-bottom: 1.25rem;
  }
  .card.missing { color: #9aa0a6; }
  h2 { font-size: 1.1rem; margin: 0 0 .35rem; }
  p { margin: .35rem 0; }
  .what { color: #9aa0a6; font-size: .95rem; }
  .get {
    display: inline-block; margin: .6rem 0 .4rem; padding: .6rem 1.4rem;
    /* #2563eb, not #3b82f6: white on that measured 3.68:1 where AA wants 4.5.
       This is 5.17. Checked, not chosen by eye. */
    background: #2563eb; color: #fff; text-decoration: none;
    border-radius: .4rem; font-weight: 600;
  }
  .get:focus { outline: 3px solid #93c5fd; outline-offset: 2px; }
  .note, .short { color: #9aa0a6; font-size: .9rem; }
  code { background: #14161a; padding: .1rem .35rem; border-radius: .25rem; }
  /* #868b91 rather than #6b7075, which was 3.62:1 against this background. */
  footer { color: #868b91; font-size: .85rem; margin-top: 2rem; }
</style>
</head>
<body>
<main>
  <h1>Xtream</h1>
  <p class="lede">Install once. Both apps update themselves after that.</p>
${card(
  "Android phone, tablet and TV",
  `${host}/a`,
  apk,
  // The second sentence from a user's Xiaomi TV box (22 October): it never
  // asked, and said "There was a problem parsing the package" instead.
  'Allow installing from unknown sources when the phone asks. On a television, the Downloader app fetches the address below; first allow it in Settings \u2192 Device Preferences \u2192 Security & restrictions \u2192 Unknown sources \u2192 Downloader. Some TV boxes never ask, and say "There was a problem parsing the package" instead.',
  "No APK has been published yet."
)}
${card(
  "Windows",
  `${host}/w`,
  exe,
  "Windows will warn about an unknown publisher, because this installer is not signed. More info, then Run anyway.",
  "No Windows installer has been published yet."
)}
  <footer>Both apps look for new versions by themselves, so this page is only for the first install &mdash; or for a device that has been wiped.</footer>
</main>
</body>
</html>
`;
var downloadsPage = async (request, env) => {
  const bucket = env.UPDATES;
  if (!bucket) {
    return redirect(`${RELEASES}/latest`);
  }
  const [apk, exe] = await Promise.all([android(bucket), desktop(bucket)]);
  const host = new URL(request.url).host;
  return new Response(page(host, apk, exe), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60, must-revalidate"
    }
  });
};
var latestDownload = async (env, which) => {
  const bucket = env.UPDATES;
  const found = bucket ? await (which === "android" ? android(bucket) : desktop(bucket)).then(
    (download) => download ? `/updates/${encodeURIComponent(download.file)}` : null
  ) : await fromFeed(which);
  if (!found) {
    throw new HttpError("Nothing has been published for that yet", 404);
  }
  return redirect(found);
};

// ../shared/subtitles.ts
var MAX_SUBTITLE_BYTES = 512 * 1024;
var MAX_SUBTITLES_PER_ACCOUNT = 200;
var MAX_SUBTITLES_PER_ITEM = 10;
var MAX_SUBTITLE_OFFSET_MS = 6e4;
var isWebVtt = (text2) => /^﻿?WEBVTT(?:[ \t]|\r?\n|$)/.test(text2);

// src/subtitles.ts
var SUBTITLE_ROUTE = /^(GET|POST|DELETE) \/api\/subtitles\/([A-Za-z0-9-]{8,64})$/;
var COLUMNS = `id, type, item_id, series_id, season, episode_num, name, language, release,
  file_id, hearing_impaired, offset_ms, created_at, updated_at`;
var subtitlesConfig = async (env) => ok({ apiKey: env.OPENSUBTITLES_API_KEY?.trim() || null });
var getSubtitleAccount = async (env, userId) => {
  const row = await env.DB.prepare("SELECT payload, updated_at FROM subtitle_accounts WHERE user_id = ?").bind(userId).first();
  return ok(row ? { payload: text(row["payload"]), updatedAt: text(row["updated_at"]) } : null);
};
var saveSubtitleAccount = async (request, env, userId) => {
  const { payload } = await readJson(request);
  if (typeof payload !== "string" || !/^sb1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(payload) || payload.length > 4096) {
    throw new HttpError("A sealed payload is required", 400);
  }
  const at = now();
  await env.DB.prepare(
    `INSERT INTO subtitle_accounts (user_id, payload, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
  ).bind(userId, payload, at).run();
  return ok({ payload, updatedAt: at });
};
var forgetSubtitleAccount = async (env, userId) => {
  await env.DB.prepare("DELETE FROM subtitle_accounts WHERE user_id = ?").bind(userId).run();
  return ok(null);
};
var listSubtitles = async (request, env, userId) => {
  const query = new URL(request.url).searchParams;
  const type = query.get("type");
  const itemId = query.get("itemId");
  if (type === null !== (itemId === null)) {
    throw new HttpError("type and itemId go together", 400);
  }
  const rows = type === null ? await env.DB.prepare(
    `SELECT ${COLUMNS} FROM subtitles WHERE user_id = ? ORDER BY updated_at DESC`
  ).bind(userId).all() : await env.DB.prepare(
    `SELECT ${COLUMNS} FROM subtitles WHERE user_id = ? AND type = ? AND item_id = ?
            ORDER BY updated_at DESC`
  ).bind(userId, itemType(type), itemId).all();
  return ok(rows.results.map((row) => toSubtitle(row)));
};
var getSubtitle = async (env, userId, id) => {
  const row = await env.DB.prepare(`SELECT ${COLUMNS}, body FROM subtitles WHERE user_id = ? AND id = ?`).bind(userId, id).first();
  if (!row) {
    throw new HttpError("No such subtitle", 404);
  }
  const withText = { ...toSubtitle(row), text: text(row["body"]) };
  return ok(withText);
};
var addSubtitle = async (request, env, userId) => {
  const input = validNew(await readJson(request));
  const counts = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN type = ? AND item_id = ? THEN 1 ELSE 0 END) AS for_item,
       MAX(CASE WHEN type = ? AND item_id = ? AND file_id = ? THEN id END) AS existing
     FROM subtitles WHERE user_id = ?`
  ).bind(input.type, input.itemId, input.type, input.itemId, input.fileId, userId).first();
  const existing = maybeText(counts?.["existing"]);
  if (!existing) {
    if (number(counts?.["total"]) >= MAX_SUBTITLES_PER_ACCOUNT) {
      throw new HttpError(
        `An account can keep ${MAX_SUBTITLES_PER_ACCOUNT} subtitles. Remove some first.`,
        409
      );
    }
    if (number(counts?.["for_item"]) >= MAX_SUBTITLES_PER_ITEM) {
      throw new HttpError(
        `One title can keep ${MAX_SUBTITLES_PER_ITEM} subtitles. Remove one first.`,
        409
      );
    }
  }
  const id = existing ?? crypto.randomUUID();
  const at = now();
  await env.DB.prepare(
    `INSERT INTO subtitles (
       user_id, id, type, item_id, series_id, season, episode_num, name, language, release,
       file_id, hearing_impaired, offset_ms, body, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, type, item_id, file_id) DO UPDATE SET
       series_id = excluded.series_id,
       season = excluded.season,
       episode_num = excluded.episode_num,
       name = excluded.name,
       language = excluded.language,
       release = excluded.release,
       hearing_impaired = excluded.hearing_impaired,
       offset_ms = ${input.offsetMs === void 0 ? "subtitles.offset_ms" : "excluded.offset_ms"},
       body = excluded.body,
       updated_at = excluded.updated_at`
  ).bind(
    userId,
    id,
    input.type,
    input.itemId,
    input.seriesId ?? null,
    input.season ?? null,
    input.episodeNum ?? null,
    input.name ?? null,
    input.language,
    input.release,
    input.fileId,
    input.hearingImpaired ? 1 : 0,
    input.offsetMs ?? 0,
    input.text,
    at,
    at
  ).run();
  return readBack(env, userId, id, existing ? 200 : 201);
};
var updateSubtitle = async (request, env, userId, id) => {
  const input = await readJson(request);
  const offsetMs = validOffset(input.offsetMs);
  if (offsetMs === void 0) {
    throw new HttpError("offsetMs is required", 400);
  }
  const result = await env.DB.prepare(
    "UPDATE subtitles SET offset_ms = ?, updated_at = ? WHERE user_id = ? AND id = ?"
  ).bind(offsetMs, now(), userId, id).run();
  if (!result.meta.changes) {
    throw new HttpError("No such subtitle", 404);
  }
  return readBack(env, userId, id, 200);
};
var removeSubtitle = async (env, userId, id) => {
  const result = await env.DB.prepare("DELETE FROM subtitles WHERE user_id = ? AND id = ?").bind(userId, id).run();
  if (!result.meta.changes) {
    throw new HttpError("No such subtitle", 404);
  }
  return ok({ removed: id });
};
var readBack = async (env, userId, id, status) => {
  const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM subtitles WHERE user_id = ? AND id = ?`).bind(userId, id).first();
  if (!row) {
    throw new HttpError("No such subtitle", 404);
  }
  return ok(toSubtitle(row), status);
};
var toSubtitle = (row) => ({
  id: text(row["id"]),
  type: itemType(text(row["type"])),
  itemId: text(row["item_id"]),
  seriesId: maybeText(row["series_id"]),
  season: maybeNumber(row["season"]),
  episodeNum: maybeNumber(row["episode_num"]),
  name: maybeText(row["name"]),
  language: text(row["language"]),
  release: text(row["release"]),
  fileId: number(row["file_id"]),
  hearingImpaired: number(row["hearing_impaired"]) === 1,
  offsetMs: number(row["offset_ms"]),
  createdAt: text(row["created_at"]),
  updatedAt: text(row["updated_at"])
});
var itemType = (value) => {
  if (value !== "vod" && value !== "series") {
    throw new HttpError("type must be vod or series", 400);
  }
  return value;
};
var shortText = (value, field, max, required) => {
  if (value === void 0 || value === null || value === "") {
    if (required) {
      throw new HttpError(`${field} is required`, 400);
    }
    return null;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new HttpError(`${field} must be text`, 400);
  }
  const trimmed = String(value).trim();
  if (required && !trimmed) {
    throw new HttpError(`${field} is required`, 400);
  }
  if (trimmed.length > max) {
    throw new HttpError(`${field} is too long`, 400);
  }
  return trimmed || null;
};
var smallInteger = (value, field) => {
  if (value === void 0 || value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0 || value > 1e5) {
    throw new HttpError(`${field} must be a whole number`, 400);
  }
  return value;
};
var validOffset = (value) => {
  if (value === void 0) {
    return void 0;
  }
  if (!Number.isInteger(value) || Math.abs(value) > MAX_SUBTITLE_OFFSET_MS) {
    throw new HttpError(`offsetMs must be whole milliseconds within ${MAX_SUBTITLE_OFFSET_MS / 1e3} s`, 400);
  }
  return value;
};
var validNew = (input) => {
  const type = itemType(String(input.type ?? ""));
  const itemId = shortText(input.itemId, "itemId", 64, true);
  const language = shortText(input.language, "language", 16, true);
  const release2 = shortText(input.release, "release", 300, true);
  if (!/^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(language)) {
    throw new HttpError("language must be a language code", 400);
  }
  if (!Number.isInteger(input.fileId) || input.fileId <= 0) {
    throw new HttpError("fileId must be an OpenSubtitles file id", 400);
  }
  if (typeof input.text !== "string" || !isWebVtt(input.text)) {
    throw new HttpError("text must be WebVTT", 400);
  }
  if (new TextEncoder().encode(input.text).length > MAX_SUBTITLE_BYTES) {
    throw new HttpError(`A subtitle can be at most ${MAX_SUBTITLE_BYTES / 1024} KB`, 413);
  }
  return {
    type,
    itemId,
    seriesId: shortText(input.seriesId, "seriesId", 64, false),
    season: smallInteger(input.season, "season"),
    episodeNum: smallInteger(input.episodeNum, "episodeNum"),
    name: shortText(input.name, "name", 300, false),
    language: language.toLowerCase(),
    release: release2,
    fileId: input.fileId,
    hearingImpaired: input.hearingImpaired === true,
    offsetMs: validOffset(input.offsetMs),
    text: input.text
  };
};

// src/index.ts
var OPEN = {
  "POST /api/accounts/register": register,
  "POST /api/accounts/login": login,
  "GET /api/accounts/salt": accountSalt
};
var ACCOUNT_ROUTES = /* @__PURE__ */ new Set([
  "GET /api/accounts/me",
  "POST /api/accounts/picture",
  "POST /api/accounts/keys",
  "GET /api/accounts/providers",
  "POST /api/accounts/providers",
  "GET /api/accounts/providers/active",
  "GET /api/accounts/invites",
  "POST /api/accounts/invites",
  "GET /api/devices/changes",
  "POST /api/devices/changes",
  "GET /api/devices/settings",
  "POST /api/devices/settings",
  "GET /api/subtitles/config",
  "GET /api/tmdb/config",
  "GET /api/subtitles/account",
  "POST /api/subtitles/account",
  "DELETE /api/subtitles/account",
  "GET /api/subtitles",
  "POST /api/subtitles",
  "GET /api/family",
  "POST /api/family/key",
  "POST /api/family/managed-keys",
  "POST /api/family/members",
  "POST /api/family/leave",
  "POST /api/family/join",
  "GET /api/accounts/tools",
  "GET /api/accounts/tools/requests",
  "GET /api/accounts/tools/actions",
  "POST /api/accounts/tools/actions"
]);
var TOOL_ACTION_ROUTE = /^(GET|POST) \/api\/accounts\/tools\/actions\/([0-9a-f]{32})$/;
var TOOL_POLL_ROUTE = /^GET \/api\/tools\/requests\/([0-9a-f]{32})$/;
var TOOL_ANSWER_ROUTE = /^POST \/api\/accounts\/tools\/requests\/([0-9a-f]{32})$/;
var TOOL_ROUTE = /^DELETE \/api\/accounts\/tools\/([^/]+)$/;
var MEMBER_ROUTE = /^(POST|DELETE) \/api\/family\/members\/(\d+)(?:\/(session|password|release))?$/;
var PROVIDER_ROUTE = /^DELETE \/api\/accounts\/providers\/(.+)$/;
var INVITE_ROUTE = /^DELETE \/api\/accounts\/invites\/(\d+)$/;
var KID_REFUSED = /* @__PURE__ */ new Set([
  "POST /api/accounts/keys",
  "POST /api/accounts/providers",
  "POST /api/accounts/invites",
  "POST /api/devices/settings",
  "POST /api/subtitles/account",
  "DELETE /api/subtitles/account"
]);
var SETUP_REFUSED = /* @__PURE__ */ new Set([
  "POST /api/accounts/keys",
  "GET /api/accounts/invites",
  "POST /api/accounts/invites",
  "GET /api/subtitles",
  "POST /api/subtitles"
]);
var TOOL_REFUSED = /* @__PURE__ */ new Set([
  "POST /api/accounts/keys",
  "POST /api/family/key",
  "POST /api/family/managed-keys",
  "POST /api/family/members",
  "POST /api/family/leave",
  "POST /api/family/join",
  "GET /api/subtitles/account",
  "POST /api/subtitles/account",
  "DELETE /api/subtitles/account",
  "GET /api/accounts/tools",
  "GET /api/accounts/tools/requests",
  "GET /api/accounts/tools/actions",
  "POST /api/devices/settings"
]);
var isSubtitleListRoute = (route) => route === "GET /api/subtitles" || route === "POST /api/subtitles" || SUBTITLE_ROUTE.test(route);
var refusal = (caller, route) => {
  if (caller.mintedBy && route === "POST /api/accounts/keys") {
    return "Only the account itself can change its password";
  }
  if (caller.mintedBy?.tool && TOOL_REFUSED.has(route)) {
    return "A tool cannot do this; do it in the app";
  }
  if (caller.scope === "tool" && isSubtitleListRoute(route)) {
    return "This tool was not allowed to see what the account watched";
  }
  if (isToolScope(caller.scope)) {
    const member = MEMBER_ROUTE.exec(route);
    const memberAllowed = member !== null && member[1] === "POST" && (member[3] === void 0 || member[3] === "session");
    const action = TOOL_ACTION_ROUTE.exec(route);
    if (TOOL_REFUSED.has(route) || member && !memberAllowed || TOOL_ANSWER_ROUTE.test(route) || action?.[1] === "POST") {
      return "A tool cannot do this; do it in the app";
    }
    const tool = TOOL_ROUTE.exec(route);
    if (tool && tool[1] !== caller.sessionId) {
      return "A tool can sign itself out and no other";
    }
  }
  if (caller.scope === "setup") {
    if (SETUP_REFUSED.has(route) || SUBTITLE_ROUTE.test(route) || INVITE_ROUTE.test(route) || route === "GET /api/accounts/tools/requests" || TOOL_ANSWER_ROUTE.test(route) || route.includes("/api/accounts/tools/actions")) {
      return "Setting somebody up does not reach what they watch, their password or their invites";
    }
    return null;
  }
  if (caller.role === "kid" && (KID_REFUSED.has(route) || PROVIDER_ROUTE.test(route) || INVITE_ROUTE.test(route))) {
    return "This account is set up by somebody else";
  }
  if (caller.role === "member" && (route === "POST /api/accounts/invites" || INVITE_ROUTE.test(route))) {
    return "Only an admin can invite somebody into the family";
  }
  return null;
};
var currentHash = async (request) => {
  const token = bearerToken(request);
  return token ? hashToken(token) : null;
};
var handle = async (request, env) => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const route = `${request.method} ${path}`;
  if (path === "/" || path === "/api" || path === "/api/health") {
    return new Response(
      JSON.stringify({
        success: true,
        // `tools`: this service knows tool sessions, so the tvinto CLI can
        // sign in here -- and can say so before it asks
        // for a password, when a service does not.
        data: { status: "ok", service: "sync", registration: await registrationMode(env), tools: true, toolApproval: true, toolConfirm: true }
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }
  if (path.startsWith("/updates/")) {
    return serveUpdate(request, env, path);
  }
  if (path === "/downloads") {
    return downloadsPage(request, env);
  }
  if (path === "/a") {
    return latestDownload(env, "android");
  }
  if (path === "/w") {
    return latestDownload(env, "desktop");
  }
  const open2 = OPEN[route];
  if (open2) {
    return open2(request, env);
  }
  if (route === "POST /api/tools/requests") {
    return createToolRequest(request, env);
  }
  const poll = TOOL_POLL_ROUTE.exec(route);
  if (poll) {
    return pollToolRequest(request, env, poll[1]);
  }
  if (!ACCOUNT_ROUTES.has(route) && !PROVIDER_ROUTE.test(route) && !SUBTITLE_ROUTE.test(route) && !INVITE_ROUTE.test(route) && !MEMBER_ROUTE.test(route) && !TOOL_ROUTE.test(route) && !TOOL_ANSWER_ROUTE.test(route) && !TOOL_ACTION_ROUTE.test(route)) {
    throw new HttpError("No such endpoint", 404);
  }
  const caller = await resolveSession(env.DB, request);
  if (caller === null) {
    throw new HttpError("Sign in to continue", 401);
  }
  const { userId } = caller;
  const refused = refusal(caller, route);
  if (refused) {
    throw new HttpError(refused, 403);
  }
  switch (route) {
    case "GET /api/accounts/me":
      return me(env, userId);
    case "POST /api/accounts/picture":
      return setPicture(request, env, userId);
    case "POST /api/accounts/keys":
      return replaceKeys(request, env, userId);
    case "GET /api/accounts/providers":
      return listProviders(env, userId);
    case "POST /api/accounts/providers":
      return saveProvider(request, env, userId);
    case "GET /api/accounts/providers/active":
      return activeProvider(env, userId);
    case "GET /api/accounts/invites":
      return listInvites(env, userId);
    case "POST /api/accounts/invites":
      return createInvite(env, userId);
    case "GET /api/accounts/tools/requests":
      return listToolRequests(env, caller);
    case "GET /api/accounts/tools/actions":
      return listToolActions(env, caller);
    case "POST /api/accounts/tools/actions":
      return createToolAction(request, env, caller);
    case "GET /api/accounts/tools":
      return ok({ tools: await listToolSessions(env.DB, userId, await currentHash(request)) });
    case "GET /api/devices/changes":
      return pullChanges(request, env, userId, kindsVisible(caller.scope));
    case "POST /api/devices/changes":
      return pushChanges(
        request,
        env,
        userId,
        kindsAllowed(caller.role, caller.scope),
        actsAsTool(caller) ? (changes) => chargeToolChanges(env.DB, toolChargeId(caller), changes) : void 0,
        actsAsTool(caller)
      );
    case "GET /api/devices/settings":
      return getSettings(env, userId);
    case "POST /api/devices/settings":
      return saveSettings(request, env, userId);
    case "GET /api/tmdb/config":
      return tmdbConfig(env);
    case "GET /api/subtitles/config":
      return subtitlesConfig(env);
    case "GET /api/subtitles/account":
      return getSubtitleAccount(env, userId);
    case "POST /api/subtitles/account":
      return saveSubtitleAccount(request, env, userId);
    case "DELETE /api/subtitles/account":
      return forgetSubtitleAccount(env, userId);
    case "GET /api/subtitles":
      return listSubtitles(request, env, userId);
    case "POST /api/subtitles":
      return addSubtitle(request, env, userId);
    case "GET /api/family":
      return getFamily(env, caller);
    case "POST /api/family/key":
      return saveOwnKey(request, env, caller);
    case "POST /api/family/managed-keys":
      return saveManagedKeys(request, env, caller);
    case "POST /api/family/members":
      return addMember(request, env, caller);
    case "POST /api/family/leave":
      return leaveFamily(env, caller);
    case "POST /api/family/join":
      return joinFamily(request, env, caller);
  }
  const member = MEMBER_ROUTE.exec(route);
  if (member) {
    const [, method, id, action2] = member;
    const memberId = Number(id);
    if (method === "DELETE") {
      if (action2) {
        throw new HttpError("No such endpoint", 404);
      }
      return deleteMember(env, caller, memberId);
    }
    switch (action2) {
      case "session":
        return memberSession(request, env, caller, memberId);
      case "password":
        return resetMemberPassword(request, env, caller, memberId);
      case "release":
        return releaseMember(env, caller, memberId);
      default:
        return changeMember(request, env, caller, memberId);
    }
  }
  const subtitle = SUBTITLE_ROUTE.exec(route);
  if (subtitle) {
    const [, method, id] = subtitle;
    if (method === "GET") {
      return getSubtitle(env, userId, id);
    }
    if (method === "POST") {
      return updateSubtitle(request, env, userId, id);
    }
    return removeSubtitle(env, userId, id);
  }
  const invite = INVITE_ROUTE.exec(route);
  if (invite) {
    return revokeInvite(env, userId, invite[1]);
  }
  const action = TOOL_ACTION_ROUTE.exec(route);
  if (action) {
    return action[1] === "GET" ? toolActionStatus(env, caller, action[2]) : answerToolAction(request, env, caller, action[2]);
  }
  const answer = TOOL_ANSWER_ROUTE.exec(route);
  if (answer) {
    return answerToolRequest(request, env, caller, answer[1]);
  }
  const tool = TOOL_ROUTE.exec(route);
  if (tool) {
    if (!await endToolSession(env.DB, userId, tool[1])) {
      throw new HttpError("No such tool on this account", 404);
    }
    return ok({ signedOut: tool[1] });
  }
  const provider = PROVIDER_ROUTE.exec(route);
  if (provider) {
    return removeProvider(env, userId, decodeURIComponent(provider[1]));
  }
  throw new HttpError("No such endpoint", 404);
};
var index_default = {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    try {
      const response = await handle(request, env);
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(cors)) {
        headers.set(name, value);
      }
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      if (error instanceof HttpError) {
        return fail(error.message, error.status, cors);
      }
      console.error("Unhandled failure", error);
      return fail("Something went wrong", 500, cors);
    }
  }
};
export {
  index_default as default
};
