import { TestBed } from '@angular/core/testing';
import { RECENT_SEARCHES_KEPT, RecentSearchesService, withSearch } from './recent-searches.service';

describe('withSearch', () => {
  it('puts the newest first', () => {
    expect(withSearch(['dune', 'hrt 1'], 'severance')).toEqual(['severance', 'dune', 'hrt 1']);
  });

  it('keeps a search once, ignoring case, at the front', () => {
    expect(withSearch(['hrt 1', 'Dune'], 'dune')).toEqual(['dune', 'hrt 1']);
  });

  it('drops the shorter words typed on the way to it', () => {
    expect(withSearch(['sever', 'dune'], 'severance')).toEqual(['severance', 'dune']);
  });

  it(`keeps ${RECENT_SEARCHES_KEPT}`, () => {
    expect(withSearch(['a1', 'b2', 'c3', 'd4', 'e5'], 'f6')).toEqual(['f6', 'a1', 'b2', 'c3', 'd4']);
  });
});

describe('RecentSearchesService', () => {
  beforeEach(() => localStorage.clear());

  it('outlives the run, on this device', () => {
    TestBed.inject(RecentSearchesService).remember('  arena   sport ');

    TestBed.resetTestingModule();
    expect(TestBed.inject(RecentSearchesService).list()).toEqual(['arena sport']);
  });

  it('does not keep fewer than three letters, which never ran as a search', () => {
    const recent = TestBed.inject(RecentSearchesService);
    recent.remember('du');

    expect(recent.list()).toEqual([]);
  });

  it('clears', () => {
    const recent = TestBed.inject(RecentSearchesService);
    recent.remember('dune');
    recent.clear();

    TestBed.resetTestingModule();
    expect(TestBed.inject(RecentSearchesService).list()).toEqual([]);
  });
});
