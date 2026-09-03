/**
 * Generators for property P3 (task 11.2): design.md's
 * `arbitrarySettlementWithReconReport` — a Settlement_Recon_Report, the received
 * amount that goes with it, and the two shape discriminators design.md names.
 *
 * ## What is *constructed* here, and why nothing is stumbled upon
 *
 * design.md's generator input says the report "includes cases where the residual is
 * constructed to be exactly zero (the SET-9281 shape), positive, and negative". A
 * generator that drew fee and GST lines freely would hit `residual === 0n` with
 * probability near zero over the paise range, and the zero case is the one the whole
 * demo rests on: SET-9281's `2320000n` Difference is fully explained by
 * `1966100n + 353900n`, so `difference_explained` is exactly the branch a free
 * generator would never reach.
 *
 * So the construction runs **backwards** from the figure under test:
 *
 * 1. Draw the four Expected Amount line groups. `expected` follows.
 * 2. Draw the **Difference** directly (`differenceTarget`) and set
 *    `received = expected − differenceTarget`, so the Difference is a controlled
 *    quantity rather than the residue of two large independent draws — including
 *    `0n` and ±1 paisa.
 * 3. Draw the residual the case is supposed to exhibit:
 *    `zero → 0n`, `positive → +delta`, `negative → −delta`, with `delta >= 1n` so
 *    the non-zero shapes are never accidentally zero.
 * 4. Solve for the fee and GST lines: `fee + gst = difference − residual`, split
 *    between the two components and then across 1..3 lines each.
 *
 * Step 4 is the only inversion, and it is exact in integer paise — it is a
 * subtraction and a split, never a rate and never a division that rounds. The
 * generator therefore knows the residual it *intended*, which is what lets P3
 * assert the biconditional in **both** directions: a `zero` case that comes back
 * `mismatch` fails, and a `positive`/`negative` case that comes back
 * `difference_explained` fails too.
 *
 * ## Shape discriminators come *after* the data arrays
 *
 * design.md: "shape discriminators placed after the data arrays so shrinking
 * reduces data first". {@link arbitrarySettlementWithReconReport} is
 * `fc.tuple(arbitraryReportData, residualShape, reportShape).map(build)`, and
 * fast-check shrinks a tuple component by component from the left, so a
 * counterexample has its payments, refunds, chargebacks, adjustments and Difference
 * shrunk toward `[]`/`0n` **before** either discriminator is touched. The minimised
 * counterexample therefore still says `negative` / `present`, which is the half of
 * it a reader needs; had the discriminators come first, shrinking would collapse
 * every failure onto whichever shape sorts smallest and the report would name the
 * wrong branch.
 *
 * The nine `(residualShape, reportShape)` combinations are drawn from **explicit
 * weighted branches**, not from `fc.constantFrom` alone, and P3 asserts the observed
 * counts over a fixed sample, so no shape can silently stop occurring.
 *
 * ## In the paise domain by construction, not by filtering
 *
 * `sum`, `add` and `subtract` range-check every operand, every running total and
 * every result, so a draw whose partial sum leaves ±99999999999999 raises
 * `PaiseRangeError` — which in a property test is indistinguishable from the defect
 * under test. There is no `fc.pre` and no `.filter` here: a rejected draw would bias
 * the distribution and quietly thin out the shapes that matter (the same discipline
 * as `evidence-chain-generators.ts`, which degrades a step to `select` rather than
 * discarding it). Instead every magnitude is bounded so the **widest reachable**
 * intermediate stays four orders of magnitude below the ceiling:
 *
 * | Quantity | Bound by construction | Ceiling |
 * |---|---|---|
 * | `Σpayments` | 6 × 1e9 = 6e9 | 1e14 |
 * | `Σrefunds`, `Σchargebacks` | 4 × 2e8 = 8e8 | |
 * | `\|Σadjustments\|` | 4 × 2e8 = 8e8 | |
 * | `\|expected\|` | ≤ 6.8e9 | |
 * | `\|differenceTarget\|` | ≤ 2e9 | |
 * | `\|received\|` | ≤ 8.8e9 | |
 * | `\|residual\|` | ≤ 1e9 | |
 * | `\|fee + gst\|` | ≤ 3e9 | |
 * | any one fee/GST line | ≤ 3e9 + 2 × 1e8 = 3.2e9 | |
 *
 * P3 asserts these bounds on the generated values rather than trusting this table,
 * so "in the domain by construction" is a checked claim.
 *
 * ## Signs
 *
 * `adjustments` is **signed** — positive credit, negative debit — which is
 * `ReconReportLines` as 11.1 defines it and as `test/fixtures/set-9281.ts` carries
 * it (`[-300000n, -190000n]`). The generator draws both signs directly rather than
 * going through `signedAdjustmentPaise`, because the summed representation is the
 * signed one and the projection belongs at the ingestion boundary.
 *
 * A fee or GST **line** can come out negative here, which a Razorpay fee never is.
 * That is a deliberate consequence of construction, not an oversight: a Difference
 * below zero (a Settlement that received more than expected) can only be explained
 * by `fee + gst` below zero, so demanding non-negative fee lines would delete the
 * `negative`-Difference half of the input space. Nothing in Requirement 4.3 or in
 * `reconcileSettlement` constrains the sign of a line — the component is `sum` of
 * whatever the report enumerates — so the arithmetic under test is total over
 * signed lines, and the ordinary all-non-negative shape is included rather than
 * excluded.
 */

import fc from 'fast-check';

import { PAISE_MAX, type Paise } from '@/calc/paise';
import type { ReconReportLines } from '@/agents/reconciliation/reconcile-settlement';

/** Which residual the case is constructed to exhibit. */
export type ResidualShape = 'zero' | 'positive' | 'negative';

/** Whether the Settlement_Recon_Report is there at all (Requirement 4.13). */
export type ReportShape = 'present' | 'absent' | 'empty';

/**
 * One generated Settlement, plus the two facts about it the generator knows and
 * `reconcileSettlement` has to rediscover.
 */
export interface SettlementReconCase {
  readonly settlement_id: string;
  /** A second, always-reconciled Settlement, so the aggregation has something in it. */
  readonly companion_settlement_id: string;
  readonly received_paise: Paise;
  /** `null` for `absent`; `payments: []` for `empty` (Requirement 4.13). */
  readonly report: ReconReportLines | null;
  /** The report as drawn, before {@link ReportShape} was applied. Never `null`. */
  readonly drawn_report: ReconReportLines;
  readonly residual_shape: ResidualShape;
  readonly report_shape: ReportShape;
  /**
   * The residual the fee and GST lines were solved for. Meaningful only when
   * `report_shape === 'present'`; an absent or empty report computes no residual at
   * all, and P3 asserts exactly that.
   */
  readonly intended_residual_paise: Paise;
  /** The companion's residual, drawn independently. May be any sign, including `0n`. */
  readonly companion_residual_paise: Paise;
  /** The companion's single Payment line. */
  readonly companion_payment_paise: Paise;
}

/* -------------------------------------------------------------------------- */
/* Bounds. Every one of these is what keeps the widest sum inside the domain.  */
/* -------------------------------------------------------------------------- */

/** ₹1,00,00,000 per Payment line. */
const PAYMENT_MAX: Paise = 1_000_000_000n;
/** ₹20,00,000 per Refund, chargeback or adjustment line. */
const MINOR_LINE_MAX: Paise = 200_000_000n;
/** ₹2,00,00,000 either way on the Difference. */
const DIFFERENCE_MAX: Paise = 2_000_000_000n;
/** ₹1,00,00,000 either way on a non-zero residual. */
const RESIDUAL_MAX: Paise = 1_000_000_000n;
/** ₹10,00,000 of jitter on a split line. */
const SPLIT_JITTER_MAX: Paise = 100_000_000n;

/**
 * The widest magnitude any generated line or figure can reach, from the table in the
 * module doc comment. Exported so P3 can assert the headroom rather than assume it.
 */
export const WIDEST_GENERATED_MAGNITUDE: Paise = 10_000_000_000n;

/** Asserted once at module load: the bounds above really do leave headroom. */
if (WIDEST_GENERATED_MAGNITUDE * 1000n > PAISE_MAX) {
  throw new Error(
    'settlement-recon-generators: the line bounds no longer leave three orders of ' +
      'magnitude of headroom below PAISE_MAX; a running total could reach the ceiling ' +
      'and a PaiseRangeError would masquerade as a P3 failure',
  );
}

/* -------------------------------------------------------------------------- */
/* The data draws                                                             */
/* -------------------------------------------------------------------------- */

const arbitraryPaymentLine = fc.bigInt({ min: 0n, max: PAYMENT_MAX });
const arbitraryMinorLine = fc.bigInt({ min: 0n, max: MINOR_LINE_MAX });
const arbitrarySignedAdjustmentLine = fc.bigInt({ min: -MINOR_LINE_MAX, max: MINOR_LINE_MAX });
const arbitrarySplitJitter = fc.bigInt({ min: -SPLIT_JITTER_MAX, max: SPLIT_JITTER_MAX });

/**
 * The Difference, drawn directly. `0n` and ±1 paisa are inside the range, and the
 * generator is biased toward small Differences because that is where the interesting
 * boundary is: a one-paisa Difference must be a `mismatch`, never a rounding-away
 * "explained" (Requirement 4.4, no tolerance band).
 */
const arbitraryDifferenceTarget = fc.oneof(
  { arbitrary: fc.bigInt({ min: -100_000n, max: 100_000n }), weight: 2 },
  { arbitrary: fc.bigInt({ min: -DIFFERENCE_MAX, max: DIFFERENCE_MAX }), weight: 3 },
);

/** A strictly non-zero magnitude, so `positive` and `negative` cannot collapse to `zero`. */
const arbitraryResidualDelta = fc.oneof(
  // One paisa and its neighbourhood: the tolerance-band boundary.
  { arbitrary: fc.bigInt({ min: 1n, max: 100n }), weight: 2 },
  { arbitrary: fc.bigInt({ min: 1n, max: RESIDUAL_MAX }), weight: 3 },
);

/** Everything drawn before either discriminator, in one tuple so it shrinks first. */
interface ReportData {
  readonly payments: readonly Paise[];
  readonly refunds: readonly Paise[];
  readonly chargebacks: readonly Paise[];
  readonly adjustments: readonly Paise[];
  readonly differenceTarget: Paise;
  readonly residualDelta: Paise;
  /** How much of `fee + gst` lands on the GST component, in hundredths. */
  readonly gstShareHundredths: bigint;
  /** Extra fee lines; the first line absorbs the remainder, so the total is exact. */
  readonly feeJitter: readonly Paise[];
  readonly gstJitter: readonly Paise[];
  readonly idIndex: number;
  readonly companionResidual: Paise;
  readonly companionPayment: Paise;
}

const arbitraryReportData: fc.Arbitrary<ReportData> = fc
  .tuple(
    fc.array(arbitraryPaymentLine, { minLength: 1, maxLength: 6 }),
    fc.array(arbitraryMinorLine, { minLength: 0, maxLength: 4 }),
    fc.array(arbitraryMinorLine, { minLength: 0, maxLength: 4 }),
    fc.array(arbitrarySignedAdjustmentLine, { minLength: 0, maxLength: 4 }),
    arbitraryDifferenceTarget,
    arbitraryResidualDelta,
    fc.bigInt({ min: 0n, max: 100n }),
    fc.array(arbitrarySplitJitter, { minLength: 0, maxLength: 2 }),
    fc.array(arbitrarySplitJitter, { minLength: 0, maxLength: 2 }),
    fc.integer({ min: 0, max: 999_999 }),
    fc.bigInt({ min: -RESIDUAL_MAX, max: RESIDUAL_MAX }),
    arbitraryPaymentLine,
  )
  .map(
    ([
      payments,
      refunds,
      chargebacks,
      adjustments,
      differenceTarget,
      residualDelta,
      gstShareHundredths,
      feeJitter,
      gstJitter,
      idIndex,
      companionResidual,
      companionPayment,
    ]): ReportData => ({
      payments,
      refunds,
      chargebacks,
      adjustments,
      differenceTarget,
      residualDelta,
      gstShareHundredths,
      feeJitter,
      gstJitter,
      idIndex,
      companionResidual,
      companionPayment,
    }),
  );

/* -------------------------------------------------------------------------- */
/* The discriminators, drawn last                                             */
/* -------------------------------------------------------------------------- */

/**
 * `zero` is weighted heaviest on purpose: it is the SET-9281 shape and the branch
 * the demo turns on, so it has to be common rather than incidental.
 */
const arbitraryResidualShape: fc.Arbitrary<ResidualShape> = fc.oneof(
  { arbitrary: fc.constant<ResidualShape>('zero'), weight: 2 },
  { arbitrary: fc.constant<ResidualShape>('positive'), weight: 1 },
  { arbitrary: fc.constant<ResidualShape>('negative'), weight: 1 },
);

/** `present` dominates, but both halves of Requirement 4.13 stay frequent. */
const arbitraryReportShape: fc.Arbitrary<ReportShape> = fc.oneof(
  { arbitrary: fc.constant<ReportShape>('present'), weight: 3 },
  { arbitrary: fc.constant<ReportShape>('absent'), weight: 1 },
  { arbitrary: fc.constant<ReportShape>('empty'), weight: 1 },
);

/* -------------------------------------------------------------------------- */
/* Construction                                                               */
/* -------------------------------------------------------------------------- */

/** Plain `bigint` reduction. Deliberately not the Calculation Service. */
function plainSum(lines: readonly Paise[]): Paise {
  let total = 0n;
  for (const line of lines) {
    total = total + line;
  }
  return total;
}

/**
 * Split `total` across `1 + jitter.length` lines whose sum is **exactly** `total`:
 * the jitter lines are taken as drawn and the leading line absorbs the remainder.
 * Exact by construction in integer paise — no proportional division, so nothing
 * rounds and no remainder is dropped.
 */
function splitExactly(total: Paise, jitter: readonly Paise[]): readonly Paise[] {
  const remainder = total - plainSum(jitter);
  return [remainder, ...jitter];
}

/**
 * `fee + gst = target`, divided between the two components. The share is truncating
 * integer arithmetic, and the fee component takes whatever the GST share left, so
 * the two always re-add to `target` regardless of how the truncation fell.
 */
function splitComponents(
  target: Paise,
  gstShareHundredths: bigint,
): { readonly feeTotal: Paise; readonly gstTotal: Paise } {
  const gstTotal = (target * gstShareHundredths) / 100n;
  return { feeTotal: target - gstTotal, gstTotal };
}

function buildCase(
  data: ReportData,
  residualShape: ResidualShape,
  reportShape: ReportShape,
): SettlementReconCase {
  // Steps 1..7, in plain bigint. `expected` is what the drawn lines imply.
  const expected =
    plainSum(data.payments) -
    plainSum(data.refunds) -
    plainSum(data.chargebacks) +
    plainSum(data.adjustments);

  // Step 8, run backwards: the Difference is the drawn quantity and the received
  // amount is solved for, so `difference === differenceTarget` exactly.
  const received = expected - data.differenceTarget;

  // The residual the case is built to exhibit.
  const intendedResidual: Paise =
    residualShape === 'zero'
      ? 0n
      : residualShape === 'positive'
        ? data.residualDelta
        : -data.residualDelta;

  // Steps 9..12, run backwards: fee + gst = difference − residual.
  const componentTarget = data.differenceTarget - intendedResidual;
  const { feeTotal, gstTotal } = splitComponents(componentTarget, data.gstShareHundredths);

  const drawnReport: ReconReportLines = {
    payments: data.payments,
    refunds: data.refunds,
    chargebacks: data.chargebacks,
    adjustments: data.adjustments,
    fees: splitExactly(feeTotal, data.feeJitter),
    gst_on_fees: splitExactly(gstTotal, data.gstJitter),
  };

  const report: ReconReportLines | null =
    reportShape === 'absent'
      ? null
      : reportShape === 'empty'
        ? { ...drawnReport, payments: [] }
        : drawnReport;

  const suffix = String(data.idIndex).padStart(6, '0');
  return {
    settlement_id: `setl_p3_${suffix}`,
    // Distinct from `settlement_id` for every `idIndex`, so the aggregation's
    // exclusion clause is asserted against two identifiers that cannot collide.
    companion_settlement_id: `setl_p3_companion_${suffix}`,
    received_paise: received,
    report,
    drawn_report: drawnReport,
    residual_shape: residualShape,
    report_shape: reportShape,
    intended_residual_paise: intendedResidual,
    companion_residual_paise: data.companionResidual,
    companion_payment_paise: data.companionPayment,
  };
}

/**
 * design.md's `arbitrarySettlementWithReconReport`.
 *
 * The tuple order is the point: the data arrives first and the two shape
 * discriminators last, so fast-check shrinks the payments, refunds, chargebacks,
 * adjustments and Difference toward nothing before it tries to change the shape a
 * counterexample is reported under.
 */
export const arbitrarySettlementWithReconReport: fc.Arbitrary<SettlementReconCase> = fc
  .tuple(arbitraryReportData, arbitraryResidualShape, arbitraryReportShape)
  .map(([data, residualShape, reportShape]) => buildCase(data, residualShape, reportShape));

/**
 * Re-label a drawn set so every Settlement identifier is distinct.
 *
 * Two cases can draw the same `idIndex`, and `totalShortfall` is keyed by identifier:
 * one `setl_p3_000007` with a positive residual and another with a negative one would
 * legitimately put the same string in both the shortfall and the excess list. That is
 * correct behaviour over a malformed input, not a defect, so the ambiguity is removed
 * at the generator rather than excused at the assertion. Position-based, so it stays
 * a pure function of the draw.
 */
function withDistinctIdentifiers(
  cases: readonly SettlementReconCase[],
): readonly SettlementReconCase[] {
  return cases.map((c, index) => ({
    ...c,
    settlement_id: `${c.settlement_id}_${index}`,
    companion_settlement_id: `${c.companion_settlement_id}_${index}`,
  }));
}

/**
 * A set of Settlements with distinct identifiers, for the aggregation clause:
 * Requirement 4.13's exclusion is a statement about a *collection*, so it needs more
 * than one row to bite.
 */
export const arbitrarySettlementReconCaseSet: fc.Arbitrary<readonly SettlementReconCase[]> = fc
  .array(arbitrarySettlementWithReconReport, { minLength: 1, maxLength: 8 })
  .map(withDistinctIdentifiers);
