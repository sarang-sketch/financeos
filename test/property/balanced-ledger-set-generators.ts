/**
 * design.md's `arbitraryBalancedLedgerSet` and `arbitraryDateRange` building blocks, for the
 * ledger properties whose subject is a *set* rather than a Source_Record.
 *
 * WHY THIS IS NOT IN `./ledger-generators.ts`
 * ------------------------------------------
 * That module (task 8.6) holds design.md's `arbitrarySourceRecord`: `PostingSource` values for
 * the five Source_Records that have a posting rule, shared by P1 and P2. Everything in it
 * flows through `postingDraftFor`, so every set it can produce is one of the five fixed
 * posting shapes over the five accounts of `DEFAULT_CHART_OF_ACCOUNTS`.
 *
 * P13 and P14 need sets those rules cannot produce. design.md's P14 generator note asks for
 * "2 to 20 entries across a **generated account set**, including sets that post several
 * entries to the same account on the same side and sets that post to the same account on both
 * sides", and P13's closing sign rule has five branches while the production chart of accounts
 * has members of only three kinds. So `arbitraryBalancedLedgerSet` draws **balanced legs** over
 * an account pool the caller supplies, which is a different input space with a different
 * subject, not a variant of `arbitrarySourceRecord`.
 *
 * Kept as its own file so the two modules can be merged later — by whichever task wants one
 * import site — without either being rewritten under the other. Nothing here imports from
 * `./ledger-generators.ts` and nothing there imports from here.
 *
 * BALANCE IS STRUCTURAL, NOT FILTERED
 * ----------------------------------
 * Each leg contributes the same amount to both sides, so `Σdebit − Σcredit = 0` by
 * construction and no draw is ever discarded. A leg may name the same account on both sides,
 * and two legs may name the same account on the same side, which is exactly the repetition
 * P13's "each in-range account appears exactly once" and P14's per-account netting need in
 * order to mean anything.
 */

import fc from 'fast-check';

import { PAISE_MAX, type Paise } from '@/calc/calculation-service';
import type {
  DateOnly,
  LedgerEntryDraft,
  LedgerEntrySetDraft,
  SourceRef,
} from '@/ledger/posting-rules';

const MS_PER_DAY = 86_400_000;

/** An inclusive `YYYY-MM-DD` window. `from` must be on or before `to`. */
export interface DateWindow {
  readonly from: DateOnly;
  readonly to: DateOnly;
}

function epochOf(date: DateOnly): number {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) {
    throw new Error(`not a YYYY-MM-DD calendar date: ${JSON.stringify(date)}`);
  }
  return ms;
}

/** `date` shifted by whole days. Negative shifts backwards. */
export function shiftDate(date: DateOnly, days: number): DateOnly {
  return new Date(epochOf(date) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Every calendar date in `window`, ascending. Both ends included. */
export function datesIn(window: DateWindow): readonly DateOnly[] {
  const start = epochOf(window.from);
  const end = epochOf(window.to);
  if (end < start) {
    throw new Error(`date window ${window.from}..${window.to} ends before it starts`);
  }
  const dates: DateOnly[] = [];
  for (let at = start; at <= end; at += MS_PER_DAY) {
    dates.push(new Date(at).toISOString().slice(0, 10));
  }
  return dates;
}

/** A calendar date inside `window`, uniformly over the days it holds. */
export function arbitraryDateIn(window: DateWindow): fc.Arbitrary<DateOnly> {
  return fc.constantFrom(...datesIn(window));
}

/**
 * The raw draw a leg amount is folded out of.
 *
 * Biased to the ends: `0n` folds to the smallest amount a `paise_positive` column accepts,
 * and the top of the range folds to the per-leg cap exactly, so a generated set can reach its
 * whole permitted side total rather than only wandering near the middle.
 */
const arbitraryAmountSeed: fc.Arbitrary<bigint> = fc.oneof(
  {
    arbitrary: fc.constantFrom(0n, 1n, 2n, 99n, 2_783n, 99_999n, PAISE_MAX - 1n, PAISE_MAX),
    weight: 3,
  },
  { arbitrary: fc.bigInt({ min: 0n, max: PAISE_MAX }), weight: 5 },
);

export interface BalancedLedgerSetSpec {
  /** The account pool the legs draw from. Must hold at least 1 code. */
  readonly accountCodes: readonly string[];
  /** The set's `entry_date`. One date per set, as `LedgerEntrySetDraft` carries. */
  readonly entryDate: fc.Arbitrary<DateOnly>;
  /**
   * Legs per set, 1..10. Each leg is 2 entries, so this is what keeps the draft inside
   * `entry_count BETWEEN 2 AND 20` (Requirement 2.1). Defaults to 10.
   */
  readonly maxLegs?: number;
  /**
   * The largest total either side may reach. Defaults to `PAISE_MAX`.
   *
   * A caller that sums several sets' totals together needs this below `PAISE_MAX`: the
   * per-account totals are `BIGINT` in SQL, but the range-checked `sum` of the Calculation
   * Service raises once a running total leaves the paise domain.
   */
  readonly maxSideTotalPaise?: Paise;
  /** The set's Source_Record links. The first is the derivation identity. */
  readonly sourceRefs?: readonly SourceRef[];
}

const DEFAULT_SOURCE_REFS: readonly SourceRef[] = Object.freeze([
  { type: 'payment', id: 'pay_generated_set' },
]);

/**
 * A balanced `LedgerEntrySetDraft`: 1..`maxLegs` legs, each a debit and a credit of one
 * amount, over `accountCodes`.
 *
 * Every draft this produces satisfies `assertDraftWellFormed` — 2..20 entries, every amount
 * `>= 1n`, at least 1 Source_Record ref, a real calendar `entry_date` — and satisfies
 * `imbalancePaise(draft) === 0n` structurally. Neither side's total can leave the paise
 * range, because the per-leg cap is `maxSideTotalPaise / legs`.
 */
export function arbitraryBalancedLedgerSet(
  spec: BalancedLedgerSetSpec,
): fc.Arbitrary<LedgerEntrySetDraft> {
  const codes = spec.accountCodes;
  if (codes.length === 0) {
    throw new Error('arbitraryBalancedLedgerSet needs at least 1 account code');
  }
  const maxLegs = spec.maxLegs ?? 10;
  if (!Number.isInteger(maxLegs) || maxLegs < 1 || maxLegs > 10) {
    throw new Error(
      `maxLegs must be an integer in 1..10 so entry_count stays in 2..20, got ${maxLegs}`,
    );
  }
  const maxSideTotal = spec.maxSideTotalPaise ?? PAISE_MAX;
  if (maxSideTotal < BigInt(maxLegs)) {
    throw new Error(
      `maxSideTotalPaise ${maxSideTotal} cannot cover ${maxLegs} legs of at least 1 paisa`,
    );
  }
  const sourceRefs = spec.sourceRefs ?? DEFAULT_SOURCE_REFS;

  return fc
    .record({
      entry_date: spec.entryDate,
      legs: fc.array(
        fc.record({
          debit: fc.constantFrom(...codes),
          credit: fc.constantFrom(...codes),
          amountSeed: arbitraryAmountSeed,
        }),
        { minLength: 1, maxLength: maxLegs },
      ),
    })
    .map(({ entry_date, legs }) => {
      // Integer division, so `legs.length * cap <= maxSideTotal` and a leg at the cap is
      // reachable: `seed % cap` hits `cap - 1` at `seed = PAISE_MAX` for many caps and at
      // `PAISE_MAX - 1n` for the rest, both of which are in the seed pool above.
      const cap = maxSideTotal / BigInt(legs.length);
      const entries: readonly LedgerEntryDraft[] = legs.flatMap((leg) => {
        const amount: Paise = 1n + (leg.amountSeed % cap);
        return [
          { account_code: leg.debit, side: 'debit' as const, amount_paise: amount },
          { account_code: leg.credit, side: 'credit' as const, amount_paise: amount },
        ];
      });
      return { source_refs: sourceRefs, entry_date, entries };
    });
}
