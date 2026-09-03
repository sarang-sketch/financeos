/**
 * The production Financial_Tool catalogue (task 12.7).
 * Requirements 12.1, 12.2, 12.3, 12.7, 12.9, 12.11.
 *
 * Every tool of tasks 12.1 through 12.6 exports a `catalogueEntryFor(deps)` and each
 * of those tasks deliberately stopped short of creating this module, because
 * `test/contract/tool-contract.test.ts` asserted that `src/tools/catalogue.ts` did not
 * exist — a trip-wire whose stated purpose was to force whoever added one to wire it
 * into `runToolContract`. This is that module, and
 * `test/contract/slice-1-catalogue.test.ts` is that wiring: it builds this registry and
 * hands it to the harness, so a tool cannot enter the catalogue without acquiring a
 * contract fixture and ten generated cases.
 *
 * ## What this module is, and what it is not
 *
 * It is the **assembly point**: one function per catalogue, taking the read seams every
 * tool declares and returning the audited {@link ToolRegistry} an Agent selects a tool
 * from. It holds no tool logic, no schema, no figure and no store. Every entry goes
 * through the tool's own `catalogueEntryFor`, so `NoTenantId<In>` is still checked at
 * each hand-off and `createToolRegistry` still audits every declaration eagerly — a
 * malformed one is a process that does not start (see `./registry.ts`).
 *
 * It is **not a composition root**. Nothing here constructs a store, reads
 * `process.env` or touches `src/db/clients.ts`: every settlement, ledger, Payment,
 * Refund, Exception and metric table is RLS-`FORCE`d with no policies until task 26.1,
 * so a live adapter written today would answer zero rows for every Tenant. The seams
 * arrive as {@link SliceOneToolDeps} — one bundle per tool, each a factory over the
 * `ToolContext` — exactly as every tool declares them, so 26.x supplies `ctx.db`-backed
 * adapters and the API layer calls {@link createSliceOneToolRegistry} once per process
 * with no change here.
 *
 * ## Slice 1 is thirteen of design.md's twenty tools, and the gap is visible
 *
 * {@link SLICE_1_TOOL_NAMES} is the eleven read-only tools that exist plus the two
 * write-capable ones of **task 24.3**. design.md's catalogue names 20 — 17 read-only and
 * 3 write-capable — so seven are still absent: six read-only ones
 * (`get_compliance_findings`, `get_itc_discrepancy`, `get_cash_forecast`,
 * `simulate_cash_action`, `get_failed_payment_recovery_profile`,
 * `get_period_comparison`) and `initiate_payment_retry`, which is the one tool that
 * calls a Razorpay write API and is not part of 24.3.
 * `catalogueGaps` in `test/contract/tool-contract.ts` reports them by name, and
 * `test/contract/slice-1-catalogue.test.ts` asserts that it still does: a catalogue that
 * quietly claimed completeness would be worse than one that names what it lacks.
 *
 * There is no `index.ts` and no barrel. A tool is imported from its own module; this
 * module exists to build a registry, not to re-export thirteen files.
 *
 * ## The two write-capable entries are gated once, here
 *
 * `post_reconciliation_adjustment` and `mark_exception_resolved` take a second argument
 * their read-only siblings do not: the shared {@link SliceOneToolDeps.writeGate}. Each
 * tool's own `catalogueEntryFor` applies `createWriteCapableTool` exactly once, so the
 * declaration that enters the registry already carries `mode: 'write_capable'` and the
 * gate — there is no path from this module to a write seam that skips it. See
 * `./write-tool.ts`.
 *
 * ## Money
 *
 * Nothing here touches money. No figure is read, computed, formatted or converted —
 * `Paise` is `bigint` throughout and this module never sees one.
 */

import { catalogueEntryFor as controlTowerMetricsEntry } from './get-control-tower-metrics';
import type { GetControlTowerMetricsDeps } from './get-control-tower-metrics';
import { catalogueEntryFor as duplicateRefundCandidatesEntry } from './get-duplicate-refund-candidates';
import type { GetDuplicateRefundCandidatesDeps } from './get-duplicate-refund-candidates';
import { catalogueEntryFor as exceptionEvidenceEntry } from './get-exception-evidence';
import type { GetExceptionEvidenceDeps } from './get-exception-evidence';
import { catalogueEntryFor as missingAccrualsEntry } from './get-missing-accruals';
import type { GetMissingAccrualsDeps } from './get-missing-accruals';
import { catalogueEntryFor as settlementDifferenceBreakdownEntry } from './get-settlement-difference-breakdown';
import type { GetSettlementDifferenceBreakdownDeps } from './get-settlement-difference-breakdown';
import { catalogueEntryFor as settlementReconciliationEntry } from './get-settlement-reconciliation';
import type { GetSettlementReconciliationDeps } from './get-settlement-reconciliation';
import { catalogueEntryFor as trialBalanceEntry } from './get-trial-balance';
import type { GetTrialBalanceDeps } from './get-trial-balance';
import { catalogueEntryFor as unsettledPaymentsEntry } from './get-unsettled-payments';
import type { GetUnsettledPaymentsDeps } from './get-unsettled-payments';
import { catalogueEntryFor as exceptionListEntry } from './list-exceptions-by-category';
import type { ListExceptionsByCategoryDeps } from './list-exceptions-by-category';
import { catalogueEntryFor as markExceptionResolvedEntry } from './mark-exception-resolved';
import type { MarkExceptionResolvedDeps } from './mark-exception-resolved';
import { catalogueEntryFor as postReconciliationAdjustmentEntry } from './post-reconciliation-adjustment';
import type { PostReconciliationAdjustmentDeps } from './post-reconciliation-adjustment';
import {
  linkedAccountBalanceCatalogueEntry,
  sellerPayoutChainCatalogueEntry,
  type GetLinkedAccountBalanceDeps,
  type GetSellerPayoutChainDeps,
} from './marketplace-tools';
import { createToolRegistry, type ToolRegistry } from './registry';
import type { ErasedFinancialTool } from './tool';
import type { WriteCapableToolGate } from './write-tool';

export interface SliceOneToolDeps {
  readonly settlementReconciliation: GetSettlementReconciliationDeps;
  readonly settlementDifferenceBreakdown: GetSettlementDifferenceBreakdownDeps;
  readonly trialBalance: GetTrialBalanceDeps;
  readonly unsettledPayments: GetUnsettledPaymentsDeps;
  readonly duplicateRefundCandidates: GetDuplicateRefundCandidatesDeps;
  readonly missingAccruals: GetMissingAccrualsDeps;
  readonly exceptionList: ListExceptionsByCategoryDeps;
  readonly exceptionEvidence: GetExceptionEvidenceDeps;
  readonly sellerPayoutChain: GetSellerPayoutChainDeps;
  readonly linkedAccountBalance: GetLinkedAccountBalanceDeps;
  readonly controlTowerMetrics: GetControlTowerMetricsDeps;
  /**
   * The two write-capable tools of task 24.3, and the gate they share.
   *
   * The gate is one object for both because Requirement 12.10 is one rule: an
   * invocation carrying no reference to a Proposal holding a recorded Authorization is
   * refused, whichever tool it named. Giving each tool its own lookup would allow two
   * answers to one question. See `./write-tool.ts` for why the seams behind the gate
   * are unreachable without its proof.
   */
  readonly writeGate: WriteCapableToolGate;
  readonly reconciliationAdjustment: PostReconciliationAdjustmentDeps;
  readonly exceptionResolution: MarkExceptionResolvedDeps;
}

/** Registered production tools, in design.md catalogue order. */
export const SLICE_1_TOOL_NAMES: readonly string[] = [
  'get_settlement_reconciliation',
  'get_settlement_difference_breakdown',
  'get_trial_balance',
  'get_unsettled_payments',
  'get_duplicate_refund_candidates',
  'get_missing_accruals',
  'list_exceptions_by_category',
  'get_exception_evidence',
  'get_seller_payout_chain',
  'get_linked_account_balance',
  'get_control_tower_metrics',
  'post_reconciliation_adjustment',
  'mark_exception_resolved',
] as const;

export function createSliceOneTools(deps: SliceOneToolDeps): readonly ErasedFinancialTool[] {
  return [
    settlementReconciliationEntry(deps.settlementReconciliation),
    settlementDifferenceBreakdownEntry(deps.settlementDifferenceBreakdown),
    trialBalanceEntry(deps.trialBalance),
    unsettledPaymentsEntry(deps.unsettledPayments),
    duplicateRefundCandidatesEntry(deps.duplicateRefundCandidates),
    missingAccrualsEntry(deps.missingAccruals),
    exceptionListEntry(deps.exceptionList),
    exceptionEvidenceEntry(deps.exceptionEvidence),
    sellerPayoutChainCatalogueEntry(deps.sellerPayoutChain),
    linkedAccountBalanceCatalogueEntry(deps.linkedAccountBalance),
    controlTowerMetricsEntry(deps.controlTowerMetrics),
    // The two write-capable tools of task 24.3. Both are assembled through
    // `createWriteCapableTool` with the one shared gate, so neither is reachable
    // without a `proposal_id` and `authorization_id` resolving to a Proposal holding a
    // recorded Authorization (Requirement 12.10).
    postReconciliationAdjustmentEntry(deps.reconciliationAdjustment, deps.writeGate),
    markExceptionResolvedEntry(deps.exceptionResolution, deps.writeGate),
  ];
}

/**
 * The Slice 1 catalogue, audited.
 *
 * @throws {ToolRegistryError} for a duplicate name or any declaration the registration
 * audit refuses. A tool that cannot be proven bounded, strict and session-scoped is a
 * process that does not start (Requirement 12.9).
 */
export function createSliceOneToolRegistry(deps: SliceOneToolDeps): ToolRegistry {
  return createToolRegistry(createSliceOneTools(deps));
}
