/**
 * `get_settlement_difference_breakdown` — the second production Financial_Tool
 * (task 12.2). Requirements 4.3, 4.6, 12.2.
 *
 * `get_settlement_reconciliation` (task 12.1) answers "how much is missing across
 * this window". This tool answers the follow-up: **which Settlements, largest gap
 * first, and what explains each gap**. design.md's reconciliation sequence calls it
 * `T2` — `RA->>T2: {tenant_id, from, to, limit 50}`, then `T2->>CALC: per settlement
 * fee_component + gst_component + residual` — and fixes the contract exactly:
 *
 *     in   { from: DateOnly; to: DateOnly; limit: 1..50 }
 *     out  { rows: DifferenceRow[];
 *            remainder: { count: number; total_absolute_difference_paise: Paise } }
 *
 * ## Nothing here is a second copy of task 12.1
 *
 * | Concern | Where |
 * |---|---|
 * | the resolved scope, the examined lines, the read seam, Requirement 12.3's unreadable set | `./settlement-scope.ts` |
 * | the twelve-step per-row chain, and the aggregate chain behind the remainder total | `./settlement-evidence.ts` |
 * | Expected Amount, Difference, the three-way decomposition | `@/agents/reconciliation/reconcile-settlement` (task 11.1) |
 * | composing, validating and persisting a chain | `@/evidence/chain-builder` (task 9.1) |
 * | parse, authorize, bound, envelope check | `./tool.ts` (task 10.1) |
 * | **the row set, the order, the limit and the remainder** | here |
 *
 * The per-row chain is `reconciledSettlementChain` **unchanged** — design.md's twelve
 * steps, figure = residual, Expected Amount at step 7, Difference at step 8. This
 * file composes no step of its own for a row, so the two tools cannot come to report
 * the same five figures over two chains that differ by a step. The one thing 12.2
 * needed and 12.1 did not have is `totalAbsoluteDifferenceChain`, and that was
 * **added to the shared module** rather than kept private here, next to
 * `totalShortfallChain` which it is the sibling of.
 *
 * **No money is computed in this file.** Every figure comes from
 * `reconcileSettlement` or from the Calculation Service through
 * `./settlement-evidence.ts`, and the recomputed chain is cross-checked against the
 * reported figures before anything is written.
 *
 * ## Decision 1: which Settlements are rows — the asymmetry with 12.1
 *
 * Requirement 4.6 asks for "one breakdown row per in-scope Settlement whose
 * Difference is not equal to 0 paise". So, unlike `get_settlement_reconciliation`,
 * which reports **every** in-scope Settlement:
 *
 * - a Settlement whose Difference is exactly `0n` is **not** a row. No tolerance
 *   band, in either direction (Requirement 4.4's stance, applied to the Difference).
 * - an `unreconciled` Settlement is **not** a row: `difference_paise` is `null`
 *   because no Difference was computed at all (Requirement 4.13). It is not a
 *   zero-Difference row and it is not a hidden one; it is absent, and 12.1 is the
 *   tool that reports it.
 * - an **excess** is a row. A negative Difference is as non-zero as a positive one,
 *   which is why Requirement 4.6 orders on the absolute value.
 *
 * `hasNonZeroDifference` in `./settlement-evidence.ts` is that predicate, stated once.
 *
 * ## Decision 2: the order, and the tie-break design.md leaves open
 *
 * Requirement 4.6 fixes **descending absolute Difference** — so an excess of ₹5,000
 * outranks a shortfall of ₹3,000 — and fixes no tie-break. Two Settlements each
 * ₹5,000 out would then be ordered by whatever sequence the store returned, and the
 * *limit* would cut between them, so the returned rows would not be a function of the
 * data. Requirement 4.15's determinism does not survive that.
 *
 * > **Ties on `|Difference|` break on ascending Settlement identifier.**
 *
 * Ascending identifier is the house pattern — `inScopeOrder` in
 * `./settlement-scope.ts` uses it, `totalShortfall` in task 11.1 sorts its identifier
 * lists with it, and Requirement 10.4 and 10.5 name "ascending Source_Record
 * identifier" as the final tie-break for their own descending-absolute-amount
 * orderings. It is total, because a Settlement identifier is unique per Tenant, so
 * the whole answer — rows, their order, and which rows the remainder absorbed — is a
 * function of the in-scope set alone. Settlement *date* is deliberately **not** in
 * the key: this tool's question is about magnitude, not about a window's shape, and a
 * date-first tie-break would order two equal gaps by an attribute Requirement 4.6
 * never mentions.
 *
 * ## Decision 3: `limit` is required, bounded in the schema, and never clamped
 *
 * design.md writes `limit: 1..50`. Not optional, no default. A request for 0 rows or
 * 51 rows is therefore a **`schema_violation` naming `limit`**, with no connection
 * opened and the rejection audited (Requirement 12.9) — not a runtime clamp to the
 * nearest legal value. A clamp would answer a question the caller did not ask and
 * would report a remainder computed against a limit the caller never chose.
 *
 * ## Decision 4: what the remainder row is
 *
 * Requirement 4.6: "a single aggregate row stating the count and the total absolute
 * Difference of the remaining in-scope Settlements".
 *
 * > **The remainder is exactly the breakdown rows the limit cut off** — the
 * > `|Difference|`-ordered rows from position `limit` onward. `count` is how many,
 * > and `total_absolute_difference_paise` is Σ`|Difference|` over them.
 *
 * Three consequences, each stated because each could have gone another way:
 *
 * 1. **It is an absolute total, so it never nets.** `>= 0n` always, and a ₹5,000
 *    excess plus a ₹3,000 shortfall is ₹8,000, not ₹2,000. Requirement 4.6 says
 *    "total absolute Difference" outright, and it is the same non-netting stance 12.1
 *    took for `total_shortfall_paise` for the same reason: two Settlements wrong in
 *    opposite directions are two anomalies, not zero.
 * 2. **It is present when it is empty.** Nothing cut off gives
 *    `{ count: 0, total_absolute_difference_paise: 0n }`, not an omitted key and not
 *    `null`. A caller must never have to tell "absent" from "zero", and the figure is
 *    grounded in that case too — the aggregate chain sums a `literal '0'` and cites
 *    the examined Settlements.
 * 3. **Zero-Difference and `unreconciled` Settlements are not in it.** Requirement
 *    4.6's phrase is "the remaining in-scope Settlements", which read literally would
 *    include every Settlement that was never a candidate row. Their contribution to
 *    the total would be `0n` (or undefined, for an `unreconciled` one), so only
 *    `count` would move — and it would move in a way that makes the count mean "rows
 *    you did not see" for some Settlements and "Settlements with nothing to see" for
 *    others. Reading it as the cut-off rows keeps `count` a single fact: how many
 *    breakdown rows the limit withheld. Reported as an ambiguity in design.md and
 *    Requirement 4.6 rather than silently resolved.
 *
 * ## Decision 5: one chain per row, and the envelope grounds the remainder total
 *
 * Task 10.1's finding 1 — `ToolResult<T>` carries a **single** `EvidenceChain` — is
 * still open, and this tool does **not** widen it. Exactly as 12.1:
 *
 * - **Every row carries its own `evidence_chain_id`**, grounding all five of its
 *   monetary fields (Requirement 12.2). That chain is design.md's twelve steps with
 *   the residual as its figure; the Difference is step {@link DIFFERENCE_STEP_INDEX}
 *   and the Expected Amount step {@link EXPECTED_AMOUNT_STEP_INDEX} of the same
 *   chain, so a drill-down on either reads a step rather than a second chain.
 * - **The envelope chain grounds `remainder.total_absolute_difference_paise`**, the
 *   only monetary figure outside the rows. `remainder` declares no
 *   `evidence_chain_id` of its own precisely so that
 *   `test/contract/tool-contract.ts`'s `chainCoverageOf` attributes that field to the
 *   envelope — where the enclosing object holds exactly one monetary field, the
 *   harness additionally requires the resolved chain's `figure_paise` to equal it,
 *   which it does by construction.
 *
 * The remainder total is grounded by `totalAbsoluteDifferenceChain`, which inlines
 * each cut-off Settlement's steps 1..8 and terminates in one `sum`, so the figure
 * replays from source records rather than from literals (Requirement 12.8).
 *
 * **A finding it forced.** `evidence_operation` declares nine labels and **none of
 * them is `abs`**. `|Difference|` is therefore expressed as a `negate` step over step
 * 8 wherever the Difference is negative, and as step 8 itself where it is positive.
 * That is exact and replayable; it is not a workaround for a missing enum value, and
 * no enum label was invented — a migration is not this task's to write. See
 * `./settlement-evidence.ts` for the full note.
 *
 * ## What this tool does not report, though 12.1 does
 *
 * No `scope` and no `examined`. design.md's output for this tool is `rows` and
 * `remainder`, and Requirement 4.7's scope-and-counts reporting hangs off the *total
 * shortfall* figure, which is `get_settlement_reconciliation`'s. The scope is still
 * validated and still the only thing read; it is simply not echoed. Widening the
 * output to echo it would put two tools in the business of answering Requirement 4.7.
 *
 * ## Counts are `number`, figures are `bigint`
 *
 * `remainder.count` is a count of Settlements, so `number` is right and the ESLint
 * money rule does not fire on it. Every `*_paise` field is `Paise` (`bigint`); the
 * decimal-string encoding is the transport layer's, through `toWire`, and nothing
 * here converts.
 *
 * ## The read seam, and what is not here
 *
 * `ctx.db` is **not read**. Every settlement table is `ENABLE`d and `FORCE`d for
 * row-level security with no policies until task 26.1, so PostgREST matches zero rows
 * for every role without `BYPASSRLS`; a live adapter written today would silently
 * answer "no settlements" for every Tenant. Both seams are injected as **factories
 * over the `ToolContext`**, exactly as 12.1 injects them, so 26.x supplies
 * `ctx.db`-backed adapters with no change to this file.
 *
 * `tenant_id` reaches the store from `ctx.tenant_id` — the session — and is not an
 * argument at any depth (Requirement 12.7). A cross-Tenant request answers zero rows,
 * never a permission error, and a scope holding no Settlement at all is refused as
 * `tool_failure` cause `execution_error` rather than answered with an ungrounded
 * zero: `evidence_chains.source_count >= 1` makes an unsourced figure unstorable, and
 * `incomplete_evidence` would be a lie because nothing was unreadable. Same call
 * 12.1 made, same gap reported — design.md specifies no result shape for "your window
 * contains nothing".
 *
 * ## Scope — deliberately left elsewhere
 *
 * - **Task 12.7** runs the contract harness over the Slice 1 catalogue. This module
 *   exports {@link createGetSettlementDifferenceBreakdown} and
 *   {@link catalogueEntryFor}, and `./catalogue.ts` — 12.7's module, not this one —
 *   registers it in one line. `test/contract/slice-1-catalogue.test.ts` drives that
 *   catalogue through `runToolContract`; nothing here changed to satisfy it.
 * - **Task 13.2** owns the Reconciliation_Agent run: Requirement 4.7's trailing-90-day
 *   default (`resolveSettlementScope`, already exported from `./settlement-scope.ts`),
 *   the 120-second bound, the run identifier, persisting `settlement_reconciliations`
 *   rows and creating `settlement_mismatch` Exceptions. **This tool persists no
 *   reconciliation row and creates no Exception**; it is `read_only`, and the only
 *   thing it writes is the Evidence_Chain a figure cannot exist without.
 * - **Task 26.x** owns the RLS policies, the read-only role and the live adapters.
 *
 * ## Reported, not silently patched
 *
 * 1. **design.md never declares `DifferenceRow`.** Its tool table names the type and
 *    defines it nowhere — the same gap it has for `ExaminedCounts` and `DateRange`.
 *    {@link differenceRowSchema} is Requirement 4.6's seven named fields plus the
 *    Evidence_Chain identifier and as-of that Requirement 12.2 and 12.4 need, and
 *    nothing else.
 * 2. **Requirement 4.6's "the remaining in-scope Settlements" is ambiguous.** Decided
 *    as the cut-off rows; see decision 4.
 * 3. **Requirement 4.6 fixes no tie-break for equal absolute Differences.** Chosen as
 *    ascending Settlement identifier; see decision 2.
 * 4. **`evidence_operation` has no `abs`.** Composed from `negate`; see decision 5.
 * 5. **The single-`evidence` envelope still cannot carry per-row chains.** Task
 *    10.1's finding 1, unchanged: resolved inside `Out` rather than by widening
 *    `ToolResult`.
 * 6. **A scope holding no Settlement has no specified result shape.** Refused; see
 *    above.
 */

import { z } from 'zod';

import { reconcileSettlement } from '@/agents/reconciliation/reconcile-settlement';
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
  absoluteDifferencePaise,
  DIFFERENCE_STEP_INDEX,
  EXPECTED_AMOUNT_STEP_INDEX,
  hasNonZeroDifference,
  type ReconciledPair,
  reconciledSettlementChain,
  RESIDUAL_STEP_INDEX,
  totalAbsoluteDifferenceChain,
} from './settlement-evidence';
import {
  assertDateRange,
  inScopeOrder,
  reconReportLinesOf,
  type SettlementScopeStore,
  unreadableIn,
} from './settlement-scope';
import { catalogued } from './registry';
import {
  type ErasedFinancialTool,
  type FinancialTool,
  TOOL_TIMEOUT_MS,
  type ToolContext,
  type ToolResult,
} from './tool';

export { DIFFERENCE_STEP_INDEX, EXPECTED_AMOUNT_STEP_INDEX, RESIDUAL_STEP_INDEX };

/** design.md's catalogue name, and `evidence_chains.produced_by` for every chain here. */
export const GET_SETTLEMENT_DIFFERENCE_BREAKDOWN = 'get_settlement_difference_breakdown';

/* -------------------------------------------------------------------------- */
/* Input schema                                                               */
/* -------------------------------------------------------------------------- */

/** design.md's `limit: 1..50`, both ends inclusive. Requirement 4.6's 50. */
export const MIN_BREAKDOWN_LIMIT = 1;
export const MAX_BREAKDOWN_LIMIT = 50;

/**
 * A Razorpay Settlement identifier, for the **output** schema. Pattern-bounded so a
 * row cannot carry free-form text, and the same pattern
 * `get_settlement_reconciliation` states, admitting a live identifier (`setl_` plus
 * 14 base-62 characters) and the synthetic ones the fixtures use.
 */
const SETTLEMENT_ID_RE = /^setl_[A-Za-z0-9]{4,40}$/;

/** `YYYY-MM-DD` that is also a real calendar date. `2026-02-30` is neither. */
function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const inputSchema = z
  .strictObject({
    from: z.iso.date(),
    to: z.iso.date(),
    /**
     * Required and bounded here rather than clamped in `execute`, so an out-of-range
     * limit is a `schema_violation` naming `limit` with no connection opened
     * (Requirement 12.9). See decision 3 in the module doc comment.
     */
    limit: z.number().int().min(MIN_BREAKDOWN_LIMIT).max(MAX_BREAKDOWN_LIMIT),
  })
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

export type GetSettlementDifferenceBreakdownInput = z.infer<typeof inputSchema>;

/* -------------------------------------------------------------------------- */
/* Output schema                                                              */
/* -------------------------------------------------------------------------- */

const paise = z.bigint();

/**
 * design.md's undeclared `DifferenceRow` (finding 1): Requirement 4.6's seven named
 * fields, plus the two Requirement 12.2 and 12.4 need.
 *
 * Every monetary field is non-nullable, which is structural rather than optimistic: a
 * row exists only for a Settlement with a computed, non-zero Difference, and such a
 * Settlement has all five figures (Requirement 4.13's `null`s belong to the
 * `unreconciled` case, which is not a row here).
 */
export const differenceRowSchema = z.strictObject({
  settlement_id: z.string().regex(SETTLEMENT_ID_RE),
  expected_paise: paise,
  received_paise: paise,
  /** `expected − received`. Non-zero, either sign. */
  difference_paise: paise,
  /** Requirement 4.3's Σ Razorpay_Fee lines. */
  fee_component_paise: paise,
  /** Requirement 4.3's Σ GST_On_Fee lines. */
  gst_component_paise: paise,
  /** Requirement 4.3's `difference − fee − gst`. */
  residual_paise: paise,
  /** Grounds every monetary field of this row (Requirement 12.2). Never null. */
  evidence_chain_id: z.uuid(),
  /** The chain's as-of: the newest contributing `record_updated_at`. */
  evidence_as_of: z.iso.datetime(),
});

const outputSchema = z.strictObject({
  /** Descending `|Difference|`, ties on ascending identifier. At most `limit` rows. */
  rows: z.array(differenceRowSchema).max(MAX_BREAKDOWN_LIMIT),
  /**
   * Requirement 4.6's single aggregate row: the breakdown rows the limit cut off.
   * Always present, `{ count: 0, total_absolute_difference_paise: 0n }` when nothing
   * was cut off. Grounded by the envelope Evidence_Chain — see decision 5.
   */
  remainder: z.strictObject({
    count: z.number().int().nonnegative(),
    /** Σ `|Difference|` over the cut-off rows. Absolute, so always `>= 0n`. */
    total_absolute_difference_paise: paise,
  }),
});

export type GetSettlementDifferenceBreakdownOutput = z.infer<typeof outputSchema>;
export type DifferenceRow = z.infer<typeof differenceRowSchema>;

/* -------------------------------------------------------------------------- */
/* Dependencies                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The two seams, as factories over the invocation context — the same shape
 * `get_settlement_reconciliation` declares, for the same reason: the Tenant and the
 * connection travel from `ToolContext` into the store, which is what lets task 26.x
 * hand back a `ctx.db`-backed adapter with no change here.
 */
export interface GetSettlementDifferenceBreakdownDeps {
  readonly settlements: (ctx: ToolContext) => SettlementScopeStore;
  readonly chains: (ctx: ToolContext) => EvidenceChainStore;
}

/* -------------------------------------------------------------------------- */
/* Ordering (Requirement 4.6, 4.15)                                           */
/* -------------------------------------------------------------------------- */

/** Aborted mid-invocation. Becomes `tool_failure` cause `execution_error`. */
class DifferenceBreakdownToolError extends Error {
  override readonly name = 'DifferenceBreakdownToolError';
}

/**
 * Requirement 4.6's candidate rows, in Requirement 4.6's order: the in-scope
 * Settlements whose Difference is non-zero, descending `|Difference|`, ties on
 * ascending Settlement identifier.
 *
 * Pure and total, and a function of the **set**: `pairs` may arrive in any order and
 * the answer is the same, which is what Requirement 4.15's determinism needs of a
 * result the limit then cuts. Exported so a test can assert the order without going
 * through the invoker.
 *
 * @throws {PaiseRangeError} when a Difference leaves the paise range.
 */
export function breakdownRowsInOrder(
  pairs: readonly ReconciledPair[],
): readonly ReconciledPair[] {
  const candidates = pairs.filter(hasNonZeroDifference);
  const magnitude = new Map<string, Paise>();
  for (const pair of candidates) {
    const absolute = absoluteDifferencePaise(pair);
    if (absolute === null) {
      // Unreachable: `hasNonZeroDifference` already excluded a null Difference.
      throw new DifferenceBreakdownToolError(
        `${pair.settlement.settlement_id} passed the non-zero Difference test and then stated no ` +
          `Difference`,
      );
    }
    magnitude.set(pair.settlement.settlement_id, absolute);
  }
  const absoluteOf = (pair: ReconciledPair): Paise =>
    magnitude.get(pair.settlement.settlement_id) ?? 0n;

  return [...candidates].sort((a, b) => {
    const left = absoluteOf(a);
    const right = absoluteOf(b);
    if (left !== right) {
      // Descending magnitude. `bigint` comparison, never a `Number` subtraction: a
      // difference of two paise values can exceed the safe integer range.
      return left > right ? -1 : 1;
    }
    const leftId = a.settlement.settlement_id;
    const rightId = b.settlement.settlement_id;
    if (leftId === rightId) {
      return 0;
    }
    // The tie-break design.md leaves open. See decision 2.
    return leftId < rightId ? -1 : 1;
  });
}

/**
 * Σ `|Difference|` over the cut-off rows: Requirement 4.6's remainder total.
 *
 * Every operand and the running total are range-checked by the Calculation Service.
 * Absolute, so nothing nets and the figure is always `>= 0n`.
 *
 * @throws {PaiseRangeError} when the running total leaves the paise range.
 */
export function totalAbsoluteDifferenceOf(pairs: readonly ReconciledPair[]): Paise {
  const magnitudes: Paise[] = [];
  for (const pair of pairs) {
    const absolute = absoluteDifferencePaise(pair);
    if (absolute !== null) {
      magnitudes.push(absolute);
    }
  }
  return sum(magnitudes);
}

/* -------------------------------------------------------------------------- */
/* The tool                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build the tool. A factory because both seams are injected — see
 * {@link GetSettlementDifferenceBreakdownDeps}.
 */
export function createGetSettlementDifferenceBreakdown(
  deps: GetSettlementDifferenceBreakdownDeps,
): FinancialTool<
  GetSettlementDifferenceBreakdownInput,
  GetSettlementDifferenceBreakdownOutput
> {
  return {
    name: GET_SETTLEMENT_DIFFERENCE_BREAKDOWN,
    // Reads only. It persists Evidence_Chains, which is not Tenant financial state:
    // a figure cannot be returned without one (Requirement 12.2).
    mode: 'read_only',
    inputSchema,
    outputSchema,
    timeoutMs: TOOL_TIMEOUT_MS,

    async execute(
      ctx: ToolContext,
      input: GetSettlementDifferenceBreakdownInput,
    ): Promise<ToolResult<GetSettlementDifferenceBreakdownOutput>> {
      // Already accepted by the input schema; this is the single place the resolved
      // scope is named, and it is the only thing the store is asked for.
      const scope = assertDateRange({ from: input.from, to: input.to }, 'scope');

      const read = await deps.settlements(ctx).listInScope({
        // From the session, never from an argument (Requirement 12.7).
        tenant_id: ctx.tenant_id,
        scope,
        // design.md's input for this tool names no `settlement_ids`; the range is the
        // whole scope. `get_settlement_reconciliation` is the tool that narrows.
        settlement_ids: null,
      });

      // Requirement 12.3, before any figure is computed: one unreadable contributing
      // record withholds the whole answer. The remainder total is composed from the
      // in-scope set, so a partially read scope cannot produce a complete chain for
      // it — and a row set missing a Settlement nobody could read would be a partial
      // answer presented as a whole one.
      const unreadable = unreadableIn(read.settlements);
      if (unreadable.length > 0) {
        return incompleteEvidence(unreadable);
      }

      // `inScopeOrder` first, so the *examined* citation order in the aggregate chain
      // is a function of the set too, independent of the store's return order.
      const pairs: readonly ReconciledPair[] = inScopeOrder(read.settlements).map(
        (settlement) => ({
          settlement,
          // Task 11.1's algorithm. Nothing here recomputes any of it.
          recon: reconcileSettlement(
            settlement.settlement_id,
            settlement.received_paise,
            reconReportLinesOf(settlement),
          ),
        }),
      );

      const ordered = breakdownRowsInOrder(pairs);
      const shown = ordered.slice(0, input.limit);
      const cutOff = ordered.slice(input.limit);
      const remainderTotal = totalAbsoluteDifferenceOf(cutOff);

      const builder = createEvidenceChainBuilder({
        store: deps.chains(ctx),
        // The session Tenant, bound once. No method takes one.
        tenantId: ctx.tenant_id,
      });

      /** Compose and persist one chain, or hand back `incomplete_evidence` as-is. */
      const persist = async (
        chain: EvidenceChainInput,
      ): Promise<EvidenceChain | IncompleteEvidence> => {
        if (ctx.signal.aborted) {
          // The 10-second bound has elapsed. Stop before issuing another write rather
          // than leaving chains behind for a figure that will never be returned.
          throw new DifferenceBreakdownToolError(
            `${GET_SETTLEMENT_DIFFERENCE_BREAKDOWN} was aborted while composing Evidence_Chains`,
          );
        }
        const built = await builder.build(chain);
        return built.ok ? built.evidence : built;
      };

      const rows: DifferenceRow[] = [];
      for (const pair of shown) {
        // design.md's twelve steps, from the shared module. No step is composed here.
        const persisted = await persist(
          reconciledSettlementChain(
            GET_SETTLEMENT_DIFFERENCE_BREAKDOWN,
            pair.settlement,
            pair.recon,
          ),
        );
        if ('ok' in persisted) {
          return persisted;
        }
        rows.push(rowFor(pair, persisted.evidence_chain_id, persisted.as_of));
      }

      // The envelope chain grounds `remainder.total_absolute_difference_paise` and
      // nothing else. Every in-scope Settlement is cited as examined; only the
      // cut-off rows contribute steps.
      const envelope = await persist(
        totalAbsoluteDifferenceChain(GET_SETTLEMENT_DIFFERENCE_BREAKDOWN, {
          contributors: cutOff,
          examined: pairs,
          total_absolute_difference_paise: remainderTotal,
        }),
      );
      if ('ok' in envelope) {
        return envelope;
      }

      return {
        ok: true,
        value: {
          rows,
          remainder: {
            // A count of Settlements, not money.
            count: cutOff.length,
            total_absolute_difference_paise: remainderTotal,
          },
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
 * declaration — including `NoTenantId<In>` — at the hand-off rather than losing it in
 * an erased list.
 */
export function catalogueEntryFor(
  deps: GetSettlementDifferenceBreakdownDeps,
): ErasedFinancialTool {
  return catalogued(createGetSettlementDifferenceBreakdown(deps));
}

/**
 * One breakdown row from a reconciliation and the chain that grounds it.
 *
 * @throws {DifferenceBreakdownToolError} when a figure is `null`, which would mean an
 * `unreconciled` Settlement reached the row set. Structurally unreachable through
 * {@link breakdownRowsInOrder}; refused rather than coerced, because a `0n` in place
 * of an absent Expected Amount is the kind of figure Requirement 4.13 exists to keep
 * out of an answer.
 */
function rowFor(pair: ReconciledPair, evidenceChainId: string, evidenceAsOf: string): DifferenceRow {
  const { recon } = pair;
  const {
    expected_paise,
    difference_paise,
    fee_component_paise,
    gst_component_paise,
    residual_paise,
  } = recon;
  if (
    expected_paise === null ||
    difference_paise === null ||
    fee_component_paise === null ||
    gst_component_paise === null ||
    residual_paise === null
  ) {
    throw new DifferenceBreakdownToolError(
      `${recon.settlement_id} states one or more figures as null, so it is unreconciled ` +
        `(Requirement 4.13) and has no Difference to break down; it is not a breakdown row`,
    );
  }
  return {
    settlement_id: recon.settlement_id,
    expected_paise,
    received_paise: recon.received_paise,
    difference_paise,
    fee_component_paise,
    gst_component_paise,
    residual_paise,
    evidence_chain_id: evidenceChainId,
    evidence_as_of: evidenceAsOf,
  };
}
