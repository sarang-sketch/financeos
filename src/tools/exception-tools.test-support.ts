import type { Paise } from '@/calc/calculation-service';
import type { TenantId } from '@/config/configuration-service';
import {
  createEvidenceChainBuilder,
  type EvidenceChainStepRow,
  type EvidenceChainStore,
  type EvidenceChainWrite,
  type EvidenceSourceRow,
} from '@/evidence/chain-builder';
import type { SourceRef } from '@/ledger/posting-rules';

import type { ExceptionStore, ScopedException } from './exception-tools';
import type { ToolContext } from './tool';

export const TENANT = '11111111-1111-4111-8111-111111111111';
export const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
export const UPDATED = '2026-07-28T00:00:00.000Z';

export class MemoryEvidenceStore implements EvidenceChainStore {
  readonly writes: EvidenceChainWrite[] = [];
  private readonly headers = new Map<string, EvidenceChainWrite>();
  private readonly stepRows = new Map<string, readonly EvidenceChainStepRow[]>();
  private readonly sourceRows = new Map<string, EvidenceSourceRow[]>();
  private nextId = 1;

  insertChain(write: EvidenceChainWrite) {
    const chainId = `90000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`;
    this.writes.push(write);
    this.headers.set(chainId, write);
    this.stepRows.set(
      chainId,
      write.steps.map((step) => ({
        step_index: step.step_index,
        operation: step.operation,
        operands: JSON.parse(step.operands_json) as unknown,
        result_paise: step.result_paise,
        note: step.note,
      })),
    );
    this.sourceRows.set(chainId, groupedSources(write));
    return Promise.resolve({ ok: true as const, chain_id: chainId });
  }

  findChain(tenantId: TenantId, chainId: string) {
    const row = this.headers.get(chainId);
    if (row === undefined || row.tenant_id !== tenantId) return Promise.resolve(null);
    return Promise.resolve({
      chain_id: chainId,
      figure_paise: row.figure_paise,
      source_count: row.source_count,
      as_of: row.as_of,
      produced_by: row.produced_by,
    });
  }

  listSteps(tenantId: TenantId, chainId: string) {
    const row = this.headers.get(chainId);
    return Promise.resolve(row?.tenant_id === tenantId ? (this.stepRows.get(chainId) ?? []) : []);
  }

  listSourcePage(query: Parameters<EvidenceChainStore['listSourcePage']>[0]) {
    const header = this.headers.get(query.chain_id);
    if (header?.tenant_id !== query.tenant_id) return Promise.resolve([]);
    const afterKey = query.after === null ? null : `${query.after.type}\u0000${query.after.id}`;
    const rows = (this.sourceRows.get(query.chain_id) ?? []).filter((row) =>
      afterKey === null ? true : `${row.source_record_type}\u0000${row.source_record_id}` > afterKey,
    );
    return Promise.resolve(rows.slice(0, query.limit));
  }

  setSourceTimestamp(chainId: string, timestamp: string): void {
    const rows = this.sourceRows.get(chainId);
    if (rows === undefined || rows[0] === undefined) throw new Error('chain has no source');
    rows[0] = { ...rows[0], record_updated_at: timestamp };
  }
}
function groupedSources(write: EvidenceChainWrite): EvidenceSourceRow[] {
  const grouped = new Map<string, EvidenceSourceRow>();
  for (const source of write.sources) {
    const key = `${source.source_record_type}\u0000${source.source_record_id}`;
    const existing = grouped.get(key);
    grouped.set(key, {
      source_record_type: source.source_record_type,
      source_record_id: source.source_record_id,
      fields: [...new Set([...(existing?.fields ?? []), source.field])].sort(),
      record_updated_at:
        existing === undefined || source.record_updated_at > existing.record_updated_at
          ? source.record_updated_at
          : existing.record_updated_at,
    });
  }
  return [...grouped.values()].sort((left, right) => {
    const a = `${left.source_record_type}\u0000${left.source_record_id}`;
    const b = `${right.source_record_type}\u0000${right.source_record_id}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export class MemoryExceptionStore implements ExceptionStore {
  constructor(readonly rows: ScopedException[]) {}

  list(query: Parameters<ExceptionStore['list']>[0]) {
    return Promise.resolve(
      this.rows.filter(
        (row) =>
          row.tenant_id === query.tenant_id &&
          row.state === query.state &&
          (query.category === null || row.category === query.category),
      ),
    );
  }

  find(tenantId: TenantId, exceptionId: string) {
    return Promise.resolve(
      this.rows.find((row) => row.tenant_id === tenantId && row.exception_id === exceptionId) ?? null,
    );
  }
}

export function context(tenantId: TenantId = TENANT): ToolContext {
  return {
    tenant_id: tenantId,
    user_id: '33333333-3333-4333-8333-333333333333',
    permissions: ['view_financial_data'],
    db: {} as ToolContext['db'],
    signal: new AbortController().signal,
  };
}

export async function exceptionWithChain(options: {
  readonly store: MemoryEvidenceStore;
  readonly exceptionId: string;
  readonly impact: Paise;
  readonly category?: ScopedException['category'];
  readonly state?: ScopedException['state'];
  readonly tenantId?: TenantId;
  readonly sourceRefs?: readonly SourceRef[];
}): Promise<ScopedException> {
  const tenantId = options.tenantId ?? TENANT;
  const refs = options.sourceRefs ?? [{ type: 'payment', id: `pay_${options.exceptionId.slice(0, 8)}` }];
  const builder = createEvidenceChainBuilder({ store: options.store, tenantId });
  const built = await builder.build({
    produced_by: 'exception_detector',
    figure_paise: options.impact,
    steps: [
      {
        index: 1,
        operation: 'sum',
        operands: refs.map((ref) => ({ kind: 'source' as const, ref, field: 'amount' })),
        result_paise: options.impact,
      },
    ],
    sources: refs.map((ref) => ({ ref, field: 'amount', record_updated_at: UPDATED })),
  });
  if (!built.ok) throw new Error('test chain unexpectedly incomplete');
  const state = options.state ?? 'open';
  return {
    tenant_id: tenantId,
    exception_id: options.exceptionId,
    category: options.category ?? 'settlement_mismatch',
    state,
    impact_paise: options.impact,
    direction: 'shortfall',
    source_records: refs,
    evidence_chain_id: built.evidence.evidence_chain_id,
    fingerprint: options.exceptionId.replaceAll('-', '').padEnd(64, 'a').slice(0, 64),
    first_detected_at: UPDATED,
    last_detected_at: UPDATED,
    resolved_at: state === 'open' ? null : '2026-07-29T00:00:00.000Z',
  };
}
