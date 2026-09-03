/**
 * Static-markup tests for the metric strip (task 14.1).
 * Requirements 3.2, 3.3, 3.8, 3.9, 3.10, 3.11, 3.12.
 *
 * **What this can and cannot cover.** There is no DOM environment and no React testing
 * library in this repository, and no dependency may be added, so these tests render the
 * components with `renderToStaticMarkup` from `react-dom/server` — already a dependency,
 * and it needs no DOM. That is enough to assert that the components put the view model's
 * strings into the right elements and attributes, which is the half of task 14.1 the pure
 * view-model tests cannot reach.
 *
 * It is **not** enough for behaviour, because `useEffect` does not run during a static
 * render. So the loaders are never called here and a retry is never clicked. Task 14.6
 * owns both; see the report for exactly what it needs installed.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { MetricCell, RunwayCell } from '@/tools/control-tower-metrics-cells';
import type { GetControlTowerMetricsOutput } from '@/tools/get-control-tower-metrics';

import { MetricCellDisplay } from './MetricCell';
import { EmptyIngestionMetricStrip, MetricStrip, MetricStripSnapshot } from './MetricStrip';
import type { ControlTowerMetricSource } from './metric-cell-state';
import { monetaryCellView, runwayCellView } from './metric-view-model';

const CHAIN_ID = '9f1c2c2e-0f4b-4b9e-9d33-6f4a1b2c3d4e';
const AS_OF = '2026-08-02T14:05:07.412Z';
const INGESTED_AT = '2026-08-02T13:59:59.999Z';

/** A loader that never settles, so a static render shows the initial state. */
const pending =
  <C,>(): ((signal: AbortSignal) => Promise<C>) =>
  () =>
    new Promise<C>(() => {
      /* never settles */
    });

const OPEN_EVIDENCE = (_chainId: string): void => {
  /* EvidencePanel owner supplies navigation in production. */
};

const NEVER_SETTLES: ControlTowerMetricSource = {
  cash: pending<MetricCell>(),
  revenue_30d: pending<MetricCell>(),
  pending_settlement: pending<MetricCell>(),
  runway: pending<RunwayCell>(),
};

describe('MetricStrip first paint', () => {
  const html = renderToStaticMarkup(
    <MetricStrip source={NEVER_SETTLES} onOpenEvidence={OPEN_EVIDENCE} />,
  );

  it('is a named region holding a list of four cells in design.md order', () => {
    expect(html).toContain('data-control-tower="metric-strip"');
    expect(html).toContain('Financial position');
    expect(html.match(/<li>/g)).toHaveLength(4);
    expect([...html.matchAll(/data-metric="([a-z_0-9]+)"/g)].map((m) => m[1])).toEqual([
      'cash',
      'revenue_30d',
      'pending_settlement',
      'runway',
    ]);
  });

  it('starts every cell at processing with aria-busy, and no figure anywhere', () => {
    // Requirement 3.8. The tool never returns `processing`; this is the UI's own state.
    expect(html.match(/data-state="processing"/g)).toHaveLength(4);
    expect(html.match(/aria-busy="true"/g)).toHaveLength(4);
    expect(html).not.toContain('₹');
    expect(html).not.toContain('<data');
  });

  it('names each cell with its own heading rather than one heading for the strip', () => {
    expect(html.match(/aria-labelledby=/g)).toHaveLength(5); // 4 cells + the section
    expect(html).toContain('Pending Settlement');
    expect(html).toContain('Revenue (trailing 30 days)');
  });
});

describe('MetricStripSnapshot renders four independent states at once', () => {
  const cells: GetControlTowerMetricsOutput = {
    cash: {
      state: 'ready',
      value_paise: 1_50_000_00n,
      evidence_chain_id: CHAIN_ID,
      evidence_as_of: AS_OF,
      last_ingested_at: INGESTED_AT,
    },
    revenue_30d: { state: 'failed', failure_kind: 'timeout' },
    pending_settlement: { state: 'unavailable', reason: 'no_contributing_source_records' },
    runway: { state: 'unavailable', reason: 'exceeds_maximum_months' },
  };
  const html = renderToStaticMarkup(
    <MetricStripSnapshot cells={cells} onOpenEvidence={OPEN_EVIDENCE} />,
  );

  it('renders the ready figure as a control with its chain identifier and as-of', () => {
    // Requirements 12.4 and 12.5: the primary and secondary rendering are one
    // keyboard-operable control for the same persisted figure.
    expect(html).toContain('<button type="button" data-figure-control');
    expect(html).toContain(`data-evidence-chain-id="${CHAIN_ID}"`);
    expect(html).toContain(`Evidence chain <code>${CHAIN_ID}</code>`);
    expect(html).toContain('as of');
    expect(html).toContain('2026-08-02 19:35:07 IST');
  });

  it('renders the ready figure with its lakh secondary line and machine paise', () => {
    // Requirement 3.2, 3.3
    expect(html).toContain('₹1,50,000.00');
    expect(html).toContain('data-secondary-unit="lakh"');
    expect(html).toContain('₹1.50 L');
    expect(html).toContain('<data value="15000000">');
  });

  it('renders the contributing ingestion timestamp as a machine-readable IST time', () => {
    // Requirement 3.10. The attribute name is matched case-insensitively: React's static
    // renderer emits `dateTime` verbatim and HTML attribute names are ASCII
    // case-insensitive, so the browser reads it as `datetime` either way.
    expect(html).toMatch(/<time datetime="2026-08-02T19:29:59\+05:30">/i);
    expect(html).toContain('2026-08-02 19:29:59 IST');
  });

  it('shows a failure beside three other cells, in words rather than by colour', () => {
    // Requirement 3.9: the remaining metrics still render.
    expect(html).toContain('data-state="failed"');
    expect(html).toContain('Timed out');
    expect(html).toContain('data-state="ready"');
    expect(html.match(/data-state="unavailable"/g)).toHaveLength(2);
  });

  it('renders no Runway number for the exceeds-maximum state', () => {
    // Requirement 3.12
    expect(html).toContain('Exceeds 120.0 months');
    expect(html).not.toContain('months</data>');
  });

  it('omits the retry control when no handler is supplied', () => {
    expect(html).not.toContain('data-metric-retry');
  });
});

describe('MetricCellDisplay', () => {
  it('renders a keyboard-operable retry button naming its metric', () => {
    // Requirement 3.9, and Requirement 3.13's "controls operable".
    const html = renderToStaticMarkup(
      <MetricCellDisplay
        view={monetaryCellView('cash', { state: 'failed', failure_kind: 'error' })}
        onOpenEvidence={OPEN_EVIDENCE}
        onRetry={() => {
          /* task 14.5 */
        }}
      />,
    );
    expect(html).toContain('<button type="button" data-metric-retry');
    expect(html).toContain('Retry');
    expect(html).toContain('the Cash metric');
    expect(html).toContain('Computation error');
  });

  it('carries a polite live region in every state, so processing to ready is announced', () => {
    const processing = renderToStaticMarkup(
      <MetricCellDisplay
        view={monetaryCellView('cash', { state: 'processing' })}
        onOpenEvidence={OPEN_EVIDENCE}
      />,
    );
    const ready = renderToStaticMarkup(
      <MetricCellDisplay
        view={monetaryCellView('cash', {
          state: 'ready',
          value_paise: 1_50_000_00n,
          evidence_chain_id: CHAIN_ID,
          evidence_as_of: AS_OF,
        })}
        onOpenEvidence={OPEN_EVIDENCE}
      />,
    );

    expect(processing).toContain('aria-live="polite"');
    expect(ready).toContain('aria-live="polite"');
    expect(processing).toContain('Cash: processing');
    expect(ready).toContain('Cash ₹1,50,000.00 (₹1.50 L)');
  });

  it('renders Runway to 1 decimal place, never through formatInr', () => {
    // Requirement 3.4
    const html = renderToStaticMarkup(
      <MetricCellDisplay
        view={runwayCellView({
          state: 'ready',
          runway_months: 18.4,
          runway_basis: 'computed',
          evidence_chain_id: CHAIN_ID,
          evidence_as_of: AS_OF,
        })}
        onOpenEvidence={OPEN_EVIDENCE}
      />,
    );
    expect(html).toContain('<data value="18.4">18.4 months</data>');
    expect(html).not.toContain('₹');
  });
});


describe('EmptyIngestionMetricStrip', () => {
  it('identifies incomplete ingestion, displays no monetary values, and preserves controls', () => {
    // Validates: Requirements 3.7
    const html = renderToStaticMarkup(
      <EmptyIngestionMetricStrip
        onOpenEvidence={OPEN_EVIDENCE}
        controls={<button type="button">Start ingestion</button>}
      />,
    );

    expect(html).toContain('data-control-tower-empty="ingestion-incomplete"');
    expect(html).toContain('Ingestion has not completed');
    expect(html).toContain('No Razorpay objects have been ingested');
    expect(html).not.toContain('₹');
    expect(html).not.toContain('<data');
    expect(html).not.toContain('data-figure-control');
    expect(html).toContain('<button type="button">Start ingestion</button>');
    expect(html).not.toContain('disabled');
  });
});


describe('Control Tower monetary band boundaries', () => {
  const ready = (valuePaise: bigint): MetricCell => ({
    state: 'ready',
    value_paise: valuePaise,
    evidence_chain_id: CHAIN_ID,
    evidence_as_of: AS_OF,
  });

  it.each([
    [99_999_99n, '₹99,999.99', null, null],
    [1_00_000_00n, '₹1,00,000.00', 'lakh', '₹1.00 L'],
    [99_99_999_99n, '₹99,99,999.99', 'lakh', '₹100.00 L'],
    [1_00_00_000_00n, '₹1,00,00,000.00', 'crore', '₹1.00 Cr'],
  ])(
    'renders %s paise in Indian_Number_Format with the correct secondary band',
    (valuePaise, primary, unit, secondary) => {
      // Validates: Requirements 3.2, 3.3, 3.11
      const boundaryHtml = renderToStaticMarkup(
        <MetricCellDisplay
          view={monetaryCellView('cash', ready(valuePaise))}
          onOpenEvidence={OPEN_EVIDENCE}
        />,
      );

      expect(boundaryHtml).toContain(primary);
      expect(boundaryHtml).toContain(`<data value="${valuePaise.toString()}">`);
      if (unit === null) {
        expect(boundaryHtml).not.toContain('data-secondary-unit');
      } else {
        expect(boundaryHtml).toContain(`data-secondary-unit="${unit}"`);
        expect(boundaryHtml).toContain(secondary);
      }
    },
  );
});

describe('MetricCellDisplay complete non-ready state coverage', () => {
  it.each([
    [
      'processing',
      monetaryCellView('cash', { state: 'processing' }),
      'Processing',
      'true',
      false,
    ],
    [
      'computation failure',
      monetaryCellView('cash', { state: 'failed', failure_kind: 'error' }),
      'Computation error',
      'false',
      true,
    ],
    [
      'timeout failure',
      monetaryCellView('cash', { state: 'failed', failure_kind: 'timeout' }),
      'Timed out',
      'false',
      true,
    ],
    [
      'empty metric window',
      monetaryCellView('cash', {
        state: 'unavailable',
        reason: 'no_contributing_source_records',
        last_ingested_at: INGESTED_AT,
      }),
      'No contributing records',
      'false',
      false,
    ],
    [
      'incomplete evidence',
      monetaryCellView('cash', {
        state: 'incomplete_evidence',
        unavailable: [{ type: 'payment', count: 2 }],
      }),
      'Evidence incomplete',
      'false',
      false,
    ],
  ])('renders the %s state without a stale figure', (_name, view, text, busy, retryable) => {
    // Validates: Requirements 3.7, 3.8, 3.9
    const stateHtml = renderToStaticMarkup(
      <MetricCellDisplay
        view={view}
        onOpenEvidence={OPEN_EVIDENCE}
        onRetry={retryable ? () => undefined : undefined}
      />,
    );

    expect(stateHtml).toContain(text);
    expect(stateHtml).toContain(`aria-busy="${busy}"`);
    expect(stateHtml).not.toContain('data-metric-figure');
    expect(stateHtml).not.toContain('data-figure-control');
    expect(stateHtml.includes('data-metric-retry')).toBe(retryable);
  });

  it.each([
    [{ state: 'processing' } as const, 'Processing', false],
    [{ state: 'failed', failure_kind: 'error' } as const, 'Computation error', true],
    [{ state: 'failed', failure_kind: 'timeout' } as const, 'Timed out', true],
    [{ state: 'unavailable', reason: 'not_yet_available' } as const, 'Not yet available', false],
    [{ state: 'unavailable', reason: 'not_applicable_non_positive_burn' } as const, 'Not applicable', false],
    [{ state: 'unavailable', reason: 'exceeds_maximum_months' } as const, 'Exceeds 120.0 months', false],
  ])('renders Runway state %j without a numeric value', (cell, text, retryable) => {
    // Validates: Requirements 3.8, 3.9
    const stateHtml = renderToStaticMarkup(
      <MetricCellDisplay
        view={runwayCellView(cell)}
        onOpenEvidence={OPEN_EVIDENCE}
        onRetry={retryable ? () => undefined : undefined}
      />,
    );

    expect(stateHtml).toContain(text);
    expect(stateHtml).not.toContain('data-metric-figure');
    expect(stateHtml).not.toContain('<data');
    expect(stateHtml.includes('data-metric-retry')).toBe(retryable);
  });
});