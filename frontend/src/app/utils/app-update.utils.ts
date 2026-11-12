/**
 * Whether a newer Android app has been published than the one installed.
 *
 * Web bundles arrive by themselves (web-update.utils.ts); an APK does not,
 * because a change to native code -- the player overlays, the subtitle button
 * -- cannot travel as web files. So the app says when there is one and offers
 * to download it, and the person installs it. This decides the "when".
 */

import { compareVersions, isFeedFile } from './web-update.utils';

/** What the feed's `android-apk.json` says (frontend/scripts/publish-apk.js writes it). */
export interface ApkManifest {
  version: string;
  file: string;
  sha256: string;
  /** Bytes. */
  size: number;
}

const VERSION = /^\d+(\.\d+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const parseApkManifest = (raw: unknown): ApkManifest | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const { version, file, sha256, size } = raw as Record<string, unknown>;
  if (
    typeof version !== 'string' ||
    !VERSION.test(version) ||
    typeof file !== 'string' ||
    !isFeedFile(file) ||
    typeof sha256 !== 'string' ||
    !SHA256.test(sha256)
  ) {
    return null;
  }
  return { version, file, sha256, size: typeof size === 'number' && size > 0 ? size : 0 };
};

/** The published APK when it is newer than the installed one, else null. */
export const newerApp = (published: ApkManifest | null, installed: string | null | undefined): ApkManifest | null =>
  published && installed && VERSION.test(installed) && compareVersions(published.version, installed) > 0 ? published : null;

/** "168 MB", for the notice. Empty when the size is not known. */
export const megabytes = (bytes: number): string => (bytes > 0 ? `${Math.round(bytes / (1024 * 1024))} MB` : '');
