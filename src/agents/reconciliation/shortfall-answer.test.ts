/**
 * Task 13.4 through the two real settlement Financial_Tools and their in-memory
 * persistence seams. No monetary result is fabricated by the answer layer.
 *
 * Validates: Requirements 4.6, 4.7
 */

import { describe, expect, it } from 'vitest';

import { createEvidenceChainBuilder } from '@/evidence/chain-builder';
import {
  createGetSettlementDifferenceBreakdown,
  type GetSettlementDifferenceBreakdownOutput,
} from '@/tools/get-settlement-difference-breakdown';
import {
  createGetSettlementReconciliation,
  type GetSettlementReconciliationOutput,
} from '@/tools/get-settlement-reconciliation';
import type {
  ScopedSettlement,
  SettlementScopeQuery,
  SettlementScopeResult,
  SettlementScopeStore,
} from '@/tools/settlement-scope';
import {
  createToolInvoker,
  type ToolConnection,
  type ToolConnections,
  type ToolDbClient,
  type ToolResult,
  type ToolSession,
} from '@/tools/tool';

import {
  createMemoryEvidenceStore,
  type MemoryEvidenceStore,
} from '../../../test/property/evidence-chain-memory-store';
import {
  createShortfallAnswer,
  type ShortfallAnswerService,
} from './shortfall-answer';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SESSION: ToolSession = {
  tenant_id: TENANT,
  user_id: 'usr_shortfall_answer',
  permissions: ['view_financial_data', 'run_agents'],
};
const NOW = '2026-07-30T09:00:00.000Z';
const AS_OF = '2026-07-15T00:00:00.000Z';
function settlement(id: string, difference: bigint): ScopedSettlement {
  const received = 1_000_000n;
  return {
    settlement_id: id,
    settlement_date: '2026-07-15',
    received_paise: received,
    record_updated_at: AS_OF,
    recon_report_id: `setlrcn_${id.slice(5)}`,
    payments: [
      {
        line_id: `pay_${id.slice(5)}`,
        record_updated_at: AS_OF,
        amount_paise: received + difference,
        fee_paise: 0n,
        gst_on_fee_paise: 0n,
      },
    ],
    refunds: [],
    chargebacks: [],
    adjustments: [],
  };
}

function unreachableDb(): ToolDbClient {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`answer path reached ctx.db.${String(property)}`);
      },
    },
  ) as ToolDbClient;
}

function connections(): ToolConnections {
  return {
    acquire(mode): Promise<ToolConnection> {
      return Promise.resolve({
        db: unreachableDb(),
        mode,
        release: () => Promise.resolve(),
      });
    },
  };
}

interface Harness {
  readonly answer: ShortfallAnswerService;
  readonly chains: MemoryEvidenceStore;
  readonly queries: SettlementScopeQuery[];
  readonly breakdownCalls: { count: number };
}
function harness(
  settlements: readonly ScopedSettlement[],
  counts = { ledger_entries_examined: 0, razorpay_invoices_examined: 0 },
): Harness {
  const chains = createMemoryEvidenceStore();
  const queries: SettlementScopeQuery[] = [];
  const scopeStore: SettlementScopeStore = {
    listInScope(query): Promise<SettlementScopeResult> {
      queries.push(query);
      return Promise.resolve({
        settlements: query.tenant_id === TENANT ? settlements : [],
        ...counts,
      });
    },
  };
  const toolDeps = { settlements: () => scopeStore, chains: () => chains };
  const reconciliation = createGetSettlementReconciliation(toolDeps);
  const breakdown = createGetSettlementDifferenceBreakdown(toolDeps);
  const invoker = createToolInvoker({
    connections: connections(),
    audit: { append: () => Promise.resolve() },
    actor: { kind: 'agent', id: 'reconciliation_agent' },
    now: () => new Date(NOW),
  });
  const breakdownCalls = { count: 0 };

  return {
    chains,
    queries,
    breakdownCalls,
    answer: createShortfallAnswer({
      now: () => new Date(NOW),
      getSettlementReconciliation: (input): Promise<ToolResult<GetSettlementReconciliationOutput>> =>
        invoker.invoke(reconciliation, SESSION, input),
      getSettlementDifferenceBreakdown: (
        input,
      ): Promise<ToolResult<GetSettlementDifferenceBreakdownOutput>> => {
        breakdownCalls.count += 1;
        return invoker.invoke(breakdown, SESSION, input);
      },
    }),
  };
}

const EXCESS = settlement('setl_EXCESS01', -500_000n);
const SHORTFALL = settlement('setl_SHORT001', 300_000n);

describe('shortfall answer composition', () => {
  it('reports the default scope and counts while keeping missing and residual distinct', async () => {
    const h = harness([SHORTFALL, EXCESS], {
      ledger_entries_examined: 7,
      razorpay_invoices_examined: 3,
    });
    const result = await h.answer.answer();
    if (!result.ok) throw new Error(`expected an answer, got ${result.kind}`);

    expect(result.value.scope).toEqual({ from: '2026-05-02', to: '2026-07-30' });
    expect(result.value.examined).toEqual({
      payments_examined: 2,
      settlements_examined: 2,
      refunds_examined: 0,
      ledger_entries_examined: 7,
      razorpay_invoices_examined: 3,
    });
    // Only the positive Difference is missing. The larger excess does not net it.
    expect(result.value.total_missing_paise).toBe(300_000n);
    expect(result.value.unexplained_residual_nonzero_count).toBe(2);

    const settlementRows = result.value.rows.filter((row) => row.kind === 'settlement');
    expect(settlementRows.map((row) => row.settlement_id)).toEqual([
      EXCESS.settlement_id,
      SHORTFALL.settlement_id,
    ]);
    expect(settlementRows.map((row) => row.difference_paise)).toEqual([-500_000n, 300_000n]);
    expect(settlementRows.map((row) => row.residual_paise)).toEqual([-500_000n, 300_000n]);

    const remainder = result.value.rows.at(-1);
    expect(remainder).toMatchObject({
      kind: 'remainder',
      count: 0,
      total_absolute_difference_paise: 0n,
    });

    // Both tools receive the exact same resolved range; T2 is fixed at limit 50.
    expect(h.queries).toEqual([
      {
        tenant_id: TENANT,
        scope: { from: '2026-05-02', to: '2026-07-30' },
        settlement_ids: null,
      },
      {
        tenant_id: TENANT,
        scope: { from: '2026-05-02', to: '2026-07-30' },
        settlement_ids: null,
      },
    ]);

    const evidence = createEvidenceChainBuilder({ store: h.chains, tenantId: TENANT });
    expect(
      (await evidence.read(result.value.total_missing_evidence.evidence_chain_id))?.figure_paise,
    ).toBe(result.value.total_missing_paise);
    for (const row of result.value.rows) {
      const chain = await evidence.read(row.evidence_chain_id);
      expect(chain).not.toBeNull();
      if (row.kind === 'settlement') {
        expect(chain?.steps[6]?.result_paise).toBe(row.expected_paise);
        expect(chain?.steps[7]?.result_paise).toBe(row.difference_paise);
        expect(chain?.steps[8]?.result_paise).toBe(row.fee_component_paise);
        expect(chain?.steps[9]?.result_paise).toBe(row.gst_component_paise);
        expect(chain?.steps[11]?.result_paise).toBe(row.residual_paise);
      } else {
        expect(chain?.figure_paise).toBe(row.total_absolute_difference_paise);
      }
    }
  });
  it('returns exactly 50 largest rows plus one non-netting aggregate remainder row', async () => {
    const settlements = Array.from({ length: 52 }, (_, index) => {
      const ordinal = index + 1;
      return settlement(`setl_${String(ordinal).padStart(4, '0')}`, BigInt(ordinal * 1_000));
    });
    const h = harness(settlements);
    const result = await h.answer.answer({ from: '2026-07-01', to: '2026-07-31' });
    if (!result.ok) throw new Error(`expected an answer, got ${result.kind}`);

    expect(result.value.rows).toHaveLength(51);
    const shown = result.value.rows.slice(0, 50);
    expect(shown.every((row) => row.kind === 'settlement')).toBe(true);
    expect(shown[0]).toMatchObject({ settlement_id: 'setl_0052', difference_paise: 52_000n });
    expect(shown.at(-1)).toMatchObject({
      settlement_id: 'setl_0003',
      difference_paise: 3_000n,
    });
    expect(result.value.rows.at(-1)).toMatchObject({
      kind: 'remainder',
      count: 2,
      // |2000| + |1000|, produced by T2's evidence-backed aggregate.
      total_absolute_difference_paise: 3_000n,
    });

    const remainder = result.value.rows.at(-1);
    if (remainder?.kind !== 'remainder') throw new Error('missing aggregate remainder');
    const evidence = createEvidenceChainBuilder({ store: h.chains, tenantId: TENANT });
    expect((await evidence.read(remainder.evidence_chain_id))?.figure_paise).toBe(3_000n);
  });

  it('returns no partial figures when T1 reports incomplete evidence', async () => {
    const hidden: ScopedSettlement = {
      ...SHORTFALL,
      unreadable: [{ type: 'settlement_recon_report', id: 'pay_hidden' }],
    };
    const h = harness([hidden, EXCESS]);
    const result = await h.answer.answer({ from: '2026-07-01', to: '2026-07-31' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected incomplete evidence');
    expect(result.kind).toBe('incomplete_evidence');
    expect('value' in result).toBe(false);
    expect(h.breakdownCalls.count).toBe(0);
    expect(h.chains.chainCount).toBe(0);
  });
});
