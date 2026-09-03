/**
 * Shared exception-tool read seams, summaries, ordering, and Evidence_Chain projections.
 *
 * **Requirement 12.3 as of task 12.7.** Neither exception tool composes the figure it
 * presents: an Exception's impact *is* its persisted Evidence_Chain's figure. So a chain
 * that cannot be read for this Tenant is a contributing record that cannot be read, and
 * {@link aggregateExceptionChainInput} answers `incomplete_evidence` — the figure omitted
 * entirely, the Exception's own cited Source_Record types counted by type — instead of
 * throwing. {@link unreadableRefsOf} is where the types come from, and the reason they are
 * knowable at all is that the Exception row carries them independently of the chain.
 */
import { EXCEPTION_CATEGORIES, EXCEPTION_DIRECTIONS, EXCEPTION_STATES, type ExceptionCategory, type ExceptionDirection, type ExceptionState } from '@/agents/exception-fingerprint';
import { sum, type Paise } from '@/calc/calculation-service';
import type { TenantId } from '@/config/configuration-service';
import {
  incompleteEvidence,
  MAX_SOURCE_PAGE_SIZE,
  MAX_STEP_INDEX,
  type EvidenceChain,
  type EvidenceChainBuilder,
  type EvidenceChainInput,
  type EvidenceOperand,
  type EvidenceSourceCitation,
  type EvidenceSourceEntry,
  type EvidenceStep,
  type IncompleteEvidence,
} from '@/evidence/chain-builder';
import { SOURCE_RECORD_TYPES, type SourceRef } from '@/ledger/posting-rules';
import { z } from 'zod';

export { EXCEPTION_CATEGORIES, EXCEPTION_STATES };
export const MAX_EXCEPTION_PAGE_SIZE = 50;

const paise = z.bigint();
const sourceRefSchema = z.strictObject({
  type: z.enum(SOURCE_RECORD_TYPES),
  id: z.string().min(1).max(256),
});
export const exceptionItemSummarySchema = z.strictObject({
  kind: z.literal('exception'),
  exception_id: z.uuid(),
  category: z.enum(EXCEPTION_CATEGORIES),
  state: z.enum(EXCEPTION_STATES),
  impact_paise: paise.nonnegative(),
  direction: z.enum(EXCEPTION_DIRECTIONS).nullable(),
  source_records: z.array(sourceRefSchema).min(1),
  evidence_chain_id: z.uuid(),
  evidence_as_of: z.iso.datetime(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  first_detected_at: z.iso.datetime(),
  last_detected_at: z.iso.datetime(),
  resolved_at: z.iso.datetime().nullable(),
});

export const exceptionCategorySummarySchema = z.strictObject({
  kind: z.literal('category'),
  category: z.enum(EXCEPTION_CATEGORIES),
  state: z.enum(EXCEPTION_STATES),
  exception_count: z.number().int().positive(),
  impact_paise: paise.nonnegative(),
  evidence_chain_id: z.uuid(),
  evidence_as_of: z.iso.datetime(),
});

/**
 * `ExceptionSummary` is referenced but never declared by design.md. This is the
 * minimal discriminated shape needed for its two list modes: category rollups and
 * Exception drill-down rows.
 */
export type ExceptionItemSummary = z.infer<typeof exceptionItemSummarySchema>;
export type ExceptionCategorySummary = z.infer<typeof exceptionCategorySummarySchema>;
export type ExceptionSummary = ExceptionItemSummary | ExceptionCategorySummary;
export const exceptionSummarySchema = z.discriminatedUnion('kind', [
  exceptionItemSummarySchema,
  exceptionCategorySummarySchema,
]);

export interface ScopedException {
  readonly tenant_id: TenantId;
  readonly exception_id: string;
  readonly category: ExceptionCategory;
  readonly state: ExceptionState;
  readonly impact_paise: Paise;
  readonly direction: ExceptionDirection | null;
  readonly source_records: readonly SourceRef[];
  readonly evidence_chain_id: string;
  readonly fingerprint: string;
  readonly first_detected_at: string;
  readonly last_detected_at: string;
  readonly resolved_at: string | null;
}

export interface ExceptionListQuery {
  readonly tenant_id: TenantId;
  readonly category: ExceptionCategory | null;
  readonly state: ExceptionState;
}

export interface ExceptionStore {
  /** Return the full filtered set; totals and exact aggregate evidence span every page. */
  list(query: ExceptionListQuery): Promise<readonly ScopedException[]>;
  /** Null means absent or another Tenant; those cases are deliberately indistinguishable. */
  find(tenantId: TenantId, exceptionId: string): Promise<ScopedException | null>;
}

export class ExceptionToolError extends Error {
  override readonly name = 'ExceptionToolError';
}

export function exceptionsInOrder(rows: readonly ScopedException[]): readonly ScopedException[] {
  return [...rows].sort((left, right) => {
    if (left.impact_paise !== right.impact_paise) {
      return left.impact_paise > right.impact_paise ? -1 : 1;
    }
    return left.exception_id < right.exception_id ? -1 : left.exception_id > right.exception_id ? 1 : 0;
  });
}

export function itemSummary(row: ScopedException, evidenceAsOf: string): ExceptionItemSummary {
  return {
    kind: 'exception',
    exception_id: row.exception_id,
    category: row.category,
    state: row.state,
    impact_paise: row.impact_paise,
    direction: row.direction,
    source_records: [...row.source_records],
    evidence_chain_id: row.evidence_chain_id,
    evidence_as_of: evidenceAsOf,
    fingerprint: row.fingerprint,
    first_detected_at: row.first_detected_at,
    last_detected_at: row.last_detected_at,
    resolved_at: row.resolved_at,
  };
}

function shiftedOperand(operand: EvidenceOperand, offset: number): EvidenceOperand {
  return operand.kind === 'step' ? { ...operand, index: operand.index + offset } : operand;
}

interface LoadedExceptionChain {
  readonly row: ScopedException;
  readonly steps: readonly EvidenceStep[];
  readonly citations: readonly EvidenceSourceCitation[];
  readonly as_of: string;
}

/**
 * One Exception's persisted chain, or `null` when it does not resolve for this Tenant.
 *
 * `null` rather than a throw as of task 12.7. An Exception whose Evidence_Chain cannot
 * be read is Requirement 12.3's condition — a contributing record the tool cannot
 * present — so the figure is **omitted** and the Exception's own cited Source_Record
 * types are reported as unavailable, which is what the caller can act on. A
 * `tool_failure` said only "something went wrong". The distinction matters because
 * these tools do not compose their figures: an Exception's impact *is* its persisted
 * chain's figure, so an unreadable chain is an unreadable contributor and nothing else.
 *
 * A chain that resolves and disagrees with the Exception's impact still throws: that is
 * corruption rather than unavailability, and presenting either number would be a guess.
 */
async function loadExceptionChain(
  reader: EvidenceChainBuilder,
  row: ScopedException,
): Promise<LoadedExceptionChain | null> {
  const view = await reader.read(row.evidence_chain_id, MAX_SOURCE_PAGE_SIZE);
  if (view === null) {
    return null;
  }
  if (view.figure_paise !== row.impact_paise) {
    throw new ExceptionToolError(
      `Exception ${row.exception_id} impact does not equal its persisted Evidence_Chain figure`,
    );
  }
  const entries: EvidenceSourceEntry[] = [...view.first_page.sources];
  let cursor = view.first_page.next;
  while (cursor !== null) {
    const page = await reader.sourcePage(row.evidence_chain_id, cursor, MAX_SOURCE_PAGE_SIZE);
    if (page === null) {
      throw new ExceptionToolError(`Evidence_Chain ${row.evidence_chain_id} disappeared during retrieval`);
    }
    entries.push(...page.sources);
    cursor = page.next;
  }
  const identities = new Set(entries.map((entry) => `${entry.ref.type}\u0000${entry.ref.id}`));
  if (identities.size !== view.source_count || identities.size !== entries.length) {
    throw new ExceptionToolError(
      `Evidence_Chain ${row.evidence_chain_id} source pages do not match source_count`,
    );
  }
  const citations = entries.flatMap((entry) =>
    entry.fields.map((field) => ({
      ref: entry.ref,
      field,
      record_updated_at: entry.record_updated_at,
    })),
  );
  return { row, steps: view.steps, citations, as_of: view.as_of };
}

/** A composable aggregate, or Requirement 12.3's withheld figure. */
export type ExceptionAggregate =
  | {
      readonly ok: true;
      readonly input: EvidenceChainInput;
      readonly asOfByException: ReadonlyMap<string, string>;
    }
  | IncompleteEvidence;

/**
 * Inline persisted exception chains, then sum their terminal results exactly.
 *
 * Answers `incomplete_evidence` where any contributing Exception's chain cannot be read,
 * naming that Exception's own Source_Record types (Requirement 12.3). The aggregate spans
 * the whole filtered set, so one unreadable contributor withholds the whole figure rather
 * than quietly summing the rest.
 *
 * @throws {ExceptionToolError} for an empty scope, which has no storable chain at all —
 * `evidence_chains.source_count >= 1` — and is the shared gap tasks 12.1 through 12.6
 * escalated rather than patched.
 */
export async function aggregateExceptionChainInput(
  producedBy: string,
  rows: readonly ScopedException[],
  reader: EvidenceChainBuilder,
): Promise<ExceptionAggregate> {
  if (rows.length === 0) {
    throw new ExceptionToolError(
      `${producedBy} found no Exception in the requested lifecycle scope; an aggregate 0 paise ` +
        `would cite no Source_Record and evidence_chains.source_count >= 1 forbids that shape`,
    );
  }
  const loaded: LoadedExceptionChain[] = [];
  const unreadable: SourceRef[] = [];
  for (const row of rows) {
    const chain = await loadExceptionChain(reader, row);
    if (chain === null) {
      unreadable.push(...unreadableRefsOf(row));
      continue;
    }
    loaded.push(chain);
  }
  if (unreadable.length > 0) {
    return incompleteEvidence(unreadable);
  }

  const steps: EvidenceStep[] = [];
  const citations: EvidenceSourceCitation[] = [];
  const terminals: EvidenceOperand[] = [];
  for (const chain of loaded) {
    const offset = steps.length;
    for (const step of chain.steps) {
      steps.push({
        ...step,
        index: step.index + offset,
        operands: step.operands.map((operand) => shiftedOperand(operand, offset)),
      });
    }
    terminals.push({ kind: 'step', index: steps.length });
    citations.push(...chain.citations);
  }
  if (steps.length + 1 > MAX_STEP_INDEX) {
    throw new ExceptionToolError(`the aggregate would exceed ${MAX_STEP_INDEX} Evidence_Chain steps`);
  }
  const aggregateImpact = sum(rows.map((row) => row.impact_paise));
  steps.push({
    index: steps.length + 1,
    operation: 'sum',
    operands: terminals,
    result_paise: aggregateImpact,
    note: 'exact sum of persisted Exception impact Evidence_Chains across the full filtered set',
  });
  return {
    ok: true,
    input: { produced_by: producedBy, figure_paise: aggregateImpact, steps, sources: citations },
    asOfByException: new Map(loaded.map((chain) => [chain.row.exception_id, chain.as_of])),
  };
}

/**
 * The Source_Records to report unavailable for an Exception whose chain cannot be read.
 *
 * The Exception row carries them, so they are known even when the chain is not: that is
 * what makes Requirement 12.3's "identify the unavailable source record types" answerable
 * here at all. An Exception with no cited Source_Record could not be reported this way,
 * and is refused rather than reported as an empty `unavailable` list, which
 * `incompleteEvidence` forbids.
 *
 * @throws {ExceptionToolError} for an Exception citing no Source_Record.
 */
export function unreadableRefsOf(row: ScopedException): readonly SourceRef[] {
  if (row.source_records.length === 0) {
    throw new ExceptionToolError(
      `Exception ${row.exception_id} references an Evidence_Chain that does not resolve and ` +
        `cites no Source_Record, so there is no unavailable type to report (Requirement 12.3)`,
    );
  }
  return row.source_records;
}

export const evidenceSourceEntrySchema = z.strictObject({
  ref: sourceRefSchema,
  fields: z.array(z.string().min(1).max(128)).min(1),
  record_updated_at: z.iso.datetime(),
  as_of: z.iso.datetime(),
  stale: z.boolean(),
});

export const exceptionEvidenceSchema = z.strictObject({
  evidence_chain_id: z.uuid(),
  figure_paise: paise,
  source_count: z.number().int().positive(),
  as_of: z.iso.datetime(),
  produced_by: z.string().min(1).max(64),
  steps: z.array(z.unknown()).min(1),
  sources: z.array(evidenceSourceEntrySchema).max(MAX_SOURCE_PAGE_SIZE),
  source_page: z.strictObject({
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(MAX_SOURCE_PAGE_SIZE),
    next_offset: z.number().int().nonnegative().nullable(),
    total: z.number().int().positive(),
  }),
  stale: z.boolean(),
});

export type ExceptionEvidence = z.infer<typeof exceptionEvidenceSchema>;

/** Retrieve every keyset page once, then expose the requested offset window. */
export async function exceptionEvidencePage(
  reader: EvidenceChainBuilder,
  chainId: string,
  page: { readonly offset: number; readonly limit: number },
): Promise<ExceptionEvidence | null> {
  const view = await reader.read(chainId, 1);
  if (view === null) return null;
  const all: EvidenceSourceEntry[] = [];
  for await (const sourcePage of reader.sourcePages(chainId, MAX_SOURCE_PAGE_SIZE)) {
    all.push(...sourcePage.sources);
  }
  const identities = new Set(all.map((entry) => `${entry.ref.type}\u0000${entry.ref.id}`));
  if (all.length !== view.source_count || identities.size !== view.source_count) {
    throw new ExceptionToolError(`Evidence_Chain ${chainId} pages omit or duplicate Source_Record identifiers`);
  }
  const sources = all.slice(page.offset, page.offset + page.limit);
  const nextOffset = page.offset + sources.length < all.length ? page.offset + sources.length : null;
  return {
    evidence_chain_id: view.evidence_chain_id,
    figure_paise: view.figure_paise,
    source_count: view.source_count,
    as_of: view.as_of,
    produced_by: view.produced_by,
    steps: [...view.steps],
    sources: sources.map((entry) => ({ ...entry, fields: [...entry.fields] })),
    source_page: { offset: page.offset, limit: page.limit, next_offset: nextOffset, total: all.length },
    stale: all.some((entry) => entry.stale),
  };
}

/** ToolResult's shared envelope projected onto the requested retrievable source page. */
export function envelopeFromExceptionEvidence(evidence: ExceptionEvidence): EvidenceChain {
  return {
    evidence_chain_id: evidence.evidence_chain_id,
    figure_paise: evidence.figure_paise,
    sources: evidence.sources.map((entry) => entry.ref),
    source_count: evidence.source_count,
    steps: evidence.steps as readonly EvidenceStep[],
    as_of: evidence.as_of,
    produced_by: evidence.produced_by,
  };
}
