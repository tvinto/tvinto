import { PROFILE_ANIMALS, ProfileAnimal, ProfilePicture, shownAnimal } from '@shared/profilePicture';

/**
 * How a person's picture is drawn (1-2 November; NX-TV-10): one of
 * eight animals on a circle of its own colour, or a picture of their own
 * filling the circle. With nothing chosen, the animal comes from the name, so
 * it is the same on every device (shared/profilePicture.ts).
 *
 * The animals are Microsoft's Fluent Emoji, 3D style, under the MIT licence
 * (`src/assets/profiles/LICENSE`): drawn, one set, so they look alike.
 */

/** A hue for each animal, far enough apart to tell four people apart at a glance. */
const HUES: Record<ProfileAnimal, number> = { dog: 250, cat: 200, fox: 150, panda: 290, lion: 60, tiger: 20, koala: 320, rabbit: 350 };

export interface ProfileFace {
  /** The picture's address: the app's own animal, or the person's image. */
  picture: string;
  /** The circle behind it, as a CSS background; none behind a picture of one's own. */
  background: string;
  /** A picture of their own, which fills the circle rather than sitting in it. */
  own: boolean;
}

export const animalPicture = (animal: ProfileAnimal): string => `assets/profiles/${animal}.png`;

export const animalBackground = (animal: ProfileAnimal): string => {
  const hue = HUES[animal];
  return `linear-gradient(140deg, oklch(0.62 0.13 ${hue}), oklch(0.4 0.12 ${hue + 30}))`;
};

export function profileFace(name: string, picture?: ProfilePicture): ProfileFace {
  const animal = shownAnimal(name, picture);
  if (!animal) {
    return { picture: picture!, background: 'var(--glass)', own: true };
  }
  return { picture: animalPicture(animal), background: animalBackground(animal), own: false };
}

export { PROFILE_ANIMALS };
