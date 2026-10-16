/**
 * Date formatting in the user's local time zone. Every function takes an
 * optional IANA time zone so tests do not depend on the machine they run on.
 */

type Parts = Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', string>;

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsOf(date: Date, timeZone: string | undefined): Parts {
  const key = timeZone ?? '';
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(key, formatter);
  }
  const parts = {} as Parts;
  for (const { type, value } of formatter.formatToParts(date)) {
    if (type in { year: 1, month: 1, day: 1, hour: 1, minute: 1, second: 1 }) {
      parts[type as keyof Parts] = value;
    }
  }
  return parts;
}

export function parseDate(value: string | Date): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${String(value)}`);
  return date;
}

/** `2026-10-13`: the calendar date used in folder names. */
export function localDate(value: string | Date, timeZone?: string): string {
  const p = partsOf(parseDate(value), timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** `2026-10-13 12:41`: message headings. */
export function localDateTime(value: string | Date, timeZone?: string): string {
  const p = partsOf(parseDate(value), timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** `2026-10-13-1441`: report file names. */
export function reportTimestamp(value: string | Date, timeZone?: string): string {
  const p = partsOf(parseDate(value), timeZone);
  return `${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}`;
}

/** `2026-10-13T12:41:00+05:00`: frontmatter dates, local time with the offset. */
export function isoWithOffset(value: string | Date, timeZone?: string): string {
  const date = parseDate(value);
  const p = partsOf(date, timeZone);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offsetMinutes = Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${hh}:${mm}`;
}
