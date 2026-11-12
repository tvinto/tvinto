import { Env } from './d1';
import { HttpError, corsHeaders, fail, ok } from './http';
import {
  actsAsTool,
  bearerToken,
  chargeToolChanges,
  endToolSession,
  hashToken,
  listToolSessions,
  resolveSession,
  toolChargeId
} from './sessions';
import {
  accountSalt,
  activeProvider,
  listProviders,
  login,
  me,
  register,
  registrationMode,
  removeProvider,
  replaceKeys,
  saveProvider,
  setPicture
} from './accounts';
import { getSettings, pullChanges, pushChanges, saveSettings } from './sync';
import {
  addMember,
  changeMember,
  deleteMember,
  getFamily,
  joinFamily,
  leaveFamily,
  memberSession,
  releaseMember,
  resetMemberPassword,
  saveManagedKeys,
  saveOwnKey
} from './family';
import { Caller } from './sessions';
import { isToolScope, kindsAllowed, kindsVisible } from '../../shared/family';
import { serveUpdate } from './updates';
import { tmdbConfig } from './tmdb';
import { createInvite, listInvites, revokeInvite } from './invites';
import { answerToolRequest, createToolRequest, listToolRequests, pollToolRequest } from './toolRequests';
import { answerToolAction, createToolAction, listToolActions, toolActionStatus } from './toolActions';
import { downloadsPage, latestDownload } from './downloads';
import {
  SUBTITLE_ROUTE,
  addSubtitle,
  getSubtitle,
  listSubtitles,
  forgetSubtitleAccount,
  getSubtitleAccount,
  removeSubtitle,
  saveSubtitleAccount,
  subtitlesConfig,
  updateSubtitle
} from './subtitles';

/**
 * The sync service.
 *
 * What is left of a backend once the devices talk to the provider themselves:
 * who you are, and what you have made. No catalogue, no video, no guide, and
 * no password -- the device derives its key and this keeps a hash of it, which
 * is what lets an account fit inside 10 ms of CPU.
 *
 * The paths and the response envelope are the Express backend's, unchanged.
 * The devices are not being rewritten; they are being pointed somewhere else.
 */

/** Routes reachable without a session, because they are how you get one. */
const OPEN: Record<string, (request: Request, env: Env) => Promise<Response>> = {
  'POST /api/accounts/register': register,
  'POST /api/accounts/login': login,
  'GET /api/accounts/salt': accountSalt
};

/**
 * The routes that exist and need a session, listed so that "does this exist"
 * can be answered before "who are you".
 *
 * Kept beside the switch below rather than derived from it, because a switch
 * is not a value. The test that walks this set against the handler is what
 * stops the two drifting: a route added to one and not the other either 404s
 * when it should work, or is never reached.
 */
const ACCOUNT_ROUTES = new Set([
  'GET /api/accounts/me',
  'POST /api/accounts/picture',
  'POST /api/accounts/keys',
  'GET /api/accounts/providers',
  'POST /api/accounts/providers',
  'GET /api/accounts/providers/active',
  'GET /api/accounts/invites',
  'POST /api/accounts/invites',
  'GET /api/devices/changes',
  'POST /api/devices/changes',
  'GET /api/devices/settings',
  'POST /api/devices/settings',
  'GET /api/subtitles/config',
  'GET /api/tmdb/config',
  'GET /api/subtitles/account',
  'POST /api/subtitles/account',
  'DELETE /api/subtitles/account',
  'GET /api/subtitles',
  'POST /api/subtitles',
  'GET /api/family',
  'POST /api/family/key',
  'POST /api/family/managed-keys',
  'POST /api/family/members',
  'POST /api/family/leave',
  'POST /api/family/join',
  'GET /api/accounts/tools',
  'GET /api/accounts/tools/requests',
  'GET /api/accounts/tools/actions',
  'POST /api/accounts/tools/actions'
]);

/** One thing a tool asked the app to do: asked about by the tool, answered by the app. */
const TOOL_ACTION_ROUTE = /^(GET|POST) \/api\/accounts\/tools\/actions\/([0-9a-f]{32})$/;

/** A tool's sign-in request, asked about by the tool itself: open, with its secret. */
const TOOL_POLL_ROUTE = /^GET \/api\/tools\/requests\/([0-9a-f]{32})$/;

/** Allowing or refusing a tool's sign-in request, from a device of the account. */
const TOOL_ANSWER_ROUTE = /^POST \/api\/accounts\/tools\/requests\/([0-9a-f]{32})$/;

/** Signing a tool out names it in the path. */
const TOOL_ROUTE = /^DELETE \/api\/accounts\/tools\/([^/]+)$/;

/** One account below the caller, and what to do with it. */
const MEMBER_ROUTE = /^(POST|DELETE) \/api\/family\/members\/(\d+)(?:\/(session|password|release))?$/;

/** Removing a provider names it in the path, so it cannot be a fixed string. */
const PROVIDER_ROUTE = /^DELETE \/api\/accounts\/providers\/(.+)$/;

/** Cancelling an invite names it in the path. */
const INVITE_ROUTE = /^DELETE \/api\/accounts\/invites\/(\d+)$/;

/**
 * What a caller may not do, before any handler runs (shared/family.ts).
 *
 * A kid changes nothing but its favourites and what it watched; a member
 * makes no invites, since an invite brings somebody into the family; and a
 * manager setting an account up reaches its setup and not what it watched,
 * nor its password or its invites. The change feed is narrowed rather than
 * refused (`kindsAllowed`), because a device pushes everything it has at once.
 */
const KID_REFUSED = new Set([
  'POST /api/accounts/keys',
  'POST /api/accounts/providers',
  'POST /api/accounts/invites',
  'POST /api/devices/settings',
  'POST /api/subtitles/account',
  'DELETE /api/subtitles/account'
]);

const SETUP_REFUSED = new Set([
  'POST /api/accounts/keys',
  'GET /api/accounts/invites',
  'POST /api/accounts/invites',
  'GET /api/subtitles',
  'POST /api/subtitles'
]);

/**
 * What the tvinto tool is never let do, whatever the account's role:
 * the password and keys, the family's keys and members,
 * and the OpenSubtitles login. Those stay with a person at the app. Nor does
 * it list the account's tools -- the account's own devices do that -- or write
 * settings outside the change feed, where the parental lock is guarded
 * (`touchesLock`) and its changes are counted.
 */
const TOOL_REFUSED = new Set([
  'POST /api/accounts/keys',
  'POST /api/family/key',
  'POST /api/family/managed-keys',
  'POST /api/family/members',
  'POST /api/family/leave',
  'POST /api/family/join',
  'GET /api/subtitles/account',
  'POST /api/subtitles/account',
  'DELETE /api/subtitles/account',
  'GET /api/accounts/tools',
  'GET /api/accounts/tools/requests',
  'GET /api/accounts/tools/actions',
  'POST /api/devices/settings'
]);

/**
 * The account's saved subtitles: one row per title it added one for, which is
 * a record of what it watched. A tool sees them only with history allowed.
 */
const isSubtitleListRoute = (route: string): boolean =>
  route === 'GET /api/subtitles' || route === 'POST /api/subtitles' || SUBTITLE_ROUTE.test(route);

const refusal = (caller: Caller, route: string): string | null => {
  // A session another made is not the account's own: it never changes the
  // password, and one a tool made carries the tool's limits.
  if (caller.mintedBy && route === 'POST /api/accounts/keys') {
    return 'Only the account itself can change its password';
  }
  if (caller.mintedBy?.tool && TOOL_REFUSED.has(route)) {
    return 'A tool cannot do this; do it in the app';
  }
  if (caller.scope === 'tool' && isSubtitleListRoute(route)) {
    return 'This tool was not allowed to see what the account watched';
  }
  if (isToolScope(caller.scope)) {
    // A member's role and household, and a session to set the member up, are
    // a tool's to change (12 October: "I want AI to be able to do
    // pretty much anything"). Adding, removing, releasing and resetting a
    // member's password are the app's, on a person's click.
    const member = MEMBER_ROUTE.exec(route);
    const memberAllowed = member !== null && member[1] === 'POST' && (member[3] === undefined || member[3] === 'session');
    const action = TOOL_ACTION_ROUTE.exec(route);
    if (TOOL_REFUSED.has(route) || (member && !memberAllowed) || TOOL_ANSWER_ROUTE.test(route) || action?.[1] === 'POST') {
      return 'A tool cannot do this; do it in the app';
    }
    const tool = TOOL_ROUTE.exec(route);
    if (tool && tool[1] !== caller.sessionId) {
      return 'A tool can sign itself out and no other';
    }
    // Otherwise as the account's own role allows: a kid's tool is a kid.
  }
  if (caller.scope === 'setup') {
    // The account's own role is about its own devices. Somebody above it
    // setting it up -- a kid's above all -- is exactly who may change it.
    if (
      SETUP_REFUSED.has(route) ||
      SUBTITLE_ROUTE.test(route) ||
      INVITE_ROUTE.test(route) ||
      route === 'GET /api/accounts/tools/requests' ||
      TOOL_ANSWER_ROUTE.test(route) ||
      route.includes('/api/accounts/tools/actions')
    ) {
      return 'Setting somebody up does not reach what they watch, their password or their invites';
    }
    return null;
  }
  if (caller.role === 'kid' && (KID_REFUSED.has(route) || PROVIDER_ROUTE.test(route) || INVITE_ROUTE.test(route))) {
    return 'This account is set up by somebody else';
  }
  if (caller.role === 'member' && (route === 'POST /api/accounts/invites' || INVITE_ROUTE.test(route))) {
    return 'Only an admin can invite somebody into the family';
  }
  return null;
};

/** The hash of the token this request carries, to mark the caller's own session in a list. */
const currentHash = async (request: Request): Promise<string | null> => {
  const token = bearerToken(request);
  return token ? hashToken(token) : null;
};

const handle = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const route = `${request.method} ${path}`;

  if (path === '/' || path === '/api' || path === '/api/health') {
    // `service` is how a device tells this apart from the Express backend,
    // which answers the same path. It matters because the two want different
    // things in a subscription: that one takes the credentials and encrypts
    // them itself, and this one takes ciphertext and could not read them if it
    // wanted to. Sending the wrong shape to either is not a small mistake.
    //
    // `registration` is how the sign-in page knows whether an account here
    // needs an invite: on a server somebody has just set up for themselves
    // (`first-only`, nobody signed up yet) it does not, and the app asking
    // for a code nobody could have given them was a locked front door.
    return new Response(
      JSON.stringify({
        success: true,
        // `tools`: this service knows tool sessions, so the tvinto CLI can
        // sign in here -- and can say so before it asks
        // for a password, when a service does not.
        data: { status: 'ok', service: 'sync', registration: await registrationMode(env), tools: true, toolApproval: true, toolConfirm: true }
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Ahead of the session, deliberately: an app asking whether there is a newer
  // version has nobody signed in to it, and it is running the very code it is
  // about to replace. Making an update depend on an account would mean a bug
  // in accounts could stop the fix for itself from arriving.
  if (path.startsWith('/updates/')) {
    return serveUpdate(request, env, path);
  }

  // The other half of the same bucket: the page a person installs from, and
  // two paths short enough to type with a television remote. `/a` and `/w` are
  // one letter because every one of them is an arrow-key journey around an
  // on-screen keyboard in the Downloader app -- see src/downloads.ts.
  if (path === '/downloads') {
    return downloadsPage(request, env);
  }
  if (path === '/a') {
    return latestDownload(env, 'android');
  }
  if (path === '/w') {
    return latestDownload(env, 'desktop');
  }

  const open = OPEN[route];
  if (open) {
    return open(request, env);
  }

  // A tool asking to be let in, and asking how that went: no session yet,
  // which is the point (src/toolRequests.ts).
  if (route === 'POST /api/tools/requests') {
    return createToolRequest(request, env);
  }
  const poll = TOOL_POLL_ROUTE.exec(route);
  if (poll) {
    return pollToolRequest(request, env, poll[1]);
  }

  /*
   * Does this endpoint exist at all, before asking who is calling it.
   *
   * It used to be the other way round, and everything unknown came back 401.
   * Two things wrong with that. A browser asks any page for `/favicon.ico`,
   * `/apple-touch-icon.png` and `/manifest.json` unprompted, so the public
   * downloads page logged three console errors on every load -- which is how
   * this was found. And "sign in to continue" is not true of a path that does
   * not exist: it tells an anonymous caller that something is there.
   *
   * 404 first, then 401. A real endpoint asked for without a session still
   * says so.
   */
  if (
    !ACCOUNT_ROUTES.has(route) &&
    !PROVIDER_ROUTE.test(route) &&
    !SUBTITLE_ROUTE.test(route) &&
    !INVITE_ROUTE.test(route) &&
    !MEMBER_ROUTE.test(route) &&
    !TOOL_ROUTE.test(route) &&
    !TOOL_ANSWER_ROUTE.test(route) &&
    !TOOL_ACTION_ROUTE.test(route)
  ) {
    throw new HttpError('No such endpoint', 404);
  }

  // Everything below is about one account, so it needs to know which.
  const caller = await resolveSession(env.DB, request);
  if (caller === null) {
    throw new HttpError('Sign in to continue', 401);
  }
  const { userId } = caller;

  const refused = refusal(caller, route);
  if (refused) {
    throw new HttpError(refused, 403);
  }

  switch (route) {
    case 'GET /api/accounts/me':
      return me(env, userId);
    case 'POST /api/accounts/picture':
      return setPicture(request, env, userId);
    case 'POST /api/accounts/keys':
      return replaceKeys(request, env, userId);

    case 'GET /api/accounts/providers':
      return listProviders(env, userId);
    case 'POST /api/accounts/providers':
      return saveProvider(request, env, userId);
    case 'GET /api/accounts/providers/active':
      return activeProvider(env, userId);

    case 'GET /api/accounts/invites':
      return listInvites(env, userId);
    case 'POST /api/accounts/invites':
      return createInvite(env, userId);

    case 'GET /api/accounts/tools/requests':
      return listToolRequests(env, caller);
    case 'GET /api/accounts/tools/actions':
      return listToolActions(env, caller);
    case 'POST /api/accounts/tools/actions':
      return createToolAction(request, env, caller);
    case 'GET /api/accounts/tools':
      return ok({ tools: await listToolSessions(env.DB, userId, await currentHash(request)) });

    case 'GET /api/devices/changes':
      return pullChanges(request, env, userId, kindsVisible(caller.scope));
    case 'POST /api/devices/changes':
      return pushChanges(
        request,
        env,
        userId,
        kindsAllowed(caller.role, caller.scope),
        actsAsTool(caller) ? changes => chargeToolChanges(env.DB, toolChargeId(caller), changes) : undefined,
        actsAsTool(caller)
      );
    case 'GET /api/devices/settings':
      return getSettings(env, userId);
    case 'POST /api/devices/settings':
      return saveSettings(request, env, userId);

    case 'GET /api/tmdb/config':
      return tmdbConfig(env);
    case 'GET /api/subtitles/config':
      return subtitlesConfig(env);
    case 'GET /api/subtitles/account':
      return getSubtitleAccount(env, userId);
    case 'POST /api/subtitles/account':
      return saveSubtitleAccount(request, env, userId);
    case 'DELETE /api/subtitles/account':
      return forgetSubtitleAccount(env, userId);
    case 'GET /api/subtitles':
      return listSubtitles(request, env, userId);
    case 'POST /api/subtitles':
      return addSubtitle(request, env, userId);

    case 'GET /api/family':
      return getFamily(env, caller);
    case 'POST /api/family/key':
      return saveOwnKey(request, env, caller);
    case 'POST /api/family/managed-keys':
      return saveManagedKeys(request, env, caller);
    case 'POST /api/family/members':
      return addMember(request, env, caller);
    case 'POST /api/family/leave':
      return leaveFamily(env, caller);
    case 'POST /api/family/join':
      return joinFamily(request, env, caller);
  }

  const member = MEMBER_ROUTE.exec(route);
  if (member) {
    const [, method, id, action] = member;
    const memberId = Number(id);
    if (method === 'DELETE') {
      if (action) {
        throw new HttpError('No such endpoint', 404);
      }
      return deleteMember(env, caller, memberId);
    }
    switch (action) {
      case 'session':
        return memberSession(request, env, caller, memberId);
      case 'password':
        return resetMemberPassword(request, env, caller, memberId);
      case 'release':
        return releaseMember(env, caller, memberId);
      default:
        return changeMember(request, env, caller, memberId);
    }
  }

  // After the fixed routes, so /api/subtitles/config is never read as an id.
  const subtitle = SUBTITLE_ROUTE.exec(route);
  if (subtitle) {
    const [, method, id] = subtitle;
    if (method === 'GET') {
      return getSubtitle(env, userId, id);
    }
    if (method === 'POST') {
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
    return action[1] === 'GET' ? toolActionStatus(env, caller, action[2]) : answerToolAction(request, env, caller, action[2]);
  }

  const answer = TOOL_ANSWER_ROUTE.exec(route);
  if (answer) {
    return answerToolRequest(request, env, caller, answer[1]);
  }

  const tool = TOOL_ROUTE.exec(route);
  if (tool) {
    if (!(await endToolSession(env.DB, userId, tool[1]))) {
      throw new HttpError('No such tool on this account', 404);
    }
    return ok({ signedOut: tool[1] });
  }

  const provider = PROVIDER_ROUTE.exec(route);
  if (provider) {
    return removeProvider(env, userId, decodeURIComponent(provider[1]));
  }

  throw new HttpError('No such endpoint', 404);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const response = await handle(request, env);

      // Added here rather than in every handler, so a route added later cannot
      // forget them and work everywhere except in a browser.
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(cors)) {
        headers.set(name, value);
      }

      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      if (error instanceof HttpError) {
        return fail(error.message, error.status, cors);
      }

      // Logged, and not returned. What went wrong here is this service's
      // business; what the caller gets is that it did.
      console.error('Unhandled failure', error);
      return fail('Something went wrong', 500, cors);
    }
  }
};
