/**
 * IST rendering tests (Requirement 3.10).
 *
 * The instants are chosen so the +05:30 offset is exercised rather than assumed:
 * one mid-UTC-day instant, one late-UTC-day instant that crosses midnight IST,
 * and the exact 18:30:00Z boundary where the IST date rolls over.
 */

import { describe, expect, it } from 'vitest';
import { formatIst, formatIstIso, IST_OFFSET_MINUTES } from '@/format/ist';

describe('formatIst', () => {
  it('IST is a fixed UTC+05:30 offset', () => {
    expect(IST_OFFSET_MINUTES).toBe(330);
  });

  it('renders a mid-UTC-day instant at IST wall-clock time', () => {
    // 16:05:07Z + 05:30 = 21:35:07 IST, same calendar day
    expect(formatIst(new Date('2024-03-14T16:05:07Z'))).toBe('2024-03-14 21:35:07 IST');
  });

  it('crosses midnight IST for a late-UTC-day instant', () => {
    // 20:30:00Z on the 14th is 02:00:00 IST on the 15th
    expect(formatIst(new Date('2024-03-14T20:30:00Z'))).toBe('2024-03-15 02:00:00 IST');
    // 23:59:59Z on the 14th is 05:29:59 IST on the 15th
    expect(formatIst(new Date('2024-03-14T23:59:59Z'))).toBe('2024-03-15 05:29:59 IST');
  });

  it('rolls the IST date over at exactly 18:30:00Z', () => {
    expect(formatIst(new Date('2024-03-14T18:29:59Z'))).toBe('2024-03-14 23:59:59 IST');
    expect(formatIst(new Date('2024-03-14T18:30:00Z'))).toBe('2024-03-15 00:00:00 IST');
  });

  it('drops milliseconds rather than rounding them', () => {
    expect(formatIst(new Date('2024-03-14T16:05:07.001Z'))).toBe('2024-03-14 21:35:07 IST');
    expect(formatIst(new Date('2024-03-14T16:05:07.999Z'))).toBe('2024-03-14 21:35:07 IST');
  });

  it('has no daylight saving: the offset is the same in January and July', () => {
    expect(formatIst(new Date('2024-01-15T12:00:00Z'))).toBe('2024-01-15 17:30:00 IST');
    expect(formatIst(new Date('2024-07-15T12:00:00Z'))).toBe('2024-07-15 17:30:00 IST');
  });

  it('accepts an ISO string and an epoch millisecond value', () => {
    expect(formatIst('2024-03-14T16:05:07Z')).toBe('2024-03-14 21:35:07 IST');
    expect(formatIst(0)).toBe('1970-01-01 05:30:00 IST');
  });

  it('never emits a sub-second component, whatever the milliseconds are', () => {
    const SHAPE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} IST$/;
    const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/;
    const instants = [
      '2024-03-14T16:05:07.000Z', // exact whole UTC second
      '2024-03-14T16:05:07.001Z',
      '2024-03-14T16:05:07.500Z',
      '2024-03-14T16:05:07.999Z',
      '2024-03-14T18:30:00.999Z', // the IST date rollover, with milliseconds
      '1970-01-01T00:00:00.001Z',
    ];
    for (const instant of instants) {
      const text = formatIst(instant);
      const iso = formatIstIso(instant);
      expect(text).toMatch(SHAPE);
      expect(iso).toMatch(ISO_SHAPE);
      expect(text).not.toContain('.');
      // The two renderers describe the same instant: same date, same whole second.
      expect(iso).toBe(`${text.slice(0, 10)}T${text.slice(11, 19)}+05:30`);
    }
  });

  it('rejects an invalid instant', () => {
    expect(() => formatIst('not a timestamp')).toThrow(RangeError);
    expect(() => formatIst(new Date(Number.NaN))).toThrow(RangeError);
  });
});

describe('formatIstIso', () => {
  it('renders the same instant offset-qualified to whole seconds', () => {
    expect(formatIstIso(new Date('2024-03-14T16:05:07.500Z'))).toBe(
      '2024-03-14T21:35:07+05:30',
    );
    expect(formatIstIso(new Date('2024-03-14T18:30:00Z'))).toBe(
      '2024-03-15T00:00:00+05:30',
    );
  });
});
