/**
 * Subtitles turned off by hiding them, not by unselecting the track.
 *
 * mpv keeps packets of the selected tracks only. A subtitle track selected
 * while the film plays has none, so mpv reads the film again from just before
 * where it is ("refresh seek"), and over HTTP that is another request to the
 * provider -- the first time two, with the Matroska cues at the end of the
 * file (measured 22 November, tools/qa/fake-xtream.js's /qa/requests). They
 * come one after another, never two connections at once, but each is a fresh
 * request on a subscription that allows one connection, and the cache is
 * downloaded again behind it.
 *
 * A track that stays selected while hidden costs nothing: subtitles are a few
 * kilobytes, and measured, a hidden track changed neither the requests at the
 * start, nor at a resume, nor at a seek. So:
 *
 * - Off in the panel hides the track (`sub-visibility`), and On again with
 *   the same track shows it, with no request. Another track still takes one:
 *   mpv selects at most two at once (`sid`, `secondary-sid`), so there is no
 *   keeping them all.
 * - In the app's own player, a film started with subtitles off still selects
 *   the remembered (or the account's) language, hidden, so turning subtitles
 *   on in that language costs nothing either. Not in mpv's own window: there
 *   its on-screen controller and `j` are the interface, and they would cycle
 *   tracks nobody can see.
 *
 * Whether subtitles are on is `sub-visibility` and a selected track together,
 * as it already was (`PositionWatcher.settleSubtitles`).
 */

export interface SubtitleStart {
  enabled: boolean;
  language: string;
  /** Subtitles added for this film, which the player selects once it is open. */
  added: boolean;
  /** The app's own player, whose panel is the only way to change subtitles. */
  inApp: boolean;
}

/** mpv's command-line options for the subtitles a film starts with. */
export function subtitleArguments(start: SubtitleStart): string[] {
  if (start.enabled) {
    return start.language ? [`--slang=${start.language}`] : [];
  }
  if (start.added) {
    return [];
  }
  if (start.inApp && start.language) {
    return ['--sub-visibility=no', `--slang=${start.language}`];
  }
  return ['--sid=no'];
}

/** What the panel's choice of subtitle (null for Off) sends to mpv. */
export function subtitleCommands(id: number | null): unknown[][] {
  if (id === null) {
    return [['set_property', 'sub-visibility', false]];
  }
  // The same track as the one hidden selects nothing new, so mpv asks nothing.
  return [
    ['set_property', 'sid', id],
    ['set_property', 'sub-visibility', true]
  ];
}
