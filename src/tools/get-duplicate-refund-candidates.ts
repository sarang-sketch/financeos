/**
 * Read-only duplicate-refund detector (task 12.4).
 *
 * The store exposes only persisted Refund.payload.payment_id links. The tool never
 * compares amounts or dates to discover a relationship: dates only bound which
 * already-linked Refund records participate. Candidates require at least two linked
 * Refunds and exact combined_refund_paise > payment_paise (Requirement 4.8).
 *
 * Ordering is descending excess_paise, then ascending payment_id. Refund identifiers
 * are ascending. The output contract has no page or total field, despite task 12.4's
 * generic paging sentence; the fixed design table is preserved rather than widened.
 * No live adapter is supplied while the FORCE RLS tables have no policies (task 26.1).
 */
import { type Paise, subtract, sum } from '@/calc/calculation-service';
import type { TenantId } from '@/config/configuration-service';
import {
  createEvidenceChainBuilder,
  type EvidenceChain,
  type EvidenceChainInput,
  type EvidenceChainStore,
  type EvidenceSourceCitation,
  type EvidenceStep,
  incompleteEvidence,
  type IncompleteEvidence,
  MAX_STEP_INDEX,
} from '@/evidence/chain-builder';
import type { DateOnly, SourceRef } from '@/ledger/posting-rules';
import { z } from 'zod';

import { catalogued } from './registry';
import { assertDateRange, type DateRange } from './settlement-scope';
import {
  type ErasedFinancialTool,
  type FinancialTool,
  TOOL_TIMEOUT_MS,
  type ToolContext,
  type ToolResult,
} from './tool';

export const GET_DUPLICATE_REFUND_CANDIDATES = 'get_duplicate_refund_candidates';
const PAYMENT_ID_RE = /^pay_[A-Za-z0-9_-]{1,64}$/;
const REFUND_ID_RE = /^rfnd_[A-Za-z0-9_-]{1,64}$/;
const realDate = (value: string): boolean => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const inputSchema = z
  .strictObject({ from: z.iso.date(), to: z.iso.date() })
  .refine((v) => realDate(v.from), { path: ['from'], error: 'from must be a real calendar date' })
  .refine((v) => realDate(v.to), { path: ['to'], error: 'to must be a real calendar date' })
  .refine((v) => v.from <= v.to, { path: ['from'], error: 'from must be on or before to' });
export type GetDuplicateRefundCandidatesInput = z.infer<typeof inputSchema>;

export const duplicateRefundCandidateRowSchema = z.strictObject({
  payment_id: z.string().regex(PAYMENT_ID_RE),
  payment_paise: z.bigint(),
  refund_ids: z.array(z.string().regex(REFUND_ID_RE)).min(2),
  combined_refund_paise: z.bigint(),
  excess_paise: z.bigint().positive(),
  evidence_chain_id: z.uuid(),
  evidence_as_of: z.iso.datetime(),
});
const outputSchema = z.strictObject({ rows: z.array(duplicateRefundCandidateRowSchema) });
export type DuplicateRefundCandidateRow = z.infer<typeof duplicateRefundCandidateRowSchema>;
export type GetDuplicateRefundCandidatesOutput = z.infer<typeof outputSchema>;

export interface StoredLinkedRefund {
  readonly refund_id: string;
  /** The persisted Refund.payload.payment_id value. */
  readonly linked_payment_id: string;
  readonly created_on: DateOnly;
  readonly amount_paise: Paise;
  readonly record_updated_at: string;
  readonly unreadable?: readonly SourceRef[];
}
export interface PaymentRefundGroup {
  readonly payment_id: string;
  readonly payment_paise: Paise;
  readonly record_updated_at: string;
  /** Refunds found through the persisted payment_id index, never inferred. */
  readonly refunds: readonly StoredLinkedRefund[];
  readonly unreadable?: readonly SourceRef[];
}
export interface DuplicateRefundRead {
  readonly groups: readonly PaymentRefundGroup[];
  /** Citations read while proving that no other candidate exists. */
  readonly examined: readonly EvidenceSourceCitation[];
  readonly unreadable?: readonly SourceRef[];
}
export interface DuplicateRefundQuery {
  readonly tenant_id: TenantId;
  readonly range: DateRange;
}
export interface DuplicateRefundStore {
  listLinkedRefunds(query: DuplicateRefundQuery): Promise<DuplicateRefundRead>;
}
export interface GetDuplicateRefundCandidatesDeps {
  readonly refunds: (ctx: ToolContext) => DuplicateRefundStore;
  readonly chains: (ctx: ToolContext) => EvidenceChainStore;
}

interface Candidate {
  readonly group: PaymentRefundGroup;
  readonly refunds: readonly StoredLinkedRefund[];
  readonly combined_refund_paise: Paise;
  readonly excess_paise: Paise;
}

export class DuplicateRefundCandidatesError extends Error {
  override readonly name = 'DuplicateRefundCandidatesError';
}

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

function assertNonNegative(value: Paise, label: string): void {
  if (value < 0n) throw new DuplicateRefundCandidatesError(`${label} must be non-negative paise`);
}

/** Pure candidate grouping over stored identifier links. */
export function duplicateRefundCandidatesInOrder(
  groups: readonly PaymentRefundGroup[],
  range: DateRange,
): readonly Candidate[] {
  const candidates: Candidate[] = [];
  for (const group of groups) {
    assertNonNegative(group.payment_paise, `${group.payment_id}.payment_paise`);
    const linked = group.refunds.filter((refund) => {
      if (refund.linked_payment_id !== group.payment_id) {
        throw new DuplicateRefundCandidatesError(
          `${refund.refund_id} is grouped under ${group.payment_id} but its stored payment_id is ${refund.linked_payment_id}`,
        );
      }
      assertNonNegative(refund.amount_paise, `${refund.refund_id}.amount_paise`);
      return refund.created_on >= range.from && refund.created_on <= range.to;
    });
    if (linked.length < 2) continue;
    const combined = sum(linked.map((refund) => refund.amount_paise));
    if (combined <= group.payment_paise) continue;
    candidates.push({
      group,
      refunds: [...linked].sort((a, b) => compareText(a.refund_id, b.refund_id)),
      combined_refund_paise: combined,
      excess_paise: subtract(combined, group.payment_paise),
    });
  }
  return candidates.sort((a, b) =>
    a.excess_paise !== b.excess_paise
      ? a.excess_paise > b.excess_paise ? -1 : 1
      : compareText(a.group.payment_id, b.group.payment_id),
  );
}

const paymentRef = (id: string): SourceRef => ({ type: 'payment', id });
const refundRef = (id: string): SourceRef => ({ type: 'refund', id });
const source = (ref: SourceRef, field: string) => ({ kind: 'source' as const, ref, field });
const step = (index: number) => ({ kind: 'step' as const, index });
const cite = (ref: SourceRef, field: string, record_updated_at: string): EvidenceSourceCitation => ({
  ref, field, record_updated_at,
});

function candidateBlock(candidate: Candidate, base = 0): {
  readonly steps: readonly EvidenceStep[];
  readonly sources: readonly EvidenceSourceCitation[];
  readonly excessStep: number;
} {
  const payment = paymentRef(candidate.group.payment_id);
  const refundOperands = candidate.refunds.map((r) => source(refundRef(r.refund_id), 'amount'));
  const steps: readonly EvidenceStep[] = [
    { index: base + 1, operation: 'sum', operands: [source(payment, 'amount')], result_paise: candidate.group.payment_paise },
    { index: base + 2, operation: 'sum', operands: refundOperands, result_paise: candidate.combined_refund_paise },
    { index: base + 3, operation: 'subtract', operands: [step(base + 2), step(base + 1)], result_paise: candidate.excess_paise },
  ];
  const sources = [
    cite(payment, 'amount', candidate.group.record_updated_at),
    ...candidate.refunds.flatMap((refund) => [
      cite(refundRef(refund.refund_id), 'amount', refund.record_updated_at),
      cite(refundRef(refund.refund_id), 'payment_id', refund.record_updated_at),
    ]),
  ];
  return { steps, sources, excessStep: base + 3 };
}

export function duplicateRefundCandidateChain(producedBy: string, candidate: Candidate): EvidenceChainInput {
  const block = candidateBlock(candidate);
  return {
    produced_by: producedBy,
    figure_paise: candidate.excess_paise,
    steps: block.steps,
    sources: block.sources,
  };
}

function totalCandidateExcessChain(
  producedBy: string,
  candidates: readonly Candidate[],
  examined: readonly EvidenceSourceCitation[],
): EvidenceChainInput {
  if (candidates.length * 3 + 1 > MAX_STEP_INDEX) {
    throw new DuplicateRefundCandidatesError('too many candidates for one complete Evidence_Chain');
  }
  const steps: EvidenceStep[] = [];
  const sources: EvidenceSourceCitation[] = [];
  const excessSteps: number[] = [];
  const excesses: Paise[] = [];
  for (const candidate of candidates) {
    const block = candidateBlock(candidate, steps.length);
    steps.push(...block.steps);
    sources.push(...block.sources);
    excessSteps.push(block.excessStep);
    excesses.push(candidate.excess_paise);
  }
  sources.push(...examined);
  if (sources.length === 0) {
    throw new DuplicateRefundCandidatesError('the detector examined no Source_Record, so its envelope cannot be grounded');
  }
  const total = sum(excesses);
  steps.push({
    index: steps.length + 1,
    operation: 'sum',
    operands: excessSteps.length === 0
      ? [{ kind: 'literal', value: '0' }]
      : excessSteps.map(step),
    result_paise: total,
  });
  return { produced_by: producedBy, figure_paise: total, steps, sources };
}

function unreadableIn(read: DuplicateRefundRead): readonly SourceRef[] {
  return [
    ...(read.unreadable ?? []),
    ...read.groups.flatMap((group) => [
      ...(group.unreadable ?? []),
      ...group.refunds.flatMap((refund) => refund.unreadable ?? []),
    ]),
  ];
}

async function persist(
  ctx: ToolContext,
  store: EvidenceChainStore,
  chain: EvidenceChainInput,
): Promise<EvidenceChain | IncompleteEvidence> {
  if (ctx.signal.aborted) throw new DuplicateRefundCandidatesError('invocation aborted');
  const built = await createEvidenceChainBuilder({ store, tenantId: ctx.tenant_id }).build(chain);
  return built.ok ? built.evidence : built;
}

export function createGetDuplicateRefundCandidates(
  deps: GetDuplicateRefundCandidatesDeps,
): FinancialTool<GetDuplicateRefundCandidatesInput, GetDuplicateRefundCandidatesOutput> {
  return {
    name: GET_DUPLICATE_REFUND_CANDIDATES,
    mode: 'read_only',
    inputSchema,
    outputSchema,
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(ctx, input): Promise<ToolResult<GetDuplicateRefundCandidatesOutput>> {
      const range = assertDateRange(input, 'range');
      const read = await deps.refunds(ctx).listLinkedRefunds({ tenant_id: ctx.tenant_id, range });
      const unreadable = unreadableIn(read);
      if (unreadable.length > 0) return incompleteEvidence(unreadable);

      const candidates = duplicateRefundCandidatesInOrder(read.groups, range);
      const chainStore = deps.chains(ctx);
      const rows: DuplicateRefundCandidateRow[] = [];
      for (const candidate of candidates) {
        const evidence = await persist(
          ctx,
          chainStore,
          duplicateRefundCandidateChain(GET_DUPLICATE_REFUND_CANDIDATES, candidate),
        );
        if ('ok' in evidence) return evidence;
        rows.push({
          payment_id: candidate.group.payment_id,
          payment_paise: candidate.group.payment_paise,
          refund_ids: candidate.refunds.map((refund) => refund.refund_id),
          combined_refund_paise: candidate.combined_refund_paise,
          excess_paise: candidate.excess_paise,
          evidence_chain_id: evidence.evidence_chain_id,
          evidence_as_of: evidence.as_of,
        });
      }
      const envelope = await persist(
        ctx,
        chainStore,
        totalCandidateExcessChain(GET_DUPLICATE_REFUND_CANDIDATES, candidates, read.examined),
      );
      if ('ok' in envelope) return envelope;
      return { ok: true, value: { rows }, evidence: envelope };
    },
  };
}

export function catalogueEntryFor(
  deps: GetDuplicateRefundCandidatesDeps,
): ErasedFinancialTool {
  return catalogued(createGetDuplicateRefundCandidates(deps));
}