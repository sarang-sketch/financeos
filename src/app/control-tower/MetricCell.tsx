'use client';

/**
 * One Control_Tower metric cell (task 14.1).
 * Requirements 3.1, 3.2, 3.3, 3.4, 3.8, 3.9, 3.10, 3.11, 3.12.
 *
 * This file is the first component in the project and sets three conventions:
 *
 * 1. **Presentation is a pure function; the component only places strings.** Every
 *    wording, band and format decision is in `./metric-view-model.ts`, which is unit
 *    tested. {@link MetricCellDisplay} takes a `MetricCellView` and adds no logic beyond
 *    "is this field present".
 * 2. **State ownership is a thin wrapper.** {@link MoneyMetricCell} and
 *    {@link RunwayMetricCell} own one cell's async state through
 *    {@link useMetricCellState}, whose transitions live in the pure
 *    `./metric-cell-state.ts`. The stateful part of a component is therefore a reducer
 *    plus one effect, both testable without a DOM.
 * 3. **Accessibility is part of the markup, not a later pass.** See below.
 *
 * ## Per-cell independence
 *
 * A cell is a **self-contained subtree**: its own `useReducer`, its own effect, its own
 * `AbortController`, its own retry handler. Nothing is lifted. That is what makes
 * Requirement 3.9's "display the remaining metrics that computed successfully" a property
 * of the tree rather than a promise — there is no shared state for a slow or failing cell
 * to hold.
 *
 * Three edits would break it, and they are the ones to reject in review:
 *
 * - Lifting the four loads into one `await` / `Promise.all` in a parent, so three
 *   resolved cells wait on the slowest.
 * - Wrapping the strip in a single `<Suspense>` boundary, which hides three good cells
 *   behind one pending one.
 * - Rendering from one shared `state` object in a parent, which reintroduces the single
 *   aggregate design.md rejected for exactly this reason.
 *
 * A shared *transport* is fine and expected: task 15.1's `GET /control-tower/metrics`
 * returns all four cells in one response, and four loaders may close over one in-flight
 * request. Independence is about the component tree, not the number of HTTP requests.
 *
 * ## Two concrete components rather than one generic one
 *
 * `MetricCell` and `RunwayCell` are different types — Runway is months, not money — so
 * there are two components. One generic component would have to be generic over the cell
 * union, and inference across the strip's four call sites would then widen every cell to
 * `MetricCell | RunwayCell`, letting a Runway cell hold a monetary figure as far as the
 * compiler was concerned. `get-control-tower-metrics.ts` makes the same call for the same
 * reason, in `failedMonetaryCell` / `failedRunwayCell`.
 *
 * ## Accessibility
 *
 * - **State is never colour-only.** Every non-`ready` cell renders `statusText` and a
 *   `detail` sentence as text. `data-state` and `data-metric` are emitted for styling and
 *   for tests, and carry no meaning a User depends on.
 * - **Each cell has an accessible name.** `<article aria-labelledby>` pointing at the
 *   cell's own heading, so a screen reader announces "Pending Settlement" before the
 *   figure and cells are navigable as regions.
 * - **`aria-busy`** is set while a cell is `processing`, so assistive technology knows the
 *   subtree is mid-update rather than final.
 * - **One stable polite live region per cell**, carrying `view.announcement`. It is
 *   stable on purpose: a live region that is removed and re-added when the state changes
 *   announces nothing, so the element is always present and only its text changes. That
 *   is what makes the `processing` -> `ready` transition audible (Requirement 3.8 into
 *   3.1) without any cell announcing over another.
 * - **Retry is a real `<button type="button">`**, so it is keyboard operable and
 *   focusable with no `tabIndex` or key handling of our own, and its accessible name
 *   names the metric ("Retry the Cash metric") rather than being four identical "Retry"
 *   buttons. Requirement 3.13 wants controls operable in empty states; because the button
 *   is plain markup inside the cell and depends on nothing outside it, an empty or
 *   failed strip stays operable.
 * - **The ingestion timestamp is a `<time>`** with a machine-readable `dateTime`
 *   alongside the IST text (Requirement 3.10).
 * - **No colour, no icon-only affordance and no `title`-only text** anywhere in this file.
 *
 * Layout and theming are deliberately absent: no stylesheet exists yet and design.md
 * fixes no visual design. The markup is semantic and ordered so a stylesheet can be added
 * without changing it.
 */

import { useCallback, useEffect, useId, useReducer, type CSSProperties, type ReactElement } from 'react';

import { FigureControl, type OpenEvidence } from '@/app/evidence/FigureControl';
import type { MetricCell as MonetaryCell, RunwayCell } from '@/tools/control-tower-metrics-cells';

import {
  type AnyMetricCell,
  classifyLoadFailure,
  initialMetricCellState,
  type LoadedCell,
  loadMetricWithDeadline,
  type MetricLoad,
  metricCellReducer,
} from './metric-cell-state';
import {
  type MetricCellView,
  monetaryCellView,
  type MonetaryMetricName,
  runwayCellView,
} from './metric-view-model';

/**
 * Visually hidden, still announced. Inline rather than a class because the project has no
 * stylesheet yet and this file must not invent one; a later theme can override it.
 */
export const SR_ONLY_STYLE: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  border: 0,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
};

/* -------------------------------------------------------------------------- */
/* Presentation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The figure, or nothing.
 *
 * `<data value>` carries the exact machine value beside the rendered text: integer paise
 * for money (never a float, never a re-parse of the formatted string) and the 1-decimal
 * month figure for Runway.
 */
function MetricValue({
  view,
  onOpenEvidence,
}: {
  readonly view: MetricCellView;
  readonly onOpenEvidence: OpenEvidence;
}): ReactElement | null {
  const { value, evidence } = view;
  if (value.kind === 'none') {
    return null;
  }

  const content =
    value.kind === 'money' ? (
      <>
        <span data-metric-figure="primary">
          <data value={value.machinePaise}>{value.primary}</data>
        </span>
        {value.secondary === null ? null : (
          <span data-metric-figure="secondary" data-secondary-unit={value.secondaryUnit}>
            {value.secondary}
          </span>
        )}
      </>
    ) : (
      <span data-metric-figure="primary">
        <data value={value.machineMonths}>{value.text}</data>
      </span>
    );

  if (evidence === null) {
    throw new Error(`Displayed ${view.label} figure has no Evidence_Chain`);
  }
  return (
    <FigureControl
      evidence={evidence}
      accessibleFigure={view.announcement}
      onOpenEvidence={onOpenEvidence}
    >
      {content}
    </FigureControl>
  );
}

export interface MetricCellDisplayProps {
  readonly view: MetricCellView;
  /** Every ready figure must have a real Evidence_Chain opener (Requirement 12.5). */
  readonly onOpenEvidence: OpenEvidence;
  /**
   * Requirement 3.9's retry control. Rendered only when the view is retryable **and** a
   * handler exists — a button that cannot retry anything is worse than no button.
   */
  readonly onRetry?: () => void;
}

/**
 * A cell, rendered. Pure: same view in, same markup out, no state and no effects, so it
 * is equally usable from a server component holding a resolved
 * `get_control_tower_metrics` snapshot and from the self-loading wrappers below.
 */
export function MetricCellDisplay({
  view,
  onRetry,
  onOpenEvidence,
}: MetricCellDisplayProps): ReactElement {
  const titleId = useId();

  return (
    <article
      aria-labelledby={titleId}
      aria-busy={view.busy}
      data-metric={view.metric}
      data-state={view.state}
    >
      <h3 id={titleId}>{view.label}</h3>

      <MetricValue view={view} onOpenEvidence={onOpenEvidence} />

      {view.state === 'ready' ? null : <p data-metric-status>{view.statusText}</p>}
      {view.detail === null ? null : <p data-metric-detail>{view.detail}</p>}

      {view.ingestedAt === null ? null : (
        <p data-metric-ingested-at>
          Last contributing ingestion{' '}
          <time dateTime={view.ingestedAt.machine}>{view.ingestedAt.text}</time>
        </p>
      )}

      {view.retryable && onRetry !== undefined ? (
        <button type="button" onClick={onRetry} data-metric-retry>
          Retry
          <span style={SR_ONLY_STYLE}> the {view.label} metric</span>
        </button>
      ) : null}

      {/* Stable polite live region: see the accessibility notes above. */}
      <p style={SR_ONLY_STYLE} aria-live="polite">
        {view.announcement}
      </p>
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/* State ownership                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One cell's async state: `processing` until its own load settles, `failed` if the load
 * rejects or exceeds 30 seconds, and back to `processing` on retry.
 *
 * Every attempt runs through {@link loadMetricWithDeadline}. Because this hook exists
 * once per cell, each deadline and retry is independent; there is no parent timer or
 * shared failure state.
 *
 * The effect aborts on cleanup and ignores a settled result it no longer owns, so an
 * unmounted or superseded load can neither dispatch nor leave a request running.
 *
 * `load` is an effect dependency, so it must be referentially stable across renders of
 * the same data source (see {@link MetricLoad}). It is a dependency rather than a ref
 * because a genuinely different loader means genuinely different data, and silently
 * ignoring that would be the harder bug.
 */
export function useMetricCellState<C extends AnyMetricCell>(
  load: MetricLoad<C>,
): { readonly cell: LoadedCell<C>; readonly retry: () => void } {
  const [state, dispatch] = useReducer(metricCellReducer<C>, initialMetricCellState<C>());
  const { attempt } = state;

  useEffect(() => {
    const controller = new AbortController();
    let owned = true;

    loadMetricWithDeadline(load, controller.signal).then(
      (cell) => {
        if (owned) {
          dispatch({ kind: 'load_settled', cell });
        }
      },
      (reason: unknown) => {
        if (owned) {
          dispatch({ kind: 'load_failed', failureKind: classifyLoadFailure(reason) });
        }
      },
    );

    return () => {
      owned = false;
      controller.abort();
    };
  }, [load, attempt]);

  const retry = useCallback(() => {
    dispatch({ kind: 'retry_requested' });
  }, []);

  return { cell: state.cell, retry };
}

/* -------------------------------------------------------------------------- */
/* The two self-loading cells                                                 */
/* -------------------------------------------------------------------------- */

export interface MoneyMetricCellProps {
  readonly metric: MonetaryMetricName;
  readonly load: MetricLoad<MonetaryCell>;
  readonly onOpenEvidence: OpenEvidence;
}

/** Cash, Revenue (trailing 30 days) or Pending Settlement: a figure in `Paise`. */
export function MoneyMetricCell({ metric, load, onOpenEvidence }: MoneyMetricCellProps): ReactElement {
  const { cell, retry } = useMetricCellState<MonetaryCell>(load);
  return (
    <MetricCellDisplay
      view={monetaryCellView(metric, cell)}
      onRetry={retry}
      onOpenEvidence={onOpenEvidence}
    />
  );
}

export interface RunwayMetricCellProps {
  readonly load: MetricLoad<RunwayCell>;
  readonly onOpenEvidence: OpenEvidence;
}

/** Runway: months to 1 decimal place, or a non-numeric state (Requirement 3.4, 3.12). */
export function RunwayMetricCell({ load, onOpenEvidence }: RunwayMetricCellProps): ReactElement {
  const { cell, retry } = useMetricCellState<RunwayCell>(load);
  return (
    <MetricCellDisplay
      view={runwayCellView(cell)}
      onRetry={retry}
      onOpenEvidence={onOpenEvidence}
    />
  );
}
