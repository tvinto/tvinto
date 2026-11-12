/**
 * Deciding whether to take a new web bundle, and refusing to when it is wrong.
 *
 * The app on a phone is two things installed at different times: an APK, which
 * carries the native code, and a bundle of web files, which carries almost
 * everything else. Most changes are only the second, so the second can be
 * replaced without anybody plugging anything in.
 *
 * That is also where it can go wrong, and the two ways it goes wrong are both
 * silent. A bundle built against native code the installed APK has not got
 * calls a plugin that is not there. A bundle that fails to start leaves a white
 * screen and no way to ask for a different one. So the rules for taking one
 * live here, on their own, where they can be read and tested -- the part that
 * downloads it is native and the part that runs it is Android, and neither is
 * somewhere a decision should hide.
 */

/** What the service publishes about the current bundle. */
export interface WebBundleManifest {
  /** The bundle's version, on the same number line as the APK's. */
  version: string;
  /** Its file name beside the manifest, or its https address (isFeedFile). */
  file: string;
  /** Lower-case hex, 64 characters. Checked on the device before unpacking. */
  sha256: string;
  /**
   * The oldest APK this bundle will run on.
   *
   * The APK the bundle was built against. A phone on an older one keeps what
   * it has: a bundle calling a plugin the installed APK does not carry fails
   * at the moment somebody uses the feature, which may be days later and looks
   * like anything but an update.
   */
  minNative: string;
}

/** Why a bundle was or was not taken. Every branch is a sentence. */
export type UpdateDecision =
  | { take: true; manifest: WebBundleManifest }
  | {
      take: false;
      because: 'nothing-published' | 'not-newer' | 'needs-a-newer-app' | 'refused-before';
    };

/**
 * File names the update route will serve.
 *
 * Deliberately the same rule as `worker/src/updates.ts`, and the reason it is
 * repeated rather than shared is that they are two programs -- but a manifest
 * naming a file the route will not serve is a download that 404s forever, so
 * the disagreement is worth catching here, on the device, before it is asked
 * for.
 */
const SERVABLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * What a manifest may name: a file beside it, by the rule above, or an https
 * address -- on GitHub Releases each version's files are in a release of
 * their own, apart from the feed (frontend/scripts/feed.js). The hash beside
 * the name is what makes either safe to take.
 */
export const isFeedFile = (file: string): boolean => {
  if (SERVABLE.test(file)) {
    return true;
  }
  try {
    const url = new URL(file);
    return url.protocol === 'https:' && !url.username && !url.password && file.length <= 512;
  } catch {
    return false;
  }
};

const VERSION = /^\d+(\.\d+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Compares two versions the way a person reads them.
 *
 * Segment by segment, numerically, with a missing segment counting as zero --
 * so 1.2 and 1.2.0 are the same version, and 1.10 is newer than 1.9 rather
 * than older, which is what a string comparison would say.
 */
export const compareVersions = (a: string, b: string): number => {
  const left = a.split('.');
  const right = b.split('.');

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = Number(left[i] ?? 0) - Number(right[i] ?? 0);
    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }

  return 0;
};

/**
 * The manifest, or null if it is not one.
 *
 * Every field is checked, including the ones that "cannot" be wrong. This is
 * the one message that tells a device to replace itself, and it is fetched
 * over the network from a file somebody edits by hand.
 */
export const parseBundleManifest = (raw: unknown): WebBundleManifest | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const { version, file, sha256, minNative } = raw as Record<string, unknown>;

  if (typeof version !== 'string' || !VERSION.test(version)) {
    return null;
  }
  if (typeof file !== 'string' || !isFeedFile(file)) {
    return null;
  }
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) {
    return null;
  }
  if (typeof minNative !== 'string' || !VERSION.test(minNative)) {
    return null;
  }

  return { version, file, sha256, minNative };
};

/**
 * Whether to take what has been published.
 *
 * `running` is the bundle in use -- the downloaded one, or the APK's own
 * version when it is still serving what it shipped with. `app` is the APK's
 * version, which is what says whether the native half is new enough.
 * `pending` is a bundle already downloaded and waiting for the next launch.
 */
export const decideUpdate = (found: {
  manifest: WebBundleManifest | null;
  running: string;
  app: string;
  /** A version that has already been installed and failed to start. */
  refused: string | null;
  pending?: string | null;
}): UpdateDecision => {
  const { manifest, app, refused, pending } = found;

  // Newer than what is waiting, not merely newer than what is running. The
  // device used to report a waiting bundle as the running one, which hid this;
  // told the truth, a phone with 1.0.18 downloaded and not yet started would
  // otherwise fetch 1.0.18 again on every check until it was restarted.
  const running =
    pending && compareVersions(pending, found.running) > 0 ? pending : found.running;

  if (!manifest) {
    return { take: false, because: 'nothing-published' };
  }

  if (refused && compareVersions(manifest.version, refused) === 0) {
    // Taken once, and it did not start. Offering it again would be a loop that
    // costs a download every launch and ends in the same white screen.
    return { take: false, because: 'refused-before' };
  }

  if (compareVersions(manifest.version, running) <= 0) {
    return { take: false, because: 'not-newer' };
  }

  if (compareVersions(manifest.minNative, app) > 0) {
    return { take: false, because: 'needs-a-newer-app' };
  }

  return { take: true, manifest };
};

/**
 * When a television, which never closes the app, takes an update that is
 * waiting (2 October: "my app never restarts so I don't see the
 * new updates").
 *
 * Only when it costs nobody anything: coming back to the app after being
 * away a while -- the set woken from standby, or another app left -- which
 * looks exactly like the app starting; or the app left untouched for a long
 * time with nothing playing. Never in the middle of somebody using it: then
 * the "update ready" bar offers it instead. And never because the app's own
 * player closed, which is a return to where the person was.
 */
export const AWAY_LONG_ENOUGH_MS = 15 * 60 * 1000;
export const IDLE_LONG_ENOUGH_MS = 30 * 60 * 1000;

export type ApplyMoment = 'returned' | 'idle' | null;

export const momentToApply = (now: {
  waiting: boolean;
  playing: boolean;
  /** How long the app had been out of sight, if it has just come back; else null. */
  returnedAfterMs: number | null;
  /** Since the last key press or touch. */
  idleMs: number;
  visible: boolean;
}): ApplyMoment => {
  if (!now.waiting || now.playing || !now.visible) {
    return null;
  }
  if (now.returnedAfterMs !== null && now.returnedAfterMs >= AWAY_LONG_ENOUGH_MS) {
    return 'returned';
  }
  return now.idleMs >= IDLE_LONG_ENOUGH_MS ? 'idle' : null;
};
