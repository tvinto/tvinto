import { accountSettings } from './settings.utils';

describe('accountSettings', () => {
  it('keeps the theme and sort orders on the device', () => {
    expect(
      accountSettings({ theme: 'light', categorySort: 'manual', streamSort: 'number', player: '{"subtitleSize":2}' })
    ).toEqual({ player: '{"subtitleSize":2}' });
  });

  it('passes an empty set through', () => {
    expect(accountSettings({})).toEqual({});
  });
});
