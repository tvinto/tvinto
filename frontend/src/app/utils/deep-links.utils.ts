/**
 * tvinto:// links, which open the app on something from outside it: a
 * reminder's notification or its banner in the player, and the television's
 * home-screen rows.
 *
 *   tvinto://watch?stream=<id>&name=<channel>[&kind=reminder|home]
 *   tvinto://movie?play=<id>&name=<title>
 *   tvinto://series/<id>?name=<title>
 *
 * Each becomes the route the app already plays from on arrival (`playOnArrival`
 * in the section component; a show's own page), so nothing about playing is
 * done twice.
 */

export interface LinkTarget {
  path: string[];
  queryParams: Record<string, string>;
}

const KINDS = new Set(['reminder', 'home']);

/** The route for a link, or null for one that is not the app's or not understood. */
export function routeForLink(link: string): LinkTarget | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== 'tvinto:') {
    return null;
  }
  // `tvinto://watch?..` puts "watch" in the host; `tvinto:watch?..` in the path.
  const parts = [url.host, ...url.pathname.split('/')].filter(Boolean);
  const name = url.searchParams.get('name') ?? '';

  switch (parts[0]) {
    case 'watch': {
      const stream = url.searchParams.get('stream');
      if (!stream) {
        return null;
      }
      const asked = url.searchParams.get('kind') ?? '';
      return {
        path: ['/tv'],
        queryParams: { play: stream, kind: KINDS.has(asked) ? asked : 'home', name, icon: '' }
      };
    }
    case 'movie': {
      const play = url.searchParams.get('play');
      return play ? { path: ['/movies'], queryParams: { play, kind: 'recent', name, icon: '' } } : null;
    }
    case 'series': {
      const id = parts[1];
      return id ? { path: ['/series', id], queryParams: { name } } : null;
    }
    default:
      return null;
  }
}

/**
 * `tvinto://start`: the television was turned on and opened the app, which
 * then shows For You or plays the last channel, as Account says
 * (android device/StartUp.java, DeepLinksService).
 */
export function isStartLink(link: string): boolean {
  return /^tvinto:(\/\/)?start\/?(\?.*)?$/i.test(link.trim());
}
