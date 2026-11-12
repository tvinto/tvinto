import { Injectable, inject } from '@angular/core';
import { Category, Stream, StreamType } from '@shared/types';
import { LibraryListing, idMoves, movedScope } from '@shared/providers/carryOver';
import { tagged, untagged } from '@shared/providers/providerRecord';
import { ProviderAccessService } from './provider-access.service';
import { XtreamService } from './xtream.service';
import { LocalUserDataService } from './local-user-data.service';
import { GuideSourcesService } from './guide-sources.service';
import { ParentalLockService } from './parental-lock.service';

const TYPES: StreamType[] = ['live', 'vod', 'series'];

/** What the account referred to under one provider, with names, before it was replaced. */
export interface CarrySnapshot {
  tag: string;
  libraries: Record<StreamType, LibraryListing>;
}

/**
 * Carries an account over to the provider that replaced another.
 *
 * A user's case (29 September): a subscription runs out and a new one
 * takes its place, and the guides, favourites and history built on the old
 * one should carry on. `snapshot` is taken before the replacement -- what the
 * account holds under the provider's slot, named from the old catalogue --
 * and `carryOver` after it: the new provider's lists are read, and every id
 * that changed is moved to the category or channel of the same name (see
 * shared/providers/carryOver.ts for when a name is taken as the same).
 *
 * When the new provider numbers things the same way, nothing moves.
 */
@Injectable({ providedIn: 'root' })
export class CarryOverService {
  private readonly access = inject(ProviderAccessService);
  private readonly xtream = inject(XtreamService);
  private readonly local = inject(LocalUserDataService);
  private readonly guides = inject(GuideSourcesService);
  private readonly lock = inject(ParentalLockService);

  async snapshot(tag: string): Promise<CarrySnapshot | null> {
    const direct = await this.access.direct();
    const slot = direct?.slots.find(candidate => candidate.tag === tag);
    if (!slot || !this.local.enabled) {
      return null;
    }
    const own = (id: string | number) => untagged(id).tag === tag;
    const raw = (id: string | number) => untagged(id).id;

    const libraries = {} as Record<StreamType, LibraryListing>;
    for (const type of TYPES) {
      const categories: Category[] = await slot.catalogue.categories(type).catch(() => []);
      const held = await slot.catalogue.allStreams(type).catch(() => [] as Stream[]);
      const heldById = new Map(held.map(stream => [String(stream.stream_id), stream]));

      const referenced = new Map<string, Stream>();
      const note = (id: string, name: string | null | undefined) => {
        const known = heldById.get(id);
        if (!referenced.has(id) && (known?.name || name)) {
          referenced.set(id, { ...(known ?? {}), stream_id: id, name: known?.name || name || '' } as Stream);
        }
      };
      for (const favourite of this.local.favourites(type)) {
        if (own(favourite.stream_id)) {
          note(raw(favourite.stream_id), favourite.name);
        }
      }
      if (type !== 'series') {
        for (const entry of this.local.recent(type, 100_000)) {
          if (own(entry.itemId)) {
            note(raw(entry.itemId), entry.name);
          }
        }
      }
      if (type === 'live') {
        for (const streamId of Object.keys(this.guides.mappings())) {
          if (own(streamId)) {
            note(raw(streamId), null);
          }
        }
      }

      libraries[type] = { categories, streams: [...referenced.values()] };
    }
    return { tag, libraries };
  }

  /** How many things were moved to the new provider's ids. */
  async carryOver(snapshot: CarrySnapshot): Promise<number> {
    const direct = await this.access.direct();
    const slot = direct?.slots.find(candidate => candidate.tag === snapshot.tag);
    if (!slot) {
      return 0;
    }
    const tag = snapshot.tag;
    const categoryMoves = new Map<string, string>();
    const streamMoves = new Map<string, string>();
    let moved = 0;

    for (const type of TYPES) {
      const before = snapshot.libraries[type];
      if (!before.categories.length && !before.streams.length) {
        continue;
      }
      const categories: Category[] = await slot.catalogue.categories(type).catch(() => []);
      // Every old category still there under its id and name: the same panel,
      // numbering things the same way -- a renewed password, not a new
      // provider -- and nothing to move. Asking for the whole library to
      // find that out would be a download for nothing.
      const newById = new Map(categories.map(category => [String(category.category_id), category.category_name]));
      // An Xtream panel only: a playlist's category ids are made from its
      // group names, so theirs agreeing says nothing about its channels' --
      // and reading a playlist again costs no provider anything.
      const sameNumbering =
        !!slot.xtream &&
        before.categories.length > 0 &&
        before.categories.every(category => newById.get(String(category.category_id)) === category.category_name);
      if (sameNumbering) {
        continue;
      }
      let streams: Stream[] = [];
      if (before.streams.length) {
        // The whole library, once: the new provider's names for everything
        // the account refers to. One request, as a first search makes.
        await this.xtream.indexProvider(tag, type).catch(() => null);
        streams = await slot.catalogue.allStreams(type);
      }

      const moves = idMoves(before, { categories, streams });
      const names = new Map(streams.map(stream => [String(stream.stream_id), stream.name]));

      const typeCategories = new Map<string, string>();
      for (const [from, to] of moves.categories) {
        typeCategories.set(tagged(tag, from), tagged(tag, to));
        categoryMoves.set(tagged(tag, from), tagged(tag, to));
      }
      const items = new Map<string, { id: string; name: string }>();
      for (const [from, to] of moves.streams) {
        items.set(tagged(tag, from), { id: tagged(tag, to), name: names.get(to) ?? '' });
        streamMoves.set(tagged(tag, from), tagged(tag, to));
      }

      moved += this.local.moveItems(type, items);
      moved += this.lock.moveCategories(type, typeCategories);

      if (type === 'live') {
        for (const [from, to] of items) {
          const mapping = this.guides.mappingFor(from);
          if (mapping) {
            this.guides.map(to.id, mapping.channelId, mapping.sourceId);
            this.guides.unmap(from);
            moved++;
          }
        }
      }
    }

    moved += this.local.moveArrangements(
      scope => movedScope(scope, categoryMoves),
      id => categoryMoves.get(id) ?? streamMoves.get(id)
    );
    return moved;
  }
}
