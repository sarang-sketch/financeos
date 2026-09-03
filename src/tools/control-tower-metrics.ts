import { type Paise, subtract, sum } from '@/calc/calculation-service';
import type { TenantId } from '@/config/configuration-service';
import type {
  EvidenceChainInput,
  EvidenceOperand,
  EvidenceSourceCitation,
  SourceRef,
} from '@/evidence/chain-builder';
import { IST_OFFSET_MINUTES } from '@/format/ist';
import type { DateOnly } from '@/ledger/posting-rules';

import type { DateRange } from './settlement-scope';

export interface MetricAmountRecord {
  readonly ref: SourceRef;
  readonly field: string;
  readonly amount_paise: Paise;
  readonly record_updated_at: string;
  /** Completion time of the ingestion run that contributed this record. */
  readonly last_ingested_at: string;
}

export interface CashMetricRead {
  /** Settlement received amounts dated on or before `as_of`. */
  readonly settlements: readonly MetricAmountRecord[];
  /** Credits/outflows recorded against the ledger bank account on or before `as_of`. */
  readonly recorded_outflows: readonly MetricAmountRecord[];
  readonly unreadable?: readonly SourceRef[];
}

export interface Revenue30dMetricRead {
  /** Captured Payment gross amounts whose capture date is inside the requested range. */
  readonly captured_payments: readonly MetricAmountRecord[];
  /** Refund amounts whose creation date is inside the same requested range. */
  readonly refunds: readonly MetricAmountRecord[];
  readonly unreadable?: readonly SourceRef[];
}

export interface PendingSettlementMetricRead {
  /** Captured Payment gross amounts with no identifier link to a Settlement as of the date. */
  readonly captured_unlinked_payments: readonly MetricAmountRecord[];
  readonly unreadable?: readonly SourceRef[];
}

export interface CashMetricQuery {
  readonly tenant_id: TenantId;
  readonly as_of: DateOnly;
}

export interface Revenue30dMetricQuery {
  readonly tenant_id: TenantId;
  readonly range: DateRange;
}

export interface PendingSettlementMetricQuery {
  readonly tenant_id: TenantId;
  readonly as_of: DateOnly;
}

/** Injected read seams; task 26.x supplies RLS-bound `ctx.db` adapters. */
export interface CashMetricSource {
  read(query: CashMetricQuery, signal: AbortSignal): Promise<CashMetricRead>;
}

export interface Revenue30dMetricSource {
  read(query: Revenue30dMetricQuery, signal: AbortSignal): Promise<Revenue30dMetricRead>;
}

export interface PendingSettlementMetricSource {
  read(
    query: PendingSettlementMetricQuery,
    signal: AbortSignal,
  ): Promise<PendingSettlementMetricRead>;
}

export interface CalculatedMetric {
  readonly value_paise: Paise;
  readonly last_ingested_at: string;
  readonly evidence: EvidenceChainInput;
}

const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MS_PER_DAY = 86_400_000;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60 * 1000;

function assertTimestamp(value: string, field: string): string {
  if (!ISO_UTC_MS.test(value) || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${field} must be ISO-8601 UTC to millisecond precision`);
  }
  return value;
}

function recordKey(record: MetricAmountRecord): string {
  return `${record.ref.type}\u0000${record.ref.id}\u0000${record.field}`;
}

/** Total ordering makes the chain a function of the record set, not store row order. */
function ordered(records: readonly MetricAmountRecord[]): readonly MetricAmountRecord[] {
  const result = [...records].sort((left, right) =>
    recordKey(left) < recordKey(right) ? -1 : recordKey(left) > recordKey(right) ? 1 : 0,
  );
  for (let index = 1; index < result.length; index += 1) {
    if (recordKey(result[index] as MetricAmountRecord) === recordKey(result[index - 1] as MetricAmountRecord)) {
      throw new TypeError(`metric scope repeats Source_Record field ${recordKey(result[index] as MetricAmountRecord)}`);
    }
  }
  return result;
}

function latestIngestionAt(records: readonly MetricAmountRecord[]): string {
  let latest = '';
  for (const record of records) {
    const candidate = assertTimestamp(record.last_ingested_at, 'last_ingested_at');
    if (candidate > latest) latest = candidate;
  }
  if (latest === '') {
    throw new TypeError('a ready metric must have a contributing ingestion timestamp');
  }
  return latest;
}

function operand(record: MetricAmountRecord): EvidenceOperand {
  return { kind: 'source', ref: record.ref, field: record.field };
}

function citation(record: MetricAmountRecord): EvidenceSourceCitation {
  return {
    ref: record.ref,
    field: record.field,
    record_updated_at: assertTimestamp(record.record_updated_at, 'record_updated_at'),
  };
}

function operandsOrZero(records: readonly MetricAmountRecord[]): readonly EvidenceOperand[] {
  return records.length === 0
    ? [{ kind: 'literal', value: '0' }]
    : records.map(operand);
}

function calculated(
  producedBy: string,
  positive: readonly MetricAmountRecord[],
  negative: readonly MetricAmountRecord[],
  positiveNote: string,
  negativeNote: string,
): CalculatedMetric | null {
  const positives = ordered(positive);
  const negatives = ordered(negative);
  const all = [...positives, ...negatives];
  if (all.length === 0) return null;

  const positiveTotal = sum(positives.map((record) => record.amount_paise));
  const negativeTotal = sum(negatives.map((record) => record.amount_paise));
  const value = subtract(positiveTotal, negativeTotal);
  return {
    value_paise: value,
    last_ingested_at: latestIngestionAt(all),
    evidence: {
      produced_by: producedBy,
      figure_paise: value,
      steps: [
        {
          index: 1,
          operation: 'sum',
          operands: operandsOrZero(positives),
          result_paise: positiveTotal,
          note: positiveNote,
        },
        {
          index: 2,
          operation: 'sum',
          operands: operandsOrZero(negatives),
          result_paise: negativeTotal,
          note: negativeNote,
        },
        {
          index: 3,
          operation: 'subtract',
          operands: [
            { kind: 'step', index: 1 },
            { kind: 'step', index: 2 },
          ],
          result_paise: value,
          note: `${positiveNote} minus ${negativeNote}`,
        },
      ],
      sources: all.map(citation),
    },
  };
}

/** Requirement 3.1: Settlement received amounts minus recorded ledger outflows. */
export function calculateCash(
  producedBy: string,
  read: CashMetricRead,
): CalculatedMetric | null {
  return calculated(
    producedBy,
    read.settlements,
    read.recorded_outflows,
    'Σ Settlement received amounts as of the current date',
    'Σ outflows recorded against the ledger bank account as of the current date',
  );
}

/** Requirement 3.1: captured Payments minus Refunds in the trailing 30 dates. */
export function calculateRevenue30d(
  producedBy: string,
  read: Revenue30dMetricRead,
): CalculatedMetric | null {
  return calculated(
    producedBy,
    read.captured_payments,
    read.refunds,
    'Σ captured Payment gross amounts in the trailing 30 calendar days',
    'Σ Refund amounts in the trailing 30 calendar days',
  );
}

/** Requirement 3.1: captured Payment gross amounts not identifier-linked to a Settlement. */
export function calculatePendingSettlement(
  producedBy: string,
  read: PendingSettlementMetricRead,
): CalculatedMetric | null {
  const payments = ordered(read.captured_unlinked_payments);
  if (payments.length === 0) return null;
  const value = sum(payments.map((record) => record.amount_paise));
  return {
    value_paise: value,
    last_ingested_at: latestIngestionAt(payments),
    evidence: {
      produced_by: producedBy,
      figure_paise: value,
      steps: [
        {
          index: 1,
          operation: 'sum',
          operands: payments.map(operand),
          result_paise: value,
          note:
            'Σ captured Payment gross amounts having no stored Settlement identifier link',
        },
      ],
      sources: payments.map(citation),
    },
  };
}

/** The Indian calendar date containing the instant. */
export function istDateOf(instant: Date): DateOnly {
  return new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Exactly 30 inclusive calendar dates ending on the current Indian date. */
export function trailing30DateRange(instant: Date): DateRange {
  const to = istDateOf(instant);
  const from = new Date(Date.parse(`${to}T00:00:00.000Z`) - 29 * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
  return { from, to };
}
