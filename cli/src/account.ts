import { checkKdfParams, deriveAccountKeys, fromBase64, toBase64 } from '../../shared/auth/accountKeys';
import { open } from '../../shared/auth/secretBox';
import { makeKeyPair, openPrivateKey, openWith } from '../../shared/auth/keyPair';
import { serverAddressCandidates } from '../../shared/server';
import { hostOf, readProviderRecord, recordAddress } from '../../shared/providers/providerRecord';
import { SETTING_KEYS } from '../../shared/types';
import { countOf, readCategorySets, readLockSettings } from '../../shared/categoryLock';
import { readPlayerPreferences, PlayerPreferences } from '../../shared/player';
import { FamilyRole } from '../../shared/family';
import { nodeKdf } from './nodeKdf';
import { Fetch, ServiceError, SyncService } from './service';
import { readAgeLock } from '../../shared/tmdb/age';
import { readLanguages } from '../../shared/languages';
import {
  Config,
  Credentials,
  SecretStore,
  entryName,
  readConfig,
  readCredentials,
  writeConfig,
  writeCredentials
} from './store';

/**
 * What tvinto does with an account, apart from how it is printed.
 *
 * Nothing here returns a password, a provider login or a full provider
 * address -- not to the terminal, and not to an agent through the MCP server
 * later. A provider is its
 * label and its host. Text somebody else wrote -- labels, names -- comes back
 * wrapped as `Untrusted`, for the output to mark as data.
 */

/** Text from somebody else: a label, a name. Data, never instructions. */
export interface Untrusted {
  untrusted: string;
}

export const untrusted = (text: string): Untrusted => ({ untrusted: text });

/** A signed-in account, ready to be asked things. */
export interface Session {
  config: Config;
  service: SyncService;
  enc: Uint8Array;
  /** Set when this is a family member being set up (`--for`). */
  memberId?: number;
}

/** What a tool session is called on the account's own devices. */
export const toolName = (hostname: string): string => `Tool on ${hostname}`.slice(0, 60);

// --- Signing in and out --------------------------------------------------------

export interface SignInRequest {
  server: string;
  username: string;
  password: string;
  /** Whether it may read and change favourites and watch history. */
  history: boolean;
  name: string;
}

/**
 * Signs in as a tool, keeps the token and the key, and remembers which
 * account this is.
 *
 * Checks the service knows tools before the password is used for anything:
 * an older one would hand out a full session to a tool asking for less, and
 * that is refused here rather than accepted and narrowed by hope.
 */
export async function signIn(request: SignInRequest, fetch: Fetch, store: SecretStore): Promise<Config> {
  const { apiUrl } = await findService(request.server, fetch);
  const service = new SyncService(apiUrl, fetch);
  const answer = await service.salt(request.username);
  const salt = fromBase64(answer.salt);
  if (!salt?.length) {
    throw new Error('The sync service did not send a usable salt');
  }
  const params = { cost: answer.cost, blockSize: answer.blockSize, parallelism: answer.parallelism };
  // The server's word on the cost is not taken below the floor (shared/auth).
  checkKdfParams(params);
  const { auth, enc } = await deriveAccountKeys(request.password, salt, params, nodeKdf);

  const signedIn = await service.login(request.username, toBase64(auth), {
    name: request.name,
    history: request.history
  });
  const expected = request.history ? 'tool-history' : 'tool';
  if (signedIn.scope !== expected) {
    // Kept nowhere: a session wider than asked for is not one to hold.
    throw new Error('The sync service did not give the narrow session tvinto asks for; nothing was kept.');
  }

  const config: Config = { server: apiUrl, username: signedIn.user.username };
  await writeCredentials(store, config, { token: signedIn.token, enc: toBase64(enc) });
  writeConfig(config);
  return config;
}

/** The sync service at an address, checked to know tools; and whether it takes approval in the app. */
async function findService(server: string, fetch: Fetch): Promise<{ apiUrl: string; approval: boolean }> {
  const candidates = serverAddressCandidates(server);
  if (!candidates.length) {
    throw new Error(`"${server}" is not a server address`);
  }
  let tooOld = false;
  for (const candidate of candidates) {
    const health = await new SyncService(candidate, fetch).health();
    if (health?.tools === true) {
      return { apiUrl: candidate, approval: health.toolApproval === true };
    }
    tooOld = tooOld || health !== null;
  }
  throw new Error(
    tooOld
      ? 'This sync service is too old for tvinto: it does not know tool sessions yet. It needs updating first.'
      : `No sync service answered at ${candidates[0]}`
  );
}

/** What signing in by approval needs from outside: showing the code, opening the app, waiting. */
export interface ApprovalHooks {
  /** Shows the code, and opens the desktop app on the request if it can. */
  asked(code: string, link: string): void;
  wait(ms: number): Promise<void>;
  /**
   * Asks the person for the confirmation the app shows once they allowed it
   * (worker/src/toolRequests.ts); `wrong` when the last one was not it.
   */
  confirm?(wrong: boolean): Promise<string>;
}

const POLL_MS = 2000;
const POLL_LIMIT_MS = 10 * 60 * 1000;

/**
 * Signs in without a password: asks the sync service to let this tool in,
 * and waits for a device of the account to allow it (worker/src/toolRequests.ts).
 *
 * A fresh key pair is made for the asking. What comes back -- the session
 * token and the account's `enc` -- is sealed for its public key, so the
 * service relays both without being able to read either.
 */
export async function signInByApproval(
  request: Omit<SignInRequest, 'password'>,
  fetch: Fetch,
  store: SecretStore,
  hooks: ApprovalHooks
): Promise<Config> {
  const { apiUrl, approval } = await findService(request.server, fetch);
  if (!approval) {
    throw new Error('This sync service cannot ask the app yet. Sign in with the password: tvinto sign-in --password');
  }
  const service = new SyncService(apiUrl, fetch);
  const pair = await makeKeyPair();
  const asked = await service.requestSignIn(request.username, request.name, request.history, pair.publicKey);
  hooks.asked(
    asked.code,
    `tvinto://tool-request?id=${asked.id}&code=${asked.code}&server=${encodeURIComponent(apiUrl)}`
  );

  let confirmation = '';
  for (let waited = 0; waited < POLL_LIMIT_MS; waited += POLL_MS) {
    if (!confirmation) {
      await hooks.wait(POLL_MS);
    }
    let answer: Awaited<ReturnType<SyncService['pollSignIn']>>;
    try {
      answer = await service.pollSignIn(asked.id, asked.secret, confirmation || undefined);
    } catch (error) {
      if (error instanceof ServiceError && error.status === 404) {
        throw new Error('The request ran out, or that account does not exist here. Try again.');
      }
      throw error;
    }
    if (answer.status === 'pending') {
      continue;
    }
    if (answer.status === 'confirm') {
      // Allowed in the app, which now shows a confirmation for this tool.
      if (!hooks.confirm) {
        throw new Error("Allowed in the app; this tool cannot ask for the confirmation it shows.");
      }
      confirmation = (await hooks.confirm(answer.wrong === true)).trim();
      if (!confirmation) {
        throw new Error('No confirmation typed. Nothing was kept.');
      }
      continue;
    }
    if (answer.status !== 'approved') {
      throw new Error('Refused in the app. Nothing was kept.');
    }
    const token = await openWith(answer.sealedToken ?? '', pair.privateKey);
    const enc = await openWith(answer.sealedEnc ?? '', pair.privateKey);
    if (!token || !enc || fromBase64(enc)?.length !== 32) {
      throw new Error('The answer could not be opened. Nothing was kept.');
    }
    const config: Config = { server: apiUrl, username: answer.username || request.username };
    await writeCredentials(store, config, { token, enc });
    writeConfig(config);
    return config;
  }
  throw new Error('Nobody allowed it within ten minutes. Try again.');
}

/**
 * Asks the app to do something only a person may -- add or remove a family
 * member, reset a member's password, take the lock off -- and waits for the
 * answer. The app does it itself, on a click; a password it makes is shown
 * there and never comes back here.
 */
export async function askTheApp(
  current: Session,
  kind: 'add-member' | 'remove-member' | 'reset-password' | 'pin-off',
  details: object,
  hooks: ApprovalHooks
): Promise<'done' | 'refused'> {
  const { id } = await current.service.askApp(kind, details);
  hooks.asked('', `tvinto://tool-action?id=${id}&server=${encodeURIComponent(current.config.server)}`);
  for (let waited = 0; waited < POLL_LIMIT_MS; waited += POLL_MS) {
    await hooks.wait(POLL_MS);
    let answer: { status: string };
    try {
      answer = await current.service.askedStatus(id);
    } catch (error) {
      if (error instanceof ServiceError && error.status === 404) {
        throw new Error('Nobody answered it in the app within ten minutes.');
      }
      throw error;
    }
    if (answer.status === 'done' || answer.status === 'refused') {
      return answer.status;
    }
  }
  throw new Error('Nobody answered it in the app within ten minutes.');
}

/** A family member by name, from the account's own view of its family. */
export async function memberNamed(current: Session, name: string): Promise<{ id: number; username: string }> {
  const family = await current.service.family();
  const member = family.members.find(candidate => candidate.username.toLowerCase() === name.trim().toLowerCase());
  if (!member) {
    throw new Error(`Nobody called ${JSON.stringify(name)} in the family below this account.`);
  }
  return member;
}

/** Ends the session on the service and forgets it here. Whether there was one. */
export async function signOut(fetch: Fetch, store: SecretStore): Promise<boolean> {
  const config = readConfig();
  if (!config) {
    return false;
  }
  const credentials = await readCredentials(store, config);
  if (credentials) {
    try {
      await new SyncService(config.server, fetch, credentials.token).signOut();
    } catch (error) {
      // Already gone there -- signed out from the app, or run out -- is fine.
      if (!(error instanceof ServiceError) || (error.status !== 401 && error.status !== 404)) {
        throw error;
      }
    }
    await store.delete(entryName(config));
  }
  writeConfig(null);
  return true;
}

/** The signed-in account, or an error that says to sign in. */
export async function session(fetch: Fetch, store: SecretStore): Promise<Session> {
  const config = readConfig();
  const credentials: Credentials | null = config ? await readCredentials(store, config) : null;
  const enc = credentials ? fromBase64(credentials.enc) : null;
  if (!config || !credentials || !enc) {
    throw new Error('Not signed in. Run: tvinto sign-in --server <address>');
  }
  return { config, service: new SyncService(config.server, fetch, credentials.token), enc };
}

/**
 * The same account's view of a family member, for setting the member up
 * (`--for <name>`): a setup session as the member, and the member's `enc`,
 * opened the way the app opens it (FamilyService.memberEnc).
 *
 * The setup session is kept in the credential store beside the account's
 * own, and used again while it works: every one made is a session row, and
 * a command per change would leave a trail of them.
 */
export async function memberSession(own: Session, name: string, store: SecretStore): Promise<Session> {
  const family = await own.service.family();
  const member = family.members.find(candidate => candidate.username.toLowerCase() === name.trim().toLowerCase());
  if (!member) {
    throw new Error(`Nobody called ${JSON.stringify(name)} in the family below this account.`);
  }
  const privateKey = family.me.sealedPrivateKey ? await openPrivateKey(family.me.sealedPrivateKey, own.enc) : null;
  const opened = privateKey && member.sealedEnc ? await openWith(member.sealedEnc, privateKey) : null;
  const enc = opened ? fromBase64(opened) : null;
  if (!enc) {
    throw new Error(`${member.username}'s key has not reached this account yet: open the app once on one of ${member.username}'s devices.`);
  }

  const config: Config = { server: own.config.server, username: `${own.config.username}/${member.username}` };
  const kept = await store.get(entryName(config));
  if (kept) {
    const service = new SyncService(config.server, own.service.fetchFn, kept);
    try {
      await service.me();
      return { config, service, enc, memberId: member.id };
    } catch (error) {
      if (!(error instanceof ServiceError) || error.status !== 401) {
        throw error;
      }
    }
  }
  const { token } = await own.service.setUpMember(member.id);
  await store.set(entryName(config), token);
  return { config, service: new SyncService(config.server, own.service.fetchFn, token), enc, memberId: member.id };
}

// --- Reading -----------------------------------------------------------------

export interface StatusView {
  server: string;
  username: string;
  role: string;
  providers: number;
}

export async function status(current: Session): Promise<StatusView> {
  const me = await current.service.me();
  return {
    server: hostOf(current.config.server),
    username: me.user.username,
    role: me.user.role ?? 'admin',
    providers: me.providers.length
  };
}

export interface ProviderView {
  label: Untrusted;
  kind: 'xtream' | 'm3u' | 'stalker';
  /** The provider's host, and nothing else of its address. */
  host: string;
  enabled: boolean;
  /** The account that shared it, when one did. */
  sharedBy: Untrusted | null;
}

export interface ProvidersView {
  providers: ProviderView[];
  /** Rows the key here does not open: sealed under a password since changed. */
  unreadable: number;
}

export async function providers(current: Session): Promise<ProvidersView> {
  const me = await current.service.me();
  const shown: ProviderView[] = [];
  let unreadable = 0;
  for (const row of me.providers) {
    const record = readProviderRecord(await open(row.payload, current.enc));
    if (!record) {
      unreadable++;
      continue;
    }
    shown.push({
      label: untrusted(record.label),
      kind: record.kind,
      host: hostOf(recordAddress(record)),
      enabled: record.enabled,
      sharedBy: record.sharedBy ? untrusted(record.sharedBy) : null
    });
  }
  return { providers: shown, unreadable };
}

export interface GuideView {
  /** What `tvinto guide on|off` takes: a hash of the address, which carries none of it. */
  id: string;
  label: Untrusted;
  host: string;
  enabled: boolean;
  /** Channels tied to this guide by hand. */
  matchedByHand: number;
}

export interface GuidesView {
  guides: GuideView[];
  unreadable: number;
}

export async function guides(current: Session): Promise<GuidesView> {
  const pulled = await current.service.pull();
  const byHand = new Map<string, number>();
  for (const mapping of pulled.channelMappings ?? []) {
    byHand.set(mapping.sourceId, (byHand.get(mapping.sourceId) ?? 0) + 1);
  }

  const shown: GuideView[] = [];
  let unreadable = 0;
  for (const source of pulled.guideSources ?? []) {
    const opened = await open(source.payload, current.enc);
    const details = readSealedGuide(opened);
    if (!details) {
      unreadable++;
      continue;
    }
    const host = hostOf(details.url);
    shown.push({
      id: source.id,
      label: untrusted(typeof details.label === 'string' && details.label ? details.label : host),
      host,
      enabled: details.enabled !== false,
      matchedByHand: byHand.get(source.id) ?? 0
    });
  }
  return { guides: shown, unreadable };
}

/** A guide as the app seals it (GuideSourcesService.send), or null. */
function readSealedGuide(opened: string | null): { label: unknown; url: string; enabled: unknown } | null {
  if (!opened) {
    return null;
  }
  try {
    const parsed = JSON.parse(opened) as { label?: unknown; url?: unknown; enabled?: unknown } | null;
    return parsed && typeof parsed.url === 'string'
      ? { label: parsed.label, url: parsed.url, enabled: parsed.enabled }
      : null;
  } catch {
    return null;
  }
}

export interface SettingsView {
  /** The sorts set for the whole account, or null where each device keeps its own. */
  categorySort: string | null;
  channelSort: string | null;
  hiddenCategories: number;
  lockedCategories: number;
  /** Whether a PIN is set. Never the PIN, nor its hash. */
  pin: boolean;
  /** Minutes untouched before the lock comes back, 0 for never; null without a PIN. */
  lockAfterMinutes: number | null;
  descriptions: string;
  openLastChannel: boolean;
  /** Films and shows locked at this age and over, 0 for off; by this country's ratings first. */
  ageLock: { limit: number; country: string };
  /** Whether a television plays the channel in focus above the guide. */
  channelPreview: boolean;
  /** Copies and trailers in this order; empty for the app's language, then English. */
  languages: string[];
  player: PlayerPreferences;
}

export async function settings(current: Session): Promise<SettingsView> {
  const pulled = await current.service.pull();
  const values = new Map((pulled.settings ?? []).map(setting => [setting.key, setting.value]));
  const value = (key: string): string | null => values.get(key) ?? null;
  const sortOf = (key: string): string | null => {
    try {
      const parsed = JSON.parse(value(key) ?? 'null') as { sort?: unknown } | null;
      return typeof parsed?.sort === 'string' ? parsed.sort : null;
    } catch {
      return null;
    }
  };
  const lock = readLockSettings(value(SETTING_KEYS.parentalLock));

  return {
    categorySort: sortOf(SETTING_KEYS.setUpCategorySort),
    channelSort: sortOf(SETTING_KEYS.setUpStreamSort),
    hiddenCategories: countOf(readCategorySets(value(SETTING_KEYS.hiddenCategories))),
    lockedCategories: lock ? countOf(readCategorySets(value(SETTING_KEYS.lockedCategories))) : 0,
    pin: lock !== null,
    lockAfterMinutes: lock ? lock.idleMinutes : null,
    descriptions: value(SETTING_KEYS.descriptionLanguage) || 'provider',
    openLastChannel: value(SETTING_KEYS.openLastChannel) === 'on',
    channelPreview: value(SETTING_KEYS.channelPreview) !== 'off',
    languages: value(SETTING_KEYS.languages) ? readLanguages(value(SETTING_KEYS.languages), 'en') : [],
    ageLock: lock ? readAgeLock(value(SETTING_KEYS.ageLock)) : { limit: 0, country: readAgeLock(null).country },
    player: readPlayerPreferences(value(SETTING_KEYS.player))
  };
}

export interface FamilyMemberView {
  name: Untrusted;
  role: FamilyRole;
  /** Shown as a profile on its managers' own devices. */
  household: boolean;
}

export interface FamilyOverview {
  role: FamilyRole;
  managers: Untrusted[];
  members: FamilyMemberView[];
}

export async function family(current: Session): Promise<FamilyOverview> {
  const view = await current.service.family();
  return {
    role: view.me.role,
    managers: view.managers.map(manager => untrusted(manager.username)),
    members: view.members.map(member => ({
      name: untrusted(member.username),
      role: member.role,
      household: member.household
    }))
  };
}
