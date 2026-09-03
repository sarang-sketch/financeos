import { describe, expect, it } from 'vitest';

import { createEvidenceChainBuilder, type SourceRef } from '@/evidence/chain-builder';

import {
  createMemoryEvidenceStore,
  type MemoryEvidenceStore,
} from '../../test/property/evidence-chain-memory-store';
import type {
  CashMetricQuery,
  CashMetricRead,
  CashMetricSource,
  MetricAmountRecord,
  PendingSettlementMetricQuery,
  PendingSettlementMetricRead,
  PendingSettlementMetricSource,
  Revenue30dMetricQuery,
  Revenue30dMetricRead,
  Revenue30dMetricSource,
} from './control-tower-metrics';
import {
  assertCellBudgetMs,
  METRIC_CELL_BUDGET_MS,
  MetricCellError,
} from './control-tower-metrics-cells';
import {
  catalogueEntryFor,
  createGetControlTowerMetrics,
  GET_CONTROL_TOWER_METRICS,
  type GetControlTowerMetricsDeps,
  type GetControlTowerMetricsOutput,
  metricCellSchema,
  runwayCellSchema,
} from './get-control-tower-metrics';
import { createToolRegistry } from './registry';
import {
  createToolInvoker,
  type ToolConnection,
  type ToolConnections,
  type ToolDbClient,
  type ToolMode,
  type ToolResult,
  type ToolSession,
} from './tool';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-08-01T20:00:00.000Z'); // 2026-08-02 in IST
const INGESTED = '2026-08-01T18:00:00.000Z';
const UPDATED = '2026-08-01T17:30:00.000Z';

const SESSION: ToolSession = {
  tenant_id: TENANT,
  user_id: 'usr_metrics',
  permissions: ['view_financial_data'],
};

function record(type: SourceRef['type'], id: string, amount_paise: bigint): MetricAmountRecord {
  return {
    ref: { type, id },
    field: type === 'ledger_entry_set' ? 'line_2.amount_paise' : 'amount',
    amount_paise,
    record_updated_at: UPDATED,
    last_ingested_at: INGESTED,
  };
}

const CASH: CashMetricRead = {
  settlements: [record('settlement', 'setl_cash_1', 100_000n)],
  recorded_outflows: [record('ledger_entry_set', '10000000-0000-4000-8000-000000000001', 20_000n)],
};
const REVENUE: Revenue30dMetricRead = {
  captured_payments: [
    record('payment', 'pay_revenue_1', 60_000n),
    record('payment', 'pay_revenue_2', 40_000n),
  ],
  refunds: [record('refund', 'rfnd_revenue_1', 10_000n)],
};
const PENDING: PendingSettlementMetricRead = {
  captured_unlinked_payments: [record('payment', 'pay_pending_1', 30_000n)],
};

function unreachableDb(): ToolDbClient {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`metrics tool touched ctx.db.${String(property)}`);
      },
    },
  ) as ToolDbClient;
}

interface RecordedConnections {
  readonly acquired: ToolMode[];
  readonly released: ('commit' | 'rollback')[];
  readonly connections: ToolConnections;
}

function connections(): RecordedConnections {
  const acquired: ToolMode[] = [];
  const released: ('commit' | 'rollback')[] = [];
  return {
    acquired,
    released,
    connections: {
      acquire(mode: ToolMode): Promise<ToolConnection> {
        acquired.push(mode);
        return Promise.resolve({
          mode,
          db: unreachableDb(),
          release(disposition): Promise<void> {
            released.push(disposition);
            return Promise.resolve();
          },
        });
      },
    },
  };
}

interface HarnessOptions {
  readonly cash?: CashMetricSource;
  readonly revenue?: Revenue30dMetricSource;
  readonly pending?: PendingSettlementMetricSource;
  readonly cellBudgetMs?: number;
}

interface Harness {
  readonly chains: MemoryEvidenceStore;
  readonly recorded: RecordedConnections;
  readonly cashQueries: CashMetricQuery[];
  readonly revenueQueries: Revenue30dMetricQuery[];
  readonly pendingQueries: PendingSettlementMetricQuery[];
  readonly deps: GetControlTowerMetricsDeps;
  invoke(input: unknown, session?: ToolSession): Promise<ToolResult<GetControlTowerMetricsOutput>>;
}

function harness(options: HarnessOptions = {}): Harness {
  const chains = createMemoryEvidenceStore();
  const recorded = connections();
  const cashQueries: CashMetricQuery[] = [];
  const revenueQueries: Revenue30dMetricQuery[] = [];
  const pendingQueries: PendingSettlementMetricQuery[] = [];

  const cash: CashMetricSource = options.cash ?? {
    read(query): Promise<CashMetricRead> {
      cashQueries.push(query);
      return Promise.resolve(CASH);
    },
  };
  const revenue: Revenue30dMetricSource = options.revenue ?? {
    read(query): Promise<Revenue30dMetricRead> {
      revenueQueries.push(query);
      return Promise.resolve(REVENUE);
    },
  };
  const pending: PendingSettlementMetricSource = options.pending ?? {
    read(query): Promise<PendingSettlementMetricRead> {
      pendingQueries.push(query);
      return Promise.resolve(PENDING);
    },
  };

  const deps: GetControlTowerMetricsDeps = {
    cash: () => cash,
    revenue30d: () => revenue,
    pendingSettlement: () => pending,
    chains: () => chains,
    now: () => NOW,
    cellBudgetMs: options.cellBudgetMs,
  };
  const invoker = createToolInvoker({
    connections: recorded.connections,
    audit: { append: () => Promise.resolve() },
    actor: { kind: 'agent', id: 'reconciliation_agent' },
    now: () => NOW,
  });
  const tool = createGetControlTowerMetrics(deps);
  return {
    chains,
    recorded,
    cashQueries,
    revenueQueries,
    pendingQueries,
    deps,
    invoke: (input, session = SESSION) => invoker.invoke(tool, session, input),
  };
}

function valueOf(result: ToolResult<GetControlTowerMetricsOutput>): GetControlTowerMetricsOutput {
  if (!result.ok) throw new Error(`expected metrics, got ${result.kind}`);
  return result.value;
}

describe('get_control_tower_metrics contract and formulas', () => {
  it('registers strict empty input in read-only mode', () => {
    const test = harness();
    const tool = createGetControlTowerMetrics(test.deps);
    expect(tool.name).toBe(GET_CONTROL_TOWER_METRICS);
    expect(tool.mode).toBe('read_only');
    expect(tool.timeoutMs).toBe(10_000);
    expect(createToolRegistry([catalogueEntryFor(test.deps)]).names()).toEqual([
      GET_CONTROL_TOWER_METRICS,
    ]);
  });

  it('computes the three authoritative monetary definitions in integer paise', async () => {
    const test = harness();
    const value = valueOf(await test.invoke({}));
    expect(value.cash).toMatchObject({ state: 'ready', value_paise: 80_000n });
    expect(value.revenue_30d).toMatchObject({ state: 'ready', value_paise: 90_000n });
    expect(value.pending_settlement).toMatchObject({ state: 'ready', value_paise: 30_000n });
    expect(value.runway).toEqual({ state: 'unavailable', reason: 'not_yet_available' });

    expect(test.cashQueries).toEqual([{ tenant_id: TENANT, as_of: '2026-08-02' }]);
    expect(test.revenueQueries).toEqual([
      { tenant_id: TENANT, range: { from: '2026-07-04', to: '2026-08-02' } },
    ]);
    expect(test.pendingQueries).toEqual([{ tenant_id: TENANT, as_of: '2026-08-02' }]);
    expect(test.recorded.acquired).toEqual(['read_only']);
    expect(test.recorded.released).toEqual(['commit']);
  });

  it('gives every ready cell its own resolvable chain and ingestion timestamp', async () => {
    const test = harness();
    const result = await test.invoke({});
    const value = valueOf(result);
    const builder = createEvidenceChainBuilder({ store: test.chains, tenantId: TENANT });

    for (const cell of [value.cash, value.revenue_30d, value.pending_settlement]) {
      expect(cell.state).toBe('ready');
      if (cell.state !== 'ready') continue;
      expect(cell.last_ingested_at).toBe(INGESTED);
      const chain = await builder.read(cell.evidence_chain_id);
      expect(chain?.figure_paise).toBe(cell.value_paise);
      expect(chain?.as_of).toBe(cell.evidence_as_of);
    }
    if (result.ok) {
      expect(result.evidence.evidence_chain_id).toBe(
        value.cash.state === 'ready' ? value.cash.evidence_chain_id : '',
      );
    }
    expect(test.chains.chainCount).toBe(3);
  });

  it('uses discriminated shapes that forbid stale values on processing or failed cells', () => {
    expect(metricCellSchema.safeParse({ state: 'failed', failure_kind: 'error' }).success).toBe(true);
    expect(
      metricCellSchema.safeParse({ state: 'failed', failure_kind: 'error', value_paise: 1n }).success,
    ).toBe(false);
    expect(metricCellSchema.safeParse({ state: 'processing', value_paise: 1n }).success).toBe(false);
    expect(metricCellSchema.safeParse({ state: 'ready', value_paise: 1n }).success).toBe(false);
  });

  it('rejects every argument, tenant_id included, before opening a connection', async () => {
    const test = harness();
    const result = await test.invoke({ tenant_id: OTHER_TENANT });
    expect(result.ok).toBe(false);
    if (result.ok || result.kind !== 'schema_violation') throw new Error('expected a violation');
    expect(result.violations.map((violation) => violation.argument)).toEqual(['tenant_id']);
    expect(test.recorded.acquired).toEqual([]);
    expect(test.cashQueries).toEqual([]);
  });

  it('scopes every read to the session Tenant, never to an argument', async () => {
    const test = harness();
    valueOf(await test.invoke({}, { ...SESSION, tenant_id: OTHER_TENANT }));
    expect(test.cashQueries.map((query) => query.tenant_id)).toEqual([OTHER_TENANT]);
    expect(test.revenueQueries.map((query) => query.tenant_id)).toEqual([OTHER_TENANT]);
    expect(test.pendingQueries.map((query) => query.tenant_id)).toEqual([OTHER_TENANT]);
  });

  it('leaves Runway non-numeric rather than a fabricated zero', async () => {
    const value = valueOf(await harness().invoke({}));
    expect(value.runway).toEqual({ state: 'unavailable', reason: 'not_yet_available' });
    expect(value.runway).not.toHaveProperty('value_paise');
    expect(value.runway).not.toHaveProperty('runway_months');
    expect(runwayCellSchema.safeParse({ state: 'ready', runway_months: 0 }).success).toBe(false);
  });
});

describe('get_control_tower_metrics per-cell independence (Requirement 3.9)', () => {
  it('fails only the erroring cell and renders the other three', async () => {
    const test = harness({
      revenue: {
        read(): Promise<Revenue30dMetricRead> {
          throw new Error('revenue store exploded');
        },
      },
    });
    const value = valueOf(await test.invoke({}));
    expect(value.revenue_30d).toEqual({ state: 'failed', failure_kind: 'error' });
    expect(value.cash).toMatchObject({ state: 'ready', value_paise: 80_000n });
    expect(value.pending_settlement).toMatchObject({ state: 'ready', value_paise: 30_000n });
    expect(value.runway).toMatchObject({ state: 'unavailable' });
    expect(test.recorded.released).toEqual(['commit']);
  });

  it('times out only the slow cell, and aborts that cell alone', async () => {
    let pendingAborted = false;
    const test = harness({
      cellBudgetMs: 25,
      pending: {
        read(_query, signal): Promise<PendingSettlementMetricRead> {
          return new Promise<PendingSettlementMetricRead>(() => {
            signal.addEventListener('abort', () => {
              pendingAborted = true;
            });
          });
        },
      },
    });
    const value = valueOf(await test.invoke({}));
    expect(value.pending_settlement).toEqual({ state: 'failed', failure_kind: 'timeout' });
    expect(pendingAborted).toBe(true);
    expect(value.cash).toMatchObject({ state: 'ready', value_paise: 80_000n });
    expect(value.revenue_30d).toMatchObject({ state: 'ready', value_paise: 90_000n });
  });

  it('withholds one figure for unreadable records and grounds the rest (Requirement 12.3)', async () => {
    const test = harness({
      cash: {
        read(): Promise<CashMetricRead> {
          return Promise.resolve({
            settlements: [],
            recorded_outflows: [],
            unreadable: [
              { type: 'settlement', id: 'setl_gone_1' },
              { type: 'settlement', id: 'setl_gone_2' },
            ],
          });
        },
      },
    });
    const value = valueOf(await test.invoke({}));
    expect(value.cash).toEqual({
      state: 'incomplete_evidence',
      unavailable: [{ type: 'settlement', count: 2 }],
    });
    expect(value.cash).not.toHaveProperty('value_paise');
    expect(value.revenue_30d).toMatchObject({ state: 'ready', value_paise: 90_000n });
    expect(value.pending_settlement).toMatchObject({ state: 'ready', value_paise: 30_000n });
    // Only the two grounded cells wrote a chain.
    expect(test.chains.chainCount).toBe(2);
  });

  it('reports an empty window as unavailable rather than a ready zero', async () => {
    const test = harness({
      revenue: {
        read(): Promise<Revenue30dMetricRead> {
          return Promise.resolve({ captured_payments: [], refunds: [] });
        },
      },
    });
    const value = valueOf(await test.invoke({}));
    expect(value.revenue_30d).toEqual({
      state: 'unavailable',
      reason: 'no_contributing_source_records',
    });
    expect(value.revenue_30d).not.toHaveProperty('value_paise');
    expect(value.cash).toMatchObject({ state: 'ready', value_paise: 80_000n });
  });

  it('refuses the invocation only when no cell can be grounded at all', async () => {
    const test = harness({
      cash: { read: () => Promise.resolve({ settlements: [], recorded_outflows: [] }) },
      revenue: { read: () => Promise.resolve({ captured_payments: [], refunds: [] }) },
      pending: { read: () => Promise.resolve({ captured_unlinked_payments: [] }) },
    });
    const result = await test.invoke({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.kind).toBe('tool_failure');
    expect(test.recorded.released).toEqual(['rollback']);
    expect(test.chains.chainCount).toBe(0);
  });

  it('keeps a per-metric budget strictly below the 10-second tool bound', () => {
    expect(METRIC_CELL_BUDGET_MS).toBeLessThan(10_000);
    expect(() => assertCellBudgetMs(10_000)).toThrow(MetricCellError);
    expect(() => assertCellBudgetMs(0)).toThrow(MetricCellError);
    expect(assertCellBudgetMs(METRIC_CELL_BUDGET_MS)).toBe(METRIC_CELL_BUDGET_MS);
  });
});
