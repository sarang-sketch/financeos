/**
 * Unit tests for the metric strip's view model (task 14.1).
 * Requirements 3.2, 3.3, 3.4, 3.10, 3.11, 3.12.
 *
 * Stage 3, `unit` project: pure functions, no DOM, no React, no network. This is the
 * whole of the state-to-view mapping, which is why it lives in a pure module — the
 * repository has no DOM environment and no React testing library, so a mapping left
 * inside a component would be untested until task 14.6 installs one.
 */

import { describe, expect, it } from 'vitest';

import type { Paise } from '@/calc/paise';
import {
  MAX_RUNWAY_MONTHS,
  METRIC_NAMES,
  type MetricCell,
  type RunwayCell,
  RUNWAY_UNAVAILABLE_REASONS,
} from '@/tools/control-tower-metrics-cells';
import type { GetControlTowerMetricsOutput } from '@/tools/get-control-tower-metrics';

import {
  formatRunwayMonths,
  istStamp,
  METRIC_LABELS,
  metricStripView,
  moneyValueView,
  monetaryCellView,
  runwayCellView,
} from './metric-view-model';

const CHAIN_ID = '9f1c2c2e-0f4b-4b9e-9d33-6f4a1b2c3d4e';
const AS_OF = '2026-08-02T14:05:07.412Z';
const INGESTED_AT = '2026-08-02T13:59:59.999Z';

function readyMoney(valuePaise: Paise, lastIngestedAt?: string): MetricCell {
  return {
    state: 'ready',
    value_paise: valuePaise,
    evidence_chain_id: CHAIN_ID,
    evidence_as_of: AS_OF,
    ...(lastIngestedAt === undefined ? {} : { last_ingested_at: lastIngestedAt }),
  };
}

describe('moneyValueView — Indian_Number_Format and the two secondary bands', () => {
  it('renders the primary figure through formatInr with 2,2,3 grouping', () => {
    // Requirement 3.2
    expect(moneyValueView(1_50_000_00n).primary).toBe('₹1,50,000.00');
    expect(moneyValueView(66_100n).primary).toBe('₹661.00');
    expect(moneyValueView(0n).primary).toBe('₹0.00');
  });

  it('carries the exact integer paise as the machine value, never a float', () => {
    expect(moneyValueView(1_50_000_00n).machinePaise).toBe('15000000');
    expect(moneyValueView(-1n).machinePaise).toBe('-1');
  });

  it('adds no secondary line below ₹1,00,000', () => {
    // Requirement 3.3's lower boundary: 99,999.99 is outside the band.
    const view = moneyValueView(99_999_99n);
    expect(view.secondaryUnit).toBe('none');
    expect(view.secondary).toBeNull();
  });

  it('adds the lakh line from ₹1,00,000 to just below ₹1,00,00,000', () => {
    // Requirement 3.3, both ends of the band, to 2 decimal places.
    const atOpen = moneyValueView(1_00_000_00n);
    expect(atOpen.secondaryUnit).toBe('lakh');
    expect(atOpen.secondary).toBe('₹1.00 L');

    const atClose = moneyValueView(99_99_999_99n);
    expect(atClose.secondaryUnit).toBe('lakh');
    expect(atClose.secondary).toBe('₹100.00 L');

    expect(moneyValueView(12_34_567_00n).secondary).toBe('₹12.35 L');
  });

  it('switches to the crore line at ₹1,00,00,000', () => {
    // Requirement 3.11
    const atOpen = moneyValueView(1_00_00_000_00n);
    expect(atOpen.secondaryUnit).toBe('crore');
    expect(atOpen.secondary).toBe('₹1.00 Cr');

    expect(moneyValueView(12_34_56_789_00n).secondary).toBe('₹12.35 Cr');
  });

  it('keeps the sign on the secondary line, placed before the symbol', () => {
    // `secondaryUnit` is magnitude-based, so an unsigned secondary line beside a
    // negative primary would read as a positive figure.
    const view = moneyValueView(-1_50_000_00n);
    expect(view.primary).toBe('-₹1,50,000.00');
    expect(view.secondary).toBe('-₹1.50 L');
  });
});

describe('istStamp — Requirement 3.10', () => {
  it('renders IST to whole-second precision, dropping milliseconds', () => {
    // 13:59:59.999Z + 05:30 = 19:29:59 IST, and the .999 never appears.
    expect(istStamp(INGESTED_AT).text).toBe('2026-08-02 19:29:59 IST');
    expect(istStamp(INGESTED_AT).machine).toBe('2026-08-02T19:29:59+05:30');
  });

  it('is carried on a ready cell that has a contributing ingestion', () => {
    const view = monetaryCellView('cash', readyMoney(1_00_000_00n, INGESTED_AT));
    expect(view.ingestedAt).toEqual({
      text: '2026-08-02 19:29:59 IST',
      machine: '2026-08-02T19:29:59+05:30',
    });
  });

  it('is absent when the cell carries no contributing ingestion', () => {
    expect(monetaryCellView('cash', readyMoney(1_00_000_00n)).ingestedAt).toBeNull();
  });
});

describe('monetaryCellView', () => {
  it('grounds a ready figure in its Evidence_Chain, in IST', () => {
    // Requirement 12.2: a figure and its chain, or neither.
    const view = monetaryCellView('revenue_30d', readyMoney(5_00_000_00n, INGESTED_AT));
    expect(view.state).toBe('ready');
    expect(view.label).toBe(METRIC_LABELS.revenue_30d);
    expect(view.evidence).toEqual({
      chainId: CHAIN_ID,
      asOf: { text: '2026-08-02 19:35:07 IST', machine: '2026-08-02T19:35:07+05:30' },
    });
    expect(view.detail).toBeNull();
    expect(view.retryable).toBe(false);
    expect(view.busy).toBe(false);
  });

  it('announces the figure and its secondary line for a screen reader', () => {
    const view = monetaryCellView('cash', readyMoney(1_50_000_00n));
    expect(view.announcement).toBe('Cash ₹1,50,000.00 (₹1.50 L)');
  });

  it('renders processing with no figure and aria-busy set', () => {
    // Requirement 3.8
    const view = monetaryCellView('cash', { state: 'processing', last_ingested_at: INGESTED_AT });
    expect(view.state).toBe('processing');
    expect(view.statusText).toBe('Processing');
    expect(view.value).toEqual({ kind: 'none' });
    expect(view.busy).toBe(true);
    expect(view.retryable).toBe(false);
    expect(view.ingestedAt).not.toBeNull();
  });

  it('distinguishes a computation error from a timeout, names the metric, and offers retry', () => {
    // Requirement 3.9
    const errored = monetaryCellView('pending_settlement', {
      state: 'failed',
      failure_kind: 'error',
    });
    const timedOut = monetaryCellView('pending_settlement', {
      state: 'failed',
      failure_kind: 'timeout',
    });

    expect(errored.statusText).toBe('Computation error');
    expect(timedOut.statusText).toBe('Timed out');
    expect(errored.statusText).not.toBe(timedOut.statusText);
    expect(errored.detail).toContain('Pending Settlement');
    expect(timedOut.detail).toContain('Pending Settlement');
    expect(errored.retryable).toBe(true);
    expect(timedOut.retryable).toBe(true);
  });

  it('tells "nothing ingested yet" apart from "this window is empty"', () => {
    // Requirement 3.7's two halves, told apart by `last_ingested_at`.
    const never = monetaryCellView('cash', {
      state: 'unavailable',
      reason: 'no_contributing_source_records',
    });
    const emptyWindow = monetaryCellView('cash', {
      state: 'unavailable',
      reason: 'no_contributing_source_records',
      last_ingested_at: INGESTED_AT,
    });

    expect(never.statusText).toBe('No contributing records');
    expect(emptyWindow.statusText).toBe('No contributing records');
    expect(never.detail).not.toBe(emptyWindow.detail);
    expect(never.detail).toContain('No ingestion has completed');
    expect(emptyWindow.detail).toContain('Ingestion has completed');
    expect(never.retryable).toBe(false);
  });

  it('states the unavailable Source_Record types and counts, and withholds the figure', () => {
    // Requirement 12.3, applied per cell.
    const view = monetaryCellView('revenue_30d', {
      state: 'incomplete_evidence',
      unavailable: [
        { type: 'payment', count: 3 },
        { type: 'settlement_recon_report', count: 1 },
      ],
    });
    expect(view.statusText).toBe('Evidence incomplete');
    expect(view.detail).toContain('3 payments');
    expect(view.detail).toContain('1 settlement recon report');
    expect(view.value).toEqual({ kind: 'none' });
  });
});

describe('runwayCellView — Requirement 3.4 and 3.12', () => {
  it('renders an available Runway to exactly 1 decimal place', () => {
    const ready = (months: number): RunwayCell => ({
      state: 'ready',
      runway_months: months,
      runway_basis: 'computed',
      evidence_chain_id: CHAIN_ID,
      evidence_as_of: AS_OF,
    });

    expect(runwayCellView(ready(18.4)).value).toEqual({
      kind: 'months',
      text: '18.4 months',
      machineMonths: '18.4',
    });
    expect(formatRunwayMonths(0)).toBe('0.0 months');
    expect(formatRunwayMonths(1)).toBe('1.0 months');
    expect(formatRunwayMonths(MAX_RUNWAY_MONTHS)).toBe('120.0 months');
  });

  it('never renders Runway as money', () => {
    const view = runwayCellView({
      state: 'ready',
      runway_months: 7.5,
      runway_basis: 'computed',
      evidence_chain_id: CHAIN_ID,
      evidence_as_of: AS_OF,
    });
    expect(view.value.kind).toBe('months');
    expect(JSON.stringify(view)).not.toContain('₹');
  });

  it('gives each of the three unavailable reasons its own non-numeric wording', () => {
    const views = RUNWAY_UNAVAILABLE_REASONS.map((reason) =>
      runwayCellView({ state: 'unavailable', reason }),
    );
    const statuses = views.map((v) => v.statusText);

    expect(statuses).toEqual(['Not yet available', 'Not applicable', 'Exceeds 120.0 months']);
    expect(new Set(statuses).size).toBe(RUNWAY_UNAVAILABLE_REASONS.length);
    expect(new Set(views.map((v) => v.detail)).size).toBe(RUNWAY_UNAVAILABLE_REASONS.length);

    // Requirement 3.12: no Runway number in any of them.
    for (const view of views) {
      expect(view.value).toEqual({ kind: 'none' });
      expect(view.state).toBe('unavailable');
    }
  });

  it('states the 120.0 month ceiling from MAX_RUNWAY_MONTHS, not a literal', () => {
    const view = runwayCellView({ state: 'unavailable', reason: 'exceeds_maximum_months' });
    expect(view.statusText).toBe(`Exceeds ${formatRunwayMonths(MAX_RUNWAY_MONTHS)}`);
    expect(view.detail).toContain(formatRunwayMonths(MAX_RUNWAY_MONTHS));
  });

  it('shares processing and failed with the monetary cells', () => {
    expect(runwayCellView({ state: 'processing' }).busy).toBe(true);
    const failed = runwayCellView({ state: 'failed', failure_kind: 'timeout' });
    expect(failed.statusText).toBe('Timed out');
    expect(failed.retryable).toBe(true);
    expect(failed.detail).toContain('Runway');
  });
});

describe('no non-ready state ever carries a figure or a chain', () => {
  // A stale value rendered as current is indistinguishable to a User from a current one.
  const monetary: MetricCell[] = [
    { state: 'processing' },
    { state: 'processing', last_ingested_at: INGESTED_AT },
    { state: 'failed', failure_kind: 'error' },
    { state: 'failed', failure_kind: 'timeout' },
    { state: 'unavailable', reason: 'no_contributing_source_records' },
    { state: 'incomplete_evidence', unavailable: [{ type: 'payment', count: 1 }] },
  ];

  const runway: RunwayCell[] = [
    { state: 'processing' },
    { state: 'failed', failure_kind: 'error' },
    ...RUNWAY_UNAVAILABLE_REASONS.map(
      (reason): RunwayCell => ({ state: 'unavailable', reason }),
    ),
  ];

  it.each(monetary.map((cell) => [cell.state, cell] as const))(
    'monetary %s carries no value and no evidence',
    (_state, cell) => {
      const view = monetaryCellView('cash', cell);
      expect(view.value).toEqual({ kind: 'none' });
      expect(view.evidence).toBeNull();
      expect(view.detail).not.toBeNull();
      expect(view.announcement.startsWith('Cash')).toBe(true);
    },
  );

  it.each(runway.map((cell) => [cell.state, cell] as const))(
    'runway %s carries no value and no evidence',
    (_state, cell) => {
      const view = runwayCellView(cell);
      expect(view.value).toEqual({ kind: 'none' });
      expect(view.evidence).toBeNull();
      expect(view.detail).not.toBeNull();
      expect(view.announcement.startsWith('Runway')).toBe(true);
    },
  );
});

describe('metricStripView', () => {
  it('returns the four cells in design.md strip order, each with its own state', () => {
    const cells: GetControlTowerMetricsOutput = {
      cash: readyMoney(1_00_00_000_00n, INGESTED_AT),
      revenue_30d: { state: 'failed', failure_kind: 'timeout' },
      pending_settlement: { state: 'processing' },
      runway: { state: 'unavailable', reason: 'not_yet_available' },
    };

    const views = metricStripView(cells);

    expect(views.map((v) => v.metric)).toEqual([...METRIC_NAMES]);
    // One failing metric leaves the other three intact (Requirement 3.9).
    expect(views.map((v) => v.state)).toEqual([
      'ready',
      'failed',
      'processing',
      'unavailable',
    ]);
    expect(views[0]?.value).toEqual({
      kind: 'money',
      primary: '₹1,00,00,000.00',
      machinePaise: '1000000000',
      secondary: '₹1.00 Cr',
      secondaryUnit: 'crore',
    });
    expect(views[3]?.statusText).toBe('Not yet available');
  });

  it('labels every metric', () => {
    for (const metric of METRIC_NAMES) {
      expect(METRIC_LABELS[metric].length).toBeGreaterThan(0);
    }
  });
});
