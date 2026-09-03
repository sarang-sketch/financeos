import { describe, expect, it } from 'vitest';

import {
  assertInRange,
  assertPaise,
  isPaise,
  PAISE_INGESTED_MAX,
  PAISE_INGESTED_MIN,
  PAISE_MAX,
  PAISE_MIN,
  PaiseRangeError,
  PaiseTypeError,
} from './paise';

describe('paise range constants', () => {
  it('are the signed and ingested ranges from the design', () => {
    expect(PAISE_MIN).toBe(-99999999999999n);
    expect(PAISE_MAX).toBe(99999999999999n);
    expect(PAISE_INGESTED_MIN).toBe(0n);
    expect(PAISE_INGESTED_MAX).toBe(999999999999n);
  });
});

describe('isPaise', () => {
  it('accepts a bigint', () => {
    expect(isPaise(0n)).toBe(true);
    expect(isPaise(84260000n)).toBe(true);
    expect(isPaise(-1n)).toBe(true);
  });

  it('rejects a number, a boolean and null', () => {
    expect(isPaise(84260000)).toBe(false);
    expect(isPaise(0)).toBe(false);
    expect(isPaise(true)).toBe(false);
    expect(isPaise(null)).toBe(false);
    expect(isPaise(undefined)).toBe(false);
    expect(isPaise('84260000')).toBe(false);
  });
});

describe('assertPaise', () => {
  it('passes a bigint through', () => {
    expect(() => {
      assertPaise(84260000n);
    }).not.toThrow();
  });

  const notPaise: readonly (readonly [string, unknown])[] = [
    ['number', 84260000],
    ['boolean', true],
    ['null', null],
  ];

  for (const [label, value] of notPaise) {
    it(`throws PaiseTypeError on a ${label}`, () => {
      expect(() => {
        assertPaise(value);
      }).toThrow(PaiseTypeError);
    });
  }
});

describe('assertInRange', () => {
  it('accepts both range extremes and zero', () => {
    expect(() => {
      assertInRange(PAISE_MIN);
    }).not.toThrow();
    expect(() => {
      assertInRange(0n);
    }).not.toThrow();
    expect(() => {
      assertInRange(PAISE_MAX);
    }).not.toThrow();
  });

  it('rejects one paisa beyond each extreme', () => {
    expect(() => {
      assertInRange(PAISE_MIN - 1n);
    }).toThrow(PaiseRangeError);
    expect(() => {
      assertInRange(PAISE_MAX + 1n);
    }).toThrow(PaiseRangeError);
  });
});
