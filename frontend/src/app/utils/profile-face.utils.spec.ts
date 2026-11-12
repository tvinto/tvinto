import { existsSync } from 'fs';
import { join } from 'path';
import { profileFace } from './profile-face.utils';

describe('profileFace', () => {
  it('gives a name the same picture every time, whatever its case', () => {
    expect(profileFace('Petar')).toEqual(profileFace('petar'));
  });

  it('points at a picture the app ships', () => {
    for (const name of ['ana', 'ivan', 'marko', 'petra', 'luka', 'sara', 'tin', 'eva', 'kid']) {
      const { picture } = profileFace(name);
      expect(existsSync(join(__dirname, '..', '..', picture))).toBe(true);
    }
  });

  it('draws a chosen animal, and a picture of their own as it is', () => {
    expect(profileFace('petar', 'animal:koala').picture).toBe('assets/profiles/koala.png');
    const own = profileFace('petar', 'data:image/jpeg;base64,AAAA');
    expect(own).toMatchObject({ picture: 'data:image/jpeg;base64,AAAA', own: true });
  });

  it('uses more than one animal across a household', () => {
    const pictures = new Set(['ana', 'ivan', 'marko', 'petra'].map(name => profileFace(name).picture));
    expect(pictures.size).toBeGreaterThan(1);
  });
});
