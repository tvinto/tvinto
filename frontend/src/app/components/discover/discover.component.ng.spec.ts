import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NEVER, of } from 'rxjs';
import { Stream } from '@shared/types';
import { TmdbTrending } from '@shared/tmdb/client';
import { DiscoverComponent } from './discover.component';
import { Popular, PopularService } from '../../services/popular.service';
import { TmdbService } from '../../services/tmdb.service';
import { XtreamService } from '../../services/xtream.service';
import { DiscoverService } from '../../services/discover.service';
import { AgeLockService } from '../../services/age-lock.service';
import { ParentalLockService } from '../../services/parental-lock.service';
import { ShowService } from '../../services/show.service';
import { BackButtonService } from '../../services/back-button.service';

/**
 * Back to Movies (card 39): the page is made afresh, and its TMDB rows waited
 * for the categories from the database -- behind a film page's searches of the
 * library, 11 to 14 s on the owner's TV. They are kept, shown at once, and
 * replaced only where something changed.
 */
describe('DiscoverComponent', () => {
  const film = (id: number, title: string): Popular => ({
    item: { kind: 'movie', id, title, originalTitle: title, overview: '', year: '2025', poster: '' } as TmdbTrending,
    type: 'vod',
    versions: [{ stream_id: String(id * 10), name: title, category_id: '1' } as unknown as Stream],
    rank: id
  });
  let categories: ReturnType<typeof signal<'answer' | 'busy'>>;
  let locked: string[];
  let owner: string;

  const make = () => {
    const fixture = TestBed.createComponent(DiscoverComponent);
    fixture.componentRef.setInput('kind', 'movie');
    fixture.detectChanges();
    return fixture;
  };
  const shown = (fixture: ReturnType<typeof make>) =>
    [...(fixture.nativeElement as HTMLElement).querySelectorAll('[data-discover-row]')].map(
      row => `${row.getAttribute('data-discover-row')}: ${[...row.querySelectorAll('[data-fy-poster]')].map(card => card.getAttribute('title')).join(', ')}`
    );
  const settle = async (fixture: ReturnType<typeof make>) => {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    await fixture.whenStable();
    fixture.detectChanges();
  };

  let lists: Record<string, Popular[]>;

  beforeEach(() => {
    categories = signal('answer');
    locked = [];
    owner = 'owner';
    lists = { popular: [film(1, 'Dune'), film(2, 'Hope')], trending: [film(3, 'Sinners')], top: [], new: [] };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: TmdbService, useValue: { client: async () => ({}) } },
        {
          provide: XtreamService,
          useValue: {
            libraryOwner: async () => owner,
            allowed: (_type: string, stream: Stream) => !locked.includes(String(stream.stream_id)),
            // A database busy with something else answers nothing.
            getCategories: () => (categories() === 'busy' ? NEVER : of([{ category_id: '1', category_name: 'EN | Films', parent_id: 0 }])),
            getRecentlyWatched: () => of([]),
            indexing: signal(null)
          }
        },
        { provide: DiscoverService, useValue: { genres: async () => [], watched: async () => [] } },
        { provide: AgeLockService, useValue: { engaged: () => false, learn: async () => undefined, lockedLabel: () => null, covered: () => false } },
        { provide: ParentalLockService, useValue: {} },
        { provide: ShowService, useValue: { chosen: () => null } },
        { provide: BackButtonService, useValue: { bindTo: () => undefined } }
      ]
    });
    const popular = TestBed.inject(PopularService);
    // As the service does: what the parental lock keeps out is never there.
    const open = (list = 'trending') => (lists[list] ?? []).filter(entry => !entry.versions.some(stream => locked.includes(String(stream.stream_id))));
    jest.spyOn(popular, 'lastPopular').mockImplementation(async (_kind, _limit, list) => open(list));
    jest.spyOn(popular, 'popular').mockImplementation(async (_kind, _limit, list) => open(list));
  });

  it('shows the rows it showed last at once when made again, while the database answers nothing', async () => {
    const first = make();
    await settle(first);
    expect(shown(first)).toEqual(['popular: Dune, Hope', 'trending: Sinners']);
    first.destroy();

    categories.set('busy');
    const back = make();
    await settle(back);
    expect(shown(back)).toEqual(['popular: Dune, Hope', 'trending: Sinners']);
  });

  it('puts its rows up on a first visit while the database answers nothing, and their categories once it does', async () => {
    categories.set('busy');
    const fixture = make();
    await settle(fixture);
    expect(shown(fixture)).toEqual(['popular: Dune, Hope', 'trending: Sinners']);
    expect(fixture.componentInstance.rows()[0].cards[0].categories).toEqual(['']);
    fixture.destroy();

    categories.set('answer');
    const again = make();
    await settle(again);
    expect(again.componentInstance.rows()[0].cards[0].categories).toEqual(['Films']);
  });

  it('replaces a row only where it changed, keeping the others as they are on screen', async () => {
    const first = make();
    await settle(first);
    first.destroy();

    lists = { ...lists, trending: [film(3, 'Sinners'), film(4, 'Weapons')] };
    const back = make();
    const popularRow = () => (back.nativeElement as HTMLElement).querySelector('[data-discover-row="popular"] [data-fy-poster]');
    await Promise.resolve();
    back.detectChanges();
    const before = popularRow();
    await settle(back);

    expect(shown(back)).toEqual(['popular: Dune, Hope', 'trending: Sinners, Weapons']);
    expect(popularRow()).toBe(before);
  });

  it('leaves out copies the parental lock has closed since, and another library\'s rows', async () => {
    const first = make();
    await settle(first);
    first.destroy();

    categories.set('busy');
    locked = ['10'];
    const locked1 = make();
    await settle(locked1);
    expect(shown(locked1)).toEqual(['popular: Hope', 'trending: Sinners']);
    locked1.destroy();

    // Nothing matched for the other library yet: only what was kept could show.
    owner = 'someone else';
    lists = {};
    const other = make();
    await settle(other);
    expect(shown(other)).toEqual([]);
  });
});
