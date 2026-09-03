/**
 * One metric cell's async state, as a pure reducer (task 14.1).
 * Requirements 3.8, 3.9; the UI half of Requirement 3.1.
 *
 * ## Where the `processing` state comes from
 *
 * `get_control_tower_metrics` **never returns `processing`**. Its own doc comment says
 * why: it is synchronous, so by the time it answers, every cell has either a figure or
 * a reason it has none, and a cell that ran past its budget is `failed` with
 * `failure_kind: 'timeout'`. The label is declared in the tool's schema for one reason —
 * "the Control_Tower (task 14.1) renders `processing` while this tool's invocation is in
 * flight".
 *
 * **This module is that.** {@link initialMetricCellState} starts a cell at
 * `{ state: 'processing' }` and it stays there until the load settles, which is exactly
 * Requirement 3.8's condition: computation started, not yet complete. Nothing here
 * fabricates a `processing` cell from a tool response; the tool's `processing` variant is
 * never constructed from data, only from the absence of data.
 *
 * ## Independence is one reducer per cell, never one reducer for four
 *
 * The state is `{ cell, attempt }` for **one** metric. There is no combined state, no
 * shared in-flight flag and no shared error. Four cells means four independent
 * instances, so a load that hangs or rejects moves exactly one `cell` and leaves the
 * other three untouched (Requirement 3.9, and the UI half of design.md's "one failing
 * metric does not block the other three").
 *
 * `attempt` is what a retry increments, and it is the effect key: bumping it puts the
 * cell back to `processing` and re-runs that cell's load. It is per cell for the same
 * reason the rest of the state is.
 *
 * ## The per-attempt 30-second bound
 *
 * {@link loadMetricWithDeadline} wraps every invocation of one cell's loader. It owns
 * its own timer and child `AbortController`, so a timeout aborts only that metric and
 * rejects with {@link MetricLoadTimeoutError}; {@link classifyLoadFailure} then produces
 * the distinct `timeout` state Requirement 3.9 requires. A retry increments this cell's
 * `attempt`, creates a fresh effect and therefore gets a fresh 30-second window. There is
 * no retry limit or backoff in Requirement 3.9.
 *
 * The tool also has a shorter per-cell budget because its whole invocation is bounded to
 * 10 seconds. This UI deadline is still required: it bounds any loader/transport path and
 * is the stated Control_Tower patience. A tool-returned failed cell settles normally and
 * is not rewritten; successful figures and their Evidence_Chain references pass through
 * unchanged.
 *
 * ## What this module does not decide
 *
 * **Task 15.1 owns the transport.** {@link MetricLoad} is a function from an
 * `AbortSignal` to a cell and nothing more, so nothing in the component tree constructs
 * a Supabase client or knows a route exists. `GET /control-tower/metrics` (task 15.1) is
 * a single request returning all four cells, and a loader set may perfectly well be four
 * closures over one shared in-flight request — the component tree cannot tell. Each cell
 * still owns its presentation state, deadline, and retry attempt; callers must keep the
 * four loader functions independently invokable so one retry does not reset another
 * metric.
 *
 * No React, no DOM, no module state.
 */

import {
  failedMetricCell,
  type FailedMetricCell,
  type MetricCell,
  type MetricFailureKind,
  type ProcessingMetricCell,
  REQUIREMENT_3_9_METRIC_BOUND_MS,
  type RunwayCell,
} from '@/tools/control-tower-metrics-cells';

/* -------------------------------------------------------------------------- */
/* The load seam                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Either cell union. Used only where a helper is genuinely indifferent between money
 * and months; the components stay concrete, so a Runway cell can never hold a monetary
 * figure as far as the compiler is concerned.
 */
export type AnyMetricCell = MetricCell | RunwayCell;

/**
 * How one metric's cell is obtained.
 *
 * Takes an `AbortSignal` so an unmounted or superseded load stops rather than running on
 * behind a cell nobody will look at, the same discipline `isolateMetricCell` applies on
 * the tool side.
 *
 * **Must be referentially stable** across renders of the same data source: it is an
 * effect dependency, so a fresh closure per render means a fresh load per render. Hoist
 * it to module scope, or wrap it in `useCallback`/`useMemo`.
 */
export type MetricLoad<C extends AnyMetricCell> = (signal: AbortSignal) => Promise<C>;

/**
 * The four independent loaders the strip needs.
 *
 * One field per metric rather than one loader returning all four, so that "four
 * independent cells" is the shape of the props and not a convention a future edit can
 * quietly drop. Note the type asymmetry the tool already has: Runway is a `RunwayCell`,
 * not a `MetricCell`.
 */
export interface ControlTowerMetricSource {
  readonly cash: MetricLoad<MetricCell>;
  readonly revenue_30d: MetricLoad<MetricCell>;
  readonly pending_settlement: MetricLoad<MetricCell>;
  readonly runway: MetricLoad<RunwayCell>;
}

/* -------------------------------------------------------------------------- */
/* Failure classification                                                     */
/* -------------------------------------------------------------------------- */

/** Requirement 3.9's client-side patience for each metric attempt. */
export const METRIC_LOAD_TIMEOUT_MS = REQUIREMENT_3_9_METRIC_BOUND_MS;

/**
 * Thrown by {@link loadMetricWithDeadline} when one attempt reaches the metric deadline.
 * The message is diagnostic only; the UI displays the safe cause class, never this text.
 */
export class MetricLoadTimeoutError extends Error {
  override readonly name = 'MetricLoadTimeoutError';
}

/**
 * Run one metric load under its own deadline.
 *
 * This function deliberately wraps one `MetricLoad`, not a `ControlTowerMetricSource`:
 * each mounted cell creates its own call, timer and child signal. The loader's resolved
 * cell is returned byte-for-byte, preserving its Evidence_Chain fields. A timeout aborts
 * only this loader and rejects with {@link MetricLoadTimeoutError}; ordinary computation
 * errors are allowed through unchanged so the caller can distinguish the two classes.
 *
 * `timeoutMs` is a test seam. Production callers omit it and always receive the exact
 * 30-second Requirement 3.9 bound.
 */
export async function loadMetricWithDeadline<C extends AnyMetricCell>(
  load: MetricLoad<C>,
  outerSignal: AbortSignal,
  timeoutMs: number = METRIC_LOAD_TIMEOUT_MS,
): Promise<C> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError(`metric timeout must be a positive safe integer; got ${String(timeoutMs)}`);
  }

  if (outerSignal.aborted) {
    throw outerSignal.reason;
  }

  const controller = new AbortController();
  let rejectOuterAbort: (reason?: unknown) => void = () => undefined;
  const outerAbort = new Promise<never>((_resolve, reject) => {
    rejectOuterAbort = reject;
  });
  const onOuterAbort = (): void => {
    const reason = outerSignal.reason;
    controller.abort(reason);
    rejectOuterAbort(reason);
  };
  outerSignal.addEventListener('abort', onOuterAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const timeout = new MetricLoadTimeoutError(
        `metric computation did not complete within ${timeoutMs} ms`,
      );
      controller.abort(timeout);
      reject(timeout);
    }, timeoutMs);
  });

  // Defer the call so a synchronous throw from a non-async loader is also a rejection.
  const running = Promise.resolve().then(() => load(controller.signal));

  try {
    return await Promise.race([running, deadline, outerAbort]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Requirement 3.9's two causes, decided from the rejection.
 *
 * `timeout` for {@link MetricLoadTimeoutError} and for the platform's own
 * `TimeoutError` (what `AbortSignal.timeout` aborts with), `error` for everything else.
 * The rejection reason itself is deliberately discarded rather than displayed: a raw
 * message can carry Tenant data or a provider string into a dashboard, which is the same
 * reason `isolateMetricCell` drops it on the tool side.
 */
export function classifyLoadFailure(reason: unknown): MetricFailureKind {
  if (reason instanceof MetricLoadTimeoutError) {
    return 'timeout';
  }
  if (reason instanceof Error && reason.name === 'TimeoutError') {
    return 'timeout';
  }
  return 'error';
}

/* -------------------------------------------------------------------------- */
/* The state                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What a cell can hold: whatever its own load produced, plus the two states the UI owns
 * rather than the tool.
 *
 * Spelled as a union with `ProcessingMetricCell` and `FailedMetricCell` rather than as
 * bare `C` for a concrete reason: both are members of `MetricCell` *and* of `RunwayCell`,
 * so `LoadedCell<MetricCell>` is just `MetricCell` and `LoadedCell<RunwayCell>` is just
 * `RunwayCell` — the reducer can construct either without a type assertion, and without
 * being generic in a way that would let a Runway cell hold a monetary figure. This is the
 * same reasoning `get-control-tower-metrics.ts` gives for using two concrete failure
 * builders instead of one generic one.
 */
export type LoadedCell<C extends AnyMetricCell> = C | ProcessingMetricCell | FailedMetricCell;

/** Requirement 3.8's state, and the only cell a strip shows before anything resolves. */
export const PROCESSING_CELL: ProcessingMetricCell = { state: 'processing' };

export interface MetricCellState<C extends AnyMetricCell> {
  readonly cell: LoadedCell<C>;
  /** 0 for the first load, then one per retry. The load effect's key. */
  readonly attempt: number;
}

export function initialMetricCellState<C extends AnyMetricCell>(): MetricCellState<C> {
  return { cell: PROCESSING_CELL, attempt: 0 };
}

export type MetricCellAction<C extends AnyMetricCell> =
  /** Requirement 3.9's retry control was used. Back to `processing`, load again. */
  | { readonly kind: 'retry_requested' }
  /** The load answered. Whatever it answered *is* the cell, including `failed`. */
  | { readonly kind: 'load_settled'; readonly cell: C }
  /** The load rejected. See {@link classifyLoadFailure}. */
  | { readonly kind: 'load_failed'; readonly failureKind: MetricFailureKind };

/**
 * The whole state machine for one cell.
 *
 * Note what is absent: no branch carries a figure forward. `retry_requested` and
 * `load_failed` both replace the cell outright, so a previous value can never be left on
 * screen looking current while a retry is in flight or after a failure — the same
 * guarantee `FailedMetricCell` gives structurally on the tool side.
 */
export function metricCellReducer<C extends AnyMetricCell>(
  state: MetricCellState<C>,
  action: MetricCellAction<C>,
): MetricCellState<C> {
  switch (action.kind) {
    case 'retry_requested':
      return { cell: PROCESSING_CELL, attempt: state.attempt + 1 };
    case 'load_settled':
      return { cell: action.cell, attempt: state.attempt };
    case 'load_failed':
      return { cell: failedMetricCell(action.failureKind), attempt: state.attempt };
  }
}
