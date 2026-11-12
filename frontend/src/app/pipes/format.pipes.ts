import { Pipe, PipeTransform } from '@angular/core';
import { LANGUAGE_NAMES } from '../utils/language-names';
import { channelDisplay, channelMonogram } from '../utils/channel-display.utils';
import { posterTitle } from '../utils/series-display.utils';

/**
 * Formatting that depends on nothing but its input, as pure pipes.
 *
 * These were methods a template called, and a template calls its methods at
 * every check. A pure pipe runs again only when what it is given changes.
 */

/** "Croatian" for "hr"; the code itself, in capitals, for one without a name here. */
@Pipe({ name: 'languageName', standalone: true })
export class LanguageNamePipe implements PipeTransform {
  transform(code: string): string {
    return LANGUAGE_NAMES[code] ?? code.toUpperCase();
  }
}

/** A subtitle's timing: "+1.5 s", or "0.0 s" when it has not been moved. */
@Pipe({ name: 'subtitleOffset', standalone: true })
export class SubtitleOffsetPipe implements PipeTransform {
  transform(offsetMs: number): string {
    const seconds = offsetMs / 1000;
    return `${seconds > 0 ? '+' : ''}${seconds.toFixed(1)} s`;
  }
}

/** A channel's name without the provider's tags (D-9): "HRT 1" for "HR| HRT 1 FHD". */
@Pipe({ name: 'channelTitle', standalone: true })
export class ChannelTitlePipe implements PipeTransform {
  transform(name: string | null | undefined): string {
    return channelDisplay(name).title;
  }
}

/** The tags taken off a channel's name, for the small print beside it. */
@Pipe({ name: 'channelTags', standalone: true })
export class ChannelTagsPipe implements PipeTransform {
  transform(name: string | null | undefined): string {
    return channelDisplay(name).tags;
  }
}

/** The letters a channel with no logo is drawn with. */
@Pipe({ name: 'channelMonogram', standalone: true })
export class ChannelMonogramPipe implements PipeTransform {
  transform(name: string | null | undefined): string {
    return channelMonogram(channelDisplay(name).title);
  }
}

/** A film's or show's name as a poster says it: tags and year taken off. */
@Pipe({ name: 'posterTitle', standalone: true })
export class PosterTitlePipe implements PipeTransform {
  transform(name: string | null | undefined): string {
    return posterTitle(name ?? '').title;
  }
}

/** The year a film or show's name gives, or '': what tells two of one name apart. */
@Pipe({ name: 'posterYear', standalone: true })
export class PosterYearPipe implements PipeTransform {
  transform(name: string | null | undefined): string {
    return posterTitle(name ?? '').year;
  }
}
