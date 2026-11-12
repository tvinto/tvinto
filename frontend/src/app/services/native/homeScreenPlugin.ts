import { Capacitor, registerPlugin } from '@capacitor/core';
import { HomeRowItem, PlayNextItem } from '../../utils/home-screen.utils';

interface HomeScreenPlugin {
  publish(options: { rowName: string; channels: HomeRowItem[]; playNext: PlayNextItem[] }): Promise<{ published: boolean }>;
}

const plugin = registerPlugin<HomeScreenPlugin>('HomeScreen');

/**
 * The television's home screen (HomeScreenPlugin.java), or null where the APK
 * has none -- older than 1.0.58, or no APK at all. On a phone it is there and
 * answers that it published nothing.
 */
export function homeScreen(): HomeScreenPlugin | null {
  return Capacitor.isPluginAvailable('HomeScreen') ? plugin : null;
}
