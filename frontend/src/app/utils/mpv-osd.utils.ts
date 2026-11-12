/**
 * What mpv's on-screen display says while a live channel plays on the desktop
 * (design board PL-D-1).
 *
 * mpv sits over the page and cannot draw the app's panels, so the banner and
 * the switching panel become four lines of text in one monospaced face. The
 * lines are written here, in tested TypeScript, and the main process only
 * shows them -- the same division as on Android, where the web app decides and
 * the player draws.
 *
 * Switching and failures use the same four-line slot as the banner, so the
 * eye never moves.
 */

import { ChannelBanner } from './player-banner.utils';
import { clockTime, minutesLeft, percentThrough } from './channel-display.utils';
import { t } from './i18n';

export interface OsdChannel {
  number: string;
  name: string;
}

/** How many cells the progress meter has. */
const METER_CELLS = 22;

const heading = (channel: OsdChannel, tags = ''): string =>
  [channel.number, channel.name, tags].filter(Boolean).join('  ');

/** "[##########------------]  49%" */
export const osdMeter = (percent: number): string => {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * METER_CELLS);
  return `[${'#'.repeat(filled)}${'-'.repeat(METER_CELLS - filled)}]  ${Math.round(percent)}%`;
};

/** The banner: shown on arrival and on `i`. */
export const osdBanner = (channel: OsdChannel, banner: ChannelBanner | null, now: number): string => {
  const lines = [heading(channel, banner?.tags ?? '')];

  if (!banner) {
    return lines.join('\n');
  }
  if (!banner.hasGuide) {
    lines.push(t('osd.noGuide'));
    return lines.join('\n');
  }

  const on = banner.now && banner.now.stopMs > now ? banner.now : null;
  if (on) {
    const left = minutesLeft(on.stopMs, now);
    lines.push(
      [on.title, `${clockTime(on.startMs)}-${clockTime(on.stopMs)}`, left].filter(Boolean).join('   ')
    );
    lines.push(osdMeter(percentThrough(on.startMs, on.stopMs, now)));
  }
  if (banner.next) {
    lines.push(t('osd.next', { time: clockTime(banner.next.startMs), title: banner.next.title }));
  }
  return lines.join('\n');
};

/** PL-TV-2 and PL-TV-2b, in text: where it is going, and why the wait. */
export const osdSwitching = (channel: OsdChannel, from: string, attempt: 1 | 2): string =>
  attempt === 1
    ? [t('osd.changingTo', { channel: heading(channel) }), from ? t('osd.from', { channel: from }) : '', t('osd.closingFirst')]
        .filter(Boolean)
        .join('\n')
    : [
        t('osd.tryingAgain', { channel: heading(channel) }),
        t('osd.turnedAway'),
        from ? t('osd.backspaceReturns', { channel: from }) : ''
      ]
        .filter(Boolean)
        .join('\n');

/** After the second refusal. */
export const osdGaveUp = (channel: OsdChannel, backTo: string): string =>
  [t('osd.couldNotStart', { channel: heading(channel) }), backTo ? t('osd.backspaceReturns', { channel: backTo }) : t('osd.escCloses')]
    .join('\n');
