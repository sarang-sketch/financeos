/**
 * Read-only missing-accrual detector (task 12.4).
 *
 * A Payment or Refund is missing only when ledger_entry_sources has no row whose
 * stored (source_record_type, source_record_id) equals that record. Amount/date
 * similarity never participates. Sources are filtered by inclusive creation date,
 * ordered by descending amount then ascending type/id, and only then paged.
 * `total` is the full filtered count, not the page size.
 *
 * Page<N> is not defined in design.md; paging.ts documents the stable choice
 * `{ offset, limit }`, with limit 1..100 and bounded offset. No live adapter is
 * supplied before task 26.1 installs usable RLS policies and the read-only role.
 */
import { type Paise, sum } from '@/calc/calculation-service';
import type { TenantId } from '@/config/configuration-service';
import {
  createEvidenceChainBuilder,
  type EvidenceChain,
  type EvidenceChainInput,
  type EvidenceChainStore,
  type EvidenceSourceCitation,
  incompleteEvidence,
  type IncompleteEvidence,
  MAX_STEP_INDEX,
} from '@/evidence/chain-builder';
import type { DateOnly, SourceRef } from '@/ledger/posting-rules';
import { z } from 'zod';

import { MAX_PAGE_SIZE_100, type Page, pageOf, pageSchema } from './paging';
import { catalogued } from './registry';
import { assertDateRange, type DateRange } from './settlement-scope';
import {
  type ErasedFinancialTool,
  type FinancialTool,
  TOOL_TIMEOUT_MS,
  type ToolContext,
  type ToolResult,
} from './tool';

export const GET_MISSING_ACCRUALS = 'get_missing_accruals';
const SOURCE_ID_RE = /^(pay|rfnd)_[A-Za-z0-9_-]{1,64}$/;
const realDate = (value: string): boolean => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const inputSchema = z
  .strictObject({ from: z.iso.date(), to: z.iso.date(), page: pageSchema(MAX_PAGE_SIZE_100) })
  .refine((v) => realDate(v.from), { path: ['from'], error: 'from must be a real calendar date' })
  .refine((v) => realDate(v.to), { path: ['to'], error: 'to must be a real calendar date' })
  .refine((v) => v.from <= v.to, { path: ['from'], error: 'from must be on or before to' });
export type GetMissingAccrualsInput = z.infer<typeof inputSchema>;

const accrualRefSchema = z.strictObject({
  type: z.enum(['payment', 'refund']),
  id: z.string().regex(SOURCE_ID_RE),
});
export const missingAccrualRowSchema = z.strictObject({
  ref: accrualRefSchema,
  amount_paise: z.bigint().nonnegative(),
  evidence_chain_id: z.uuid(),
  evidence_as_of: z.iso.datetime(),
});
const outputSchema = z.strictObject({
  rows: z.array(missingAccrualRowSchema).max(MAX_PAGE_SIZE_100),
  total: z.number().int().nonnegative(),
});
export type MissingAccrualRow = z.infer<typeof missingAccrualRowSchema>;
export type GetMissingAccrualsOutput = z.infer<typeof outputSchema>;

export interface AccrualSourceRecord {
  readonly ref: { readonly type: 'payment' | 'refund'; readonly id: string };
  readonly created_on: DateOnly;
  readonly amount_paise: Paise;
  readonly record_updated_at: string;
  /** Exact matches in ledger_entry_sources, not inferred entries. */
  readonly ledger_entry_source_count: number;
  readonly unreadable?: readonly SourceRef[];
}
export interface MissingAccrualRead {
  readonly records: readonly AccrualSourceRecord[];
  readonly examined: readonly EvidenceSourceCitation[];
  readonly unreadable?: readonly SourceRef[];
}
export interface MissingAccrualQuery {
  readonly tenant_id: TenantId;
  readonly range: DateRange;
}
export interface MissingAccrualStore {
  listAccrualSources(query: MissingAccrualQuery): Promise<MissingAccrualRead>;
}
export interface GetMissingAccrualsDeps {
  readonly accruals: (ctx: ToolContext) => MissingAccrualStore;
  readonly chains: (ctx: ToolContext) => EvidenceChainStore;
}

export class MissingAccrualsError extends Error {
  override readonly name = 'MissingAccrualsError';
}

const compareText = (left: string, right: string): number => left === right ? 0 : left < right ? -1 : 1;

/** Pure exact-link classification and deterministic total ordering. */
export function missingAccrualsInOrder(
  records: readonly AccrualSourceRecord[],
  range: DateRange,
): readonly AccrualSourceRecord[] {
  const candidates = records.filter((record) => {
    if (!Number.isSafeInteger(record.ledger_entry_source_count) || record.ledger_entry_source_count < 0) {
      throw new MissingAccrualsError(`${record.ref.type}:${record.ref.id} has an invalid ledger link count`);
    }
    if (record.amount_paise < 0n) {
      throw new MissingAccrualsError(`${record.ref.type}:${record.ref.id} has negative ingested paise`);
    }
    return record.created_on >= range.from && record.created_on <= range.to
      && record.ledger_entry_source_count === 0;
  });
  return [...candidates].sort((a, b) => {
    if (a.amount_paise !== b.amount_paise) return a.amount_paise > b.amount_paise ? -1 : 1;
    const type = compareText(a.ref.type, b.ref.type);
    return type !== 0 ? type : compareText(a.ref.id, b.ref.id);
  });
}

const source = (ref: SourceRef) => ({ kind: 'source' as const, ref, field: 'amount' });
const cite = (record: AccrualSourceRecord): EvidenceSourceCitation => ({
  ref: record.ref,
  field: 'amount',
  record_updated_at: record.record_updated_at,
});

export function missingAccrualChain(
  producedBy: string,
  record: AccrualSourceRecord,
): EvidenceChainInput {
  return {
    produced_by: producedBy,
    figure_paise: record.amount_paise,
    steps: [{ index: 1, operation: 'sum', operands: [source(record.ref)], result_paise: record.amount_paise }],
    sources: [cite(record)],
  };
}

function totalMissingAccrualChain(
  producedBy: string,
  records: readonly AccrualSourceRecord[],
  examined: readonly EvidenceSourceCitation[],
): EvidenceChainInput {
  if (records.length > MAX_STEP_INDEX) {
    throw new MissingAccrualsError('too many missing accrual contributors for one complete Evidence_Chain');
  }
  const total = sum(records.map((record) => record.amount_paise));
  const sources = [...records.map(cite), ...examined];
  if (sources.length === 0) {
    throw new MissingAccrualsError('the detector examined no Source_Record, so its envelope cannot be grounded');
  }
  return {
    produced_by: producedBy,
    figure_paise: total,
    steps: [{
      index: 1,
      operation: 'sum',
      operands: records.length === 0
        ? [{ kind: 'literal', value: '0' }]
        : records.map((record) => source(record.ref)),
      result_paise: total,
    }],
    sources,
  };
}

function unreadableIn(read: MissingAccrualRead): readonly SourceRef[] {
  return [
    ...(read.unreadable ?? []),
    ...read.records.flatMap((record) => record.unreadable ?? []),
  ];
}

async function persist(
  ctx: ToolContext,
  store: EvidenceChainStore,
  chain: EvidenceChainInput,
): Promise<EvidenceChain | IncompleteEvidence> {
  if (ctx.signal.aborted) throw new MissingAccrualsError('invocation aborted');
  const built = await createEvidenceChainBuilder({ store, tenantId: ctx.tenant_id }).build(chain);
  return built.ok ? built.evidence : built;
}

export function createGetMissingAccruals(
  deps: GetMissingAccrualsDeps,
): FinancialTool<GetMissingAccrualsInput, GetMissingAccrualsOutput> {
  return {
    name: GET_MISSING_ACCRUALS,
    mode: 'read_only',
    inputSchema,
    outputSchema,
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(ctx, input): Promise<ToolResult<GetMissingAccrualsOutput>> {
      const range = assertDateRange({ from: input.from, to: input.to }, 'range');
      const read = await deps.accruals(ctx).listAccrualSources({ tenant_id: ctx.tenant_id, range });
      const unreadable = unreadableIn(read);
      if (unreadable.length > 0) return incompleteEvidence(unreadable);

      const ordered = missingAccrualsInOrder(read.records, range);
      const requested: Page<typeof MAX_PAGE_SIZE_100> = input.page;
      const page = pageOf(ordered, requested);
      const chainStore = deps.chains(ctx);
      const rows: MissingAccrualRow[] = [];
      for (const record of page.rows) {
        const evidence = await persist(
          ctx,
          chainStore,
          missingAccrualChain(GET_MISSING_ACCRUALS, record),
        );
        if ('ok' in evidence) return evidence;
        rows.push({
          ref: record.ref,
          amount_paise: record.amount_paise,
          evidence_chain_id: evidence.evidence_chain_id,
          evidence_as_of: evidence.as_of,
        });
      }
      const envelope = await persist(
        ctx,
        chainStore,
        totalMissingAccrualChain(GET_MISSING_ACCRUALS, ordered, read.examined),
      );
      if ('ok' in envelope) return envelope;
      return { ok: true, value: { rows, total: page.total }, evidence: envelope };
    },
  };
}

export function catalogueEntryFor(deps: GetMissingAccrualsDeps): ErasedFinancialTool {
  return catalogued(createGetMissingAccruals(deps));
}