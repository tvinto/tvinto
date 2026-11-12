import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Account } from '@shared/types';
import { countChanges } from '@shared/sync';
import { AccountService } from './account.service';
import { PlatformService } from './platform.service';
import { LocalUserDataService } from './local-user-data.service';

/**
 * The device's own copy of the account, and how it survives a move.
 *
 * Every fault this covers shipped, and every one of them was silent. A drawer
 * named after the id a server assigned; an empty drawer counting as a drawer;
 * a refused token treated as a sign-out and clearing the lot. None of them
 * threw, none of them logged, and the only symptom was an account that arrived
 * somewhere new looking brand new.
 *
 * They were possible because nothing here could be injected in a test. That is
 * what this file is for.
 */

const ACCOUNT: Account = { id: 1, username: 'AnaMaria', createdAt: '2026-08-30T10:00:00.000Z' };

/** A drawer as an older build wrote it, holding real work. */
const holdings = () =>
  JSON.stringify({
    favourites: {
      'live:101': {
        change: { type: 'live', streamId: '101', name: 'HTV 1', updatedAt: '2026-08-30T10:00:00.000Z' },
        icon: ''
      }
    },
    progress: {
      'vod:55': {
        type: 'vod',
        itemId: '55',
        seriesId: null,
        season: null,
        episodeNum: null,
        name: 'A Film',
        episodeTitle: null,
        icon: null,
        containerExtension: 'mkv',
        positionSeconds: 1902,
        durationSeconds: 3600,
        completed: false,
        updatedAt: '2026-08-30T10:00:00.000Z'
      }
    },
    arrangements: {
      'category:live': {
        scope: 'category:live',
        itemIds: ['3', '1'],
        names: {},
        updatedAt: '2026-08-30T10:00:00.000Z'
      }
    },
    tombstones: {
      'favourite:live:99': {
        kind: 'favourite',
        key: 'live:99',
        deletedAt: '2026-08-30T09:00:00.000Z'
      }
    },
    pending: {
      favourites: [],
      arrangements: [],
      progress: [],
      settings: [],
      guideSources: [],
      channelMappings: [],
      deletions: []
    }
  });

/** The same shape, with nothing in it, as a failed adoption leaves behind. */
const emptyDrawer = () =>
  JSON.stringify({ favourites: {}, progress: {}, arrangements: {}, tombstones: {} });

describe('LocalUserDataService', () => {
  const account = signal<Account | null>(ACCOUNT);
  const deliberateSignOuts = signal(0);

  const build = (): LocalUserDataService => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: AccountService, useValue: { account, deliberateSignOuts, storageName: () => account()?.username } },
        { provide: PlatformService, useValue: { keepsLocalData: true } }
      ]
    });
    return TestBed.inject(LocalUserDataService);
  };

  beforeEach(() => {
    localStorage.clear();
    account.set(ACCOUNT);
    deliberateSignOuts.set(0);
  });

  describe('finding the account after a move', () => {
    it('adopts a drawer an older build named after the account id', () => {
      // The bug in one line. The same person was user 2 on the old service and
      // user 1 on the new one, so the device looked under a name nothing had
      // ever written to.
      localStorage.setItem('xtream_local_data:2', holdings());

      expect(build().favourites('live')).toHaveLength(1);
    });

    it('keeps it under the new name, so it is found without hunting again', () => {
      localStorage.setItem('xtream_local_data:2', holdings());
      build().favourites('live');

      expect(localStorage.getItem('xtream_local_data:anamaria')).not.toBeNull();
    });

    it('takes the old drawer rather than copying it', () => {
      localStorage.setItem('xtream_local_data:2', holdings());
      build().favourites('live');

      // Leaving it sounds harmless and is not: signing out removes the drawer
      // it knows the name of, and the one it does not is adopted straight back
      // on the next read -- so the account would survive its own deletion.
      // Nothing needs the old name any more; both services look under the new
      // one.
      expect(localStorage.getItem('xtream_local_data:2')).toBeNull();
    });

    it('skips an empty drawer and takes the one with the account in it', () => {
      // Signing in to the new service created a drawer under the id it
      // assigned, before anything had been written to it.
      localStorage.setItem('xtream_local_data:1', emptyDrawer());
      localStorage.setItem('xtream_local_data:2', holdings());

      expect(build().favourites('live')).toHaveLength(1);
    });

    it('adopts even when an empty drawer already sits under the right name', () => {
      // What the first attempt at the fix left behind, and then tripped over:
      // a key that exists is not the same as an account that exists.
      localStorage.setItem('xtream_local_data:anamaria', emptyDrawer());
      localStorage.setItem('xtream_local_data:2', holdings());

      expect(build().favourites('live')).toHaveLength(1);
    });

    it('starts empty when there is genuinely nothing to adopt', () => {
      expect(build().favourites('live')).toEqual([]);
    });
  });

  describe('drawing the favourites rail', () => {
    /** A favourite as it arrives from another device: a name, and no picture. */
    const synced = () =>
      JSON.stringify({
        favourites: {
          'live:101': {
            change: { type: 'live', streamId: '101', name: 'HTV 1', updatedAt: '2026-08-30T10:00:00.000Z' },
            icon: ''
          },
          'live:102': {
            // Starred before names travelled: neither half survived the trip.
            change: { type: 'live', streamId: '102', name: null, updatedAt: '2026-08-20 20:09:43' },
            icon: ''
          }
        },
        progress: {
          'live:101': {
            type: 'live',
            itemId: '101',
            seriesId: null,
            season: null,
            episodeNum: null,
            name: 'HTV 1',
            episodeTitle: null,
            icon: 'https://logos.example/htv1.png',
            containerExtension: null,
            positionSeconds: 60,
            durationSeconds: 0,
            completed: false,
            updatedAt: '2026-08-30T11:00:00.000Z'
          }
        },
        arrangements: {},
        tombstones: {}
      });

    beforeEach(() => localStorage.setItem('xtream_local_data:anamaria', synced()));

    it('borrows the logo from the history when the favourite has none', async () => {
      // Only the name travels between devices -- a logo is a URL into the
      // provider. The history on this device has both, for the same channels.
      const [first] = build().favourites('live');

      expect((first as unknown as { stream_icon: string }).stream_icon).toBe(
        'https://logos.example/htv1.png'
      );
    });

    it('never draws a card with nothing on it', async () => {
      // What this replaces: a favourite with no name rendered as a star, a
      // placeholder glyph and no words at all.
      const [, second] = build().favourites('live');

      expect(second.name).toBe('Channel 102');
    });
  });

  describe('the tracks a film was watched with', () => {
    const watched = () => {
      const service = build();
      service.saveProgress({
        type: 'vod',
        itemId: '55',
        name: 'A Film',
        positionSeconds: 600,
        durationSeconds: 5400
      } as never);
      return service;
    };

    it('says nobody has chosen, before anybody has', () => {
      // Null, not "no subtitles" -- the difference decides whether the account
      // preference gets to speak.
      expect(watched().tracksFor('vod', '55')).toBeNull();
    });

    it('remembers what the player reported', () => {
      const service = watched();

      service.rememberTracks('vod', '55', {
        audioLanguage: 'eng',
        subtitleLanguage: 'hrv',
        audioTitle: '',
        subtitleTitle: 'English (SDH)',
        subtitlesEnabled: true
      });

      expect(service.tracksFor('vod', '55')).toEqual({
        audioLanguage: 'eng',
        subtitleLanguage: 'hrv',
        audioTitle: '',
        // The half a language cannot carry: three tracks here say `eng` and
        // differ only by name.
        subtitleTitle: 'English (SDH)',
        subtitlesEnabled: true
      });
    });

    it('keeps it while the position goes on ticking', () => {
      // The one that would break it in use: a position is written every ten
      // seconds, and each write rebuilds the row.
      const service = watched();
      service.rememberTracks('vod', '55', {
        audioLanguage: '',
        subtitleLanguage: 'hrv',
        audioTitle: '',
        subtitleTitle: '',
        subtitlesEnabled: true
      });

      service.saveProgress({
        type: 'vod',
        itemId: '55',
        name: 'A Film',
        positionSeconds: 900,
        durationSeconds: 5400
      } as never);

      expect(service.tracksFor('vod', '55')?.subtitleLanguage).toBe('hrv');
    });

    it('sends the choice to the other devices on the account', () => {
      const service = watched();

      service.rememberTracks('vod', '55', {
        audioLanguage: '',
        subtitleLanguage: 'hrv',
        audioTitle: '',
        subtitleTitle: '',
        subtitlesEnabled: true
      });

      const queued = service.pending().progress.find(change => change.itemId === '55');
      expect(queued).toMatchObject({ subtitleLanguage: 'hrv', subtitlesEnabled: true });
    });
  });

  describe('the tracks a show was watched with', () => {
    const english = {
      audioLanguage: 'en',
      subtitleLanguage: 'en',
      audioTitle: 'Surround',
      subtitleTitle: 'Full',
      subtitlesEnabled: true
    };

    const episode = (service: LocalUserDataService, itemId: string, seriesId = '7120') =>
      service.saveProgress({
        type: 'series',
        itemId,
        seriesId,
        name: 'Supernatural',
        positionSeconds: 60,
        durationSeconds: 2600
      } as never);

    it('offers what the last episode was watched with, for another episode of the show', () => {
      // Chosen in S4E13; S4E14 opened from the show's page had nothing of its
      // own and came up in the account's defaults.
      const service = build();
      episode(service, '1413');
      service.rememberTracks('series', '1413', english);

      expect(service.tracksForShow('7120')).toEqual(english);
    });

    it('takes the most recent choice when episodes were watched differently', () => {
      const service = build();
      episode(service, '1401');
      service.rememberTracks('series', '1401', { ...english, subtitlesEnabled: false });
      episode(service, '1413');
      service.rememberTracks('series', '1413', english);

      expect(service.tracksForShow('7120')?.subtitlesEnabled).toBe(true);
    });

    it('does not borrow from another show', () => {
      const service = build();
      episode(service, '901', '8000');
      service.rememberTracks('series', '901', english);

      expect(service.tracksForShow('7120')).toBeNull();
    });

    it('keeps a choice reported before the episode had a position', () => {
      // The order it really happens in: the player's answer, tracks and all,
      // is read before the page writes where the episode got to.
      const service = build();
      service.rememberTracks('series', '1414', english);
      episode(service, '1414');

      expect(service.tracksFor('series', '1414')).toEqual(english);
      expect(service.tracksForShow('7120')).toEqual(english);
    });

    it('knows which show an episode it has seen belongs to', () => {
      const service = build();
      episode(service, '1413');

      expect(service.showOf('1413')).toBe('7120');
      expect(service.showOf('9999')).toBeNull();
    });
  });

  describe('a report from a player closed before its stream loaded', () => {
    // The Last Bus E3: 28 min left, then Back on the opening panel sent where
    // it was asked to start, with the length not yet known.
    const partWatched = () => {
      const service = build();
      service.saveProgress({ type: 'series', itemId: '13', name: 'The Last Bus', positionSeconds: 360, durationSeconds: 2056 } as never);
      return service;
    };

    it('keeps the length already known', () => {
      const service = partWatched();

      const saved = service.saveProgress({ type: 'series', itemId: '13', name: 'The Last Bus', positionSeconds: 362, durationSeconds: 0 } as never);

      expect(saved.durationSeconds).toBe(2056);
      expect(saved.positionSeconds).toBe(362);
    });

    it('still takes a length that is known', () => {
      const service = partWatched();

      const saved = service.saveProgress({ type: 'series', itemId: '13', name: 'The Last Bus', positionSeconds: 400, durationSeconds: 2100 } as never);

      expect(saved.durationSeconds).toBe(2100);
    });

    it('leaves a live channel without a length', () => {
      const service = build();
      service.saveProgress({ type: 'live', itemId: '7', name: 'HRT 1', positionSeconds: 60, durationSeconds: 60 } as never);

      const saved = service.saveProgress({ type: 'live', itemId: '7', name: 'HRT 1', positionSeconds: 90, durationSeconds: 0 } as never);

      expect(saved.durationSeconds).toBe(0);
    });
  });

  describe('offering a new server everything held', () => {
    it('queues every kind, not only what was waiting', () => {
      localStorage.setItem('xtream_local_data:2', holdings());
      const service = build();

      service.requeueEverything();

      // One of each, and the removal too -- without that, a favourite deleted
      // here would come back the moment the new server heard of it elsewhere.
      expect(countChanges(service.pending())).toBe(4);
      expect(service.pending().deletions).toHaveLength(1);
    });

    it('gives the same answer twice, so a failed push does not double it', () => {
      localStorage.setItem('xtream_local_data:2', holdings());
      const service = build();

      service.requeueEverything();
      const once = service.pending();
      service.requeueEverything();

      expect(service.pending()).toEqual(once);
    });
  });

  describe('losing the session versus signing out', () => {
    it('keeps everything when the server merely refused the token', () => {
      localStorage.setItem('xtream_local_data:2', holdings());
      const service = build();
      service.favourites('live');

      // What a refused session does: the account goes, the token goes, and
      // this is not told that anybody signed out.
      account.set(null);
      TestBed.tick();

      account.set(ACCOUNT);
      TestBed.tick();
      expect(service.favourites('live')).toHaveLength(1);
    });

    it('clears everything when somebody signs out on purpose', () => {
      localStorage.setItem('xtream_local_data:2', holdings());
      const service = build();
      service.favourites('live');

      deliberateSignOuts.update(count => count + 1);
      TestBed.tick();

      expect(service.favourites('live')).toEqual([]);
    });
  });
});
