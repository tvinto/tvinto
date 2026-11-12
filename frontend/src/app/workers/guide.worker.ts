/// <reference lib="webworker" />
import { GuideWorkerScope, serveGuideParse } from '@shared/xtream/guideWorker';

/**
 * Reads guides away from the page (shared/xtream/guideWorker.ts): the page
 * hands over bytes as they are asked for and writes what comes back.
 */
serveGuideParse(self as unknown as GuideWorkerScope);
