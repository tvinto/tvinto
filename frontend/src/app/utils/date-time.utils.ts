/**
 * Date and Time Utility Functions
 */

/** `YYYYMMDDHHMMSS` with optional seconds and optional ` +HHMM` / ` -HH:MM` offset. */
const XMLTV_DATE_PATTERN =
  /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\s*([+-])(\d{2}):?(\d{2}))?/;

/**
 * Parse an XMLTV date such as `20260807222300 +0000` into a Date.
 *
 * The trailing offset is part of the timestamp: ignoring it shifts every
 * programme by the viewer's own UTC offset, which breaks "now playing"
 * detection everywhere except UTC. Per the XMLTV DTD an absent offset means
 * the timestamp is already local time.
 *
 * @param dateStr XMLTV formatted date string
 * @returns Date object, or an Invalid Date if the string cannot be parsed
 */
export function parseXMLTVDate(dateStr: string): Date {
  const match = XMLTV_DATE_PATTERN.exec((dateStr ?? '').trim());
  if (!match) {
    return new Date(NaN);
  }

  const [, year, month, day, hour, minute, second, sign, offsetHours, offsetMinutes] = match;

  const parts = [
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? 0)
  ] as const;

  if (!sign) {
    return new Date(...parts);
  }

  const offsetInMinutes =
    (Number(offsetHours) * 60 + Number(offsetMinutes)) * (sign === '-' ? -1 : 1);

  return new Date(Date.UTC(...parts) - offsetInMinutes * 60_000);
}

/**
 * Format XMLTV date string to time string (HH:mm)
 * @param dateStr XMLTV formatted date string
 * @returns Formatted time string
 */
export function formatXMLTVTime(dateStr: string | undefined): string {
  if (!dateStr) return '';
  const date = parseXMLTVDate(dateStr);
  return date.toLocaleTimeString('en-US', { 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: false
  });
}

/**
 * Format XMLTV date string to date string (MMM DD, YYYY)
 * @param dateStr XMLTV formatted date string
 * @returns Formatted date string
 */
export function formatXMLTVDate(dateStr: string | undefined): string {
  if (!dateStr) return '';
  const date = parseXMLTVDate(dateStr);
  return date.toLocaleDateString('en-US', { 
    month: 'short', 
    day: 'numeric',
    year: 'numeric'
  });
}

/**
 * Format Unix timestamp to time string (HH:mm)
 * @param timestamp Unix timestamp (seconds or milliseconds)
 * @returns Formatted time string
 */
export function formatUnixTime(timestamp: number | string | undefined): string {
  if (!timestamp) return '';
  const date = new Date(parseInt(timestamp.toString()) * 1000);
  return date.toLocaleTimeString('en-US', { 
    hour: '2-digit', 
    minute: '2-digit',
    hour12: false
  });
}

/**
 * Format Unix timestamp to date string (MMM DD, YYYY)
 * @param timestamp Unix timestamp (seconds or milliseconds)
 * @returns Formatted date string
 */
export function formatUnixDate(timestamp: number | string | undefined): string {
  if (!timestamp) return '';
  const date = new Date(parseInt(timestamp.toString()) * 1000);
  return date.toLocaleDateString('en-US', { 
    month: 'short', 
    day: 'numeric',
    year: 'numeric'
  });
}

/**
 * Calculate progress percentage for a time-based program
 * @param startTime Start time (Date or timestamp)
 * @param endTime End time (Date or timestamp)
 * @param currentTime Current time (defaults to now)
 * @returns Progress percentage (0-100)
 */
export function calculateTimeProgress(
  startTime: Date | number,
  endTime: Date | number,
  currentTime: Date | number = new Date()
): number {
  const start = startTime instanceof Date ? startTime.getTime() : startTime;
  const end = endTime instanceof Date ? endTime.getTime() : endTime;
  const current = currentTime instanceof Date ? currentTime.getTime() : currentTime;
  
  const duration = end - start;
  const elapsed = current - start;
  
  return Math.min(100, Math.max(0, (elapsed / duration) * 100));
}

/**
 * Calculate progress for XMLTV programme
 * @param startDateStr XMLTV start date string
 * @param stopDateStr XMLTV stop date string
 * @returns Progress percentage (0-100)
 */
export function calculateXMLTVProgress(startDateStr: string, stopDateStr: string): number {
  const start = parseXMLTVDate(startDateStr);
  const stop = parseXMLTVDate(stopDateStr);
  return calculateTimeProgress(start, stop);
}

/**
 * Calculate progress for Unix timestamp programme
 * @param startTimestamp Unix start timestamp (seconds)
 * @param stopTimestamp Unix stop timestamp (seconds)
 * @returns Progress percentage (0-100)
 */
export function calculateUnixProgress(startTimestamp: number, stopTimestamp: number): number {
  const now = Date.now() / 1000;
  const duration = stopTimestamp - startTimestamp;
  const elapsed = now - startTimestamp;
  return Math.min(100, Math.max(0, (elapsed / duration) * 100));
}
