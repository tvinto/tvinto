import { StreamType } from '@shared/types';

/**
 * The app's own destinations, in the order they are always offered.
 *
 * Here rather than in the shell because there are now two things that draw
 * them: the bar along the top, and the navigation panel the drawer pushes open
 * on a television (TV-N-1c). Two copies of a list like this drift -- a section
 * added to one and not the other is a page that exists and cannot be reached
 * from half the app -- and the order is part of the design rather than an
 * accident of either template.
 */
export interface Section {
  path: string;
  /** A key for the words, in the language in use. */
  label: string;
  icon: string;
  type: StreamType;
  /** The dot beside the section you are in, in that library's colour. */
  dot: string;
}

export const SECTIONS: Section[] = [
  { path: '/for-you', label: 'nav.forYou', icon: 'lucideTv', type: 'live', dot: 'bg-primary-bright' },
  { path: '/tv', label: 'nav.liveTv', icon: 'lucideTv', type: 'live', dot: 'bg-live' },
  { path: '/movies', label: 'nav.movies', icon: 'lucideClapperboard', type: 'vod', dot: 'bg-vod' },
  { path: '/shows', label: 'nav.shows', icon: 'lucideVideo', type: 'series', dot: 'bg-series' }
];

/**
 * The quieter half of the navigation panel, below the libraries.
 *
 * Search is not here: SR-TV-1 puts it above the line, with the libraries, as
 * a place to go rather than a setting, and the shell draws it there.
 */
export const DESTINATIONS: { path: string; label: string }[] = [
  { path: '/guides', label: 'nav.guides' },
  { path: '/account', label: 'nav.account' }
];
