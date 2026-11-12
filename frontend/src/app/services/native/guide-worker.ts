import { GuideWorkerHandle } from '@shared/xtream/guideWorker';

/**
 * Starts the guide worker (workers/guide.worker.ts).
 *
 * A module of its own, loaded when a guide is read: `import.meta` is what the
 * build uses to find the worker, and the tests -- which import the guide
 * service but never read a guide -- cannot compile it.
 */
export const startGuideWorker = (): GuideWorkerHandle =>
  new Worker(new URL('../../workers/guide.worker', import.meta.url), { type: 'module' }) as unknown as GuideWorkerHandle;
