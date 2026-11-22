import { subtitleArguments, subtitleCommands } from './subtitleChoice';

describe('subtitleArguments', () => {
  it('asks for the language when subtitles are on', () => {
    expect(subtitleArguments({ enabled: true, language: 'hrv', added: false, inApp: true })).toEqual(['--slang=hrv']);
    expect(subtitleArguments({ enabled: true, language: '', added: false, inApp: false })).toEqual([]);
  });

  it('selects the language hidden in the app player, so turning it on asks the provider nothing', () => {
    expect(subtitleArguments({ enabled: false, language: 'hrv', added: false, inApp: true })).toEqual([
      '--sub-visibility=no',
      '--slang=hrv'
    ]);
  });

  it('selects no track in mpv’s own window, or with no language to select', () => {
    expect(subtitleArguments({ enabled: false, language: 'hrv', added: false, inApp: false })).toEqual(['--sid=no']);
    expect(subtitleArguments({ enabled: false, language: '', added: false, inApp: true })).toEqual(['--sid=no']);
  });

  it('leaves an added subtitle to be selected once the film is open', () => {
    expect(subtitleArguments({ enabled: false, language: 'hrv', added: true, inApp: true })).toEqual([]);
  });
});

describe('subtitleCommands', () => {
  it('hides the track for Off rather than unselecting it', () => {
    expect(subtitleCommands(null)).toEqual([['set_property', 'sub-visibility', false]]);
  });

  it('selects and shows a chosen track', () => {
    expect(subtitleCommands(3)).toEqual([
      ['set_property', 'sid', 3],
      ['set_property', 'sub-visibility', true]
    ]);
  });
});
