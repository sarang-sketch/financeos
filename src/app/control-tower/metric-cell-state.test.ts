/**
 * Unit tests for one metric cell's async state and deadline (tasks 14.1, 14.5).
 * Requirements 3.8, 3.9.
 *
 * Stage 3, `unit` project: the reducer, failure classifier and deadline runner are tested
 * without a DOM. What needs a DOM — that the effect in `useMetricCellState` calls the
 * loader and that a click on the retry control dispatches `retry_requested` — remains in
 * task 14.6's interaction coverage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MetricCell, RunwayCell } from '@/tools/control-tower-metrics-cells';

import {
  classifyLoadFailure,
  initialMetricCellState,
  loadMetricWithDeadline,
  METRIC_LOAD_TIMEOUT_MS,
  MetricLoadTimeoutError,
  metricCellReducer,
  PROCESSING_CELL,
} from './metric-cell-state';

describe('initialMetricCellState — Requirement 3.8', () => {
  it('starts a cell at processing, which the tool itself never returns', () => {
    const state = initialMetricCellState<MetricCell>();
    expect(state.cell).toEqual({ state: 'processing' });
    expect(state.attempt).toBe(0);
  });

  it('is the same starting state for Runway, which is not money', () => {
    expect(initialMetricCellState<RunwayCell>().cell).toBe(PROCESSING_CELL);
  });
});

describe('metricCellReducer', () => {
  it('takes whatever the load answered as the cell, including a failed one', () => {
    // The tool returns `failed` with `failure_kind: 'timeout'` for a cell that ran past
    // its budget; that is a settled load, not a load failure.
    const settled = metricCellReducer<MetricCell>(initialMetricCellState<MetricCell>(), {
      kind: 'load_settled',
      cell: { state: 'failed', failure_kind: 'timeout' },
    });
    expect(settled.cell).toEqual({ state: 'failed', failure_kind: 'timeout' });
    expect(settled.attempt).toBe(0);
  });

  it('turns a rejected load into a failed cell of the classified kind', () => {
    // Requirement 3.9
    const state = initialMetricCellState<MetricCell>();
    expect(
      metricCellReducer(state, { kind: 'load_failed', failureKind: 'error' }).cell,
    ).toEqual({ state: 'failed', failure_kind: 'error' });
    expect(
      metricCellReducer(state, { kind: 'load_failed', failureKind: 'timeout' }).cell,
    ).toEqual({ state: 'failed', failure_kind: 'timeout' });
  });

  it('returns to processing and bumps the attempt on retry', () => {
    const failed = metricCellReducer<MetricCell>(initialMetricCellState<MetricCell>(), {
      kind: 'load_failed',
      failureKind: 'error',
    });
    const retried = metricCellReducer(failed, { kind: 'retry_requested' });

    expect(retried.cell).toEqual({ state: 'processing' });
    expect(retried.attempt).toBe(1);
    expect(metricCellReducer(retried, { kind: 'retry_requested' }).attempt).toBe(2);
  });

  it('never carries a figure forward past a retry or a failure', () => {
    const ready: MetricCell = {
      state: 'ready',
      value_paise: 1_50_000_00n,
      evidence_chain_id: '9f1c2c2e-0f4b-4b9e-9d33-6f4a1b2c3d4e',
      evidence_as_of: '2026-08-02T14:05:07.412Z',
    };
    const settled = metricCellReducer<MetricCell>(initialMetricCellState<MetricCell>(), {
      kind: 'load_settled',
      cell: ready,
    });

    for (const next of [
      metricCellReducer(settled, { kind: 'retry_requested' }),
      metricCellReducer(settled, { kind: 'load_failed', failureKind: 'error' }),
    ]) {
      expect(next.cell).not.toHaveProperty('value_paise');
      expect(next.cell).not.toHaveProperty('evidence_chain_id');
    }
  });

  it('does not mutate the state it is given', () => {
    const state = initialMetricCellState<MetricCell>();
    metricCellReducer(state, { kind: 'retry_requested' });
    expect(state).toEqual({ cell: { state: 'processing' }, attempt: 0 });
  });
});

describe('classifyLoadFailure — Requirement 3.9 distinguishes the two causes', () => {
  it('reports a timeout for MetricLoadTimeoutError', () => {
    expect(classifyLoadFailure(new MetricLoadTimeoutError('30 s elapsed'))).toBe('timeout');
  });

  it('reports a timeout for the platform TimeoutError AbortSignal.timeout raises', () => {
    const signal = AbortSignal.timeout(0);
    // The reason is only populated once the signal aborts; construct the equivalent.
    const platform = new DOMException('The operation timed out.', 'TimeoutError');
    expect(classifyLoadFailure(platform)).toBe('timeout');
    expect(signal.aborted).toBe(false);
  });

  it('reports an error for everything else, including an ordinary abort', () => {
    expect(classifyLoadFailure(new Error('boom'))).toBe('error');
    expect(classifyLoadFailure(new DOMException('aborted', 'AbortError'))).toBe('error');
    expect(classifyLoadFailure('a string')).toBe('error');
    expect(classifyLoadFailure(undefined)).toBe('error');
  });
});

describe('loadMetricWithDeadline — Requirement 3.9', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a 30-second per-attempt bound and aborts only the timed-out loader', async () => {
    const outer = new AbortController();
    let loaderSignal: AbortSignal | undefined;
    const load = (signal: AbortSignal): Promise<MetricCell> => {
      loaderSignal = signal;
      return new Promise<MetricCell>(() => {
        /* deliberately ignores settlement; abort is observed through loaderSignal */
      });
    };

    const result = loadMetricWithDeadline(load, outer.signal);
    const rejected = expect(result).rejects.toBeInstanceOf(MetricLoadTimeoutError);

    await vi.advanceTimersByTimeAsync(METRIC_LOAD_TIMEOUT_MS - 1);
    expect(loaderSignal?.aborted).toBe(false);
    expect(outer.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(loaderSignal?.aborted).toBe(true);
    expect(loaderSignal?.reason).toBeInstanceOf(MetricLoadTimeoutError);
    expect(outer.signal.aborted).toBe(false);
  });

  it('returns a grounded successful cell unchanged and clears its deadline', async () => {
    const ready: MetricCell = {
      state: 'ready',
      value_paise: 1_50_000_00n,
      evidence_chain_id: '9f1c2c2e-0f4b-4b9e-9d33-6f4a1b2c3d4e',
      evidence_as_of: '2026-08-02T14:05:07.412Z',
    };

    await expect(
      loadMetricWithDeadline(() => Promise.resolve(ready), new AbortController().signal),
    ).resolves.toBe(ready);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a computation rejection so it is classified as an error, not a timeout', async () => {
    const failure = new Error('store failed');
    const result = loadMetricWithDeadline(
      () => Promise.reject(failure),
      new AbortController().signal,
    );

    await expect(result).rejects.toBe(failure);
    expect(classifyLoadFailure(failure)).toBe('error');
    expect(vi.getTimerCount()).toBe(0);
  });
});