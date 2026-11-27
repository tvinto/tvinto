import { Stream } from '@shared/types';
import { guideCandidates, indexGuideChannels, resolveGuideChannel } from '@shared/xtream/guideMatching';
import { CapacitorCatalogueStore } from './capacitorCatalogueStore';
import { idleWork } from '../../utils/library-refresh.utils';

describe('CapacitorCatalogueStore.writeStreams', () => {
  const stream = (id: number) => ({ stream_id: String(id), name: `Film ${id}` }) as unknown as Stream;

  it('writes a large category in pieces, so a read waits for one piece and not the whole of it', async () => {
    const written: number[] = [];
    const db = {
      executeSet: async (set: Array<{ values: unknown[][] }>) => {
        written.push(set[0].values.length);
        return { changes: { changes: set[0].values.length } };
      }
    };
    const store = new CapacitorCatalogueStore(db as never, 'provider');

    await store.writeStreams('vod', '7', Array.from({ length: 600 }, (_, i) => stream(i)));

    expect(written).toEqual([250, 250, 100]);
  });
});

describe('CapacitorCatalogueStore searches', () => {
  type Rows = { values: Record<string, unknown>[] };
  interface SqlJs {
    exec(sql: string, params?: unknown[]): { columns: string[]; values: unknown[][] }[];
  }

  /** The store on a real SQLite (sql.js, which the web build's plugin already ships). */
  const open = async () => {
    const module = 'sql.js/dist/sql-asm.js';
    const initSqlJs = ((await import(module)) as { default: () => Promise<{ Database: new () => SqlJs }> }).default;
    const sqlite = new (await initSqlJs()).Database();
    const query = async (sql: string, params: unknown[] = []): Promise<Rows> => {
      const [result] = sqlite.exec(sql, params);
      return { values: (result?.values ?? []).map(row => Object.fromEntries(result.columns.map((column, i) => [column, row[i]]))) };
    };
    const db = {
      execute: async (sql: string) => (sqlite.exec(sql), { changes: { changes: 0 } }),
      query,
      run: async (sql: string, params: unknown[] = []) => (sqlite.exec(sql, params), { changes: { changes: 0 } }),
      executeSet: async (set: Array<{ statement: string; values: unknown[][] }>) => {
        for (const row of set[0].values) {
          sqlite.exec(set[0].statement, row);
        }
        return { changes: { changes: set[0].values.length } };
      }
    };
    const store = new CapacitorCatalogueStore(db as never, 'provider');
    await store.initialise();
    return { store, query };
  };

  const film = (id: number, name: string) => ({ stream_id: String(id), name }) as unknown as Stream;

  it('reads every live stream the guide matching would tie to some channels, and few others', async () => {
    const { store } = await open();
    const live = [
      [1, 'HR| HRT 1 HD', 'HRT1.hr'],
      [2, 'HR| HRT 1 FHD', 'htv1.hd.hr'],
      [3, 'HR| Doma TV', 'Doma.TV.HD.hr'],
      [4, 'HR| RTL Kockica', ''],
      [5, 'HR| Šport Klub 1', 'nothing.known'],
      [6, 'DE| ARD', 'ARD.de'],
      [7, 'HR| HRT 2', 'HRT2.hr'],
      [8, 'Mapped by hand', '']
    ].map(([id, name, epg]) => ({ stream_id: id, name, epg_channel_id: epg }) as unknown as Stream);
    await store.writeStreams('live', '1', live);
    const channels = [
      { id: 'HRT1.hr', name: 'HRT 1', sourceId: 'a' },
      { id: 'Htv1.hr', name: 'HTV 1', sourceId: 'a' },
      { id: 'DomaTv.hr', name: 'Doma', sourceId: 'a' },
      { id: 'kockica.hr', name: 'RTL Kockica', sourceId: 'a' },
      { id: 'sk1.hr', name: 'Šport Klub 1', sourceId: 'a' },
      { id: 'HRT2.hr', name: 'HRT 2', sourceId: 'a' },
      { id: 'ARD.de', name: 'ARD', sourceId: 'a' }
    ];
    const found = ['HRT1.hr', 'Htv1.hr', 'DomaTv.hr', 'kockica.hr', 'sk1.hr'];

    const near = await store.liveStreamsNear({ ...guideCandidates(channels.filter(c => found.includes(c.id))), streamIds: ['8'] });
    const index = indexGuideChannels(channels);
    const tied = live.filter(stream => found.includes(resolveGuideChannel(index, stream.epg_channel_id, stream.name)?.id ?? ''));

    expect(tied.map(stream => String(stream.stream_id))).toEqual(['1', '2', '3', '4', '5']);
    expect(near.map(stream => stream.stream_id).sort()).toEqual(['1', '2', '3', '4', '5', '8']);
  });

  it('reads a whole library as one cell of JSON, each stream as a row read would have it', async () => {
    const { store } = await open();
    const channel = { stream_id: 7, name: 'HR| HRT 1 "HD"', stream_icon: 'http://x/1.png', epg_channel_id: 'HRT1.hr', num: 3, tv_archive: 1, tv_archive_duration: 4 };
    await store.writeStreams('live', '2', [channel as unknown as Stream, { stream_id: 8, name: 'Bare' } as unknown as Stream]);

    expect(await store.allStreams('live')).toEqual([
      { stream_id: '7', name: 'HR| HRT 1 "HD"', icon: 'http://x/1.png', stream_icon: 'http://x/1.png', epg_channel_id: 'HRT1.hr', added: undefined, num: 3, container_extension: undefined, tv_archive: 1, tv_archive_duration: 4, category_id: '2' },
      { stream_id: '8', name: 'Bare', icon: '', stream_icon: '', epg_channel_id: undefined, added: undefined, num: undefined, container_extension: undefined, category_id: '2' }
    ]);
    expect(await store.allStreams('vod')).toEqual([]);
  });

  it('finds a word in any case, and reads a category through its own index', async () => {
    const { store, query } = await open();
    await store.writeStreams('vod', '1', [film(1, 'EN| The MATRIX (1999)'), film(2, 'Heat (1995)')]);

    expect((await store.findStreams('vod', ['matrix'], 10)).map(found => found.stream_id)).toEqual(['1']);
    expect((await store.findStreamsWithAny!('vod', ['heat', 'matrix'], 10)).map(found => found.stream_id)).toEqual(['1', '2']);

    const sent: [string, unknown[]][] = [];
    (store as unknown as { db: { query: typeof query } }).db.query = async (sql, params = []) => (sent.push([sql, params]), query(sql, params));
    await store.readStreams('vod', '1');
    const plan = (await query('EXPLAIN QUERY PLAN ' + sent[0][0], sent[0][1])).values.map(step => String(step['detail'])).join(' | ');

    // Not every film of the type walked in name order, as with a name index.
    expect(plan).toContain('idx_streams_category (provider=? AND type=? AND category_id=?)');
  });
});

describe('CapacitorCatalogueStore name index', () => {
  afterEach(() => delete idleWork.until);

  const store = (ran: unknown[][]) =>
    new CapacitorCatalogueStore(
      {
        execute: async () => ({ changes: { changes: 0 } }),
        query: async (sql: string) => ({
          values: sql.includes('stream_words_filled')
            ? []
            : sql.includes('MAX(rowid)')
              ? [{ last: 2500 }]
              : ['tv_archive', 'tv_archive_duration', 'extra'].map(name => ({ name }))
        }),
        run: async (_sql: string, values: unknown[]) => (ran.push(values), { changes: { changes: 0 } })
      } as never,
      'provider'
    );

  it('indexes a library already held a piece a call, then marks it done', async () => {
    const ran: unknown[][] = [];
    idleWork.until = async () => undefined;
    await store(ran).initialise();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(ran).toEqual([[0, 1000], [1000, 0], [1000, 2000], [2000, 0], [2000, 3000], [3000, 0], [3000, 1]]);
  });

  it('writes a piece only once nobody is using the app', async () => {
    const ran: unknown[][] = [];
    let gone!: () => void;
    idleWork.until = () => new Promise(resolve => (gone = resolve));
    await store(ran).initialise();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ran).toEqual([]);

    gone();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ran).toEqual([[0, 1000], [1000, 0]]);
  });
});
