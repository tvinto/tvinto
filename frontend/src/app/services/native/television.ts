import { Capacitor, registerPlugin } from '@capacitor/core';

interface TelevisionPlugin {
  isTelevision(): Promise<{ television: boolean }>;
}

/**
 * Whether Android says this device is a television (TelevisionPlugin.java).
 *
 * False wherever the plugin is not -- a browser, the desktop, an APK older than
 * 1.0.24 -- which leaves those to the first press of a D-pad key, as before.
 * A failure is also false: the fallback is the old behaviour, not a crash.
 */
export const platformSaysTelevision = async (): Promise<boolean> => {
  try {
    if (!Capacitor.isPluginAvailable('Television')) {
      return false;
    }
    return (await registerPlugin<TelevisionPlugin>('Television').isTelevision()).television === true;
  } catch {
    return false;
  }
};
