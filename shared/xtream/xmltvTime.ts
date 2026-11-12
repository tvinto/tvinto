/**
 * Reading the times XMLTV writes.
 *
 * The format is `YYYYMMDDHHMMSS +HHMM`, and almost every part of it is
 * optional in the wild. Feeds drop the seconds, drop the minutes, and drop the
 * offset entirely; the specification says the offset should always be there
 * and real guides disagree.
 *
 * A wrong answer here is not a crash but a guide that is quietly an hour out,
 * which looks like the provider's fault rather than ours -- so the parsing is
 * deliberate about what it will and will not accept.
 */

/**
 * `YYYYMMDDHHMMSS` with everything after the year optional, then an optional
 * offset of `+HHMM`, `-HHMM`, or `Z`.
 */
const XMLTV_TIME =
  /^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(?:(Z)|([+-])(\d{2})(\d{2}))?$/;

/**
 * Parses an XMLTV timestamp to epoch milliseconds, or null if it will not
 * parse.
 *
 * Null rather than a throw, and null rather than a guess: a programme whose
 * time cannot be read should be dropped, not shown at the wrong hour. The
 * caller can count how many it lost, which says something useful about a feed;
 * a silently shifted schedule says nothing at all.
 *
 * **A timestamp with no offset is read as UTC.** There is no better answer --
 * the device's own timezone is not the feed's, and assuming it would be right
 * only by coincidence.
 */
export const parseXmltvTime = (value: string | undefined | null): number | null => {
  if (!value) {
    return null;
  }

  const match = XMLTV_TIME.exec(value.trim());
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second, zulu, sign, offsetHours, offsetMinutes] = match;

  // A year on its own is not a programme time, it is a mistake that would put
  // something at midnight on the first of January.
  if (!month || !day) {
    return null;
  }

  const monthIndex = Number(month) - 1;
  const dayOfMonth = Number(day);

  if (monthIndex < 0 || monthIndex > 11 || dayOfMonth < 1 || dayOfMonth > 31) {
    return null;
  }

  const utc = Date.UTC(
    Number(year),
    monthIndex,
    dayOfMonth,
    Number(hour ?? 0),
    Number(minute ?? 0),
    Number(second ?? 0)
  );

  if (Number.isNaN(utc)) {
    return null;
  }

  // Date.UTC rolls impossible dates forward -- the 32nd of a month becomes the
  // 1st of the next -- which would place a programme on the wrong day rather
  // than admitting the timestamp is wrong.
  const rolled = new Date(utc);
  if (rolled.getUTCMonth() !== monthIndex || rolled.getUTCDate() !== dayOfMonth) {
    return null;
  }

  if (zulu || !sign) {
    return utc;
  }

  const offset = (Number(offsetHours) * 60 + Number(offsetMinutes)) * 60_000;
  return sign === '+' ? utc - offset : utc + offset;
};

/**
 * Whether a programme is on at a given moment.
 *
 * Start inclusive, stop exclusive, so the programme that has just ended and
 * the one just starting are never both "now".
 */
export const isOnAt = (start: number, stop: number, at: number): boolean =>
  at >= start && at < stop;

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

/**
 * Writes epoch milliseconds back out in XMLTV's own form.
 *
 * The inverse of the parsing above, and needed because parts of the app were
 * written against XMLTV strings and read them with their own formatters.
 * Rather than teach every one of those about milliseconds, a guide read from
 * the device can be handed back in the form they already understand.
 *
 * Always UTC, and always with the offset written out. Emitting a timestamp
 * with no offset would be legal and would mean "read this as UTC" only by the
 * convention above -- saying so explicitly costs five characters and removes
 * the question.
 */
export const formatXmltvTime = (epochMs: number): string => {
  const when = new Date(epochMs);

  if (Number.isNaN(when.getTime())) {
    return '';
  }

  return (
    `${pad(when.getUTCFullYear(), 4)}${pad(when.getUTCMonth() + 1, 2)}${pad(when.getUTCDate(), 2)}` +
    `${pad(when.getUTCHours(), 2)}${pad(when.getUTCMinutes(), 2)}${pad(when.getUTCSeconds(), 2)}` +
    ' +0000'
  );
};
