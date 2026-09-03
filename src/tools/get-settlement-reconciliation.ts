/**
 * `get_settlement_reconciliation` — the first production Financial_Tool (task 12.1).
 * Requirements 4.2, 4.4, 4.7, 4.13, 12.2.
 *
 * This is the tool the MVP demo runs through. A User asks "why am I missing ₹3.82
 * lakh in settlements?"; design.md's reconciliation sequence has the
 * Reconciliation_Agent resolve a scope and call this tool as `T1`, which answers
 * `total_shortfall_paise`, the examined counts, one row per in-scope Settlement, and
 * an Evidence_Chain identifier behind every figure. `get_settlement_difference_breakdown`
 * (task 12.2) then decomposes each row, and the Response_Validator refuses any
 * figure whose chain does not resolve (Requirement 12.6).
 *
 * design.md fixes the contract exactly:
 *
 *     in   { from: DateOnly; to: DateOnly; settlement_ids?: string[] }
 *     out  { rows: SettlementRecon[]; total_shortfall_paise: Paise; scope: DateRange;
 *            examined: ExaminedCounts; residual_nonzero_count: number }
 *
 * ## What this module owns, and what it only calls
 *
 * | Concern | Where |
 * |---|---|
 * | the Zod schemas, the `ToolResult` envelope, the catalogue entry | here |
 * | the resolved scope, the examined counts, the read seam | `./settlement-scope.ts` |
 * | the twelve-step chain and the aggregate chain | `./settlement-evidence.ts` |
 * | Expected Amount, Difference, decomposition, status, direction | `@/agents/reconciliation/reconcile-settlement` (task 11.1) |
 * | composing, validating and persisting a chain | `@/evidence/chain-builder` (task 9.1) |
 * | parse, authorize, bound, envelope check | `./tool.ts` (task 10.1) |
 *
 * **No money is computed in this file.** Every figure comes from
 * `reconcileSettlement` or from the Calculation Service through
 * `./settlement-evidence.ts`, and the two are cross-checked against each other
 * before anything is written.
 *
 * ## Decision 1: what `total_shortfall_paise` sums
 *
 * design.md never defines it — task 11.1 recorded that as its finding 4 — so the
 * choice is stated here rather than implied:
 *
 * > **`total_shortfall_paise` is the sum of the *Differences* of the in-scope
 * > Settlements whose Difference is positive. Nothing is netted against it, and an
 * > `unreconciled` Settlement contributes nothing. It is always `>= 0n`.**
 *
 * Four reasons, in the order they decided it:
 *
 * 1. **design.md quantifies the figure exactly once, and only the Difference fits.**
 *    Its sequence diagram has this tool answer `total_shortfall_paise 38200000` and
 *    the response then read back as "3,82,000 breaks down as fee 2,74,500 + GST on
 *    fee 49,410 + unexplained 58,090". Those three sum to 3,82,000, and
 *    `difference = fee + gst + residual` is the only decomposition in the system
 *    with that shape (Requirement 4.3). A residual-based total would already *be*
 *    the unexplained leg, so decomposing it again into fee and GST is incoherent.
 * 2. **It is what the User's question means.** "Missing ₹3.82 lakh in settlements"
 *    is expected minus received — what did not arrive in the bank — before anything
 *    explains it. The demo's whole point is that most of the gap turns out to be
 *    fees and GST and a small part does not.
 * 3. **Requirement 4.7 reports `residual_nonzero_count` *beside* the total**, as a
 *    separate quantity. Under a residual-based total that count would be a
 *    restatement of the total's own contributor set; under this reading the two say
 *    genuinely different things — how much is missing, and how many Settlements
 *    cannot fully explain it.
 * 4. **Nothing is netted**, for exactly the objection task 11.1 raised: a Settlement
 *    that received *more* than expected is a second anomaly, not a cancellation of
 *    the first, and a signed total would report the pair as zero — the same way a
 *    tolerance band hides a systematic error. Negative Differences are therefore
 *    excluded from the figure, never subtracted from it.
 *
 * Requirement 4.13's exclusion is structural rather than a filter: an `unreconciled`
 * Settlement has `difference_paise === null`, so there is nothing to add.
 *
 * **A name collision a reader must not trip over.** Task 11.1's
 * `totalShortfall(recons).total_shortfall_paise` is a **different quantity** — Σ
 * *residual* over Settlements whose residual is positive — and property P3 already
 * asserts it under that name. This tool uses 11.1's function only for
 * `residual_nonzero_count`, which is unambiguous, and computes its own figure. Both
 * are reported as findings against design.md at the foot of this comment.
 *
 * ## Decision 2: one chain per row, and one for the aggregate
 *
 * Task 10.1's finding 1: `ToolResult<T>`'s success variant carries a **single**
 * `EvidenceChain`, and this tool produces one per row plus one for the total.
 * `./tool.ts` is **unchanged** — widening the envelope would touch all 19 other
 * tools for the benefit of this one — and the resolution is entirely inside `Out`:
 *
 * - **Every row carries its own `evidence_chain_id`**, which grounds all six of its
 *   monetary fields. A reconciled row's chain is design.md's twelve steps with the
 *   residual as its figure, the Expected Amount at step
 *   {@link EXPECTED_AMOUNT_STEP_INDEX} and the Difference at step
 *   {@link DIFFERENCE_STEP_INDEX}; an `unreconciled` row's chain is one step over the
 *   Settlement's own `amount`, grounding `received_paise`, which is the only figure
 *   it has (Requirement 4.13).
 * - **The envelope chain grounds `total_shortfall_paise` and nothing else.** It is
 *   the aggregate chain: every contributing Settlement's steps 1..8 inlined, then one
 *   `sum` over those Difference results, so replaying it reproduces the total from
 *   the source records themselves (Requirement 12.8).
 *
 * `test/contract/tool-contract.ts`'s `attributeMonetaryFields` was written for
 * exactly this shape — it attributes each `*_paise` field to the nearest enclosing
 * object declaring an `evidence_chain_id` and falls back to the envelope only when
 * none does — so the harness needed **no change** either. The single top-level
 * monetary field means the harness will additionally require the envelope chain's
 * `figure_paise` to equal `total_shortfall_paise`, which it does by construction.
 *
 * ## Decision 3: counts are `number`, figures are `bigint`
 *
 * `residual_nonzero_count` and all five examined counts are counts, so `number` is
 * correct and the ESLint money rule does not fire on them — none is named in a way
 * that reads as monetary. Every `*_paise` field is `Paise` (`bigint`), which is what
 * design.md's output type says; the decimal-string encoding is the transport
 * layer's, through `toWire`, and nothing here converts.
 *
 * ## What an empty scope cannot be, and why it is refused
 *
 * `evidence_chains.source_count >= 1` is a database CHECK, so a figure that cites no
 * Source_Record has no storable chain. A resolved scope holding **no Settlement at
 * all** therefore has no grounded `total_shortfall_paise` to return, and this tool
 * refuses rather than returning `0n` with no chain — an ungrounded figure is the one
 * thing the Financial_Tool_Layer exists to prevent, and `incomplete_evidence` would
 * be a lie because nothing was unreadable. The refusal surfaces as `tool_failure`
 * with cause `execution_error`. Reported as a gap: design.md specifies no result
 * shape for "your window contains nothing", and the honest fix is either a nullable
 * figure in the tool table or a `source_count >= 0` chain, both of which are
 * decisions above this task.
 *
 * A scope holding Settlements of which **none** contributes is fine: the aggregate
 * chain sums a `literal '0'`, cites every examined Settlement, and the figure is a
 * grounded `0n`.
 *
 * ## The read seam, and what is not here
 *
 * `ctx.db` is **not read**. Every settlement table is `ENABLE`d and `FORCE`d for
 * row-level security with no policies until task 26.1, so PostgREST matches zero
 * rows for every role without `BYPASSRLS`; a live adapter written today would
 * silently answer "no settlements" for every Tenant. {@link SettlementScopeStore}
 * and `EvidenceChainStore` are therefore injected as **factories over the
 * `ToolContext`**, so 26.x supplies `ctx.db`-backed adapters without this file
 * changing. `test/db/settlement-reconciliation.test.ts` and
 * `test/db/evidence-chain.test.ts` are where the statements are proven against a
 * real SQL session today.
 *
 * `tenant_id` reaches the store from `ctx.tenant_id` — the session — and is not an
 * argument at any depth (Requirement 12.7). A cross-Tenant request answers zero
 * rows, never a permission error.
 *
 * ## Scope — what is deliberately left elsewhere
 *
 * - **Task 12.2** owns `get_settlement_difference_breakdown`: the ordering by
 *   descending absolute Difference, the 50-row limit and the aggregate remainder row
 *   (Requirement 4.6). It imports `./settlement-scope.ts` and
 *   `./settlement-evidence.ts` rather than restating either.
 * - **Task 12.7** owns the catalogue and the contract suite over it. This module exports
 *   {@link createGetSettlementReconciliation} and {@link catalogueEntryFor}, and
 *   `./catalogue.ts` registers it in one line — that module is 12.7's, created there
 *   rather than here, and `test/contract/slice-1-catalogue.test.ts` drives it through
 *   `runToolContract`. Nothing about this tool changed to satisfy the contract.
 * - **Task 13.2** owns the Reconciliation_Agent run: applying Requirement 4.7's
 *   trailing-90-day default (which is `resolveSettlementScope`, exported from
 *   `./settlement-scope.ts`), the 120-second bound, the run identifier, persisting
 *   `settlement_reconciliations` rows through `createSettlementReconciler`, and
 *   creating `settlement_mismatch` Exceptions. **This tool persists no
 *   reconciliation row and creates no Exception**: it is `read_only`, and the only
 *   thing it writes is the Evidence_Chain a figure cannot exist without.
 * - **Task 26.x** owns the RLS policies, the read-only role with no write grants,
 *   and the live store adapters.
 *
 * ## Reported, not silently patched
 *
 * 1. **design.md never defines what `total_shortfall_paise` sums** (task 11.1's
 *    finding 4, still open). Decided above from the sequence diagram's figure.
 * 2. **`total_shortfall_paise` names two different quantities in the codebase**: this
 *    tool's Σ positive Difference, and task 11.1's `TotalShortfall.total_shortfall_paise`
 *    Σ positive residual. Both are defensible readings of an undefined term; having
 *    one name for both is not, and design.md is where the term should be fixed.
 * 3. **design.md writes `examined: ExaminedCounts` and defines no such shape.** The
 *    only existing declaration is task 11.1's per-Settlement four-count row shape,
 *    which is not Requirement 4.7's five record types. See
 *    `./settlement-scope.ts` for `ExaminedRecordCounts` and why both are kept.
 * 4. **design.md writes `scope: DateRange` and defines no such shape.** Declared as
 *    the two inclusive `DateOnly` bounds in `./settlement-scope.ts`.
 * 5. **design.md's input makes `from` and `to` required**, so this tool can never
 *    take Requirement 4.7's "request states no date range" branch. Its own sequence
 *    diagram agrees — the Agent resolves the window — so the default lives in
 *    `resolveSettlementScope` for task 13.2 to apply, and the tool validates and
 *    echoes what it was given. Implemented as written.
 * 6. **The recon-line identifier collision is live.** A combined report line keys on
 *    `entity_id`, so a line and its Payment contend for one `razorpay_objects` row.
 *    The judgement call it forces on the chain's citations is recorded on
 *    `./settlement-scope.ts`; it needs a migration and is not fixed here.
 * 7. **design.md fixes no row order for this tool.** Ascending settlement date then
 *    identifier, so the answer is a function of the set (Requirement 4.15).
 */

import { z } from 'zod';

import {
  RECON_STATUSES,
  reconcileSettlement,
  type SettlementRecon,
  totalShortfall,
} from '@/agents/reconciliation/reconcile-settlement';
import { type Paise, sum } from '@/calc/calculation-service';
import {
  createEvidenceChainBuilder,
  type EvidenceChain,
  type EvidenceChainInput,
  type EvidenceChainStore,
  incompleteEvidence,
  type IncompleteEvidence,
} from '@/evidence/chain-builder';

import {
  DIFFERENCE_STEP_INDEX,
  EXPECTED_AMOUNT_STEP_INDEX,
  type ReconciledPair,
  reconciledSettlementChain,
  RESIDUAL_STEP_INDEX,
  contributesToTotalShortfall,
  totalShortfallChain,
  unreconciledSettlementChain,
} from './settlement-evidence';
import {
  assertDateRange,
  examinedCountsFor,
  inScopeOrder,
  reconReportLinesOf,
  type ScopedSettlement,
  type SettlementScopeStore,
  unreadableIn,
  unreconciledSourceOf,
} from './settlement-scope';
import { catalogued } from './registry';
import {
  type ErasedFinancialTool,
  type FinancialTool,
  TOOL_TIMEOUT_MS,
  type ToolContext,
  type ToolResult,
} from './tool';

export {
  DIFFERENCE_STEP_INDEX,
  EXPECTED_AMOUNT_STEP_INDEX,
  RESIDUAL_STEP_INDEX,
};

/** design.md's catalogue name, and `evidence_chains.produced_by` for every chain here. */
export const GET_SETTLEMENT_RECONCILIATION = 'get_settlement_reconciliation';

/* -------------------------------------------------------------------------- */
/* Input schema                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A Razorpay Settlement identifier. Pattern-bounded, so the argument cannot carry
 * free-form text or SQL (Requirement 12.9). The width admits both a live identifier
 * (`setl_` plus 14 base-62 characters) and the synthetic ones the fixtures use.
 */
const SETTLEMENT_ID_RE = /^setl_[A-Za-z0-9]{4,40}$/;

/** How many identifiers one request may name. A bound, not a page: the range is the scope. */
export const MAX_SETTLEMENT_IDS = 200;

/** `YYYY-MM-DD` that is also a real calendar date. `2026-02-30` is neither. */
function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const inputSchema = z
  .strictObject({
    from: z.iso.date(),
    to: z.iso.date(),
    settlement_ids: z.array(z.string().regex(SETTLEMENT_ID_RE)).min(1).max(MAX_SETTLEMENT_IDS).optional(),
  })
  // Both refinements are here rather than in `execute` so a bad range is a
  // `schema_violation` naming the argument, with no connection opened and the
  // rejection appended to the Audit_Log (Requirement 12.9). A throw inside `execute`
  // would surface as `tool_failure` and tell the caller nothing about which argument
  // was wrong.
  .refine((value) => isRealDate(value.from), {
    error: 'from must be a real calendar date',
    path: ['from'],
  })
  .refine((value) => isRealDate(value.to), {
    error: 'to must be a real calendar date',
    path: ['to'],
  })
  .refine((value) => value.from <= value.to, {
    error: 'from must be on or before to; a settlement date range runs forward',
    path: ['from'],
  });

export type GetSettlementReconciliationInput = z.infer<typeof inputSchema>;

/* -------------------------------------------------------------------------- */
/* Output schema                                                              */
/* -------------------------------------------------------------------------- */

/** Requirement 4.5's three labels, plus Requirement 4.4's absence of a direction. */
const RESIDUAL_DIRECTIONS = [
  'unexplained_shortfall',
  'unexplained_excess',
  'not_applicable',
] as const;

const paise = z.bigint();

/**
 * One row: design.md's `SettlementRecon`, plus the three things Requirement 4.13 and
 * Requirement 12.2 need reported against the Settlement identifier and which
 * design.md's interface has no field for.
 */
const rowSchema = z.strictObject({
  settlement_id: z.string().regex(SETTLEMENT_ID_RE),
  settlement_date: z.iso.date(),
  expected_paise: paise.nullable(),
  received_paise: paise,
  difference_paise: paise.nullable(),
  fee_component_paise: paise.nullable(),
  gst_component_paise: paise.nullable(),
  residual_paise: paise.nullable(),
  status: z.enum(RECON_STATUSES),
  direction: z.enum(RESIDUAL_DIRECTIONS),
  /** `null` for an absent Settlement_Recon_Report (Requirement 4.13). */
  recon_report_id: z.string().nullable(),
  /**
   * Requirement 4.13's "the Settlement identifier together with the absent or empty
   * source record type". `null` for a Settlement that reconciled.
   */
  unreconciled_source: z
    .strictObject({
      type: z.literal('settlement_recon_report'),
      reason: z.enum(['absent', 'enumerates_zero_payments']),
    })
    .nullable(),
  /** Grounds every monetary field of this row (Requirement 12.2). Never null. */
  evidence_chain_id: z.uuid(),
  /** The chain's as-of: the newest contributing `record_updated_at`. */
  evidence_as_of: z.iso.datetime(),
});

const outputSchema = z.strictObject({
  rows: z.array(rowSchema),
  /** Σ Difference over in-scope Settlements whose Difference is positive. `>= 0n`. */
  total_shortfall_paise: paise,
  /** design.md's `DateRange`: the range Requirement 4.7 reports against the figure. */
  scope: z.strictObject({ from: z.iso.date(), to: z.iso.date() }),
  /** Requirement 4.7's five record types. */
  examined: z.strictObject({
    payments_examined: z.number().int().nonnegative(),
    settlements_examined: z.number().int().nonnegative(),
    refunds_examined: z.number().int().nonnegative(),
    ledger_entries_examined: z.number().int().nonnegative(),
    razorpay_invoices_examined: z.number().int().nonnegative(),
  }),
  /** Requirement 4.7's count of Settlements with a non-zero residual, both directions. */
  residual_nonzero_count: z.number().int().nonnegative(),
});

export type GetSettlementReconciliationOutput = z.infer<typeof outputSchema>;
export type SettlementReconciliationRow = z.infer<typeof rowSchema>;

/* -------------------------------------------------------------------------- */
/* Dependencies                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The two seams, as factories over the invocation context.
 *
 * Factories rather than instances so the Tenant and the connection travel from
 * `ToolContext` into the store, which is what lets task 26.x hand back a
 * `ctx.db`-backed adapter with no change here. A unit test hands back an in-memory
 * one.
 */
export interface GetSettlementReconciliationDeps {
  readonly settlements: (ctx: ToolContext) => SettlementScopeStore;
  readonly chains: (ctx: ToolContext) => EvidenceChainStore;
}

/* -------------------------------------------------------------------------- */
/* The tool                                                                   */
/* -------------------------------------------------------------------------- */

/** Aborted mid-invocation. Becomes `tool_failure` cause `execution_error`. */
class ReconciliationToolError extends Error {
  override readonly name = 'ReconciliationToolError';
}

/**
 * Requirement 4.7's total shortfall: Σ Difference over the in-scope Settlements whose
 * Difference is positive.
 *
 * Every operand and the running total are range-checked by the Calculation Service.
 * Nothing is netted; see decision 1 in the module doc comment.
 *
 * @throws {PaiseRangeError} when the running total leaves the paise range.
 */
export function totalShortfallOf(pairs: readonly ReconciledPair[]): Paise {
  const differences: Paise[] = [];
  for (const pair of pairs) {
    const difference = pair.recon.difference_paise;
    if (contributesToTotalShortfall(pair) && difference !== null) {
      differences.push(difference);
    }
  }
  return sum(differences);
}

/**
 * Build the tool. A factory because both seams are injected — see
 * {@link GetSettlementReconciliationDeps}.
 */
export function createGetSettlementReconciliation(
  deps: GetSettlementReconciliationDeps,
): FinancialTool<GetSettlementReconciliationInput, GetSettlementReconciliationOutput> {
  return {
    name: GET_SETTLEMENT_RECONCILIATION,
    // Reads only. It persists Evidence_Chains, which is not Tenant financial state:
    // a figure cannot be returned without one (Requirement 12.2), and design.md
    // declares this tool read-only.
    mode: 'read_only',
    inputSchema,
    outputSchema,
    timeoutMs: TOOL_TIMEOUT_MS,

    async execute(
      ctx: ToolContext,
      input: GetSettlementReconciliationInput,
    ): Promise<ToolResult<GetSettlementReconciliationOutput>> {
      // Requirement 4.7's reported range. Already accepted by the input schema; this
      // is the single place the resolved scope is named, and it is what the output
      // echoes so `scope` can never disagree with what was read.
      const scope = assertDateRange({ from: input.from, to: input.to }, 'scope');

      const read = await deps.settlements(ctx).listInScope({
        // From the session, never from an argument (Requirement 12.7).
        tenant_id: ctx.tenant_id,
        scope,
        settlement_ids: input.settlement_ids ?? null,
      });

      // Requirement 12.3, before any figure is computed: one unreadable contributing
      // record withholds the whole figure, because the total is composed from every
      // in-scope Settlement. No chain is composed and no statement is issued.
      const unreadable = unreadableIn(read.settlements);
      if (unreadable.length > 0) {
        return incompleteEvidence(unreadable);
      }

      const ordered = inScopeOrder(read.settlements);
      const pairs: ReconciledPair[] = ordered.map((settlement) => ({
        settlement,
        // Task 11.1's algorithm. Nothing here recomputes any of it.
        recon: reconcileSettlement(
          settlement.settlement_id,
          settlement.received_paise,
          reconReportLinesOf(settlement),
        ),
      }));

      const total = totalShortfallOf(pairs);
      const builder = createEvidenceChainBuilder({
        store: deps.chains(ctx),
        // The session Tenant, bound once. No method takes one.
        tenantId: ctx.tenant_id,
      });

      /**
       * Compose and persist one chain.
       *
       * `builder.build` answers either the composed chain or `incomplete_evidence`,
       * and the latter is already a `ToolResult` variant, so it is returned as-is
       * rather than translated.
       */
      const persist = async (
        chain: EvidenceChainInput,
      ): Promise<EvidenceChain | IncompleteEvidence> => {
        if (ctx.signal.aborted) {
          // The 10-second bound has elapsed. Stop before issuing another write rather
          // than leaving chains behind for a figure that will never be returned.
          throw new ReconciliationToolError(
            `${GET_SETTLEMENT_RECONCILIATION} was aborted while composing Evidence_Chains`,
          );
        }
        const built = await builder.build(chain);
        return built.ok ? built.evidence : built;
      };

      const rows: SettlementReconciliationRow[] = [];
      for (const pair of pairs) {
        const chain =
          pair.recon.status === 'unreconciled'
            ? unreconciledSettlementChain(GET_SETTLEMENT_RECONCILIATION, pair.settlement)
            : reconciledSettlementChain(
                GET_SETTLEMENT_RECONCILIATION,
                pair.settlement,
                pair.recon,
              );
        const persisted = await persist(chain);
        if ('ok' in persisted) {
          return persisted;
        }
        rows.push(
          rowFor(pair.settlement, pair.recon, persisted.evidence_chain_id, persisted.as_of),
        );
      }

      // The envelope chain, grounding the one top-level figure and nothing else.
      const envelope = await persist(
        totalShortfallChain(GET_SETTLEMENT_RECONCILIATION, pairs, total),
      );
      if ('ok' in envelope) {
        return envelope;
      }

      return {
        ok: true,
        value: {
          rows,
          total_shortfall_paise: total,
          scope,
          examined: examinedCountsFor(read),
          // Requirement 4.7's count, from task 11.1's aggregation so the definition of
          // "non-zero residual" is stated once.
          residual_nonzero_count: totalShortfall(pairs.map((pair) => pair.recon))
            .residual_nonzero_count,
        },
        evidence: envelope,
      };
    },
  };
}

/**
 * The tool as a catalogue entry, ready for `createToolRegistry` (task 12.7).
 *
 * `catalogued` is identity at runtime; it exists so TypeScript checks the whole
 * declaration — including `NoTenantId<In>`, which is what makes a `tenant_id`
 * argument uninhabitable — at the hand-off rather than losing it in an erased list.
 */
export function catalogueEntryFor(
  deps: GetSettlementReconciliationDeps,
): ErasedFinancialTool {
  return catalogued(createGetSettlementReconciliation(deps));
}

/** One row from a reconciliation and the chain that grounds it. */
function rowFor(
  settlement: ScopedSettlement,
  recon: SettlementRecon,
  evidenceChainId: string,
  evidenceAsOf: string,
): SettlementReconciliationRow {
  return {
    settlement_id: recon.settlement_id,
    settlement_date: settlement.settlement_date,
    expected_paise: recon.expected_paise,
    received_paise: recon.received_paise,
    difference_paise: recon.difference_paise,
    fee_component_paise: recon.fee_component_paise,
    gst_component_paise: recon.gst_component_paise,
    residual_paise: recon.residual_paise,
    status: recon.status,
    direction: recon.direction,
    recon_report_id: settlement.recon_report_id,
    unreconciled_source: unreconciledSourceOf(settlement),
    evidence_chain_id: evidenceChainId,
    evidence_as_of: evidenceAsOf,
  };
}
