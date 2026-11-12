/**
 * A person's profile picture (1-2 November): one of eight drawn
 * animals, a picture of their own, or -- with nothing chosen -- the animal
 * worked out from their name.
 *
 * Kept on the sync service with the account (`users.picture`), so every
 * device in the household shows the same one. A picture of one's own is a
 * small square image as a data address, made small on the device that adds
 * it (256 pixels across), so the service only checks its kind and size.
 * Unlike subscriptions it is not sealed: other people's devices in the
 * household show it before anybody has their keys.
 */

/** The animals, in the order they are offered. Files: `assets/profiles/<name>.png`. */
export const PROFILE_ANIMALS = ['dog', 'cat', 'fox', 'panda', 'lion', 'tiger', 'koala', 'rabbit'] as const;

export type ProfileAnimal = (typeof PROFILE_ANIMALS)[number];

/** `animal:fox`, or `data:image/jpeg;base64,...`; null is the one from the name. */
export type ProfilePicture = string | null;

/** A data address this long is about 45 KB of image: a 256-pixel photo is a third of it. */
export const PICTURE_MAX_LENGTH = 60_000;

const IMAGE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export const isProfileAnimal = (value: unknown): value is ProfileAnimal =>
  typeof value === 'string' && (PROFILE_ANIMALS as readonly string[]).includes(value);

/** Whether a value may be stored as somebody's picture; null clears it. */
export function isProfilePicture(value: unknown): value is ProfilePicture {
  if (value === null) {
    return true;
  }
  if (typeof value !== 'string') {
    return false;
  }
  if (value.startsWith('animal:')) {
    return isProfileAnimal(value.slice('animal:'.length));
  }
  return value.length <= PICTURE_MAX_LENGTH && IMAGE.test(value);
}

/** The animal a name gets when nothing is chosen: the same on every device. */
export function animalFor(name: string): ProfileAnimal {
  let hash = 0;
  for (const char of name.toLowerCase()) {
    hash = (hash * 31 + char.codePointAt(0)!) % 1_000_003;
  }
  return PROFILE_ANIMALS[hash % PROFILE_ANIMALS.length];
}

/** The animal shown, chosen or from the name; null for a picture of one's own. */
export function shownAnimal(name: string, picture: ProfilePicture | undefined): ProfileAnimal | null {
  if (picture && !picture.startsWith('animal:')) {
    return null;
  }
  const chosen = picture?.slice('animal:'.length);
  return isProfileAnimal(chosen) ? chosen : animalFor(name);
}
