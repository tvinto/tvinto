import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { Stream } from '@shared/types';
import { TmdbTrending } from '@shared/tmdb/client';
import { API_URL } from './api-url';
import { LocalProfileService } from './local-profile.service';
import { PopularService } from './popular.service';
import { TmdbService } from './tmdb.service';
import { XtreamService } from './xtream.service';

/**
 * "Popular now": the week's trending titles from TMDB,
 * kept to the ones this library has, each with every copy of it -- and the
 * key it is asked with: the one typed on this device, else the sync
 * service's.
 */

const trend = (kind: 'movie' | 'tv', id: number, title: string, year: string): TmdbTrending => ({
  kind,
  id,
  title,
  originalTitle: title,
  overview: '',
  year,
  poster: `/${id}.jpg`
});

const stream = (id: number, name: string): Stream => ({ stream_id: String(id), name, icon: '' }) as Stream;

describe('PopularService', () => {
  let tmdbAsked: string[];
  let searched: string[];

  /** TMDB's list, films and shows apart, twenty -- here two -- to a page. */
  const setup = (options: { trending?: TmdbTrending[]; held?: Record<string, Stream[]>; key?: boolean; perPage?: number; failFrom?: number; locked?: string[] } = {}) => {
    tmdbAsked = [];
    searched = [];
    const perPage = options.perPage ?? 20;
    const client = {
      list: async (kind: 'movie' | 'tv', list: string, _language: string, page: number) => {
        tmdbAsked.push(list === 'trending' ? `${kind}:${page}` : `${kind}:${list}:${page}`);
        if (options.failFrom && page >= options.failFrom) {
          throw new Error('TMDB answered 503');
        }
        const all = (options.trending ?? []).filter(item => item.kind === kind);
        return { items: all.slice((page - 1) * perPage, page * perPage), pages: Math.max(1, Math.ceil(all.length / perPage)) };
      }
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: TmdbService, useValue: { client: async () => (options.key === false ? null : client) } },
        {
          provide: XtreamService,
          useValue: {
            findHeld: async (type: string, query: string) => {
              searched.push(`${type}:${query}`);
              return options.held?.[`${type}:${query}`] ?? [];
            },
            findHeldTitles: async (type: string, titles: string[]) =>
              new Map(
                titles.map(title => {
                  searched.push(`${type}:${title}`);
                  return [title, options.held?.[`${type}:${title}`] ?? []];
                })
              ),
            libraryOwner: async () => 'owner',
            allowed: (_type: string, held: Stream) => !(options.locked ?? []).includes(held.stream_id)
          }
        }
      ]
    });
    return TestBed.inject(PopularService);
  };

  beforeEach(() => localStorage.clear());

  it("reads any of TMDB's lists the same way, each kept apart", async () => {
    const service = setup({ trending: [trend('movie', 1, 'Sacrifice', '2025')], held: { 'vod:Sacrifice': [stream(10, 'EN - Sacrifice (2025)')] } });
    expect((await service.page('movie', 1, 'top')).found.map(entry => entry.item.id)).toEqual([1]);
    await service.page('movie', 1, 'genre-80');
    await service.page('movie', 1, 'top');
    expect(tmdbAsked).toEqual(['movie:top:1', 'movie:genre-80:1']);
  });

  it('keeps the trending titles this library has, films and shows apart, each with every copy, in TMDB order', async () => {
    const service = setup({
      trending: [trend('movie', 1, 'Sacrifice', '2025'), trend('tv', 2, 'The Bear', '2022'), trend('movie', 3, 'Dune: Part Two', '2024')],
      held: {
        'vod:Dune: Part Two': [stream(10, 'EN - Dune: Part Two (2024)'), stream(11, '[4K] - Dune Part Two 4K'), stream(12, 'EN - Dune (2021)')],
        'series:The Bear': [stream(20, '|EN| The Bear')]
      }
    });

    const films = await service.popular('movie');
    const shows = await service.popular('tv');

    expect(films.map(entry => [entry.item.title, entry.type, entry.versions.map(v => v.stream_id)])).toEqual([['Dune: Part Two', 'vod', ['10', '11']]]);
    expect(shows.map(entry => [entry.item.title, entry.type, entry.versions.map(v => v.stream_id)])).toEqual([['The Bear', 'series', ['20']]]);
  });

  it('reads on down the list a page at a time, for Show more', async () => {
    const titles = ['A', 'B', 'C', 'D', 'E'].map((title, index) => trend('movie', index + 1, title, '2025'));
    const service = setup({
      trending: titles,
      perPage: 2,
      held: { 'vod:A': [stream(1, 'A')], 'vod:D': [stream(4, 'D')], 'vod:E': [stream(5, 'E')] }
    });

    const pages = [await service.page('movie', 1), await service.page('movie', 2), await service.page('movie', 3)];

    expect(pages.map(page => page.found.map(entry => entry.item.title))).toEqual([['A'], ['D'], ['E']]);
    expect(pages.map(page => page.pages)).toEqual([3, 3, 3]);
    expect(pages.map(page => page.checked)).toEqual([2, 2, 1]);
  });

  it('asks TMDB once a day for a page, and nothing at all without a key', async () => {
    const service = setup({ trending: [trend('movie', 1, 'Sacrifice', '2025')] });
    await service.popular('movie');
    await service.popular('movie');
    expect(tmdbAsked).toEqual(['movie:1']); // a list of one page, asked once

    // Another launch the same day reads the kept pages.
    const again = setup({ trending: [trend('movie', 1, 'Sacrifice', '2025')] });
    await again.page('movie', 1);
    expect(tmdbAsked).toEqual([]);

    localStorage.clear();
    const keyless = setup({ key: false });
    expect(await keyless.popular('movie')).toEqual([]);
    expect(await keyless.page('movie', 1)).toEqual({ found: [], checked: 0, pages: 0 });
    expect(searched).toEqual([]);
  });

  it('mixes films and shows into one row by their places on their own lists, ten at most', async () => {
    const service = setup({
      trending: [trend('movie', 1, 'Hope', '2026'), trend('movie', 3, 'Sinners', '2025'), trend('tv', 4, 'Unheld', '2024'), trend('tv', 2, 'Severance', '2022')],
      held: { 'vod:Hope': [stream(1, 'Hope')], 'series:Severance': [stream(2, 'Severance')], 'vod:Sinners': [stream(3, 'Sinners')] }
    });

    // Hope is first among films; Sinners and Severance both second, and on a tie the film goes first.
    expect((await service.mixed()).map(entry => entry.item.title)).toEqual(['Hope', 'Sinners', 'Severance']);
    expect(await service.mixed(2)).toHaveLength(2);
  });

  // Over a minute on a user's TV, and For You did it on every visit (21 October).
  it('works the row out once a day, and keeps to what the lock still allows', async () => {
    localStorage.clear();
    const trending = [trend('movie', 1, 'Hope', '2026'), trend('tv', 2, 'Severance', '2022')];
    const held = { 'vod:Hope': [stream(1, 'Hope')], 'series:Severance': [stream(2, 'Severance')] };
    await setup({ trending, held }).mixed();

    const again = setup({ trending, held, locked: ['2'] });
    expect((await again.lastMixed())?.map(entry => entry.item.title)).toEqual(['Hope']);
    expect((await again.mixed()).map(entry => entry.item.title)).toEqual(['Hope']);
    expect(searched).toEqual([]);
  });

  it("lets last week's list stand in while TMDB is away", async () => {
    const titles = [trend('movie', 1, 'Hope', '2026')];
    const held = { 'vod:Hope': [stream(1, 'Hope')] };
    await setup({ trending: titles, held }).popular('movie');
    const kept = JSON.parse(localStorage.getItem('xtream_tmdb_trending_movie')!);
    localStorage.setItem('xtream_tmdb_trending_movie', JSON.stringify({ ...kept, at: Date.now() - 3 * 24 * 60 * 60 * 1000 }));

    const away = setup({ trending: titles, held, failFrom: 1 });
    expect((await away.popular('movie')).map(entry => entry.item.title)).toEqual(['Hope']);

    localStorage.setItem('xtream_tmdb_trending_movie', JSON.stringify({ ...kept, at: Date.now() - 8 * 24 * 60 * 60 * 1000 }));
    localStorage.removeItem('xtream_popular_pages');
    await expect(setup({ trending: titles, held, failFrom: 1 }).page('movie', 1)).rejects.toThrow('TMDB answered 503');
  });

  it("keeps a list's matched pages for the day, and shows the last while today's is worked out", async () => {
    const titles = [trend('movie', 1, 'Hope', '2026'), trend('movie', 2, 'Dune', '2021')];
    const held = { 'vod:Hope': [stream(1, 'Hope')], 'vod:Dune': [stream(2, 'Dune')] };
    await setup({ trending: titles, held }).popular('movie', 12, 'top');

    // Another visit the same day: nothing asked of TMDB, nothing looked up.
    const later = setup({ trending: titles, held, locked: ['2'] });
    expect((await later.popular('movie', 12, 'top')).map(entry => entry.item.title)).toEqual(['Hope']);
    expect([...tmdbAsked, ...searched]).toEqual([]);

    // A day on, the last row is there at once while today's is matched.
    const kept = JSON.parse(localStorage.getItem('xtream_popular_pages')!);
    localStorage.setItem('xtream_popular_pages', JSON.stringify(kept.map((page: { at: number }) => ({ ...page, at: page.at - 2 * 24 * 60 * 60 * 1000 }))));
    const tomorrow = setup({ trending: titles, held });
    expect((await tomorrow.lastPopular('movie', 12, 'top'))?.map(entry => entry.item.title)).toEqual(['Hope', 'Dune']);
    expect(searched).toEqual([]);
    expect(await tomorrow.lastPopular('movie', 12, 'trending')).toBeNull();
  });

  it('looks up a list of titles in one go, each with its own copies', async () => {
    const service = setup({ held: { 'vod:Hope': [stream(1, 'Hope')] } });
    const copies = await service.copiesIn('vod', [trend('movie', 1, 'Hope', '2026'), trend('movie', 2, 'Unheld', '2020')]);
    expect(copies.get(1)?.map(held => held.stream_id)).toEqual(['1']);
    expect(copies.get(2)).toEqual([]);
  });

  it('keeps what the row found when TMDB stops answering, and tells a page asked for on purpose', async () => {
    const titles = ['A', 'B', 'C', 'D'].map((title, index) => trend('movie', index + 1, title, '2025'));
    const service = setup({ trending: titles, perPage: 2, failFrom: 2, held: { 'vod:A': [stream(1, 'A')] } });

    expect((await service.popular('movie')).map(entry => entry.item.title)).toEqual(['A']);
    await expect(service.page('movie', 2)).rejects.toThrow('TMDB answered 503');
  });
});

describe('TmdbService', () => {
  const setup = (options: { serviceKey?: string | null; local?: boolean; tmdbStatus?: number } = {}) => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: HttpClient, useValue: { get: () => of({ data: { apiKey: options.serviceKey ?? null } }) } },
        { provide: API_URL, useValue: () => 'https://sync.example/api' },
        { provide: LocalProfileService, useValue: { active: signal(options.local ?? false) } }
      ]
    });
    const service = TestBed.inject(TmdbService);
    const used: string[] = [];
    service.fetchImpl = async url => {
      used.push(new URL(url).searchParams.get('api_key') ?? '');
      const status = options.tmdbStatus ?? 200;
      return { ok: status === 200, status, json: async () => ({ results: [] }) };
    };
    return { service, used };
  };

  beforeEach(() => localStorage.clear());

  it("uses the key typed on this device before the sync service's, and the service's otherwise", async () => {
    const { service, used } = setup({ serviceKey: 'service-key' });
    await (await service.client())!.trending('movie', 'en-US');
    await service.setOwnKey('  own-key  ');
    await (await service.client())!.trending('movie', 'en-US');
    service.clearOwnKey();
    await (await service.client())!.trending('movie', 'en-US');

    expect(used).toEqual(['service-key', 'own-key', 'own-key', 'service-key']);
    expect(localStorage.getItem('xtream_tmdb_key')).toBeNull();
  });

  it('has a client without an account only once a key is typed', async () => {
    const { service } = setup({ local: true, serviceKey: 'never-asked' });
    expect(await service.client()).toBeNull();
    await service.setOwnKey('own-key');
    expect(await service.client()).not.toBeNull();
  });

  it('keeps nothing TMDB refuses', async () => {
    const { service } = setup({ tmdbStatus: 401 });
    await expect(service.setOwnKey('wrong')).rejects.toThrow('TMDB answered 401');
    expect(service.ownKey()).toBe('');
    expect(localStorage.getItem('xtream_tmdb_key')).toBeNull();
  });
});
