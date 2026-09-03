import {
  canonicalSourceRefs,
  createExceptionUpserter,
  EXCEPTION_CATEGORIES,
  type ExceptionNotReopened,
  type ExceptionStore,
  type ExceptionUpsertInput,
  type ExceptionUpsertResult,
  sourceRefsSegment,
} from '@/agents/exception-fingerprint';
import { assertInRange, subtract, type Paise } from '@/calc/calculation-service';
import type { TenantId } from '@/config/configuration-service';
import type { SourceRef } from '@/ledger/posting-rules';
import type { DuplicateRefundCandidateRow } from '@/tools/get-duplicate-refund-candidates';
import type { MissingAccrualRow } from '@/tools/get-missing-accruals';
import type { UnsettledPaymentRow } from '@/tools/get-unsettled-payments';
import { toWire } from '@/wire/paise-wire';

import {
  ambiguousCandidateRefs,
  notMatchedTypes,
  type PaymentLifecycleMatch,
} from './match';

/** A Credit_Note read together with its stored Invoice link, never an inferred match. */
export interface CreditNoteReconciliation {
  readonly credit_note_id: string;
  readonly value_paise: Paise;
  readonly linked_invoice_id: string | null;
  /** The linked Invoice's stored adjusted value. Null only when there is no link. */
  readonly linked_invoice_adjusted_value_paise: Paise | null;
  readonly evidence_chain_id: string | null;
}

export type UnmatchedCreditNoteReason =
  | 'no_linked_invoice'
  | 'linked_invoice_adjusted_value_mismatch';

export class RemainingDetectorError extends Error {
  override readonly name = 'RemainingDetectorError';
}

const ref = (type: SourceRef['type'], id: string, role: string) => ({ type, id, role });

function nonNegative(value: Paise, what: string): void {
  assertInRange(value);
  if (value < 0n) throw new RemainingDetectorError(`${what} must be non-negative paise`);
}

/** Requirement 4.8. The row comes from the identifier-only duplicate-refund tool. */
export function possibleDuplicateRefundExceptionFor(
  row: DuplicateRefundCandidateRow,
  detectedAt: string,
): ExceptionUpsertInput | null {
  nonNegative(row.payment_paise, `${row.payment_id}.payment_paise`);
  nonNegative(row.combined_refund_paise, `${row.payment_id}.combined_refund_paise`);
  const refundIds = [...new Set(row.refund_ids)].sort();
  if (refundIds.length < 2) return null;
  const computedExcess = subtract(row.combined_refund_paise, row.payment_paise);
  if (computedExcess <= 0n) return null;
  if (computedExcess !== row.excess_paise) {
    throw new RemainingDetectorError(
      `${row.payment_id}.excess_paise disagrees with combined refunds minus Payment`,
    );
  }

  return {
    category: 'possible_duplicate_refund',
    source_refs: [
      ref('payment', row.payment_id, 'payment'),
      ...refundIds.map((id) => ref('refund', id, 'contributing_refund')),
    ],
    impact_paise: computedExcess,
    direction: 'not_applicable',
    detail: {
      failing_rule: 'combined_refunds_exceed_payment',
      payment_paise: toWire(row.payment_paise),
      combined_refund_paise: toWire(row.combined_refund_paise),
      excess_paise: toWire(computedExcess),
      refund_count: refundIds.length,
    },
    evidence_chain_id: row.evidence_chain_id,
    detected_at: detectedAt,
  };
}
/** Requirement 4.9 and the glossary definition of Unmatched_Credit_Note. */
export function unmatchedCreditNoteExceptionFor(
  note: CreditNoteReconciliation,
  detectedAt: string,
): ExceptionUpsertInput | null {
  nonNegative(note.value_paise, `${note.credit_note_id}.value_paise`);

  let reason: UnmatchedCreditNoteReason;
  if (note.linked_invoice_id === null) {
    if (note.linked_invoice_adjusted_value_paise !== null) {
      throw new RemainingDetectorError(
        `${note.credit_note_id} has an adjusted Invoice value but no stored Invoice link`,
      );
    }
    reason = 'no_linked_invoice';
  } else {
    const adjusted = note.linked_invoice_adjusted_value_paise;
    if (adjusted === null) {
      throw new RemainingDetectorError(
        `${note.credit_note_id} links Invoice ${note.linked_invoice_id} without its adjusted value`,
      );
    }
    nonNegative(adjusted, `${note.linked_invoice_id}.adjusted_value_paise`);
    if (adjusted === note.value_paise) return null;
    reason = 'linked_invoice_adjusted_value_mismatch';
  }

  const sourceRefs = [ref('credit_note', note.credit_note_id, 'credit_note')];
  if (note.linked_invoice_id !== null) {
    sourceRefs.push(ref('razorpay_invoice', note.linked_invoice_id, 'linked_invoice'));
  }
  return {
    category: 'unmatched_credit_note',
    source_refs: sourceRefs,
    impact_paise: note.value_paise,
    direction: 'not_applicable',
    detail: {
      failing_rule: reason,
      credit_note_value_paise: toWire(note.value_paise),
      ...(note.linked_invoice_adjusted_value_paise === null
        ? {}
        : {
            linked_invoice_adjusted_value_paise: toWire(
              note.linked_invoice_adjusted_value_paise,
            ),
          }),
    },
    evidence_chain_id: note.evidence_chain_id,
    detected_at: detectedAt,
  };
}

/** Requirement 4.10. Payment absence is confirmed through notMatchedTypes. */
export function missingAccrualExceptionFor(
  row: MissingAccrualRow,
  lifecycleByPayment: ReadonlyMap<string, PaymentLifecycleMatch>,
  detectedAt: string,
): ExceptionUpsertInput | null {
  nonNegative(row.amount_paise, `${row.ref.type}:${row.ref.id}.amount_paise`);
  if (row.ref.type === 'payment') {
    const lifecycle = lifecycleByPayment.get(row.ref.id);
    if (lifecycle === undefined) {
      throw new RemainingDetectorError(
        `missing-accrual Payment ${row.ref.id} has no identifier-only lifecycle result`,
      );
    }
    if (!notMatchedTypes(lifecycle).includes('ledger_entries')) return null;
  }

  return {
    category: 'missing_accrual',
    source_refs: [ref(row.ref.type, row.ref.id, 'source_without_ledger_entry')],
    impact_paise: row.amount_paise,
    direction: 'not_applicable',
    detail: {
      failing_rule: 'no_referencing_ledger_entry',
      source_record_type: row.ref.type,
      amount_paise: toWire(row.amount_paise),
    },
    evidence_chain_id: row.evidence_chain_id,
    detected_at: detectedAt,
  };
}

/** Requirement 4.14. ambiguousCandidateRefs supplies every stored-link candidate. */
export function ambiguousMatchExceptionFor(
  match: PaymentLifecycleMatch,
  detectedAt: string,
): ExceptionUpsertInput | null {
  const refs = ambiguousCandidateRefs(match);
  if (refs.length === 0) return null;
  return {
    category: 'ambiguous_match',
    source_refs: refs.map((source) => ({ ...source, role: source.type === 'payment' ? 'payment' : 'candidate' })),
    impact_paise: 0n,
    direction: 'not_applicable',
    detail: {
      failing_rule: 'multiple_identifier_link_candidates',
      candidate_count: refs.length - 1,
      settlement_candidate_count:
        match.settlement.kind === 'ambiguous' ? match.settlement.candidate_ids.length : 0,
      razorpay_invoice_candidate_count:
        match.razorpay_invoice.kind === 'ambiguous'
          ? match.razorpay_invoice.candidate_ids.length
          : 0,
    },
    evidence_chain_id: null,
    detected_at: detectedAt,
  };
}

/** Excludes both Settlement ambiguity and Invoice-only ambiguity from unsettled rows. */
export function excludeAmbiguousMatchesFromUnsettled<T extends Pick<UnsettledPaymentRow, 'payment_id'>>(
  rows: readonly T[],
  matches: readonly PaymentLifecycleMatch[],
): readonly T[] {
  const excluded = new Set(
    matches.filter((match) => ambiguousCandidateRefs(match).length > 0).map((match) => match.payment_id),
  );
  return rows.filter((row) => !excluded.has(row.payment_id));
}
export interface RemainingDetectorRunInput {
  readonly duplicate_refunds: readonly DuplicateRefundCandidateRow[];
  readonly credit_notes: readonly CreditNoteReconciliation[];
  readonly missing_accruals: readonly MissingAccrualRow[];
  readonly lifecycle_matches: readonly PaymentLifecycleMatch[];
  readonly detected_at: string;
}

export interface RemainingDetectorDetection {
  readonly exception: ExceptionUpsertInput;
  readonly outcome: ExceptionUpsertResult;
}

export interface RemainingDetectorRunReport {
  readonly detections: readonly RemainingDetectorDetection[];
  readonly created_count: number;
  readonly updated_count: number;
  readonly not_reopened_count: number;
  readonly not_reopened: readonly ExceptionNotReopened[];
  /** Ascending and suitable for filtering get_unsettled_payments output. */
  readonly unsettled_excluded_payment_ids: readonly string[];
}

export interface RemainingDetectorRunner {
  run(input: RemainingDetectorRunInput): Promise<RemainingDetectorRunReport>;
}

export interface RemainingDetectorDeps {
  readonly tenantId: TenantId;
  readonly exceptions: ExceptionStore;
}

function compareExceptions(left: ExceptionUpsertInput, right: ExceptionUpsertInput): number {
  const category =
    EXCEPTION_CATEGORIES.indexOf(left.category) - EXCEPTION_CATEGORIES.indexOf(right.category);
  if (category !== 0) return category;
  if (left.impact_paise !== right.impact_paise) return left.impact_paise > right.impact_paise ? -1 : 1;
  const leftRefs = sourceRefsSegment(left.source_refs);
  const rightRefs = sourceRefsSegment(right.source_refs);
  return leftRefs === rightRefs ? 0 : leftRefs < rightRefs ? -1 : 1;
}

function lifecycleIndex(
  matches: readonly PaymentLifecycleMatch[],
): ReadonlyMap<string, PaymentLifecycleMatch> {
  const result = new Map<string, PaymentLifecycleMatch>();
  for (const match of matches) {
    if (result.has(match.payment_id)) {
      throw new RemainingDetectorError(`duplicate lifecycle result for ${match.payment_id}`);
    }
    result.set(match.payment_id, match);
  }
  return result;
}

function assertUniqueConditions(exceptions: readonly ExceptionUpsertInput[]): void {
  const identities = new Set<string>();
  for (const exception of exceptions) {
    const key = `${exception.category}|${sourceRefsSegment(canonicalSourceRefs(exception.source_refs))}`;
    if (identities.has(key)) {
      throw new RemainingDetectorError(`duplicate detector condition ${key}`);
    }
    identities.add(key);
  }
}

/** Runs the four thin detector slices and reuses the shared fingerprint/upsert lifecycle. */
export function createRemainingDetectorRunner(deps: RemainingDetectorDeps): RemainingDetectorRunner {
  const upserter = createExceptionUpserter({ store: deps.exceptions, tenantId: deps.tenantId });
  return {
    async run(input): Promise<RemainingDetectorRunReport> {
      const byPayment = lifecycleIndex(input.lifecycle_matches);
      const pending: ExceptionUpsertInput[] = [];
      for (const row of input.duplicate_refunds) {
        const exception = possibleDuplicateRefundExceptionFor(row, input.detected_at);
        if (exception !== null) pending.push(exception);
      }
      for (const note of input.credit_notes) {
        const exception = unmatchedCreditNoteExceptionFor(note, input.detected_at);
        if (exception !== null) pending.push(exception);
      }
      for (const row of input.missing_accruals) {
        const exception = missingAccrualExceptionFor(row, byPayment, input.detected_at);
        if (exception !== null) pending.push(exception);
      }
      for (const match of input.lifecycle_matches) {
        const exception = ambiguousMatchExceptionFor(match, input.detected_at);
        if (exception !== null) pending.push(exception);
      }

      assertUniqueConditions(pending);
      pending.sort(compareExceptions);
      const detections: RemainingDetectorDetection[] = [];
      for (const exception of pending) {
        detections.push({ exception, outcome: await upserter.upsert(exception) });
      }
      const notReopened = detections
        .map((detection) => detection.outcome)
        .filter((outcome): outcome is ExceptionNotReopened => !outcome.ok);
      const successful = detections
        .map((detection) => detection.outcome)
        .filter((outcome): outcome is Extract<ExceptionUpsertResult, { ok: true }> => outcome.ok);
      const unsettledExcluded = input.lifecycle_matches
        .filter((match) => ambiguousCandidateRefs(match).length > 0)
        .map((match) => match.payment_id)
        .sort();

      return {
        detections,
        created_count: successful.filter((outcome) => outcome.created).length,
        updated_count: successful.filter((outcome) => !outcome.created).length,
        not_reopened_count: notReopened.length,
        not_reopened: notReopened,
        unsettled_excluded_payment_ids: unsettledExcluded,
      };
    },
  };
}
