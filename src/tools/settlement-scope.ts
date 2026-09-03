/**
 * The settlement read scope: Requirement 4.7's date range and examined counts, and
 * the seam a settlement Financial_Tool reads its in-scope Settlements through
 * (task 12.1).
 *
 * **This module is deliberately shared.** `get_settlement_reconciliation` (task
 * 12.1) and `get_settlement_difference_breakdown` (task 12.2) answer two different
 * questions over *the same rows*: the same resolved scope, the same examined
 * counts, the same per-Settlement recon report lines with the same Source_Record
 * identifiers. 12.2 imports {@link SettlementScopeStore},
 * {@link ScopedSettlement}, {@link resolveSettlementScope} and
 * {@link reconReportLinesOf} from here rather than writing a second copy, and a
 * disagreement between the two tools about what "in scope" means becomes a compile
 * error rather than two plausible answers to one question.
 *
 * `src/agents/reconciliation/reconcile-settlement.ts` (task 11.1) owns the
 * *arithmetic* — `expectedAmount`, `reconcileSettlement`, `totalShortfall` — and
 * nothing here recomputes any of it. This module owns only *which* Settlements are
 * reconciled and *what was read* to reconcile them.
 *
 * ## Requirement 4.7's trailing window is applied by the caller, and why
 *
 * Requirement 4.7 wants "the trailing 90 days ending at the run timestamp where
 * the request states no date range". design.md's input for
 * `get_settlement_reconciliation` is `{ from: DateOnly; to: DateOnly;
 * settlement_ids?: string[] }` — `from` and `to` are **not** optional — and its
 * reconciliation sequence diagram has the Agent resolve the window before the tool
 * is called at all (`RA->>RA: resolve scope = trailing 90 days`, then
 * `RA->>T1: {tenant_id, from, to}`). So the tool never sees an absent range, and
 * the default belongs to its caller.
 *
 * {@link resolveSettlementScope} is that default, exported here so the tool (which
 * validates and echoes the resolved range as `scope`), the Reconciliation_Agent run
 * of task 13.2 and task 12.2 all use **one** definition rather than three
 * subtractions that disagree at a month boundary. See its doc comment for why the
 * window is 90 inclusive dates rather than 91.
 *
 * ## The five examined counts are Requirement 4.7's, not task 11.1's
 *
 * Requirement 4.7 names five record types: **Payments, Settlements, Refunds,
 * Ledger_Entries and Razorpay_Invoices**. Task 11.1 also declares an
 * `ExaminedCounts`, but it is a different thing — the four *per-Settlement* line
 * counts that land in the `settlement_reconciliations` `*_counted` columns
 * (payments, refunds, chargebacks, adjustments). design.md's tool table writes
 * `examined: ExaminedCounts` for this tool and **never defines the shape**, so
 * there is no way to tell which of the two it meant.
 *
 * Resolved by keeping both and naming them apart: {@link ExaminedRecordCounts} is
 * Requirement 4.7's five, and 11.1's `ExaminedCounts` stays the per-row four. A
 * reported finding, not a silent merge — merging them would drop Ledger_Entries and
 * Razorpay_Invoices, which are the two types Requirement 4.1's identifier matching
 * reads and which no per-Settlement report line accounts for.
 *
 * ## The recon-line identifier collision, and how this seam reads around it
 *
 * A combined Settlement_Recon_Report line keys on `entity_id`, which *is* the
 * settled entity's identifier, so a line and its Payment contend for one
 * `(tenant_id, razorpay_id)` row in `razorpay_objects`
 * (`IDENTIFIER_COLLIDES_WITH_OTHER_TYPE` in `src/ingestion/ingestion-service.ts`,
 * reproduced deliberately in `test/fixtures/set-9281.ts`, confirmed against test
 * mode in `test/integration/razorpay-live-traversal.integration.test.ts`). Fixing
 * it needs a `(tenant_id, object_type, razorpay_id)` key and a migration, which is
 * not this task's.
 *
 * The judgement call it forces here: **a line's Source_Record identifier is
 * whatever the store resolved it to, and this module does not re-derive it.**
 * {@link ReconLine.line_id} is carried per line, the store owns how it obtained it,
 * and the Evidence_Chain cites that identifier with type `settlement_recon_report`.
 * That is what makes the citation honest under the collision: where a line lost its
 * `razorpay_objects` row to its Payment, the store still knows which line it read,
 * and the alternative — reconstructing the identifier from the Payment — would cite
 * a `payment` row for a figure that came from a report line. Reported, worked
 * around, not papered over.
 *
 * ## No live adapter, deliberately
 *
 * Same reason `LedgerStore`, `EvidenceChainStore` and `SettlementReconStore` have
 * none: every settlement table is `ENABLE`d **and** `FORCE`d for row-level security
 * with no policies until task 26.1, so PostgREST matches zero rows for every role
 * without `BYPASSRLS`. {@link SettlementScopeStore} is the seam; the `ctx.db`-backed
 * adapter lands with 26.x, and `test/db/settlement-reconciliation.test.ts` is where
 * the statements are exercised against a real SQL session today.
 */

import type { Paise } from '@/calc/paise';
import type { TenantId } from '@/config/configuration-service';
import type { ReconReportLines } from '@/agents/reconciliation/reconcile-settlement';
import type { DateOnly, SourceRef } from '@/ledger/posting-rules';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** Thrown when a scope or a scoped Settlement is malformed as stated. */
export class SettlementScopeError extends Error {
  override readonly name = 'SettlementScopeError';
}

/* -------------------------------------------------------------------------- */
/* DateRange (design.md's `scope`)                                            */
/* -------------------------------------------------------------------------- */

/**
 * design.md's `DateRange`, which its tool table names for
 * `get_settlement_reconciliation`'s `scope` and `get_cash_forecast`'s
 * `history_window` and **never declares**.
 *
 * Declared here as the two `DateOnly` bounds, inclusive at both ends, because that
 * is the only shape either usage can be: `scope` is Requirement 4.7's "settlement
 * date range applied to that figure", and a settlement date is a `DATE`. A finding
 * against design.md rather than an invention — there is no third field it could
 * plausibly have had.
 *
 * `from <= to` always. {@link assertDateRange} is the check.
 */
export interface DateRange {
  readonly from: DateOnly;
  readonly to: DateOnly;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** One day in milliseconds. `DateOnly` arithmetic is done in UTC, never locally. */
const MS_PER_DAY = 86_400_000;

/**
 * Requirement 4.7's window length: 90 **inclusive** dates.
 *
 * "The trailing 90 days ending at the run timestamp" over a `DATE` column is 90
 * calendar dates, the last of which is the run date, so the first is the run date
 * minus 89 days. Subtracting 90 would produce a 91-date window and would report a
 * `scope` one day wider than the figure was computed over — which Requirement 4.7
 * forbids more directly than it fixes the arithmetic, since the range it wants is
 * "the range applied to that figure".
 */
export const TRAILING_WINDOW_DAYS = 90;

/** `YYYY-MM-DD`, or a rejection naming the field. Real calendar dates only. */
export function assertDateOnlyValue(value: DateOnly, what: string): DateOnly {
  if (typeof value !== 'string' || !DATE_ONLY_RE.test(value)) {
    throw new SettlementScopeError(
      `${what} must be a date as YYYY-MM-DD, got ${JSON.stringify(value)}`,
    );
  }
  // `2026-02-30` matches the pattern and is not a date. `Date.UTC` would roll it
  // forward silently, so the round trip is what rejects it.
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new SettlementScopeError(`${what} is not a real calendar date: ${JSON.stringify(value)}`);
  }
  return value;
}

/** `from <= to`, both real dates. */
export function assertDateRange(range: DateRange, what = 'scope'): DateRange {
  assertDateOnlyValue(range.from, `${what}.from`);
  assertDateOnlyValue(range.to, `${what}.to`);
  if (range.from > range.to) {
    // Lexicographic comparison of `YYYY-MM-DD` is chronological comparison.
    throw new SettlementScopeError(
      `${what} states from ${range.from} after to ${range.to}; a settlement date range runs ` +
        `forward and an inverted one would silently examine nothing`,
    );
  }
  return range;
}

/** The UTC calendar date of an instant, as `YYYY-MM-DD`. */
export function dateOnlyOf(instant: Date): DateOnly {
  return instant.toISOString().slice(0, 10);
}

/** `date` shifted by whole days, in UTC. Never crosses a local time zone. */
export function shiftDateOnly(date: DateOnly, days: number): DateOnly {
  assertDateOnlyValue(date, 'date');
  if (!Number.isSafeInteger(days)) {
    throw new SettlementScopeError(`days must be a whole number of days, got ${String(days)}`);
  }
  return dateOnlyOf(new Date(Date.parse(`${date}T00:00:00.000Z`) + days * MS_PER_DAY));
}

/** How many inclusive dates a range covers. `{from: d, to: d}` is 1. */
export function rangeLengthInDays(range: DateRange): number {
  assertDateRange(range);
  const span = Date.parse(`${range.to}T00:00:00.000Z`) - Date.parse(`${range.from}T00:00:00.000Z`);
  return span / MS_PER_DAY + 1;
}

/**
 * Requirement 4.7's scope resolution: the stated range, or the trailing
 * {@link TRAILING_WINDOW_DAYS} days ending at the run timestamp where the request
 * states none.
 *
 * Pure and total over a validated request. Both bounds are stated together or
 * neither is: a request naming only one end has not stated a range, and guessing
 * the other end would report a `scope` the caller never asked for.
 *
 * @throws {SettlementScopeError} for a half-stated range, a malformed date, or an
 * inverted one.
 */
export function resolveSettlementScope(request: {
  readonly from?: DateOnly | undefined;
  readonly to?: DateOnly | undefined;
  /** The run timestamp. Requirement 4.7 anchors the trailing window to it. */
  readonly runAt: Date;
}): DateRange {
  const { from, to } = request;
  if (from === undefined && to === undefined) {
    const end = dateOnlyOf(request.runAt);
    return assertDateRange({ from: shiftDateOnly(end, -(TRAILING_WINDOW_DAYS - 1)), to: end });
  }
  if (from === undefined || to === undefined) {
    throw new SettlementScopeError(
      `a settlement date range states both bounds or neither; got from ` +
        `${JSON.stringify(from)} and to ${JSON.stringify(to)}. A half-stated range would be ` +
        `completed by a guess, and Requirement 4.7 reports the range actually applied`,
    );
  }
  return assertDateRange({ from, to });
}

/* -------------------------------------------------------------------------- */
/* Requirement 4.7's examined counts                                          */
/* -------------------------------------------------------------------------- */

/**
 * Requirement 4.7's examined counts: the five record types it names, per resolved
 * scope.
 *
 * Counts, not money, so every field is `number` — and none of them is named in a
 * way the ESLint money rule reads as monetary, which is deliberate: a count of
 * Payments is not an amount of Payments.
 *
 * Distinct from task 11.1's `ExaminedCounts`, which is the per-Settlement line
 * count that lands in the `settlement_reconciliations` `*_counted` columns. See the
 * module doc comment.
 */
export interface ExaminedRecordCounts {
  readonly payments_examined: number;
  readonly settlements_examined: number;
  readonly refunds_examined: number;
  readonly ledger_entries_examined: number;
  readonly razorpay_invoices_examined: number;
}

/** Every count zero: an empty scope examined nothing. */
export const NO_RECORDS_EXAMINED: ExaminedRecordCounts = {
  payments_examined: 0,
  settlements_examined: 0,
  refunds_examined: 0,
  ledger_entries_examined: 0,
  razorpay_invoices_examined: 0,
};

function assertCount(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SettlementScopeError(
      `${what} must be a non-negative whole count, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* One in-scope Settlement, as the store hands it over                        */
/* -------------------------------------------------------------------------- */

/**
 * What every Settlement_Recon_Report line carries besides its figures: the
 * Source_Record identifier the Evidence_Chain cites, and the record's update
 * timestamp, which is what `as_of` and the stale indicator are derived from.
 *
 * `line_id` is the store's, not re-derived here — see the module doc comment on the
 * recon-line identifier collision.
 */
export interface ReconLine {
  /** Cited as `{ type: 'settlement_recon_report', id: line_id }`. */
  readonly line_id: string;
  /** ISO-8601 UTC to millisecond precision, as the record stood when read. */
  readonly record_updated_at: string;
}

/** One enumerated Payment line: the amount, its Razorpay_Fee and its GST on fee. */
export interface PaymentReconLine extends ReconLine {
  readonly amount_paise: Paise;
  readonly fee_paise: Paise;
  readonly gst_on_fee_paise: Paise;
}

/** One enumerated Refund or chargeback line. */
export interface AmountReconLine extends ReconLine {
  readonly amount_paise: Paise;
}

/**
 * One enumerated adjustment line, as a **signed** value.
 *
 * `signed_amount_paise` is the ingestion-boundary projection `credit − debit` —
 * task 11.1's `signedAdjustmentPaise` — and is the field the SET-9281
 * Evidence_Chain cites as `signed_amount`. The projection is applied before this
 * seam, never inside it: design.md's twelve-step chain spends one step on
 * `sum(adjustments)` followed by `add`, with no step for a sign flip, so a signed
 * input is the only representation those twelve steps reach the Expected Amount
 * through.
 */
export interface AdjustmentReconLine extends ReconLine {
  readonly signed_amount_paise: Paise;
}

/**
 * One in-scope Settlement with every line its Settlement_Recon_Report enumerates.
 *
 * `recon_report_id` is `null` for an **absent** report and present for one that
 * enumerates 0 Payments — the only thing that distinguishes the two halves of
 * Requirement 4.13, and the distinction the row reports.
 *
 * `received_paise` is not nullable: it comes from the Settlement object, so it is
 * known even when no report exists.
 */
export interface ScopedSettlement {
  readonly settlement_id: string;
  readonly settlement_date: DateOnly;
  /** What landed in the bank. Cited as `{ type: 'settlement' }`, field `amount`. */
  readonly received_paise: Paise;
  /** ISO-8601 UTC, ms precision, as the Settlement record stood when read. */
  readonly record_updated_at: string;
  /** `null` when the Settlement_Recon_Report is absent (Requirement 4.13). */
  readonly recon_report_id: string | null;
  readonly payments: readonly PaymentReconLine[];
  readonly refunds: readonly AmountReconLine[];
  readonly chargebacks: readonly AmountReconLine[];
  readonly adjustments: readonly AdjustmentReconLine[];
  /**
   * Source_Records the store knows contribute to this Settlement and could not
   * read. Non-empty anywhere in the scope means the figure is **omitted** and
   * `incomplete_evidence` is returned instead (Requirement 12.3).
   */
  readonly unreadable?: readonly SourceRef[];
}

/**
 * Why a Settlement is `unreconciled`, which Requirement 4.13 requires reported
 * alongside the identifier: "the Settlement identifier together with the absent or
 * empty source record type".
 *
 * design.md's `SettlementRecon` carries no such field, so this is additive and
 * reported. The type is always `settlement_recon_report`; the reason is what
 * distinguishes absent from empty.
 */
export interface UnreconciledSource {
  readonly type: 'settlement_recon_report';
  readonly reason: 'absent' | 'enumerates_zero_payments';
}

/**
 * Requirement 4.13's classification, or `null` for a Settlement that reconciles.
 *
 * The two cases are distinguished by `recon_report_id`, exactly as they are on the
 * persisted `settlement_reconciliations` row.
 */
export function unreconciledSourceOf(settlement: ScopedSettlement): UnreconciledSource | null {
  if (settlement.recon_report_id === null) {
    return { type: 'settlement_recon_report', reason: 'absent' };
  }
  if (settlement.payments.length === 0) {
    return { type: 'settlement_recon_report', reason: 'enumerates_zero_payments' };
  }
  return null;
}

/**
 * A scoped Settlement's lines as task 11.1's {@link ReconReportLines}, which is
 * what `reconcileSettlement` consumes.
 *
 * `null` for an absent report, so `reconcileSettlement` takes the Requirement 4.13
 * branch without this module restating the rule. An **empty** report yields an
 * object with empty arrays, which that function's own `payments.length === 0` test
 * then classifies — the two halves of 4.13 stay distinguishable, and only one
 * module decides what `unreconciled` means.
 *
 * The projection is amounts only, by design: the identifiers the Evidence_Chain
 * needs stay on {@link ScopedSettlement} and are read by
 * `src/tools/settlement-evidence.ts`.
 */
export function reconReportLinesOf(settlement: ScopedSettlement): ReconReportLines | null {
  if (settlement.recon_report_id === null) {
    return null;
  }
  return {
    payments: settlement.payments.map((line) => line.amount_paise),
    refunds: settlement.refunds.map((line) => line.amount_paise),
    chargebacks: settlement.chargebacks.map((line) => line.amount_paise),
    adjustments: settlement.adjustments.map((line) => line.signed_amount_paise),
    fees: settlement.payments.map((line) => line.fee_paise),
    gst_on_fees: settlement.payments.map((line) => line.gst_on_fee_paise),
  };
}

/**
 * Every unreadable Source_Record across a scope, in first-mention order.
 *
 * Requirement 12.3 is scope-wide rather than per-Settlement: a total shortfall
 * figure composed from every in-scope Settlement is incomplete if *any* of them
 * could not be fully read, so one unreadable record withholds the whole figure.
 */
export function unreadableIn(
  settlements: readonly ScopedSettlement[],
): readonly SourceRef[] {
  return settlements.flatMap((settlement) => settlement.unreadable ?? []);
}

/**
 * A deterministic order over a scope: ascending settlement date, then ascending
 * identifier.
 *
 * design.md fixes an order for `get_settlement_difference_breakdown` (descending
 * absolute Difference, Requirement 4.6) and **none** for this tool. Ascending date
 * is chosen because the question is about a window; the identifier tie-break is
 * what makes the answer a function of the set rather than of the order the store
 * happened to return rows in, which Requirement 4.15's determinism needs.
 */
export function inScopeOrder(
  settlements: readonly ScopedSettlement[],
): readonly ScopedSettlement[] {
  return [...settlements].sort((a, b) => {
    if (a.settlement_date !== b.settlement_date) {
      return a.settlement_date < b.settlement_date ? -1 : 1;
    }
    if (a.settlement_id === b.settlement_id) {
      return 0;
    }
    return a.settlement_id < b.settlement_id ? -1 : 1;
  });
}

/* -------------------------------------------------------------------------- */
/* The read seam                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One scoped read. `tenant_id` comes from the session and is passed to the store
 * explicitly, never accepted as a tool argument (Requirement 12.7).
 *
 * `settlement_ids` is `null` for "every Settlement in the range" and a non-empty
 * list for the subset design.md's optional argument names. A listed identifier
 * outside the range is simply not returned: the range is the scope, and the list
 * narrows it rather than widening it.
 */
export interface SettlementScopeQuery {
  readonly tenant_id: TenantId;
  readonly scope: DateRange;
  readonly settlement_ids: readonly string[] | null;
}

/**
 * What the store answers.
 *
 * Only two of Requirement 4.7's five counts are stated here. The other three —
 * Settlements, Payments and Refunds — are **derived** from `settlements` by
 * {@link examinedCountsFor}, because they are exactly what this tool read and a
 * store-supplied count that disagreed with the rows returned would be
 * unfalsifiable. Ledger_Entries and Razorpay_Invoices have no counterpart in the
 * returned rows — Requirement 4.1's identifier matching reads them and the Expected
 * Amount does not — so those two the store must report.
 */
export interface SettlementScopeResult {
  readonly settlements: readonly ScopedSettlement[];
  /** Read for Requirement 4.1's identifier matching, not for the Expected Amount. */
  readonly ledger_entries_examined: number;
  readonly razorpay_invoices_examined: number;
}

/**
 * Where in-scope Settlements come from. Injected rather than imported, for the
 * reason in the module doc comment: there is no live adapter until task 26.1.
 *
 * Two contracts every adapter owes:
 *
 * 1. **Tenant scoping is the query's, and rows outside it do not exist.** A
 *    cross-Tenant request answers zero rows, never a permission error
 *    (Requirement 14.4).
 * 2. **Timestamps are ISO-8601 UTC to millisecond precision.** `TIMESTAMPTZ`
 *    renders in the session time zone by default, and `record_updated_at` feeds
 *    `as_of` and the stale indicator, both of which compare as strings. Select it
 *    as `to_char(x AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.
 */
export interface SettlementScopeStore {
  listInScope(query: SettlementScopeQuery): Promise<SettlementScopeResult>;
}

/**
 * Requirement 4.7's five examined counts for a resolved scope.
 *
 * Settlements, Payments and Refunds are counted from the rows actually read;
 * Ledger_Entries and Razorpay_Invoices come from the store. A Payment or Refund
 * enumerated by two reports would be counted twice, which is why the count is
 * described as "examined" rather than "distinct": it is a statement about the work
 * done, and Requirement 4.7 asks for the count examined.
 *
 * @throws {SettlementScopeError} for a negative or non-integral store count.
 */
export function examinedCountsFor(result: SettlementScopeResult): ExaminedRecordCounts {
  let payments = 0;
  let refunds = 0;
  for (const settlement of result.settlements) {
    payments += settlement.payments.length;
    refunds += settlement.refunds.length;
  }
  return {
    payments_examined: payments,
    settlements_examined: result.settlements.length,
    refunds_examined: refunds,
    ledger_entries_examined: assertCount(result.ledger_entries_examined, 'ledger_entries_examined'),
    razorpay_invoices_examined: assertCount(
      result.razorpay_invoices_examined,
      'razorpay_invoices_examined',
    ),
  };
}
