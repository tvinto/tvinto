import { LibraryWorkerHandle } from '@shared/xtream/libraryWorker';

/**
 * Starts the library worker (workers/library.worker.ts).
 *
 * A module of its own, loaded when a library is indexed, for the same reason
 * as the guide worker's: `import.meta` is what the build uses to find the
 * worker, and the tests cannot compile it.
 */
export const startLibraryWorker = (): LibraryWorkerHandle =>
  new Worker(new URL('../../workers/library.worker', import.meta.url), { type: 'module' }) as unknown as LibraryWorkerHandle;
