import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { Episode, SeriesInfo } from '@shared/types';
import { XtreamService } from '../services/xtream.service';
import { SeriesDetailStore } from './series-detail.store';

/**
 * A show's seasons gathered from every copy (22 November): the page lists
 * seasons this copy lacks, and the provider's answer for this copy arriving
 * behind the kept one must not take them away, nor the season being looked at.
 */

const episode = (season: number, number: number, id = `${season}-${number}`) => ({ id, season, episode_num: number }) as unknown as Episode;
const info = (episodes: Record<string, Episode[]>) => ({ episodes }) as unknown as SeriesInfo;

describe('SeriesDetailStore with seasons from other copies', () => {
  let answers: Subject<SeriesInfo>;

  const build = () => {
    answers = new Subject<SeriesInfo>();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [SeriesDetailStore, { provide: XtreamService, useValue: { getSeriesInfo: () => answers } }]
    });
    return TestBed.inject(SeriesDetailStore);
  };

  const own = { '1': [episode(1, 1)], '2': [episode(2, 1)] };
  const merged = { ...own, '3': [episode(3, 1, 'hd-3-1')] };

  it('lists the merged seasons and keeps the season being looked at', () => {
    const store = build();
    store.loadSeriesInfo('4k');
    answers.next(info(own));
    store.selectSeason('2');
    store.setEpisodes(merged);
    expect(store.availableSeasons()).toEqual(['1', '2', '3']);
    expect(store.selectedSeason()).toBe('2');
    store.selectSeason('3');
    expect(store.currentSeasonEpisodes().map(one => one.id)).toEqual(['hd-3-1']);
  });

  it('keeps a season only another copy has when this copy\'s answer arrives again', () => {
    const store = build();
    store.loadSeriesInfo('4k');
    answers.next(info(own));
    store.setEpisodes(merged);
    store.selectSeason('3');
    // The provider's answer, behind the kept one.
    answers.next(info({ ...own, '1': [episode(1, 1), episode(1, 2)] }));
    expect(store.selectedSeason()).toBe('3');
    expect(store.availableSeasons()).toEqual(['1', '2', '3']);
    expect(store.episodes()['1'].length).toBe(2);
  });

  it('starts another show afresh', () => {
    const store = build();
    store.loadSeriesInfo('4k');
    answers.next(info(own));
    store.setEpisodes(merged);
    store.selectSeason('3');
    store.loadSeriesInfo('other');
    answers.next(info({ '5': [episode(5, 1)] }));
    expect(store.availableSeasons()).toEqual(['5']);
    expect(store.selectedSeason()).toBe('5');
  });

  it('says the provider is still being asked until its answer is complete', () => {
    const store = build();
    store.loadSeriesInfo('4k');
    expect(store.asking()).toBe(true);
    answers.next(info(own));
    expect(store.loading()).toBe(false);
    expect(store.asking()).toBe(true);
    answers.complete();
    expect(store.asking()).toBe(false);
  });
});
