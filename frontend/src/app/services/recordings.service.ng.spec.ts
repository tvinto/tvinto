import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { Stream } from '@shared/types';
import { bookingKey, readPlanned, recorderKey, writePlanned, writeRecorder } from '@shared/recording/plan';
import { SettingsService } from './settings.service';
import { TvNavigationService } from './tv-navigation.service';
import { XtreamService } from './xtream.service';

/**
 * Bookings belong to the account and each recording device books, natively,
 * what is for it (private plan: recording). Driven through a stand-in for the
 * desktop's recorder, which is how the page finds one in a browser.
 */
describe('RecordingsService, bookings for the account', () => {
  const HOUR = 3_600_000;
  let values: ReturnType<typeof signal<Record<string, string>>>;
  let native: { booked: Array<{ id: string; url: string; startMs: number; endsAt: number }>; cancelled: string[] };
  let deleted: string[];
  let made: Array<Record<string, unknown>>;
  let removed: string[];
  let airings: Array<{ title: string; start_timestamp: number; stop_timestamp: number }>;

  const channel = { stream_id: '7', name: 'HRT 1' } as unknown as Stream;

  const make = async () => {
    const { RecordingsService } = await import('./recordings.service');
    const service = TestBed.inject(RecordingsService);
    TestBed.tick();
    await service.reconcile();
    return service;
  };

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('tvinto_recorder_key', 'thisdevice1');
    values = signal<Record<string, string>>({});
    native = { booked: [], cancelled: [] };
    deleted = [];
    made = [];
    removed = [];
    airings = [];
    (window as unknown as { xtreamDesktop: unknown }).xtreamDesktop = {
      recorder: {
        list: async () => ({ recordings: made.filter(one => !removed.includes(String(one['id']))) }),
        remove: async ({ id }: { id: string }) => (removed.push(id), { removed: true }),
        bookings: async () => ({ bookings: native.booked.filter(one => !native.cancelled.includes(one.id)).map(({ url: _u, ...rest }) => ({ ...rest, title: '', channel: '', channelId: '7' })) }),
        book: async (one: { id: string; url: string; startMs: number; endsAt: number }) => void (native.booked = [...native.booked.filter(held => held.id !== one.id), one]),
        cancelBooking: async ({ id }: { id: string }) => void native.cancelled.push(id),
        onChanged: () => () => undefined
      }
    };
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SettingsService,
          useValue: {
            loaded: () => true,
            all: () => values(),
            get: (key: string) => values()[key] ?? null,
            set: (key: string, value: string) => values.update(now => ({ ...now, [key]: value })),
            delete: (key: string) => {
              deleted.push(key);
              values.update(now => Object.fromEntries(Object.entries(now).filter(([name]) => name !== key)));
            }
          }
        },
        { provide: TvNavigationService, useValue: { isTelevision: () => true } },
        {
          provide: XtreamService,
          useValue: {
            learnConnectionsAllowed: async () => undefined,
            guideForStreams: () => of({ '7': airings }),
            getPlaybackUrl: (_type: string, id: string, extension: string) => of(`http://provider/live/u/p/${id}.${extension}`)
          }
        }
      ]
    });
  });

  afterEach(() => {
    delete (window as unknown as { xtreamDesktop?: unknown }).xtreamDesktop;
  });

  it('keeps a booking for the account and books it here as TS, with the minutes either side', async () => {
    const service = await make();
    const start = Date.now() + HOUR;
    const result = await service.book(channel, 'HRT 1', { title: 'Dnevnik', startMs: start, stopMs: start + HOUR });

    expect('booked' in result).toBe(true);
    const [kept] = readPlanned(values());
    expect(kept).toEqual(expect.objectContaining({ device: 'thisdevice1', channelId: '7', startMs: start }));
    expect(values()[bookingKey(kept.id)]).not.toContain('provider');
    // A minute before and two after by default; the recorder itself starts a minute before what it is given.
    expect(native.booked).toEqual([expect.objectContaining({ id: kept.id, url: 'http://provider/live/u/p/7.ts', startMs: start, endsAt: start + HOUR + 2 * 60_000 })]);
  });

  it('books again with the new minutes when the account changes them', async () => {
    const service = await make();
    const start = Date.now() + HOUR;
    await service.book(channel, 'HRT 1', { title: 'Dnevnik', startMs: start, stopMs: start + HOUR });
    service.setOptions({ beforeMin: 1, afterMin: 10, keepDays: null });
    await service.reconcile();
    expect(native.booked.at(-1)).toEqual(expect.objectContaining({ endsAt: start + HOUR + 10 * 60_000 }));
  });

  it('deletes recordings older than the account keeps them, and none while kept until deleted', async () => {
    const day = 24 * HOUR;
    const one = (id: string, daysAgo: number) => ({ id, title: id, channel: '', channelId: '7', startedAt: Date.now() - daysAgo * day, endsAt: 0, state: 'done', bytes: 1, path: `file:///r/${id}.ts` });
    made = [one('new', 1), one('old', 20)];
    const service = await make();
    expect(removed).toEqual([]);

    service.setOptions({ beforeMin: 1, afterMin: 2, keepDays: 7 });
    await service.reconcile();
    expect(removed).toEqual(['old']);
    expect(service.recordings().map(kept => kept.id)).toEqual(['new']);
  });

  it('records every airing of a title, skips one cancelled, and stops', async () => {
    const at = (hours: number) => Math.floor((Date.now() + hours * HOUR) / 1000);
    airings = [
      { title: 'Dnevnik', start_timestamp: at(2), stop_timestamp: at(2.5) },
      { title: 'Vijesti', start_timestamp: at(3), stop_timestamp: at(3.5) },
      { title: 'Dnevnik', start_timestamp: at(20), stop_timestamp: at(20.5) }
    ];
    const service = await make();
    const rule = await service.recordEvery({ ...channel, epg_channel_id: 'HRT1.hr' } as Stream, 'HRT 1', 'Dnevnik');
    await service.reconcile();

    expect(service.planned().map(one => one.startMs)).toEqual([at(2) * 1000, at(20) * 1000]);
    expect(native.booked.map(one => one.id).sort()).toEqual(service.planned().map(one => one.id).sort());

    const first = service.planned()[0].id;
    await service.cancelBooking(first);
    await service.reconcile();
    expect(service.planned().map(one => one.id)).not.toContain(first);
    expect(service.rules()[0].skip).toEqual([first]);

    await service.stopEvery(rule!.id);
    expect(service.rules()).toEqual([]);
    expect(service.planned()).toEqual([]);
  });

  it('announces itself, so other devices can book for it', async () => {
    await make();
    expect(JSON.parse(values()[recorderKey('thisdevice1')])).toEqual(expect.objectContaining({ kind: 'tv' }));
  });

  it("leaves another device's booking to that device", async () => {
    const start = Date.now() + HOUR;
    values.set({ [bookingKey('b1')]: writePlanned({ id: 'b1', device: 'kitchen', channelId: '7', channel: 'HRT 1', title: 'Film', startMs: start, stopMs: start + HOUR }) });
    const service = await make();
    expect(native.booked).toEqual([]);
    expect(service.planned().map(one => one.id)).toEqual(['b1']);
  });

  it('books for another device by naming it, and refuses what would need a second stream', async () => {
    values.set({ [recorderKey('kitchen')]: writeRecorder({ key: 'kitchen', name: 'Kitchen', kind: 'tv', seenAt: Date.now() }) });
    const service = await make();
    const start = Date.now() + HOUR;
    await service.book(channel, 'HRT 1', { title: 'One', startMs: start, stopMs: start + HOUR }, 'kitchen');
    expect(native.booked).toEqual([]);
    expect(service.deviceName('kitchen')).toBe('Kitchen');

    const clash = await service.book(channel, 'HRT 1', { title: 'Two', startMs: start + HOUR / 2, stopMs: start + 2 * HOUR });
    expect(clash).toEqual({ clash: [expect.objectContaining({ title: 'One' })] });
  });

  it('cancels its own booking when another device cancelled it', async () => {
    const service = await make();
    const start = Date.now() + HOUR;
    const result = await service.book(channel, 'HRT 1', { title: 'Dnevnik', startMs: start, stopMs: start + HOUR });
    const id = 'booked' in result ? result.booked.id : '';

    values.set({});
    await service.reconcile();
    expect(native.cancelled).toEqual([id]);
  });

  it('cancels for every device by deleting the key', async () => {
    const service = await make();
    const start = Date.now() + HOUR;
    const result = await service.book(channel, 'HRT 1', { title: 'Dnevnik', startMs: start, stopMs: start + HOUR });
    const id = 'booked' in result ? result.booked.id : '';
    await service.cancelBooking(id);
    expect(deleted).toEqual([bookingKey(id)]);
    expect(native.cancelled).toEqual([id]);
  });
});
