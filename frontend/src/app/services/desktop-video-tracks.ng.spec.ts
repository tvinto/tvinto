import { MpvTrack, TrackWords, foldUnlabelled, playingTarget, trackLabel, trackLabels } from './desktop-video.service';

const track = (id: number, lang: string, title = '', flags: Partial<MpvTrack> = {}): MpvTrack => ({ id, lang, title, selected: false, ...flags });
const words = (unnamed: string): TrackWords => ({ unnamed, forced: 'Forced', default: 'Default' });

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

  it('keeps the language when its code is only part of a word in the title', () => {
    expect(trackLabel(track(8, 'en', 'Commentary'), 'en')).toBe('English · Commentary');
    expect(trackLabel(track(9, 'eng', 'ENG SDH'), 'en')).toBe('ENG SDH');
  });

  it('numbers the ones that would otherwise read the same', () => {
    const labels = trackLabels([track(1, 'spa', 'Castilian'), track(2, 'spa', 'Latin American'), track(3, 'chi', 'Simplified'), track(4, 'chi'), track(5, 'spa'), track(6, 'spa'), track(7, 'und')], 'en', words('Subtitles'));

    expect(labels).toEqual(['Spanish · Castilian', 'Spanish · Latin American', 'Chinese · Simplified', 'Chinese', 'Spanish', 'Spanish 2', 'Subtitles 7']);
  });

  it('says a subtitle is forced, and a track is the default only when another is not', () => {
    const subtitles = [track(1, '', '', { forced: true, default: true }), track(2, ''), track(3, '')];
    expect(trackLabels(subtitles, 'en', words('Subtitles'))).toEqual(['Subtitles 1 · Forced', 'Subtitles 2', 'Subtitles 3']);

    expect(trackLabels([track(1, '', '', { default: true })], 'en', words('Audio'))).toEqual(['Audio 1']);
    expect(trackLabels([track(1, '', '', { default: true }), track(2, '', '', { default: true })], 'en', words('Audio'))).toEqual(['Audio 1', 'Audio 2']);
    expect(trackLabels([track(1, '', '', { default: true }), track(2, 'eng')], 'en', words('Audio'))).toEqual(['Audio 1 · Default', 'English']);
  });

  it('does not say forced twice, and tells a forced track from its plain twin by the flag alone', () => {
    expect(trackLabels([track(1, 'eng', 'English (Forced)', { forced: true })], 'en', words('Subtitles'))).toEqual(['English (Forced)']);
    expect(trackLabels([track(1, 'eng', '', { forced: true }), track(2, 'eng')], 'en', words('Subtitles'))).toEqual(['English · Forced', 'English']);
  });
});

describe('folding a long list of unlabelled tracks', () => {
  const row = (unlabelled: boolean, extra: { forced?: boolean; selected?: boolean } = {}) => ({ unlabelled, forced: false, selected: false, ...extra });

  it('leaves six unlabelled tracks as they are', () => {
    const tracks = Array.from({ length: 6 }, () => row(true));
    expect(foldUnlabelled(tracks)).toEqual({ shown: tracks, hidden: 0 });
  });

  it('folds seven, keeping the labelled, the forced and the one in use', () => {
    const labelled = row(false);
    const forced = row(true, { forced: true });
    const inUse = row(true, { selected: true });
    const plain = Array.from({ length: 6 }, () => row(true));
    const folded = foldUnlabelled([forced, labelled, ...plain.slice(0, 3), inUse, ...plain.slice(3)]);

    expect(folded.shown).toEqual([forced, labelled, inUse]);
    expect(folded.hidden).toBe(6);
  });
});

describe('what the player hands the subtitle picker', () => {
  it('names a film by the library’s title', () => {
    expect(playingTarget({ type: 'vod', id: '2100' }, { kind: 'film', title: 'Dune' }, '[4K] Dune (2021)')).toEqual({
      item: { type: 'vod', itemId: '2100', name: 'Dune' },
      name: 'Dune'
    });
  });

  it('takes an episode’s numbers from its title, and its show for the name', () => {
    const target = playingTarget({ type: 'series', id: '77', showId: '12' }, { kind: 'episode', heading: 'Severance', title: 'S1 E3 · In Perpetuity' }, 'x');
    expect(target?.item).toEqual({ type: 'series', itemId: '77', seriesId: '12', season: 1, episodeNum: 3, name: 'Severance' });
  });

  it('offers nothing for a live channel', () => {
    expect(playingTarget({ type: 'live', id: '5' }, null, 'News')).toBeNull();
    expect(playingTarget(undefined, null, 'News')).toBeNull();
  });
});
