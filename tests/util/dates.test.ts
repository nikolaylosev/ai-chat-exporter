import { describe, expect, it } from 'vitest';
import {
  isoWithOffset,
  localDate,
  localDateTime,
  parseDate,
  reportTimestamp,
} from '../../src/util/dates';

// 2026-10-13 21:30 UTC is already the 14th in Yekaterinburg (UTC+5) and still the 13th in New York.
const LATE_UTC = '2026-10-13T21:30:15Z';

describe('localDate', () => {
  it.each([
    ['UTC', '2026-10-13'],
    ['Asia/Yekaterinburg', '2026-10-14'],
    ['America/New_York', '2026-10-13'],
    ['Pacific/Kiritimati', '2026-10-14'],
  ])('in %s', (zone, expected) => {
    expect(localDate(LATE_UTC, zone)).toBe(expected);
  });

  it('accepts Date objects', () => {
    expect(localDate(new Date(LATE_UTC), 'UTC')).toBe('2026-10-13');
  });
});

describe('localDateTime', () => {
  it('formats with 24-hour time', () => {
    expect(localDateTime(LATE_UTC, 'Asia/Yekaterinburg')).toBe('2026-10-14 02:30');
    expect(localDateTime('2026-10-13T00:05:00Z', 'UTC')).toBe('2026-10-13 00:05');
  });
});

describe('reportTimestamp', () => {
  it('has no separators inside the time', () => {
    expect(reportTimestamp(LATE_UTC, 'UTC')).toBe('2026-10-13-2130');
  });
});

describe('isoWithOffset', () => {
  it.each([
    ['UTC', '2026-10-13T21:30:15+00:00'],
    ['Asia/Yekaterinburg', '2026-10-14T02:30:15+05:00'],
    ['America/New_York', '2026-10-13T17:30:15-04:00'],
    ['Asia/Kolkata', '2026-10-14T03:00:15+05:30'],
  ])('in %s', (zone, expected) => {
    expect(isoWithOffset(LATE_UTC, zone)).toBe(expected);
  });

  it('round-trips to the same instant', () => {
    const iso = isoWithOffset(LATE_UTC, 'Asia/Kathmandu');
    expect(new Date(iso).toISOString()).toBe('2026-10-13T21:30:15.000Z');
  });

  it('ignores milliseconds', () => {
    expect(isoWithOffset('2026-10-13T21:30:15.999Z', 'UTC')).toBe('2026-10-13T21:30:15+00:00');
  });
});

describe('parseDate', () => {
  it('rejects invalid input', () => {
    expect(() => parseDate('not a date')).toThrow(/Invalid date/);
  });
});
