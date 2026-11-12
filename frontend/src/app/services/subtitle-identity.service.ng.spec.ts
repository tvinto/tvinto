import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Account } from '@shared/types';
import { AccountService } from './account.service';
import { ProviderAccessService } from './provider-access.service';
import { SubtitleIdentityService } from './subtitle-identity.service';

/**
 * Knowing which film or episode "Add subtitles" is for, asking the provider at
 * most once per title on this device.
 */

const ACCOUNT: Account = { id: 7, username: 'AnaMaria', createdAt: '2026-08-30T10:00:00.000Z' };
const PROVIDER_USERNAME = 'line-user-123';

describe('SubtitleIdentityService', () => {
  let client: { getVodInfo: jest.Mock; getSeriesInfo: jest.Mock };
  let direct: boolean;

  const build = () => {
    client = {
      getVodInfo: jest.fn().mockResolvedValue({ info: { tmdb_id: '24188', releasedate: '2004-03-11' } }),
      getSeriesInfo: jest.fn().mockResolvedValue({ info: { tmdb: '1668' }, episodes: {} })
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: AccountService, useValue: { account: signal(ACCOUNT) } },
        {
          provide: ProviderAccessService,
          useValue: { direct: async () => (direct ? { client, catalogue: {}, providerUsername: PROVIDER_USERNAME } : null) }
        }
      ]
    });
    return TestBed.inject(SubtitleIdentityService);
  };

  beforeEach(() => {
    localStorage.clear();
    direct = true;
  });

  it('asks the provider about a film once, then remembers', async () => {
    const identity = build();

    const first = await identity.film(4512, 'HR - Ne diraj mi mamu (2004)');
    const second = await identity.film(4512, 'HR - Ne diraj mi mamu (2004)');

    expect(first).toMatchObject({ matchedBy: 'tmdb', tmdbId: 24188, title: 'Ne diraj mi mamu', year: 2004 });
    expect(second).toEqual(first);
    expect(client.getVodInfo).toHaveBeenCalledTimes(1);
    expect(client.getVodInfo).toHaveBeenCalledWith('4512', 8000);
  });

  it('remembers under a name that is not the provider username', async () => {
    const identity = build();

    await identity.film(4512, 'Film');

    expect(localStorage.getItem('xtream.subtitleIdentity.v1')).not.toContain(PROVIDER_USERNAME);
  });

  it('searches by title when the provider cannot be reached, and asks again next time', async () => {
    const identity = build();
    client.getVodInfo.mockRejectedValueOnce(new Error('timed out'));

    expect(await identity.film(4512, 'EN - Some Film (2019)')).toMatchObject({ matchedBy: 'title', title: 'Some Film', year: 2019 });
    await identity.film(4512, 'EN - Some Film (2019)');

    expect(client.getVodInfo).toHaveBeenCalledTimes(2);
  });

  it('remembers that a film has no id, rather than asking again', async () => {
    const identity = build();
    client.getVodInfo.mockResolvedValue({ info: { tmdb_id: '' } });

    await identity.film(9, 'Novine');
    await identity.film(9, 'Novine');

    expect(client.getVodInfo).toHaveBeenCalledTimes(1);
  });

  it('uses the show details the page already has, and remembers them for later episodes', async () => {
    const identity = build();

    const fromPage = await identity.episode(14178, 'EN - Friends - UNCUT (1994)', { season: 3, episode: 2 }, { info: { tmdb: '1668' } });
    const later = await identity.episode(14178, 'EN - Friends - UNCUT (1994)', { season: 5, episode: 1 });

    expect(fromPage).toMatchObject({ matchedBy: 'tmdb', parentTmdbId: 1668, season: 3, episode: 2 });
    expect(later).toMatchObject({ parentTmdbId: 1668, season: 5, episode: 1 });
    expect(client.getSeriesInfo).not.toHaveBeenCalled();
  });

  it('asks for the show once when nothing is at hand', async () => {
    const identity = build();

    await identity.episode(1406, 'Deadwood', { season: 1, episode: 1 });
    await identity.episode(1406, 'Deadwood', { season: 1, episode: 2 });

    expect(client.getSeriesInfo).toHaveBeenCalledTimes(1);
  });

  it('keeps two subscriptions apart', async () => {
    const identity = build();
    await identity.film(4512, 'Film');

    const other = TestBed.inject(ProviderAccessService) as unknown as { direct: () => Promise<unknown> };
    other.direct = async () => ({ client, catalogue: {}, providerUsername: 'another-line' });
    await identity.film(4512, 'Film');

    expect(client.getVodInfo).toHaveBeenCalledTimes(2);
  });

  it('answers by title on a build that cannot reach the provider', async () => {
    direct = false;
    const identity = build();

    expect(await identity.film(1, 'EN - Film (2020)')).toMatchObject({ matchedBy: 'title', title: 'Film', year: 2020 });
    expect(client.getVodInfo).not.toHaveBeenCalled();
  });
});
