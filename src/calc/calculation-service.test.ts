import { describe, expect, it } from 'vitest';

import {
  add,
  applyRate,
  assertInRange,
  DivisionByZeroError,
  PAISE_MAX,
  PAISE_MIN,
  PaiseRangeError,
  PaiseTypeError,
  RATE_DIVISOR,
  roundHalfUpToPaisa,
  subtract,
  sum,
  toInrDisplay,
  toLakhOrCrore,
} from './calculation-service';

describe('the range guard is the shared one, not a second copy', () => {
  it('re-exports assertInRange from src/calc/paise.ts', async () => {
    const paiseModule = await import('./paise');
    expect(assertInRange).toBe(paiseModule.assertInRange);
  });

  it('accepts +1n and -1n, the smallest non-zero magnitudes', () => {
    // paise.test.ts covers 0n, both extremes, and one paisa beyond each; the
    // smallest non-zero magnitudes are the remaining named boundary.
    expect(() => {
      assertInRange(1n);
    }).not.toThrow();
    expect(() => {
      assertInRange(-1n);
    }).not.toThrow();
  });
});

describe('the display names are aliases, not a second formatter', () => {
  it('points toInrDisplay and toLakhOrCrore at src/format/inr.ts', async () => {
    const formatModule = await import('@/format/inr');
    expect(toInrDisplay).toBe(formatModule.formatInr);
    expect(toLakhOrCrore).toBe(formatModule.secondaryUnit);
  });
});

describe('sum', () => {
  it('returns 0n for an empty array rather than throwing', () => {
    // An empty recon report, an account with no entries in range, and a
    // category with no open Exceptions all legitimately sum to zero.
    expect(sum([])).toBe(0n);
  });

  it('adds the named boundary values', () => {
    expect(sum([0n])).toBe(0n);
    expect(sum([1n, -1n])).toBe(0n);
    expect(sum([1966100n, 353900n])).toBe(2320000n); // SET-9281 fee + GST
  });

  it('reaches both range extremes exactly', () => {
    expect(sum([PAISE_MAX - 1n, 1n])).toBe(PAISE_MAX);
    expect(sum([PAISE_MIN + 1n, -1n])).toBe(PAISE_MIN);
  });

  it('accepts either extreme as a lone operand', () => {
    // An extreme passed in is a different path from an extreme arrived at: the
    // operand check runs before the running total exists.
    expect(sum([PAISE_MAX])).toBe(PAISE_MAX);
    expect(sum([PAISE_MIN])).toBe(PAISE_MIN);
  });

  it('raises rather than wrapping when a running total leaves the range', () => {
    expect(() => sum([PAISE_MAX, 1n])).toThrow(PaiseRangeError);
    expect(() => sum([PAISE_MIN, -1n])).toThrow(PaiseRangeError);
  });

  it('rejects an out-of-range operand before adding it', () => {
    expect(() => sum([PAISE_MAX + 1n])).toThrow(PaiseRangeError);
    expect(() => sum([PAISE_MIN - 1n])).toThrow(PaiseRangeError);
  });
});

describe('add', () => {
  it('returns 0n with no operands, matching sum([])', () => {
    expect(add()).toBe(0n);
  });

  it('is exact over 0n and ±1n', () => {
    expect(add(0n)).toBe(0n);
    expect(add(0n, 0n)).toBe(0n);
    expect(add(-1n)).toBe(-1n);
    expect(add(1n, -1n)).toBe(0n);
    expect(add(-1n, 1n)).toBe(0n);
  });

  it('adds at both range extremes', () => {
    expect(add(PAISE_MAX)).toBe(PAISE_MAX);
    expect(add(PAISE_MIN)).toBe(PAISE_MIN);
    expect(add(PAISE_MAX - 1n, 1n)).toBe(PAISE_MAX);
    expect(add(PAISE_MIN + 1n, -1n)).toBe(PAISE_MIN);
    expect(add(PAISE_MAX, PAISE_MIN)).toBe(0n);
  });

  it('raises one paisa beyond each extreme', () => {
    expect(() => add(PAISE_MAX, 1n)).toThrow(PaiseRangeError);
    expect(() => add(PAISE_MIN, -1n)).toThrow(PaiseRangeError);
  });

  it('raises on an out-of-range intermediate even when the total would be in range', () => {
    // Documented behaviour: Requirement 15.1 constrains every intermediate, so
    // the running total is checked as it goes and ordering is significant.
    expect(() => add(PAISE_MAX, 1n, -1n)).toThrow(PaiseRangeError);
    expect(add(PAISE_MAX, -1n, 1n)).toBe(PAISE_MAX);
  });

  it('rejects an out-of-range operand before adding it', () => {
    // The operand check, not the running-total check: nothing has accumulated
    // yet when the first assertion fires.
    expect(() => add(PAISE_MAX + 1n)).toThrow(PaiseRangeError);
    expect(() => add(PAISE_MIN - 1n)).toThrow(PaiseRangeError);
    expect(() => add(0n, PAISE_MAX + 1n)).toThrow(PaiseRangeError);
  });

  it('rejects a non-bigint operand', () => {
    // @ts-expect-error money is Paise (bigint), never number
    expect(() => add(1, 2)).toThrow(PaiseTypeError);
  });
});

describe('subtract', () => {
  it('subtracts at the named boundaries', () => {
    expect(subtract(0n, 0n)).toBe(0n);
    expect(subtract(0n, 1n)).toBe(-1n);
    expect(subtract(1n, -1n)).toBe(2n);
    expect(subtract(84260000n, 81940000n)).toBe(2320000n); // SET-9281 difference
  });

  it('reaches both range extremes exactly', () => {
    expect(subtract(PAISE_MAX - 1n, -1n)).toBe(PAISE_MAX);
    expect(subtract(PAISE_MIN + 1n, 1n)).toBe(PAISE_MIN);
    expect(subtract(PAISE_MAX, PAISE_MAX)).toBe(0n);
  });

  it('raises one paisa beyond each extreme', () => {
    expect(() => subtract(PAISE_MAX, -1n)).toThrow(PaiseRangeError);
    expect(() => subtract(PAISE_MIN, 1n)).toThrow(PaiseRangeError);
    expect(() => subtract(PAISE_MAX, PAISE_MIN)).toThrow(PaiseRangeError);
  });

  it('rejects an out-of-range operand', () => {
    expect(() => subtract(PAISE_MAX + 1n, 0n)).toThrow(PaiseRangeError);
    expect(() => subtract(0n, PAISE_MIN - 1n)).toThrow(PaiseRangeError);
  });
});

describe('applyRate', () => {
  it('reports a zero adjustment when the exact product is a whole paisa', () => {
    // 2.5% of ₹1,000.00: 100000 paise × 250 bp = 25000000, /10000 = 2500 exactly.
    const applied = applyRate(100000n, 250n);
    expect(applied.result).toBe(2500n);
    expect(applied.rounding_adjustment_paise).toBe(0n);
    expect(applied.rounding_divisor).toBe(RATE_DIVISOR);
  });

  it('is exact at a 0 basis point rate and at 10000 basis points', () => {
    expect(applyRate(84260000n, 0n).result).toBe(0n);
    expect(applyRate(84260000n, 0n).rounding_adjustment_paise).toBe(0n);
    expect(applyRate(84260000n, 10000n).result).toBe(84260000n);
  });

  it('returns 0n with a zero adjustment for a 0n value at any rate', () => {
    for (const rate of [0n, 1n, 5000n, 10000n, 300000n]) {
      const applied = applyRate(0n, rate);
      expect(applied.result).toBe(0n);
      expect(applied.rounding_adjustment_paise).toBe(0n);
    }
  });

  it('rounds ±1n at the smallest non-zero rate to 0n, residual carrying the whole product', () => {
    // 1 paisa × 1 bp = 1/10000 of a paisa: far below the tie, so the result is
    // 0n and the residual is the entire product.
    const positive = applyRate(1n, 1n);
    expect(positive.result).toBe(0n);
    expect(positive.rounding_adjustment_paise).toBe(1n);

    const negative = applyRate(-1n, 1n);
    expect(negative.result).toBe(0n);
    expect(negative.rounding_adjustment_paise).toBe(-1n);
  });

  it('reaches each range extreme exactly as a result at 10000 basis points', () => {
    expect(applyRate(PAISE_MAX, 10000n).result).toBe(PAISE_MAX);
    expect(applyRate(PAISE_MAX, 10000n).rounding_adjustment_paise).toBe(0n);
    expect(applyRate(PAISE_MIN, 10000n).result).toBe(PAISE_MIN);
    expect(applyRate(PAISE_MIN, 10000n).rounding_adjustment_paise).toBe(0n);
  });

  it('rounds an exact half paisa away from zero at both range extremes', () => {
    // Both extremes are odd, so 5000 bp of either is exactly a half paisa: the
    // tie case at the largest magnitude the range allows.
    expect((PAISE_MAX * 5000n) % RATE_DIVISOR).toBe(RATE_DIVISOR / 2n);

    const atCeiling = applyRate(PAISE_MAX, 5000n);
    expect(atCeiling.result).toBe(50000000000000n); // (PAISE_MAX + 1n) / 2n
    expect(atCeiling.rounding_adjustment_paise).toBe(-5000n);

    const atFloor = applyRate(PAISE_MIN, 5000n);
    expect(atFloor.result).toBe(-50000000000000n);
    expect(atFloor.rounding_adjustment_paise).toBe(5000n);
  });

  it('raises when the rounded result is exactly one paisa beyond an extreme', () => {
    // 10000000000000 × 100000 bp = 1e18, /10000 = 100000000000000 exactly:
    // PAISE_MAX + 1n, with no rounding involved.
    expect((10000000000000n * 100000n) / RATE_DIVISOR).toBe(PAISE_MAX + 1n);
    expect(() => applyRate(10000000000000n, 100000n)).toThrow(PaiseRangeError);
    expect(() => applyRate(-10000000000000n, 100000n)).toThrow(PaiseRangeError);
  });

  it('rounds a product that is exactly a half paisa away from zero', () => {
    // 1 paisa × 5000 bp = 5000, /10000 = exactly 0.5 paisa.
    const positive = applyRate(1n, 5000n);
    expect(positive.result).toBe(1n);
    expect(positive.rounding_adjustment_paise).toBe(-5000n); // rounded up, so the residual is negative

    // 3 paise × 5000 bp = 15000, /10000 = exactly 1.5 paise.
    const oneAndAHalf = applyRate(3n, 5000n);
    expect(oneAndAHalf.result).toBe(2n);
    expect(oneAndAHalf.rounding_adjustment_paise).toBe(-5000n);
  });

  it('rounds a negative half paisa to -1n, away from zero', () => {
    // The decision recorded in the module doc comment: -0.5 -> -1n, so that
    // applyRate(-v, r) is exactly -applyRate(v, r) and a reversing ledger set
    // balances to 0 paise.
    const negative = applyRate(-1n, 5000n);
    expect(negative.result).toBe(-1n);
    expect(negative.rounding_adjustment_paise).toBe(5000n);
  });

  it('is sign-symmetric across a spread of values and rates', () => {
    const values = [1n, 3n, 7n, 12345n, 84260000n, 99999999n];
    const rates = [1n, 250n, 1800n, 5000n, 9999n];
    for (const value of values) {
      for (const rate of rates) {
        expect(applyRate(-value, rate).result).toBe(-applyRate(value, rate).result);
      }
    }
  });

  it('rounds a negative product below the half boundary toward zero', () => {
    // -4/10 of a paisa rounds to 0n; the residual carries the whole product.
    const belowHalf = applyRate(-1n, 4000n);
    expect(belowHalf.result).toBe(0n);
    expect(belowHalf.rounding_adjustment_paise).toBe(-4000n);
  });

  it('does not raise on a large unrounded intermediate', () => {
    // 3333333333333 × 300000 = 999999999999900000, roughly 1e18 — two orders of
    // magnitude above 2^53 and far outside the paise range. The intermediate is
    // a scaled bigint, not a Paise, so it is not range-checked.
    const applied = applyRate(3333333333333n, 300000n);
    expect(applied.result).toBe(99999999999990n);
    expect(applied.rounding_adjustment_paise).toBe(0n);
    expect(3333333333333n * 300000n > 2n ** 53n).toBe(true);
  });

  it('raises on the result, not the intermediate, at the range maximum with 300000 bp', () => {
    // The product 99999999999999 × 300000 ≈ 3e19 is carried exactly; the rounded
    // result 2999999999999970 is 30× the paise ceiling, so the result check fires.
    expect(() => applyRate(PAISE_MAX, 300000n)).toThrow(PaiseRangeError);
    expect(() => applyRate(PAISE_MIN, 300000n)).toThrow(PaiseRangeError);
  });

  it('rejects an out-of-range value operand', () => {
    expect(() => applyRate(PAISE_MAX + 1n, 0n)).toThrow(PaiseRangeError);
    expect(() => applyRate(PAISE_MIN - 1n, 0n)).toThrow(PaiseRangeError);
  });

  it('reconstructs the exact unrounded product from the result and the adjustment', () => {
    // Property P12's assertion, as an example table including negatives, the
    // half boundary, and a product above 2^53.
    const cases: ReadonlyArray<readonly [bigint, bigint]> = [
      [0n, 0n],
      [0n, 300000n],
      [1n, 5000n],
      [-1n, 5000n],
      [3n, 5000n],
      [-3n, 5000n],
      [7n, 1n],
      [-7n, 1n],
      [100000n, 250n],
      [-100000n, 250n],
      [84260000n, 1800n],
      [-84260000n, 1800n],
      [3333333333333n, 300000n],
      [-3333333333333n, 300000n],
      [99999999999999n, 9999n],
      [-99999999999999n, 9999n],
    ];

    for (const [value, rate] of cases) {
      const applied = applyRate(value, rate);
      expect(applied.result * RATE_DIVISOR + applied.rounding_adjustment_numerator).toBe(
        value * rate,
      );
      expect(applied.rounding_adjustment_numerator).toBe(applied.rounding_adjustment_paise);
      // The residual is a true remainder: strictly less than half the divisor
      // in magnitude once the half case has been rounded away.
      const magnitude =
        applied.rounding_adjustment_paise < 0n
          ? -applied.rounding_adjustment_paise
          : applied.rounding_adjustment_paise;
      expect(magnitude * 2n <= RATE_DIVISOR).toBe(true);
    }
  });
});

describe('roundHalfUpToPaisa', () => {
  it('rounds a tie away from zero in both directions', () => {
    expect(roundHalfUpToPaisa(5n, 10n).result).toBe(1n);
    expect(roundHalfUpToPaisa(-5n, 10n).result).toBe(-1n);
    expect(roundHalfUpToPaisa(15n, 10n).result).toBe(2n);
    expect(roundHalfUpToPaisa(-15n, 10n).result).toBe(-2n);
  });

  it('rounds below the tie toward zero', () => {
    expect(roundHalfUpToPaisa(4n, 10n).result).toBe(0n);
    expect(roundHalfUpToPaisa(-4n, 10n).result).toBe(0n);
    expect(roundHalfUpToPaisa(14n, 10n).result).toBe(1n);
  });

  it('returns 0n for a 0n numerator, with no negative zero on a negative denominator', () => {
    const positiveDenominator = roundHalfUpToPaisa(0n, 10n);
    expect(positiveDenominator.result).toBe(0n);
    expect(positiveDenominator.rounding_adjustment_paise).toBe(0n);

    const negativeDenominator = roundHalfUpToPaisa(0n, -10n);
    expect(negativeDenominator.result).toBe(0n);
    expect(negativeDenominator.rounding_adjustment_paise).toBe(0n);
  });

  it('handles the smallest possible operands: ±1n over 1n and the ±1n over 2n tie', () => {
    expect(roundHalfUpToPaisa(1n, 1n).result).toBe(1n);
    expect(roundHalfUpToPaisa(1n, 1n).rounding_adjustment_paise).toBe(0n);
    expect(roundHalfUpToPaisa(-1n, 1n).result).toBe(-1n);

    // 1/2 is the smallest tie there is, and it goes away from zero in both signs.
    expect(roundHalfUpToPaisa(1n, 2n).result).toBe(1n);
    expect(roundHalfUpToPaisa(1n, 2n).rounding_adjustment_paise).toBe(-1n);
    expect(roundHalfUpToPaisa(-1n, 2n).result).toBe(-1n);
    expect(roundHalfUpToPaisa(-1n, 2n).rounding_adjustment_paise).toBe(1n);
  });

  it('reaches each extreme exactly, and raises exactly one paisa beyond', () => {
    expect(roundHalfUpToPaisa(PAISE_MAX, 1n).result).toBe(PAISE_MAX);
    expect(roundHalfUpToPaisa(PAISE_MIN, 1n).result).toBe(PAISE_MIN);
    expect(roundHalfUpToPaisa(PAISE_MAX * RATE_DIVISOR, RATE_DIVISOR).result).toBe(PAISE_MAX);
    expect(roundHalfUpToPaisa(PAISE_MIN * RATE_DIVISOR, RATE_DIVISOR).result).toBe(PAISE_MIN);

    // One paisa beyond, not ten times beyond: the check is on the boundary, not
    // on an obviously huge value.
    expect(() => roundHalfUpToPaisa(PAISE_MAX + 1n, 1n)).toThrow(PaiseRangeError);
    expect(() => roundHalfUpToPaisa(PAISE_MIN - 1n, 1n)).toThrow(PaiseRangeError);
  });

  it('lets a half paisa tie land on an extreme, and raises when the tie crosses it', () => {
    // Half a paisa below the ceiling rounds up onto it exactly.
    const ontoCeiling = roundHalfUpToPaisa(PAISE_MAX * RATE_DIVISOR - 5000n, RATE_DIVISOR);
    expect(ontoCeiling.result).toBe(PAISE_MAX);
    expect(ontoCeiling.rounding_adjustment_paise).toBe(-5000n);

    const ontoFloor = roundHalfUpToPaisa(PAISE_MIN * RATE_DIVISOR + 5000n, RATE_DIVISOR);
    expect(ontoFloor.result).toBe(PAISE_MIN);
    expect(ontoFloor.rounding_adjustment_paise).toBe(5000n);

    // Half a paisa past the extreme rounds away from zero onto PAISE_MAX + 1n /
    // PAISE_MIN - 1n, so the result check fires rather than the value being
    // quietly truncated back onto the boundary.
    expect(() =>
      roundHalfUpToPaisa(PAISE_MAX * RATE_DIVISOR + 5000n, RATE_DIVISOR),
    ).toThrow(PaiseRangeError);
    expect(() =>
      roundHalfUpToPaisa(PAISE_MIN * RATE_DIVISOR - 5000n, RATE_DIVISOR),
    ).toThrow(PaiseRangeError);
  });

  it('takes the sign from the quotient, so a negative denominator flips it', () => {
    expect(roundHalfUpToPaisa(5n, -10n).result).toBe(-1n);
    expect(roundHalfUpToPaisa(-5n, -10n).result).toBe(1n);
  });

  it('reconstructs the numerator from the result and the adjustment', () => {
    const cases: ReadonlyArray<readonly [bigint, bigint]> = [
      [5n, 10n],
      [-5n, 10n],
      [5n, -10n],
      [-5n, -10n],
      [4n, 10n],
      [123456789n, 7n],
      [-123456789n, 7n],
      [1n, 3n],
    ];
    for (const [numerator, denominator] of cases) {
      const rounded = roundHalfUpToPaisa(numerator, denominator);
      expect(rounded.result * denominator + rounded.rounding_adjustment_paise).toBe(numerator);
    }
  });

  it('raises DivisionByZeroError on a zero denominator rather than returning 0n', () => {
    // A silent 0n would flow into a ledger set or an Evidence_Chain as a
    // confident wrong figure, so the only safe answer is to raise.
    expect(() => roundHalfUpToPaisa(1n, 0n)).toThrow(DivisionByZeroError);
    expect(() => roundHalfUpToPaisa(0n, 0n)).toThrow(DivisionByZeroError);
  });

  it('raises when the rounded result leaves the paise range', () => {
    expect(() => roundHalfUpToPaisa(PAISE_MAX * 10n, 1n)).toThrow(PaiseRangeError);
    expect(() => roundHalfUpToPaisa(PAISE_MIN * 10n, 1n)).toThrow(PaiseRangeError);
  });

  it('rejects a non-bigint numerator or denominator', () => {
    // @ts-expect-error scaled monetary numerators are bigint, never number
    expect(() => roundHalfUpToPaisa(5, 10n)).toThrow(PaiseTypeError);
    // @ts-expect-error divisors are bigint, never number
    expect(() => roundHalfUpToPaisa(5n, 10)).toThrow(PaiseTypeError);
  });
});
