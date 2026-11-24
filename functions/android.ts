import { websiteDownload } from '../worker/src/downloads';

/** `/android` (GET and HEAD: link checkers ask HEAD first): the current APK. The TV's Downloader code points here, so this address must not change. */
export const onRequest = ({ env }: { env: { FEED?: string } }): Promise<Response> =>
  websiteDownload('android', env.FEED);
