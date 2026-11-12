import { Stream } from '@shared/types';
import { CapacitorCatalogueStore } from './capacitorCatalogueStore';

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
