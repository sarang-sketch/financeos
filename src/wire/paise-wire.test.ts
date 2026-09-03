import { describe, expect, it } from 'vitest';

import { PAISE_MAX, PAISE_MIN, PaiseRangeError } from '@/calc/paise';

import { decodePaise, encodePaise, fromWire, toWire, WireError } from './paise-wire';

describe('toWire', () => {
  it('encodes zero, a single paisa either side of it, and both range extremes', () => {
    expect(toWire(0n)).toBe('0');
    expect(toWire(1n)).toBe('1');
    expect(toWire(-1n)).toBe('-1');
    expect(toWire(PAISE_MIN)).toBe('-99999999999999');
    expect(toWire(PAISE_MAX)).toBe('99999999999999');
    expect(toWire(84260000n)).toBe('84260000');
  });

  it('throws rather than emitting a string one paisa beyond each extreme', () => {
    expect(() => toWire(PAISE_MIN - 1n)).toThrow(PaiseRangeError);
    expect(() => toWire(PAISE_MAX + 1n)).toThrow(PaiseRangeError);
  });
});

describe('fromWire', () => {
  it('decodes a valid integer string', () => {
    expect(fromWire('0')).toBe(0n);
    expect(fromWire('1')).toBe(1n);
    expect(fromWire('-1')).toBe(-1n);
    expect(fromWire('84260000')).toBe(84260000n);
    expect(fromWire('-99999999999999')).toBe(PAISE_MIN);
    expect(fromWire('99999999999999')).toBe(PAISE_MAX);
  });

  it('round-trips every in-range value toWire produced', () => {
    for (const v of [0n, 1n, -1n, 84260000n, PAISE_MIN, PAISE_MAX]) {
      expect(fromWire(toWire(v))).toBe(v);
    }
  });

  const malformed: readonly (readonly [string, string])[] = [
    ['a decimal string', '842600.00'],
    ['a leading-plus string', '+84260000'],
    ['leading whitespace', ' 84260000'],
    ['a non-numeric string', 'eighty-four lakh'],
    ['an empty string', ''],
  ];

  for (const [label, value] of malformed) {
    it(`rejects ${label} with a WireError`, () => {
      expect(() => fromWire(value)).toThrow(WireError);
    });
  }

  it('names the field when the caller supplies one', () => {
    expect(() => fromWire('842600.00', 'expected_amount_paise')).toThrow(
      /monetary field expected_amount_paise is not an integer string/,
    );
  });

  it('throws the range error, not the format error, on an out-of-range integer string', () => {
    const beyondMax = (PAISE_MAX + 1n).toString();

    expect(() => fromWire(beyondMax)).toThrow(PaiseRangeError);
    expect(() => fromWire(beyondMax)).not.toThrow(WireError);
    expect(() => fromWire((PAISE_MIN - 1n).toString())).toThrow(PaiseRangeError);
  });
});

describe('encodePaise / decodePaise', () => {
  it('round-trips a value above 2^53, which the range guard rejects by design', () => {
    const unroundedProduct = 10n ** 19n;

    expect(unroundedProduct).toBeGreaterThan(2n ** 53n);
    expect(encodePaise(unroundedProduct)).toBe('10000000000000000000');
    expect(decodePaise(encodePaise(unroundedProduct))).toBe(unroundedProduct);
    expect(decodePaise(encodePaise(-unroundedProduct))).toBe(-unroundedProduct);
    expect(() => toWire(unroundedProduct)).toThrow(PaiseRangeError);
  });

  it('still rejects a malformed string', () => {
    expect(() => decodePaise('1e19')).toThrow(WireError);
  });
});
