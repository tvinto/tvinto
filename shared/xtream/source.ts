import { Category, Stream, StreamType } from '../types';

/**
 * Where a catalogue's categories and streams come from.
 *
 * An Xtream provider answers these one request at a time (`XtreamClient`);
 * an M3U playlist answers them from one download (`M3uSource`). `Catalogue`
 * asks only this, so it keeps and serves either the same way.
 *
 * `getStreams` with no category is the whole library at once -- what search's
 * daily index asks for.
 */
export interface CatalogueSource {
  getCategories(type: StreamType, timeoutMs?: number): Promise<Category[]>;
  getStreams(type: StreamType, categoryId?: string, timeoutMs?: number): Promise<Stream[]>;
}
