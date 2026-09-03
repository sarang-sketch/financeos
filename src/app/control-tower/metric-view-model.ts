/**
 * The Control_Tower metric strip's **view model** (task 14.1).
 * Requirements 3.1, 3.2, 3.3, 3.4, 3.10, 3.11, 3.12.
 *
 * This is the first UI module in the project, so it sets a convention the rest of task
 * 14 and task 27.1 follow:
 *
 * > **Every decision about what a state looks like is made in a pure module; the
 * > components only place the strings in the DOM.**
 *
 * There is no DOM environment and no React testing library in this repository
 * (`vitest.config.ts` runs every project with `environment: 'node'`, and neither
 * `jsdom`/`happy-dom` nor `@testing-library/react` is installed). Rather than leave the
 * state-to-view mapping untested until task 14.6 installs one, the whole mapping lives
 * here — pure functions from a `MetricCell` to a `MetricCellView`, no React import, no
 * DOM — and is unit-tested under the existing `unit` project in
 * `./metric-view-model.test.ts`. What is left for 14.6 is what genuinely needs a DOM:
 * that the components put these strings in the right elements, and that a click on the
 * retry control re-invokes the loader.
 *
 * ## Money
 *
 * `formatInr` and `secondaryUnit` from `@/format/inr` are the only paths a monetary
 * value takes to the screen. There is no `Intl.NumberFormat`, no `toFixed` and no
 * `Number(...)` on a `Paise` anywhere in this file — `Paise` is `bigint`, the lakh and
 * crore bands are `secondaryUnit`'s (Requirement 3.3, 3.11) and are **not re-derived
 * here**, and the 2,2,3 grouping and the two decimal places are `formatInr`'s
 * (Requirement 3.2).
 *
 * The one thing this module adds to `secondaryUnit`'s output is the sign and the
 * symbol. `secondaryUnit` is deliberately magnitude-based — its own doc comment says
 * it "only ever passes a non-negative numerator" — so `-1_50_000_00n` yields the text
 * `1.50 L` with no sign and no `₹`. Rendering that beside `-₹1,50,000.00` would read as
 * a positive secondary figure for a negative primary one, which for the Cash metric is
 * the difference between "you are 1.5 lakh short" and "you have 1.5 lakh". So the sign
 * is re-applied from the same `Paise` value and placed before the symbol, exactly as
 * `formatInr` places it: `-₹1.50 L`. This is string concatenation of an already-rounded
 * 2-decimal string, not arithmetic; no monetary value passes through a float.
 *
 * ## Runway is not money
 *
 * `RunwayCell` is a different type from `MetricCell` and `runway_months` is a `number`
 * of months, not `Paise` (see `@/tools/control-tower-metrics-cells`). So Runway is
 * **not** rendered through `formatInr`, and `toFixed(1)` is correct for it:
 * Requirement 3.4 wants 1 decimal place, the value is a presentation value bounded to
 * `0.0..120.0` by the tool's schema, and it is not a monetary quantity, so the money
 * type discipline does not reach it. {@link formatRunwayMonths} is the single place
 * that formatting happens.
 *
 * ## State is never conveyed by colour
 *
 * Every view carries a {@link MetricCellView.statusText} and, for every non-`ready`
 * state, a {@link MetricCellView.detail} sentence — both plain text. A theme may use
 * the `data-state` attribute the components emit for colour, and the text still says
 * which state applies without it.
 *
 * ## The invariant a failed or processing cell must not break
 *
 * A `failed`, `processing`, `unavailable` or `incomplete_evidence` view has
 * `value.kind === 'none'` and `evidence === null`. **No stale figure is ever rendered
 * as current.** The cell types make that unrepresentable at the source (a
 * `FailedMetricCell` has no `value_paise` field at all), and
 * `./metric-view-model.test.ts` asserts it again on the view, because the view is what
 * a component reads.
 *
 * ## Deliberately not here
 *
 * - **Task 14.4** owns the empty states: the Tenant-wide "ingestion has not completed"
 *   message, the ≤30 s processing window, and the zero-open-Exceptions state. This
 *   module renders the *per-cell* half of those (`unavailable`, `processing`) because a
 *   cell has to render something; the Tenant-level message and the 30 s timer are 14.4's.
 * - **Task 14.5** owns the failure policy: the 30 s bound, what a retry re-invokes, and
 *   the `metric_computation_failed` Audit_Event. This module produces the failure
 *   *view* and sets {@link MetricCellView.retryable}; it decides nothing about retrying.
 * - **Task 14.2 / 14.3** own the Attention_Panel and the Evidence panel. This module
 *   carries {@link MetricCellView.evidence} so 14.3 can attach "every displayed figure
 *   is a control that opens its Evidence_Chain" (Requirement 12.5) without this file
 *   changing, and opens nothing itself.
 *
 * Pure and synchronous. No module state, no React, no DOM.
 */

import type { Paise } from '@/calc/paise';
import { formatInr, secondaryUnit } from '@/format/inr';
import { formatIst, formatIstIso } from '@/format/ist';
import type { SourceRecordType } from '@/ledger/posting-rules';
import {
  MAX_RUNWAY_MONTHS,
  METRIC_NAMES,
  type MetricCell,
  type MetricFailureKind,
  type MetricName,
  type MetricState,
  type MetricUnavailableReason,
  type RunwayCell,
  type RunwayUnavailableReason,
} from '@/tools/control-tower-metrics-cells';
import type { GetControlTowerMetricsOutput } from '@/tools/get-control-tower-metrics';

/* -------------------------------------------------------------------------- */
/* Labels                                                                     */
/* -------------------------------------------------------------------------- */

/** The three metrics whose figure is money. Runway is months (Requirement 3.4). */
export type MonetaryMetricName = Exclude<MetricName, 'runway'>;

/**
 * design.md's four strip labels. "Revenue (trailing 30 days)" spells the window out
 * because Requirement 3.1 defines Revenue as a trailing-30-calendar-day figure and a
 * bare "Revenue" would read as period-to-date.
 */
export const METRIC_LABELS = {
  cash: 'Cash',
  revenue_30d: 'Revenue (trailing 30 days)',
  pending_settlement: 'Pending Settlement',
  runway: 'Runway',
} as const satisfies Record<MetricName, string>;

export function metricLabel(metric: MetricName): string {
  return METRIC_LABELS[metric];
}

/* -------------------------------------------------------------------------- */
/* Timestamps                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One instant, twice: the text a User reads and the value a `<time dateTime>` carries.
 *
 * Both come from `@/format/ist`, which uses the fixed +05:30 offset rather than `Intl`,
 * and both are whole-second precision (Requirement 3.10) — milliseconds are dropped,
 * not rounded.
 */
export interface IstStamp {
  /** `2024-03-14 21:35:07 IST`. */
  readonly text: string;
  /** `2024-03-14T21:35:07+05:30`, for the `datetime` attribute. */
  readonly machine: string;
}

export function istStamp(iso: string): IstStamp {
  return { text: formatIst(iso), machine: formatIstIso(iso) };
}

/** `last_ingested_at` and `evidence_as_of` are both optional on some cells. */
function optionalIstStamp(iso: string | undefined): IstStamp | null {
  return iso === undefined ? null : istStamp(iso);
}

/* -------------------------------------------------------------------------- */
/* Values                                                                     */
/* -------------------------------------------------------------------------- */

/** Which secondary line applies, mirroring `secondaryUnit`'s bands exactly. */
export type SecondaryUnitKind = 'lakh' | 'crore' | 'none';

/**
 * What a cell displays where a figure would go.
 *
 * `none` is not "zero" — it is "there is no figure", which is what every non-`ready`
 * state has. A `0n` Cash figure is `money` with `primary: '₹0.00'`.
 */
export interface MoneyValueView {
  readonly kind: 'money';
  /** `formatInr`: `₹1,50,000.00`, Indian_Number_Format (Requirement 3.2). */
  readonly primary: string;
  /** The exact integer paise, for `<data value>`. Never a float. */
  readonly machinePaise: string;
  /** `₹1.50 L` / `₹1.23 Cr` / `null` outside both bands (Requirement 3.3, 3.11). */
  readonly secondary: string | null;
  readonly secondaryUnit: SecondaryUnitKind;
}

export interface MonthsValueView {
  readonly kind: 'months';
  /** `18.4 months`, 1 decimal place (Requirement 3.4). */
  readonly text: string;
  /** `18.4`, for `<data value>`. */
  readonly machineMonths: string;
}

export type MetricValueView = { readonly kind: 'none' } | MoneyValueView | MonthsValueView;

const NO_VALUE: MetricValueView = { kind: 'none' };

/**
 * A monetary figure, its Indian_Number_Format rendering and its secondary line.
 *
 * Both bands come from `secondaryUnit`. The sign is re-applied here because
 * `secondaryUnit` is magnitude-based; see the module doc comment.
 */
export function moneyValueView(valuePaise: Paise): MoneyValueView {
  const unit = secondaryUnit(valuePaise);
  const sign = valuePaise < 0n ? '-' : '';
  return {
    kind: 'money',
    primary: formatInr(valuePaise),
    machinePaise: valuePaise.toString(),
    secondary: unit.text === null ? null : `${sign}₹${unit.text}`,
    secondaryUnit: unit.unit,
  };
}

/**
 * Runway in months to 1 decimal place (Requirement 3.4).
 *
 * `toFixed` is correct here and would not be for money: months are a presentation
 * `number` bounded to `0.0..MAX_RUNWAY_MONTHS` by `readyRunwaySchema`, not a monetary
 * quantity. Always 1 decimal place, so `120` renders `120.0 months` and `1` renders
 * `1.0 months` rather than `1 month`.
 */
export function formatRunwayMonths(months: number): string {
  return `${months.toFixed(1)} months`;
}

/* -------------------------------------------------------------------------- */
/* The view                                                                   */
/* -------------------------------------------------------------------------- */

/** The Evidence_Chain behind a figure. Task 14.3 turns this into a control. */
export interface EvidenceRef {
  readonly chainId: string;
  /** The chain's `as_of`, in IST. Requirement 12.4 compares against this. */
  readonly asOf: IstStamp;
}

/**
 * Everything one metric cell renders. A flat record rather than a discriminated union,
 * because the component is then a single pass with no branching on state — every state
 * differs only in which fields are populated, and the constructors below are the only
 * things that populate them.
 */
export interface MetricCellView {
  readonly metric: MetricName;
  /** The accessible name of the cell, e.g. `Pending Settlement`. */
  readonly label: string;
  /** Emitted as `data-state`, so a theme can style state without owning its meaning. */
  readonly state: MetricState;
  readonly value: MetricValueView;
  /**
   * The state in words, always present. This is what makes state legible without
   * colour: `Processing`, `Computation error`, `Timed out`, `Not applicable`,
   * `Exceeds 120.0 months`. For a `ready` cell it is `Ready` and the component shows
   * the figure instead.
   */
  readonly statusText: string;
  /** One sentence saying why, for every non-`ready` state. `null` when `ready`. */
  readonly detail: string | null;
  /**
   * What the cell's polite live region says. Present in every state, so a cell that
   * transitions from `processing` to `ready` announces the figure rather than
   * silently swapping it (the live region element is stable; only its text changes).
   */
  readonly announcement: string;
  /** Requirement 3.10: the most recent contributing ingestion, IST, whole seconds. */
  readonly ingestedAt: IstStamp | null;
  /** Requirement 12.2: present exactly when there is a figure. */
  readonly evidence: EvidenceRef | null;
  /** Requirement 3.9: a retry control belongs on this cell. Task 14.5 owns the policy. */
  readonly retryable: boolean;
  /** `aria-busy`: the computation is in flight. */
  readonly busy: boolean;
}

/* -------------------------------------------------------------------------- */
/* State wording                                                              */
/* -------------------------------------------------------------------------- */

/** Requirement 3.9: the two causes, told apart in words rather than by colour. */
const FAILURE_STATUS: Record<MetricFailureKind, string> = {
  error: 'Computation error',
  timeout: 'Timed out',
};

const FAILURE_CAUSE: Record<MetricFailureKind, string> = {
  error: 'the computation returned an error',
  timeout: 'the computation did not complete in time',
};

/**
 * Requirement 3.7's condition, worded from `last_ingested_at`.
 *
 * The two halves are told apart exactly as `METRIC_UNAVAILABLE_REASONS` documents:
 * absent means nothing has ever been ingested, present means ingestion has run and
 * this metric's window is empty.
 */
const MONETARY_UNAVAILABLE_STATUS: Record<MetricUnavailableReason, string> = {
  no_contributing_source_records: 'No contributing records',
};

/**
 * Requirement 3.12's two conditions, plus the one this slice actually produces.
 *
 * The task text asks for "exceeds 120.0 months" to be distinguishable from "not
 * applicable". `not_yet_available` is distinguished too, and it is the only reason
 * `get_control_tower_metrics` returns today: Runway comes from the Cash_Agent, which
 * task 34.4 lands. Wording it as a failure would put a retry control on a condition no
 * retry can change, so it reads as a release fact rather than as a fault.
 *
 * The `120.0` in both strings is `MAX_RUNWAY_MONTHS` through
 * {@link formatRunwayMonths}, so the ceiling is stated in one place and the number in
 * the message cannot drift from the number in the schema.
 */
const RUNWAY_UNAVAILABLE_TEXT: Record<
  RunwayUnavailableReason,
  { readonly status: string; readonly detail: string }
> = {
  not_yet_available: {
    status: 'Not yet available',
    detail:
      'Runway is computed by the Cash Agent, which is not part of this release. No ' +
      'Runway number is shown.',
  },
  not_applicable_non_positive_burn: {
    status: 'Not applicable',
    detail:
      'Average net monthly outflow is at or below zero, so there is no runway to ' +
      'divide out and no Runway number is shown.',
  },
  exceeds_maximum_months: {
    status: `Exceeds ${formatRunwayMonths(MAX_RUNWAY_MONTHS)}`,
    detail:
      `Runway is above the maximum of ${formatRunwayMonths(MAX_RUNWAY_MONTHS)}, so no ` +
      'Runway number is shown.',
  },
};

/** `settlement_recon_report` -> `settlement recon report`, for a mid-sentence list. */
function sourceTypeText(type: SourceRecordType): string {
  return type.replace(/_/g, ' ');
}

/** Requirement 12.3's per-type counts, as a sentence fragment: `3 payments, 1 refund`. */
function unavailableCountsText(
  unavailable: readonly { readonly type: SourceRecordType; readonly count: number }[],
): string {
  return unavailable
    .map(({ type, count }) => `${String(count)} ${sourceTypeText(type)}${count === 1 ? '' : 's'}`)
    .join(', ');
}

/* -------------------------------------------------------------------------- */
/* Shared state constructors                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The pieces every view shares, so `processing` and `failed` — the two states both cell
 * unions have in common — are worded once rather than once per metric family.
 */
function baseView(metric: MetricName): {
  readonly metric: MetricName;
  readonly label: string;
} {
  return { metric, label: metricLabel(metric) };
}

/** Requirement 3.8. No figure: a partial value shown as current is indistinguishable. */
function processingView(metric: MetricName, lastIngestedAt: string | undefined): MetricCellView {
  const { label } = baseView(metric);
  return {
    metric,
    label,
    state: 'processing',
    value: NO_VALUE,
    statusText: 'Processing',
    detail: `The ${label} metric is still being computed.`,
    announcement: `${label}: processing`,
    ingestedAt: optionalIstStamp(lastIngestedAt),
    evidence: null,
    retryable: false,
    busy: true,
  };
}

/**
 * Requirement 3.9: the metric is named, the cause class is stated, and a retry control
 * belongs here. No figure and no chain — a failed cell must not hand back a stale value.
 */
function failedView(metric: MetricName, failureKind: MetricFailureKind): MetricCellView {
  const { label } = baseView(metric);
  return {
    metric,
    label,
    state: 'failed',
    value: NO_VALUE,
    statusText: FAILURE_STATUS[failureKind],
    detail: `The ${label} metric could not be computed: ${FAILURE_CAUSE[failureKind]}.`,
    announcement: `${label}: ${FAILURE_STATUS[failureKind].toLowerCase()}`,
    ingestedAt: null,
    evidence: null,
    retryable: true,
    busy: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Monetary cells                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One monetary cell's view. Total on `MetricCell`'s five states.
 *
 * Requirement 3.2, 3.3 and 3.11 are satisfied entirely by {@link moneyValueView};
 * Requirement 3.10's timestamp is carried on every state that has one.
 */
export function monetaryCellView(metric: MonetaryMetricName, cell: MetricCell): MetricCellView {
  const { label } = baseView(metric);

  switch (cell.state) {
    case 'ready': {
      const value = moneyValueView(cell.value_paise);
      const spoken =
        value.secondary === null ? value.primary : `${value.primary} (${value.secondary})`;
      return {
        metric,
        label,
        state: 'ready',
        value,
        statusText: 'Ready',
        detail: null,
        announcement: `${label} ${spoken}`,
        ingestedAt: optionalIstStamp(cell.last_ingested_at),
        evidence: { chainId: cell.evidence_chain_id, asOf: istStamp(cell.evidence_as_of) },
        retryable: false,
        busy: false,
      };
    }
    case 'processing':
      return processingView(metric, cell.last_ingested_at);
    case 'failed':
      return failedView(metric, cell.failure_kind);
    case 'unavailable': {
      const status = MONETARY_UNAVAILABLE_STATUS[cell.reason];
      const detail =
        cell.last_ingested_at === undefined
          ? 'No ingestion has completed for this Tenant yet, so this metric has no ' +
            'Source_Records to compute from.'
          : 'Ingestion has completed, but no Source_Record contributes to this metric.';
      return {
        metric,
        label,
        state: 'unavailable',
        value: NO_VALUE,
        statusText: status,
        detail,
        announcement: `${label}: ${status.toLowerCase()}`,
        ingestedAt: optionalIstStamp(cell.last_ingested_at),
        evidence: null,
        retryable: false,
        busy: false,
      };
    }
    case 'incomplete_evidence':
      return {
        metric,
        label,
        state: 'incomplete_evidence',
        value: NO_VALUE,
        statusText: 'Evidence incomplete',
        detail:
          `The ${label} figure is withheld because contributing Source_Records could ` +
          `not be read: ${unavailableCountsText(cell.unavailable)}.`,
        announcement: `${label}: evidence incomplete`,
        ingestedAt: null,
        evidence: null,
        retryable: false,
        busy: false,
      };
  }
}

/* -------------------------------------------------------------------------- */
/* The Runway cell                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The Runway cell's view. Total on `RunwayCell`'s four states.
 *
 * Runway has no `incomplete_evidence` variant and no `value_paise`: it is months, not
 * money (Requirement 3.4), so it never reaches `formatInr`.
 */
export function runwayCellView(cell: RunwayCell): MetricCellView {
  const metric: MetricName = 'runway';
  const { label } = baseView(metric);

  switch (cell.state) {
    case 'ready': {
      const text = formatRunwayMonths(cell.runway_months);
      return {
        metric,
        label,
        state: 'ready',
        value: { kind: 'months', text, machineMonths: cell.runway_months.toFixed(1) },
        statusText: 'Ready',
        detail: null,
        announcement: `${label} ${text}`,
        ingestedAt: optionalIstStamp(cell.last_ingested_at),
        evidence: { chainId: cell.evidence_chain_id, asOf: istStamp(cell.evidence_as_of) },
        retryable: false,
        busy: false,
      };
    }
    case 'processing':
      return processingView(metric, cell.last_ingested_at);
    case 'failed':
      return failedView(metric, cell.failure_kind);
    case 'unavailable': {
      const wording = RUNWAY_UNAVAILABLE_TEXT[cell.reason];
      return {
        metric,
        label,
        state: 'unavailable',
        value: NO_VALUE,
        statusText: wording.status,
        detail: wording.detail,
        announcement: `${label}: ${wording.status.toLowerCase()}`,
        ingestedAt: optionalIstStamp(cell.last_ingested_at),
        evidence: null,
        retryable: false,
        busy: false,
      };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The strip                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The four views for a resolved snapshot, in `METRIC_NAMES` order — which is design.md's
 * strip order: Cash, Revenue (trailing 30 days), Pending Settlement, Runway.
 *
 * For the snapshot path only (a server-resolved `get_control_tower_metrics` result).
 * The self-loading path never has all four cells in one object, which is the point: see
 * `./MetricStrip.tsx`.
 */
export function metricStripView(cells: GetControlTowerMetricsOutput): readonly MetricCellView[] {
  return METRIC_NAMES.map((metric) =>
    metric === 'runway'
      ? runwayCellView(cells.runway)
      : monetaryCellView(metric, cells[metric]),
  );
}
