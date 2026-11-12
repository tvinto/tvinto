/**
 * Which links the desktop app opens in the person's own browser: the
 * project's pages, and nothing else (externalLinks.ts does the opening).
 *
 * The app opens no windows of its own (setup.ts), so a link on a page has
 * nowhere to go. This is the way out for the few that must -- the guide to
 * running a sync service of one's own, on the sign-in page. Limited to the
 * project's repository, so that nothing the page is shown (a provider's
 * channel names, a guide's descriptions) can become something the app opens.
 *
 * Kept apart from Electron so that it can be tested where Electron is not
 * installed, as in CI.
 */
const PROJECT = 'https://github.com/tvinto/';

export const isProjectLink = (url: unknown): url is string => {
  if (typeof url !== 'string' || !url.startsWith(PROJECT)) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.host === 'github.com' &&
      parsed.pathname.startsWith('/tvinto/') &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
};
