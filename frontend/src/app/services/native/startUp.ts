import { Capacitor, registerPlugin } from '@capacitor/core';

/** Opening the app when the television is turned on (device/StartUpPlugin.java). */
export interface StartUpState {
  /** Asked for on this device. */
  enabled: boolean;
  /** Android lets the app open itself: "Display over other apps" is granted. */
  allowed: boolean;
  /** The device has a page to grant it on. */
  canAsk: boolean;
}

interface StartUpPlugin {
  state(): Promise<StartUpState>;
  set(options: { enabled: boolean }): Promise<StartUpState>;
  ask(): Promise<{ opened: boolean }>;
}

const plugin = registerPlugin<StartUpPlugin>('StartUp');

/** Null wherever there is no such plugin: a browser, the desktop, an APK before 1.0.121. */
export const startUp: StartUpPlugin | null =
  Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('StartUp') ? plugin : null;
