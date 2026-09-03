/**
 * The Control_Tower metric cell, and the isolation that makes four cells
 * independent (task 12.6). Requirements 3.1, 3.7–3.10, 3.12, 12.2, 12.3, 12.11.
 *
 * `get_control_tower_metrics` is the only tool in the catalogue whose answer is
 * **four answers**. design.md says why in one sentence — "returns four independent
 * cells rather than a single aggregate, which is what lets one failing metric
 * surface a failure state while the other three render (Requirement 3.9)" — and this
 * module is where that independence is made structural rather than promised.
 *
 * ## Independence is a combinator, not a `try`/`catch` per cell
 *
 * {@link isolateMetricCell} is the **only** way a cell reaches the output, and it
 * cannot propagate anything:
 *
 * - It never rejects. Every throw from the computation — a store fault, a chain
 *   refusal, a paise-range violation, a synchronous throw before the promise is even
 *   created — is converted to `{ state: 'failed', failure_kind: 'error' }`.
 * - It never runs past its budget. A computation that has not answered within
 *   {@link METRIC_CELL_BUDGET_MS} yields `{ state: 'failed', failure_kind: 'timeout' }`,
 *   and the cell's `AbortSignal` is aborted so a signal-aware read stops.
 * - It knows nothing about the other three cells, and the assembly step that builds
 *   the result reads outcomes only — it has no reference to any computation.
 *
 * So a refactor cannot quietly collapse the isolation of one cell the way a hand-rolled
 * `try`/`catch` per cell could: removing the isolation means removing the combinator,
 * which is the only thing that produces a cell at all. This is the same move task 6.2
 * made for "zero objects stored" — stage the whole thing behind one funnel, so the
 * guarantee is a property of the shape rather than of four call sites agreeing.
 *
 * ## Requirement 12.3 and Requirement 3.9, reconciled rather than assumed
 *
 * Requirement 12.3: a Financial_Tool that cannot read every contributing Source_Record
 * returns an incomplete-evidence result **in place of the figure**, omits the figure,
 * and identifies each unavailable Source_Record type with its count.
 * Requirement 3.9: one metric failing must not stop the other three rendering.
 *
 * Every other tool in this codebase applies 12.3 to the **whole invocation**, because
 * every other tool returns *one* figure composed from every record it read — so one
 * unreadable record leaves nothing to report. This tool returns four figures composed
 * from four disjoint reads, and that is the difference that decides it:
 *
 * > **12.3 applies per figure, and here a figure is a cell.** An unreadable Payment in
 * > the revenue window makes the *revenue* figure uncomposable; it says nothing about
 * > the Cash figure, which was composed from Settlements and Ledger_Entry_Sets that
 * > were all read. So the incomplete-evidence result is the **cell's**, with the
 * > figure omitted from that cell and the unavailable type counts stated on it, and
 * > the other three cells are unaffected.
 *
 * That reading is not free — it is argued, not assumed. Two things make it the
 * defensible one. First, 12.3's own words are "in place of the figure", and each cell
 * is a figure: applying it to the invocation would withhold three figures that *are*
 * fully grounded, which 12.3 never asks for and 3.9 forbids outright. Second, the
 * **shape** is preserved exactly — {@link IncompleteMetricCell} has no `value_paise`
 * field at all and carries `UnavailableSourceCount[]` verbatim, so nothing is weakened
 * about what 12.3 requires; only the scope it is applied at changes, from the envelope
 * to the cell. The invocation-level `incomplete_evidence` variant of `ToolResult` is
 * therefore never returned by this tool, and the reason is stated here rather than
 * being visible only as its absence.
 *
 * ## Why the state enum has five labels and design.md writes three
 *
 * design.md's cell is `{ state: 'ready'|'processing'|'failed'; value_paise?; failure_kind?;
 * last_ingested_at?; evidence_chain_id? }`. Three labels cannot honestly carry two
 * conditions the requirements state outright, so two are added and each is traceable
 * to the requirement that forces it (reported as a finding, see the tool module):
 *
 * | Label | Required by | Meaning |
 * |---|---|---|
 * | `ready` | Requirement 3.1 | a figure, with the chain that grounds it |
 * | `processing` | Requirement 3.8 | computation started, not yet complete |
 * | `failed` | Requirement 3.9 | computation error, or the per-metric bound elapsed |
 * | `unavailable` | Requirement 3.7, 3.12 | there is no figure to compute, and nothing failed |
 * | `incomplete_evidence` | Requirement 12.3 | contributing records could not be read |
 *
 * `unavailable` is the label that does the work design.md's enum has no room for.
 * Requirement 3.7 wants no monetary value displayed while a Tenant has zero ingested
 * objects — and a scope citing no Source_Record has no storable chain at all, because
 * `evidence_chains.source_count >= 1` is a database CHECK, so `0n` there would be an
 * **ungrounded** figure rather than a small one. Requirement 3.12 wants a non-numeric
 * Runway state naming which of two conditions applies. Neither is a failure and
 * neither is "still computing"; calling either `failed` would put a retry control
 * (Requirement 3.9) on a condition retrying cannot change.
 *
 * **This tool never returns `processing`.** It is synchronous: by the time it answers,
 * every cell has either a figure or a reason it has none, and a cell that did not
 * finish inside its budget is `failed` with `failure_kind: 'timeout'`, which is what
 * Requirement 3.9 asks for. The label is kept because design.md declares it and
 * Requirement 3.8 needs the vocabulary: the Control_Tower (task 14.1) renders
 * `processing` while this tool's invocation is in flight, and task 14.5's per-metric
 * retry is what re-invokes it. Nothing here fabricates that state.
 *
 * ## The per-metric bound, against the 10-second tool bound
 *
 * See {@link METRIC_CELL_BUDGET_MS}. In short: Requirement 3.9's 30 s is unreachable
 * inside Requirement 12.11's 10 s, the four cells run concurrently rather than in
 * sequence, and the per-cell budget is strictly below the tool bound so that a slow
 * cell fails *as a cell* instead of taking the invocation — and the other three
 * cells — down with it.
 */

import type { Paise } from '@/calc/paise';
import type { EvidenceChain, UnavailableSourceCount } from '@/evidence/chain-builder';

import { TOOL_TIMEOUT_MS } from './tool';

/* -------------------------------------------------------------------------- */
/* Names and enums                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The four cells design.md's output declares, in the order the Control_Tower's metric
 * strip renders them (design.md, "Metric strip").
 */
export const METRIC_NAMES = ['cash', 'revenue_30d', 'pending_settlement', 'runway'] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

/** design.md's `failure_kind`: Requirement 3.9's two causes, and only those two. */
export const METRIC_FAILURE_KINDS = ['error', 'timeout'] as const;

export type MetricFailureKind = (typeof METRIC_FAILURE_KINDS)[number];

/** Every cell state. See the module doc comment for why there are five. */
export const METRIC_STATES = [
  'ready',
  'processing',
  'failed',
  'unavailable',
  'incomplete_evidence',
] as const;

export type MetricState = (typeof METRIC_STATES)[number];

/**
 * Why a monetary metric has no figure to compute, where nothing failed.
 *
 * One reason today. `no_contributing_source_records` covers both halves of
 * Requirement 3.7's condition — a Tenant with zero ingested objects, and a Tenant
 * whose scope for *this* metric contains none — and the two are told apart by
 * `last_ingested_at`: absent means nothing has ever been ingested, present means
 * ingestion has run and this window is empty.
 *
 * It is deliberately **not** a `ready` cell carrying `0n`. A chain needs at least one
 * citation (`evidence_chains.source_count >= 1`), so `0n` with no contributing record
 * is a figure with no Evidence_Chain, which is the one thing the Financial_Tool_Layer
 * exists to prevent (Requirement 12.2).
 */
export const METRIC_UNAVAILABLE_REASONS = ['no_contributing_source_records'] as const;

export type MetricUnavailableReason = (typeof METRIC_UNAVAILABLE_REASONS)[number];

/**
 * Why Runway has no number.
 *
 * - `not_yet_available` — **this slice's answer**. Runway comes from the Cash_Agent
 *   (design.md: "feeds the Control_Tower Runway metric"), which lands in Slice 4 and
 *   is wired by task 34.4. Not a failure and not a computation in progress: the
 *   producer does not exist yet, and no state in design.md's three-label enum says
 *   that. Returning `failed` would put a retry control on a condition no retry can
 *   change, and returning `processing` would claim a computation that was never
 *   started.
 * - `not_applicable_non_positive_burn` — Requirement 8.11 and 3.12: average net
 *   monthly outflow at or below zero, so there is no runway to divide out. The label
 *   matches `cash_forecasts.runway_basis`'s CHECK value exactly, so the tool and the
 *   column say the same word.
 * - `exceeds_maximum_months` — Requirement 3.12's other branch: above
 *   {@link MAX_RUNWAY_MONTHS}, a non-numeric state and **no number**.
 *
 * The last two are task 34.4's to return; this slice returns only the first.
 */
export const RUNWAY_UNAVAILABLE_REASONS = [
  'not_yet_available',
  'not_applicable_non_positive_burn',
  'exceeds_maximum_months',
] as const;

export type RunwayUnavailableReason = (typeof RUNWAY_UNAVAILABLE_REASONS)[number];

/** Requirement 3.4 and 3.12's ceiling: above this, Runway is a non-numeric state. */
export const MAX_RUNWAY_MONTHS = 120;

/* -------------------------------------------------------------------------- */
/* The monetary cell                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A metric with a figure.
 *
 * `value_paise` and `evidence_chain_id` are **both required here**, which is the
 * type-level form of Requirement 12.2: a figure with no chain is not merely
 * discouraged, it is unrepresentable. design.md writes both optional because it
 * writes one shape for three states; a discriminated union says the same thing
 * without admitting the three combinations 12.2 forbids (a figure with no chain, a
 * chain with no figure, a failed cell carrying a stale figure).
 *
 * `evidence_as_of` is the chain's as-of, carried beside the identifier for the same
 * reason task 12.1 carries it per row: Requirement 12.4 has the Agent present a
 * figure with its chain's as-of timestamp and re-invoke where it is more than 15
 * minutes stale, and the Control_Tower cannot apply that rule from an identifier
 * alone.
 *
 * `last_ingested_at` is Requirement 3.10's, and it is a **different fact** from
 * `evidence_as_of`: the as-of is the newest contributing record's update timestamp,
 * this is the completion timestamp of the most recent ingestion run that stored a
 * record of a type this figure cites. Optional because a Tenant can hold contributing
 * records with no completed run behind them (a backfilled or ledger-only
 * contribution); the Control_Tower renders it in IST to whole-second precision.
 */
export interface ReadyMetricCell {
  readonly state: 'ready';
  readonly value_paise: Paise;
  /** Requirement 12.2. Never absent on a `ready` cell. */
  readonly evidence_chain_id: string;
  /** ISO-8601 UTC, ms precision. The chain's `as_of`. */
  readonly evidence_as_of: string;
  /** ISO-8601 UTC. Requirement 3.10. */
  readonly last_ingested_at?: string;
}

/**
 * Requirement 3.8's state. **Never returned by `get_control_tower_metrics`** — see the
 * module doc comment. Declared because design.md declares it and the Control_Tower
 * renders it.
 *
 * No `value_paise`: a metric that has not finished computing has no figure, and a
 * partial or previous one shown as current is indistinguishable to a User from a
 * current one.
 */
export interface ProcessingMetricCell {
  readonly state: 'processing';
  readonly last_ingested_at?: string;
}

/**
 * Requirement 3.9's state: a computation error, or the per-metric bound elapsed.
 *
 * `failure_kind` is required, because Requirement 3.9 asks the Control_Tower to
 * distinguish the two causes, and it carries **no figure and no chain**: a failed
 * cell must not hand back a stale value that would render as current.
 */
export interface FailedMetricCell {
  readonly state: 'failed';
  readonly failure_kind: MetricFailureKind;
}

/** There is no figure to compute, and nothing failed. See {@link METRIC_UNAVAILABLE_REASONS}. */
export interface UnavailableMetricCell {
  readonly state: 'unavailable';
  readonly reason: MetricUnavailableReason;
  readonly last_ingested_at?: string;
}

/**
 * Requirement 12.3, applied to one cell: contributing Source_Records could not be
 * read, so **this** figure is withheld.
 *
 * `unavailable` is the same `UnavailableSourceCount[]` the invocation-level
 * `incomplete_evidence` result carries, produced by the same `incompleteEvidence`
 * function in `@/evidence/chain-builder`, so the type counts are computed in exactly
 * one place. There is no `value_paise` field: the figure is omitted structurally, not
 * set to `0` or `null`.
 */
export interface IncompleteMetricCell {
  readonly state: 'incomplete_evidence';
  /** One entry per type, in `source_record_type` enum order. Never empty. */
  readonly unavailable: readonly UnavailableSourceCount[];
}

/** design.md's `MetricCell`, as a discriminated union on `state`. */
export type MetricCell =
  | ReadyMetricCell
  | ProcessingMetricCell
  | FailedMetricCell
  | UnavailableMetricCell
  | IncompleteMetricCell;

/* -------------------------------------------------------------------------- */
/* The Runway cell                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Runway with a number.
 *
 * **`RunwayCell` is a distinct type from `MetricCell` in design.md's signature and is
 * never declared there.** This is why it has to be: Runway is **not money**. It is a
 * duration in months, `cash_forecasts.runway_months NUMERIC(4,1)`, described in
 * design.md as "a presentation value" and expressed to 1 decimal place
 * (Requirement 3.4). A `value_paise` field cannot hold it and a `Paise` cannot
 * represent it, so a Runway cell states `runway_months` instead. That is the whole
 * difference between the two types, and it is the reading that makes design.md's two
 * type names necessary rather than accidental.
 *
 * `runway_months` is therefore the one `number` in this module's output, and it is not
 * money: no monetary value passes through a float (Requirement 15.1). The division it
 * comes from — cash over average net monthly outflow (Requirement 8.10) — happens in
 * the Cash_Agent through the Calculation Service, and only the rounded presentation
 * value arrives here.
 *
 * The chain is still required: Runway is derived from monetary figures, so
 * Requirement 12.2's grounding applies to what it was derived from even though the
 * presented value is not itself paise.
 *
 * **Task 34.4 is the only thing that can return this variant.** This slice always
 * answers `{ state: 'unavailable', reason: 'not_yet_available' }`.
 */
export interface ReadyRunwayCell {
  readonly state: 'ready';
  /** Months, 0.0..{@link MAX_RUNWAY_MONTHS}, 1 decimal place. Not money. */
  readonly runway_months: number;
  /** `cash_forecasts.runway_basis`. `computed` is the only basis with a number. */
  readonly runway_basis: 'computed';
  readonly evidence_chain_id: string;
  readonly evidence_as_of: string;
  readonly last_ingested_at?: string;
}

/** Requirement 3.12's non-numeric state, and this slice's not-yet-available answer. */
export interface UnavailableRunwayCell {
  readonly state: 'unavailable';
  readonly reason: RunwayUnavailableReason;
  readonly last_ingested_at?: string;
}

/**
 * design.md's `RunwayCell`. Shares `processing` and `failed` with {@link MetricCell},
 * because a Runway computation can be in flight or fail exactly as a monetary one can,
 * and differs in its `ready` and `unavailable` variants.
 *
 * No `incomplete_evidence` variant: Runway is not read from Source_Records by this
 * tool at all. Task 34.4 adds one if the Cash_Agent's read can be partial.
 */
export type RunwayCell =
  | ReadyRunwayCell
  | ProcessingMetricCell
  | FailedMetricCell
  | UnavailableRunwayCell;

/* -------------------------------------------------------------------------- */
/* Constructors                                                               */
/* -------------------------------------------------------------------------- */

/** Requirement 3.9's cell. Carries a cause, never a figure. */
export function failedMetricCell(failureKind: MetricFailureKind): FailedMetricCell {
  return { state: 'failed', failure_kind: failureKind };
}

/** This slice's Runway answer: honest, and not a failure of the system. */
export const RUNWAY_NOT_YET_AVAILABLE: UnavailableRunwayCell = {
  state: 'unavailable',
  reason: 'not_yet_available',
};

/* -------------------------------------------------------------------------- */
/* The per-metric bound                                                       */
/* -------------------------------------------------------------------------- */

/**
 * How long one cell may take.
 *
 * Three constraints decide this number, and they conflict:
 *
 * 1. **Requirement 12.11 bounds the whole invocation at 10 s** and
 *    `TOOL_TIMEOUT_MS` is a literal a tool cannot override. When it elapses the
 *    invoker aborts `ctx.signal`, rolls the connection back and returns
 *    `tool_failure` — **discarding the result**, and with it all four cells.
 * 2. **Requirement 3.9 bounds a metric at 30 s**, and design.md's error-handling table
 *    puts that timer inside this tool ("Per-metric timer and error boundary in
 *    `get_control_tower_metrics`"). 30 s is unreachable inside a 10 s invocation.
 *    Reported as a finding; the 30 s figure is honoured where it can be — as the
 *    Control_Tower's own patience across a retry (task 14.5) — and the tool's
 *    per-metric bound is this constant.
 * 3. **Requirement 3.1 wants the dashboard within 3 s.** So the budget is a ceiling
 *    for a pathological read, not a target.
 *
 * Hence: **strictly below the tool bound, with a margin.** If a cell's budget equalled
 * `TOOL_TIMEOUT_MS`, a single slow cell would trip the invoker's deadline first and
 * take the three healthy cells down with it — precisely the outcome Requirement 3.9
 * forbids. The margin is what the tool spends assembling and returning the four cells
 * after the slowest one has given up.
 *
 * The four cells run **concurrently**, so the invocation's wall clock is about the
 * slowest cell rather than the sum of four. A sequential design would need a budget of
 * `TOOL_TIMEOUT_MS / 4` and would report a timeout for cells that were never given a
 * chance to run.
 *
 * Each cell's `AbortSignal` is also linked to `ctx.signal`, so if the invoker's
 * deadline does fire first every cell stops immediately rather than continuing to
 * write Evidence_Chains for a result that will be discarded.
 */
export const METRIC_CELL_MARGIN_MS = 2_000;

/** See {@link METRIC_CELL_MARGIN_MS}. Strictly below {@link TOOL_TIMEOUT_MS}. */
export const METRIC_CELL_BUDGET_MS = TOOL_TIMEOUT_MS - METRIC_CELL_MARGIN_MS;

/** Requirement 3.9's stated bound. Recorded because it is not the enforced one. */
export const REQUIREMENT_3_9_METRIC_BOUND_MS = 30_000;

/** Thrown for a budget that is not a bound this tool can honour. */
export class MetricCellError extends Error {
  override readonly name = 'MetricCellError';
}

/**
 * A per-cell budget must be a whole number of milliseconds in `1..METRIC_CELL_BUDGET_MS`.
 *
 * The upper bound is not negotiable by a caller: a budget at or above
 * `TOOL_TIMEOUT_MS` would let one cell take the invocation down, which is the failure
 * this whole module exists to prevent.
 */
export function assertCellBudgetMs(budgetMs: number): number {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > METRIC_CELL_BUDGET_MS) {
    throw new MetricCellError(
      `a per-metric budget is 1..${METRIC_CELL_BUDGET_MS} ms — strictly below the ` +
        `${TOOL_TIMEOUT_MS} ms tool bound, so a slow cell fails as a cell rather than ` +
        `taking the invocation and the other three cells with it — got ${String(budgetMs)}`,
    );
  }
  return budgetMs;
}

/* -------------------------------------------------------------------------- */
/* The isolation combinator                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A cell, with the Evidence_Chain behind it where it has one.
 *
 * The chain travels beside the cell rather than inside it because design.md's
 * envelope carries **one** `EvidenceChain` for the whole result (task 10.1, finding 1)
 * and the tool has to nominate one of the per-cell chains for it. The cell itself
 * carries only the identifier and the as-of, which is what a caller needs.
 */
export interface GroundedCell<C> {
  readonly cell: C;
  /** `null` for every state but `ready`. */
  readonly evidence: EvidenceChain | null;
}

/**
 * One cell's computation. It may do anything: read, compute, persist a chain, throw.
 *
 * `signal` is aborted when the cell's budget elapses **or** when the invocation's
 * `ctx.signal` aborts, whichever is first. A computation that issues writes must check
 * it before each one, exactly as tasks 12.1 and 12.2 do.
 */
export interface MetricCellComputation<C> {
  readonly metric: MetricName;
  compute(signal: AbortSignal): Promise<GroundedCell<C>>;
}

/**
 * Run one cell's computation in isolation, under its own budget.
 *
 * **Never rejects, never returns `undefined`, and never observes another cell.** That
 * is the whole contract, and it is what makes `Promise.all` over four of these safe:
 * a rejection would abandon the other three results.
 *
 * @param onFailure builds the cell for a failure of the stated kind. Takes the kind
 * rather than being a constant so `error` and `timeout` stay distinguishable
 * (Requirement 3.9), and is supplied by the caller so a Runway failure and a monetary
 * failure are the same shape without this module importing either.
 */
export async function isolateMetricCell<C>(
  computation: MetricCellComputation<C>,
  outerSignal: AbortSignal,
  budgetMs: number,
  onFailure: (failureKind: MetricFailureKind) => GroundedCell<C>,
): Promise<GroundedCell<C>> {
  assertCellBudgetMs(budgetMs);

  // The invocation is already over: the invoker has aborted and its result will be
  // discarded. Report a timeout rather than starting a read nothing will read.
  if (outerSignal.aborted) {
    return onFailure('timeout');
  }

  const controller = new AbortController();
  const abortCell = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(
        new MetricCellError(
          `the ${computation.metric} metric exceeded its ${budgetMs} ms budget, or the ` +
            `invocation was aborted`,
        ),
      );
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onOuterAbort: (() => void) | undefined;

  const deadline = new Promise<{ readonly kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => {
      abortCell();
      resolve({ kind: 'timeout' });
    }, budgetMs);
    onOuterAbort = (): void => {
      // The tool bound elapsed. For this cell the outcome is the same as its own
      // budget elapsing: no figure, and the cause is a timeout rather than an error.
      abortCell();
      resolve({ kind: 'timeout' });
    };
    outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  });

  // `Promise.resolve().then` rather than a bare call, so a computation that throws
  // **synchronously** — before it ever returns a promise — is caught too. A bare call
  // would let that throw escape and take the other three cells with it.
  const running: Promise<
    { readonly kind: 'cell'; readonly grounded: GroundedCell<C> } | { readonly kind: 'threw' }
  > = Promise.resolve()
    .then(() => computation.compute(controller.signal))
    .then((grounded) => ({ kind: 'cell' as const, grounded }))
    // The rejection reason is deliberately dropped rather than surfaced in the cell:
    // Requirement 3.9 asks for the metric name and the cause class, and a raw error
    // message can carry Tenant data or a provider string into a dashboard.
    .catch(() => ({ kind: 'threw' as const }));

  try {
    const outcome = await Promise.race([running, deadline]);
    if (outcome.kind === 'cell') {
      return outcome.grounded;
    }
    return onFailure(outcome.kind === 'timeout' ? 'timeout' : 'error');
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (onOuterAbort !== undefined) {
      outerSignal.removeEventListener('abort', onOuterAbort);
    }
    // The cell is done either way. Abort so an abandoned read stops rather than
    // running on behind a result nobody will look at.
    abortCell();
  }
}
