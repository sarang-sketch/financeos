/**
 * `get_control_tower_metrics` — the four Control_Tower cells (task 12.6).
 * Requirements 3.1, 3.7–3.10, 3.12, 12.2, 12.3.
 *
 * design.md fixes the contract exactly:
 *
 *     in   {}
 *     out  { cash: MetricCell; revenue_30d: MetricCell;
 *            pending_settlement: MetricCell; runway: RunwayCell }
 *
 * and then says the sentence this whole module exists to honour: it "returns four
 * independent cells rather than a single aggregate, which is what lets one failing
 * metric surface a failure state while the other three render (Requirement 3.9)".
 *
 * ## What this module owns, and what it only calls
 *
 * | Concern | Where |
 * |---|---|
 * | the Zod schemas, the four computations, the catalogue entry | here |
 * | the metric formulas and their Evidence_Chain inputs | `./control-tower-metrics.ts` |
 * | the cell types, the states, the per-cell budget, the isolation combinator | `./control-tower-metrics-cells.ts` |
 * | composing, validating and persisting a chain | `@/evidence/chain-builder` (task 9.1) |
 * | every addition and subtraction | `@/calc/calculation-service` (task 2.1) |
 * | parse, authorize, bound, envelope check | `./tool.ts` (task 10.1) |
 *
 * **No money is computed in this file.** The three monetary formulas live in
 * `./control-tower-metrics.ts` and every operation there goes through the Calculation
 * Service, which range-checks each operand and each running total. Nothing here is a
 * `number` except the cell budget in milliseconds.
 *
 * ## The formulas are Requirement 3.1's, transcribed and not invented
 *
 * | Cell | Requirement 3.1's words | Implementation |
 * |---|---|---|
 * | `cash` | "Settlement received amounts minus the Tenant's recorded outflows as of the current date" | {@link calculateCash} |
 * | `revenue_30d` | "captured Payment amounts minus Refund amounts over the 30 calendar days ending on the current date" | {@link calculateRevenue30d} |
 * | `pending_settlement` | "the captured Payment amounts not yet linked to a Settlement" | {@link calculatePendingSettlement} |
 * | `runway` | "and the Runway metric" — **defined nowhere in Requirement 3** | see below |
 *
 * "the current date" and "the 30 calendar days ending on the current date" are Indian
 * calendar dates (Requirement 15.4's IST presentation), so the as-of date and the
 * trailing window come from `istDateOf` / `trailing30DateRange` rather than from a UTC
 * date. The window is 30 **inclusive** dates: `2026-07-04..2026-08-02`, not 31.
 *
 * "not yet linked to a Settlement" is a **stored identifier link**, never an inferred
 * amount or date match (Requirement 4.1). The seam reports the unlinked captured
 * Payments; no adapter this interface admits may infer a link.
 *
 * ## Runway is not available in this slice, and says so
 *
 * Requirement 3.1 names the Runway metric and defines it nowhere; Requirement 8.10 and
 * 8.11 put its computation in the **Cash_Agent**, which design.md says "feeds the
 * Control_Tower Runway metric" and which task 34.4 lands in Slice 4. So this tool has
 * no producer for Runway, and the honest answers available in design.md's three-label
 * enum are all wrong:
 *
 * - `ready` with a number would be fabricated, and `ready` with `0n` would be worse —
 *   it reads as "you have no runway", which is a solvency claim.
 * - `failed` would put Requirement 3.9's retry control on a condition no retry can
 *   change.
 * - `processing` would claim a computation that was never started, and Requirement 3.8
 *   bounds that state at 30 s, after which the Control_Tower would show a failure.
 *
 * **Reported as a finding, resolved additively:** the cell answers
 * `{ state: 'unavailable', reason: 'not_yet_available' }`. Requirement 3.12 already
 * requires a *non-numeric Runway state identifying which condition applies*, so a
 * reason-bearing non-numeric state is the shape that requirement asks for; this slice
 * adds one more reason to the two Requirement 3.12 names, and task 34.4 returns the
 * other two plus `ready`. See `RUNWAY_UNAVAILABLE_REASONS` for the full set.
 *
 * ## The envelope, and the one case still refused
 *
 * `ToolResult`'s success variant carries **one** `EvidenceChain` (task 10.1, finding
 * 1) and this tool produces **one chain per ready cell**. Resolved additively, without
 * widening `ToolResult` and disturbing the other tools:
 *
 * > Each ready cell carries its own `evidence_chain_id` and its chain's `as_of`, which
 * > is the real contract — design.md declares `evidence_chain_id` per cell. The
 * > envelope is *nominated* from the first ready monetary cell in `cash`,
 * > `revenue_30d`, `pending_settlement` order, and nothing derives meaning from which
 * > one it was.
 *
 * That leaves one case with no legal answer: a result in which **no** cell produced a
 * chain — a Tenant with nothing ingested (Requirement 3.7), or all three monetary
 * reads failing. `evidence_chains.source_count >= 1` is a database CHECK, so a chain
 * citing no Source_Record cannot be stored, and `ToolResult` has no success variant
 * without a chain. The invocation is therefore refused with a thrown
 * {@link ControlTowerMetricsToolError}, which the invoker turns into `tool_failure`.
 * This is the **same cross-cutting gap** tasks 12.1, 12.2 and 12.4 reported, and it is
 * reported again here rather than patched, because the patch belongs in the envelope:
 * Requirement 3.7 wants a fresh Tenant to see an empty state with the interface
 * operable, and `tool_failure` is not that. Independence is unaffected — one, two or
 * three cells may fail, be unavailable or be incomplete while the rest render.
 *
 * ## Per-cell isolation
 *
 * Every cell reaches the output through `isolateMetricCell`, which never rejects and
 * never runs past its own budget, and the four run concurrently under `Promise.all`.
 * A store that throws, a chain the builder refuses, a paise range violation or a read
 * that hangs affects **one** cell. See `./control-tower-metrics-cells.ts` for why that
 * is a combinator rather than four `try`/`catch` blocks, and for why the per-cell
 * budget is strictly below Requirement 12.11's 10 s tool bound.
 *
 * ## Read-only, and no live adapter
 *
 * `ctx.db` is **not read**. Every Razorpay table is RLS-`FORCE`d with no policies until
 * task 26.1, so a live PostgREST adapter written today would answer "no records" for
 * every Tenant — an ungrounded empty state rather than a figure. The three metric
 * seams and the chain store are injected as **factories over the `ToolContext`**,
 * exactly as tasks 12.1, 12.2 and 12.4 inject theirs, so 26.x supplies `ctx.db`-backed
 * adapters with no change to this file.
 *
 * `tenant_id` reaches every seam from `ctx.tenant_id` — the session — and is not an
 * argument at any depth (Requirement 12.7). The input is `z.strictObject({})`, so a
 * caller that sends `tenant_id`, or anything else at all, gets `schema_violation`
 * naming the argument with no connection opened and nothing read.
 *
 * ## Scope — deliberately left elsewhere
 *
 * - **Task 14.1 / 14.5** own the Control_Tower itself: the `processing` state while an
 *   invocation is in flight (Requirement 3.8), Indian_Number_Format and the
 *   Lakh/Crore suffixes (Requirement 3.2, 3.3, 3.11), the IST ingestion timestamp
 *   (Requirement 3.10) and the per-metric retry control (Requirement 3.9). This module
 *   builds no component and formats nothing.
 * - **Task 34.4** owns Runway.
 * - **Task 12.7** runs the contract harness over the Slice 1 catalogue.
 *   {@link catalogueEntryFor} is the one-line registration `./catalogue.ts` — 12.7's
 *   module, not this one — makes. 12.7 taught the harness this tool's shape rather than
 *   the reverse: a fixture declares `incompleteEvidenceScope: 'per_figure'`, and the
 *   contract then requires the withheld **cell** to carry its unavailable types, no
 *   figure and no chain, while the other three cells stay grounded (finding 3 below).
 * - **Task 26.x** owns the RLS policies, the read-only role and the live adapters.
 *
 * ## Findings, reported rather than silently patched
 *
 * 1. **Requirement 3.9's 30 s cannot fit inside Requirement 12.11's 10 s.** The
 *    enforced per-metric bound is `METRIC_CELL_BUDGET_MS`; the 30 s figure is the
 *    Control_Tower's patience across a retry. See the cells module.
 * 2. **design.md's three-label cell state cannot express two conditions the
 *    requirements state outright** — Requirement 3.7's "no monetary metric values" for
 *    a Tenant with nothing ingested, and Requirement 3.12's reason-bearing non-numeric
 *    Runway state. Two labels are added, `unavailable` and `incomplete_evidence`, and
 *    the optional-field contract design.md wrote is preserved structurally: every
 *    field design.md names keeps its name, its type and its meaning, and a consumer
 *    reading `state`, `value_paise`, `failure_kind`, `last_ingested_at` and
 *    `evidence_chain_id` sees exactly what design.md promised. What changes is that the
 *    optionals became a discriminated union, so the combinations Requirement 12.2
 *    forbids — a figure with no chain, a `failed` cell carrying a stale figure — are
 *    unrepresentable rather than merely unwritten.
 * 3. **Requirement 12.3 is applied per cell, not per invocation.** A figure here is a
 *    cell, and an unreadable Payment in the revenue window says nothing about Cash.
 *    Argued in full in the cells module.
 * 4. **The envelope has no empty-success variant** (see above).
 */

import { z } from 'zod';

import {
  createEvidenceChainBuilder,
  type EvidenceChain,
  type EvidenceChainBuilder,
  type EvidenceChainStore,
  incompleteEvidence,
  type SourceRef,
} from '@/evidence/chain-builder';
import { SOURCE_RECORD_TYPES } from '@/ledger/posting-rules';

import {
  calculateCash,
  calculatePendingSettlement,
  calculateRevenue30d,
  type CalculatedMetric,
  type CashMetricSource,
  istDateOf,
  type PendingSettlementMetricSource,
  type Revenue30dMetricSource,
  trailing30DateRange,
} from './control-tower-metrics';
import {
  failedMetricCell,
  type GroundedCell,
  isolateMetricCell,
  METRIC_CELL_BUDGET_MS,
  type MetricCell,
  type MetricCellComputation,
  type MetricFailureKind,
  RUNWAY_NOT_YET_AVAILABLE,
  type RunwayCell,
} from './control-tower-metrics-cells';
import { catalogued } from './registry';
import {
  type ErasedFinancialTool,
  type FinancialTool,
  TOOL_TIMEOUT_MS,
  type ToolContext,
  type ToolResult,
} from './tool';

export const GET_CONTROL_TOWER_METRICS = 'get_control_tower_metrics';

/* -------------------------------------------------------------------------- */
/* Input: design.md's `{}`                                                    */
/* -------------------------------------------------------------------------- */

/**
 * No arguments. The Control_Tower asks for *its* Tenant's metrics as of now, and both
 * of those come from the session and the clock rather than from a caller.
 *
 * Spelled `Record<never, never>` rather than `z.infer<typeof inputSchema>`, which is
 * the pattern every other tool uses, and the reason is a real interaction rather than
 * a style choice: Zod infers an **empty** strict object as `Record<string, never>`,
 * whose `keyof` is `string`, so `'tenant_id' extends keyof In` is *true* and
 * `NoTenantId<In>` in `./tool.ts` collapses to `TenantIdIsNotAnArgument` — the guard
 * for a tool that declares a `tenant_id` argument fires on the tool that declares no
 * arguments at all. `keyof Record<never, never>` is `never`, so the guard reads this
 * input correctly: it declares no `tenant_id`, because it declares nothing.
 *
 * The runtime half is unchanged and is what actually refuses a smuggled Tenant:
 * `inputSchema` is strict, so `{ tenant_id: '…' }` is `schema_violation` naming
 * `tenant_id`, rejected rather than stripped.
 */
export type GetControlTowerMetricsInput = Record<never, never>;

const inputSchema: z.ZodType<GetControlTowerMetricsInput> = z.strictObject({});

/* -------------------------------------------------------------------------- */
/* Output: four cells                                                         */
/* -------------------------------------------------------------------------- */

const unavailableCountSchema = z.strictObject({
  type: z.enum(SOURCE_RECORD_TYPES),
  count: z.number().int().positive(),
});

const readyMetricSchema = z.strictObject({
  state: z.literal('ready'),
  value_paise: z.bigint(),
  /** Requirement 12.2: a figure and its chain, or neither. */
  evidence_chain_id: z.uuid(),
  evidence_as_of: z.iso.datetime(),
  last_ingested_at: z.iso.datetime().optional(),
});

/** Requirement 3.8's state. Never returned here; see the cells module. */
const processingMetricSchema = z.strictObject({
  state: z.literal('processing'),
  last_ingested_at: z.iso.datetime().optional(),
});

/** Requirement 3.9's state. No figure, and the cause is always stated. */
const failedMetricSchema = z.strictObject({
  state: z.literal('failed'),
  failure_kind: z.enum(['error', 'timeout']),
});

/** Requirement 3.7: nothing to compute, and nothing failed. */
const unavailableMetricSchema = z.strictObject({
  state: z.literal('unavailable'),
  reason: z.literal('no_contributing_source_records'),
  last_ingested_at: z.iso.datetime().optional(),
});

/** Requirement 12.3, per cell. `.readonly()` so the cell types need no copy. */
const incompleteMetricSchema = z.strictObject({
  state: z.literal('incomplete_evidence'),
  unavailable: z.array(unavailableCountSchema).min(1).readonly(),
});

export const metricCellSchema = z.discriminatedUnion('state', [
  readyMetricSchema,
  processingMetricSchema,
  failedMetricSchema,
  unavailableMetricSchema,
  incompleteMetricSchema,
]);

const readyRunwaySchema = z.strictObject({
  state: z.literal('ready'),
  /** Months to 1 decimal place (Requirement 3.4), 0.0..120.0. Not money. */
  runway_months: z.number().min(0).max(120).multipleOf(0.1),
  runway_basis: z.literal('computed'),
  evidence_chain_id: z.uuid(),
  evidence_as_of: z.iso.datetime(),
  last_ingested_at: z.iso.datetime().optional(),
});

/** Requirement 3.12's non-numeric state, plus this slice's not-yet-available answer. */
const unavailableRunwaySchema = z.strictObject({
  state: z.literal('unavailable'),
  reason: z.enum([
    'not_yet_available',
    'not_applicable_non_positive_burn',
    'exceeds_maximum_months',
  ]),
  last_ingested_at: z.iso.datetime().optional(),
});

export const runwayCellSchema = z.discriminatedUnion('state', [
  readyRunwaySchema,
  processingMetricSchema,
  failedMetricSchema,
  unavailableRunwaySchema,
]);

const outputSchema = z.strictObject({
  cash: metricCellSchema,
  revenue_30d: metricCellSchema,
  pending_settlement: metricCellSchema,
  runway: runwayCellSchema,
});

export type GetControlTowerMetricsOutput = z.infer<typeof outputSchema>;

/* -------------------------------------------------------------------------- */
/* Dependencies                                                               */
/* -------------------------------------------------------------------------- */

export interface GetControlTowerMetricsDeps {
  /** Factories keep each metric on an independent read seam bound to the session. */
  readonly cash: (ctx: ToolContext) => CashMetricSource;
  readonly revenue30d: (ctx: ToolContext) => Revenue30dMetricSource;
  readonly pendingSettlement: (ctx: ToolContext) => PendingSettlementMetricSource;
  readonly chains: (ctx: ToolContext) => EvidenceChainStore;
  /** Injectable clock, so the IST as-of date and the trailing window are assertable. */
  readonly now?: () => Date;
  /** Test seam. Defaults to the bound strictly below the 10-second tool limit. */
  readonly cellBudgetMs?: number;
}

/** Thrown for an invocation no `ToolResult` variant can carry. See finding 4. */
export class ControlTowerMetricsToolError extends Error {
  override readonly name = 'ControlTowerMetricsToolError';
}

/* -------------------------------------------------------------------------- */
/* Cell construction                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Requirement 3.9's cell for a monetary metric.
 *
 * Two concrete builders rather than one generic one: a generic
 * `<C extends MetricCell | RunwayCell>` would have to assert its way from
 * `FailedMetricCell` to `C`, and inference across four call sites would then widen
 * every cell to `MetricCell | RunwayCell`, letting a Runway cell hold a monetary
 * figure as far as the compiler was concerned. `FailedMetricCell` is a member of both
 * unions, so two one-line functions need no assertion at all.
 */
function failedMonetaryCell(failureKind: MetricFailureKind): GroundedCell<MetricCell> {
  return { cell: failedMetricCell(failureKind), evidence: null };
}

/** Requirement 3.9's cell for Runway. See {@link failedMonetaryCell}. */
function failedRunwayCell(failureKind: MetricFailureKind): GroundedCell<RunwayCell> {
  return { cell: failedMetricCell(failureKind), evidence: null };
}

/**
 * Requirement 12.3 for one cell: the figure is omitted and the unavailable types are
 * counted by `incompleteEvidence`, so the type counts have one implementation.
 */
function incompleteCell(unreadable: readonly SourceRef[]): GroundedCell<MetricCell> {
  const result = incompleteEvidence(unreadable);
  return {
    cell: { state: 'incomplete_evidence', unavailable: result.unavailable },
    evidence: null,
  };
}

/**
 * Persist one metric's chain and return its cell.
 *
 * `null` means the metric's scope cites no Source_Record: Requirement 3.7's condition,
 * answered as `unavailable` rather than as a `ready` `0n`, which would be a figure with
 * no storable chain (`evidence_chains.source_count >= 1`).
 */
async function persistMetric(
  calculated: CalculatedMetric | null,
  builder: EvidenceChainBuilder,
  signal: AbortSignal,
): Promise<GroundedCell<MetricCell>> {
  if (calculated === null) {
    return {
      cell: { state: 'unavailable', reason: 'no_contributing_source_records' },
      evidence: null,
    };
  }
  if (signal.aborted) {
    // The cell's budget or the tool bound has elapsed. Stop before writing a chain
    // for a figure this invocation will not return.
    throw new ControlTowerMetricsToolError(
      'the metric was aborted before its Evidence_Chain was persisted',
    );
  }
  const built = await builder.build(calculated.evidence);
  if (!built.ok) {
    return {
      cell: { state: 'incomplete_evidence', unavailable: built.unavailable },
      evidence: null,
    };
  }
  return {
    cell: {
      state: 'ready',
      value_paise: calculated.value_paise,
      evidence_chain_id: built.evidence.evidence_chain_id,
      evidence_as_of: built.evidence.as_of,
      last_ingested_at: calculated.last_ingested_at,
    },
    evidence: built.evidence,
  };
}

/* -------------------------------------------------------------------------- */
/* The tool                                                                   */
/* -------------------------------------------------------------------------- */

export function createGetControlTowerMetrics(
  deps: GetControlTowerMetricsDeps,
): FinancialTool<GetControlTowerMetricsInput, GetControlTowerMetricsOutput> {
  return {
    name: GET_CONTROL_TOWER_METRICS,
    mode: 'read_only',
    inputSchema,
    outputSchema,
    timeoutMs: TOOL_TIMEOUT_MS,

    async execute(ctx: ToolContext): Promise<ToolResult<GetControlTowerMetricsOutput>> {
      const now = (deps.now ?? ((): Date => new Date()))();
      const asOf = istDateOf(now);
      const revenueRange = trailing30DateRange(now);
      const budget = deps.cellBudgetMs ?? METRIC_CELL_BUDGET_MS;
      const builder = createEvidenceChainBuilder({
        store: deps.chains(ctx),
        tenantId: ctx.tenant_id,
      });

      const cash: MetricCellComputation<MetricCell> = {
        metric: 'cash',
        async compute(signal): Promise<GroundedCell<MetricCell>> {
          const read = await deps.cash(ctx).read({ tenant_id: ctx.tenant_id, as_of: asOf }, signal);
          const unreadable = read.unreadable ?? [];
          if (unreadable.length > 0) return incompleteCell(unreadable);
          return persistMetric(calculateCash(GET_CONTROL_TOWER_METRICS, read), builder, signal);
        },
      };

      const revenue: MetricCellComputation<MetricCell> = {
        metric: 'revenue_30d',
        async compute(signal): Promise<GroundedCell<MetricCell>> {
          const read = await deps
            .revenue30d(ctx)
            .read({ tenant_id: ctx.tenant_id, range: revenueRange }, signal);
          const unreadable = read.unreadable ?? [];
          if (unreadable.length > 0) return incompleteCell(unreadable);
          return persistMetric(calculateRevenue30d(GET_CONTROL_TOWER_METRICS, read), builder, signal);
        },
      };

      const pending: MetricCellComputation<MetricCell> = {
        metric: 'pending_settlement',
        async compute(signal): Promise<GroundedCell<MetricCell>> {
          const read = await deps
            .pendingSettlement(ctx)
            .read({ tenant_id: ctx.tenant_id, as_of: asOf }, signal);
          const unreadable = read.unreadable ?? [];
          if (unreadable.length > 0) return incompleteCell(unreadable);
          return persistMetric(
            calculatePendingSettlement(GET_CONTROL_TOWER_METRICS, read),
            builder,
            signal,
          );
        },
      };

      /** Task 34.4's cell. Not a failure, not a computation in progress. */
      const runway: MetricCellComputation<RunwayCell> = {
        metric: 'runway',
        compute(): Promise<GroundedCell<RunwayCell>> {
          return Promise.resolve({ cell: RUNWAY_NOT_YET_AVAILABLE, evidence: null });
        },
      };

      // Concurrent, and every outcome is a value: `isolateMetricCell` never rejects,
      // so one metric's fault cannot abandon the other three (Requirement 3.9).
      const [cashResult, revenueResult, pendingResult, runwayResult] = await Promise.all([
        isolateMetricCell(cash, ctx.signal, budget, failedMonetaryCell),
        isolateMetricCell(revenue, ctx.signal, budget, failedMonetaryCell),
        isolateMetricCell(pending, ctx.signal, budget, failedMonetaryCell),
        isolateMetricCell(runway, ctx.signal, budget, failedRunwayCell),
      ]);

      const envelope = [cashResult.evidence, revenueResult.evidence, pendingResult.evidence].find(
        (evidence): evidence is EvidenceChain => evidence !== null,
      );
      if (envelope === undefined) {
        // Finding 4. Every cell is a legitimate non-figure state, but `ToolResult`
        // has no success variant without a chain and a chain citing no
        // Source_Record cannot be stored.
        throw new ControlTowerMetricsToolError(
          `no ${GET_CONTROL_TOWER_METRICS} cell produced an Evidence_Chain, so the shared ` +
            `ToolResult envelope has no chain to carry; the four per-cell outcomes are ` +
            `independent and complete, but the envelope has no empty-success variant ` +
            `(Requirement 3.7 wants this answered as an empty state, not as a failure)`,
        );
      }

      return {
        ok: true,
        value: {
          cash: cashResult.cell,
          revenue_30d: revenueResult.cell,
          pending_settlement: pendingResult.cell,
          runway: runwayResult.cell,
        },
        // The real grounding is per cell. This slot is design.md's single envelope,
        // nominated from the first ready monetary cell and carrying no extra meaning.
        evidence: envelope,
      };
    },
  };
}

/** What `./catalogue.ts` registers the tool with (task 12.7). */
export function catalogueEntryFor(deps: GetControlTowerMetricsDeps): ErasedFinancialTool {
  return catalogued(createGetControlTowerMetrics(deps));
}
