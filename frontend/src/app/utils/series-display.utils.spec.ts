import { episodeMinutes, posterTitle, seriesFacts } from './series-display.utils';

describe('seriesFacts', () => {
  it('reads the provider shape, with the facts under info', () => {
    expect(
      seriesFacts({
        info: {
          cover: 'http://img/novine.jpg',
          plot: 'Novinari lokalnog dnevnika.',
          releaseDate: '2016-10-02',
          genre: 'Drama, Crime, Mystery',
          rating_5based: '3.8'
        },
        episodes: {}
      })
    ).toEqual({
      cover: 'http://img/novine.jpg',
      plot: 'Novinari lokalnog dnevnika.',
      year: '2016',
      genre: 'Drama · Crime',
      rating: 4
    });
  });

  it('reads the flattened backend shape, and a ten-point rating', () => {
    const facts = seriesFacts({ plot: 'x', releaseDate: '2024', rating: 7 });
    expect(facts.year).toBe('2024');
    expect(facts.rating).toBe(4);
  });

  it('leaves everything empty rather than inventing it', () => {
    expect(seriesFacts(null)).toEqual({ cover: '', plot: '', year: '', genre: '', rating: 0 });
    expect(seriesFacts({ info: [] as unknown, releaseDate: 'unknown' }).year).toBe('');
  });
});

describe('episodeMinutes', () => {
  it('prefers the seconds the provider counted', () => {
    expect(episodeMinutes({ duration_secs: 3130, duration: '00:10:00' })).toBe(52);
  });

  it('reads a clock', () => {
    expect(episodeMinutes({ duration: '00:51:40' })).toBe(52);
    expect(episodeMinutes({ duration: '01:02:00' })).toBe(62);
    expect(episodeMinutes({ duration: '44:10' })).toBe(44);
  });

  it('says nothing when there is nothing', () => {
    expect(episodeMinutes({ duration: '' })).toBeNull();
    expect(episodeMinutes({ duration: '00:00:00' })).toBeNull();
    expect(episodeMinutes(undefined)).toBeNull();
  });
});

describe('posterTitle', () => {
  it('takes the country tag off the front and the year off the end', () => {
    expect(posterTitle('EX - 3 Body Problem (2024)')).toEqual({ title: '3 Body Problem', tags: '', year: '2024' });
  });

  it('keeps the packaging tags aside and reads a dashed year', () => {
    expect(posterTitle('HR| Zora Mrak ⱽᴵᴾ - 2019')).toEqual({ title: 'Zora Mrak', tags: 'ⱽᴵᴾ', year: '2019' });
  });

  it('drops what the provider writes after the year, and prefixes with a plus', () => {
    expect(posterTitle('EN - Stiller Meara Nothing Is Lost (2025) (MULTI SUB) CHRISTOPHER WALKEN')).toEqual({
      title: 'Stiller Meara Nothing Is Lost',
      tags: '',
      year: '2025'
    });
    expect(posterTitle("A+ - 9/11: Inside The President's War Room (2021)").title).toBe(
      "9/11: Inside The President's War Room"
    );
  });

  it('leaves a number that is part of the title alone', () => {
    expect(posterTitle('Blade Runner 2049')).toEqual({ title: 'Blade Runner 2049', tags: '', year: '' });
    expect(posterTitle('(1999)')).toEqual({ title: '(1999)', tags: '', year: '' });
    expect(posterTitle('1917 (2019)')).toEqual({ title: '1917', tags: '', year: '2019' });
  });
});
