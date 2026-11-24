import { websiteDownload } from '../worker/src/downloads';

/** `/android`: the current APK. The TV's Downloader code points here, so this address must not change. */
export const onRequestGet = ({ env }: { env: { FEED?: string } }): Promise<Response> =>
  websiteDownload('android', env.FEED);
