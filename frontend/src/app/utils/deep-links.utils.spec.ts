import { isStartLink, routeForLink } from './deep-links.utils';

describe('tvinto:// links', () => {
  it('open a channel from a reminder', () => {
    expect(routeForLink('tvinto://watch?stream=pabc~7&name=HRT%201&kind=reminder')).toEqual({
      path: ['/tv'],
      queryParams: { play: 'pabc~7', kind: 'reminder', name: 'HRT 1', icon: '' }
    });
  });

  it('open a channel from the home screen, whatever kind a link claims', () => {
    expect(routeForLink('tvinto://watch?stream=7&kind=recent')?.queryParams['kind']).toBe('home');
  });

  it('resume a film', () => {
    expect(routeForLink('tvinto://movie?play=55&name=Up')).toEqual({
      path: ['/movies'],
      queryParams: { play: '55', kind: 'recent', name: 'Up', icon: '' }
    });
  });

  it("open a show's page", () => {
    expect(routeForLink('tvinto://series/12?name=Dexter')).toEqual({ path: ['/series', '12'], queryParams: { name: 'Dexter' } });
  });

  it('ignore anything else', () => {
    expect(routeForLink('https://example.com/watch?stream=1')).toBeNull();
    expect(routeForLink('tvinto://watch')).toBeNull();
    expect(routeForLink('tvinto://elsewhere?x=1')).toBeNull();
    expect(routeForLink('not a link')).toBeNull();
  });
});

describe('the link a television opens the app with when turned on', () => {
  it('is known, however it is written', () => {
    expect(['tvinto://start', 'tvinto:start', 'tvinto://start/', ' TVINTO://START '].every(isStartLink)).toBe(true);
  });

  it('is not any other link, and is no route of its own', () => {
    expect(['tvinto://started', 'tvinto://watch?stream=1', 'https://start', 'tvinto://series/start'].some(isStartLink)).toBe(false);
    expect(routeForLink('tvinto://start')).toBeNull();
  });
});
