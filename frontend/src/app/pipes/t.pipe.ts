import { Pipe, PipeTransform } from '@angular/core';
import { formatDate } from '@angular/common';
import { currentLanguage, Params, t } from '../utils/i18n';
import { angularLocale } from '../services/language.service';

/**
 * `{{ 'account.title' | t }}`, or with values: `{{ 'time.minLeft' | t: { count: n } }}`.
 *
 * Not pure: the words change when the language does, with nothing else about
 * the binding changing. The lookup is a few property reads, so running it on
 * every check costs nothing a guide row would notice.
 */
@Pipe({ name: 't', standalone: true, pure: false })
export class TPipe implements PipeTransform {
  transform(key: string, params?: Params): string {
    return t(key, params);
  }
}

/** A date in the language in use: `{{ at | tdate: 'd MMM y' }}` -- "26 Sep 2026", "26. ruj 2026.". */
@Pipe({ name: 'tdate', standalone: true, pure: false })
export class TDatePipe implements PipeTransform {
  transform(value: string | number | Date | null | undefined, format: string): string {
    if (value === null || value === undefined || value === '') {
      return '';
    }
    return formatDate(value, format, angularLocale(currentLanguage()));
  }
}
