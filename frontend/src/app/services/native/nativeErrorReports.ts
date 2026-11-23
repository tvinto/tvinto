import { Capacitor, PluginListenerHandle, registerPlugin } from '@capacitor/core';

/**
 * The Android app's own crashes -- Java, native, the app not responding --
 * kept on the device as Sentry wrote them, until the page says what to do
 * with them (device/ErrorReportsPlugin.java). The page cleans them with
 * everything else and sends them through its own Sentry, so there is one
 * cleaning step and one switch.
 */
interface NativeErrorReportsPlugin {
  /** The switch. Off deletes what is kept and stops catching, from this launch and the next. */
  set(options: { on: boolean }): Promise<void>;
  /** What is kept, as Sentry's event JSON, and forgotten on the device. */
  take(): Promise<{ events: string[] }>;
  /** A crash or a hang caught while the app runs, kept and waiting to be taken. */
  addListener(event: 'kept', listener: () => void): Promise<PluginListenerHandle>;
}

const plugin = registerPlugin<NativeErrorReportsPlugin>('ErrorReports');

/** Null wherever there is no such plugin: a browser, the desktop, an APK before this one. */
export const nativeErrorReports: NativeErrorReportsPlugin | null =
  Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('ErrorReports') ? plugin : null;
