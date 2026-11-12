/// <reference lib="webworker" />
import { LibraryWorkerScope, serveLibraryRead } from '@shared/xtream/libraryWorker';

/**
 * Reads whole-library listings away from the page (shared/xtream/libraryWorker.ts):
 * the page hands over bytes as they are asked for and writes the categories
 * that come back.
 */
serveLibraryRead(self as unknown as LibraryWorkerScope);
