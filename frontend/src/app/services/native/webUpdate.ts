import { InjectionToken } from '@angular/core';
import { registerPlugin } from '@capacitor/core';

/** Where a running bundle came from, and what the phone is willing to run. */
export interface WebBundleState {
  /**
   * The version in use.
   *
   * The APK's own version when it is still serving the bundle it shipped with,
   * because that bundle *is* that version -- the two are built and released
   * together and share one number line.
   */
  version: string;

  /** The APK's version, which is what says whether native code is new enough. */
  app: string;

  /** Whether the bundle in use arrived over the air rather than in the APK. */
  downloaded: boolean;

  /**
   * A version that was installed and never confirmed itself started.
   *
   * The device rolled back to the bundle in the APK and remembered this, so
   * the same broken bundle is not fetched again on the next launch.
   */
  refused: string | null;

  /**
   * A bundle downloaded and waiting for the next launch, or null.
   *
   * Kept apart from `version`, which is only ever what this launch is serving.
   * The two used to be one answer, so a device that fetched a bundle a few
   * seconds after starting reported it as running when it was not -- which is
   * exactly the question asked when checking what a device runs. Absent on an
   * APK older than 1.0.3.
   */
  pending?: string | null;
}

export interface WebUpdatePlugin {
  /** What is running, without changing anything. */
  state(): Promise<WebBundleState>;

  /**
   * Fetch, check and unpack a bundle, to be used from the next launch.
   *
   * Never swapped underneath a running app: a reload in the middle of an
   * evening is not an improvement, and half the app's state lives in memory.
   */
  download(options: { url: string; version: string; sha256: string }): Promise<{ version: string }>;

  /**
   * Say that the bundle in use started properly.
   *
   * The whole of the rollback. A bundle that white-screens never reaches the
   * code that calls this, so after a few launches the device gives up on it
   * and goes back to the one in the APK -- which is the difference between a
   * bad release and a phone that has to be plugged in again.
   */
  confirm(): Promise<void>;

  /** Go back to the bundle in the APK. An escape hatch, for a person to use. */
  forget(): Promise<void>;

  /**
   * Start the web app again, on the bundle the next launch would serve --
   * so a waiting update takes effect now. From APK 1.0.36; older ones reject
   * it as unimplemented.
   */
  restart(): Promise<void>;
}

/**
 * Resolved lazily by Capacitor, and absent everywhere but Android.
 *
 * Behind a token rather than imported directly, because the decisions around
 * it are worth testing and a plugin that only exists inside an APK is not
 * something a test can have.
 */
export const WEB_UPDATE_PLUGIN = new InjectionToken<WebUpdatePlugin>('WEB_UPDATE_PLUGIN', {
  providedIn: 'root',
  factory: () => registerPlugin<WebUpdatePlugin>('WebUpdate')
});
