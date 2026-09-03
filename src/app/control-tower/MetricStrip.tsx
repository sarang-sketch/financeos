'use client';

/**
 * The Control_Tower metric strip (task 14.1).
 * Requirements 3.1, 3.2, 3.3, 3.4, 3.9, 3.10, 3.11, 3.12.
 *
 * design.md's structure, transcribed: "Cash, Revenue (trailing 30 days), Pending
 * Settlement, Runway. Each metric is an independent async cell with its own loading,
 * processing, failure, and retry state, so one failing metric does not block the other
 * three."
 *
 * ## The strip owns layout and nothing else
 *
 * There is no state in this component. It renders four cells, each of which owns its own
 * loading, processing, failure and retry state (see `./MetricCell.tsx`). That is the whole
 * mechanism behind Requirement 3.9's "display the remaining metrics that computed
 * successfully": there is nothing here for a slow or failing metric to hold.
 *
 * Two entry points, matching the two honest ways cell data can arrive:
 *
 * - {@link MetricStrip} — four independent loaders. Each cell starts at `processing`
 *   (Requirement 3.8) and settles on its own schedule. **No `Promise.all`, no shared
 *   `await`, no single `<Suspense>` boundary**, because each of those would make three
 *   resolved cells wait on the slowest one.
 * - {@link MetricStripSnapshot} — one already-resolved `get_control_tower_metrics`
 *   result. For a server component that has the four cells in hand (task 15.1).
 *   Independence is preserved here too because the tool already returns four independent
 *   cells and this component never combines them. Its optional retry callback is passed
 *   the requesting metric only.
 *
 * ## No data fetching decisions live here
 *
 * A loader is `(signal: AbortSignal) => Promise<Cell>` and nothing more. This component
 * constructs no Supabase client, knows no route and holds no credential — the tool's
 * `ctx.db`-backed adapters do not exist until task 26.x and the routes are task 15.1's.
 *
 * ## Left for the rest of task 14
 *
 * - **14.2** adds the Attention_Panel beside this strip.
 * - **14.3** turns each figure into a control that opens its Evidence_Chain; the chain
 *   identifier and its as-of are already on every ready view (`MetricCellView.evidence`).
 * - **14.4** owns the Tenant-level empty states — the "ingestion has not completed"
 *   message, the ≤30 s processing window and the zero-open-Exceptions state. It wraps this
 *   strip; the strip's own per-cell `unavailable` and `processing` rendering is here.
 *
 * Requirement 3.9's per-cell deadline and retry execution live in `MetricCell`; this
 * layout component deliberately remains stateless.
 */

import { useId, type ReactElement, type ReactNode } from 'react';

import type { OpenEvidence } from '@/app/evidence/FigureControl';
import type { MetricName } from '@/tools/control-tower-metrics-cells';
import type { GetControlTowerMetricsOutput } from '@/tools/get-control-tower-metrics';

import { MetricCellDisplay, MoneyMetricCell, RunwayMetricCell } from './MetricCell';
import type { ControlTowerMetricSource } from './metric-cell-state';
import { metricStripView } from './metric-view-model';

/**
 * design.md calls this the "metric strip"; the accessible name says what it holds rather
 * than what it looks like.
 */
const STRIP_HEADING = 'Financial position';

export interface MetricStripProps {
  readonly source: ControlTowerMetricSource;
  readonly onOpenEvidence: OpenEvidence;
}

/**
 * The strip, with each cell loading independently.
 *
 * A `<section>` with an accessible name is a region, so the strip is reachable by
 * landmark navigation; the `<ul>` tells a screen reader there are four cells and which one
 * of four it is on. Cells are in `METRIC_NAMES` order, which is design.md's order.
 */
export function MetricStrip({ source, onOpenEvidence }: MetricStripProps): ReactElement {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} data-control-tower="metric-strip">
      <h2 id={headingId}>{STRIP_HEADING}</h2>
      <ul>
        <li>
          <MoneyMetricCell metric="cash" load={source.cash} onOpenEvidence={onOpenEvidence} />
        </li>
        <li>
          <MoneyMetricCell
            metric="revenue_30d"
            load={source.revenue_30d}
            onOpenEvidence={onOpenEvidence}
          />
        </li>
        <li>
          <MoneyMetricCell
            metric="pending_settlement"
            load={source.pending_settlement}
            onOpenEvidence={onOpenEvidence}
          />
        </li>
        <li>
          <RunwayMetricCell load={source.runway} onOpenEvidence={onOpenEvidence} />
        </li>
      </ul>
    </section>
  );
}

export interface MetricStripSnapshotProps {
  /** One `get_control_tower_metrics` result: four independent cells. */
  readonly cells: GetControlTowerMetricsOutput;
  readonly onOpenEvidence: OpenEvidence;
  /**
   * Requirement 3.9's per-metric retry. Called with the metric that asked, so the caller
   * re-invokes one metric and leaves the other three alone.
   */
  readonly onRetry?: (metric: MetricName) => void;
}

/**
 * The strip from a resolved snapshot, with no state of its own.
 *
 * The retry handler is per metric by construction: there is no "retry all" here, because
 * Requirement 3.9 asks for "a retry control for that metric".
 */
export function MetricStripSnapshot({
  cells,
  onRetry,
  onOpenEvidence,
}: MetricStripSnapshotProps): ReactElement {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} data-control-tower="metric-strip">
      <h2 id={headingId}>{STRIP_HEADING}</h2>
      <ul>
        {metricStripView(cells).map((view) => (
          <li key={view.metric}>
            <MetricCellDisplay
              view={view}
              onOpenEvidence={onOpenEvidence}
              onRetry={
                onRetry === undefined
                  ? undefined
                  : () => {
                      onRetry(view.metric);
                    }
              }
            />
          </li>
        ))}
      </ul>
    </section>
  );
}


/* -------------------------------------------------------------------------- */
/* Tenant-level empty ingestion state                                         */
/* -------------------------------------------------------------------------- */

/**
 * The four honest non-figure cells for a Tenant with zero ingested Razorpay objects.
 *
 * This state is explicit rather than inferred from a failed tool invocation. The
 * `get_control_tower_metrics` tool currently cannot return an empty successful envelope
 * because every successful `ToolResult` requires an Evidence_Chain and a persisted chain
 * must cite at least one Source_Record. Requirement 3.7 nevertheless requires a usable
 * empty dashboard, so the owner that establishes the zero-object fact renders this entry
 * point directly. No synthetic zero, paise value, or empty Evidence_Chain is introduced.
 */
export const EMPTY_INGESTION_METRIC_CELLS: GetControlTowerMetricsOutput = {
  cash: { state: 'unavailable', reason: 'no_contributing_source_records' },
  revenue_30d: { state: 'unavailable', reason: 'no_contributing_source_records' },
  pending_settlement: { state: 'unavailable', reason: 'no_contributing_source_records' },
  runway: { state: 'unavailable', reason: 'not_yet_available' },
};

export interface EmptyIngestionMetricStripProps {
  readonly onOpenEvidence: OpenEvidence;
  /**
   * Optional owner-supplied navigation or ingestion controls. They remain ordinary,
   * enabled controls; the empty state adds no overlay, disabled fieldset, or focus trap.
   */
  readonly controls?: ReactNode;
}

/**
 * Requirement 3.7's Tenant-level zero-ingestion presentation.
 *
 * The message identifies the condition, while the metric strip contains four explicit
 * non-figure cells. Controls are rendered outside the status message so assistive
 * technology does not repeatedly announce them as status text.
 */
export function EmptyIngestionMetricStrip({
  onOpenEvidence,
  controls,
}: EmptyIngestionMetricStripProps): ReactElement {
  const headingId = useId();

  return (
    <>
      <section aria-labelledby={headingId} data-control-tower-empty="ingestion-incomplete">
        <h2 id={headingId}>Ingestion has not completed</h2>
        <p role="status">
          No Razorpay objects have been ingested for this Tenant. Monetary metrics are
          unavailable until ingestion completes.
        </p>
        {controls === undefined ? null : <div data-empty-state-controls>{controls}</div>}
      </section>
      <MetricStripSnapshot
        cells={EMPTY_INGESTION_METRIC_CELLS}
        onOpenEvidence={onOpenEvidence}
      />
    </>
  );
}
