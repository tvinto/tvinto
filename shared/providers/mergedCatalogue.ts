import { Category, Stream, StreamType } from '../types';
import { Catalogue } from '../xtream/catalogue';
import { tagged, untagged } from './providerRecord';

/** One provider's catalogue, and the slot its ids are written under. */
export interface CatalogueSlot {
  tag: string;
  catalogue: Catalogue;
}

/**
 * Every provider's catalogue as one.
 *
 * The same questions `Catalogue` answers, over all the account's switched-on
 * providers: each answer is the slots' answers side by side, with the ids of
 * every slot but the first written `tag~id` and each item carrying its
 * `provider` tag, which is what the category list groups by. A question about
 * one category or stream goes to the slot its id names.
 *
 * With one provider this is that provider's catalogue and nothing more: its
 * tag is '', so no id changes.
 */
export interface MergedOptions {
  /**
   * How long the list waits for a provider other than the first. A playlist
   * host that does not answer held every category list up for the whole of
   * the platform's connect timeout; past this the list goes on without it.
   */
  waitMs?: number;
  /** Called when a provider that was not waited for has answered after all. */
  onLate?: () => void;
}

export class MergedCatalogue {
  constructor(
    readonly slots: CatalogueSlot[],
    private readonly options: MergedOptions = {}
  ) {}

  async categories(type: StreamType): Promise<Category[]> {
    const lists = await Promise.all(
      this.slots.map(async slot =>
        (await this.orNothing(this.inTime(slot, slot.catalogue.categories(type)), slot)).map(category =>
          tagCategory(slot.tag, category)
        )
      )
    );
    return lists.flat();
  }

  /**
   * The first provider's answer, always; another's if it comes within
   * `waitMs`, and otherwise nothing now and a call to `onLate` when it does
   * come -- by which time the catalogue has kept it, so asking again finds it.
   */
  private inTime<T>(slot: CatalogueSlot, asked: Promise<T[]>): Promise<T[]> {
    const waitMs = this.options.waitMs;
    if (!slot.tag || waitMs === undefined || this.slots.length === 1) {
      return asked;
    }
    let late = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeUp = new Promise<T[]>(resolve => {
      timer = setTimeout(() => {
        late = true;
        resolve([]);
      }, waitMs);
    });
    asked.then(
      answer => {
        clearTimeout(timer);
        if (late && answer.length > 0) {
          this.options.onLate?.();
        }
      },
      () => clearTimeout(timer)
    );
    return Promise.race([asked, timeUp]);
  }

  async streams(type: StreamType, categoryId: string): Promise<Stream[]> {
    const { slot, id } = this.slotFor(categoryId);
    if (!slot) {
      return [];
    }
    return (await slot.catalogue.streams(type, id)).map(stream => tagStream(slot.tag, stream));
  }

  /** A category as this device holds it, never asked of the provider (`Catalogue.held`). */
  async held(type: StreamType, categoryId: string): Promise<Stream[]> {
    const { slot, id } = this.slotFor(categoryId);
    if (!slot) {
      return [];
    }
    return (await slot.catalogue.held(type, id)).map(stream => tagStream(slot.tag, stream));
  }

  async search(type: StreamType, query: string, limit = 100): Promise<Stream[]> {
    const lists = await Promise.all(
      this.slots.map(async slot =>
        (await this.orNothing(slot.catalogue.search(type, query, limit), slot)).map(stream =>
          tagStream(slot.tag, stream)
        )
      )
    );
    return lists.flat();
  }

  async findTitles(type: StreamType, titles: string[], signal?: AbortSignal): Promise<Map<string, Stream[]>> {
    const found = new Map<string, Stream[]>(titles.map(title => [title, []]));
    const each = await Promise.all(
      this.slots.map(async slot => ({
        slot,
        // As orNothing does for lists: one provider that cannot be read leaves the others.
        held: await slot.catalogue.findTitles(type, titles, signal).catch(error => {
          if (this.slots.length === 1) {
            throw error;
          }
          return new Map<string, Stream[]>();
        })
      }))
    );
    for (const { slot, held } of each) {
      for (const [title, streams] of held) {
        found.get(title)?.push(...streams.map(stream => tagStream(slot.tag, stream)));
      }
    }
    return found;
  }

  async recentlyAdded(type: StreamType, limit = 24): Promise<Stream[]> {
    const lists = await Promise.all(
      this.slots.map(async slot =>
        (await this.orNothing(slot.catalogue.recentlyAdded(type, limit), slot)).map(stream =>
          tagStream(slot.tag, stream)
        )
      )
    );
    return lists
      .flat()
      .sort((a, b) => Number(b.added ?? 0) - Number(a.added ?? 0))
      .slice(0, limit);
  }

  /** Fresh only when every slot's index is. */
  async indexIsFresh(type: StreamType): Promise<boolean> {
    const fresh = await Promise.all(this.slots.map(slot => slot.catalogue.indexIsFresh(type)));
    return fresh.every(Boolean);
  }

  /** The oldest slot's index time, or null while any slot has none. */
  async indexedAt(type: StreamType): Promise<string | null> {
    const times = await Promise.all(this.slots.map(slot => slot.catalogue.indexedAt(type)));
    if (times.some(time => !time)) {
      return null;
    }
    return (times as string[]).reduce((oldest, time) => (Date.parse(time) < Date.parse(oldest) ? time : oldest), times[0] as string) ?? null;
  }

  /** Every slot indexed, one after another: they may well share a line. */
  async index(type: StreamType): Promise<number> {
    let count = 0;
    for (const slot of this.slots) {
      count += await slot.catalogue.index(type);
    }
    return count;
  }

  /** The slot an id names, and the provider's own id within it. */
  slotFor(id: string | number): { slot: CatalogueSlot | undefined; id: string } {
    const parts = untagged(id);
    return { slot: this.slots.find(slot => slot.tag === parts.tag), id: parts.id };
  }

  /**
   * One slot failing -- a playlist host down, an expired login -- must not
   * take every other provider's categories with it. The first slot's failure
   * still surfaces when it is the only one, as it always has.
   */
  private orNothing<T>(asked: Promise<T[]>, slot: CatalogueSlot): Promise<T[]> {
    if (this.slots.length === 1) {
      return asked;
    }
    return asked.catch(error => {
      console.warn(`A provider could not be read (${slot.tag || 'first'})`, error instanceof Error ? error.name : '');
      return [];
    });
  }
}

export function tagCategory(tag: string, category: Category): Category {
  return {
    ...category,
    category_id: tagged(tag, category.category_id),
    provider: tag
  };
}

export function tagStream(tag: string, stream: Stream): Stream {
  if (!tag) {
    return { ...stream, provider: '' };
  }
  const categoryId = stream.category_id;
  return {
    ...stream,
    stream_id: tagged(tag, stream.stream_id),
    ...(categoryId !== undefined && categoryId !== null && categoryId !== ''
      ? { category_id: tagged(tag, categoryId) }
      : {}),
    provider: tag
  };
}
