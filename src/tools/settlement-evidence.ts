/**
 * The Evidence_Chains a settlement Financial_Tool composes: design.md's twelve
 * steps per Settlement, and the aggregate chain behind a total figure (task 12.1).
 * Requirements 4.2, 4.3, 4.13, 12.2, 12.8.
 *
 * **This module is deliberately shared with task 12.2.**
 * `get_settlement_difference_breakdown` returns the same five figures per row as
 * `get_settlement_reconciliation` does and needs the same per-row chain;
 * {@link reconciledSettlementChain} is that chain, and 12.2 imports it rather than
 * composing a second twelve-step sequence that could drift from this one by a step.
 * `src/tools/settlement-scope.ts` is the other half of the shared machinery — the
 * scope, the examined counts and the read seam.
 *
 * Task 12.2 added one thing here rather than keeping a private copy of it:
 * {@link totalAbsoluteDifferenceChain}, the aggregate chain behind Requirement 4.6's
 * remainder total. It is {@link totalShortfallChain}'s sibling — same inlined 1..8
 * prefixes, same terminal `sum` — differing only in that it sums **absolute**
 * Differences. Both live here so the two aggregate figures in the settlement path
 * cannot drift apart in how they ground themselves.
 *
 * ## The twelve steps are design.md's, in design.md's order
 *
 * `test/fixtures/set-9281.ts` fixes the sequence, and
 * `test/worked-example/set-9281.worked-example.test.ts`,
 * `test/db/evidence-chain.test.ts` and `test/db/settlement-reconciliation.test.ts`
 * all assert `produced_by = 'get_settlement_reconciliation'` against it:
 *
 * | Step | Operation | Result |
 * |---|---|---|
 * | 1 | `sum` of every Payment line's `amount` | Σ payments |
 * | 2 | `sum` of every Refund line's `amount` | Σ refunds |
 * | 3 | `subtract(1, 2)` | payments − refunds |
 * | 4 | `sum` of every chargeback line's `amount` | Σ chargebacks |
 * | 5 | `subtract(3, 4)` | − chargebacks |
 * | 6 | `sum` of every adjustment line's `signed_amount` | signed Σ adjustments |
 * | 7 | `add(5, 6)` | **Expected Amount** (Requirement 4.2) |
 * | 8 | `subtract(7, settlement.amount)` | **Difference** (Requirement 4.2) |
 * | 9 | `sum` of every Payment line's `fee` | Razorpay_Fee component |
 * | 10 | `sum` of every Payment line's `tax` | GST_On_Fee component |
 * | 11 | `subtract(8, 9)` | Difference − fee |
 * | 12 | `subtract(11, 10)` | **residual** — the chain's `figure_paise` |
 *
 * Step 7 is `add`, not `subtract`, because step 6 sums a **signed** value. The sign
 * is a field read (`signed_amount`, the ingestion-boundary projection
 * `credit − debit`), not a step: design.md's sequence has no `negate`, and inventing
 * one would make a replay reproduce a different figure than the tool reported, which
 * is exactly what Requirement 12.8 forbids.
 *
 * The chain's figure is the **residual**, the terminal step's result, because
 * `composeEvidenceChain` requires the terminal result to equal `figure_paise` and
 * `evidence_chains` stores one figure per chain. The Expected Amount and the
 * Difference are intermediates of the same chain, at
 * {@link EXPECTED_AMOUNT_STEP_INDEX} and {@link DIFFERENCE_STEP_INDEX}. A drill-down
 * that wants either reads that step's `result_paise`; there is no second chain and
 * this module does not invent one.
 *
 * ## Every figure the tool returns is covered, including `received_paise`
 *
 * Requirement 12.2 applies to *every* monetary figure a tool returns, so the
 * `unreconciled` case is not exempt: its five computed figures are `null`
 * (Requirement 4.13) but `received_paise` is real, read from the Settlement object.
 * {@link unreconciledSettlementChain} grounds exactly that — one `sum` step over the
 * Settlement's `amount` — so no row ever carries a figure with no chain, and the
 * envelope chain is left grounding the one top-level figure and nothing else.
 *
 * ## An empty line list is a `literal '0'` operand, not a zero-operand step
 *
 * `composeEvidenceChain` rejects a step with no operands, and a Settlement whose
 * report enumerates no Refunds still needs step 2. Such a step therefore states one
 * `{ kind: 'literal', value: '0' }` operand and result `0n`. The literal is a
 * **string** because `operands` is `JSONB` and a JSON numeric literal parses back
 * through an IEEE-754 double. A replay reads `'0'` and reproduces `0n` exactly, so
 * the shape is honest rather than a filler: the report genuinely enumerated nothing,
 * and the step says so.
 *
 * ## The aggregate chain replays; it does not assert
 *
 * {@link totalShortfallChain} could have stated one `literal` operand per
 * contributing Difference and summed them. It does not, because a chain of literals
 * is not grounded in anything a drill-down can open: Requirement 12.2 wants the
 * contributing Source_Record identifiers *and* the operands that used them. So the
 * aggregate chain inlines each contributing Settlement's steps 1..8 — the prefix
 * that produces its Difference — and its terminal step sums those step results.
 * Replaying it reproduces the total from the Payment, Refund, chargeback, adjustment
 * and Settlement records themselves.
 *
 * The cost is `8k + 1` steps for `k` contributors, and `evidence_chain_steps.step_index`
 * is `SMALLINT`, so {@link MAX_TOTAL_SHORTFALL_CONTRIBUTORS} contributors is the
 * hard ceiling. Beyond it the chain cannot be stored and the tool must say so rather
 * than truncate a figure's evidence.
 *
 * ## `|x|` is a `negate` step, because the operation enum has no `abs`
 *
 * Requirement 4.6's remainder total is a sum of **absolute** Differences, and
 * `evidence_operation` (`20260101000006_evidence_chains.sql`, transcribed as
 * `EVIDENCE_OPERATIONS` in `@/evidence/chain-builder`) declares nine labels —
 * `sum`, `subtract`, `add`, `multiply`, `divide`, `round_half_up`, `negate`,
 * `select`, `compare` — and **`abs` is not one of them**. Inventing one would need a
 * migration and would leave the task 9.2 replay interpreter partial, which is
 * exactly the failure the migration's own FINDING warns about.
 *
 * `negate` composes it instead, and does so exactly: for a contributor whose
 * Difference is **negative**, {@link totalAbsoluteDifferenceChain} states one extra
 * `negate` step over that contributor's step 8, whose result is `|Difference|`; for a
 * positive Difference the terminal sum reads step 8 directly, because `|x| = x`
 * there and a step asserting that would say nothing. So the chain shape depends on
 * the sign of each contributor's Difference, which is honest — the arithmetic
 * genuinely differs — and a replay reproduces the total in exact paise either way
 * (Requirement 12.8). The cost is at most `9k + 1` steps for `k` contributors, hence
 * a ceiling of {@link MAX_ABSOLUTE_DIFFERENCE_CONTRIBUTORS} rather than
 * {@link MAX_TOTAL_SHORTFALL_CONTRIBUTORS}.
 *
 * ## Money
 *
 * Every intermediate is computed through the Calculation Service (`sum`, `add`,
 * `subtract`), which range-checks every operand and every running total, so a report
 * whose partial sum leaves the paise domain raises rather than flowing onward
 * (Requirement 15.1, 15.8). There is no division, no rate and no rounding anywhere
 * in this path.
 *
 * The recomputation is then **checked against the figures the caller reported**:
 * {@link reconciledSettlementChain} throws if step 7 disagrees with
 * `expected_paise`, step 8 with `difference_paise`, step 9 with
 * `fee_component_paise`, step 10 with `gst_component_paise` or step 12 with
 * `residual_paise`. A chain that replays to a different value than the figure beside
 * it is the one failure Requirement 12.8 exists to prevent, and it is cheaper to
 * refuse than to discover in a drill-down.
 */

import { add, type Paise, subtract, sum } from '@/calc/calculation-service';
import type { SettlementRecon } from '@/agents/reconciliation/reconcile-settlement';
import {
  type EvidenceChainInput,
  type EvidenceOperand,
  type EvidenceSourceCitation,
  type EvidenceStep,
  MAX_STEP_INDEX,
} from '@/evidence/chain-builder';
import type { SourceRef } from '@/ledger/posting-rules';

import type { ScopedSettlement } from './settlement-scope';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** Thrown when a chain cannot be composed as stated, before anything is written. */
export class SettlementEvidenceError extends Error {
  override readonly name = 'SettlementEvidenceError';
}

/* -------------------------------------------------------------------------- */
/* The step layout                                                            */
/* -------------------------------------------------------------------------- */

/** design.md's twelve, for one Settlement. */
export const SETTLEMENT_CHAIN_STEP_COUNT = 12;

/** Steps 1..8: the prefix that produces the Difference. */
export const DIFFERENCE_PREFIX_STEP_COUNT = 8;

/** The step whose `result_paise` is the Expected Amount (Requirement 4.2). */
export const EXPECTED_AMOUNT_STEP_INDEX = 7;

/** The step whose `result_paise` is the Difference (Requirement 4.2). */
export const DIFFERENCE_STEP_INDEX = 8;

/** The terminal step, whose `result_paise` is the residual and the chain's figure. */
export const RESIDUAL_STEP_INDEX = 12;

/**
 * The field names the chain cites. `signed_amount` is the ingestion-boundary
 * projection `credit − debit`; `tax` is Razorpay's name for GST on the fee.
 */
export const SETTLEMENT_FIELD = {
  amount: 'amount',
  fee: 'fee',
  tax: 'tax',
  signed_amount: 'signed_amount',
} as const;

/**
 * How many contributing Settlements one aggregate chain can carry.
 *
 * `8k + 1 <= MAX_STEP_INDEX`, because `evidence_chain_steps.step_index` is
 * `SMALLINT` and the schema states no upper CHECK (`MAX_STEP_INDEX` in
 * `@/evidence/chain-builder` is where that bound lives).
 */
export const MAX_TOTAL_SHORTFALL_CONTRIBUTORS = Math.floor(
  (MAX_STEP_INDEX - 1) / DIFFERENCE_PREFIX_STEP_COUNT,
);

/**
 * Steps one contributor costs an **absolute**-Difference aggregate: the 1..8 prefix
 * plus at most one `negate`, which is how `|x|` is expressed with no `abs` label in
 * the operation enum. See the module doc comment.
 */
export const ABSOLUTE_DIFFERENCE_STEP_COUNT = DIFFERENCE_PREFIX_STEP_COUNT + 1;

/**
 * How many contributing Settlements one absolute-Difference aggregate chain can
 * carry: `9k + 1 <= MAX_STEP_INDEX`.
 *
 * Lower than {@link MAX_TOTAL_SHORTFALL_CONTRIBUTORS} because each contributor may
 * need the extra `negate`. The bound is computed for the worst case — every
 * Difference negative — rather than per call, so the answer does not depend on the
 * signs of the data.
 */
export const MAX_ABSOLUTE_DIFFERENCE_CONTRIBUTORS = Math.floor(
  (MAX_STEP_INDEX - 1) / ABSOLUTE_DIFFERENCE_STEP_COUNT,
);

/* -------------------------------------------------------------------------- */
/* Operand and citation helpers                                               */
/* -------------------------------------------------------------------------- */

const lineRef = (lineId: string): SourceRef => ({ type: 'settlement_recon_report', id: lineId });

const settlementRef = (settlementId: string): SourceRef => ({
  type: 'settlement',
  id: settlementId,
});

const sourceOperand = (ref: SourceRef, field: string): EvidenceOperand => ({
  kind: 'source',
  ref,
  field,
});

const stepOperand = (index: number): EvidenceOperand => ({ kind: 'step', index });

/** The zero a step over an empty line list sums. A string, because `operands` is JSONB. */
const ZERO_LITERAL: EvidenceOperand = { kind: 'literal', value: '0' };

/** `operands`, or one `literal '0'` where the report enumerated nothing. */
function operandsOrZero(operands: readonly EvidenceOperand[]): readonly EvidenceOperand[] {
  return operands.length === 0 ? [ZERO_LITERAL] : operands;
}

function citation(ref: SourceRef, field: string, recordUpdatedAt: string): EvidenceSourceCitation {
  return { ref, field, record_updated_at: recordUpdatedAt };
}

/* -------------------------------------------------------------------------- */
/* One Settlement's steps and citations                                       */
/* -------------------------------------------------------------------------- */

/** The step results, so a caller can check them against the reported figures. */
interface SettlementStepResults {
  readonly expected_paise: Paise;
  readonly difference_paise: Paise;
  readonly fee_component_paise: Paise;
  readonly gst_component_paise: Paise;
  readonly residual_paise: Paise;
}

/** Steps and citations for one Settlement, plus what those steps produced. */
export interface SettlementStepBlock {
  readonly steps: readonly EvidenceStep[];
  readonly citations: readonly EvidenceSourceCitation[];
  /** Absolute index of the step whose result is the Difference. */
  readonly difference_step_index: number;
  readonly results: SettlementStepResults;
}

/**
 * design.md's twelve steps for one Settlement, offset so the block can be inlined
 * into a longer chain.
 *
 * @param settlement the Settlement and every line its report enumerates.
 * @param baseIndex how many steps precede this block. `0` for a chain of its own.
 * @param through `12` for the whole sequence, or {@link DIFFERENCE_PREFIX_STEP_COUNT}
 * for the 1..8 prefix that produces the Difference — which is what
 * {@link totalShortfallChain} inlines.
 *
 * @throws {SettlementEvidenceError} for a Settlement whose report enumerates no
 * Payment; that is Requirement 4.13's `unreconciled` case and has no Expected Amount
 * to compute, so it takes {@link unreconciledSettlementChain} instead.
 * @throws {PaiseRangeError} when a line, a running total or an intermediate leaves
 * the paise range.
 */
export function settlementStepBlock(
  settlement: ScopedSettlement,
  baseIndex = 0,
  through: typeof SETTLEMENT_CHAIN_STEP_COUNT | typeof DIFFERENCE_PREFIX_STEP_COUNT =
    SETTLEMENT_CHAIN_STEP_COUNT,
): SettlementStepBlock {
  if (settlement.payments.length === 0) {
    throw new SettlementEvidenceError(
      `${settlement.settlement_id} enumerates no Payment, so there is no Expected Amount and no ` +
        `Difference to state steps for (Requirement 4.13). Compose an unreconciled chain instead`,
    );
  }
  if (!Number.isSafeInteger(baseIndex) || baseIndex < 0) {
    throw new SettlementEvidenceError(`baseIndex must be a non-negative ordinal, got ${String(baseIndex)}`);
  }

  const at = (offset: number): number => baseIndex + offset;

  /* Operands, in the order design.md's steps read them. */
  const paymentAmounts = settlement.payments.map((line) =>
    sourceOperand(lineRef(line.line_id), SETTLEMENT_FIELD.amount),
  );
  const refundAmounts = settlement.refunds.map((line) =>
    sourceOperand(lineRef(line.line_id), SETTLEMENT_FIELD.amount),
  );
  const chargebackAmounts = settlement.chargebacks.map((line) =>
    sourceOperand(lineRef(line.line_id), SETTLEMENT_FIELD.amount),
  );
  const adjustmentAmounts = settlement.adjustments.map((line) =>
    sourceOperand(lineRef(line.line_id), SETTLEMENT_FIELD.signed_amount),
  );
  const paymentFees = settlement.payments.map((line) =>
    sourceOperand(lineRef(line.line_id), SETTLEMENT_FIELD.fee),
  );
  const paymentGst = settlement.payments.map((line) =>
    sourceOperand(lineRef(line.line_id), SETTLEMENT_FIELD.tax),
  );

  /* Every figure through the Calculation Service, which range-checks each one. */
  const sumPayments = sum(settlement.payments.map((line) => line.amount_paise));
  const sumRefunds = sum(settlement.refunds.map((line) => line.amount_paise));
  const lessRefunds = subtract(sumPayments, sumRefunds);
  const sumChargebacks = sum(settlement.chargebacks.map((line) => line.amount_paise));
  const lessChargebacks = subtract(lessRefunds, sumChargebacks);
  const sumAdjustments = sum(settlement.adjustments.map((line) => line.signed_amount_paise));
  const expected = add(lessChargebacks, sumAdjustments);
  const difference = subtract(expected, settlement.received_paise);
  const fee = sum(settlement.payments.map((line) => line.fee_paise));
  const gst = sum(settlement.payments.map((line) => line.gst_on_fee_paise));
  const differenceLessFee = subtract(difference, fee);
  const residual = subtract(differenceLessFee, gst);

  const prefix: readonly EvidenceStep[] = [
    {
      index: at(1),
      operation: 'sum',
      operands: paymentAmounts,
      result_paise: sumPayments,
      note: 'Σ Payment amounts enumerated in the Settlement_Recon_Report (Requirement 4.2)',
    },
    {
      index: at(2),
      operation: 'sum',
      operands: operandsOrZero(refundAmounts),
      result_paise: sumRefunds,
      note: 'Σ Refund amounts enumerated in the report',
    },
    {
      index: at(3),
      operation: 'subtract',
      operands: [stepOperand(at(1)), stepOperand(at(2))],
      result_paise: lessRefunds,
      note: 'payments − refunds',
    },
    {
      index: at(4),
      operation: 'sum',
      operands: operandsOrZero(chargebackAmounts),
      result_paise: sumChargebacks,
      note: 'Σ chargeback amounts enumerated in the report',
    },
    {
      index: at(5),
      operation: 'subtract',
      operands: [stepOperand(at(3)), stepOperand(at(4))],
      result_paise: lessChargebacks,
      note: '− chargebacks',
    },
    {
      index: at(6),
      operation: 'sum',
      operands: operandsOrZero(adjustmentAmounts),
      result_paise: sumAdjustments,
      note: 'signed Σ adjustments: the operand field is the projection credit − debit',
    },
    {
      index: at(7),
      operation: 'add',
      operands: [stepOperand(at(5)), stepOperand(at(6))],
      result_paise: expected,
      note: 'Expected Amount (Requirement 4.2). `add`, because the adjustment sum is signed',
    },
    {
      index: at(8),
      operation: 'subtract',
      operands: [stepOperand(at(7)), sourceOperand(settlementRef(settlement.settlement_id), SETTLEMENT_FIELD.amount)],
      result_paise: difference,
      note: 'Difference = Expected Amount − received amount (Requirement 4.2)',
    },
  ];

  const tail: readonly EvidenceStep[] = [
    {
      index: at(9),
      operation: 'sum',
      operands: paymentFees,
      result_paise: fee,
      note: 'Razorpay_Fee component: Σ fee lines in the report (Requirement 4.3)',
    },
    {
      index: at(10),
      operation: 'sum',
      operands: paymentGst,
      result_paise: gst,
      note: 'GST_On_Fee component: Σ GST-on-fee lines in the report (Requirement 4.3)',
    },
    {
      index: at(11),
      operation: 'subtract',
      operands: [stepOperand(at(8)), stepOperand(at(9))],
      result_paise: differenceLessFee,
      note: 'Difference − Razorpay_Fee component',
    },
    {
      index: at(12),
      operation: 'subtract',
      operands: [stepOperand(at(11)), stepOperand(at(10))],
      result_paise: residual,
      note: 'unexplained residual = Difference − fee − GST (Requirement 4.3). The chain figure',
    },
  ];

  const wholeSequence = through === SETTLEMENT_CHAIN_STEP_COUNT;

  /*
   * First-citation order, which is the order `EvidenceChain.sources` reports: the
   * Payment lines, the Refund lines, the chargeback lines, the adjustment lines,
   * then the Settlement object. The same order `test/fixtures/set-9281.ts` states,
   * so the fixture's `sources` list and this one agree identifier for identifier.
   */
  const citations: EvidenceSourceCitation[] = [];
  for (const line of settlement.payments) {
    citations.push(citation(lineRef(line.line_id), SETTLEMENT_FIELD.amount, line.record_updated_at));
    if (wholeSequence) {
      // Steps 9 and 10 read these; the 1..8 prefix does not, and citing a field no
      // operand reads would overstate what the chain contributed to its figure.
      citations.push(citation(lineRef(line.line_id), SETTLEMENT_FIELD.fee, line.record_updated_at));
      citations.push(citation(lineRef(line.line_id), SETTLEMENT_FIELD.tax, line.record_updated_at));
    }
  }
  for (const line of [...settlement.refunds, ...settlement.chargebacks]) {
    citations.push(citation(lineRef(line.line_id), SETTLEMENT_FIELD.amount, line.record_updated_at));
  }
  for (const line of settlement.adjustments) {
    citations.push(
      citation(lineRef(line.line_id), SETTLEMENT_FIELD.signed_amount, line.record_updated_at),
    );
  }
  citations.push(
    citation(
      settlementRef(settlement.settlement_id),
      SETTLEMENT_FIELD.amount,
      settlement.record_updated_at,
    ),
  );

  return {
    steps: wholeSequence ? [...prefix, ...tail] : prefix,
    citations,
    difference_step_index: at(DIFFERENCE_STEP_INDEX),
    results: {
      expected_paise: expected,
      difference_paise: difference,
      fee_component_paise: fee,
      gst_component_paise: gst,
      residual_paise: residual,
    },
  };
}

/**
 * The twelve-step chain for one reconciled Settlement, with the residual as its
 * figure.
 *
 * The steps are recomputed from the lines and then checked against `recon`, so a
 * chain that would replay to a different value than the figure beside it is refused
 * before anything is written (see the module doc comment on money).
 *
 * @throws {SettlementEvidenceError} for an `unreconciled` Settlement, and for any
 * disagreement between the recomputed steps and the reported figures.
 */
export function reconciledSettlementChain(
  producedBy: string,
  settlement: ScopedSettlement,
  recon: SettlementRecon,
): EvidenceChainInput {
  if (recon.settlement_id !== settlement.settlement_id) {
    throw new SettlementEvidenceError(
      `the reconciliation of ${recon.settlement_id} was paired with Settlement ` +
        `${settlement.settlement_id}`,
    );
  }
  const block = settlementStepBlock(settlement, 0, SETTLEMENT_CHAIN_STEP_COUNT);
  const stated: readonly (readonly [string, Paise | null, Paise])[] = [
    ['expected_paise', recon.expected_paise, block.results.expected_paise],
    ['difference_paise', recon.difference_paise, block.results.difference_paise],
    ['fee_component_paise', recon.fee_component_paise, block.results.fee_component_paise],
    ['gst_component_paise', recon.gst_component_paise, block.results.gst_component_paise],
    ['residual_paise', recon.residual_paise, block.results.residual_paise],
  ];
  for (const [name, reported, replayed] of stated) {
    if (reported !== replayed) {
      throw new SettlementEvidenceError(
        `${settlement.settlement_id} reports ${name} ${String(reported)} but its Evidence_Chain ` +
          `steps produce ${replayed}; a figure whose chain replays to a different value is what ` +
          `Requirement 12.8 exists to prevent, so nothing is written`,
      );
    }
  }
  return {
    produced_by: producedBy,
    figure_paise: block.results.residual_paise,
    steps: block.steps,
    sources: block.citations,
  };
}

/**
 * The one-step chain for an `unreconciled` Settlement, whose figure is the received
 * amount.
 *
 * Requirement 4.13 leaves all five computed figures `null`, but `received_paise` is
 * real — it is read from the Settlement object, not from the report — and
 * Requirement 12.2 grounds every monetary figure a tool returns. So the row still
 * carries a chain, and it states exactly what was read: one `sum` over the
 * Settlement's own `amount`.
 */
export function unreconciledSettlementChain(
  producedBy: string,
  settlement: ScopedSettlement,
): EvidenceChainInput {
  const ref = settlementRef(settlement.settlement_id);
  return {
    produced_by: producedBy,
    figure_paise: settlement.received_paise,
    steps: [
      {
        index: 1,
        operation: 'sum',
        operands: [sourceOperand(ref, SETTLEMENT_FIELD.amount)],
        result_paise: settlement.received_paise,
        note:
          'received amount, read from the Settlement object. The Settlement_Recon_Report is ' +
          'absent or enumerates 0 Payments, so no Expected Amount and no Difference are ' +
          'computed (Requirement 4.13)',
      },
    ],
    sources: [citation(ref, SETTLEMENT_FIELD.amount, settlement.record_updated_at)],
  };
}

/* -------------------------------------------------------------------------- */
/* The aggregate chain                                                        */
/* -------------------------------------------------------------------------- */

/** One in-scope Settlement paired with what reconciling it produced. */
export interface ReconciledPair {
  readonly settlement: ScopedSettlement;
  readonly recon: SettlementRecon;
}

/**
 * Does this Settlement contribute to the total shortfall figure?
 *
 * A shortfall is a **positive Difference**: Expected Amount above received amount,
 * which is money that did not arrive. An `unreconciled` Settlement has no Difference
 * at all and is excluded (Requirement 4.13). A negative Difference — more received
 * than expected — is an excess and is **not** netted against a shortfall; see the
 * decision recorded on `get_settlement_reconciliation`.
 */
export function contributesToTotalShortfall(pair: ReconciledPair): boolean {
  const difference = pair.recon.difference_paise;
  return difference !== null && difference > 0n;
}

/**
 * Does this Settlement get a Requirement 4.6 breakdown row?
 *
 * "One breakdown row per in-scope Settlement whose Difference is not equal to 0
 * paise" — so a Difference of exactly `0n` is not a row, and neither is an
 * `unreconciled` Settlement, which has no Difference at all (Requirement 4.13). Both
 * directions count: an excess is as much a non-zero Difference as a shortfall, and
 * Requirement 4.6 orders on the **absolute** value precisely because it does not
 * prefer one.
 *
 * Note the asymmetry with `get_settlement_reconciliation`, which reports every
 * in-scope Settlement. This predicate is why.
 */
export function hasNonZeroDifference(pair: ReconciledPair): boolean {
  const difference = pair.recon.difference_paise;
  return difference !== null && difference !== 0n;
}

/**
 * `|Difference|` in integer paise, or `null` for an `unreconciled` Settlement that
 * has no Difference.
 *
 * Through the Calculation Service, which range-checks both operands and the result,
 * and by the same `subtract(0n, x)` route `residualImpactPaise` takes in task 11.1 —
 * so there is one spelling of "the magnitude of a signed paise value" in this
 * codebase rather than two.
 */
export function absoluteDifferencePaise(pair: ReconciledPair): Paise | null {
  const difference = pair.recon.difference_paise;
  if (difference === null) {
    return null;
  }
  return difference < 0n ? subtract(0n, difference) : difference;
}

/**
 * The aggregate chain behind a total shortfall figure: every contributing
 * Settlement's steps 1..8 inlined, then one `sum` over those Difference results.
 *
 * `pairs` is **every** in-scope Settlement, in the order the tool reports its rows,
 * so the chain is a function of the set and not of the order the store returned rows
 * in (Requirement 4.15). Every Settlement's own `amount` is cited whether or not it
 * contributed, because Requirement 4.7 reports the examined scope alongside the
 * figure and `as_of` is the newest record in the chain — a scope whose newest record
 * belongs to a Settlement that contributed nothing is still the scope the figure was
 * computed over.
 *
 * @throws {SettlementEvidenceError} when the summed Differences do not equal
 * `totalShortfallPaise`, when the scope cites no Source_Record at all, or when there
 * are more contributors than {@link MAX_TOTAL_SHORTFALL_CONTRIBUTORS}.
 */
export function totalShortfallChain(
  producedBy: string,
  pairs: readonly ReconciledPair[],
  totalShortfallPaise: Paise,
): EvidenceChainInput {
  const contributors = pairs.filter(contributesToTotalShortfall);
  if (contributors.length > MAX_TOTAL_SHORTFALL_CONTRIBUTORS) {
    throw new SettlementEvidenceError(
      `${contributors.length} Settlements contribute to the total shortfall, and one ` +
        `Evidence_Chain can carry at most ${MAX_TOTAL_SHORTFALL_CONTRIBUTORS} of them ` +
        `(${DIFFERENCE_PREFIX_STEP_COUNT} steps each plus the terminal sum, against a SMALLINT ` +
        `step_index). Narrow the scope rather than presenting a figure whose evidence is ` +
        `truncated`,
    );
  }

  const steps: EvidenceStep[] = [];
  const citations: EvidenceSourceCitation[] = [];
  const differenceSteps: number[] = [];
  const differences: Paise[] = [];

  for (const pair of contributors) {
    const block = settlementStepBlock(pair.settlement, steps.length, DIFFERENCE_PREFIX_STEP_COUNT);
    steps.push(...block.steps);
    citations.push(...block.citations);
    differenceSteps.push(block.difference_step_index);
    differences.push(block.results.difference_paise);
  }

  // Every in-scope Settlement, contributor or not: the examined scope the figure
  // was computed over. Duplicate citations of one (record, field) collapse in
  // `composeEvidenceChain`, so a contributor is cited once.
  for (const pair of pairs) {
    citations.push(
      citation(
        settlementRef(pair.settlement.settlement_id),
        SETTLEMENT_FIELD.amount,
        pair.settlement.record_updated_at,
      ),
    );
  }
  if (citations.length === 0) {
    // `evidence_chains.source_count >= 1` is a database CHECK, so a figure over an
    // empty scope has no representable chain. Refused here rather than discovered
    // as an ungrounded zero downstream.
    throw new SettlementEvidenceError(
      `the resolved scope holds no Settlement, so a total shortfall figure would cite no ` +
        `Source_Record; evidence_chains.source_count >= 1 makes an ungrounded figure ` +
        `unstorable, and returning one anyway is exactly what Requirement 12.2 forbids`,
    );
  }

  const summed = sum(differences);
  if (summed !== totalShortfallPaise) {
    throw new SettlementEvidenceError(
      `the total shortfall was reported as ${totalShortfallPaise} paise but summing the ` +
        `${contributors.length} contributing Differences produces ${summed}`,
    );
  }

  steps.push({
    index: steps.length + 1,
    operation: 'sum',
    operands: operandsOrZero(differenceSteps.map((index) => stepOperand(index))),
    result_paise: summed,
    note:
      `total shortfall: Σ Difference over the ${contributors.length} in-scope Settlement(s) ` +
      `whose Difference is positive. Excesses are not netted and unreconciled Settlements are ` +
      `excluded (Requirement 4.7, 4.13)`,
  });

  return { produced_by: producedBy, figure_paise: summed, steps, sources: citations };
}

/** What {@link totalAbsoluteDifferenceChain} grounds, and what it grounds it over. */
export interface AbsoluteDifferenceAggregate {
  /**
   * The Settlements whose `|Difference|` the figure sums. For Requirement 4.6's
   * remainder these are exactly the breakdown rows the limit cut off — a *set chosen
   * by the caller*, not by a predicate, which is why they are stated rather than
   * filtered out of {@link examined}.
   */
  readonly contributors: readonly ReconciledPair[];
  /**
   * Every in-scope Settlement, contributor or not, in the order the tool reports.
   * Each is cited so the chain states the scope the figure was computed over and
   * `as_of` is the newest record in it — the same stance {@link totalShortfallChain}
   * takes.
   */
  readonly examined: readonly ReconciledPair[];
  /** The figure the caller reported. Checked against the summed steps. */
  readonly total_absolute_difference_paise: Paise;
}

/**
 * The aggregate chain behind a **total absolute Difference** figure: every
 * contributor's steps 1..8 inlined, a `negate` step wherever the Difference is
 * negative, then one `sum` over those `|Difference|` results.
 *
 * This is Requirement 4.6's remainder total, the one monetary figure
 * `get_settlement_difference_breakdown` states outside its rows. It replays from the
 * Payment, Refund, chargeback, adjustment and Settlement records themselves rather
 * than from literals, for the reason in the module doc comment on aggregate chains.
 *
 * **Absolute, so nothing cancels.** A shortfall and an excess *add*: the figure is
 * always `>= 0n`, and two Settlements off by ₹5,000 in opposite directions are two
 * anomalies worth ₹10,000 of attention, not zero. The same non-netting stance
 * {@link totalShortfallChain} takes, for the same reason.
 *
 * @throws {SettlementEvidenceError} when a contributor has no Difference or a
 * Difference of `0n` (neither is a Requirement 4.6 row, so neither can be part of the
 * remainder), when the summed magnitudes do not equal the reported figure, when the
 * examined scope cites no Source_Record at all, or when there are more contributors
 * than {@link MAX_ABSOLUTE_DIFFERENCE_CONTRIBUTORS}.
 */
export function totalAbsoluteDifferenceChain(
  producedBy: string,
  aggregate: AbsoluteDifferenceAggregate,
): EvidenceChainInput {
  const { contributors, examined } = aggregate;
  if (contributors.length > MAX_ABSOLUTE_DIFFERENCE_CONTRIBUTORS) {
    throw new SettlementEvidenceError(
      `${contributors.length} Settlements contribute to the total absolute Difference, and one ` +
        `Evidence_Chain can carry at most ${MAX_ABSOLUTE_DIFFERENCE_CONTRIBUTORS} of them ` +
        `(${DIFFERENCE_PREFIX_STEP_COUNT} steps each, plus a negate where the Difference is ` +
        `negative, plus the terminal sum, against a SMALLINT step_index). Narrow the scope ` +
        `rather than presenting a figure whose evidence is truncated`,
    );
  }

  const steps: EvidenceStep[] = [];
  const citations: EvidenceSourceCitation[] = [];
  const magnitudeSteps: number[] = [];
  const magnitudes: Paise[] = [];

  for (const pair of contributors) {
    const difference = pair.recon.difference_paise;
    if (difference === null || difference === 0n) {
      throw new SettlementEvidenceError(
        `${pair.settlement.settlement_id} states a Difference of ${String(difference)}, so it is ` +
          `not a breakdown row (Requirement 4.6 reports one row per in-scope Settlement whose ` +
          `Difference is not 0 paise) and it cannot contribute to the remainder either`,
      );
    }
    const block = settlementStepBlock(pair.settlement, steps.length, DIFFERENCE_PREFIX_STEP_COUNT);
    steps.push(...block.steps);
    citations.push(...block.citations);

    if (difference < 0n) {
      // `|x|` for a negative x. The enum has no `abs`; see the module doc comment.
      const magnitude = subtract(0n, difference);
      steps.push({
        index: steps.length + 1,
        operation: 'negate',
        operands: [stepOperand(block.difference_step_index)],
        result_paise: magnitude,
        note:
          `|Difference| for ${pair.settlement.settlement_id}, whose Difference is negative: an ` +
          `excess contributes its magnitude, so a shortfall and an excess add rather than ` +
          `cancel (Requirement 4.6)`,
      });
      magnitudeSteps.push(steps.length);
      magnitudes.push(magnitude);
      continue;
    }
    // Positive: |x| = x, and a step stating that would add nothing to a replay.
    magnitudeSteps.push(block.difference_step_index);
    magnitudes.push(difference);
  }

  for (const pair of examined) {
    citations.push(
      citation(
        settlementRef(pair.settlement.settlement_id),
        SETTLEMENT_FIELD.amount,
        pair.settlement.record_updated_at,
      ),
    );
  }
  if (citations.length === 0) {
    // `evidence_chains.source_count >= 1` is a database CHECK, so a figure over an
    // empty scope has no representable chain. Refused rather than returned as an
    // ungrounded zero — the same call `totalShortfallChain` makes.
    throw new SettlementEvidenceError(
      `the resolved scope holds no Settlement, so a total absolute Difference figure would cite ` +
        `no Source_Record; evidence_chains.source_count >= 1 makes an ungrounded figure ` +
        `unstorable, and returning one anyway is exactly what Requirement 12.2 forbids`,
    );
  }

  const summed = sum(magnitudes);
  if (summed !== aggregate.total_absolute_difference_paise) {
    throw new SettlementEvidenceError(
      `the total absolute Difference was reported as ` +
        `${aggregate.total_absolute_difference_paise} paise but summing the ` +
        `${contributors.length} contributing magnitudes produces ${summed}`,
    );
  }

  steps.push({
    index: steps.length + 1,
    operation: 'sum',
    operands: operandsOrZero(magnitudeSteps.map((index) => stepOperand(index))),
    result_paise: summed,
    note:
      `total absolute Difference over the ${contributors.length} remaining in-scope ` +
      `Settlement(s) with a non-zero Difference. Absolute, so an excess and a shortfall add ` +
      `(Requirement 4.6)`,
  });

  return { produced_by: producedBy, figure_paise: summed, steps, sources: citations };
}
