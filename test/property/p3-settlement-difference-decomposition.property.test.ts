// Feature: financeos-control-tower, Property 3: Settlement difference decomposition
// exactness — for all generated Settlement_Recon_Reports and received amounts,
// `difference_paise = fee_component_paise + gst_component_paise + residual_paise`
// exactly in integer paise with zero slack; the status is `difference_explained` if and
// only if `residual_paise = 0n`; and a Settlement with an absent or empty report
// computes no Expected Amount, no Difference, and is excluded from the reported total
// shortfall.
//
// **Validates: Requirements 4.2, 4.3, 4.4, 4.5, 4.13**
//
// P3 is one of the four properties design.md raises to `numRuns: 1000`, and it runs
// in-process against the pure functions of `src/agents/reconciliation/reconcile-settlement.ts`:
// `reconcileSettlement` takes no clock, no database and no context, so there is nothing
// to stand up and no Supabase local involvement.
//
// ## What P3 adds over the 36 example tests in `reconcile-settlement.test.ts`
//
// 11.1's unit tests already cover, **by example**, the two `unreconciled` branches, the
// three residual signs with their statuses and directions, both adjustment conventions,
// `totalShortfall`'s Requirement 4.13 exclusion, and the paise range boundary. Restating
// those as a property would prove nothing new. What is here and not there:
//
// | | `reconcile-settlement.test.ts` (11.1) | P3 (this file) |
// |---|---|---|
// | decomposition exactness | 4 hand-picked reports | ∀ 1000 reports, 1..6 payments × 0..4 refunds/chargebacks/signed adjustments, Differences from `0n` to ±2e9 |
// | `explained ⇔ residual 0n` | 3 examples, one direction each | the biconditional in **both** directions against a residual the generator *intended*, so a `zero` case returning `mismatch` and a `positive` case returning `difference_explained` both fail |
// | Expected Amount | 3 literal figures | ∀ reports, against an **independent** reduction written from Requirement 4.2's words (`naiveExpected`), not against `expectedAmount` |
// | `unreconciled` | 2 examples (absent, empty) | ∀ draws, with the *same* line data present as in the reconciled case, so "empty payment list with every other line populated" is the common case rather than a single fixture |
// | shortfall exclusion | 1 example, 2 rows | ∀ draws against a companion Settlement, asserting the aggregate is *identical* to the aggregate without the unreconciled row — and ∀ sets of 1..8 Settlements |
// | shrinking | — | a counterexample minimises its data before its shape, so the failing report is reported small and still labelled `negative`/`present` |
//
// ## What clause 1 actually catches, stated honestly
//
// `residual` is *defined* in `reconcileSettlement` as `difference − fee − gst`, so
// `difference === fee + gst + residual` is exact **by construction** for every input.
// Asserting it today cannot fail: there is no rounding step, no rate, no division and no
// `number` anywhere on the path. So clause 1 is a **regression barrier**, not a
// discovery: it fails the moment someone computes the residual some other way — a
// `roundHalfUpToPaisa` inserted to "tidy" a fee, an intermediate that goes through
// `Number(...)`, a fee component read from a Razorpay field instead of summed from the
// enumerated lines, or a reordering that computes `fee + gst` first and subtracts once.
// It is also the TypeScript twin of the `difference_decomposes_exactly` CHECK, so the
// two cannot drift.
//
// The clauses that carry real weight today are the others: the biconditional against an
// **intended** residual (which is what a tolerance band would break), `expected` against
// an independent reduction (which is what a dropped or sign-flipped adjustment would
// break), and the five-nulls / exclusion clause (which is what a `0n`-instead-of-`null`
// would break — and a `0n` there would silently understate the total shortfall). Each of
// those is shown to be independently load-bearing by the mutations recorded at the foot
// of this file.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  examinedCounts,
  type ReconReportLines,
  reconcileSettlement,
  residualImpactPaise,
  type SettlementRecon,
  totalShortfall,
} from '@/agents/reconciliation/reconcile-settlement';
import { PAISE_MAX, type Paise } from '@/calc/paise';

import {
  arbitrarySettlementReconCaseSet,
  arbitrarySettlementWithReconReport,
  type ReportShape,
  type ResidualShape,
  type SettlementReconCase,
  WIDEST_GENERATED_MAGNITUDE,
} from './settlement-recon-generators';

/** P3 is pure, in-process and central, so design.md raises it from 100 to 1000 iterations. */
const NUM_RUNS = 1000;

/**
 * An explicit seed, per design.md's "seed and record" rule: a failure here has to be
 * reproducible from the committed test alone, and any counterexample gets committed as
 * an example-based regression test alongside the property.
 */
const SEED = 20260214;

const PARAMS = { numRuns: NUM_RUNS, seed: SEED } as const;

/** The five figures that are `null` together or non-null together. */
const ALL_FIGURES = [
  'expected_paise',
  'difference_paise',
  'fee_component_paise',
  'gst_component_paise',
  'residual_paise',
] as const;

/* -------------------------------------------------------------------------- */
/* The independent oracle                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Requirement 4.2's Expected Amount, written from the requirement's words rather than
 * from the implementation:
 *
 * > the sum of Payment amounts enumerated in the Settlement_Recon_Report minus the sum
 * > of Refund amounts enumerated in that report minus the sum of chargeback amounts
 * > enumerated in that report plus the signed sum of adjustment amounts enumerated in
 * > that report
 *
 * This is **not** `expectedAmount` from the module under test, and calling that instead
 * would compare the implementation against itself and prove nothing. Two deliberate
 * differences: the accumulation is a single interleaved fold over the four groups rather
 * than four separate `sum` calls combined by `subtract`/`add`, and the operators are
 * plain `bigint` `+`/`-` rather than the Calculation Service — so a defect introduced
 * *inside* `sum`, `add` or `subtract` shows up here as a disagreement instead of
 * cancelling out on both sides.
 *
 * No range check, on purpose: the generator keeps every draw four orders of magnitude
 * inside the domain by construction (asserted below), so a `PaiseRangeError` from the
 * implementation would be a real finding rather than a generator artefact.
 */
function naiveExpected(report: ReconReportLines): Paise {
  let expected = 0n;
  for (const payment of report.payments) {
    expected = expected + payment;
  }
  for (const refund of report.refunds) {
    expected = expected - refund;
  }
  for (const chargeback of report.chargebacks) {
    expected = expected - chargeback;
  }
  for (const adjustment of report.adjustments) {
    // Signed: a debit already arrives negative (Requirement 4.2, "signed sum").
    expected = expected + adjustment;
  }
  return expected;
}

/** Every monetary line a report enumerates, for the domain-headroom assertion. */
function allLines(report: ReconReportLines): readonly Paise[] {
  return [
    ...report.payments,
    ...report.refunds,
    ...report.chargebacks,
    ...report.adjustments,
    ...report.fees,
    ...report.gst_on_fees,
  ];
}

/**
 * The companion Settlement: one Payment, no fee and no GST lines, and a received amount
 * solved so its residual is exactly `companion_residual_paise`. It exists so the
 * aggregation has a reconciled row in it — an exclusion clause asserted against a
 * one-row aggregate would pass on an implementation that excluded everything.
 */
function companionRecon(c: SettlementReconCase): SettlementRecon {
  const report: ReconReportLines = {
    payments: [c.companion_payment_paise],
    refunds: [],
    chargebacks: [],
    adjustments: [],
    fees: [],
    gst_on_fees: [],
  };
  return reconcileSettlement(
    c.companion_settlement_id,
    c.companion_payment_paise - c.companion_residual_paise,
    report,
  );
}

/* -------------------------------------------------------------------------- */
/* The property                                                               */
/* -------------------------------------------------------------------------- */

describe('Property 3: settlement difference decomposition exactness', () => {
  it('decomposes every Difference exactly, explains it iff the residual is 0n, and excludes an unreconciled Settlement from the shortfall', () => {
    fc.assert(
      fc.property(arbitrarySettlementWithReconReport, (c) => {
        // The generator's own premise, asserted rather than assumed: every draw is
        // inside the paise domain **by construction**, with three orders of magnitude
        // of headroom, so no `fc.pre` and no filter is needed and a PaiseRangeError
        // could not be mistaken for the defect under test.
        for (const line of allLines(c.drawn_report)) {
          expect(typeof line).toBe('bigint');
          expect(line <= WIDEST_GENERATED_MAGNITUDE).toBe(true);
          expect(-line <= WIDEST_GENERATED_MAGNITUDE).toBe(true);
        }
        expect(c.received_paise <= WIDEST_GENERATED_MAGNITUDE).toBe(true);
        expect(-c.received_paise <= WIDEST_GENERATED_MAGNITUDE).toBe(true);
        expect(WIDEST_GENERATED_MAGNITUDE * 1000n <= PAISE_MAX).toBe(true);

        const recon = reconcileSettlement(c.settlement_id, c.received_paise, c.report);
        const companion = companionRecon(c);
        const withUnreconciled = totalShortfall([recon, companion]);
        const companionOnly = totalShortfall([companion]);

        // The shortfall and excess lists are directional, so a Settlement can never be
        // in both — regardless of shape.
        for (const id of withUnreconciled.shortfall_settlement_ids) {
          expect(withUnreconciled.excess_settlement_ids).not.toContain(id);
        }

        // The received amount comes from the Settlement object, so it survives an
        // absent report (Requirement 4.13, and why `unreconciled_has_no_figures` does
        // not constrain it).
        expect(recon.received_paise).toBe(c.received_paise);
        expect(recon.settlement_id).toBe(c.settlement_id);

        if (c.report_shape !== 'present') {
          // Requirement 4.13: no Expected Amount, no Difference, nothing at all.
          for (const figure of ALL_FIGURES) {
            expect(recon[figure]).toBeNull();
          }
          expect(recon.status).toBe('unreconciled');
          expect(recon.direction).toBe('not_applicable');
          // No Exception figure either, so 4.5 creates nothing for this Settlement.
          expect(residualImpactPaise(recon)).toBeNull();

          // Excluded from the reported total shortfall: the aggregate over the pair is
          // *identical* to the aggregate over the companion alone. A `0n` in place of a
          // `null` would pass the "all figures null" clause on a different
          // implementation but would land in one of these two totals.
          expect(withUnreconciled.total_shortfall_paise).toBe(companionOnly.total_shortfall_paise);
          expect(withUnreconciled.total_excess_paise).toBe(companionOnly.total_excess_paise);
          expect(withUnreconciled.residual_nonzero_count).toBe(
            companionOnly.residual_nonzero_count,
          );
          expect(withUnreconciled.shortfall_settlement_ids).not.toContain(c.settlement_id);
          expect(withUnreconciled.excess_settlement_ids).not.toContain(c.settlement_id);
          // Reported separately instead (Requirement 4.13's "report the Settlement
          // identifier"), so exclusion is not silence.
          expect(withUnreconciled.unreconciled_settlement_ids).toContain(c.settlement_id);

          // The two halves of 4.13 stay distinguishable: an empty report still
          // enumerated its other lines, and the counts say so.
          const counts = examinedCounts(c.report);
          expect(counts.payments_counted).toBe(0);
          if (c.report_shape === 'empty') {
            expect(counts.refunds_counted).toBe(c.drawn_report.refunds.length);
            expect(counts.adjustments_counted).toBe(c.drawn_report.adjustments.length);
          }
          return;
        }

        // ---- Reconciled: every figure is stated ----
        const expectedPaise = recon.expected_paise;
        const difference = recon.difference_paise;
        const fee = recon.fee_component_paise;
        const gst = recon.gst_component_paise;
        const residual = recon.residual_paise;
        expect(expectedPaise).not.toBeNull();
        expect(difference).not.toBeNull();
        expect(fee).not.toBeNull();
        expect(gst).not.toBeNull();
        expect(residual).not.toBeNull();
        if (
          expectedPaise === null ||
          difference === null ||
          fee === null ||
          gst === null ||
          residual === null
        ) {
          return; // Narrowing only; the assertions above already failed.
        }

        // Clause 3: Expected Amount against the independent reduction, not against
        // `expectedAmount` (Requirement 4.2).
        expect(typeof expectedPaise).toBe('bigint');
        expect(expectedPaise).toBe(naiveExpected(c.drawn_report));

        // Clause 6a: the Difference is `expected − received`, computed here rather than
        // read back (Requirement 4.2).
        expect(difference).toBe(expectedPaise - c.received_paise);

        // Clause 1: exact integer decomposition, zero slack, no tolerance
        // (Requirement 4.3). Also the TypeScript twin of the
        // `difference_decomposes_exactly` CHECK.
        expect(difference).toBe(fee + gst + residual);

        // The components are the sums of the enumerated lines and nothing else — the
        // clause that fails if a component is ever read from a Razorpay field or scaled
        // by a rate instead of summed.
        expect(fee).toBe(naiveTotal(c.drawn_report.fees));
        expect(gst).toBe(naiveTotal(c.drawn_report.gst_on_fees));

        // The generator solved the fee and GST lines for an intended residual, so this
        // is the implementation rediscovering a value the test knew independently.
        expect(residual).toBe(c.intended_residual_paise);

        // Clause 2: the biconditional, both directions (Requirement 4.4). No tolerance
        // band: one paisa is a mismatch.
        expect(recon.status === 'difference_explained').toBe(residual === 0n);
        expect(recon.status).toBe(residual === 0n ? 'difference_explained' : 'mismatch');
        expect(recon.status === 'difference_explained').toBe(c.residual_shape === 'zero');

        // Clause 5: the direction agrees with the sign in all three cases
        // (Requirement 4.4, 4.5).
        expect(recon.direction).toBe(
          residual === 0n
            ? 'not_applicable'
            : residual > 0n
              ? 'unexplained_shortfall'
              : 'unexplained_excess',
        );
        // `|residual|` is the Exception's INR impact, and there is no Exception at all
        // for a zero residual (Requirement 4.4, 4.5).
        expect(residualImpactPaise(recon)).toBe(
          residual === 0n ? null : residual > 0n ? residual : -residual,
        );

        // The reconciled Settlement lands in exactly the one list its residual points
        // at, and moves the matching total by exactly `|residual|`.
        expect(withUnreconciled.unreconciled_settlement_ids).not.toContain(c.settlement_id);
        if (residual > 0n) {
          expect(withUnreconciled.shortfall_settlement_ids).toContain(c.settlement_id);
          expect(withUnreconciled.total_shortfall_paise).toBe(
            companionOnly.total_shortfall_paise + residual,
          );
          expect(withUnreconciled.total_excess_paise).toBe(companionOnly.total_excess_paise);
        } else if (residual < 0n) {
          expect(withUnreconciled.excess_settlement_ids).toContain(c.settlement_id);
          expect(withUnreconciled.total_excess_paise).toBe(
            companionOnly.total_excess_paise - residual,
          );
          expect(withUnreconciled.total_shortfall_paise).toBe(companionOnly.total_shortfall_paise);
        } else {
          // A fully explained Settlement has nothing missing, so it is in neither.
          expect(withUnreconciled.shortfall_settlement_ids).not.toContain(c.settlement_id);
          expect(withUnreconciled.excess_settlement_ids).not.toContain(c.settlement_id);
          expect(withUnreconciled.total_shortfall_paise).toBe(companionOnly.total_shortfall_paise);
          expect(withUnreconciled.total_excess_paise).toBe(companionOnly.total_excess_paise);
        }
      }),
      PARAMS,
    );
  });

  it('excludes every unreconciled Settlement from a whole set aggregation and counts only the non-zero residuals', () => {
    fc.assert(
      fc.property(arbitrarySettlementReconCaseSet, (cases) => {
        const recons = cases.map((c) =>
          reconcileSettlement(c.settlement_id, c.received_paise, c.report),
        );
        const aggregate = totalShortfall(recons);

        // The aggregate is a function of the reconciled rows alone: dropping every
        // unreconciled row leaves both figures and both directional lists untouched
        // (Requirement 4.13).
        const reconciledOnly = totalShortfall(recons.filter((r) => r.status !== 'unreconciled'));
        expect(aggregate.total_shortfall_paise).toBe(reconciledOnly.total_shortfall_paise);
        expect(aggregate.total_excess_paise).toBe(reconciledOnly.total_excess_paise);
        expect(aggregate.residual_nonzero_count).toBe(reconciledOnly.residual_nonzero_count);
        expect(aggregate.shortfall_settlement_ids).toEqual(reconciledOnly.shortfall_settlement_ids);
        expect(aggregate.excess_settlement_ids).toEqual(reconciledOnly.excess_settlement_ids);

        // Both totals are magnitudes: neither direction is netted against the other, so
        // an unexplained excess can never cancel an unexplained shortfall.
        expect(aggregate.total_shortfall_paise >= 0n).toBe(true);
        expect(aggregate.total_excess_paise >= 0n).toBe(true);

        // Every identifier is accounted for exactly once, and no Settlement is
        // simultaneously a shortfall and an excess.
        const shortfallIds = new Set(aggregate.shortfall_settlement_ids);
        const excessIds = new Set(aggregate.excess_settlement_ids);
        const unreconciledIds = new Set(aggregate.unreconciled_settlement_ids);
        for (const id of shortfallIds) {
          expect(excessIds.has(id)).toBe(false);
          expect(unreconciledIds.has(id)).toBe(false);
        }
        for (const id of excessIds) {
          expect(unreconciledIds.has(id)).toBe(false);
        }
        expect(aggregate.residual_nonzero_count).toBe(shortfallIds.size + excessIds.size);
        expect(unreconciledIds.size).toBe(
          recons.filter((r) => r.status === 'unreconciled').length,
        );

        // The two figures are the sums of the intended residuals, reduced here
        // independently of `totalShortfall`.
        let shortfall = 0n;
        let excess = 0n;
        for (const c of cases) {
          if (c.report_shape !== 'present') continue;
          if (c.intended_residual_paise > 0n) shortfall = shortfall + c.intended_residual_paise;
          if (c.intended_residual_paise < 0n) excess = excess - c.intended_residual_paise;
        }
        expect(aggregate.total_shortfall_paise).toBe(shortfall);
        expect(aggregate.total_excess_paise).toBe(excess);
      }),
      PARAMS,
    );
  });

  it('draws all nine shape combinations often enough that none is vacuous', () => {
    // Not a distribution *hope*: the counts are asserted, so a generator change that
    // stopped producing (say) an empty report with a negative residual fails here
    // instead of quietly shrinking what the property above covers.
    const samples = fc.sample(arbitrarySettlementWithReconReport, {
      numRuns: NUM_RUNS,
      seed: SEED,
    });
    expect(samples).toHaveLength(NUM_RUNS);

    const counts = new Map<string, number>();
    for (const sample of samples) {
      const key = `${sample.residual_shape}/${sample.report_shape}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const residualShapes: readonly ResidualShape[] = ['zero', 'positive', 'negative'];
    const reportShapes: readonly ReportShape[] = ['present', 'absent', 'empty'];
    for (const residualShape of residualShapes) {
      for (const reportShape of reportShapes) {
        expect(counts.get(`${residualShape}/${reportShape}`) ?? 0).toBeGreaterThanOrEqual(20);
      }
    }

    // The SET-9281 shape — a Difference explained to the paisa — is the branch the demo
    // turns on, so it is weighted to be common rather than incidental.
    expect(counts.get('zero/present') ?? 0).toBeGreaterThanOrEqual(200);

    // A constructed zero really does come back explained, and a constructed non-zero
    // really does not: the two halves of the biconditional, over the sample.
    for (const sample of samples) {
      if (sample.report_shape !== 'present') continue;
      const recon = reconcileSettlement(sample.settlement_id, sample.received_paise, sample.report);
      expect(recon.status).toBe(
        sample.residual_shape === 'zero' ? 'difference_explained' : 'mismatch',
      );
    }
  });
});

/** Plain `bigint` reduction of one line group. Deliberately not `sum`. */
function naiveTotal(lines: readonly Paise[]): Paise {
  let total = 0n;
  for (const line of lines) {
    total = total + line;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Observed distribution over `fc.sample(..., { numRuns: 1000, seed: 20260214 })`
// ---------------------------------------------------------------------------
//
//   zero/present     281      positive/present  149      negative/present  151
//   zero/absent      116      positive/absent    40      negative/absent    46
//   zero/empty       123      positive/empty     39      negative/empty     55
//
// 581 reconciled, 419 unreconciled (202 absent + 217 empty), all nine combinations well
// clear of the asserted floor of 20. The SET-9281 shape — a Difference explained to the
// paisa — is 281 of the 1000 draws, and 6 draws land on a ±1 paisa residual, which is
// the tolerance-band boundary. Wall clock for the whole file: 0.6 s.
//
// ---------------------------------------------------------------------------
// Non-vacuity: recorded, not claimed
// ---------------------------------------------------------------------------
//
// Four mutations were applied to `src/agents/reconciliation/reconcile-settlement.ts`,
// one at a time, and reverted. Each failed with a shrunk counterexample, and each failed
// on a *different* clause, so the clauses are independently load bearing. In all four,
// shrinking reduced the data to `payments: [0n]` and empty line arrays while the shape
// discriminators kept their drawn values — which is the discriminators-last tuple order
// doing its job.
//
// **M1 — a tolerance band.** `status: residual > -100n && residual < 100n ?
// 'difference_explained' : 'mismatch'`.
//
//     Error: Property failed after 3 tests
//     { seed: 20260214, path: "2:0:0:0:0:0:0:0:0:0:0:0:0:0", endOnFailure: true }
//     Counterexample: [{"settlement_id":"setl_p3_000000",...,"received_paise":0n,
//       "report":{"payments":[0n],"refunds":[],"chargebacks":[],"adjustments":[],
//       "fees":[1n],"gst_on_fees":[0n]},"residual_shape":"negative",
//       "report_shape":"present","intended_residual_paise":-1n}]
//     Shrunk 13 time(s)
//     Caused by: AssertionError: expected true to be false
//       at p3-settlement-difference-decomposition.property.test.ts:294  (clause 2)
//
// A ₹0.01 fee line against a zero Payment: the minimal Settlement whose residual is one
// paisa. Clause 2 fails, and so does the sampled biconditional in the third test.
//
// **M2 — the adjustment sign.** `expectedAmount` ending in `subtract(lessChargebacks,
// adjustments)` instead of `add`.
//
//     Error: Property failed after 3 tests
//     Counterexample: [{...,"received_paise":-1n,"report":{"payments":[0n],...,
//       "adjustments":[-1n],"fees":[1n],"gst_on_fees":[0n]},...}]
//     Shrunk 41 time(s)
//     Caused by: AssertionError: expected 1n to be -1n
//       at p3-settlement-difference-decomposition.property.test.ts:271  (clause 3)
//
// Shrunk to a single ₹-0.01 adjustment, which is the smallest report that distinguishes
// `+` from `−` at all. This is the clause that only bites because `naiveExpected` is
// written here rather than imported: had it called `expectedAmount`, both sides would
// have flipped together and the mutation would have passed.
//
// **M3 — `0n` where `null` belongs.** The `unreconciled` branch returning `0n` for all
// five figures.
//
//     Error: Property failed after 1 tests
//     Counterexample: [{...,"report":{"payments":[],...},"residual_shape":"zero",
//       "report_shape":"empty","intended_residual_paise":0n}]
//     Shrunk 11 time(s)
//     Caused by: AssertionError: expected 0n to be null
//       at p3-settlement-difference-decomposition.property.test.ts:214  (clause 4)
//
// **M4 — a component that is not the one the residual came from.**
// `fee_component_paise: subtract(fee, 1n)`, standing in for a fee read off a Razorpay
// field instead of summed from the enumerated lines.
//
//     Error: Property failed after 3 tests
//     Counterexample: [{...,"report":{"payments":[0n],...,"fees":[1n],
//       "gst_on_fees":[0n]},"residual_shape":"negative","report_shape":"present"}]
//     Shrunk 13 time(s)
//     Caused by: AssertionError: expected 0n to be -1n
//       at p3-settlement-difference-decomposition.property.test.ts:280  (clause 1)
//
// M4 is the answer to "clause 1 is exact by construction, so what can it catch?". It
// cannot catch a defect in the subtraction — there is nothing there to get wrong. It
// catches the reported decomposition drifting apart from the arithmetic that produced
// it, which is exactly what a rounding step, an intermediate through `number`, or a
// component sourced from somewhere other than the enumerated lines would do.
