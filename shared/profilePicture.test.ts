import { PICTURE_MAX_LENGTH, animalFor, isProfilePicture, shownAnimal } from './profilePicture';

describe('profile pictures', () => {
  it('takes an animal, a small image, or null', () => {
    expect(isProfilePicture(null)).toBe(true);
    expect(isProfilePicture('animal:fox')).toBe(true);
    expect(isProfilePicture('data:image/jpeg;base64,/9j/4AAQ')).toBe(true);
  });

  it('refuses anything else', () => {
    expect(isProfilePicture('animal:dragon')).toBe(false);
    expect(isProfilePicture('https://example.com/me.png')).toBe(false);
    expect(isProfilePicture('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
    expect(isProfilePicture('data:image/png;base64,' + 'A'.repeat(PICTURE_MAX_LENGTH))).toBe(false);
    expect(isProfilePicture(42)).toBe(false);
  });

  it('gives a name the same animal whatever its case', () => {
    expect(animalFor('Petar')).toBe(animalFor('petar'));
  });

  it('shows the chosen animal, the name\'s, or none for an own picture', () => {
    expect(shownAnimal('petar', 'animal:koala')).toBe('koala');
    expect(shownAnimal('petar', null)).toBe(animalFor('petar'));
    expect(shownAnimal('petar', 'data:image/jpeg;base64,AAAA')).toBeNull();
  });
});
