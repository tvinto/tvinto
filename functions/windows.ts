import { websiteDownload } from '../worker/src/downloads';

/** `/windows`: the current Windows installer (GitHub's Latest is the APK, so not that). */
export const onRequestGet = ({ env }: { env: { FEED?: string } }): Promise<Response> =>
  websiteDownload('desktop', env.FEED);
