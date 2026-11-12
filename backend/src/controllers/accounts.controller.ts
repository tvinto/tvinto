import { Request, Response } from 'express';
import { TypedRequest } from '../types/express';
import { AccountError, SubmittedKeys, accountsService } from '../services/accounts.service';
import { sessionStore } from '../utils/sessions';
import { errorResponse } from '../utils/errorHandler';
import { xtreamService } from '../services/xtream.service';

/** Turns a thrown AccountError into its own status, anything else into a 500. */
const fail = (res: Response, error: unknown, fallback: string): void => {
  if (error instanceof AccountError) {
    errorResponse(res, error.message, error.statusCode);
    return;
  }
  console.error(fallback, error);
  errorResponse(res, fallback, 500);
};

/**
 * Creates an account.
 *
 * Open, because there has to be a way to make the first one. On an install
 * reachable from anywhere this is the door to bolt: see ACCOUNT_REGISTRATION
 * in .env.example.
 */
export const register = async (
  req: TypedRequest<{ username: string; password: string; keys?: SubmittedKeys }>,
  res: Response
): Promise<void> => {
  const { username, password, keys } = req.body || {};

  if (registrationClosed()) {
    errorResponse(res, 'Registration is closed on this server', 403);
    return;
  }

  try {
    const user = await accountsService.register(username, password, keys);
    const token = sessionStore.createForUser(user.id);

    // Signed in straight away: making an account and then being asked to prove
    // it is ceremony with nothing behind it.
    res.status(201).json({ success: true, data: { token, user } });
  } catch (error) {
    fail(res, error, 'Failed to create the account');
  }
};

/** Whether new accounts may be created. Open unless deliberately closed. */
const registrationClosed = (): boolean => {
  const setting = (process.env.ACCOUNT_REGISTRATION || '').trim().toLowerCase();
  if (setting === 'closed') {
    return true;
  }
  // "first-only" leaves the door open exactly until it has been used once.
  return setting === 'first-only' && accountsService.hasAnyUser();
};

/**
 * The salt and cost a device needs before it can derive anything.
 *
 * Necessarily open: signing in cannot start without it. An unknown name gets
 * an answer too -- see `saltFor` -- so this cannot be used to find out which
 * accounts exist.
 */
export const accountSalt = async (req: Request, res: Response): Promise<void> => {
  const username = String(req.query['username'] ?? '').trim();

  if (!username) {
    errorResponse(res, 'A username is required', 400);
    return;
  }

  try {
    res.status(200).json({ success: true, data: await accountsService.saltFor(username) });
  } catch (error) {
    fail(res, error, 'Failed to look up the salt');
  }
};

/**
 * Signs in, with either the derived key or the password itself.
 *
 * Both, for as long as it takes to move every device. A client that derives
 * sends `auth` and the password never leaves it; one that has not been updated
 * sends `password` and is answered the way it always was. Neither is told
 * which the account has on file, because that is the same question as whether
 * the account exists.
 */
export const login = async (
  req: TypedRequest<{ username: string; password: string; auth?: string }>,
  res: Response
): Promise<void> => {
  const { username, password, auth } = req.body || {};

  if (!username || (!password && !auth)) {
    errorResponse(res, 'Username and password are required', 400);
    return;
  }

  try {
    const user = auth
      ? await accountsService.authenticateWithVerifier(username, auth)
      : await accountsService.authenticate(username, password);
    if (!user) {
      // One message for both a wrong password and an unknown name, so this
      // cannot be used to find out which accounts exist.
      errorResponse(res, 'Incorrect username or password', 401);
      return;
    }

    const token = sessionStore.createForUser(user.id);
    const providers = accountsService.listProviderAccounts(user.id);

    res.status(200).json({
      success: true,
      data: {
        token,
        user,
        // The client needs to know whether to send them to the browse view or
        // straight to "add your subscription".
        hasSubscription: providers.some(p => p.active),
        // Whether this account has keys on file. Safe to say here and nowhere
        // else: by this point they have proved the password, so it is their
        // own account's state rather than an answer to a stranger. A client
        // that signed in with a password and sees false should derive and
        // enrol, which is how an account moves over.
        enrolled: accountsService.hasAccountKeys(user.id)
      }
    });
  } catch (error) {
    fail(res, error, 'Failed to sign in');
  }
};

/** The signed-in account and its subscriptions. Never the secrets. */
export const me = (req: Request, res: Response): void => {
  const user = accountsService.findById(req.userId!);
  if (!user) {
    errorResponse(res, 'No such account', 404);
    return;
  }

  res.status(200).json({
    success: true,
    data: { user, providers: accountsService.listProviderAccounts(user.id) }
  });
};

/**
 * Records the keys this device derived, for this account.
 *
 * Behind a session. The first keys need nothing more: the caller has just
 * proved the password by signing in with it. Replacing keys takes the current
 * password as well (`currentPassword` in the body).
 */
export const setKeys = async (
  req: TypedRequest<SubmittedKeys & { currentPassword?: string }>,
  res: Response
): Promise<void> => {
  try {
    await accountsService.setAccountKeys(req.userId!, req.body, req.body?.currentPassword);
    res.status(200).json({ success: true, data: { enrolled: true } });
  } catch (error) {
    fail(res, error, 'Failed to store the account keys');
  }
};

export const changePassword = async (
  req: TypedRequest<{ currentPassword: string; newPassword: string; keys?: SubmittedKeys }>,
  res: Response
): Promise<void> => {
  const { currentPassword, newPassword, keys } = req.body || {};

  try {
    await accountsService.changePassword(req.userId!, currentPassword, newPassword, keys);

    // Every other device is now holding a token minted under the old password.
    // Changing a password is often a response to it being known by someone
    // else, so those go.
    sessionStore.destroyForUser(req.userId!);
    const token = sessionStore.createForUser(req.userId!);

    res.status(200).json({ success: true, data: { token } });
  } catch (error) {
    fail(res, error, 'Failed to change the password');
  }
};

export const listProviders = (req: Request, res: Response): void => {
  res.status(200).json({
    success: true,
    data: accountsService.listProviderAccounts(req.userId!)
  });
};

/**
 * Attaches a subscription, checking it against the provider first.
 *
 * Storing credentials that do not work would leave the account looking set up
 * while every later request failed, so they are tried once here. A provider
 * that cannot be reached is not the same as a refusal: the credentials are
 * kept, and the response says they went unverified.
 */
export const addProvider = async (
  req: TypedRequest<{ serverUrl: string; username: string; password: string; label?: string }>,
  res: Response
): Promise<void> => {
  const { serverUrl, username, password, label } = req.body || {};

  if (!serverUrl || !username || !password) {
    errorResponse(res, 'Server URL, username and password are required', 400);
    return;
  }

  let verified = false;
  try {
    await xtreamService.authenticate(username, password, serverUrl);
    verified = true;
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    // Xtream reports bad credentials as HTTP 200 with auth: 0, which surfaces
    // here as a 401. Anything else is the provider being unreachable, and
    // refusing on that would make an outage look like a typo.
    if (status === 401) {
      errorResponse(res, 'The provider rejected those credentials', 401);
      return;
    }
    console.warn('Could not verify the subscription; storing it unverified', error);
  }

  try {
    const account = accountsService.addProviderAccount(
      req.userId!,
      {
        serverUrl,
        username,
        password,
        label
      },
      verified
    );

    const claimed = accountsService.countLegacyData(username);

    res.status(201).json({
      success: true,
      data: { provider: account, verified, unclaimedRowsRemaining: claimed }
    });
  } catch (error) {
    fail(res, error, 'Failed to store the subscription');
  }
};

/**
 * Hands the active subscription's credentials to the signed-in account.
 *
 * The one route that deliberately returns a provider password, and it exists
 * because a device that talks to the provider itself has no other way to get
 * one. Xtream has no notion of a session or a token: every request carries the
 * username and password, and a playback URL embeds them in its path. A native
 * client that cannot hold them cannot work without this server running, which
 * is the whole thing the native build is for.
 *
 * It is the account's own subscription, returned over its own session, which is
 * the same thing the user typed in to store it. What it does mean is that a
 * client holding this is as good as the credentials until they are renewed --
 * so nothing asks for it unless it is going to use it, and the browser build
 * never does.
 */
export const providerCredentials = (req: Request, res: Response): void => {
  const credentials = accountsService.getActiveCredentials(req.userId!);

  if (!credentials) {
    errorResponse(res, 'No usable subscription is attached to this account', 404);
    return;
  }

  res.status(200).json({
    success: true,
    data: {
      providerAccountId: credentials.providerAccountId,
      serverUrl: credentials.serverUrl,
      username: credentials.username,
      password: credentials.password
    }
  });
};

export const removeProvider = (req: Request<{ id: string }>, res: Response): void => {
  const id = parseInt(req.params.id, 10);

  if (!Number.isInteger(id)) {
    errorResponse(res, 'A subscription id is required', 400);
    return;
  }

  const removed = accountsService.removeProviderAccount(req.userId!, id);
  if (!removed) {
    errorResponse(res, 'No such subscription', 404);
    return;
  }

  res.status(200).json({ success: true, data: { removed: true } });
};
