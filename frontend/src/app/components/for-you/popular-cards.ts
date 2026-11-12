import { Router } from '@angular/router';
import { firstValueFrom, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { Category } from '@shared/types';
import { tmdbPoster } from '@shared/tmdb/client';
import { orderCopies } from '@shared/tmdb/copies';
import { Popular } from '../../services/popular.service';
import { XtreamService } from '../../services/xtream.service';
import { ItemAction } from '../item-actions/item-actions.component';
import { channelDisplay, posterTitle } from '../../utils';
import { namePrefix } from '../../utils/series-display.utils';
import { t } from '../../utils/i18n';
import { preferredLanguages } from '../../utils/languages';

/**
 * A "Popular this week" card -- on For You's row and on the full lists
 * (FY-TV-2, TV-26): the trending title, its poster, and each copy with the
 * category it is in.
 */
export interface PopularCard extends Popular {
  poster: string;
  /** "Film" or "Show", in the kind's colour: how a film and a show are told apart (FY-TV-2). */
  kindWord: string;
  year: string;
  categories: string[];
}

/** The person's languages, first preferred: chosen on Account, else the app's, then English. */
export { preferredLanguages };

/** Category names by id, films' and shows' apart, for saying where each copy is. */
export type CategoryNames = Record<'vod' | 'series', Map<string, string>>;

export async function categoryNames(xtream: XtreamService): Promise<CategoryNames> {
  const names = async (type: 'vod' | 'series') => {
    const categories = await firstValueFrom(xtream.getCategories(type).pipe(catchError(() => of([] as Category[]))));
    return new Map(categories.map(category => [category.category_id, channelDisplay(category.category_name).title]));
  };
  const [vod, series] = await Promise.all([names('vod'), names('series')]);
  return { vod, series };
}

/** A card, its copies in the order Play tries them (TV-28): your languages, the best picture, cinema recordings last. */
export function popularCard(entry: Popular, names: CategoryNames): PopularCard {
  const copies = orderCopies(
    entry.versions.map(stream => ({ stream, category: names[entry.type].get(String(stream.category_id)) ?? '' })),
    preferredLanguages(),
    copy => ({ name: copy.stream.name, category: copy.category })
  );
  return {
    ...entry,
    versions: copies.map(copy => copy.stream),
    poster: tmdbPoster(entry.item.poster) || entry.versions[0]?.stream_icon || '',
    kindWord: t(entry.type === 'series' ? 'fy.showKind' : 'fy.film'),
    year: entry.item.year,
    categories: copies.map(copy => copy.category)
  };
}

/**
 * The panel's rows, one per copy: what tells it apart -- the provider's tag,
 * the quality in its name -- and the category it is filed in.
 */
export function versionActions(card: PopularCard): ItemAction[] {
  return card.versions.map((stream, index) => {
    const named = posterTitle(stream.name);
    const prefix = namePrefix(stream.name);
    return {
      id: `version:${index}`,
      icon: card.type === 'series' ? 'lucideTv' : 'lucidePlay',
      label: [prefix, [named.title, named.tags].filter(Boolean).join(' ')].filter(Boolean).join(' · '),
      hint: [card.categories[index], named.year].filter(Boolean).join(' · ')
    };
  });
}

/** A film's own page (TV-27), with the list entry handed over to fall back on. */
export function openFilm(router: Router, card: PopularCard): void {
  const { title, originalTitle, year, poster } = card.item;
  void router.navigate(['/film', String(card.item.id)], { state: { film: { title, originalTitle, year, poster } } });
}

/** A show from a TMDB list opens its page in the copy chosen for it, else the first in the person's languages. */
export function openShow(router: Router, card: PopularCard, chosen: string | null): void {
  const index = Math.max(0, card.versions.findIndex(stream => String(stream.stream_id) === chosen));
  openVersion(router, card, index);
}

/** A copy opens where it lives: a show on its own page, a film in Movies, playing. */
export function openVersion(router: Router, card: PopularCard, index: number): void {
  const stream = card.versions[index];
  if (!stream) {
    return;
  }
  if (card.type === 'series') {
    void router.navigate(['/series', stream.stream_id], { queryParams: { name: stream.name } });
    return;
  }
  void router.navigate(['/movies'], {
    queryParams: { play: String(stream.stream_id), kind: 'stream', name: stream.name, icon: stream.stream_icon ?? '', return: 1 }
  });
}
