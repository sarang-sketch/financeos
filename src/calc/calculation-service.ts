/**
 * FinanceOS_Calculation_Service — the only place monetary arithmetic happens.
 *
 * Pure, synchronous, `bigint` only. No I/O, no async, no module state, no
 * `number` anywhere in a monetary path, no `Math.*`, no `Number(...)` on a
 * monetary value (Requirement 15.1, 15.8).
 *
 * The range guard is NOT redeclared here. `assertInRange` is imported from
 * `src/calc/paise.ts` and re-exported, so there is exactly one paise range guard
 * in the TypeScript runtime. Two guards could drift; one cannot.
 *
 * `toInrDisplay` and `toLakhOrCrore` appear in design.md's `CalculationService`
 * interface but are not implemented here either. Formatting lives in
 * `src/format/inr.ts`, and duplicating a formatter carries the same drift hazard
 * as duplicating the range guard, so the two interface names are re-exported as
 * aliases of `formatInr` and `secondaryUnit`. One implementation, two names.
 *
 * ## Two rounding decisions, stated explicitly
 *
 * ### 1. `rounding_adjustment_paise` is the scaled residual
 *
 * For `roundHalfUpToPaisa(numerator, denominator)`:
 *
 *     rounding_adjustment_paise := numerator - result * denominator
 *
 * so the exact unrounded value is always reconstructible from what is returned:
 *
 *     result * denominator + rounding_adjustment_paise === numerator
 *
 * For `applyRate(v, r)` the numerator is the exact product `v * r` and the
 * denominator is {@link RATE_DIVISOR} (`10000n`, because a rate is in basis
 * points), which specialises the identity to design.md's property P12:
 *
 *     applyRate(v, r).result * 10000n + adjustmentNumerator === v * r
 *
 * The adjustment is therefore expressed in units of 1/`denominator` of a paisa,
 * not in whole paise — it is the *numerator* of the discarded fraction. The
 * adjustment in paise is `rounding_adjustment_paise / rounding_divisor`, which
 * is exactly the value that is not an integer and is exactly why the field is
 * reported unrounded. `rounding_adjustment_numerator` and `rounding_divisor` are
 * returned alongside under the names P12 uses, computed from the same single
 * expression, so no reader has to infer the unit.
 *
 * The sign convention follows from the identity: the adjustment is what the
 * rounded result *lost*, so it is positive when the result rounded down and
 * negative when the result rounded up, whatever the sign of the value.
 *
 * ### 2. Half up means half away from zero
 *
 * Requirement 15.9 says "round the product half up to the nearest whole paisa"
 * and does not say which way −0.5 goes. `BigInt` division truncates toward zero,
 * which is neither half-up nor half-down, so the choice has to be made here:
 *
 *   **−0.5 rounds to −1n (half away from zero), not to 0n (half toward +∞).**
 *
 * The reason is double-entry symmetry: `applyRate(-v, r).result` must equal
 * `-applyRate(v, r).result` exactly. The Semantic_Ledger reverses a set with
 * per-account amounts equal and debit/credit designations exchanged
 * (Requirement 2.4), and posts a Refund with designations opposite to the
 * refunded Payment (Requirement 2.9). Half-toward-+∞ breaks that: it would round
 * a rate applied to a −0.5 paisa position one paisa differently from the same
 * rate on the +0.5 paisa position, and the reversing set would miss balance by
 * one paisa — which the ledger rejects outright. Sign symmetry is worth more
 * here than the monotonicity that half-toward-+∞ would buy.
 *
 * ## Range checking, and the one intermediate that is deliberately not checked
 *
 * Every operand, every intermediate that is a Paise, and every result is checked
 * against the paise range and raises {@link PaiseRangeError} rather than
 * wrapping or saturating (Requirement 15.1, 15.8). For `add` and `sum` that
 * includes each running total, so an out-of-range partial sum raises even when
 * the final total would have landed back in range.
 *
 * The unrounded product inside `applyRate` is the exception, and it is not an
 * oversight: at the range maximum with a 300000-basis-point rate the product is
 * `99999999999999n * 300000n`, roughly 3 × 10^19 — five orders of magnitude
 * above the paise ceiling. It is a `bigint` scaled by 10000, **not a Paise**, so
 * it is not range-checked; `bigint` is exact at any magnitude, so nothing is
 * lost by carrying it. Range-checking it would make every non-trivial rate
 * calculation throw. The operands and the final rounded result are checked, and
 * that is the complete set of Paise values in the operation. Do not "fix" this
 * by adding a check on the product.
 */

import {
  assertInRange,
  assertPaise,
  type Paise,
  PAISE_MAX,
  PAISE_MIN,
  PaiseRangeError,
  PaiseTypeError,
} from './paise';

export {
  assertInRange,
  assertPaise,
  type Paise,
  PAISE_MAX,
  PAISE_MIN,
  PaiseRangeError,
  PaiseTypeError,
};

/**
 * `toInrDisplay` and `toLakhOrCrore` under design.md's `CalculationService`
 * names. These are aliases, not implementations: `src/format/inr.ts` is the only
 * formatter, so there is nothing here that can drift away from it.
 */
export {
  formatInr as toInrDisplay,
  secondaryUnit as toLakhOrCrore,
} from '@/format/inr';

/**
 * The divisor for a rate in basis points. 10000 basis points is 1×, so
 * `applyRate` divides the product by this to get paise.
 */
export const RATE_DIVISOR = 10000n;

/** Thrown when `roundHalfUpToPaisa` is given a zero denominator. */
export class DivisionByZeroError extends RangeError {
  override readonly name = 'DivisionByZeroError';
}

/**
 * A rounded monetary result together with the exact discarded fraction, so
 * Requirement 15.9's "report the rounding adjustment with the result" holds and
 * the unrounded value stays reconstructible.
 */
export interface RoundedPaise {
  /** The half-up rounded value in whole paise. Range-checked. */
  readonly result: Paise;

  /**
   * The residual, in units of 1/{@link rounding_divisor} of a paisa:
   * `numerator - result * denominator`. Bounded in magnitude by
   * `|denominator| / 2`, so it is NOT a paise magnitude and is NOT range-checked
   * (see the module doc comment). Positive when the result rounded down,
   * negative when it rounded up.
   */
  readonly rounding_adjustment_paise: bigint;

  /** The same value as {@link rounding_adjustment_paise}, under the name property P12 uses. */
  readonly rounding_adjustment_numerator: bigint;

  /** The denominator the adjustment is scaled by. {@link RATE_DIVISOR} for `applyRate`. */
  readonly rounding_divisor: bigint;
}

function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/**
 * Adds any number of Paise operands. Each operand and each running total is
 * range-checked.
 *
 * `add()` with no operands returns `0n`, matching {@link sum} over an empty
 * array: the additive identity is the only answer that keeps `add(...xs)` equal
 * to `sum(xs)` for every `xs`.
 *
 * @throws {PaiseRangeError} when an operand, a running total, or the result
 * leaves the paise range. Never wraps, never saturates.
 */
export function add(...v: Paise[]): Paise {
  let total = 0n;
  for (const operand of v) {
    assertInRange(operand);
    total += operand;
    assertInRange(total); // the running total is an intermediate Paise
  }
  return total;
}

/**
 * `a - b`. Both operands and the result are range-checked.
 *
 * @throws {PaiseRangeError} when an operand or the result leaves the paise range.
 */
export function subtract(a: Paise, b: Paise): Paise {
  assertInRange(a);
  assertInRange(b);
  const result = a - b;
  assertInRange(result);
  return result;
}

/**
 * Sums an array of Paise. `sum([])` returns `0n` rather than throwing: an empty
 * settlement recon report, an account with no entries in a date range, and an
 * Exception_Category with no open Exceptions all legitimately sum to zero, and
 * every caller would otherwise have to special-case the empty array.
 *
 * @throws {PaiseRangeError} when an element, a running total, or the total
 * leaves the paise range.
 */
export function sum(v: Paise[]): Paise {
  let total = 0n;
  for (const element of v) {
    assertInRange(element);
    total += element;
    assertInRange(total); // the running total is an intermediate Paise
  }
  return total;
}

/**
 * Divides `numerator` by `denominator`, rounding half away from zero, and
 * reports the exact discarded residual (Requirement 15.9).
 *
 * `numerator` and `denominator` are scaled `bigint` values, **not Paise**: the
 * numerator is typically a product that is orders of magnitude outside the paise
 * range. Only `result` is range-checked.
 *
 * Guarantees, for every input where it returns:
 *   - `result * denominator + rounding_adjustment_paise === numerator`
 *   - `|rounding_adjustment_paise| * 2n <= |denominator|`
 *   - `roundHalfUpToPaisa(-n, d).result === -roundHalfUpToPaisa(n, d).result`
 *
 * A zero denominator raises {@link DivisionByZeroError} rather than returning a
 * sentinel: there is no monetary value that answers "divided by nothing", and a
 * silent `0n` would flow into a ledger set or an Evidence_Chain as a confident
 * wrong figure.
 *
 * @throws {DivisionByZeroError} when `denominator` is `0n`.
 * @throws {PaiseRangeError} when the rounded result leaves the paise range.
 */
export function roundHalfUpToPaisa(
  numerator: bigint,
  denominator: bigint,
): RoundedPaise {
  assertPaise(numerator);
  assertPaise(denominator);
  if (denominator === 0n) {
    throw new DivisionByZeroError(
      `cannot round ${numerator} over a zero denominator`,
    );
  }

  const magnitudeNumerator = abs(numerator);
  const magnitudeDenominator = abs(denominator);

  let quotient = magnitudeNumerator / magnitudeDenominator; // exact, truncating
  const remainder = magnitudeNumerator % magnitudeDenominator;
  // Half away from zero: compare 2*remainder to the denominator so the tie is
  // decided without ever forming a fraction. See the module doc comment.
  if (remainder * 2n >= magnitudeDenominator) {
    quotient += 1n;
  }

  const numeratorIsNegative = numerator < 0n;
  const denominatorIsNegative = denominator < 0n;
  const resultIsNegative = numeratorIsNegative !== denominatorIsNegative;
  const result = resultIsNegative ? -quotient : quotient;
  assertInRange(result);

  const residual = numerator - result * denominator;
  return {
    result,
    rounding_adjustment_paise: residual,
    rounding_adjustment_numerator: residual,
    rounding_divisor: denominator,
  };
}

/**
 * Multiplies a Paise value by a rate in basis points, rounding half away from
 * zero to the nearest paisa and reporting the rounding adjustment
 * (Requirement 15.9). 10000 basis points is 1×; 300000 is the top of the rate
 * range design.md generates.
 *
 * The unrounded product `value * rateBasisPoints` is a `bigint` scaled by
 * {@link RATE_DIVISOR}, not a Paise, and is deliberately not range-checked — it
 * reaches roughly 3 × 10^19 at the range maximum. `value` and `result` are
 * checked. See the module doc comment before adding a check here.
 *
 * Reconstruction of the exact product (design.md property P12):
 *
 *     result * 10000n + rounding_adjustment_numerator === value * rateBasisPoints
 *
 * @throws {PaiseRangeError} when `value` or the rounded result leaves the paise
 * range. `applyRate(PAISE_MAX, 300000n)` raises for that reason: the product is
 * exact, but the rounded result is 30× the paise ceiling.
 */
export function applyRate(
  value: Paise,
  rateBasisPoints: bigint,
): RoundedPaise {
  assertInRange(value);
  assertPaise(rateBasisPoints);
  // Exact at any magnitude. Not a Paise, so not range-checked.
  const product = value * rateBasisPoints;
  return roundHalfUpToPaisa(product, RATE_DIVISOR);
}
