import { describe, expect, test } from 'vitest';
import { matchesCron } from '@/lib/cron';

// Dates are constructed TZ-naive (no trailing Z) so getMinutes()/getHours()
// line up with the written wall-clock time on any machine — cron schedules
// fire on local time (launchd runs local).
const at = (s: string) => new Date(s);

describe('matchesCron', () => {
  describe('*/5 * * * * (every 5 minutes)', () => {
    test.each([
      ['2026-08-13T10:00:00', true], // step boundary at :00
      ['2026-08-13T10:05:00', true],
      ['2026-08-13T10:55:00', true], // last matching minute of the hour
      ['2026-08-13T10:05:37', true], // seconds are ignored — minute granularity
      ['2026-08-13T10:03:00', false], // non-matching minute
      ['2026-08-13T10:59:00', false],
    ])('%s -> %s', (when, expected) => {
      expect(matchesCron('*/5 * * * *', at(when))).toBe(expected);
    });
  });

  describe('0 2 * * * (daily at 02:00)', () => {
    test.each([
      ['2026-08-13T02:00:00', true],
      ['2026-08-13T02:00:59', true], // any second within the matching minute
      ['2026-08-13T02:01:00', false], // one minute past
      ['2026-08-13T01:59:00', false], // one minute before
      ['2026-08-13T03:00:00', false], // right minute, wrong hour
      ['2026-08-13T14:00:00', false],
    ])('%s -> %s', (when, expected) => {
      expect(matchesCron('0 2 * * *', at(when))).toBe(expected);
    });
  });

  describe('0 */4 * * * (top of every 4th hour)', () => {
    test.each([
      ['2026-08-13T00:00:00', true],
      ['2026-08-13T04:00:00', true],
      ['2026-08-13T20:00:00', true],
      ['2026-08-13T02:00:00', false], // hour not on the step
      ['2026-08-13T04:30:00', false], // right hour, wrong minute
      ['2026-08-13T23:00:00', false],
    ])('%s -> %s', (when, expected) => {
      expect(matchesCron('0 */4 * * *', at(when))).toBe(expected);
    });
  });

  describe('standard 5-field: day-of-month and day-of-week fields participate', () => {
    test('0 9 * * 1 matches Monday 09:00 and not Tuesday 09:00', () => {
      // 2026-08-17 is a Monday, 2026-08-18 a Tuesday.
      expect(matchesCron('0 9 * * 1', at('2026-08-17T09:00:00'))).toBe(true);
      expect(matchesCron('0 9 * * 1', at('2026-08-18T09:00:00'))).toBe(false);
    });

    test('0 0 1 * * matches the 1st of the month only', () => {
      expect(matchesCron('0 0 1 * *', at('2026-09-01T00:00:00'))).toBe(true);
      expect(matchesCron('0 0 1 * *', at('2026-09-02T00:00:00'))).toBe(false);
    });
  });

  describe('invalid expressions never match', () => {
    test.each([
      'not a cron',
      '* * * *', // 4 fields
      '* * * * * *', // 6 fields
      '',
      'every 5 minutes',
    ])('%j -> false', (expr) => {
      expect(matchesCron(expr, at('2026-08-13T10:05:00'))).toBe(false);
    });

    test('an out-of-range minute matches no date', () => {
      // 61 passes the loose isValidCron field regex but can never fire.
      expect(matchesCron('61 * * * *', at('2026-08-13T10:05:00'))).toBe(false);
    });
  });
});
