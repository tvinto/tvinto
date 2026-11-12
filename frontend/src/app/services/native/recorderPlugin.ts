import { Capacitor, PluginListenerHandle, registerPlugin } from '@capacitor/core';

/** Android's recorder (recording/RecorderPlugin.java), and the desktop's. */
export interface RecorderPlugin {
  /** Records `url` until `endsAt` (ms since 1970). The address carries a login: never logged. */
  start(options: { id: string; url: string; title: string; channel: string; channelId: string; endsAt: number }): Promise<{ id: string }>;
  /** A recording being made, served on this device only from near its newest part: watching without a second connection. */
  watchAddress(options: { id: string }): Promise<{ url: string }>;
  stop(options: { id: string }): Promise<void>;
  /** Books a recording: an alarm starts it a minute before `startMs`; it runs until `endsAt`. */
  book(options: { id: string; url: string; title: string; channel: string; channelId: string; startMs: number; endsAt: number }): Promise<void>;
  cancelBooking(options: { id: string }): Promise<void>;
  /** Raw, without addresses; read with readBookings (shared/recording). */
  bookings(): Promise<{ bookings: unknown }>;
  /** Raw descriptions; read with readRecordings (shared/recording). */
  list(): Promise<{ recordings: unknown }>;
  remove(options: { id: string }): Promise<{ removed: boolean }>;
  /** The drives recordings can go to; read with readVolumes (shared/recording). Absent on the desktop and older APKs. */
  volumes?(): Promise<{ volumes: unknown }>;
  chooseVolume?(options: { id: string }): Promise<{ chosen: boolean }>;
  addListener(event: 'changed', listener: (changed: { id: string }) => void): Promise<PluginListenerHandle>;
}

/** The desktop's recorder (electron/src/recorder.ts), as its preload hands it over. */
type DesktopRecorder = Omit<RecorderPlugin, 'addListener'> & { onChanged(listener: (id: string) => void): () => void };

const desktop = (): DesktopRecorder | null =>
  typeof window === 'undefined' ? null : ((window as { xtreamDesktop?: { recorder?: DesktopRecorder } }).xtreamDesktop?.recorder ?? null);

/** Android's recorder, or the desktop's with the same calls; null where neither records. */
export function recorderHere(): RecorderPlugin | null {
  const onDesktop = desktop();
  if (onDesktop) {
    return {
      ...onDesktop,
      addListener: async (_event, listener) => {
        const stop = onDesktop.onChanged(id => listener({ id }));
        return { remove: async () => stop() };
      }
    };
  }
  return Capacitor.getPlatform() === 'android' ? AndroidRecorder : null;
}

const AndroidRecorder = registerPlugin<RecorderPlugin>('Recorder');
