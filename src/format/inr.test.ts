/**
 * Formatter boundary tests (Requirement 3.2, 3.3, 3.11, 15.2).
 *
 * The exact strings asserted here are the ones written into design.md's
 * Indian_Number_Format section; they are the contract, not illustrations.
 * Property P11 (task 3.2) generalises the round-trip over the whole range.
 */

import { describe, expect, it } from 'vitest';
import { PAISE_MAX, PAISE_MIN, PaiseRangeError } from '@/calc/paise';
import {
  formatInr,
  InrParseError,
  parseInr,
  secondaryUnit,
  twoDecimalsFromRatio,
} from '@/format/inr';

describe('formatInr', () => {
  it('renders the design.md worked examples exactly', () => {
    expect(formatInr(3820000000n)).toBe('₹3,82,00,000.00');
    expect(formatInr(84260000n)).toBe('₹8,42,600.00');
    expect(formatInr(100n)).toBe('₹1.00');
    expect(formatInr(0n)).toBe('₹0.00');
    // The minus sign precedes the symbol.
    expect(formatInr(-66100n)).toBe('-₹661.00');
  });

  it('always renders exactly 2 decimal places', () => {
    expect(formatInr(1n)).toBe('₹0.01');
    expect(formatInr(10n)).toBe('₹0.10');
    expect(formatInr(99n)).toBe('₹0.99');
    expect(formatInr(-1n)).toBe('-₹0.01');
  });

  it('does not group a rupee value of three digits or fewer', () => {
    expect(formatInr(99900n)).toBe('₹999.00');
    expect(formatInr(100000n)).toBe('₹1,000.00');
  });

  it('groups 2,2,3 from the right', () => {
    expect(formatInr(1000000n)).toBe('₹10,000.00');
    expect(formatInr(10000000n)).toBe('₹1,00,000.00');
    expect(formatInr(100000000n)).toBe('₹10,00,000.00');
    expect(formatInr(1000000000n)).toBe('₹1,00,00,000.00');
  });

  it('carries the sign before the symbol at every named boundary', () => {
    // -0n === 0n for a bigint, so zero is never signed.
    expect(formatInr(-0n)).toBe('₹0.00');
    expect(formatInr(-100n)).toBe('-₹1.00');
    expect(formatInr(-9999999n)).toBe('-₹99,999.99');
    expect(formatInr(-10000000n)).toBe('-₹1,00,000.00');
    expect(formatInr(-999999999n)).toBe('-₹99,99,999.99');
    expect(formatInr(-1000000000n)).toBe('-₹1,00,00,000.00');
  });

  it('renders a negative exactly as its positive twin with a leading minus', () => {
    for (const p of [100n, 9999999n, 10000000n, 999999999n, 1000000000n, PAISE_MAX]) {
      expect(formatInr(-p)).toBe(`-${formatInr(p)}`);
    }
  });

  it('renders both range extremes', () => {
    // 99999999999999 paise is 999999999999 rupees: 12 digits, grouped 9,99,99,99,99,999
    expect(formatInr(PAISE_MAX)).toBe('₹9,99,99,99,99,999.99');
    expect(formatInr(PAISE_MIN)).toBe('-₹9,99,99,99,99,999.99');
  });

  it('rejects a value outside the paise range', () => {
    expect(() => formatInr(PAISE_MAX + 1n)).toThrow(PaiseRangeError);
    expect(() => formatInr(PAISE_MIN - 1n)).toThrow(PaiseRangeError);
  });
});

describe('secondaryUnit', () => {
  it('omits the secondary unit below 1,00,000 rupees', () => {
    // ₹99,999.99
    expect(formatInr(9999999n)).toBe('₹99,999.99');
    expect(secondaryUnit(9999999n)).toEqual({ unit: 'none', text: null });
    expect(secondaryUnit(0n)).toEqual({ unit: 'none', text: null });
  });

  it('opens the lakh band at exactly 1,00,000 rupees', () => {
    expect(formatInr(10000000n)).toBe('₹1,00,000.00');
    expect(secondaryUnit(10000000n)).toEqual({ unit: 'lakh', text: '1.00 L' });
  });

  it('stays in the lakh band at 99,99,999.99 rupees', () => {
    expect(formatInr(999999999n)).toBe('₹99,99,999.99');
    expect(secondaryUnit(999999999n).unit).toBe('lakh');
    expect(secondaryUnit(999999999n).text).toBe('100.00 L');
  });

  it('opens the crore band at exactly 1,00,00,000 rupees', () => {
    expect(formatInr(1000000000n)).toBe('₹1,00,00,000.00');
    expect(secondaryUnit(1000000000n)).toEqual({ unit: 'crore', text: '1.00 Cr' });
  });

  it('renders the design.md secondary-unit examples exactly', () => {
    // ₹8,42,600 is 8.426 lakh, rounded half up to 2 decimal places.
    expect(secondaryUnit(84260000n)).toEqual({ unit: 'lakh', text: '8.43 L' });
    expect(secondaryUnit(3820000000n)).toEqual({ unit: 'crore', text: '3.82 Cr' });
  });

  it('bands on the magnitude, so negatives carry the same unit', () => {
    expect(secondaryUnit(-84260000n)).toEqual({ unit: 'lakh', text: '8.43 L' });
    expect(secondaryUnit(-3820000000n)).toEqual({ unit: 'crore', text: '3.82 Cr' });
    expect(secondaryUnit(-9999999n)).toEqual({ unit: 'none', text: null });
  });

  it('omits the secondary unit at ₹1.00, the smallest grouped value and ₹0.01', () => {
    expect(secondaryUnit(1n)).toEqual({ unit: 'none', text: null });
    expect(secondaryUnit(100n)).toEqual({ unit: 'none', text: null });
    expect(secondaryUnit(100000n)).toEqual({ unit: 'none', text: null }); // ₹1,000.00
  });

  it('gives a negative the same band and the same unsigned text at every boundary', () => {
    for (const p of [100n, 9999999n, 10000000n, 999999999n, 1000000000n]) {
      expect(secondaryUnit(-p)).toEqual(secondaryUnit(p));
      expect(secondaryUnit(-p).text ?? '').not.toContain('-');
    }
  });

  it('bands both range extremes in crore', () => {
    expect(secondaryUnit(PAISE_MAX)).toEqual({ unit: 'crore', text: '100000.00 Cr' });
    expect(secondaryUnit(PAISE_MIN)).toEqual({ unit: 'crore', text: '100000.00 Cr' });
  });
});

describe('twoDecimalsFromRatio', () => {
  it('rounds half up on the magnitude', () => {
    expect(twoDecimalsFromRatio(1n, 3n)).toBe('0.33');
    expect(twoDecimalsFromRatio(2n, 3n)).toBe('0.67');
    expect(twoDecimalsFromRatio(5n, 1000n)).toBe('0.01'); // exact half rounds up
    expect(twoDecimalsFromRatio(-5n, 1000n)).toBe('-0.01'); // half away from zero
    expect(twoDecimalsFromRatio(4n, 1000n)).toBe('0.00');
  });

  it('pads the fractional part to two digits', () => {
    expect(twoDecimalsFromRatio(1n, 1n)).toBe('1.00');
    expect(twoDecimalsFromRatio(101n, 100n)).toBe('1.01');
    expect(twoDecimalsFromRatio(11n, 10n)).toBe('1.10');
  });

  it('rejects a zero denominator', () => {
    expect(() => twoDecimalsFromRatio(1n, 0n)).toThrow(RangeError);
    // Zero over zero is still a zero denominator, and a negative numerator does not
    // change that.
    expect(() => twoDecimalsFromRatio(0n, 0n)).toThrow(RangeError);
    expect(() => twoDecimalsFromRatio(-1n, 0n)).toThrow(RangeError);
  });

  it('takes the sign from both operands', () => {
    expect(twoDecimalsFromRatio(5n, -1000n)).toBe('-0.01');
    expect(twoDecimalsFromRatio(-5n, -1000n)).toBe('0.01');
    expect(twoDecimalsFromRatio(-1n, -3n)).toBe('0.33');
    expect(twoDecimalsFromRatio(1n, -3n)).toBe('-0.33');
  });

  it('never emits a negative zero', () => {
    expect(twoDecimalsFromRatio(0n, 100n)).toBe('0.00');
    expect(twoDecimalsFromRatio(0n, -100n)).toBe('0.00');
    // Rounds down to zero, so the sign is dropped rather than printed as "-0.00".
    expect(twoDecimalsFromRatio(-4n, 1000n)).toBe('0.00');
    expect(twoDecimalsFromRatio(4n, -1000n)).toBe('0.00');
  });

  it('is exact for magnitudes beyond Number.MAX_SAFE_INTEGER', () => {
    // 99999999999999 paise over 100: the whole part alone has 12 digits.
    expect(twoDecimalsFromRatio(PAISE_MAX, 100n)).toBe('999999999999.99');
    expect(twoDecimalsFromRatio(PAISE_MIN, 100n)).toBe('-999999999999.99');
    // The same exact half as 5/1000, scaled so numerator, denominator and the
    // internal `numerator * 100n` all exceed 2^53. A float path would drift here.
    const scale = 10n ** 16n;
    expect(twoDecimalsFromRatio(5n * scale, 1000n * scale)).toBe('0.01');
  });
});

describe('parseInr', () => {
  const ROUND_TRIP: readonly bigint[] = [
    0n,
    1n,
    -1n,
    99n,
    100n,
    9999999n,
    10000000n,
    999999999n,
    1000000000n,
    PAISE_MIN,
    PAISE_MAX,
  ];

  it('is the exact inverse of formatInr', () => {
    for (const p of ROUND_TRIP) {
      expect(parseInr(formatInr(p))).toBe(p);
    }
  });

  it('tolerates an absent symbol, absent separators and a short decimal part', () => {
    expect(parseInr('₹1.00')).toBe(100n);
    expect(parseInr('1.00')).toBe(100n);
    expect(parseInr('1')).toBe(100n);
    expect(parseInr('1.5')).toBe(150n);
    expect(parseInr('  ₹8,42,600.00  ')).toBe(84260000n);
    expect(parseInr('-₹661.00')).toBe(-66100n);
  });

  it('round-trips the negative twin of every named boundary', () => {
    for (const p of ROUND_TRIP) {
      expect(parseInr(formatInr(-p))).toBe(-p);
    }
  });

  it('rejects text that is not an INR money string', () => {
    expect(() => parseInr('')).toThrow(InrParseError);
    expect(() => parseInr('₹')).toThrow(InrParseError);
    expect(() => parseInr('abc')).toThrow(InrParseError);
    expect(() => parseInr('₹1.234')).toThrow(InrParseError);
    expect(() => parseInr('1.2.3')).toThrow(InrParseError);
  });

  it('rejects float notation rather than parsing it to a wrong value', () => {
    // A float-style exponent is not a money string, and must not be read as `1000`.
    expect(() => parseInr('₹1e3')).toThrow(InrParseError);
    expect(() => parseInr('1E3')).toThrow(InrParseError);
    expect(() => parseInr('₹1.0e2')).toThrow(InrParseError);
    expect(() => parseInr('NaN')).toThrow(InrParseError);
    expect(() => parseInr('Infinity')).toThrow(InrParseError);
    expect(() => parseInr('₹1.')).toThrow(InrParseError);
    expect(() => parseInr('₹.5')).toThrow(InrParseError);
  });

  it('rejects a misplaced or duplicated sign', () => {
    expect(() => parseInr('+₹1.00')).toThrow(InrParseError);
    expect(() => parseInr('--₹1.00')).toThrow(InrParseError);
    // The minus precedes the symbol, so the symbol-first form is not accepted.
    expect(() => parseInr('₹-1.00')).toThrow(InrParseError);
  });

  it('ignores group separators rather than validating the grouping', () => {
    // Documented leniency: `parseInr` strips every comma before matching, so it is not
    // a grouping validator. `formatInr` is what produces 2,2,3 grouping, and P11's
    // grouping regex is what pins it.
    expect(parseInr('₹1,0,000.00')).toBe(1000000n);
    expect(parseInr('₹1000000.00')).toBe(100000000n);
    expect(parseInr('₹1,0,0.00')).toBe(10000n);
  });

  it('rejects a parsed value outside the paise range', () => {
    expect(parseInr('₹9,99,99,99,99,999.99')).toBe(PAISE_MAX);
    // one rupee past the ceiling: 10,00,00,00,00,000 rupees
    expect(() => parseInr('₹10,00,00,00,00,000.00')).toThrow(PaiseRangeError);
  });
});
