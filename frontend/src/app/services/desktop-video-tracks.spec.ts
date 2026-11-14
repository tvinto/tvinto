import { MpvTrack, trackLabel, trackLabels } from './desktop-video.service';

const track = (id: number, lang: string, title = ''): MpvTrack => ({ id, lang, title, selected: false });

describe('what the desktop player calls a track', () => {
  it('names no language for a music-only track, or any code that names none', () => {
    expect(trackLabel(track(4, 'zxx', "Composer's Isolated Score"), 'en')).toBe("Composer's Isolated Score");
    expect(trackLabel(track(5, 'und', 'Stereo'), 'en')).toBe('Stereo');
    expect(trackLabel(track(6, 'mul', 'Original'), 'en')).toBe('Original');
    expect(trackLabel(track(7, 'mis', ''), 'en')).toBe('');
  });

  it('puts the language first and the file’s own title after it', () => {
    expect(trackLabel(track(2, 'spa', 'Latin American'), 'en')).toBe('Spanish · Latin American');
    expect(trackLabel(track(3, 'eng', 'English SDH'), 'en')).toBe('English SDH');
    expect(trackLabel(track(1, 'eng'), 'en')).toBe('English');
  });

  it('numbers the ones that would otherwise read the same', () => {
    const labels = trackLabels([track(1, 'spa', 'Castilian'), track(2, 'spa', 'Latin American'), track(3, 'chi', 'Simplified'), track(4, 'chi'), track(5, 'spa'), track(6, 'spa'), track(7, 'und')], 'en', 'Subtitles');

    expect(labels).toEqual(['Spanish · Castilian', 'Spanish · Latin American', 'Chinese · Simplified', 'Chinese', 'Spanish', 'Spanish 2', 'Subtitles 7']);
  });
});
