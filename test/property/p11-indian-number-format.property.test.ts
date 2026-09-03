// Feature: financeos-control-tower, Property 11: Indian number format round-trip —
// for all paise values `p` in the range -99999999999999 to 99999999999999,
// `parseInr(formatInr(p)) === p`; the formatted rupee portion is grouped 2,2,3 from the
// right; and the secondary unit is `lakh` exactly when the rupee value is at or above
// 1,00,000 and below 1,00,00,000, `crore` exactly when it is at or above 1,00,00,000,
// and absent otherwise.
//
// **Validates: Requirements 3.2, 3.3, 3.11, 15.2**
//
// No `Number(...)`, `parseFloat`, `toFixed` or `Intl.NumberFormat` appears anywhere in
// this file, matching the discipline in `src/format/inr.ts`: the expected values are
// derived by integer `bigint` arithmetic and textual digit handling, because an oracle
// that went through a float could not detect the defect the property exists to rule out
// (Requirement 15.2).
//
// The canonical names in `src/format/inr.ts` are tested here, not the
// `toInrDisplay`/`toLakhOrCrore` aliases re-exported from `src/calc/calculation-service.ts`.
//
// Negative values: `secondaryUnit` bands on the **magnitude**, so `-84260000n` is
// `8.43 L`, the same text as `+84260000n`, and the secondary-unit text never carries a
// sign. That is what the implementation does (see the "bands on the magnitude" case in
// `src/format/inr.test.ts`), so it is what the independently computed band below
// asserts. `formatInr` keeps the sign, and puts the minus *before* the symbol.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { PAISE_MAX, PAISE_MIN, type Paise } from '@/calc/paise';
import { formatInr, parseInr, secondaryUnit } from '@/format/inr';

/** P11 is cheap and central, so design.md raises it from 100 to 1000 iterations. */
const NUM_RUNS = 1000;

/**
 * An explicit seed, per design.md's "seed and record" rule: a failure here has to be
 * reproducible from the committed test alone, and any counterexample gets committed as
 * an example-based regression test alongside the property.
 */
const SEED = 20260213;

const PARAMS = { numRuns: NUM_RUNS, seed: SEED } as const;

/** 1,00,000 rupees. The lakh band opens here (Requirement 3.3). */
const ONE_LAKH_RUPEES = 100_000n;

/** 1,00,00,000 rupees. The crore band opens here (Requirement 3.11). */
const ONE_CRORE_RUPEES = 10_000_000n;

/** The same thresholds in paise, for generating values that straddle them. */
const ONE_LAKH_PAISE = ONE_LAKH_RUPEES * 100n;
const ONE_CRORE_PAISE = ONE_CRORE_RUPEES * 100n;

const RUPEE_SIGN = '₹';

/** design.md's grouping regex: 2,2,3 from the right, or an ungrouped 1-3 digits. */
const GROUPED_RUPEES = /^\d{1,2}(,\d{2})*,\d{3}$|^\d{1,3}$/;

/** Exactly two decimal digits, nothing else. */
const TWO_DECIMALS = /^\d{2}$/;

/** `8.43 L` / `3.82 Cr`: unsigned digits, exactly 2 decimal places, then the unit. */
const SECONDARY_TEXT = /^\d+\.\d{2} (L|Cr)$/;

function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/**
 * The band computed independently of `secondaryUnit`, from `p / 100n` against the two
 * thresholds. Magnitude-based, matching the implementation.
 */
function expectedBand(p: Paise): 'lakh' | 'crore' | 'none' {
  const rupees = abs(p) / 100n;
  if (rupees >= ONE_CRORE_RUPEES) return 'crore';
  if (rupees >= ONE_LAKH_RUPEES) return 'lakh';
  return 'none';
}

interface FormattedParts {
  readonly negative: boolean;
  readonly hasSymbol: boolean;
  /** The rupee portion as printed, commas included. */
  readonly rupeeGroups: string;
  /** The rupee portion with the group separators removed. */
  readonly rupeeDigits: string;
  /** Everything after the decimal point. */
  readonly paiseDigits: string;
  readonly decimalPointCount: number;
}

/**
 * Splits a formatted string structurally — strip the sign, strip the symbol, split on
 * the decimal point — rather than matching a loose regex over the whole string, so a
 * misplaced minus or a missing `₹` cannot slip through as a pass. Pure: it asserts
 * nothing, the properties do the asserting.
 */
function splitFormatted(text: string): FormattedParts {
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const hasSymbol = unsigned.startsWith(RUPEE_SIGN);
  const body = hasSymbol ? unsigned.slice(RUPEE_SIGN.length) : unsigned;

  const dot = body.indexOf('.');
  const rupeeGroups = dot === -1 ? body : body.slice(0, dot);
  const paiseDigits = dot === -1 ? '' : body.slice(dot + 1);

  return {
    negative,
    hasSymbol,
    rupeeGroups,
    rupeeDigits: rupeeGroups.replace(/,/g, ''),
    paiseDigits,
    decimalPointCount: [...body].filter((c) => c === '.').length,
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** design.md's generator: the whole signed paise range. */
const arbitraryFullRangePaise = fc.bigInt({ min: PAISE_MIN, max: PAISE_MAX });

/**
 * design.md's boundary values, plus the negation of each positive one. The range is
 * signed and the round-trip has to hold on both signs, so `-1n`, `-100n` and the rest
 * carry the same weight as their positive twins. `-0n === 0n`, so zero appears once.
 */
const arbitraryBoundaryPaise: fc.Arbitrary<Paise> = fc.constantFrom(
  0n,
  1n,
  -1n,
  99n,
  -99n,
  100n,
  -100n,
  9999999n,
  -9999999n,
  10000000n,
  -10000000n,
  999999999n,
  -999999999n,
  1000000000n,
  -1000000000n,
  PAISE_MIN,
  PAISE_MAX,
);

/** The full range, biased toward the boundaries where the bands and grouping change. */
const arbitraryPaise = fc.oneof(
  { arbitrary: arbitraryFullRangePaise, weight: 3 },
  { arbitrary: arbitraryBoundaryPaise, weight: 2 },
);

/**
 * Values within 100 paise of a band threshold, both signs. This is what pins the flip
 * to the exact threshold rather than one unit early or late: a `>` written where `>=`
 * belongs survives the uniform generator almost always, and dies here.
 */
const arbitraryNearThreshold: fc.Arbitrary<readonly [Paise, Paise]> = fc
  .tuple(
    fc.constantFrom(ONE_LAKH_PAISE, ONE_CRORE_PAISE),
    fc.bigInt({ min: -100n, max: 100n }),
    fc.boolean(),
  )
  .map(([threshold, delta, negate]): readonly [Paise, Paise] => [
    threshold,
    negate ? -(threshold + delta) : threshold + delta,
  ]);

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

describe('Property 11: Indian number format round-trip', () => {
  it('round-trips every paise value through formatInr and parseInr exactly', () => {
    fc.assert(
      fc.property(arbitraryPaise, (p) => {
        const parsed = parseInr(formatInr(p));
        // A parse that came back as a `number` has already lost the property.
        expect(typeof parsed).toBe('bigint');
        expect(parsed).toBe(p);
      }),
      PARAMS,
    );
  });

  it('groups the rupee portion 2,2,3 and always renders exactly 2 decimal places', () => {
    fc.assert(
      fc.property(arbitraryPaise, (p) => {
        const text = formatInr(p);
        const parts = splitFormatted(text);

        // The sign is carried, and it precedes the symbol: `-₹661.00`.
        expect(parts.negative).toBe(p < 0n);
        expect(parts.hasSymbol).toBe(true);
        expect(parts.decimalPointCount).toBe(1);

        expect(parts.rupeeGroups).toMatch(GROUPED_RUPEES);
        expect(parts.paiseDigits).toMatch(TWO_DECIMALS);

        // The grouping regex admits a leading zero group; the formatter never emits
        // one, because the rupee digits come from `bigint.toString()`.
        expect(parts.rupeeDigits.length === 1 || !parts.rupeeDigits.startsWith('0')).toBe(
          true,
        );
      }),
      PARAMS,
    );
  });

  it('emits no float artefacts, and its digits reconstruct the paise value exactly', () => {
    fc.assert(
      fc.property(arbitraryPaise, (p) => {
        const text = formatInr(p);

        // Nothing that only a float path could produce.
        expect(text.includes('e')).toBe(false);
        expect(text.includes('E')).toBe(false);
        expect(text.includes('NaN')).toBe(false);
        expect(text.includes('Infinity')).toBe(false);
        expect(text.includes('+')).toBe(false);
        // Sign, symbol, digits, group separators and one decimal point: nothing else.
        expect(text).toMatch(/^-?₹[0-9,]+\.[0-9]{2}$/);

        const parts = splitFormatted(text);
        expect(parts.rupeeDigits).toMatch(/^\d+$/);
        expect(parts.paiseDigits).toMatch(TWO_DECIMALS);

        // Rebuild the value from the printed digits with integer arithmetic only.
        const magnitude = BigInt(parts.rupeeDigits) * 100n + BigInt(parts.paiseDigits);
        expect(parts.negative ? -magnitude : magnitude).toBe(p);
        expect(magnitude).toBe(abs(p));
      }),
      PARAMS,
    );
  });

  it('bands the secondary unit exactly as the thresholds computed independently', () => {
    fc.assert(
      fc.property(arbitraryPaise, (p) => {
        const band = expectedBand(p);
        const actual = secondaryUnit(p);

        expect(actual.unit).toBe(band);

        if (band === 'none') {
          expect(actual.text).toBeNull();
          return;
        }

        const text = actual.text ?? '';
        // Exactly 2 decimal places on the lakh and crore text, and the right suffix.
        expect(text).toMatch(SECONDARY_TEXT);
        expect(text.endsWith(band === 'crore' ? ' Cr' : ' L')).toBe(true);
        // Magnitude-based, so the secondary text is never signed.
        expect(text.includes('-')).toBe(false);

        const decimals = text.slice(0, text.indexOf(' ')).split('.')[1] ?? '';
        expect(decimals).toMatch(TWO_DECIMALS);
      }),
      PARAMS,
    );
  });

  it('flips the band at exactly the lakh and crore thresholds, in both signs', () => {
    fc.assert(
      fc.property(arbitraryNearThreshold, ([threshold, p]) => {
        expect(secondaryUnit(p).unit).toBe(expectedBand(p));

        // The unit keys off the magnitude, so a value and its negation share a band.
        expect(secondaryUnit(-p).unit).toBe(secondaryUnit(p).unit);

        // One paisa below the threshold is still the lower band; the threshold itself
        // is the higher one. `>` where `>=` belongs dies here.
        const below = secondaryUnit(threshold - 1n).unit;
        const at = secondaryUnit(threshold).unit;
        expect(below).not.toBe(at);
        expect(at).toBe(threshold === ONE_CRORE_PAISE ? 'crore' : 'lakh');
        expect(below).toBe(threshold === ONE_CRORE_PAISE ? 'lakh' : 'none');
      }),
      PARAMS,
    );
  });
});
