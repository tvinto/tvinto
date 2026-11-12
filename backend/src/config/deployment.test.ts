import { resolveTrustProxy, deploymentNotes, DeploymentFacts } from './deployment';

describe('resolveTrustProxy', () => {
  it('trusts nothing when unset, because that is the local case', () => {
    expect(resolveTrustProxy(undefined)).toBe(false);
    expect(resolveTrustProxy('')).toBe(false);
    expect(resolveTrustProxy('   ')).toBe(false);
  });

  it('reads a hop count, which is what a proxy in front means', () => {
    expect(resolveTrustProxy('1')).toBe(1);
    expect(resolveTrustProxy(' 2 ')).toBe(2);
  });

  // "0" is a count of zero proxies, which is the same as not being behind one.
  // Express treats 0 and false alike, but false says it more plainly.
  it('treats the ways of saying no alike', () => {
    expect(resolveTrustProxy('0')).toBe(false);
    expect(resolveTrustProxy('false')).toBe(false);
    expect(resolveTrustProxy('OFF')).toBe(false);
  });

  it('takes named addresses for a proxy at a known address', () => {
    expect(resolveTrustProxy('10.0.0.1, 172.16.0.0/12')).toEqual(['10.0.0.1', '172.16.0.0/12']);
    expect(resolveTrustProxy('loopback')).toBe('loopback');
  });
});

describe('deploymentNotes', () => {
  const facts = (overrides: Partial<DeploymentFacts> = {}): DeploymentFacts => ({
    production: true,
    registration: 'closed',
    credentialKeySupplied: true,
    credentialKeyFile: '/data/xtream-cache.db.key',
    databasePath: '/data/xtream-cache.db',
    databasePathPinned: true,
    corsOrigins: ['https://example.invalid'],
    trustProxy: 1,
    ...overrides
  });

  const warnings = (given: DeploymentFacts) =>
    deploymentNotes(given).filter(note => note.level === 'warn').map(note => note.message);

  it('has nothing to complain about when everything is set', () => {
    expect(warnings(facts())).toEqual([]);
  });

  it('always says where the database and the origins are', () => {
    const messages = deploymentNotes(facts()).map(note => note.message);
    expect(messages.some(message => message.includes('/data/xtream-cache.db'))).toBe(true);
    expect(messages.some(message => message.includes('https://example.invalid'))).toBe(true);
  });

  it('warns that an open door is open', () => {
    expect(warnings(facts({ registration: 'open' })).join(' ')).toContain('ACCOUNT_REGISTRATION');
    expect(warnings(facts({ registration: 'first-only' }))).toEqual([]);
  });

  // Being set is not enough: a relative path resolves against the compiled
  // output, so the same setting names a different file once deployed.
  it('warns when the database is somewhere a deploy could replace', () => {
    expect(warnings(facts({ databasePathPinned: false })).join(' ')).toContain('DATABASE_PATH');
  });

  it('warns when nothing is trusted in front, since one limit would be shared', () => {
    expect(warnings(facts({ trustProxy: false })).join(' ')).toContain('TRUST_PROXY');
  });

  // The failure this warning is for does not mention keys: the subscription
  // simply stops being readable, and the app reports having none.
  it('warns about a generated key, and says what losing it looks like', () => {
    const message = warnings(facts({ credentialKeySupplied: false })).join(' ');
    expect(message).toContain('CREDENTIAL_KEY');
    expect(message).toContain('/data/xtream-cache.db.key');
  });

  it('leaves a development machine alone about the things only hosting cares about', () => {
    const notes = warnings(
      facts({
        production: false,
        registration: 'open',
        trustProxy: false,
        credentialKeySupplied: false,
        databasePathPinned: false
      })
    );
    expect(notes).toEqual([]);
  });
});
