import { PICTURE_MAX_LENGTH } from '@shared/profilePicture';

/** Across, in pixels: twice the largest circle it is drawn in (Who's watching on a television). */
const SIDE = 256;

/**
 * A photo somebody chose, made into a profile picture: the middle square,
 * 256 pixels across, as a JPEG data address small enough for the sync
 * service (shared/profilePicture.ts). Done here so a phone's 12-megapixel
 * photo never leaves the device.
 *
 * Throws `unreadable` for a file the browser cannot draw.
 */
export async function pictureFromFile(file: Blob): Promise<string> {
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(file);
  } catch {
    throw new Error('unreadable');
  }
  const side = Math.min(image.width, image.height);
  const canvas = document.createElement('canvas');
  canvas.width = SIDE;
  canvas.height = SIDE;
  const context = canvas.getContext('2d');
  if (!context || side === 0) {
    throw new Error('unreadable');
  }
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, SIDE, SIDE);
  image.close();
  // A busy photo can come out larger at the first quality: less, until it fits.
  for (const quality of [0.85, 0.7, 0.55, 0.4]) {
    const picture = canvas.toDataURL('image/jpeg', quality);
    if (picture.length <= PICTURE_MAX_LENGTH) {
      return picture;
    }
  }
  throw new Error('unreadable');
}
