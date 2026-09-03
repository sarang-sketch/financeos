/**
 * The Reconciliation_Agent run over the settlement path (task 13.2).
 * Requirements 4.1, 4.5, 4.7, 4.12, 4.15, 15.6, 15.7, 15.10.
 *
 * This is the assembly point. Six modules were built so that this one composes them
 * and computes nothing itself:
 *
 * | Concern | Where it lives |
 * |---|---|
 * | Requirement 4.7's trailing-90-day default and the five examined counts | `@/tools/settlement-scope` — `resolveSettlementScope`, `examinedCountsFor`, `inScopeOrder` |
 * | Expected Amount, Difference, the three-way decomposition, status, direction | `./reconcile-settlement` — `reconcileSettlement` via `createSettlementReconciler` |
 * | `|residual|` and the direction an Exception carries | `./reconcile-settlement` — `residualImpactPaise`; `@/agents/exception-fingerprint` — `exceptionDirectionFor` |
 * | the Exception identity and the upsert that makes a re-run an update | `@/agents/exception-fingerprint` — `createExceptionUpserter` |
 * | Requirement 4.1's identifier-only lifecycle mapping | `./match` — `createLifecycleMatcher` |
 * | the aggregation an unreconciled Settlement is absent from | `./reconcile-settlement` — `totalShortfall` |
 *
 * **No money is computed in this file.** There is no `+`, no `-`, no `sum` and no
 * comparison of one figure against another anywhere below. The single monetary
 * decision the run makes is "is there an impact figure at all", and even that is
 * delegated: `residualImpactPaise(recon)` is `null` exactly when Requirement 4.4
 * (a zero residual) and Requirement 4.13 (an unreconciled Settlement) forbid an
 * Exception, so {@link settlementMismatchUpsertFor} returns `null` on the same test
 * and the upserter is **never called** for a Settlement that has nothing wrong with
 * it. There is no tolerance band anywhere on this path, and none can be introduced
 * here, because this module never looks at the residual's magnitude.
 *
 * ## The run reads the seams; it does **not** go through the Financial_Tool layer
 *
 * design.md's reconciliation sequence has the Agent call `get_settlement_reconciliation`
 * (T1) and `get_settlement_difference_breakdown` (T2). That is the **answer** path —
 * a User asked a question, and a figure shown to a User must arrive inside a
 * `ToolResult` with a resolvable Evidence_Chain. It is task 13.4's path. The **run**
 * below reads `SettlementScopeStore` directly, for four reasons, in the order they
 * decided it:
 *
 * 1. **`ToolResult` cannot express a partial result, and Requirement 15.6 requires
 *    one.** `tool.ts` is explicit that on overrun "no partial output reaches the
 *    caller": the envelope becomes `{ kind: 'tool_failure', cause: 'timeout' }` with
 *    no `value` at all. A run assembled out of tool invocations could therefore only
 *    ever report *nothing* for an overrun, which is the exact opposite of "return the
 *    partial results computed so far, identify the run as incomplete, and identify
 *    which Source_Record types were not fully processed".
 * 2. **The tool's output cannot describe the row the run has to write.**
 *    `settlement_reconciliations` carries the four per-Settlement `*_counted` columns
 *    and `recon_report_id`; `get_settlement_reconciliation`'s `Out` carries neither
 *    the four counts nor the report lines they are counted from — its `examined` is
 *    Requirement 4.7's five *scope-wide* record types. Writing the row from the tool's
 *    output would mean writing `0` for every count, which is a false statement about
 *    what was examined, on a column whose whole purpose is to state it.
 * 3. **The tool is `read_only` by declaration and the run writes.** The invoker
 *    acquires the connection for the declared mode, and the run's product is two sets
 *    of rows: `settlement_reconciliations` (Requirement 4.4's "record against the
 *    Settlement identifier") and `exceptions` (Requirement 4.5). Routing writes
 *    through a `read_only` invocation would make the declared mode a fiction.
 * 4. **It is the same seam either way.** `get_settlement_reconciliation` reads
 *    `SettlementScopeStore` too, and neither route has a live adapter: every
 *    settlement table is RLS `ENABLE`d **and** `FORCE`d with no policies until task
 *    26.1, so a PostgREST adapter written today would answer zero rows for every
 *    Tenant and the run would silently reconcile nothing. Injecting the seam is what
 *    lets 26.x supply the adapter without this file changing.
 *
 * The cost is stated rather than hidden: **the run composes no Evidence_Chain.** Chain
 * composition belongs to the Financial_Tool that produced the figure
 * (`evidence_chains.produced_by` names a tool, and only the tool holds the per-line
 * Source_Record identifiers and `record_updated_at` values a citation needs — see the
 * doc comments on `reconcile-settlement.ts` and `settlement-scope.ts`). So
 * `evidence_chain_id` is an **input** here, through
 * {@link ReconciliationAgentDeps.evidenceChainFor}, which answers `null` by default.
 * A run with no chain resolver writes reconciliation rows and Exceptions whose
 * `evidence_chain_id` is `NULL`, and the consequence is real: `get_exception_evidence`
 * (task 12.5) has nothing to follow for those Exceptions until 13.4 wires the tool's
 * per-row chain identifiers in. A fabricated chain would be worse — it would be an
 * unreplayable figure wearing a chain, which is the one thing Requirement 12.8
 * forbids — so the field is left null and the gap is reported.
 *
 * ## The 120-second bound, and the tool layer's 10-second bound
 *
 * Two different bounds over two different things, and they nest:
 *
 * | Bound | Over | Where enforced | On overrun |
 * |---|---|---|---|
 * | {@link RUN_BUDGET_MS} = 120 s | one **Agent run** | here | stop, return the partial report, `incomplete` names the stage and the Source_Record types (Requirement 15.6) |
 * | `TOOL_TIMEOUT_MS` = 10 s | one **tool invocation** | `src/tools/tool.ts` | `tool_failure` cause `timeout`, connection released `rollback`, no value (Requirement 12.11) |
 * | {@link COMPLETE_SET_BUDGET_MS} = 60 s | a run over ≤ 5000 Payments | measured and reported here, **not** enforced | reported, never a reason to stop (Requirement 15.3, 15.10) |
 *
 * The run's budget is the outer one, and 120 s admits at most twelve sequential tool
 * invocations at their own bound — which is why a run cannot treat a tool timeout as
 * its own. **How a tool timeout inside a run is handled** (the case 13.4 will meet,
 * since it invokes T1 and T2): a `tool_failure` is *not* propagated as a run failure
 * and *not* retried inside the run. It is treated exactly as an unreadable
 * Source_Record is treated below — the figures that invocation would have produced are
 * omitted, the Source_Record types that tool reads go into
 * {@link RunIncompleteness.types_not_fully_processed}, and the run returns its partial
 * report flagged incomplete. The reasoning is Requirement 15.6's: a run that lost one
 * of its inputs has partial results to report, and reporting them as a failure would
 * discard work a User can act on.
 *
 * What the bound **guarantees**: no unit of work is *begun* at or after the deadline,
 * and the report distinguishes what was done from what was not. What it **cannot**
 * guarantee is the same limitation `tool.ts` states honestly: JavaScript has no
 * preemption, so a single unit already in flight is not interrupted and the run
 * returns after it finishes. The bound is therefore "the deadline plus at most one
 * unit", and a unit here is one Settlement, so the overshoot is bounded by the slowest
 * single-Settlement read. {@link SettlementScopeStore} takes no `AbortSignal` — the
 * seam has no such parameter — so there is nothing to cancel the read with, and no
 * comment here pretends otherwise.
 *
 * ## The ordering rule, in full
 *
 * Requirement 4.15 and Requirement 15.7 require a re-run over an unchanged dataset to
 * reproduce the identical Exception set in the identical order. Every order below is
 * **total** — no comparator can return 0 for two distinct rows — and every one of them
 * is a function of the *set* read, never of the order the store returned it in:
 *
 * 1. **Settlements** are reconciled in `inScopeOrder`: ascending `settlement_date`,
 *    then ascending `settlement_id`. Total because a duplicate `settlement_id` in one
 *    scope is **rejected** ({@link ReconciliationRunError}) rather than merged — two
 *    rows for one Settlement would make the order depend on arrival and would
 *    double-count the Settlement in `totalShortfall`.
 * 2. **Exceptions** are upserted, and reported, in {@link compareSettlementMismatch}
 *    order: descending `impact_paise`, then ascending `settlement_date`, then ascending
 *    `settlement_id`. Descending impact mirrors Requirement 4.6's descending absolute
 *    Difference and the Attention_Panel's impact ordering, so the run's own order and
 *    the order a User sees do not disagree; the date and identifier tie-breakers are
 *    what make it total, and they are the ones that matter, because two Settlements
 *    with the identical unexplained residual are exactly the case a single-key sort
 *    gets wrong. Ascending identifier is the house tie-break — `canonicalSourceRefs`,
 *    `inScopeOrder`, `canonicalLinkIds`, `unsettledPaymentsInOrder`.
 * 3. **Source_Record refs inside one Exception** are canonicalised by
 *    `canonicalSourceRefs` (ascending type, then ascending id) before hashing, so the
 *    fingerprint is a function of the ref *set*.
 * 4. **Lifecycle matches** are ascending Payment identifier, `matchLifecycle`'s order.
 *    {@link LifecycleRunReport.matched_payment_order} is built with
 *    `lifecycleMatchOrderKey` so the run's stated order is that module's rule rather
 *    than a second copy of it, and task 13.3's P5 can compare two runs without
 *    restating either.
 * 5. **The in-scope Payment set** handed to the matcher is deduplicated and ascending
 *    (`canonicalLinkIds`), so the query is a function of the set.
 * 6. **Identifier lists in the report** — `settlements_not_reconciled`,
 *    `payments_not_read`, the three lists on `TotalShortfall` — are ascending.
 *
 * Nothing here reads a random source, and the clock is read **once** per run:
 * `run_at` is the single instant every Exception is stamped `detected_at` with
 * (Requirement 4.15 names the run timestamp), and the deadline is measured from it.
 *
 * ## Why the settlement path finishes before the lifecycle mapping
 *
 * Stage order is {@link RUN_STAGES}: `resolve_scope`, `read_scope`, `reconcile`,
 * `detect_exceptions`, `match_lifecycle`. Requirement 4.1 is listed first in the
 * requirement and is run **last** here, deliberately: Requirement 15.3 measures "the
 * complete Exception set", so the Exception set is the run's product and a budget stop
 * should cost the mapping rather than the Exceptions.
 *
 * Nothing depends on the reverse order. Requirement 4.11 excludes an unsettled Payment
 * "from every Settlement Expected Amount and Difference computation in that run", and
 * that exclusion is **structural rather than sequential**: Expected Amount reads only
 * the lines the Settlement_Recon_Report enumerates (Requirement 4.2), so a Payment no
 * report enumerates contributes to no Expected Amount whatever order the stages run in.
 *
 * ## An `unreconciled` Settlement is not a mismatch
 *
 * Requirement 4.13's Settlement — report absent, or report enumerating 0 Payments —
 * produces a `settlement_reconciliations` row with `status = 'unreconciled'`, all five
 * figures `NULL`, `direction = 'not_applicable'`, and an
 * {@link SettlementRunRow.unreconciled_source} stating which of the two cases it is.
 * It produces **no Exception**, and that is not a policy choice made here — it falls
 * out of `residualImpactPaise(recon)` being `null` when `residual_paise` is `null`.
 *
 * The reason it must not be a `settlement_mismatch` is that the two say opposite
 * things. A mismatch is *"the Difference was computed and ₹x of it is unexplained"*; an
 * unreconciled Settlement is *"no Difference was computed at all"*. Raising a
 * `settlement_mismatch` for it would have to invent an impact — `0n` would claim
 * nothing is missing, and the received amount would claim the whole settlement is
 * unexplained — and either figure would then be summed into a total shortfall the
 * Settlement is required to be **excluded** from (Requirement 4.13, and `totalShortfall`
 * keeps it in `unreconciled_settlement_ids` instead). What it *is*, is a missing input:
 * reported against the Settlement identifier with the absent-or-empty source record
 * type, and `settlement_recon_report` is named in
 * {@link RunIncompleteness.types_not_fully_processed} only when a record was genuinely
 * unread — an absent report is a **fact about the Tenant's data**, not a failure of the
 * run, so it does not flag the run incomplete.
 *
 * ## Read, and not read at all — three facts the report keeps apart
 *
 * `payments_not_read`, `unreadable` and `not_reopened` are all things a lesser run
 * report would drop, and each one is a fact a User can be told:
 *
 * - **`not_reopened`** (Requirement 4.15). The upsert is scoped
 *   `WHERE lifecycle_state = 'open'`, so re-detecting a condition a User resolved
 *   touches no row and `ExceptionUpserter.upsert` answers
 *   {@link ExceptionNotReopened}. That is a re-detection, not a silent discard:
 *   {@link ExceptionRunReport.not_reopened} carries every one of them with the existing
 *   Exception identifier and its lifecycle state, and
 *   {@link ExceptionRunReport.not_reopened_count} is in the run summary, so "why is
 *   this not in my Attention_Panel?" has an answer.
 * - **`payments_not_read`** (`./match`'s distinction). A Payment whose four record
 *   types are all `not_matched` is a read fact. A Payment the store returned no row for
 *   is *not a fact about links* — another Tenant's, deleted, or unread — and reporting
 *   the second as the first would present a partial mapping as a complete one. It flags
 *   the run incomplete with reason `payments_not_read` and puts `payment` in the types
 *   not fully processed.
 * - **`unreadable`** (Requirement 12.3). A Settlement with any unreadable contributing
 *   record is **not reconciled at all** — no row, no Exception — and is listed in
 *   {@link ReconciliationRunReport.withheld}. Reconciling from a report with an unread
 *   line would produce a confidently wrong Expected Amount, which is the failure mode
 *   the whole Evidence_Chain apparatus exists to prevent. The tool withholds the figure
 *   for the same reason; the run withholds the row.
 *
 * ## An empty scope is a fact, not a failure
 *
 * Four tools refuse an empty window as `tool_failure` / `execution_error`, because
 * `evidence_chains.source_count >= 1` makes an ungrounded `0n` unstorable and
 * `incomplete_evidence` would be a lie when nothing was unreadable. **The run does not
 * inherit that refusal**, because it composes no chain and returns no `ToolResult`: it
 * reports zero examined records, an empty Exception set and a `complete` run. The
 * distinction is exactly right — "your window contains nothing" is a true and useful
 * answer about a *run*, while a *figure* citing nothing is not storable. The matcher is
 * not called at all in that case: `LifecycleMatcher.match` rejects an empty request by
 * design, since "match nothing" would report a mapping of zero Payments as a successful
 * mapping of the run.
 *
 * ## Reported, not silently patched
 *
 * 1. **The recon-line identifier collision reaches this module as the Payment set.**
 *    A combined Settlement_Recon_Report line keys on `entity_id`, which *is* the settled
 *    entity's identifier, so a payment line's identifier **is** the Payment identifier —
 *    which is precisely why {@link inScopePaymentIds} can derive the run's in-scope
 *    Payment set from `ScopedSettlement.payments[].line_id` at all, and it is the only
 *    stored Payment → Settlement link there is (13.1's finding 1: the Payment payload
 *    carries no `settlement_id`, so `razorpay_payment_settlement_link_idx` indexes an
 *    expression that is `NULL` for every row). The collision needs a
 *    `(tenant_id, object_type, razorpay_id)` key and a migration, and it is not fixed
 *    here. **How this run behaves under it**, which task 16.1's "run status completed"
 *    assertion needs: the run **completes**. The collision is an ingestion-side identity
 *    problem, not a read failure — the scope read still returns the Settlement and its
 *    lines, so every figure is computed and every Exception is upserted. What it can
 *    cost is the *mapping*: where a Payment's `razorpay_objects` row was lost to its
 *    recon line, `LifecycleLinkStore.readLinks` returns no entry for it and the Payment
 *    lands in `payments_not_read`, which flags the run incomplete for that reason and
 *    for no other. So 16.1 can assert a completed run and a full Exception set while
 *    the mapping is honestly reported as partial; it cannot assert a complete lifecycle
 *    mapping until the migration lands.
 * 2. **Requirement 15.10 measures "the Tenant dataset" and a run sees only its scope.**
 *    The run reports {@link ReconciliationRunReport.payments_processed} — the distinct
 *    in-scope Payment identifiers it resolved — and reads the 5000-Payment threshold
 *    against that. A Tenant holding more than 5000 Payments outside the resolved window
 *    is not something this run measured, and inventing a whole-dataset count would mean
 *    a second read the requirement does not ask for. Stated on
 *    {@link ReconciliationRunReport.complete_set_bound_applies}.
 * 3. **Requirement 15.10 and Requirement 15.6 pull in opposite directions.** 15.10 says
 *    a run over more than 5000 Payments "SHALL process every Payment"; 15.6 says a run
 *    reaching 120 seconds "SHALL stop". Read together, 15.10 disapplies the
 *    **60-second** bound of 15.3 and not the 120-second bound of 15.6 — the 120 s bound
 *    is unconditional, and a large dataset relaxes how long a *complete* run may take,
 *    not whether the run may be stopped. Implemented that way: the 60 s figure is
 *    measured and reported, never enforced.
 * 4. **design.md declares no shape for any of this.** Its Reconciliation_Agent section
 *    is one paragraph and its sequence diagram stops at "create or update settlement
 *    mismatch Exceptions where residual != 0". Every interface below is this module's,
 *    chosen so each clause of Requirements 4.7, 15.6, 15.7 and 15.10 is representable
 *    exactly once.
 * 5. **The run rejects an out-of-scope Settlement**, which `get_settlement_reconciliation`
 *    does not. `SettlementScopeStore`'s contract is that the range *is* the scope and a
 *    named identifier outside it is simply not returned; a row whose `settlement_date`
 *    falls outside the resolved range would make {@link ReconciliationRunReport.scope}
 *    a false statement about what Requirement 4.7 calls "the settlement date range
 *    applied to that figure". Rejected rather than filtered, because filtering would
 *    hide an adapter that does not implement its own contract.
 *
 * ## Scope — the line drawn with each sibling
 *
 * - **Task 13.3** owns property P5. No property test is written here. What is written
 *   is a run whose determinism P5 can *observe*: {@link compareSettlementMismatch} is
 *   exported so the comparison does not restate the ordering rule,
 *   {@link settlementMismatchUpsertFor} is pure so the identity can be computed without
 *   a store, {@link ExceptionRunReport.order} is the upsert order as issued, and
 *   {@link LifecycleRunReport.matched_payment_order} is built with
 *   `lifecycleMatchOrderKey`.
 * - **Task 13.4** owns Requirement 4.6's answer — the 50 rows by descending absolute
 *   Difference plus the aggregate remainder. **Nothing here presents anything**:
 *   {@link ReconciliationRunReport.settlements} is every in-scope row in
 *   `inScopeOrder`, unlimited and unsliced, and `shortfall` is 11.1's aggregation. 13.4
 *   builds the view, and takes the tool route for the Evidence_Chains a User-facing
 *   figure needs.
 * - **Task 13.5** owns the remaining detectors — duplicate Refunds (4.8), Unmatched
 *   Credit_Notes (4.9), missing accruals (4.10) and `ambiguous_match` (4.14). This run
 *   raises **`settlement_mismatch` and nothing else**. What it hands over is
 *   representation, not detection: {@link LifecycleRunReport.ambiguous_payment_ids} from
 *   `isAmbiguousMatch`, {@link LifecycleRunReport.not_matched_counts} from
 *   `notMatchedTypes` (whose `ledger_entries` entry is Requirement 4.10's condition
 *   exactly), and `matched` itself, from which `ambiguousCandidateRefs` produces 4.14's
 *   refs.
 * - **Task 16.1** owns the end-to-end demo assertions. See finding 1 for how this run
 *   behaves under the identifier collision.
 * - **Task 26.x** owns the RLS policies and every live adapter. There is no PostgREST
 *   adapter here for any of the four seams.
 */

import { randomUUID } from 'node:crypto';

import {
  createExceptionUpserter,
  type ExceptionDetail,
  type ExceptionDirection,
  exceptionDirectionFor,
  type ExceptionNotReopened,
  type ExceptionSourceRef,
  type ExceptionStore,
  type ExceptionUpsertInput,
  type ExceptionUpsertResult,
} from '@/agents/exception-fingerprint';
import type { Paise } from '@/calc/calculation-service';
import type { TenantId } from '@/config/configuration-service';
import {
  type DateOnly,
  SOURCE_RECORD_TYPES,
  type SourceRecordType,
  type SourceRef,
} from '@/ledger/posting-rules';
import {
  type DateRange,
  type ExaminedRecordCounts,
  examinedCountsFor,
  inScopeOrder,
  NO_RECORDS_EXAMINED,
  reconReportLinesOf,
  resolveSettlementScope,
  type ScopedSettlement,
  type SettlementScopeStore,
  type UnreconciledSource,
  unreconciledSourceOf,
} from '@/tools/settlement-scope';
import { toWire } from '@/wire/paise-wire';

import {
  canonicalLinkIds,
  createLifecycleMatcher,
  isAmbiguousMatch,
  type LifecycleLinkStore,
  type LifecycleRecordType,
  lifecycleMatchOrderKey,
  notMatchedTypes,
  type PaymentLifecycleMatch,
} from './match';
import {
  createSettlementReconciler,
  type ExaminedCounts,
  residualImpactPaise,
  type SettlementRecon,
  type SettlementReconStore,
  totalShortfall,
  type TotalShortfall,
} from './reconcile-settlement';

/* -------------------------------------------------------------------------- */
/* Bounds                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Requirement 15.6's wall-clock bound on one Agent run, in milliseconds.
 *
 * The **outer** bound. `TOOL_TIMEOUT_MS` (10 s) bounds one tool invocation and nests
 * strictly inside this one — 120 s admits at most twelve sequential invocations at
 * their own bound. See the module doc comment for how a tool timeout inside a run is
 * handled.
 */
export const RUN_BUDGET_MS = 120_000;

/**
 * Requirement 15.3's bound for returning the **complete** Exception set over a dataset
 * of up to {@link LARGE_DATASET_PAYMENT_COUNT} Payments.
 *
 * Measured and reported ({@link ReconciliationRunReport.complete_set_bound_applies},
 * {@link ReconciliationRunReport.elapsed_ms}), never enforced: Requirement 15.6's
 * 120-second bound is the only one that stops a run. See finding 3.
 */
export const COMPLETE_SET_BUDGET_MS = 60_000;

/** Requirement 15.3 / 15.10's threshold. Above this the 60-second bound does not apply. */
export const LARGE_DATASET_PAYMENT_COUNT = 5000;

/* -------------------------------------------------------------------------- */
/* Stages, and the Source_Record types each one processes                     */
/* -------------------------------------------------------------------------- */

/**
 * The stages of a settlement-path run, in execution order.
 *
 * Requirement 4.1's `match_lifecycle` is **last**; see the module doc comment for why
 * the Exception set is completed first.
 */
export const RUN_STAGES = [
  'resolve_scope',
  'read_scope',
  'reconcile',
  'detect_exceptions',
  'match_lifecycle',
] as const;

export type RunStage = (typeof RUN_STAGES)[number];

/**
 * Which `source_record_type` labels each stage reads, so Requirement 15.6's "identify
 * which Source_Record types were not fully processed" is derivable from *where* the run
 * stopped rather than guessed at.
 *
 * Two transcription notes, both honest rather than convenient:
 *
 * - **A chargeback has no enum label.** The 13 `source_record_type` labels include no
 *   `chargeback` and no `dispute`. Chargeback amounts are enumerated *by the
 *   Settlement_Recon_Report*, so `settlement_recon_report` is the label that covers
 *   them, and no label is invented.
 * - **A Ledger_Entry has no enum label either** (13.1's finding 4): the enum has
 *   `ledger_entry_set` and an entry identifier is a `ledger_entries.id` UUID rather
 *   than a Razorpay identifier. `match_lifecycle` reads `ledger_entry_sources`, so
 *   `ledger_entry_set` is the closest true statement in the vocabulary the requirement
 *   has to be answered in.
 */
export const STAGE_SOURCE_RECORD_TYPES: Readonly<Record<RunStage, readonly SourceRecordType[]>> =
  Object.freeze({
    // Pure: `resolveSettlementScope` reads a request and a clock, and no record.
    resolve_scope: [],
    read_scope: ['settlement', 'settlement_recon_report', 'payment', 'refund'],
    reconcile: ['settlement', 'settlement_recon_report'],
    detect_exceptions: ['settlement', 'settlement_recon_report'],
    match_lifecycle: ['payment', 'order', 'razorpay_invoice', 'settlement', 'ledger_entry_set'],
  });

/**
 * The Source_Record types a run stopped at `stage` did not fully process: every type
 * `stage` itself reads, plus every type each later stage reads.
 *
 * Sorted into `SOURCE_RECORD_TYPES` declaration order — the same order the enum
 * compares in — so the list is a function of the stage and not of the iteration.
 */
export function typesNotFullyProcessedFrom(stage: RunStage): readonly SourceRecordType[] {
  const from = RUN_STAGES.indexOf(stage);
  const types = new Set<SourceRecordType>();
  for (const later of RUN_STAGES.slice(from)) {
    for (const type of STAGE_SOURCE_RECORD_TYPES[later]) {
      types.add(type);
    }
  }
  return sortSourceRecordTypes(types);
}

/** The three reasons a run can be incomplete, in the order they are reported. */
export const RUN_INCOMPLETE_REASONS = [
  'wall_clock_budget',
  'unreadable_source_records',
  'payments_not_read',
] as const;

export type RunIncompleteReason = (typeof RUN_INCOMPLETE_REASONS)[number];

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Thrown when a run cannot be performed as stated: an unscoped session, a store that
 * answers outside the scope it was asked for, or a duplicate Settlement.
 *
 * A **fault**, never an outcome. Every expected outcome of a run — an empty scope, a
 * stopped run, an unreadable record, a re-detected closed Exception — is a field of
 * {@link ReconciliationRunReport}, so a caller never has to catch anything to learn
 * what happened.
 */
export class ReconciliationRunError extends Error {
  override readonly name = 'ReconciliationRunError';
}

/* -------------------------------------------------------------------------- */
/* The request                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What a run is asked for.
 *
 * Both range bounds are stated together or neither is — a half-stated range is
 * rejected by `resolveSettlementScope` rather than completed by a guess. Absent, the
 * scope is Requirement 4.7's trailing 90 days ending at the run timestamp.
 *
 * There is no `tenant_id`: the Tenant is bound once at construction from the session
 * (Requirement 12.7, 14.10), so a cross-Tenant run is not denied, it is
 * unrepresentable.
 */
export interface ReconciliationRunRequest {
  readonly from?: DateOnly | undefined;
  readonly to?: DateOnly | undefined;
  /** `null` or absent for every Settlement in the range; a list narrows it. */
  readonly settlement_ids?: readonly string[] | null | undefined;
}

/* -------------------------------------------------------------------------- */
/* The report                                                                 */
/* -------------------------------------------------------------------------- */

/** One in-scope Settlement as the run left it. */
export interface SettlementRunRow {
  readonly settlement_id: string;
  readonly settlement_date: DateOnly;
  /** `null` when the Settlement_Recon_Report is absent (Requirement 4.13). */
  readonly recon_report_id: string | null;
  /** Task 11.1's result: the six figures, the status and the direction. */
  readonly recon: SettlementRecon;
  /** The four per-Settlement line counts that landed in the `*_counted` columns. */
  readonly examined: ExaminedCounts;
  /** Requirement 4.13's absent-or-empty source record type. `null` when it reconciled. */
  readonly unreconciled_source: UnreconciledSource | null;
  /** The `settlement_reconciliations` row this run upserted. */
  readonly reconciliation_id: string;
  /** `false` when a previous run's row was updated rather than a new one written. */
  readonly created: boolean;
}

/** A Settlement the run did not reconcile, and why. */
export interface WithheldSettlement {
  readonly settlement_id: string;
  readonly reason: 'unreadable_source_records';
  /** The contributing records the store could not read (Requirement 12.3). */
  readonly unreadable: readonly SourceRef[];
}

/**
 * One detected `settlement_mismatch` condition and what the upsert did with it.
 *
 * `impact_paise` is `residualImpactPaise(recon)` — `|residual|` — and `direction` is
 * `exceptionDirectionFor(recon.direction)`. Neither is computed in this module.
 */
export interface SettlementMismatchDetection {
  readonly settlement_id: string;
  readonly settlement_date: DateOnly;
  readonly recon_report_id: string;
  /** `|residual|`, always `> 0n` — a zero residual raises nothing (Requirement 4.4). */
  readonly impact_paise: Paise;
  readonly direction: ExceptionDirection;
  /** Requirement 4.5's two refs: the Settlement and the Settlement_Recon_Report. */
  readonly source_refs: readonly ExceptionSourceRef[];
  /** Created, updated in place, or re-detected and not reopened (Requirement 4.15). */
  readonly outcome: ExceptionUpsertResult;
}

/**
 * What the run's Exception half did.
 *
 * `not_reopened` is carried in full rather than counted away: it is the fact that a
 * condition still holds against an Exception a User closed, which is the answer to
 * "why is this not in my Attention_Panel?".
 */
export interface ExceptionRunReport {
  /** Every detection, in {@link compareSettlementMismatch} order. */
  readonly detections: readonly SettlementMismatchDetection[];
  /** The Settlement identifiers in upsert order, as issued. Determinism, observable. */
  readonly order: readonly string[];
  readonly created_count: number;
  /** An existing **open** Exception updated with this run's impact and timestamp. */
  readonly updated_count: number;
  /** Re-detected against a `resolved` or `dismissed` Exception. Left untouched. */
  readonly not_reopened_count: number;
  readonly not_reopened: readonly ExceptionNotReopened[];
}

/** Requirement 4.1's mapping for the run's in-scope Payments. */
export interface LifecycleRunReport {
  /** Distinct in-scope Payment identifiers the run resolved from the report lines. */
  readonly payments_in_scope: number;
  /** Ascending Payment identifier (`matchLifecycle`'s total order). */
  readonly matched: readonly PaymentLifecycleMatch[];
  /** The same order, keyed by `lifecycleMatchOrderKey`, so P5 need not restate it. */
  readonly matched_payment_order: readonly string[];
  /** Requested Payments the store returned no links entry for. Ascending. */
  readonly payments_not_read: readonly string[];
  /** Passed through from the store (Requirement 15.6). */
  readonly unreadable: readonly SourceRef[];
  /** How many Payments carry a not-matched marker, per record type. */
  readonly not_matched_counts: Readonly<Record<LifecycleRecordType, number>>;
  /** Requirement 4.14's Payments. Task 13.5 raises the Exceptions; this only reports. */
  readonly ambiguous_payment_ids: readonly string[];
}

/** Requirement 15.6: what a run that did not finish did not finish. */
export interface RunIncompleteness {
  /** In {@link RUN_INCOMPLETE_REASONS} order. Never empty. */
  readonly reasons: readonly RunIncompleteReason[];
  /** The stage the wall-clock bound stopped, or `null` when the bound was not reached. */
  readonly stopped_at_stage: RunStage | null;
  readonly elapsed_ms: number;
  /** Requirement 15.6's named types, in `SOURCE_RECORD_TYPES` order. */
  readonly types_not_fully_processed: readonly SourceRecordType[];
  /** In-scope Settlements with no reconciliation row from this run. Ascending. */
  readonly settlements_not_reconciled: readonly string[];
  /** In-scope Payments the link store returned nothing for. Ascending. */
  readonly payments_not_read: readonly string[];
  /** Every unreadable contributing record, from both the scope read and the matcher. */
  readonly unreadable: readonly SourceRef[];
}

/**
 * The whole run, as a value. Requirement 15.6's partial result and a complete run are
 * the **same shape**: `incomplete` is `null` for one and populated for the other, so a
 * caller cannot read a partial report as a complete one by forgetting to check a flag
 * it did not know about.
 */
export interface ReconciliationRunReport {
  /** The run that computed every row and stamped every Exception. A UUID. */
  readonly run_id: string;
  /** The run timestamp, ISO-8601 UTC to the millisecond. Read once. */
  readonly run_at: string;
  /** Requirement 4.7's applied settlement date range: stated, or trailing 90 days. */
  readonly scope: DateRange;
  /** Requirement 4.7's five record types. */
  readonly examined: ExaminedRecordCounts;
  /**
   * Requirement 15.10's count: distinct Payment identifiers whose Settlement this run
   * actually reconciled. A Payment on a withheld or unreached Settlement is **not**
   * counted, so the figure never claims work the run did not do; the resolved in-scope
   * total is {@link LifecycleRunReport.payments_in_scope}. See finding 2.
   */
  readonly payments_processed: number;
  /** `false` above {@link LARGE_DATASET_PAYMENT_COUNT} Payments (Requirement 15.10). */
  readonly complete_set_bound_applies: boolean;
  /** Every reconciled Settlement, in `inScopeOrder`. Unsliced — 13.4 owns the view. */
  readonly settlements: readonly SettlementRunRow[];
  /** In-scope Settlements deliberately not reconciled (Requirement 12.3). */
  readonly withheld: readonly WithheldSettlement[];
  /** Task 11.1's aggregation, both directions kept apart and neither netted. */
  readonly shortfall: TotalShortfall;
  readonly exceptions: ExceptionRunReport;
  readonly lifecycle: LifecycleRunReport;
  /** `null` for a complete run (Requirement 15.6). */
  readonly incomplete: RunIncompleteness | null;
  readonly elapsed_ms: number;
}

/* -------------------------------------------------------------------------- */
/* Pure: the in-scope Payment set                                             */
/* -------------------------------------------------------------------------- */

/**
 * The run's in-scope Payment identifiers, from the Payment lines the in-scope
 * Settlement_Recon_Reports enumerate. Deduplicated and ascending, so the matcher's
 * query is a function of the set.
 *
 * `PaymentReconLine.line_id` **is** the Payment identifier: a combined recon line keys
 * on `entity_id`, which is the settled entity's own identifier. That is the collision
 * recorded as finding 1 in the module doc comment, and it is also the only stored
 * Payment → Settlement link there is. Nothing is inferred: no amount and no date is
 * read here, and a Payment appears in the set only because a report line names it.
 *
 * @throws {ReconciliationRunError} for a line identifier that cannot be carried as a
 * Source_Record identifier — the same rule `assertRefIdentifier` applies, applied once.
 */
export function inScopePaymentIds(
  settlements: readonly ScopedSettlement[],
): readonly string[] {
  const ids = settlements.flatMap((settlement) =>
    settlement.payments.map((line) => line.line_id),
  );
  return canonicalIdentifiers(ids, 'in-scope payment line identifiers');
}

/* -------------------------------------------------------------------------- */
/* Pure: the Exception, and its order                                         */
/* -------------------------------------------------------------------------- */

/** Everything {@link settlementMismatchUpsertFor} needs that is not the reconciliation. */
export interface SettlementMismatchContext {
  readonly recon: SettlementRecon;
  readonly settlement_date: DateOnly;
  /** `null` only for an unreconciled Settlement, which raises no Exception. */
  readonly recon_report_id: string | null;
  readonly examined: ExaminedCounts;
  /** Requirement 4.7's applied range. Recorded in `detail`, **never** in the identity. */
  readonly scope: DateRange;
  readonly run_id: string;
  /** The run timestamp, ISO-8601 UTC ms (Requirement 4.15). */
  readonly detected_at: string;
  /** The chain a Financial_Tool composed for these figures, or `null`. */
  readonly evidence_chain_id: string | null;
}

/**
 * Requirement 4.5's `settlement_mismatch` Exception for one Settlement, or **`null`
 * where no Exception is due**.
 *
 * The gate is `residualImpactPaise(recon)`, and it is the only monetary test in this
 * file: it is `null` exactly when the residual is `0n` (Requirement 4.4 — "difference
 * explained", exactly zero, no tolerance band) or `null` (Requirement 4.13 — an
 * unreconciled Settlement). A `null` return means the upserter is not called at all,
 * which is how Requirement 4.4's "create no Exception" is satisfied structurally rather
 * than by a filter somewhere downstream.
 *
 * Pure and total. No clock, no store, no run — everything it needs is an argument, so
 * task 13.3 can compute an identity without a database.
 *
 * The **identity** is the category and the two refs, and nothing else: the applied
 * scope travels in `detail`, outside the fingerprint, because `settlement_mismatch` is
 * not a range-scoped category (Requirement 4.15) and hashing the window would open a
 * second Exception for one condition every time the trailing 90 days moved.
 *
 * @throws {ReconciliationRunError} when a reconciled Settlement carries no report
 * identifier, which Requirement 4.5 requires the Exception to reference. Unreachable
 * through a run — `reconReportLinesOf` answers `null` for an absent report, and
 * `reconcileSettlement` then classifies the Settlement `unreconciled` — so reaching it
 * means the figures and the report identifier came from different places.
 */
export function settlementMismatchUpsertFor(
  context: SettlementMismatchContext,
): ExceptionUpsertInput | null {
  const { recon } = context;
  // The whole of Requirement 4.4 and Requirement 4.13, in one delegated call.
  const impactPaise = residualImpactPaise(recon);
  if (impactPaise === null) {
    return null;
  }

  const reconReportId = context.recon_report_id;
  if (reconReportId === null) {
    throw new ReconciliationRunError(
      `${recon.settlement_id} has an unexplained residual but no Settlement_Recon_Report ` +
        `identifier; Requirement 4.5 requires the Exception to reference both, and a Settlement ` +
        `with no report is unreconciled (Requirement 4.13) and raises no Exception at all`,
    );
  }

  return {
    category: 'settlement_mismatch',
    // Requirement 4.5's two references. Requirement 4.12's "at least 1" is satisfied
    // twice over; `canonicalSourceRefs` sorts them before hashing.
    source_refs: [
      { type: 'settlement', id: recon.settlement_id, role: 'settlement' },
      { type: 'settlement_recon_report', id: reconReportId, role: 'recon_report' },
    ],
    // `|residual|`, from task 11.1. The sign lives in `direction`.
    impact_paise: impactPaise,
    // The one mapping between `ResidualDirection` and the labels the column admits.
    direction: exceptionDirectionFor(recon.direction),
    detail: mismatchDetail(context, reconReportId),
    evidence_chain_id: context.evidence_chain_id,
    detected_at: context.detected_at,
  };
}

/**
 * `exceptions.detail`: design.md's "named fields, failing rule, counts", for a
 * `settlement_mismatch`.
 *
 * Every monetary field is the integer string `toWire` produced, which range-checked it
 * — JSONB would keep a `number` as an IEEE-754 double and nothing downstream could
 * recover the paisa (Requirement 15.1, 15.8), and `assertExceptionUpsertable` rejects a
 * money-named key holding a number. The residual is carried **signed** so the
 * direction is recoverable from the payload alone, while `impact_paise` on the row
 * stays the magnitude the column is CHECKed for.
 *
 * All of it is outside the fingerprint, so a re-run is free to rewrite every field
 * (Requirement 4.15).
 */
function mismatchDetail(
  context: SettlementMismatchContext,
  reconReportId: string,
): ExceptionDetail {
  const { recon, examined } = context;
  const figures = requireFigures(recon);
  return {
    failing_rule: 'unexplained_residual_nonzero',
    // Signed, so `detail` alone states which way the residual points.
    residual_paise: toWire(figures.residual),
    residual_direction: recon.direction,
    difference_paise: toWire(figures.difference),
    fee_component_paise: toWire(figures.fee),
    gst_component_paise: toWire(figures.gst),
    expected_paise: toWire(figures.expected),
    received_paise: toWire(recon.received_paise),
    settlement_date: context.settlement_date,
    recon_report_id: reconReportId,
    run_id: context.run_id,
    // Requirement 4.7's applied range, reported against the figure — and deliberately
    // not part of the identity. See `settlementMismatchUpsertFor`.
    scope_from: context.scope.from,
    scope_to: context.scope.to,
    payments_counted: examined.payments_counted,
    refunds_counted: examined.refunds_counted,
    chargebacks_counted: examined.chargebacks_counted,
    adjustments_counted: examined.adjustments_counted,
  };
}

/** The five figures a reconciled Settlement carries, narrowed. */
function requireFigures(recon: SettlementRecon): {
  readonly expected: Paise;
  readonly difference: Paise;
  readonly fee: Paise;
  readonly gst: Paise;
  readonly residual: Paise;
} {
  const { expected_paise, difference_paise, fee_component_paise, gst_component_paise } = recon;
  const residual = recon.residual_paise;
  if (
    expected_paise === null ||
    difference_paise === null ||
    fee_component_paise === null ||
    gst_component_paise === null ||
    residual === null
  ) {
    // Unreachable: a non-null `residualImpactPaise` means the Settlement reconciled, and
    // `reconcileSettlement` produces all five figures together or none of them.
    throw new ReconciliationRunError(
      `${recon.settlement_id} has an unexplained residual but does not carry all five figures; ` +
        `a reconciled Settlement carries them together (Requirement 4.3, 4.4)`,
    );
  }
  return {
    expected: expected_paise,
    difference: difference_paise,
    fee: fee_component_paise,
    gst: gst_component_paise,
    residual,
  };
}

/** The three keys {@link compareSettlementMismatch} reads, and nothing else. */
export interface SettlementMismatchOrderKey {
  readonly impact_paise: Paise;
  readonly settlement_date: DateOnly;
  readonly settlement_id: string;
}

/**
 * The total order Exceptions are upserted and reported in: **descending
 * `impact_paise`, then ascending `settlement_date`, then ascending `settlement_id`**.
 *
 * Total, because a duplicate `settlement_id` in one scope is rejected before this is
 * ever called — so no two candidates compare equal, and the sort cannot depend on the
 * order the store returned rows in (Requirement 4.15, 15.7).
 *
 * Descending impact first so the run's order and the order a User sees do not disagree
 * (Requirement 4.6 orders the breakdown by descending absolute Difference, and the
 * Attention_Panel orders by impact). The tie-breakers are the load-bearing part: two
 * Settlements with the identical unexplained residual are exactly the case a
 * single-key sort gets wrong, which is why task 13.3's generator puts deliberate
 * impact ties in the dataset.
 *
 * Exported so P5 compares two runs with **this** rule rather than a second copy of it.
 */
export function compareSettlementMismatch(
  a: SettlementMismatchOrderKey,
  b: SettlementMismatchOrderKey,
): number {
  if (a.impact_paise !== b.impact_paise) {
    return a.impact_paise > b.impact_paise ? -1 : 1;
  }
  if (a.settlement_date !== b.settlement_date) {
    return a.settlement_date < b.settlement_date ? -1 : 1;
  }
  if (a.settlement_id === b.settlement_id) {
    return 0;
  }
  return a.settlement_id < b.settlement_id ? -1 : 1;
}

/** {@link compareSettlementMismatch} applied, without mutating the input. */
export function settlementMismatchOrder<T extends SettlementMismatchOrderKey>(
  candidates: readonly T[],
): readonly T[] {
  return [...candidates].sort(compareSettlementMismatch);
}

/* -------------------------------------------------------------------------- */
/* The agent                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The four seams a run reads and writes through, plus the two things it must not
 * invent.
 *
 * The **stores** are injected rather than the services built over them, so the Tenant
 * is bound exactly once for the whole run: a reconciler bound to one Tenant and an
 * Exception upserter bound to another is not a configuration this type admits
 * (Requirement 12.7, 14.10). No live adapter exists for any of the four — every table
 * is RLS `ENABLE`d and `FORCE`d with no policies until task 26.1 — so an adapter
 * written today would reconcile nothing for every Tenant.
 */
export interface ReconciliationAgentDeps {
  /** The session Tenant. Never a method argument, never inferred. */
  readonly tenantId: TenantId;
  /** In-scope Settlements and their enumerated report lines. */
  readonly settlements: SettlementScopeStore;
  /** `settlement_reconciliations`, upserted on `settlement_recon_uniq`. */
  readonly reconciliations: SettlementReconStore;
  /** `exceptions`, upserted on `exceptions_fingerprint_uniq`. */
  readonly exceptions: ExceptionStore;
  /** Requirement 4.1's stored identifier links. */
  readonly links: LifecycleLinkStore;
  /**
   * The Evidence_Chain a Financial_Tool composed for this Settlement's figures, or
   * `null` where none has been. **The run composes no chain** — see the module doc
   * comment — so this is the only way a row or an Exception acquires one.
   */
  readonly evidenceChainFor?: (settlementId: string) => string | null;
  /** The wall clock. Read once per run, and the deadline is measured from it. */
  readonly now?: () => Date;
  /** The run identifier. A UUID; `randomUUID` by default. */
  readonly newRunId?: () => string;
  /** Requirement 15.6's bound. {@link RUN_BUDGET_MS} by default. */
  readonly budgetMs?: number;
}

/** A Reconciliation_Agent bound to one Tenant. */
export interface ReconciliationAgent {
  /**
   * One run over the settlement path: resolve the scope, reconcile every in-scope
   * Settlement, upsert a `settlement_mismatch` Exception per non-zero residual, map
   * every in-scope Payment's lifecycle, and report all of it.
   *
   * Never throws for anything a run can encounter — an empty scope, a stopped run, an
   * unreadable record, a re-detected closed Exception are all fields of the report.
   *
   * @throws {ReconciliationRunError} for a fault: a duplicate or out-of-scope
   * Settlement from the store, or a malformed identifier.
   * @throws {SettlementReconError} for a reconciliation row the validation funnel
   * refuses, and {@link ExceptionFingerprintError} for an Exception it refuses. Both
   * are programming faults on this path: every value they check is produced here from
   * task 11.1's own figures.
   */
  run(request?: ReconciliationRunRequest): Promise<ReconciliationRunReport>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createReconciliationAgent(deps: ReconciliationAgentDeps): ReconciliationAgent {
  const tenantId = deps.tenantId;
  if (!UUID_RE.test(tenantId)) {
    throw new ReconciliationRunError(
      `createReconciliationAgent requires the session Tenant identifier as a UUID, got ` +
        `${JSON.stringify(tenantId)}. The Tenant is bound once for the whole run so the four ` +
        `seams cannot disagree about whose data is being reconciled`,
    );
  }
  const budgetMs = deps.budgetMs ?? RUN_BUDGET_MS;
  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) {
    throw new ReconciliationRunError(
      `budgetMs must be a positive whole number of milliseconds, got ${String(budgetMs)}`,
    );
  }
  const now = deps.now ?? ((): Date => new Date());
  const newRunId = deps.newRunId ?? randomUUID;
  const chainFor = deps.evidenceChainFor ?? ((): string | null => null);

  // Bound to the one Tenant, once. No method below takes a `tenant_id`.
  const reconciler = createSettlementReconciler({
    store: deps.reconciliations,
    tenantId,
  });
  const upserter = createExceptionUpserter({ store: deps.exceptions, tenantId });
  const matcher = createLifecycleMatcher({ store: deps.links, tenantId });

  return {
    async run(request: ReconciliationRunRequest = {}): Promise<ReconciliationRunReport> {
      const runId = assertRunId(newRunId());
      // The clock is read once. `run_at` is Requirement 4.15's run timestamp — every
      // Exception this run touches is stamped with this one instant — and the deadline
      // is measured from it, so a run cannot drift between the two.
      const runAt = now();
      const detectedAt = runAt.toISOString();
      const startedMs = runAt.getTime();
      /** Elapsed wall clock. Clamped at 0, so a clock that stepped back never times out. */
      const elapsedMs = (): number => Math.max(0, now().getTime() - startedMs);
      const outOfBudget = (): boolean => elapsedMs() >= budgetMs;

      // Requirement 4.7: the stated range, or the trailing 90 days ending at the run
      // timestamp. One definition, imported, never a second subtraction.
      const scope = resolveSettlementScope({
        from: request.from,
        to: request.to,
        runAt,
      });
      const namedIds =
        request.settlement_ids === undefined || request.settlement_ids === null
          ? null
          : canonicalIdentifiers(request.settlement_ids, 'settlement_ids');

      /* --- stage: read_scope ------------------------------------------------ */

      if (outOfBudget()) {
        return emptyReport({
          runId,
          detectedAt,
          scope,
          stage: 'read_scope',
          elapsedMs: elapsedMs(),
        });
      }

      const read = await deps.settlements.listInScope({
        tenant_id: tenantId,
        scope,
        settlement_ids: namedIds,
      });
      const examined = examinedCountsFor(read);
      const ordered = inScopeOrder(assertOneRowPerSettlement(read.settlements, scope));

      /* --- stage: reconcile ------------------------------------------------- */

      const rows: SettlementRunRow[] = [];
      const reconciled: ScopedSettlement[] = [];
      const withheld: WithheldSettlement[] = [];
      const candidates: (SettlementMismatchContext & SettlementMismatchOrderKey)[] = [];
      let stoppedAt: RunStage | null = null;

      for (const settlement of ordered) {
        // No unit of work is begun at or after the deadline. The unit already in flight
        // is not interrupted — there is nothing to interrupt it with — so the bound is
        // the deadline plus at most one Settlement. See the module doc comment.
        if (outOfBudget()) {
          stoppedAt = 'reconcile';
          break;
        }

        // Requirement 12.3, before any figure: one unreadable contributing record
        // withholds this Settlement entirely rather than yielding a confident Expected
        // Amount computed from a report that was only partly read.
        const unreadable = settlement.unreadable ?? [];
        if (unreadable.length > 0) {
          withheld.push({
            settlement_id: settlement.settlement_id,
            reason: 'unreadable_source_records',
            unreadable,
          });
          continue;
        }

        const report = reconReportLinesOf(settlement);
        const result = await reconciler.reconcile({
          settlement_id: settlement.settlement_id,
          recon_report_id: settlement.recon_report_id,
          settlement_date: settlement.settlement_date,
          received_paise: settlement.received_paise,
          report,
          evidence_chain_id: chainFor(settlement.settlement_id),
          run_id: runId,
        });

        rows.push({
          settlement_id: settlement.settlement_id,
          settlement_date: settlement.settlement_date,
          recon_report_id: settlement.recon_report_id,
          recon: result.recon,
          examined: result.examined,
          unreconciled_source: unreconciledSourceOf(settlement),
          reconciliation_id: result.reconciliation_id,
          created: result.created,
        });
        reconciled.push(settlement);

        // Requirement 4.4 and 4.13 are enforced by `residualImpactPaise` inside
        // `settlementMismatchUpsertFor`; this collects a candidate per reconciled
        // Settlement and the gate decides. Nothing is upserted yet, because the
        // Exception order is over the whole set.
        const impactPaise = residualImpactPaise(result.recon);
        if (impactPaise !== null) {
          candidates.push({
            recon: result.recon,
            settlement_date: settlement.settlement_date,
            recon_report_id: settlement.recon_report_id,
            examined: result.examined,
            scope,
            run_id: runId,
            detected_at: detectedAt,
            evidence_chain_id: chainFor(settlement.settlement_id),
            impact_paise: impactPaise,
            settlement_id: settlement.settlement_id,
          });
        }
      }

      /* --- stage: detect_exceptions ----------------------------------------- */

      const detections: SettlementMismatchDetection[] = [];
      const notReopened: ExceptionNotReopened[] = [];
      let created = 0;
      let updated = 0;

      if (stoppedAt === null) {
        for (const candidate of settlementMismatchOrder(candidates)) {
          if (outOfBudget()) {
            stoppedAt = 'detect_exceptions';
            break;
          }
          const input = settlementMismatchUpsertFor(candidate);
          if (input === null) {
            // Unreachable: a candidate exists only where `residualImpactPaise` was
            // non-null, which is the same gate.
            continue;
          }
          const outcome = await upserter.upsert(input);
          if (outcome.ok) {
            if (outcome.created) {
              created += 1;
            } else {
              updated += 1;
            }
          } else {
            // A re-detection of an Exception a User closed. Reported, not applied, and
            // not dropped (Requirement 4.15).
            notReopened.push(outcome);
          }
          detections.push({
            settlement_id: candidate.settlement_id,
            settlement_date: candidate.settlement_date,
            recon_report_id: requireReportId(candidate),
            impact_paise: candidate.impact_paise,
            direction: input.direction,
            source_refs: input.source_refs,
            outcome,
          });
        }
      }

      /* --- stage: match_lifecycle ------------------------------------------- */

      // Two different sets, and the difference matters. `inScopePayments` is every
      // Payment the in-scope reports enumerate — the set the matcher must be asked
      // about, and the size Requirement 15.10 reads its threshold against.
      // `processedPayments` is the subset whose Settlement was actually reconciled, so a
      // run that stopped early or withheld a Settlement does not claim to have processed
      // Payments it never reached.
      const inScopePayments = inScopePaymentIds(ordered);
      const processedPayments = inScopePaymentIds(reconciled);
      let lifecycle = emptyLifecycle(inScopePayments.length);

      if (stoppedAt === null && inScopePayments.length > 0) {
        if (outOfBudget()) {
          stoppedAt = 'match_lifecycle';
        } else {
          const matched = await matcher.match(inScopePayments);
          lifecycle = {
            payments_in_scope: inScopePayments.length,
            matched: matched.matches,
            // This module's order, stated with `./match`'s own key function.
            matched_payment_order: matched.matches.map(lifecycleMatchOrderKey),
            payments_not_read: matched.payments_not_read,
            unreadable: matched.unreadable,
            not_matched_counts: notMatchedCounts(matched.matches),
            ambiguous_payment_ids: matched.matches
              .filter(isAmbiguousMatch)
              .map((match) => match.payment_id),
          };
        }
      }
      // An empty scope, or a scope whose reports enumerate no Payment, leaves the
      // initialised empty mapping: the matcher is deliberately **not** called, because
      // it rejects an empty request — reporting a mapping of zero Payments as successful
      // would be a claim about a set nobody resolved.

      /* --- the report ------------------------------------------------------- */

      // Read once, so the two `elapsed_ms` fields cannot disagree by a clock tick.
      const finishedMs = elapsedMs();
      const reconciledIds = new Set(rows.map((row) => row.settlement_id));
      const notReconciled = ordered
        .map((settlement) => settlement.settlement_id)
        .filter((id) => !reconciledIds.has(id));
      const unreadable = [
        ...withheld.flatMap((one) => one.unreadable),
        ...lifecycle.unreadable,
      ];

      return {
        run_id: runId,
        run_at: detectedAt,
        scope,
        examined,
        payments_processed: processedPayments.length,
        // Requirement 15.10: above the threshold the 60-second bound does not apply.
        complete_set_bound_applies: inScopePayments.length <= LARGE_DATASET_PAYMENT_COUNT,
        settlements: rows,
        withheld,
        shortfall: totalShortfall(rows.map((row) => row.recon)),
        exceptions: {
          detections,
          order: detections.map((detection) => detection.settlement_id),
          created_count: created,
          updated_count: updated,
          not_reopened_count: notReopened.length,
          not_reopened: notReopened,
        },
        lifecycle,
        incomplete: incompletenessOf({
          stoppedAt,
          elapsedMs: finishedMs,
          notReconciled: ascending(notReconciled),
          paymentsNotRead: lifecycle.payments_not_read,
          unreadable,
        }),
        elapsed_ms: finishedMs,
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Requirement 15.6's incompleteness, or `null` for a run that finished everything it
 * set out to do.
 *
 * The three reasons are independent and can coexist: a run can be stopped by the clock
 * *and* have withheld a Settlement *and* have failed to read a Payment's links. Each
 * contributes its own Source_Record types, and the union is what Requirement 15.6 asks
 * to be named.
 */
function incompletenessOf(input: {
  readonly stoppedAt: RunStage | null;
  readonly elapsedMs: number;
  readonly notReconciled: readonly string[];
  readonly paymentsNotRead: readonly string[];
  readonly unreadable: readonly SourceRef[];
}): RunIncompleteness | null {
  const reasons: RunIncompleteReason[] = [];
  const types = new Set<SourceRecordType>();

  if (input.stoppedAt !== null) {
    reasons.push('wall_clock_budget');
    for (const type of typesNotFullyProcessedFrom(input.stoppedAt)) {
      types.add(type);
    }
  }
  if (input.unreadable.length > 0) {
    reasons.push('unreadable_source_records');
    // The withheld Settlement's own figures were not computed, so both of the settlement
    // path's types are unfinished — plus whatever each unreadable record itself is.
    types.add('settlement');
    types.add('settlement_recon_report');
    for (const ref of input.unreadable) {
      types.add(ref.type);
    }
  }
  if (input.paymentsNotRead.length > 0) {
    reasons.push('payments_not_read');
    types.add('payment');
  }

  if (reasons.length === 0) {
    return null;
  }
  return {
    reasons,
    stopped_at_stage: input.stoppedAt,
    elapsed_ms: input.elapsedMs,
    types_not_fully_processed: sortSourceRecordTypes(types),
    settlements_not_reconciled: input.notReconciled,
    payments_not_read: input.paymentsNotRead,
    unreadable: input.unreadable,
  };
}

/**
 * The report of a run stopped before it read anything: Requirement 15.6's partial
 * result where the partial part is empty.
 *
 * It is still a report rather than a throw, and it still names the types: "the clock
 * ran out before I read anything" is a fact a caller can act on, and an exception would
 * lose the run identifier and the resolved scope with it.
 */
function emptyReport(input: {
  readonly runId: string;
  readonly detectedAt: string;
  readonly scope: DateRange;
  readonly stage: RunStage;
  readonly elapsedMs: number;
}): ReconciliationRunReport {
  return {
    run_id: input.runId,
    run_at: input.detectedAt,
    scope: input.scope,
    examined: NO_RECORDS_EXAMINED,
    payments_processed: 0,
    complete_set_bound_applies: true,
    settlements: [],
    withheld: [],
    shortfall: totalShortfall([]),
    exceptions: {
      detections: [],
      order: [],
      created_count: 0,
      updated_count: 0,
      not_reopened_count: 0,
      not_reopened: [],
    },
    lifecycle: emptyLifecycle(0),
    incomplete: {
      reasons: ['wall_clock_budget'],
      stopped_at_stage: input.stage,
      elapsed_ms: input.elapsedMs,
      types_not_fully_processed: typesNotFullyProcessedFrom(input.stage),
      settlements_not_reconciled: [],
      payments_not_read: [],
      unreadable: [],
    },
    elapsed_ms: input.elapsedMs,
  };
}

/** A mapping of nothing: every list empty, every count zero. */
function emptyLifecycle(paymentsInScope: number): LifecycleRunReport {
  return {
    payments_in_scope: paymentsInScope,
    matched: [],
    matched_payment_order: [],
    payments_not_read: [],
    unreadable: [],
    not_matched_counts: zeroNotMatchedCounts(),
    ambiguous_payment_ids: [],
  };
}

/** One counter per {@link LifecycleRecordType}, all zero. */
function zeroNotMatchedCounts(): Record<LifecycleRecordType, number> {
  return { order: 0, razorpay_invoice: 0, settlement: 0, ledger_entries: 0 };
}

/**
 * How many Payments carry Requirement 4.1's not-matched marker, per record type.
 *
 * Counted from `notMatchedTypes` rather than by reading each arm here, so the marker is
 * defined in one place. `ledger_entries` is Requirement 4.10's condition exactly — no
 * Ledger_Entry references the Payment as a Source_Record — which is what task 13.5 will
 * read it for.
 */
function notMatchedCounts(
  matches: readonly PaymentLifecycleMatch[],
): Readonly<Record<LifecycleRecordType, number>> {
  const counts = zeroNotMatchedCounts();
  for (const match of matches) {
    for (const type of notMatchedTypes(match)) {
      counts[type] += 1;
    }
  }
  return counts;
}

/**
 * Identifiers as an identity: validated, deduplicated, ascending.
 *
 * `canonicalLinkIds` from `./match` **is** the rule — it applies
 * `assertRefIdentifier`, so an identifier that would collide two Exception identities
 * is rejected while it is still an identifier. Reusing it rather than copying the
 * pattern is the point; the rejection is re-thrown as a {@link ReconciliationRunError}
 * so a caller of this module catches one error type.
 */
function canonicalIdentifiers(ids: readonly string[], what: string): readonly string[] {
  try {
    return canonicalLinkIds(ids, what);
  } catch (cause) {
    throw new ReconciliationRunError(cause instanceof Error ? cause.message : String(cause), {
      cause,
    });
  }
}

/**
 * One row per Settlement, and every row inside the resolved scope.
 *
 * Both are rejections rather than repairs. A duplicate `settlement_id` would make the
 * reconciliation order depend on arrival and would count the Settlement twice in
 * `totalShortfall`, so the total order Requirement 4.15 needs would not exist. A row
 * whose `settlement_date` is outside the resolved range would make the reported scope
 * — Requirement 4.7's "the settlement date range applied to that figure" — a false
 * statement; filtering it away instead would hide an adapter that does not implement
 * its own contract, which is that the range **is** the scope.
 */
function assertOneRowPerSettlement(
  settlements: readonly ScopedSettlement[],
  scope: DateRange,
): readonly ScopedSettlement[] {
  const seen = new Set<string>();
  for (const settlement of settlements) {
    if (seen.has(settlement.settlement_id)) {
      throw new ReconciliationRunError(
        `${settlement.settlement_id} appears twice in one resolved scope; a Settlement ` +
          `identifier is unique per Tenant, so two rows for it describe two different ` +
          `Settlements and reconciling both would count it twice in the reported total ` +
          `shortfall and leave the run order dependent on which arrived first`,
      );
    }
    seen.add(settlement.settlement_id);

    // Fixed-width `YYYY-MM-DD` compares lexicographically as it does chronologically.
    if (settlement.settlement_date < scope.from || settlement.settlement_date > scope.to) {
      throw new ReconciliationRunError(
        `${settlement.settlement_id} is dated ${settlement.settlement_date}, outside the ` +
          `resolved scope ${scope.from}..${scope.to}; the range is the scope, and reporting it ` +
          `alongside a figure computed over a wider set would make Requirement 4.7's applied ` +
          `range a false statement`,
      );
    }
  }
  return settlements;
}

function requireReportId(candidate: SettlementMismatchContext): string {
  const id = candidate.recon_report_id;
  if (id === null) {
    // Unreachable: `settlementMismatchUpsertFor` rejects it first.
    throw new ReconciliationRunError(
      `${candidate.recon.settlement_id} raised a settlement_mismatch with no ` +
        `Settlement_Recon_Report identifier (Requirement 4.5)`,
    );
  }
  return id;
}

function assertRunId(runId: string): string {
  if (!UUID_RE.test(runId)) {
    throw new ReconciliationRunError(
      `the run identifier must be a UUID, got ${JSON.stringify(runId)}; ` +
        `settlement_reconciliations.run_id is a UUID column and a row must be attributable to ` +
        `the run that computed it`,
    );
  }
  return runId;
}

/**
 * `SOURCE_RECORD_TYPES` declaration order, which is the order the enum compares in.
 *
 * The list is imported rather than restated: a label added to the enum must not need a
 * second edit here to be reported in the right place.
 */
function sortSourceRecordTypes(types: ReadonlySet<SourceRecordType>): readonly SourceRecordType[] {
  return SOURCE_RECORD_TYPES.filter((type) => types.has(type));
}

/** Ascending character order. The house tie-break, applied to a list of identifiers. */
function ascending(ids: readonly string[]): readonly string[] {
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
