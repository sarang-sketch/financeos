import { describe, expect, it } from 'vitest';

import { createEvidenceChainBuilder, type EvidenceSourceCitation } from '@/evidence/chain-builder';
import { createMemoryEvidenceStore } from '../../test/property/evidence-chain-memory-store';
import {
  catalogueEntryFor,
  createGetUnsettledPayments,
  GET_UNSETTLED_PAYMENTS,
  type ScopedPayment,
  type UnsettledPaymentQuery,
} from './get-unsettled-payments';
import { createToolRegistry } from './registry';
import type { ToolContext, ToolDbClient } from './tool';

const TENANT = '11111111-1111-4111-8111-111111111111';
const UPDATED = '2026-03-01T00:00:00.000Z';
const ctx = (): ToolContext => ({
  tenant_id: TENANT,
  user_id: 'usr_12_4',
  permissions: ['view_financial_data'],
  db: {} as ToolDbClient,
  signal: new AbortController().signal,
});
const payment = (overrides: Partial<ScopedPayment> = {}): ScopedPayment => ({
  payment_id: 'pay_base',
  status_rzp: 'captured',
  created_on: '2026-02-28',
  amount_paise: 100n,
  record_updated_at: UPDATED,
  settlement_candidate_count: 0,
  ...overrides,
});
const examined = (payments: readonly ScopedPayment[]): EvidenceSourceCitation[] =>
  payments.map((p) => ({
    ref: { type: 'payment', id: p.payment_id },
    field: 'amount',
    record_updated_at: p.record_updated_at,
  }));

function harness(payments: readonly ScopedPayment[]) {
  const chains = createMemoryEvidenceStore();
  const queries: UnsettledPaymentQuery[] = [];
  const deps = {
    payments: () => ({
      listCandidates(query: UnsettledPaymentQuery) {
        queries.push(query);
        return Promise.resolve({
          payments: query.tenant_id === TENANT ? payments : [],
          examined: examined(payments),
        });
      },
    }),
    chains: () => chains,
  };
  return { tool: createGetUnsettledPayments(deps), deps, chains, queries };
}

describe('get_unsettled_payments', () => {
  it('registers as a strict bounded read-only catalogue entry', () => {
    const h = harness([]);
    const registry = createToolRegistry([catalogueEntryFor(h.deps)]);
    expect(registry.names()).toEqual([GET_UNSETTLED_PAYMENTS]);
    expect(registry.get(GET_UNSETTLED_PAYMENTS)?.mode).toBe('read_only');
    expect(h.tool.inputSchema.safeParse({ as_of: '2026-02-30', page: { offset: 0, limit: 1 } }).success).toBe(false);
    expect(h.tool.inputSchema.safeParse({ as_of: '2026-03-01', page: { offset: 0, limit: 101 } }).success).toBe(false);
    expect(h.tool.inputSchema.safeParse({ as_of: '2026-03-01', page: { offset: 0, limit: 1 }, tenant_id: TENANT }).success).toBe(false);
  });

  it('returns captured, identifier-unlinked Payments only, ordered before paging with a full total', async () => {
    const records = [
      payment({ payment_id: 'pay_new', created_on: '2026-03-01', amount_paise: 200n }),
      payment({ payment_id: 'pay_old', created_on: '2026-02-27', amount_paise: 300n }),
      payment({ payment_id: 'pay_settled', settlement_candidate_count: 1 }),
      payment({ payment_id: 'pay_ambiguous', settlement_candidate_count: 2 }),
      payment({ payment_id: 'pay_failed', status_rzp: 'failed' }),
    ];
    const h = harness(records);
    const result = await h.tool.execute(ctx(), { as_of: '2026-03-01', page: { offset: 1, limit: 1 } });
    if (!result.ok) throw new Error(`unexpected ${result.kind}`);
    expect(result.value.total).toBe(2);
    expect(result.value.rows).toMatchObject([{ payment_id: 'pay_new', amount_paise: 200n, age_days: 0 }]);
    expect(h.queries).toEqual([{ tenant_id: TENANT, as_of: '2026-03-01' }]);
    expect(result.evidence.figure_paise).toBe(500n);
    const chain = await createEvidenceChainBuilder({ store: h.chains, tenantId: TENANT })
      .read(result.value.rows[0]?.evidence_chain_id ?? '');
    expect(chain?.figure_paise).toBe(200n);
  });

  it('uses calendar dates for nonnegative whole age days', async () => {
    const h = harness([payment({ payment_id: 'pay_age', created_on: '2024-02-28' })]);
    const result = await h.tool.execute(ctx(), { as_of: '2024-03-01', page: { offset: 0, limit: 100 } });
    if (!result.ok) throw new Error(`unexpected ${result.kind}`);
    expect(result.value.rows[0]?.age_days).toBe(2);
  });

  it('omits figures when a contributor is unreadable', async () => {
    const hidden = payment({ unreadable: [{ type: 'settlement', id: 'setl_hidden' }] });
    const h = harness([hidden]);
    const result = await h.tool.execute(ctx(), { as_of: '2026-03-01', page: { offset: 0, limit: 10 } });
    expect(result).toEqual({ ok: false, kind: 'incomplete_evidence', unavailable: [{ type: 'settlement', count: 1 }] });
    expect(h.chains.chainCount).toBe(0);
  });
});