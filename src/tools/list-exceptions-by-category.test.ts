import { describe, expect, it } from 'vitest';

import type { ExceptionStore } from './exception-tools';
import {
  context,
  exceptionWithChain,
  MemoryEvidenceStore,
  MemoryExceptionStore,
  OTHER_TENANT,
  TENANT,
} from './exception-tools.test-support';
import {
  catalogueEntryFor,
  categoryGroupsInOrder,
  createListExceptionsByCategory,
} from './list-exceptions-by-category';
import { createToolRegistry } from './registry';

const ID_A = '10000000-0000-4000-8000-000000000001';
const ID_B = '10000000-0000-4000-8000-000000000002';
const ID_C = '10000000-0000-4000-8000-000000000003';
const ID_D = '10000000-0000-4000-8000-000000000004';

describe('list_exceptions_by_category', () => {
  it('returns a drill-down page in impact-desc/id-asc order with full totals and exact aggregate evidence', async () => {
    const chains = new MemoryEvidenceStore();
    const rows = [
      await exceptionWithChain({ store: chains, exceptionId: ID_C, impact: 10n }),
      await exceptionWithChain({ store: chains, exceptionId: ID_B, impact: 20n }),
      await exceptionWithChain({ store: chains, exceptionId: ID_A, impact: 20n }),
    ];
    const tool = createListExceptionsByCategory({
      exceptions: () => new MemoryExceptionStore(rows),
      chains: () => chains,
    });

    const result = await tool.execute(context(), {
      category: 'settlement_mismatch',
      state: 'open',
      page: { offset: 0, limit: 2 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows.map((row) => row.kind === 'exception' ? row.exception_id : '')).toEqual([
      ID_A,
      ID_B,
    ]);
    expect(result.value.total).toBe(3);
    expect(result.value.aggregate_impact_paise).toBe(50n);
    expect(result.evidence.figure_paise).toBe(50n);
    expect(rows.map((row) => row.state)).toEqual(['open', 'open', 'open']);
  });
  it('returns lifecycle-scoped category rows; under state=open the count is the open count', async () => {
    const chains = new MemoryEvidenceStore();
    const rows = [
      await exceptionWithChain({ store: chains, exceptionId: ID_A, impact: 10n }),
      await exceptionWithChain({ store: chains, exceptionId: ID_B, impact: 5n }),
      await exceptionWithChain({
        store: chains,
        exceptionId: ID_C,
        impact: 15n,
        category: 'possible_duplicate_refund',
      }),
    ];
    const tool = createListExceptionsByCategory({
      exceptions: () => new MemoryExceptionStore(rows),
      chains: () => chains,
    });
    const result = await tool.execute(context(), {
      state: 'open',
      page: { offset: 0, limit: 50 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rows).toMatchObject([
      {
        kind: 'category',
        category: 'possible_duplicate_refund',
        state: 'open',
        exception_count: 1,
        impact_paise: 15n,
      },
      {
        kind: 'category',
        category: 'settlement_mismatch',
        state: 'open',
        exception_count: 2,
        impact_paise: 15n,
      },
    ]);
    expect(result.value.total).toBe(2);
    expect(result.value.aggregate_impact_paise).toBe(30n);
    for (const row of result.value.rows) {
      expect(row.evidence_chain_id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('applies the required category ordering independently of input order', () => {
    const rows = [
      { category: 'settlement_mismatch', impact_paise: 5n },
      { category: 'possible_duplicate_refund', impact_paise: 5n },
    ] as never;
    expect(categoryGroupsInOrder(rows).map((group) => group.category)).toEqual([
      'possible_duplicate_refund',
      'settlement_mismatch',
    ]);
  });

  it('takes Tenant only from context and silently excludes a foreign row from a leaky store', async () => {
    const chains = new MemoryEvidenceStore();
    const own = await exceptionWithChain({ store: chains, exceptionId: ID_A, impact: 7n });
    const foreign = await exceptionWithChain({
      store: chains,
      exceptionId: ID_D,
      impact: 999n,
      tenantId: OTHER_TENANT,
    });
    let queryTenant = '';
    const leaky: ExceptionStore = {
      list(query) {
        queryTenant = query.tenant_id;
        return Promise.resolve([foreign, own]);
      },
      find: () => Promise.resolve(null),
    };
    const tool = createListExceptionsByCategory({ exceptions: () => leaky, chains: () => chains });
    const result = await tool.execute(context(TENANT), {
      category: 'settlement_mismatch',
      state: 'open',
      page: { offset: 0, limit: 50 },
    });
    expect(queryTenant).toBe(TENANT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.total).toBe(1);
      expect(result.value.aggregate_impact_paise).toBe(7n);
    }
  });

  it('declares strict bounded schemas and exports a standalone catalogue entry', () => {
    const chains = new MemoryEvidenceStore();
    const deps = {
      exceptions: () => new MemoryExceptionStore([]),
      chains: () => chains,
    };
    const tool = createListExceptionsByCategory(deps);
    expect(tool.inputSchema.safeParse({ state: 'open', page: { offset: 0, limit: 51 } }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ state: 'open', page: { offset: 0, limit: 1 }, tenant_id: TENANT }).success).toBe(false);
    const registry = createToolRegistry([catalogueEntryFor(deps)]);
    expect(registry.names()).toEqual(['list_exceptions_by_category']);
    expect(registry.byMode('read_only')).toHaveLength(1);
  });
});
