import { describe, expect, it } from 'vitest';

import { createEvidenceChainBuilder, type EvidenceSourceCitation } from '@/evidence/chain-builder';
import { createMemoryEvidenceStore } from '../../test/property/evidence-chain-memory-store';
import {
  catalogueEntryFor,
  createGetMissingAccruals,
  GET_MISSING_ACCRUALS,
  type AccrualSourceRecord,
  type MissingAccrualQuery,
} from './get-missing-accruals';
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
const record = (
  type: 'payment' | 'refund',
  id: string,
  amount_paise: bigint,
  links = 0,
): AccrualSourceRecord => ({
  ref: { type, id },
  created_on: '2026-07-10',
  amount_paise,
  record_updated_at: UPDATED,
  ledger_entry_source_count: links,
});
const citations = (records: readonly AccrualSourceRecord[]): EvidenceSourceCitation[] =>
  records.map((entry) => ({ ref: entry.ref, field: 'amount', record_updated_at: entry.record_updated_at }));

function harness(records: readonly AccrualSourceRecord[]) {
  const chains = createMemoryEvidenceStore();
  const queries: MissingAccrualQuery[] = [];
  const deps = {
    accruals: () => ({
      listAccrualSources(query: MissingAccrualQuery) {
        queries.push(query);
        return Promise.resolve({
          records: query.tenant_id === TENANT ? records : [],
          examined: citations(records),
        });
      },
    }),
    chains: () => chains,
  };
  return { tool: createGetMissingAccruals(deps), deps, chains, queries };
}

describe('get_missing_accruals', () => {
  it('registers with strict real forward dates and Page<100> bounds', () => {
    const h = harness([]);
    expect(createToolRegistry([catalogueEntryFor(h.deps)]).names()).toEqual([GET_MISSING_ACCRUALS]);
    expect(h.tool.mode).toBe('read_only');
    expect(h.tool.inputSchema.safeParse({ ...RANGE, page: { offset: 0, limit: 100 } }).success).toBe(true);
    expect(h.tool.inputSchema.safeParse({ ...RANGE, page: { offset: 0, limit: 101 } }).success).toBe(false);
    expect(h.tool.inputSchema.safeParse({ from: '2026-02-30', to: '2026-03-01', page: { offset: 0, limit: 1 } }).success).toBe(false);
    expect(h.tool.inputSchema.safeParse({ ...RANGE, page: { offset: 0, limit: 1 }, tenant_id: TENANT }).success).toBe(false);
  });

  it('uses exact source links, orders before paging, and reports the full total', async () => {
    const records = [
      record('refund', 'rfnd_small', 50n),
      record('payment', 'pay_posted', 1_000n, 1),
      record('payment', 'pay_large', 500n),
      record('refund', 'rfnd_large', 500n),
    ];
    const h = harness(records);
    const result = await h.tool.execute(ctx(), { ...RANGE, page: { offset: 1, limit: 2 } });
    if (!result.ok) throw new Error(`unexpected ${result.kind}`);
    expect(result.value.total).toBe(3);
    // Equal amounts break on type then id: payment precedes refund, so offset 1 starts at refund.
    expect(result.value.rows.map((row) => row.ref)).toEqual([
      { type: 'refund', id: 'rfnd_large' },
      { type: 'refund', id: 'rfnd_small' },
    ]);
    expect(h.queries).toEqual([{ tenant_id: TENANT, range: RANGE }]);
    expect(result.evidence.figure_paise).toBe(1_050n);
    for (const row of result.value.rows) {
      const chain = await createEvidenceChainBuilder({ store: h.chains, tenantId: TENANT })
        .read(row.evidence_chain_id);
      expect(chain?.figure_paise).toBe(row.amount_paise);
    }
  });

  it('does not infer an accrual from another source with the same amount or date', async () => {
    const h = harness([
      record('payment', 'pay_same', 100n, 1),
      record('refund', 'rfnd_same', 100n, 0),
    ]);
    const result = await h.tool.execute(ctx(), { ...RANGE, page: { offset: 0, limit: 100 } });
    if (!result.ok) throw new Error(`unexpected ${result.kind}`);
    expect(result.value.rows.map((row) => row.ref)).toEqual([{ type: 'refund', id: 'rfnd_same' }]);
  });

  it('returns incomplete_evidence before composing any monetary figure', async () => {
    const hidden: AccrualSourceRecord = {
      ...record('payment', 'pay_hidden', 100n),
      unreadable: [{ type: 'ledger_entry_set', id: 'set_hidden' }],
    };
    const h = harness([hidden]);
    const result = await h.tool.execute(ctx(), { ...RANGE, page: { offset: 0, limit: 10 } });
    expect(result).toEqual({
      ok: false,
      kind: 'incomplete_evidence',
      unavailable: [{ type: 'ledger_entry_set', count: 1 }],
    });
    expect(h.chains.chainCount).toBe(0);
  });
});