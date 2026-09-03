/**
 * Expected Amount, the three-way Difference decomposition, and the persisted
 * per-Settlement reconciliation result (task 11.1).
 * Requirements 4.2, 4.3, 4.4, 4.5, 4.13.
 *
 * This is the module that answers "why am I missing ₹3.82 lakh in settlements?".
 * Every figure a drill-down shows for a Settlement is computed here:
 *
 *     Expected Amount = Σpayments − Σrefunds − Σchargebacks + signed Σadjustments
 *     Difference      = Expected Amount − received amount
 *     fee             = Σ fee lines
 *     gst             = Σ GST-on-fee lines
 *     residual        = Difference − fee − gst
 *
 * ## There is no rounding anywhere in this path, and none is missing
 *
 * A reader arriving from `src/calc/calculation-service.ts` will look for a
 * `roundHalfUpToPaisa` call, because that module spends most of its doc comment on
 * the rounding-adjustment algebra and the half-away-from-zero tie rule. **There is
 * no division, no rate, no percentage and no rounding step in this file.** Every
 * operation above is an addition or a subtraction over `bigint` paise, so:
 *
 *   - `difference = fee + gst + residual` is exact **by construction** for every
 *     input, since `residual` is *defined* as `difference − fee − gst`. There is no
 *     epsilon and nothing to reconcile at the paisa. That is why property P3 (task
 *     11.2) is a total property rather than an approximate one, and why
 *     `difference_decomposes_exactly` can be a database CHECK.
 *   - "Difference explained" means the residual is exactly `0n`. **There is no
 *     tolerance band**, and one must not be introduced: a tolerance is where a
 *     systematic error hides, and Requirement 4.4 defines the term as the residual
 *     *equalling* 0 paise.
 *
 * Arithmetic is nonetheless routed through the Calculation Service rather than
 * written inline, because `sum`, `add` and `subtract` range-check every operand,
 * every running total and every result, so a report whose partial sum leaves the
 * paise domain raises {@link PaiseRangeError} instead of flowing onward as a
 * confident wrong figure (Requirement 15.1, 15.8).
 *
 * ## An adjustment line is a **signed** value, not an amount plus a direction
 *
 * {@link ReconReportLines.adjustments} holds signed paise — positive for a credit,
 * negative for a debit — which is design.md's `ReconReportLines`, the shape
 * `test/fixtures/set-9281.ts` carries (`[-300000n, -190000n]`), and the shape
 * `scripts/seed-razorpay-testmode.ts` writes into `recon_report_lines.adjustments`.
 * Razorpay's own recon line does **not** look like that: it keeps `amount` positive
 * and carries the direction in `debit` versus `credit`.
 *
 * The sign flip is therefore a projection applied at the **ingestion boundary**,
 * before this module and before the Evidence_Chain — `signed_amount = credit −
 * debit`, which is exactly the field the SET-9281 chain's step 6 cites. Three
 * reasons the projection is not done here:
 *
 * 1. design.md fixes the twelve-step Evidence_Chain as `sum(adjustments)` followed
 *    by **`add`**, not `subtract`, and states no `negate` step. A signed input is
 *    the only representation that reaches `84260000n` through those twelve steps.
 *    Doing the flip inside this module would add arithmetic the chain cannot
 *    account for, and a replay would then reproduce a different figure than the
 *    tool reported, which is precisely what Requirement 12.8 forbids.
 * 2. `sum` is defined over `Paise[]`. An amount-plus-direction line would have to
 *    be reduced to a signed value before it could be summed at all, so the two
 *    conventions cannot both be the summed one — one of them has to be a
 *    projection, and the honest place for it is where the raw payload is read.
 * 3. It keeps this module total and pure over its input: there is no direction
 *    string to validate, no "both `debit` and `credit` non-zero" case to arbitrate,
 *    and nothing to reject.
 *
 * {@link signedAdjustmentPaise} is the projection, exported so the caller that
 * reads raw `debit`/`credit` recon lines — the `get_settlement_reconciliation` tool
 * of task 12.1 and the seeding path — uses one range-checked definition rather than
 * each writing its own subtraction. It is the *only* place in the reconciliation
 * path that turns a direction into a sign.
 *
 * ## What this module enforces that the database does not
 *
 * `20260101000007_settlement_reconciliations.sql` records two FINDINGs, and the
 * second is a gap a writer has to close:
 *
 * | Invariant | Enforced by |
 * |---|---|
 * | one result row per `(tenant, settlement)` | **database** `settlement_recon_uniq`, which is what makes a re-run an UPDATE (Requirement 4.15) |
 * | `unreconciled` carries no figures | **database** `unreconciled_has_no_figures`, **and** here before any statement |
 * | `difference = fee + gst + residual` | **database** `difference_decomposes_exactly`, and here |
 * | `difference_explained` ⇔ `residual = 0` | **database** `explained_iff_zero_residual`, and here |
 * | figures inside the paise domain | **database** `paise` domain, and here through the Calculation Service |
 * | **a reconciled row carries all five figures** | **this module only** (migration FINDING 2) |
 * | **`status` and `direction` agree** | **this module only** — there is no `direction` column (migration FINDING 1) |
 * | **`settlement_date` is a real calendar date** | **this module only** — `DATE` accepts any date Postgres can parse |
 *
 * FINDING 2 is real: every figure column is nullable, and a SQL CHECK passes when
 * it evaluates to NULL, so a `mismatch` row with all five figures NULL satisfies
 * all three CHECKs. {@link assertReconPersistable} rejects it here instead, and no
 * migration is added to paper over it — design.md names three CHECKs and the
 * schema group is task 4.7's.
 *
 * Same discipline as `src/ledger/semantic-ledger.ts`, `src/ingestion/ingestion-service.ts`
 * and `src/evidence/chain-builder.ts`: the whole row is validated as a pure
 * function first, so a malformed result issues **no statement at all** rather than
 * being rolled back, and a store rejection is matched **by constraint name** rather
 * than by SQLSTATE.
 *
 * ## The Evidence_Chain identifier is an input, not something composed here
 *
 * `settlement_reconciliations.evidence_chain_id` is written from
 * {@link SettlementReconPersistInput.evidence_chain_id}. This module does not
 * compose the chain, for the same reason it does not generate the run id: the chain
 * is attributed to the Financial_Tool that produced the figure —
 * `evidence_chains.produced_by` is `'get_settlement_reconciliation'` in the
 * SET-9281 fixture — and only that tool (task 12.1) holds the per-line
 * Source_Record identifiers and `record_updated_at` values a citation needs.
 * {@link ReconReportLines} is amounts only, by design, so a chain cannot be built
 * from it.
 *
 * What 12.1 must not drift from is the **order** of the operations, because a chain
 * whose steps do not mirror the arithmetic replays to a different figure. The order
 * this module performs them in is design.md's twelve, and the mapping is:
 *
 * | Step | Operation | Result | Where |
 * |---|---|---|---|
 * | 1 | `sum(payments)` | | {@link expectedAmount} |
 * | 2 | `sum(refunds)` | | {@link expectedAmount} |
 * | 3 | `subtract` | payments − refunds | {@link expectedAmount} |
 * | 4 | `sum(chargebacks)` | | {@link expectedAmount} |
 * | 5 | `subtract` | − chargebacks | {@link expectedAmount} |
 * | 6 | `sum(adjustments)` | signed | {@link expectedAmount} |
 * | 7 | `add` | **Expected Amount** | {@link expectedAmount} |
 * | 8 | `subtract` | **Difference** | {@link reconcileSettlement} |
 * | 9 | `sum(fees)` | fee component | {@link reconcileSettlement} |
 * | 10 | `sum(gst_on_fees)` | GST component | {@link reconcileSettlement} |
 * | 11 | `subtract` | Difference − fee | {@link reconcileSettlement} |
 * | 12 | `subtract` | **residual**, the chain's figure | {@link reconcileSettlement} |
 *
 * The Difference is the result of step 8, an **intermediate** of that one chain; the
 * chain's `figure_paise` is the residual, the result of the terminal step, because
 * `composeEvidenceChain` requires the terminal result to equal the figure. A caller
 * wanting the Difference reads step 8's `result_paise`; if a separate Difference
 * chain is ever wanted it is the 1..8 prefix with `figure_paise = 2320000n`. That is
 * the fixture's reading of design.md and nothing here contradicts it.
 *
 * ## Scope — five siblings, and the line drawn with each
 *
 * - **Task 11.2** owns property P3 (`numRuns: 1000`). Everything it needs is here
 *   and pure: {@link reconcileSettlement} takes no clock, no database and no
 *   context, {@link expectedAmount} is the `naiveExpected` comparison target, and
 *   {@link totalShortfall} is the aggregation an `unreconciled` Settlement has to be
 *   absent from. No property test is written here.
 * - **Task 11.3** owns the SET-9281 worked example. `reconcileSettlement` keeps
 *   design.md's exact 3-argument signature and returns exactly
 *   {@link SettlementRecon}, so `reconcileSettlement(SET_9281.settlement_id,
 *   SET_9281.received_paise, SET_9281.lines)` compares against `SET_9281.recon`
 *   field for field, and the fee variant against `SET_9281_FEE_VARIANT.recon`.
 * - **Task 11.4** owns the Exception fingerprint and upsert, and **task 13.2** owns
 *   creating the `settlement_mismatch` Exception. **No Exception is created here**,
 *   which is also why Requirement 4.4's "no Exception for a zero residual" is
 *   trivially satisfied. What this module provides them is
 *   {@link SettlementRecon.direction} and `|residual|` via {@link residualImpactPaise}.
 * - **Task 12.1** owns the `get_settlement_reconciliation` tool: its Zod schemas,
 *   its `ToolResult` envelope, its scope resolution and its Evidence_Chain
 *   composition. This module is the algorithm it calls and the row it writes.
 * - **Task 13.2** owns the agent run: scope resolution, the 120-second bound, and
 *   the run identifier itself. `run_id` is therefore an **input** here
 *   ({@link SettlementReconPersistInput.run_id}) and is never generated in this
 *   file — a row must be attributable to the run that computed it, and a run id
 *   minted per row would be attributable to nothing.
 *
 * ## Reported, not silently patched
 *
 * 1. design.md's `expectedAmount` snippet ends with a bare `+ calc.sum(r.adjustments)`
 *    rather than a Calculation Service call, which skips the range check on the one
 *    result that matters most. {@link expectedAmount} uses `add` instead. Same value
 *    for every in-range input; a range violation now raises rather than flowing on.
 * 2. design.md's `ReconReportLines` declares mutable `Paise[]` arrays. They are
 *    `readonly` here, so a frozen fixture (`deepFreeze` in `test/fixtures/set-9281.ts`)
 *    is assignable and no caller can mutate a report between the figure and its
 *    evidence. The Calculation Service takes `Paise[]`, so each array is copied at
 *    the call.
 * 3. design.md's `SettlementRecon` carries `direction`; the table has no `direction`
 *    column (migration FINDING 1). It is derivable from `sign(residual_paise)` and
 *    nothing is lost, but the row and the interface do not correspond field for
 *    field, and no column was invented here.
 * 4. **design.md never defines what the "total shortfall figure" of Requirement 4.7
 *    sums.** `get_settlement_reconciliation` declares `total_shortfall_paise: Paise`
 *    and P3 says only that an unreconciled Settlement is absent from it. A signed
 *    sum of every residual would let an unexplained excess cancel an unexplained
 *    shortfall and understate what is actually missing — the same objection as a
 *    tolerance band. {@link totalShortfall} therefore reports the two directions
 *    **separately** and nets neither, and states the count and the contributing
 *    identifiers so a caller can see what went into the figure. Raising the
 *    definition belongs with design.md; the choice is documented on
 *    {@link TotalShortfall} rather than buried.
 */

import { add, type Paise, subtract, sum } from '@/calc/calculation-service';
import type { TenantId } from '@/config/configuration-service';
import { assertDateOnly, type DateOnly } from '@/ledger/posting-rules';
import { type PaiseWire, toWire } from '@/wire/paise-wire';

/* -------------------------------------------------------------------------- */
/* design.md's reconciliation shapes                                          */
/* -------------------------------------------------------------------------- */

/**
 * design.md's `ReconReportLines`: the Settlement_Recon_Report as enumerated lines.
 *
 * Expected Amount **reads this**; it never infers a Settlement's composition from
 * dates or amounts (Requirement 4.2). Matching is identifier-only and belongs to
 * task 13.1; nothing here looks at a date.
 *
 * `adjustments` is **signed** — positive credit, negative debit. See the module doc
 * comment for why the sign is a projection applied before this module, and
 * {@link signedAdjustmentPaise} for the projection itself.
 *
 * `fees` and `gst_on_fees` are the Razorpay_Fee and GST_On_Fee lines the report
 * enumerates, one per enumerated Payment. They are **not** derived from the payment
 * amounts and no rate is applied to anything.
 */
export interface ReconReportLines {
  /** Gross Payment amounts enumerated in the report. Empty means unreconciled. */
  readonly payments: readonly Paise[];
  readonly refunds: readonly Paise[];
  readonly chargebacks: readonly Paise[];
  /** Signed: positive credits, negative debits (Requirement 4.2). */
  readonly adjustments: readonly Paise[];
  readonly fees: readonly Paise[];
  readonly gst_on_fees: readonly Paise[];
}

/** The three labels of the `recon_status` enum, in migration order. */
export const RECON_STATUSES = ['difference_explained', 'mismatch', 'unreconciled'] as const;

export type ReconStatus = (typeof RECON_STATUSES)[number];

/**
 * Which way an unexplained residual points (Requirement 4.5).
 *
 * `not_applicable` is the zero-residual case, and is not "unknown": a Settlement
 * whose Difference is fully explained has no direction, and neither does an
 * unreconciled one, for which no Difference was computed at all.
 */
export type ResidualDirection = 'unexplained_shortfall' | 'unexplained_excess' | 'not_applicable';

/**
 * design.md's `SettlementRecon`: the whole per-Settlement result.
 *
 * All five computed figures are `null` together or non-null together. `null` is
 * load-bearing rather than tidy: a `0n` in `expected_paise` or `difference_paise`
 * would aggregate as a real value and silently understate the reported total
 * shortfall, while `null` keeps the Settlement out of it (Requirement 4.13).
 *
 * `received_paise` is **not** nullable. It is read from the Settlement object, not
 * from the report, so it is known even when the report is absent — which is exactly
 * why `unreconciled_has_no_figures` does not constrain it.
 */
export interface SettlementRecon {
  readonly settlement_id: string;
  readonly expected_paise: Paise | null;
  readonly received_paise: Paise;
  /** `expected − received`. */
  readonly difference_paise: Paise | null;
  readonly fee_component_paise: Paise | null;
  readonly gst_component_paise: Paise | null;
  /** `difference − fee − gst`. Exactly `0n` is the sole definition of explained. */
  readonly residual_paise: Paise | null;
  readonly status: ReconStatus;
  readonly direction: ResidualDirection;
}

/**
 * Requirement 4.7's examined counts for one Settlement. Counts, not money, so they
 * are `number` — `INT` columns, and the ESLint money rules do not fire on a name
 * that reads as a count.
 */
export interface ExaminedCounts {
  readonly payments_counted: number;
  readonly refunds_counted: number;
  readonly chargebacks_counted: number;
  readonly adjustments_counted: number;
}

/** Thrown when a reconciliation result cannot be persisted as stated. */
export class SettlementReconError extends Error {
  override readonly name = 'SettlementReconError';
}

/* -------------------------------------------------------------------------- */
/* The algorithm                                                              */
/* -------------------------------------------------------------------------- */

/**
 * `sum` over a `readonly` array. The Calculation Service takes `Paise[]`, and a
 * report is `readonly` so a frozen fixture is assignable — see the module doc.
 */
function total(lines: readonly Paise[]): Paise {
  return sum([...lines]);
}

/**
 * The signed value of one Razorpay adjustment recon line: `credit − debit`.
 *
 * This is the ingestion-boundary projection that turns Razorpay's
 * positive-amount-plus-direction convention into the signed value Requirement 4.2
 * sums, and it is the field the SET-9281 Evidence_Chain cites as `signed_amount`.
 * Both operands and the result are range-checked. There is no rounding: a
 * subtraction of two integer paise values is exact.
 *
 * A line carrying both a non-zero `debit` and a non-zero `credit` nets rather than
 * being rejected, because `credit − debit` is the whole definition of the field and
 * a net line is not a malformed one.
 */
export function signedAdjustmentPaise(line: {
  readonly debit: Paise;
  readonly credit: Paise;
}): Paise {
  return subtract(line.credit, line.debit);
}

/**
 * Requirement 4.2's Expected Amount:
 * `Σpayments − Σrefunds − Σchargebacks + signed Σadjustments`.
 *
 * Steps 1..7 of the Evidence_Chain, in that order. Every operation is a
 * range-checked `sum`, `subtract` or `add` from the Calculation Service, and there
 * is no division and no rounding — see the module doc comment.
 *
 * @throws {PaiseRangeError} when a line, a running total, or an intermediate leaves
 * the paise range (Requirement 15.1, 15.8).
 */
export function expectedAmount(report: ReconReportLines): Paise {
  const payments = total(report.payments); //     step 1
  const refunds = total(report.refunds); //       step 2
  const lessRefunds = subtract(payments, refunds); //            step 3
  const chargebacks = total(report.chargebacks); //              step 4
  const lessChargebacks = subtract(lessRefunds, chargebacks); // step 5
  const adjustments = total(report.adjustments); // step 6, signed
  // Step 7 is `add`, not `subtract`, because the adjustment sum is already signed.
  // design.md writes a bare `+` here; `add` is the same value and range-checks it.
  return add(lessChargebacks, adjustments);
}

/**
 * Reconcile one Settlement: Requirement 4.2's Difference, Requirement 4.3's
 * three-way decomposition, and Requirement 4.4 / 4.5's status and direction.
 *
 * **Pure and total.** No clock, no database, no Tenant, no context — so property
 * P3 (task 11.2) can drive it directly, and the twelve figures a drill-down shows
 * are a function of the report alone.
 *
 * An absent report, or one enumerating 0 Payments, yields `unreconciled` with all
 * five figures `null` and `direction: 'not_applicable'`, which is what excludes the
 * Settlement from the reported total shortfall (Requirement 4.13). The two cases
 * stay distinguishable on the persisted row: `recon_report_id` is `NULL` for an
 * absent report and present for an empty one.
 *
 * The decomposition is computed for **every** reconciled Settlement, including one
 * whose Difference is `0n`, so the exactness invariant holds on every persisted row
 * rather than only on the interesting ones (Requirement 4.3, property P3).
 *
 * @throws {PaiseRangeError} when a line, a running total, or a computed figure
 * leaves the paise range. Nothing is returned partially computed.
 */
export function reconcileSettlement(
  settlementId: string,
  receivedPaise: Paise,
  report: ReconReportLines | null,
): SettlementRecon {
  // Requirement 4.13. `received_paise` survives because it comes from the
  // Settlement object rather than from the report.
  if (report === null || report.payments.length === 0) {
    return {
      settlement_id: settlementId,
      expected_paise: null,
      received_paise: receivedPaise,
      difference_paise: null,
      fee_component_paise: null,
      gst_component_paise: null,
      residual_paise: null,
      status: 'unreconciled',
      direction: 'not_applicable',
    };
  }

  const expected = expectedAmount(report); //                   steps 1..7
  const difference = subtract(expected, receivedPaise); //      step 8

  const fee = total(report.fees); //                            step 9
  const gst = total(report.gst_on_fees); //                     step 10
  // `residual` is *defined* by these two subtractions, which is what makes
  // `difference = fee + gst + residual` exact by construction (property P3).
  const residual = subtract(subtract(difference, fee), gst); // steps 11, 12

  return {
    settlement_id: settlementId,
    expected_paise: expected,
    received_paise: receivedPaise,
    difference_paise: difference,
    fee_component_paise: fee,
    gst_component_paise: gst,
    residual_paise: residual,
    // Exactly zero. No tolerance band (Requirement 4.4).
    status: residual === 0n ? 'difference_explained' : 'mismatch',
    direction: residualDirection(residual),
  };
}

/**
 * Requirement 4.5's classification of a residual, and Requirement 4.4's absence of
 * one. Exported because task 13.2 classifies the Exception it creates from the same
 * rule and must not restate it.
 */
export function residualDirection(residualPaise: Paise | null): ResidualDirection {
  if (residualPaise === null || residualPaise === 0n) {
    return 'not_applicable';
  }
  return residualPaise > 0n ? 'unexplained_shortfall' : 'unexplained_excess';
}

/**
 * `|residual|`: the INR impact Requirement 4.5 gives the `settlement_mismatch`
 * Exception, in integer paise. `null` when there is no Exception to create — a zero
 * residual (Requirement 4.4) or an unreconciled Settlement (Requirement 4.13).
 *
 * The Exception itself is task 11.4's fingerprint and upsert and task 13.2's
 * creation. This is only the figure, so the two do not each write their own
 * absolute value.
 */
export function residualImpactPaise(recon: SettlementRecon): Paise | null {
  const residual = recon.residual_paise;
  if (residual === null || residual === 0n) {
    return null;
  }
  return residual > 0n ? residual : subtract(0n, residual);
}

/**
 * Requirement 4.7's examined counts, from the report's enumerated lines. An absent
 * report counts zero of everything, matching the table's `DEFAULT 0`.
 */
export function examinedCounts(report: ReconReportLines | null): ExaminedCounts {
  if (report === null) {
    return {
      payments_counted: 0,
      refunds_counted: 0,
      chargebacks_counted: 0,
      adjustments_counted: 0,
    };
  }
  return {
    payments_counted: report.payments.length,
    refunds_counted: report.refunds.length,
    chargebacks_counted: report.chargebacks.length,
    adjustments_counted: report.adjustments.length,
  };
}

/* -------------------------------------------------------------------------- */
/* The shortfall aggregation (Requirement 4.7, 4.13)                          */
/* -------------------------------------------------------------------------- */

/**
 * The aggregate over a set of reconciliation results, with the two directions kept
 * apart.
 *
 * design.md does not define what the total shortfall sums — see gap 4 in the module
 * doc comment — so the choice is stated here rather than implied:
 *
 * - `total_shortfall_paise` sums the residuals that **are** shortfalls (`> 0n`) and
 *   nothing else. It is always `>= 0n`.
 * - `total_excess_paise` sums the magnitudes of the residuals that are excesses
 *   (`< 0n`). Also always `>= 0n`.
 * - **Neither is netted against the other.** An unexplained excess offsetting an
 *   unexplained shortfall is two anomalies, not zero anomalies, and a single signed
 *   total would report them as zero — the same way a tolerance band hides a
 *   systematic error.
 * - An `unreconciled` Settlement contributes to **neither** figure and appears in
 *   `unreconciled_settlement_ids` instead (Requirement 4.13). A
 *   `difference_explained` Settlement contributes to neither either: its residual is
 *   `0n`, so there is nothing missing.
 *
 * Identifier lists are sorted ascending, so the aggregate is a function of the set
 * and not of the order the rows arrived in (Requirement 4.15's determinism). The
 * sums are order-independent already, being integer addition.
 */
export interface TotalShortfall {
  /** Σ residual over Settlements whose residual is `> 0n`. Always `>= 0n`. */
  readonly total_shortfall_paise: Paise;
  /** Σ |residual| over Settlements whose residual is `< 0n`. Always `>= 0n`. */
  readonly total_excess_paise: Paise;
  /** Requirement 4.7's count of Settlements with a non-zero residual, both directions. */
  readonly residual_nonzero_count: number;
  /** The Settlements in `total_shortfall_paise`, ascending. */
  readonly shortfall_settlement_ids: readonly string[];
  /** The Settlements in `total_excess_paise`, ascending. */
  readonly excess_settlement_ids: readonly string[];
  /** Excluded from both figures (Requirement 4.13), ascending. */
  readonly unreconciled_settlement_ids: readonly string[];
}

/**
 * Aggregate reconciliation results into the shortfall figures Requirement 4.7
 * reports. Pure, and order-independent.
 *
 * @throws {PaiseRangeError} when a running total leaves the paise range.
 */
export function totalShortfall(recons: readonly SettlementRecon[]): TotalShortfall {
  const shortfalls: Paise[] = [];
  const excesses: Paise[] = [];
  const shortfallIds: string[] = [];
  const excessIds: string[] = [];
  const unreconciledIds: string[] = [];

  for (const recon of recons) {
    if (recon.status === 'unreconciled' || recon.residual_paise === null) {
      unreconciledIds.push(recon.settlement_id);
      continue;
    }
    const residual = recon.residual_paise;
    if (residual > 0n) {
      shortfalls.push(residual);
      shortfallIds.push(recon.settlement_id);
    } else if (residual < 0n) {
      excesses.push(subtract(0n, residual));
      excessIds.push(recon.settlement_id);
    }
  }

  const ascending = (ids: string[]): readonly string[] => [...ids].sort((a, b) => (a < b ? -1 : 1));

  return {
    total_shortfall_paise: sum(shortfalls),
    total_excess_paise: sum(excesses),
    residual_nonzero_count: shortfalls.length + excesses.length,
    shortfall_settlement_ids: ascending(shortfallIds),
    excess_settlement_ids: ascending(excessIds),
    unreconciled_settlement_ids: ascending(unreconciledIds),
  };
}

/* -------------------------------------------------------------------------- */
/* Persistence: constraint names                                              */
/* -------------------------------------------------------------------------- */

/**
 * `UNIQUE (tenant_id, settlement_id)`: one reconciliation result per Settlement per
 * Tenant.
 *
 * This is what makes a re-run an **UPDATE** rather than a second result row, which
 * Requirement 4.15's determinism depends on: two runs over an unchanged dataset must
 * leave the same one row, not two rows that disagree. Named here so every store
 * adapter writes `ON CONFLICT ON CONSTRAINT settlement_recon_uniq DO UPDATE` against
 * the same string, exactly as `LEDGER_SET_DERIVATION_UNIQ` is used in
 * `src/ledger/semantic-ledger.ts`.
 */
export const SETTLEMENT_RECON_UNIQ = 'settlement_recon_uniq';

/** `status <> 'unreconciled' OR (all five figures IS NULL)`. */
export const UNRECONCILED_HAS_NO_FIGURES = 'unreconciled_has_no_figures';

/** `status = 'unreconciled' OR difference = fee + gst + residual`. Property P3, in the database. */
export const DIFFERENCE_DECOMPOSES_EXACTLY = 'difference_decomposes_exactly';

/** `status = 'unreconciled' OR (status = 'difference_explained') = (residual = 0)`. */
export const EXPLAINED_IFF_ZERO_RESIDUAL = 'explained_iff_zero_residual';

/**
 * The three CHECKs on `settlement_reconciliations`, in migration order.
 *
 * A store must match a rejection **by constraint name** and not merely on SQLSTATE
 * `23514`: the `paise` domain raises the same class, and reading any check violation
 * as "malformed reconciliation row" would misreport a range violation as one.
 */
export const SETTLEMENT_RECON_CHECKS = [
  UNRECONCILED_HAS_NO_FIGURES,
  DIFFERENCE_DECOMPOSES_EXACTLY,
  EXPLAINED_IFF_ZERO_RESIDUAL,
] as const;

export type SettlementReconCheck = (typeof SETTLEMENT_RECON_CHECKS)[number];

/* -------------------------------------------------------------------------- */
/* Persistence: shapes                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One reconciliation result ready to be persisted: what {@link reconcileSettlement}
 * computed, plus the four things it does not know.
 *
 * `run_id` and `evidence_chain_id` are inputs rather than values this module
 * produces — see the module doc comment. `recon_report_id` is `null` for an absent
 * report and present for an empty one, which is the only thing that distinguishes
 * the two halves of Requirement 4.13 on the row.
 */
export interface SettlementReconPersistInput {
  readonly recon: SettlementRecon;
  /** `NULL` when the report is absent (Requirement 4.13). */
  readonly recon_report_id: string | null;
  /** `YYYY-MM-DD`, the Settlement's own date. Held to a real calendar date. */
  readonly settlement_date: DateOnly;
  readonly examined: ExaminedCounts;
  /** The chain for the figures on this row, composed by the tool (task 12.1). */
  readonly evidence_chain_id: string | null;
  /** The Reconciliation_Agent run that computed this row (task 13.2). A UUID. */
  readonly run_id: string;
}

/**
 * One `settlement_reconciliations` row.
 *
 * Money travels as integer strings produced by `toWire`, which range-checked each
 * one — never as a `number`, and never through `JSON.stringify` of a `bigint`.
 * Counts are `INT` and stay `number`.
 */
export interface SettlementReconWrite {
  readonly tenant_id: TenantId;
  readonly settlement_id: string;
  readonly recon_report_id: string | null;
  readonly settlement_date: DateOnly;
  readonly expected_paise: PaiseWire | null;
  readonly received_paise: PaiseWire;
  readonly difference_paise: PaiseWire | null;
  readonly fee_component_paise: PaiseWire | null;
  readonly gst_component_paise: PaiseWire | null;
  readonly residual_paise: PaiseWire | null;
  readonly status: ReconStatus;
  readonly payments_counted: number;
  readonly refunds_counted: number;
  readonly chargebacks_counted: number;
  readonly adjustments_counted: number;
  readonly evidence_chain_id: string | null;
  readonly run_id: string;
}

/**
 * What a store reports back from the upsert.
 *
 * `created` distinguishes a first computation from a re-run, so a caller can tell
 * "one row now exists" from "one row already existed and was refreshed" without
 * counting rows. Both are successes: a re-run is expected, and
 * {@link SETTLEMENT_RECON_UNIQ} is what keeps it to one row.
 *
 * A CHECK rejection arrives as a **value** so it funnels into one place in the
 * service rather than being caught in two, matching `LedgerWriteOutcome` and
 * `EvidenceChainWriteOutcome`. It is unreachable through
 * {@link SettlementReconciler.persist}, which validates the row before any
 * statement; reaching it means the store built a row the input did not describe.
 * Anything else — a connection fault, an absent Tenant, a `paise` domain violation —
 * is a failure and the store throws.
 */
export type SettlementReconWriteOutcome =
  | {
      readonly ok: true;
      readonly reconciliation_id: string;
      /** `false` when the row already existed and this run updated it (Requirement 4.15). */
      readonly created: boolean;
    }
  | {
      readonly ok: false;
      readonly kind: 'malformed_row';
      readonly constraint: SettlementReconCheck;
    };

/**
 * Persistence for reconciliation results. Injected rather than imported, so the
 * algorithm and the mapping are unit-testable with no database and the transaction
 * boundary is the adapter's concern.
 *
 * **There is no PostgREST adapter here, deliberately**, for the same reason
 * `LedgerStore` and `EvidenceChainStore` have none: `settlement_reconciliations` is
 * `ENABLE`d **and** `FORCE`d for row-level security with no policies until task
 * 26.1, so PostgREST matches zero rows for every role without `BYPASSRLS` today.
 * `test/db/settlement-reconciliation.test.ts` exercises the same statements over a
 * real SQL session — the `ON CONFLICT ON CONSTRAINT settlement_recon_uniq DO UPDATE`
 * an adapter has to write, and each of the three CHECKs rejecting by name — which is
 * where the upsert-not-duplicate guarantee is actually proven. The adapter itself
 * lands with the tool that needs a live connection (task 12.1).
 */
export interface SettlementReconStore {
  /**
   * Upsert one row on {@link SETTLEMENT_RECON_UNIQ}, replacing every computed figure,
   * the counts, the evidence chain, the run id and `computed_at`.
   *
   * A CHECK violation — SQLSTATE `23514` with one of {@link SETTLEMENT_RECON_CHECKS}
   * as the constraint name, and only those names — is reported as
   * `{ ok: false, kind: 'malformed_row' }`. Any other error throws.
   */
  upsertReconciliation(write: SettlementReconWrite): Promise<SettlementReconWriteOutcome>;
}

/* -------------------------------------------------------------------------- */
/* Persistence: validation and mapping                                        */
/* -------------------------------------------------------------------------- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertIdentifier(value: string, what: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SettlementReconError(
      `${what} must be a non-empty identifier, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function assertUuid(value: string, what: string): string {
  if (!UUID_RE.test(value)) {
    throw new SettlementReconError(`${what} must be a UUID, got ${JSON.stringify(value)}`);
  }
  return value;
}

function assertCount(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SettlementReconError(
      `${what} must be a non-negative whole count, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Every invariant the row must satisfy, checked **before any statement is issued**,
 * so a malformed result leaves nothing to roll back.
 *
 * Three of these the database also enforces, and this is not redundant: closing them
 * here is what makes the rejection message name the figure rather than the
 * constraint, and it is what keeps a partial write impossible rather than merely
 * rolled back. The fourth — a reconciled row carrying all five figures — the
 * database **cannot** enforce, because a SQL CHECK passes when it evaluates to NULL
 * (migration FINDING 2), so this is the only place it holds.
 *
 * `status` and `direction` are also checked against each other. There is no
 * `direction` column (migration FINDING 1), so a disagreement would be invisible on
 * the row and would surface later as a `settlement_mismatch` Exception classified
 * the wrong way round.
 *
 * @throws {SettlementReconError} for any disagreement, naming the figures involved.
 */
export function assertReconPersistable(input: SettlementReconPersistInput): void {
  const { recon } = input;
  assertIdentifier(recon.settlement_id, 'settlement_id');
  assertDateOnly(input.settlement_date, 'settlement_date');
  assertUuid(input.run_id, 'run_id');
  if (input.evidence_chain_id !== null) {
    assertUuid(input.evidence_chain_id, 'evidence_chain_id');
  }
  if (input.recon_report_id !== null) {
    assertIdentifier(input.recon_report_id, 'recon_report_id');
  }
  assertCount(input.examined.payments_counted, 'payments_counted');
  assertCount(input.examined.refunds_counted, 'refunds_counted');
  assertCount(input.examined.chargebacks_counted, 'chargebacks_counted');
  assertCount(input.examined.adjustments_counted, 'adjustments_counted');

  if (!(RECON_STATUSES as readonly string[]).includes(recon.status)) {
    throw new SettlementReconError(
      `status ${JSON.stringify(recon.status)} is not a recon_status label`,
    );
  }

  const figures = [
    ['expected_paise', recon.expected_paise],
    ['difference_paise', recon.difference_paise],
    ['fee_component_paise', recon.fee_component_paise],
    ['gst_component_paise', recon.gst_component_paise],
    ['residual_paise', recon.residual_paise],
  ] as const;

  if (recon.status === 'unreconciled') {
    // `unreconciled_has_no_figures`, and Requirement 4.13's exclusion from the
    // reported total: a 0n here would aggregate as a real value.
    const stated = figures.filter(([, value]) => value !== null).map(([name]) => name);
    if (stated.length > 0) {
      throw new SettlementReconError(
        `an unreconciled Settlement computes no Expected Amount and no Difference, but ` +
          `${recon.settlement_id} states ${stated.join(', ')}; a figure here would be counted ` +
          `into the reported total shortfall the Settlement must be excluded from ` +
          `(Requirement 4.13, ${UNRECONCILED_HAS_NO_FIGURES})`,
      );
    }
    if (recon.direction !== 'not_applicable') {
      throw new SettlementReconError(
        `an unreconciled Settlement has no residual to point anywhere, but ` +
          `${recon.settlement_id} states direction ${recon.direction}`,
      );
    }
    return;
  }

  // migration FINDING 2: the database cannot require these, because every CHECK it
  // states evaluates to NULL — and therefore passes — on a row of NULLs.
  const missing = figures.filter(([, value]) => value === null).map(([name]) => name);
  if (missing.length > 0) {
    throw new SettlementReconError(
      `a reconciled Settlement carries all five figures, but ${recon.settlement_id} leaves ` +
        `${missing.join(', ')} null; the three CHECKs on settlement_reconciliations all pass ` +
        `on a row of nulls (FINDING 2 of 20260101000007), so this is the only barrier`,
    );
  }

  const difference = recon.difference_paise;
  const fee = recon.fee_component_paise;
  const gst = recon.gst_component_paise;
  const residual = recon.residual_paise;
  if (difference === null || fee === null || gst === null || residual === null) {
    // Unreachable: `missing` is empty here. Narrowing only.
    throw new SettlementReconError(`${recon.settlement_id} lost a figure between two checks`);
  }

  // `difference_decomposes_exactly`. Exact by construction in
  // `reconcileSettlement`, so reaching this means the figures were assembled
  // elsewhere. Integer paise, zero slack, no epsilon (Requirement 4.3, property P3).
  const recomposed = add(add(fee, gst), residual);
  if (recomposed !== difference) {
    throw new SettlementReconError(
      `the Difference of ${recon.settlement_id} does not decompose exactly: ` +
        `fee ${fee} + gst ${gst} + residual ${residual} = ${recomposed}, but the Difference is ` +
        `${difference} (Requirement 4.3, ${DIFFERENCE_DECOMPOSES_EXACTLY})`,
    );
  }

  // `explained_iff_zero_residual`, both directions (Requirement 4.4, 4.5).
  if ((recon.status === 'difference_explained') !== (residual === 0n)) {
    throw new SettlementReconError(
      `${recon.settlement_id} states status ${recon.status} with residual ${residual}: ` +
        `"difference explained" means the residual is exactly 0 paise and nothing else, with ` +
        `no tolerance band (Requirement 4.4, ${EXPLAINED_IFF_ZERO_RESIDUAL})`,
    );
  }

  const direction = residualDirection(residual);
  if (recon.direction !== direction) {
    throw new SettlementReconError(
      `${recon.settlement_id} states direction ${recon.direction} for residual ${residual}, ` +
        `which is ${direction} (Requirement 4.5). There is no direction column, so nothing ` +
        `downstream would catch this`,
    );
  }
}

/**
 * A validated result as a row. The single place a `Paise` becomes an integer string,
 * through `toWire`, which range-checks it (Requirement 15.1, 15.8), and the single
 * place {@link ExaminedCounts} meets the four `*_counted` columns.
 *
 * @throws {SettlementReconError} for anything {@link assertReconPersistable} rejects.
 */
export function settlementReconWriteFor(
  tenantId: TenantId,
  input: SettlementReconPersistInput,
): SettlementReconWrite {
  assertReconPersistable(input);
  const { recon } = input;
  const wire = (value: Paise | null): PaiseWire | null => (value === null ? null : toWire(value));

  return {
    tenant_id: tenantId,
    settlement_id: recon.settlement_id,
    recon_report_id: input.recon_report_id,
    settlement_date: input.settlement_date,
    expected_paise: wire(recon.expected_paise),
    received_paise: toWire(recon.received_paise),
    difference_paise: wire(recon.difference_paise),
    fee_component_paise: wire(recon.fee_component_paise),
    gst_component_paise: wire(recon.gst_component_paise),
    residual_paise: wire(recon.residual_paise),
    status: recon.status,
    payments_counted: input.examined.payments_counted,
    refunds_counted: input.examined.refunds_counted,
    chargebacks_counted: input.examined.chargebacks_counted,
    adjustments_counted: input.examined.adjustments_counted,
    evidence_chain_id: input.evidence_chain_id,
    run_id: input.run_id,
  };
}

/* -------------------------------------------------------------------------- */
/* The service                                                                */
/* -------------------------------------------------------------------------- */

/** One Settlement to reconcile and persist, end to end. */
export interface SettlementReconciliationInput {
  readonly settlement_id: string;
  /** `null` when the Settlement_Recon_Report is absent (Requirement 4.13). */
  readonly recon_report_id: string | null;
  readonly settlement_date: DateOnly;
  /** The Settlement object's own amount: what landed in the bank. */
  readonly received_paise: Paise;
  /** `null` when absent; an empty `payments` list is the other half of 4.13. */
  readonly report: ReconReportLines | null;
  readonly evidence_chain_id: string | null;
  readonly run_id: string;
}

/** What one reconciled-and-persisted Settlement yields. */
export interface SettlementReconciliationResult {
  readonly recon: SettlementRecon;
  readonly examined: ExaminedCounts;
  readonly reconciliation_id: string;
  /** `false` when a previous run's row was updated rather than a new one written. */
  readonly created: boolean;
}

/**
 * Reconcile and persist for **one** Tenant.
 *
 * No method takes a `tenant_id`: it is bound once at construction from the session
 * context, so an unscoped write is not expressible (Requirement 12.7, 14.10). A
 * cross-Tenant write is not "denied", it is unrepresentable.
 */
export interface SettlementReconciler {
  /**
   * Persist an already-computed result. Validates first, so a malformed row issues
   * no statement at all.
   *
   * @throws {SettlementReconError} for a malformed result, and for a store that
   * reports a CHECK rejection the validation already excludes.
   */
  persist(input: SettlementReconPersistInput): Promise<SettlementReconciliationResult>;

  /**
   * {@link reconcileSettlement} then {@link persist}, which is the call the
   * Reconciliation_Agent run of task 13.2 makes per in-scope Settlement.
   */
  reconcile(input: SettlementReconciliationInput): Promise<SettlementReconciliationResult>;
}

export interface SettlementReconcilerDeps {
  readonly store: SettlementReconStore;
  /** The session Tenant. Never an argument to a method (Requirement 12.7). */
  readonly tenantId: TenantId;
}

export function createSettlementReconciler(
  deps: SettlementReconcilerDeps,
): SettlementReconciler {
  const { store } = deps;
  const tenantId = assertUuid(
    deps.tenantId,
    'createSettlementReconciler requires the session Tenant identifier, which',
  );

  async function persist(
    input: SettlementReconPersistInput,
  ): Promise<SettlementReconciliationResult> {
    // Pure, and everything it rejects it rejects before any statement.
    const write = settlementReconWriteFor(tenantId, input);
    const outcome = await store.upsertReconciliation(write);
    if (!outcome.ok) {
      // Unreachable: `settlementReconWriteFor` checks all three CHECKs first.
      // Reaching it means the store wrote a row the input did not describe.
      throw new SettlementReconError(
        `the store rejected the reconciliation of ${input.recon.settlement_id} on ` +
          `${outcome.constraint}, which the validation funnel already excludes`,
      );
    }
    return {
      recon: input.recon,
      examined: input.examined,
      reconciliation_id: outcome.reconciliation_id,
      created: outcome.created,
    };
  }

  return {
    persist,

    async reconcile(
      input: SettlementReconciliationInput,
    ): Promise<SettlementReconciliationResult> {
      const recon = reconcileSettlement(input.settlement_id, input.received_paise, input.report);
      return persist({
        recon,
        recon_report_id: input.recon_report_id,
        settlement_date: input.settlement_date,
        examined: examinedCounts(input.report),
        evidence_chain_id: input.evidence_chain_id,
        run_id: input.run_id,
      });
    },
  };
}
