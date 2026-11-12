import { COPY_CHOICES_KEPT, copyChoice, fromDeviceRecords, mergeCopyChoices, readCopyChoices, withCopyChoice, writeCopyChoices } from './copyChoices';

describe('Copy choices for the account', () => {
  it('reads leniently and writes back the same', () => {
    expect(readCopyChoices('')).toEqual({ films: [], shows: [] });
    expect(readCopyChoices('{"films":[["603",12],["x",null],"bad"],"shows":{}}')).toEqual({ films: [['603', '12']], shows: [] });
    const choices = readCopyChoices('{"films":[["603","12"]],"shows":[["95396","7"]]}');
    expect(readCopyChoices(writeCopyChoices(choices))).toEqual(choices);
    expect(copyChoice(choices, 'shows', '95396')).toBe('7');
    expect(copyChoice(choices, 'films', '604')).toBeNull();
  });

  it('keeps the latest choice of each title, and drops the oldest past a few hundred', () => {
    let choices = readCopyChoices('');
    choices = withCopyChoice(choices, 'films', '603', '12');
    choices = withCopyChoice(choices, 'films', '603', '13');
    expect(choices.films).toEqual([['603', '13']]);
    // Numbers as keys, newest with the smallest: the order made is the order kept.
    for (let i = COPY_CHOICES_KEPT + 5; i > 0; i--) {
      choices = withCopyChoice(choices, 'shows', String(i), 'x');
    }
    expect(choices.shows).toHaveLength(COPY_CHOICES_KEPT);
    expect(copyChoice(choices, 'shows', String(COPY_CHOICES_KEPT + 5))).toBeNull();
    expect(copyChoice(choices, 'shows', '1')).toBe('x');
  });

  it("puts the device's old choices under the account's", () => {
    const device = fromDeviceRecords({ '603': 'device', '604': 'device' }, { '1': '2' });
    const merged = mergeCopyChoices(readCopyChoices('{"films":[["603","account"]]}'), device);
    expect(merged).toEqual({ films: [['604', 'device'], ['603', 'account']], shows: [['1', '2']] });
  });
});
