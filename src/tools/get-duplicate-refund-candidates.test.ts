import { describe, expect, it } from 'vitest';

import { createEvidenceChainBuilder, type EvidenceSourceCitation } from '@/evidence/chain-builder';
import { createMemoryEvidenceStore } from '../../test/property/evidence-chain-memory-store';
import {
  catalogueEntryFor,
  createGetDuplicateRefundCandidates,
  GET_DUPLICATE_REFUND_CANDIDATES,
  type DuplicateRefundQuery,
  type PaymentRefundGroup,
} from './get-duplicate-refund-candidates';
import { createToolRegistry } from './registry';
import type { ToolContext, ToolDbClient } from './tool';

const TENANT = '11111111-1111-4111-8111-111111111111';
const UPDATED = '2026-07-10T00:00:00.000Z';
const RANGE = { from: '2026-07-01', to: '2026-07-31' } as const;
const ctx = (): ToolContext => ({
  tenant_id: TENANT,
  user_id: 'usr_12_4',
  permissions: ['view_financial_data'],
  db: {} as ToolDbClient,
  signal: new AbortController().signal,
});
const group = (
  paymentId: string,
  paymentPaise: bigint,
  refunds: readonly [string, bigint, string?][],
): PaymentRefundGroup => ({
  payment_id: paymentId,
  payment_paise: paymentPaise,
  record_updated_at: UPDATED,
  refunds: refunds.map(([refund_id, amount_paise, linked = paymentId]) => ({
    refund_id,
    linked_payment_id: linked,
    created_on: '2026-07-10',
    amount_paise,
    record_updated_at: UPDATED,
  })),
});
const examined: EvidenceSourceCitation[] = [{
  ref: { type: 'payment', id: 'pay_examined' },
  field: 'amount',
  record_updated_at: UPDATED,
}];

function harness(groups: readonly PaymentRefundGroup[]) {
  const chains = createMemoryEvidenceStore();
  const queries: DuplicateRefundQuery[] = [];
  const deps = {
    refunds: () => ({
      listLinkedRefunds(query: DuplicateRefundQuery) {
        queries.push(query);
        return Promise.resolve({ groups: query.tenant_id === TENANT ? groups : [], examined });
      },
    }),
    chains: () => chains,
  };
  return { tool: createGetDuplicateRefundCandidates(deps), deps, chains, queries };
}

describe('get_duplicate_refund_candidates', () => {
  it('registers with strict real forward date inputs', () => {
    const h = harness([]);
    expect(createToolRegistry([catalogueEntryFor(h.deps)]).names()).toEqual([
      GET_DUPLICATE_REFUND_CANDIDATES,
    ]);
    expect(h.tool.mode).toBe('read_only');
    expect(h.tool.inputSchema.safeParse({ from: '2026-02-30', to: '2026-03-01' }).success).toBe(false);
    expect(h.tool.inputSchema.safeParse({ from: '2026-08-01', to: '2026-07-01' }).success).toBe(false);
    expect(h.tool.inputSchema.safeParse({ ...RANGE, tenant_id: TENANT }).success).toBe(false);
  });

  it('groups only stored Payment→Refund links and returns exact bigint excess', async () => {
    const h = harness([
      // Candidate: 60 + 50 - 100 = 10.
      group('pay_candidate', 100n, [['rfnd_b', 50n], ['rfnd_a', 60n]]),
      // Combined equals payment: not a candidate.
      group('pay_equal', 100n, [['rfnd_c', 40n], ['rfnd_d', 60n]]),
      // One over-sized refund is not a duplicate-refund candidate.
      group('pay_single', 100n, [['rfnd_e', 101n]]),
    ]);
    const result = await h.tool.execute(ctx(), RANGE);
    if (!result.ok) throw new Error(`unexpected ${result.kind}`);
    expect(result.value.rows).toMatchObject([{
      payment_id: 'pay_candidate',
      payment_paise: 100n,
      refund_ids: ['rfnd_a', 'rfnd_b'],
      combined_refund_paise: 110n,
      excess_paise: 10n,
    }]);
    expect(h.queries).toEqual([{ tenant_id: TENANT, range: RANGE }]);
    const row = result.value.rows[0];
    const chain = await createEvidenceChainBuilder({ store: h.chains, tenantId: TENANT })
      .read(row?.evidence_chain_id ?? '');
    expect(chain?.figure_paise).toBe(10n);
    expect(chain?.steps.map((entry) => entry.result_paise)).toEqual([100n, 110n, 10n]);
    expect(result.evidence.figure_paise).toBe(10n);
  });

  it('orders by descending excess with payment-id ties', async () => {
    const h = harness([
      group('pay_zed', 100n, [['rfnd_z1', 60n], ['rfnd_z2', 50n]]),
      group('pay_alpha', 100n, [['rfnd_a1', 70n], ['rfnd_a2', 40n]]),
      group('pay_large', 100n, [['rfnd_l1', 80n], ['rfnd_l2', 50n]]),
    ]);
    const result = await h.tool.execute(ctx(), RANGE);
    if (!result.ok) throw new Error(`unexpected ${result.kind}`);
    expect(result.value.rows.map((row) => row.payment_id)).toEqual([
      'pay_large', 'pay_alpha', 'pay_zed',
    ]);
  });

  it('refuses a group whose stored payment_id link disagrees instead of inferring a match', async () => {
    const h = harness([group('pay_owner', 100n, [
      ['rfnd_wrong', 60n, 'pay_other'], ['rfnd_right', 60n],
    ])]);
    await expect(h.tool.execute(ctx(), RANGE)).rejects.toThrow(/stored payment_id|grouped under/);
    expect(h.chains.chainCount).toBe(0);
  });

  it('returns incomplete_evidence and no figure for an unreadable linked Refund', async () => {
    const hidden: PaymentRefundGroup = {
      ...group('pay_hidden', 100n, [['rfnd_h1', 60n], ['rfnd_h2', 60n]]),
      unreadable: [{ type: 'refund', id: 'rfnd_hidden' }],
    };
    const h = harness([hidden]);
    const result = await h.tool.execute(ctx(), RANGE);
    expect(result).toEqual({ ok: false, kind: 'incomplete_evidence', unavailable: [{ type: 'refund', count: 1 }] });
    expect(h.chains.chainCount).toBe(0);
  });
});