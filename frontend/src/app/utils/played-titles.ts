/**
 * The names of what was played this run -- films, episodes, shows, channels --
 * which an error report must not carry (ErrorReportsService takes them out).
 * A plain module, not a service: the players note what they start without
 * depending on anything about reports.
 */
const KEPT = 30;
const titles: string[] = [];

export function rememberPlayedTitle(...names: (string | null | undefined)[]): void {
  for (const name of names) {
    if (typeof name === 'string' && name.trim() && !titles.includes(name)) {
      titles.push(name);
    }
  }
  titles.splice(0, Math.max(0, titles.length - KEPT));
}

export const playedTitles = (): readonly string[] => titles;
