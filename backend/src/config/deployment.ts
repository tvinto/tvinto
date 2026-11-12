/**
 * What changes when the server stops being on the same machine as the browser.
 *
 * Two things do. It sits behind something else's TLS, so the address a request
 * appears to come from is the proxy's rather than the caller's; and nobody is
 * watching the console, so a setting that is merely unwise has to say so at
 * boot rather than being discovered from the outside.
 */

/** What express should believe about X-Forwarded-For. */
export type TrustProxySetting = false | number | 'loopback' | string[];

/**
 * How many proxies stand in front, or which ones.
 *
 * Express takes a count, a list of addresses, or `true` for "trust whatever
 * the header says". The count is the one to use: X-Forwarded-For is appended
 * to by each hop and is otherwise a field the caller writes, so trusting all
 * of it lets anyone claim any address -- which, for a rate limiter keyed on
 * address, means the limit can be stepped around by inventing a new one per
 * request. One hop for Cloudflare straight through to this process, two if
 * there is an nginx in between.
 *
 * Unset means not behind a proxy, which is the local case and the safe answer:
 * being wrong that way undercounts distinct callers rather than trusting a
 * forged one.
 */
export const resolveTrustProxy = (raw: string | undefined): TrustProxySetting => {
  const value = raw?.trim();
  if (!value) {
    return false;
  }

  const lowered = value.toLowerCase();
  if (lowered === 'false' || lowered === 'off' || lowered === '0') {
    return false;
  }

  if (lowered === 'loopback') {
    return 'loopback';
  }

  if (/^\d+$/.test(lowered)) {
    return parseInt(lowered, 10);
  }

  // Named addresses or CIDR ranges: trust these hops and no others.
  const addresses = value
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);

  return addresses.length ? addresses : false;
};

export interface DeploymentFacts {
  production: boolean;
  registration: string;
  credentialKeySupplied: boolean;
  credentialKeyFile: string;
  databasePath: string;
  /**
   * Whether DATABASE_PATH names an absolute location.
   *
   * Being set is not enough. A relative path is resolved against the backend
   * package, which in a compiled deployment is the build output rather than
   * the source tree -- so the familiar `./xtream-cache.db` quietly means a
   * different file in production than it does in development.
   */
  databasePathPinned: boolean;
  corsOrigins: readonly string[];
  trustProxy: TrustProxySetting;
}

export interface DeploymentNote {
  level: 'info' | 'warn';
  message: string;
}

/**
 * What to say on the way up.
 *
 * Each of these is a setting whose wrong value fails as something else
 * entirely -- an unset key surfaces as a subscription that cannot be read, a
 * missing proxy hop as everyone sharing one rate limit -- so the point is to
 * name them while the cause and the effect are still next to each other.
 *
 * Reported rather than refused. A server that will not start is worse than one
 * that starts and says what it is, and the judgement about which of these
 * matters belongs to whoever deployed it.
 */
export const deploymentNotes = (facts: DeploymentFacts): DeploymentNote[] => {
  const notes: DeploymentNote[] = [];

  notes.push({ level: 'info', message: `Database: ${facts.databasePath}` });
  notes.push({ level: 'info', message: `Allowed origins: ${facts.corsOrigins.join(', ') || '(none)'}` });

  if (facts.credentialKeySupplied) {
    notes.push({ level: 'info', message: 'Credential key: from CREDENTIAL_KEY' });
  } else {
    notes.push({
      level: facts.production ? 'warn' : 'info',
      message:
        `Credential key: generated beside the database at ${facts.credentialKeyFile}. ` +
        'It has to survive restarts or stored subscriptions become unreadable, ' +
        'which shows up as having no usable subscription rather than as a key error. ' +
        'Set CREDENTIAL_KEY, or keep that file on the same volume as the database.'
    });
  }

  if (!facts.production) {
    return notes;
  }

  if (facts.registration !== 'closed' && facts.registration !== 'first-only') {
    notes.push({
      level: 'warn',
      message:
        'Registration is open, so anyone who finds this server can create an account. ' +
        'Set ACCOUNT_REGISTRATION=first-only, or closed once you have your account.'
    });
  }

  if (!facts.databasePathPinned) {
    notes.push({
      level: 'warn',
      message:
        `DATABASE_PATH is not an absolute path, so the database is at ${facts.databasePath}. ` +
        'A relative path is resolved against the backend package, which in a ' +
        'compiled deployment is the build output -- replaced by the next deploy, ' +
        'taking the accounts and subscriptions with it. Name a path on a volume ' +
        'that outlives a deploy.'
    });
  }

  if (facts.trustProxy === false) {
    notes.push({
      level: 'warn',
      message:
        'TRUST_PROXY is unset. Behind a proxy every request appears to come from ' +
        'the proxy, so one rate limit is shared by everyone. Set it to the number ' +
        'of proxies in front of this process (1 for Cloudflare straight through).'
    });
  }

  return notes;
};
