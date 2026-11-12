import { PluginListenerHandle, registerPlugin } from '@capacitor/core';

/** The page on the home network while a form offers to be typed on a phone (PhoneFormPlugin.java). */
export interface PhoneFormPlugin {
  /** Serves `html` at the address returned until stop(), ten minutes, or five forms. */
  start(options: { html: string }): Promise<{ address: string }>;
  stop(): Promise<void>;
  /** What a phone posted to /send, as text: sealed, for phone-form.utils.ts to open. */
  addListener(event: 'formArrived', listener: (sent: { body: string }) => void): Promise<PluginListenerHandle>;
  /** It stopped by itself: the ten minutes ran out, or too many forms came. */
  addListener(event: 'closed', listener: () => void): Promise<PluginListenerHandle>;
}

export const PhoneForm = registerPlugin<PhoneFormPlugin>('PhoneForm');
