/**
 * The money type for the whole TypeScript runtime.
 *
 * Every monetary value in FinanceOS is an integer number of paise held in a
 * `bigint`. No `number`, no `numeric`, no float, anywhere in a monetary path
 * (Requirement 15.1, 15.8). `number` is banned by name in `src/calc`,
 * `src/ledger`, `src/tools`, `src/agents` and `src/wire` by the
 * `no-restricted-syntax` money rules in `eslint.config.mjs`; this module is the
 * type those rules point callers at.
 *
 * The range check lives here, not in `src/wire`, because it is a calculation
 * concern: FinanceOS_Calculation_Service (task 2.1) reuses `assertInRange`
 * rather than declaring a second one, and `src/wire/paise-wire.ts` imports it.
 */

/** A monetary value in integer paise. Always `bigint`, never `number`. */
export type Paise = bigint;

/** The signed paise floor: -99999999999999 (Requirement 15.1, 15.8). */
export const PAISE_MIN: Paise = -99999999999999n;

/** The signed paise ceiling: 99999999999999 (Requirement 15.1, 15.8). */
export const PAISE_MAX: Paise = 99999999999999n;

/**
 * The ingested paise floor: 0. Values retrieved from Razorpay are unsigned and
 * stored with no rounding, truncation or unit scaling (Requirement 1.7).
 */
export const PAISE_INGESTED_MIN: Paise = 0n;

/** The ingested paise ceiling: 999999999999 (Requirement 1.7). */
export const PAISE_INGESTED_MAX: Paise = 999999999999n;

/** Thrown when a value is not a `bigint` where a `Paise` is required. */
export class PaiseTypeError extends TypeError {
  override readonly name = 'PaiseTypeError';
}

/**
 * Thrown when a `Paise` falls outside the signed paise range. Distinct from a
 * wire-format violation so callers can tell "not an integer string" from
 * "integer string, out of range".
 */
export class PaiseRangeError extends RangeError {
  override readonly name = 'PaiseRangeError';
}

/** Type guard: true only for `bigint`. `number`, `boolean` and `null` are not Paise. */
export function isPaise(value: unknown): value is Paise {
  return typeof value === 'bigint';
}

/** Assertion form of {@link isPaise}. Throws {@link PaiseTypeError} on anything else. */
export function assertPaise(value: unknown): asserts value is Paise {
  if (!isPaise(value)) {
    throw new PaiseTypeError(
      `monetary value is not a bigint: ${typeof value} ${String(value)}`,
    );
  }
}

/**
 * The single paise range guard for the TypeScript runtime. Raises rather than
 * wrapping or saturating (Requirement 15.1, 15.8).
 */
export function assertInRange(value: Paise): void {
  assertPaise(value);
  if (value < PAISE_MIN || value > PAISE_MAX) {
    throw new PaiseRangeError(`monetary value out of paise range: ${value}`);
  }
}
