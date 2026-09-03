// Feature: financeos-control-tower, Property 12: Integer-only monetary arithmetic —
// for all sequences of FinanceOS_Calculation_Service operations over generated paise
// operands, every operand, intermediate value and result is a `bigint` within
// -99999999999999 to 99999999999999; no operation silently produces a non-integer or
// out-of-range value; out-of-range results raise rather than wrap or saturate; and for
// any rate multiplication, `result * rounding_divisor + rounding_adjustment_numerator`
// reconstructs the exact unrounded product.
//
// **Validates: Requirements 1.7, 8.2, 10.6, 11.8, 15.1, 15.8, 15.9**
//
// `Number.isInteger` appears nowhere in this file, and neither does a `number`-typed
// monetary value: the assertion is `typeof x === 'bigint'`, because a monetary value
// that reached a `number` has already lost the property under test.
//
// P12's companion schema assertion — query `information_schema.columns` and assert no
// monetary column has type `numeric`, `real`, `double precision` or `money` — is NOT
// here. It belongs to task 4.8 (schema type audit), which runs in the `db` project
// against Supabase local with migrations applied. There is no schema to query yet.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  add,
  applyRate,
  DivisionByZeroError,
  PAISE_MAX,
  PAISE_MIN,
  type Paise,
  PaiseRangeError,
  RATE_DIVISOR,
  type RoundedPaise,
  roundHalfUpToPaisa,
  subtract,
  sum,
} from '@/calc/calculation-service';

/** P12 is cheap and central, so design.md raises it from 100 to 1000 iterations. */
const NUM_RUNS = 1000;

/**
 * An explicit seed, per design.md's "seed and record" rule: a failure here has to be
 * reproducible from the committed test alone, and any counterexample gets committed as
 * an example-based regression test alongside the property.
 */
const SEED = 20260212;

const PARAMS = { numRuns: NUM_RUNS, seed: SEED } as const;

function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/** Asserts a value is a `bigint` inside the paise range. Used on every Paise. */
function expectPaiseValue(value: Paise): void {
  expect(typeof value).toBe('bigint');
  expect(value >= PAISE_MIN).toBe(true);
  expect(value <= PAISE_MAX).toBe(true);
}

/**
 * Asserts a value is a `bigint` without a range bound. For the scaled values that are
 * deliberately not Paise: the unrounded product, the rounding residual, the divisor.
 */
function expectBigint(value: bigint): void {
  expect(typeof value).toBe('bigint');
}

/**
 * The full RoundedPaise contract: the residual is reported under all three names from
 * one expression, the reconstruction identity holds unconditionally, the residual is a
 * true remainder, and a tie rounds away from zero.
 */
function expectRounded(
  rounded: RoundedPaise,
  numerator: bigint,
  denominator: bigint,
): void {
  expectPaiseValue(rounded.result);
  expectBigint(rounded.rounding_adjustment_paise);
  expectBigint(rounded.rounding_adjustment_numerator);
  expectBigint(rounded.rounding_divisor);

  // One expression, three names.
  expect(rounded.rounding_adjustment_numerator).toBe(rounded.rounding_adjustment_paise);
  expect(rounded.rounding_divisor).toBe(denominator);

  // The reconstruction identity, asserted against the divisor the service reports
  // rather than a hardcoded 10000n.
  expect(
    rounded.result * rounded.rounding_divisor + rounded.rounding_adjustment_numerator,
  ).toBe(numerator);

  // The residual is the discarded fraction, so it never reaches a whole unit.
  const residual = rounded.rounding_adjustment_paise;
  expect(abs(residual) * 2n <= abs(denominator)).toBe(true);

  // Half away from zero: on a tie the result overshot, so the residual points back
  // toward zero — opposite in sign to the numerator.
  if (abs(residual) * 2n === abs(denominator)) {
    expect(numerator > 0n ? residual < 0n : residual > 0n).toBe(true);
  }
}

type Attempt<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/**
 * Runs `fn` and reports whether it returned or raised. Nothing inside an `attempt`
 * asserts, so an assertion failure can never be mistaken for the raise under test, and
 * `ok: false` is positive evidence that no value came back.
 */
function attempt<T>(fn: () => T): Attempt<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** design.md's operand generator: the whole signed paise range. */
const arbitraryFullRangePaise = fc.bigInt({ min: PAISE_MIN, max: PAISE_MAX });

/**
 * Operands three orders of magnitude below the ceiling. Mixed in with the full-range
 * generator because a sequence built only from ±1e14 operands overflows on its first
 * or second step, and then the fold never gets deep enough to check an intermediate.
 * Both branches matter: the modest one exercises the returning path, the full-range one
 * the raising path.
 */
const arbitraryModestPaise = fc.bigInt({
  min: -1_000_000_000n,
  max: 1_000_000_000n,
});

const arbitraryOperandPaise = fc.oneof(
  { arbitrary: arbitraryModestPaise, weight: 3 },
  { arbitrary: arbitraryFullRangePaise, weight: 1 },
);

/** Rates in basis points: 10000 is 1x, 300000 is the top of the range design.md generates. */
const arbitraryRateBasisPoints = fc.bigInt({ min: 0n, max: 300000n });

/**
 * A non-zero divisor, both signs. `roundHalfUpToPaisa` takes a scaled `bigint`
 * denominator, not a Paise, and a negative denominator legitimately flips the sign of
 * the quotient.
 */
const arbitraryNonZeroDenominator = fc.oneof(
  fc.bigInt({ min: 1n, max: 1_000_000n }),
  fc.bigInt({ min: -1_000_000n, max: -1n }),
);

type Operation =
  | { readonly kind: 'add'; readonly operands: readonly Paise[] }
  | { readonly kind: 'subtract'; readonly operand: Paise }
  | { readonly kind: 'sum'; readonly operands: readonly Paise[] }
  | { readonly kind: 'applyRate'; readonly rateBasisPoints: bigint }
  | { readonly kind: 'roundHalfUpToPaisa'; readonly denominator: bigint };

const arbitraryOperation: fc.Arbitrary<Operation> = fc.oneof(
  fc
    .array(arbitraryOperandPaise, { minLength: 0, maxLength: 4 })
    .map((operands): Operation => ({ kind: 'add', operands })),
  arbitraryOperandPaise.map((operand): Operation => ({ kind: 'subtract', operand })),
  fc
    .array(arbitraryOperandPaise, { minLength: 0, maxLength: 6 })
    .map((operands): Operation => ({ kind: 'sum', operands })),
  arbitraryRateBasisPoints.map(
    (rateBasisPoints): Operation => ({ kind: 'applyRate', rateBasisPoints }),
  ),
  arbitraryNonZeroDenominator.map(
    (denominator): Operation => ({ kind: 'roundHalfUpToPaisa', denominator }),
  ),
);

/** design.md's `arbitraryOperationSequence`, composing all five service operations. */
const arbitraryOperationSequence = fc.array(arbitraryOperation, {
  minLength: 1,
  maxLength: 12,
});

/** Every `bigint` an operation feeds into the service, so each one can be type-checked. */
function operandsOf(operation: Operation): readonly bigint[] {
  switch (operation.kind) {
    case 'add':
    case 'sum':
      return operation.operands;
    case 'subtract':
      return [operation.operand];
    case 'applyRate':
      return [operation.rateBasisPoints];
    case 'roundHalfUpToPaisa':
      return [operation.denominator];
  }
}

type StepOutcome =
  | { readonly kind: 'value'; readonly value: Paise }
  | {
      readonly kind: 'rounded';
      readonly rounded: RoundedPaise;
      readonly numerator: bigint;
      readonly denominator: bigint;
    };

/** One fold step. No assertions live here — see {@link attempt}. */
function runStep(accumulator: Paise, operation: Operation): StepOutcome {
  switch (operation.kind) {
    case 'add':
      return { kind: 'value', value: add(accumulator, ...operation.operands) };
    case 'subtract':
      return { kind: 'value', value: subtract(accumulator, operation.operand) };
    case 'sum':
      return { kind: 'value', value: sum([accumulator, ...operation.operands]) };
    case 'applyRate':
      return {
        kind: 'rounded',
        rounded: applyRate(accumulator, operation.rateBasisPoints),
        numerator: accumulator * operation.rateBasisPoints,
        denominator: RATE_DIVISOR,
      };
    case 'roundHalfUpToPaisa':
      return {
        kind: 'rounded',
        rounded: roundHalfUpToPaisa(accumulator, operation.denominator),
        numerator: accumulator,
        denominator: operation.denominator,
      };
  }
}

/** The first running total of `operands` that leaves the paise range, if any. */
function firstOutOfRangeRunningTotal(operands: readonly Paise[]): bigint | undefined {
  let total = 0n;
  for (const operand of operands) {
    total += operand;
    if (total < PAISE_MIN || total > PAISE_MAX) return total;
  }
  return undefined;
}

/** Odd values, so `v * 5000n` lands exactly on a half paisa. Never zero. */
const arbitraryOddPaise = (bound: bigint): fc.Arbitrary<Paise> =>
  fc.bigInt({ min: -bound, max: bound }).map((k) => k * 2n + 1n);

/**
 * Value/rate pairs whose exact product is a half paisa: `|v * r| % 10000n === 5000n`.
 * Two families, because the half can come from either operand — an odd value against an
 * odd multiple of 5000 bp, or an odd rate against a value that is 5000 times an odd
 * number. Magnitudes are bounded so the rounded result stays inside the paise range;
 * the out-of-range path is covered by its own property below.
 */
const arbitraryHalfPaisaPair: fc.Arbitrary<readonly [Paise, bigint]> = fc.oneof(
  fc
    .tuple(arbitraryOddPaise(166_666_666n), fc.bigInt({ min: 0n, max: 29n }))
    .map(([value, j]): readonly [Paise, bigint] => [value, (j * 2n + 1n) * 5000n]),
  fc
    .tuple(arbitraryOddPaise(33_332n), fc.bigInt({ min: 0n, max: 149_999n }))
    .map(([odd, j]): readonly [Paise, bigint] => [odd * 5000n, j * 2n + 1n]),
);

/**
 * Operand pairs that provably overflow: `a >= PAISE_MAX / 2n` and
 * `b >= PAISE_MAX - a + 1n`, so `a + b > PAISE_MAX` for every generated pair.
 */
const arbitraryOverflowingPair: fc.Arbitrary<readonly [Paise, Paise]> = fc
  .bigInt({ min: PAISE_MAX / 2n, max: PAISE_MAX })
  .chain((a) =>
    fc
      .bigInt({ min: PAISE_MAX - a + 1n, max: PAISE_MAX })
      .map((b): readonly [Paise, Paise] => [a, b]),
  );

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

describe('Property 12: integer-only monetary arithmetic', () => {
  it('keeps every operand, intermediate and result a bigint in paise range across an operation sequence', () => {
    fc.assert(
      fc.property(
        arbitraryOperandPaise,
        arbitraryOperationSequence,
        (start, operations) => {
          expectPaiseValue(start);

          let accumulator = start;
          for (const operation of operations) {
            for (const operand of operandsOf(operation)) {
              // Rates and divisors are scaled bigints, not Paise, so only the
              // Paise operands carry the range bound.
              expectBigint(operand);
              if (operation.kind === 'add' || operation.kind === 'sum') {
                expectPaiseValue(operand);
              }
              if (operation.kind === 'subtract') expectPaiseValue(operand);
            }

            const outcome = attempt(() => runStep(accumulator, operation));
            if (!outcome.ok) {
              // A step that would leave the range raises instead of wrapping or
              // saturating, and returns nothing. That is a passing case, and the
              // fold stops there because there is no value to carry forward.
              expect(outcome.error).toBeInstanceOf(PaiseRangeError);
              return;
            }

            const step = outcome.value;
            if (step.kind === 'value') {
              expectPaiseValue(step.value);
              accumulator = step.value;
            } else {
              expectRounded(step.rounded, step.numerator, step.denominator);
              accumulator = step.rounded.result;
            }
            // Every intermediate is checked here, not just the final result.
            expectPaiseValue(accumulator);
          }

          expectPaiseValue(accumulator);
        },
      ),
      PARAMS,
    );
  });

  it('sums paise operand arrays exactly, or raises on the first out-of-range running total', () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryOperandPaise, { minLength: 0, maxLength: 40 }),
        (operands) => {
          for (const operand of operands) expectPaiseValue(operand);

          const overflowingTotal = firstOutOfRangeRunningTotal(operands);
          const outcome = attempt(() => sum(operands));

          if (overflowingTotal === undefined) {
            expect(outcome.ok).toBe(true);
            if (!outcome.ok) return;
            expectPaiseValue(outcome.value);
            // Exact: the bigint total, with no rounding, truncation or saturation.
            expect(outcome.value).toBe(operands.reduce((a, b) => a + b, 0n));
            // add(...xs) agrees with sum(xs) for every xs, empty array included.
            expect(add(...operands)).toBe(outcome.value);
          } else {
            expect(outcome.ok).toBe(false);
            if (outcome.ok) return;
            expect(outcome.error).toBeInstanceOf(PaiseRangeError);
            expect(
              overflowingTotal > PAISE_MAX || overflowingTotal < PAISE_MIN,
            ).toBe(true);
          }
        },
      ),
      PARAMS,
    );
  });

  it('reconstructs the exact unrounded product from an applyRate result and its adjustment', () => {
    fc.assert(
      fc.property(
        arbitraryFullRangePaise,
        arbitraryRateBasisPoints,
        (value, rateBasisPoints) => {
          expectPaiseValue(value);
          expectBigint(rateBasisPoints);

          const product = value * rateBasisPoints;
          expectBigint(product);
          // The unrounded product reaches ~3e19. It is a scaled bigint, not a Paise,
          // so it carries no range bound — only the result does.
          const truncatedMagnitude = abs(product) / RATE_DIVISOR;

          const outcome = attempt(() => applyRate(value, rateBasisPoints));

          if (!outcome.ok) {
            expect(outcome.error).toBeInstanceOf(PaiseRangeError);
            // A raise is only warranted when the quotient really is out of range.
            expect(truncatedMagnitude >= PAISE_MAX).toBe(true);
            return;
          }

          // Conversely, a quotient past the ceiling must have raised.
          expect(truncatedMagnitude <= PAISE_MAX).toBe(true);
          expect(outcome.value.rounding_divisor).toBe(RATE_DIVISOR);
          expectRounded(outcome.value, product, RATE_DIVISOR);
        },
      ),
      PARAMS,
    );
  });

  it('negates exactly under a negated value, so a reversing ledger set still balances', () => {
    // The rounding decision recorded in calculation-service.ts: -0.5 rounds to -1n,
    // away from zero, precisely so this holds. Half-toward-+inf would break a
    // reversal by one paisa and the ledger would reject the set.
    fc.assert(
      fc.property(
        arbitraryFullRangePaise,
        arbitraryRateBasisPoints,
        (value, rateBasisPoints) => {
          const positive = attempt(() => applyRate(value, rateBasisPoints));
          const negated = attempt(() => applyRate(-value, rateBasisPoints));

          expect(negated.ok).toBe(positive.ok);
          if (!positive.ok || !negated.ok) {
            expect(positive.ok || negated.ok).toBe(false);
            return;
          }

          expectPaiseValue(positive.value.result);
          expectPaiseValue(negated.value.result);
          expect(negated.value.result).toBe(-positive.value.result);
          expect(negated.value.rounding_adjustment_numerator).toBe(
            -positive.value.rounding_adjustment_numerator,
          );
        },
      ),
      PARAMS,
    );
  });

  it('raises on deliberately overflowing operand pairs rather than wrapping or saturating', () => {
    fc.assert(
      fc.property(arbitraryOverflowingPair, ([a, b]) => {
        expectPaiseValue(a);
        expectPaiseValue(b);
        // The generator's premise, asserted rather than assumed.
        expect(a + b > PAISE_MAX).toBe(true);
        expect(-a - b < PAISE_MIN).toBe(true);

        const overflowing: ReadonlyArray<() => Paise> = [
          () => add(a, b),
          () => sum([a, b]),
          () => add(-a, -b),
          () => sum([-a, -b]),
          () => subtract(a, -b), // a - (-b) === a + b
          () => subtract(-a, b), // -a - b
        ];

        for (const operation of overflowing) {
          const outcome = attempt(operation);
          // No value is returned at all: not a wrapped one, not a saturated one.
          expect(outcome.ok).toBe(false);
          if (outcome.ok) continue;
          expect(outcome.error).toBeInstanceOf(PaiseRangeError);
        }
      }),
      PARAMS,
    );
  });

  it('rounds an exact half paisa away from zero in both signs', () => {
    fc.assert(
      fc.property(arbitraryHalfPaisaPair, ([value, rateBasisPoints]) => {
        expectPaiseValue(value);
        expectBigint(rateBasisPoints);

        const product = value * rateBasisPoints;
        const half = RATE_DIVISOR / 2n;
        // The generator's premise: the exact product is a half paisa.
        expect(abs(product) % RATE_DIVISOR).toBe(half);

        const applied = applyRate(value, rateBasisPoints);
        expectRounded(applied, product, RATE_DIVISOR);

        // Away from zero, so the magnitude rounds up in both signs.
        const expectedMagnitude = (abs(product) + half) / RATE_DIVISOR;
        expect(applied.result).toBe(value < 0n ? -expectedMagnitude : expectedMagnitude);
        // The result overshot by exactly half a paisa, so the residual points back.
        expect(applied.rounding_adjustment_numerator).toBe(value < 0n ? half : -half);
      }),
      PARAMS,
    );
  });

  it('reconstructs the numerator from any roundHalfUpToPaisa result and its adjustment', () => {
    fc.assert(
      fc.property(
        // Scaled numerators, deliberately reaching well past the paise ceiling: the
        // numerator is a product, not a Paise, and only the result is range-checked.
        fc.bigInt({ min: PAISE_MIN * RATE_DIVISOR, max: PAISE_MAX * RATE_DIVISOR }),
        arbitraryNonZeroDenominator,
        (numerator, denominator) => {
          expectBigint(numerator);
          expectBigint(denominator);
          expect(denominator === 0n).toBe(false);

          const truncatedMagnitude = abs(numerator) / abs(denominator);
          const outcome = attempt(() => roundHalfUpToPaisa(numerator, denominator));

          if (!outcome.ok) {
            expect(outcome.error).toBeInstanceOf(PaiseRangeError);
            expect(truncatedMagnitude >= PAISE_MAX).toBe(true);
            return;
          }

          expect(truncatedMagnitude <= PAISE_MAX).toBe(true);
          expectRounded(outcome.value, numerator, denominator);
          // The sign of the quotient, independent of the rounding path.
          if (outcome.value.result !== 0n) {
            const expectedNegative = numerator < 0n !== denominator < 0n;
            expect(outcome.value.result < 0n).toBe(expectedNegative);
          }
        },
      ),
      PARAMS,
    );
  });

  it('raises DivisionByZeroError on a zero denominator rather than returning a value', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: PAISE_MIN * RATE_DIVISOR, max: PAISE_MAX * RATE_DIVISOR }),
        (numerator) => {
          const outcome = attempt(() => roundHalfUpToPaisa(numerator, 0n));
          // A silent 0n would flow into a ledger set as a confident wrong figure.
          expect(outcome.ok).toBe(false);
          if (outcome.ok) return;
          expect(outcome.error).toBeInstanceOf(DivisionByZeroError);
        },
      ),
      PARAMS,
    );
  });
});
