/** Pure presentation model for task 14.3's Evidence panel. Requirements 12.4, 12.5. */
import { EVIDENCE_OPERATIONS, UI_SOURCE_PAGE_SIZE, type EvidenceOperand } from '@/evidence/chain-builder';
import { formatIst, formatIstIso } from '@/format/ist';
import type { ExceptionEvidence } from '@/tools/exception-tools';

export interface EvidencePageRequest {
  readonly offset: number;
  readonly limit: typeof UI_SOURCE_PAGE_SIZE;
}

export interface EvidenceOperandView {
  readonly kind: EvidenceOperand['kind'];
  readonly text: string;
}

export interface EvidenceStepView {
  readonly index: number;
  readonly operation: string;
  readonly operands: readonly EvidenceOperandView[];
  readonly note: string | null;
}

export interface EvidencePageLinkView {
  readonly number: number;
  readonly current: boolean;
  readonly request: EvidencePageRequest;
}

export interface EvidencePanelView {
  readonly chainId: string;
  readonly asOf: { readonly text: string; readonly machine: string };
  readonly sourceCount: number;
  readonly pageNumber: number;
  readonly pageCount: number;
  readonly pageLinks: readonly EvidencePageLinkView[];
  readonly stale: boolean;
  readonly staleText: string | null;
  readonly steps: readonly EvidenceStepView[];
  readonly sources: ExceptionEvidence['sources'];
}

export class EvidencePanelViewError extends Error {
  override readonly name = 'EvidencePanelViewError';
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EvidencePanelViewError(`${where} is not an object`);
  }
  return value as Record<string, unknown>;
}

function operandView(value: unknown, where: string): EvidenceOperandView {
  const operand = object(value, where);
  switch (operand.kind) {
    case 'source': {
      const ref = object(operand.ref, `${where}.ref`);
      if (typeof ref.type !== 'string' || typeof ref.id !== 'string' || typeof operand.field !== 'string') {
        throw new EvidencePanelViewError(`${where} has an invalid Source_Record reference`);
      }
      return { kind: 'source', text: `${ref.type}:${ref.id}.${operand.field}` };
    }
    case 'step':
      if (!Number.isSafeInteger(operand.index) || (operand.index as number) < 1) {
        throw new EvidencePanelViewError(`${where} has an invalid preceding-step reference`);
      }
      return { kind: 'step', text: `step ${String(operand.index)}` };
    case 'literal':
      if (typeof operand.value !== 'string') {
        throw new EvidencePanelViewError(`${where} has a non-string literal`);
      }
      return { kind: 'literal', text: `literal ${operand.value}` };
    default:
      throw new EvidencePanelViewError(`${where} has an unknown operand kind`);
  }
}

function stepView(value: unknown, position: number): EvidenceStepView {
  const step = object(value, `steps[${position}]`);
  const expectedIndex = position + 1;
  if (step.index !== expectedIndex) {
    throw new EvidencePanelViewError(`steps are not in stated 1-based order at position ${position}`);
  }
  if (typeof step.operation !== 'string' || !(EVIDENCE_OPERATIONS as readonly string[]).includes(step.operation)) {
    throw new EvidencePanelViewError(`step ${expectedIndex} has an unknown operation`);
  }
  if (!Array.isArray(step.operands) || step.operands.length === 0) {
    throw new EvidencePanelViewError(`step ${expectedIndex} has no operand references`);
  }
  if (step.note !== undefined && typeof step.note !== 'string') {
    throw new EvidencePanelViewError(`step ${expectedIndex} has an invalid note`);
  }
  return {
    index: expectedIndex,
    operation: step.operation,
    operands: step.operands.map((operand, index) => operandView(operand, `step ${expectedIndex} operand ${index}`)),
    note: typeof step.note === 'string' ? step.note : null,
  };
}

function pageLinks(total: number, offset: number): readonly EvidencePageLinkView[] {
  const pageCount = Math.ceil(total / UI_SOURCE_PAGE_SIZE);
  const current = offset / UI_SOURCE_PAGE_SIZE + 1;
  return Array.from({ length: pageCount }, (_unused, index) => ({
    number: index + 1,
    current: index + 1 === current,
    request: { offset: index * UI_SOURCE_PAGE_SIZE, limit: UI_SOURCE_PAGE_SIZE },
  }));
}

/**
 * Project one persisted `get_exception_evidence` page without recomputing any figure,
 * operation, source timestamp, as-of timestamp, or stale decision.
 */
export function evidencePanelView(evidence: ExceptionEvidence): EvidencePanelView {
  const { source_page: page } = evidence;
  if (page.total !== evidence.source_count) {
    throw new EvidencePanelViewError('source_page.total does not equal the persisted source_count');
  }
  if (page.limit > UI_SOURCE_PAGE_SIZE || evidence.sources.length > UI_SOURCE_PAGE_SIZE) {
    throw new EvidencePanelViewError(`Evidence panel pages may contain at most ${UI_SOURCE_PAGE_SIZE} identifiers`);
  }
  if (page.offset % UI_SOURCE_PAGE_SIZE !== 0) {
    throw new EvidencePanelViewError(`Evidence panel offsets must align to ${UI_SOURCE_PAGE_SIZE}-identifier pages`);
  }
  if (page.total > UI_SOURCE_PAGE_SIZE && page.limit !== UI_SOURCE_PAGE_SIZE) {
    throw new EvidencePanelViewError(`multi-page Evidence panel requests must use ${UI_SOURCE_PAGE_SIZE}-identifier pages`);
  }
  if (evidence.sources.length > page.limit) {
    throw new EvidencePanelViewError('the tool returned more identifiers than the requested page limit');
  }
  if (page.offset >= page.total) {
    throw new EvidencePanelViewError('the requested Evidence panel page is outside the source set');
  }

  const links = pageLinks(page.total, page.offset);
  const pageNumber = page.offset / UI_SOURCE_PAGE_SIZE + 1;
  return {
    chainId: evidence.evidence_chain_id,
    asOf: { text: formatIst(evidence.as_of), machine: formatIstIso(evidence.as_of) },
    sourceCount: evidence.source_count,
    pageNumber,
    pageCount: links.length,
    pageLinks: links,
    stale: evidence.stale,
    staleText: evidence.stale
      ? 'Stale: at least one referenced Source_Record changed after this Evidence_Chain as-of timestamp.'
      : null,
    steps: evidence.steps.map(stepView),
    sources: evidence.sources,
  };
}