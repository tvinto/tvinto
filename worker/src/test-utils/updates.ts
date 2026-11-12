import { UpdateBucket, UpdateObject } from '../updates';

/**
 * The update bucket, as far as serving a file out of it goes.
 *
 * R2 in a test would mean `wrangler dev` and a real bucket, which is a lot of
 * machinery to prove that a range header turns into a slice of some bytes.
 * What this cannot check is that R2 behaves as described -- so nothing here
 * relies on R2 doing anything clever: the offsets are worked out by us and R2
 * is asked only for the bytes between two numbers.
 */

/**
 * When everything in the fake bucket was put there.
 *
 * Fixed, so that a test asserting what the download page says about a date is
 * asserting the page rather than the day it was run.
 */
export const UPLOADED = new Date('2026-09-07T09:30:00Z');

const object = (bytes: Uint8Array, whole: number): UpdateObject => ({
  body: new Response(bytes).body,
  size: bytes.length,
  // R2 spells an etag with the quotes included, and something downstream will
  // eventually compare the two, so the fake spells it the same way.
  httpEtag: `"${whole}-${bytes.length}"`,
  uploaded: UPLOADED
});

export const bucketOf = (files: Record<string, string>): UpdateBucket => {
  const bytes = (name: string): Uint8Array | null =>
    name in files ? new TextEncoder().encode(files[name]) : null;

  return {
    async get(name, options) {
      const all = bytes(name);
      if (!all) {
        return null;
      }

      const range = options?.range;
      return range
        ? object(all.slice(range.offset, range.offset + range.length), all.length)
        : object(all, all.length);
    },

    async head(name) {
      const all = bytes(name);
      return all ? { ...object(all, all.length), body: null } : null;
    }
  };
};
