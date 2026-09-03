import { describe, expect, it } from 'vitest';

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
  createGetExceptionEvidence,
} from './get-exception-evidence';
import { createToolRegistry } from './registry';

const EXCEPTION_ID = '10000000-0000-4000-8000-000000000001';
const FOREIGN_ID = '10000000-0000-4000-8000-000000000099';

describe('get_exception_evidence', () => {
  it('pages 503 source identifiers at 500 without omission or duplication', async () => {
    const chains = new MemoryEvidenceStore();
    const sourceRefs = Array.from({ length: 503 }, (_, index) => ({
      type: 'payment' as const,
      id: `pay_${String(index).padStart(4, '0')}`,
    }));
    const exception = await exceptionWithChain({
      store: chains,
      exceptionId: EXCEPTION_ID,
      impact: 503n,
      sourceRefs,
    });
    const deps = {
      exceptions: () => new MemoryExceptionStore([exception]),
      chains: () => chains,
    };
    const tool = createGetExceptionEvidence(deps);

    const first = await tool.execute(context(), {
      exception_id: EXCEPTION_ID,
      source_page: { offset: 0, limit: 500 },
    });
    const second = await tool.execute(context(), {
      exception_id: EXCEPTION_ID,
      source_page: { offset: 500, limit: 500 },
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(first.value.evidence.sources).toHaveLength(500);
    expect(first.value.evidence.source_page.next_offset).toBe(500);
    expect(second.value.evidence.sources).toHaveLength(3);
    expect(second.value.evidence.source_page.next_offset).toBeNull();
    const ids = [...first.value.evidence.sources, ...second.value.evidence.sources].map(
      (source) => source.ref.id,
    );
    expect(ids).toHaveLength(503);
    expect(new Set(ids).size).toBe(503);
    expect(ids[0]).toBe('pay_0000');
    expect(ids[502]).toBe('pay_0502');
    expect(first.value.evidence.source_count).toBe(503);
    expect(first.evidence.sources).toHaveLength(500);
  });
  it('exposes chain as-of, record-updated-at, and a chain-level stale indicator', async () => {
    const chains = new MemoryEvidenceStore();
    const exception = await exceptionWithChain({
      store: chains,
      exceptionId: EXCEPTION_ID,
      impact: 10n,
    });
    chains.setSourceTimestamp(exception.evidence_chain_id, '2026-07-29T00:00:00.000Z');
    const tool = createGetExceptionEvidence({
      exceptions: () => new MemoryExceptionStore([exception]),
      chains: () => chains,
    });
    const result = await tool.execute(context(), {
      exception_id: EXCEPTION_ID,
      source_page: { offset: 0, limit: 1 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.evidence.as_of).toBe('2026-07-28T00:00:00.000Z');
    expect(result.value.evidence.stale).toBe(true);
    expect(result.value.evidence.sources[0]).toMatchObject({
      record_updated_at: '2026-07-29T00:00:00.000Z',
      as_of: '2026-07-28T00:00:00.000Z',
      stale: true,
    });
    expect(result.value.exception.evidence_as_of).toBe('2026-07-28T00:00:00.000Z');
  });

  it('makes a foreign Exception identifier indistinguishable from absent and never mutates it', async () => {
    const chains = new MemoryEvidenceStore();
    const foreign = await exceptionWithChain({
      store: chains,
      exceptionId: FOREIGN_ID,
      impact: 99n,
      tenantId: OTHER_TENANT,
      state: 'resolved',
    });
    const before = structuredClone(foreign);
    const tool = createGetExceptionEvidence({
      exceptions: () => new MemoryExceptionStore([foreign]),
      chains: () => chains,
    });
    await expect(
      tool.execute(context(TENANT), {
        exception_id: FOREIGN_ID,
        source_page: { offset: 0, limit: 1 },
      }),
    ).rejects.toThrow(/not found/);
    expect(foreign).toEqual(before);
  });

  it('rejects oversized pages, tenant overrides, and exports a read-only catalogue entry', () => {
    const chains = new MemoryEvidenceStore();
    const deps = {
      exceptions: () => new MemoryExceptionStore([]),
      chains: () => chains,
    };
    const tool = createGetExceptionEvidence(deps);
    expect(
      tool.inputSchema.safeParse({
        exception_id: EXCEPTION_ID,
        source_page: { offset: 0, limit: 501 },
      }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({
        exception_id: EXCEPTION_ID,
        source_page: { offset: 0, limit: 1 },
        tenant_id: TENANT,
      }).success,
    ).toBe(false);
    const registry = createToolRegistry([catalogueEntryFor(deps)]);
    expect(registry.names()).toEqual(['get_exception_evidence']);
    expect(registry.byMode('read_only')).toHaveLength(1);
  });
});
