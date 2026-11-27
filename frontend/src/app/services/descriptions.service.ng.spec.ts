import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { TmdbFetch } from '@shared/tmdb/client';
import { API_URL } from './api-url';
import { DescriptionsService } from './descriptions.service';
import { ProviderAccessService } from './provider-access.service';
import { SettingsService } from './settings.service';

/**
 * Whose words a film or episode is described in: the
 * provider's unless the account chose a language, TMDB's in that language
 * then in English, and never a request to TMDB that the choice did not need.
 */

const FILM_INFO = { info: { tmdb_id: '603', plot: 'Hakerski film na švedskom.' } };

const SHOW_INFO = { info: { tmdb: '1668', name: 'Friends' } };

describe('DescriptionsService', () => {
  let asked: string[];
  let settings: Record<string, string>;

  const setup = (options: { key?: string | null; tmdb?: Record<string, unknown>; offline?: boolean } = {}) => {
    asked = [];
    const answers = options.tmdb ?? {};
    const http = {
      get: () => options.offline ? throwError(() => new Error('offline')) : (options.key === undefined || options.key ? of({ data: { apiKey: options.key ?? 'test-key' } }) : of({ data: { apiKey: null } }))
    };
    const direct = { client: { getVodInfo: async () => FILM_INFO } };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: HttpClient, useValue: http },
        { provide: API_URL, useValue: () => 'https://sync.example/api' },
        {
          provide: SettingsService,
          useValue: {
            get: (key: string) => settings[key] ?? null,
            set: (key: string, value: string) => (settings[key] = value)
          }
        },
        { provide: ProviderAccessService, useValue: { direct: async () => direct, records: signal([]) } }
      ]
    });

    const service = TestBed.inject(DescriptionsService);
    const fetchImpl: TmdbFetch = async url => {
      const parsed = new URL(url);
      const path = `${parsed.pathname.replace('/3', '')}?${parsed.searchParams.get('language') ?? ''}`;
      asked.push(path);
      const body = answers[path];
      return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
    };
    service.fetchImpl = fetchImpl;
    return service;
  };

  beforeEach(() => {
    localStorage.clear();
    settings = {};
  });

  it("keeps the provider's words, and asks TMDB nothing, when that is the choice", async () => {
    const service = setup();

    expect(await service.film(1, 'The Matrix (1999)')).toEqual({ text: 'Hakerski film na švedskom.', source: 'provider' });
    expect(asked).toEqual([]);
  });

  it('describes in the chosen language, through the id the provider gave', async () => {
    settings['descriptionLanguage'] = 'hr';
    const service = setup({ tmdb: { '/movie/603?hr-HR': { id: 603, title: 'Matrix', overview: 'Haker otkriva istinu.' } } });

    expect(await service.film(1, 'The Matrix (1999)')).toEqual({ text: 'Haker otkriva istinu.', source: 'tmdb' });
  });

  it('falls back to English where nobody wrote it in the chosen language', async () => {
    settings['descriptionLanguage'] = 'hr';
    const service = setup({
      tmdb: {
        '/movie/603?hr-HR': { id: 603, title: 'Matrix', overview: '' },
        '/movie/603?en-US': { id: 603, title: 'The Matrix', overview: 'A hacker learns the truth.' }
      }
    });

    expect(await service.film(1, 'The Matrix (1999)')).toEqual({ text: 'A hacker learns the truth.', source: 'tmdb' });
  });

  it('looks a film up by its name without the quality and copy words a provider adds', async () => {
    const service = setup({
      tmdb: { '/search/movie?en-US': { results: [{ id: 9001, title: 'The Odyssey', original_title: 'The Odyssey', release_date: '2026-06-01' }] } }
    });

    expect(await service.filmTmdbIdByName('EN - The Odyssey 4K (2026)')).toBe(9001);
  });

  it('remembers what TMDB said, so the same film twice is one request', async () => {
    settings['descriptionLanguage'] = 'en';
    const service = setup({ tmdb: { '/movie/603?en-US': { id: 603, title: 'The Matrix', overview: 'A hacker.' } } });

    await service.film(1, 'The Matrix (1999)');
    await service.film(1, 'The Matrix (1999)');

    expect(asked).toEqual(['/movie/603?en-US']);
  });

  it("shows the provider's words when this sync service has no TMDB key", async () => {
    settings['descriptionLanguage'] = 'en';
    const service = setup({ key: null });

    expect(await service.film(1, 'The Matrix (1999)')).toEqual({ text: 'Hakerski film na švedskom.', source: 'provider' });
    expect(asked).toEqual([]);
  });

  it("fills the episodes the provider left empty, and leaves the rest its own", async () => {
    const service = setup({
      tmdb: {
        '/tv/1668/season/3?en-US': {
          episodes: [
            { episode_number: 1, name: 'One', overview: 'Ross and Rachel.' },
            { episode_number: 2, name: 'Two', overview: 'Monica cooks.' }
          ]
        }
      }
    });

    const found = await service.episodes(SHOW_INFO, 'Friends', 3, new Map([[1, 'Vlastiti opis.'], [2, '']]));

    expect(found.get(1)).toEqual({ text: 'Vlastiti opis.', source: 'provider' });
    expect(found.get(2)).toEqual({ text: 'Monica cooks.', source: 'tmdb' });
  });

  it('asks TMDB nothing for episodes the provider described, when that is the choice', async () => {
    const service = setup();

    const found = await service.episodes(SHOW_INFO, 'Friends', 3, new Map([[1, 'Opis.']]));

    expect(found.get(1)?.source).toBe('provider');
    expect(asked).toEqual([]);
  });

  it('keeps working when the sync service cannot be reached', async () => {
    settings['descriptionLanguage'] = 'en';
    const service = setup({ offline: true });

    expect(await service.film(1, 'The Matrix (1999)')).toEqual({ text: 'Hakerski film na švedskom.', source: 'provider' });
  });
});
