import {
  canonicalSourceRefs,
  createExceptionUpserter,
  EXCEPTION_CATEGORIES,
  type ExceptionNotReopened,
  type ExceptionScope,
  type ExceptionStore,
  type ExceptionUpsertInput,
  type ExceptionUpsertResult,
  sourceRefsSegment,
} from '@/agents/exception-fingerprint';
import { assertInRange, subtract, sum, type Paise } from '@/calc/calculation-service';
import type { TenantId } from '@/config/configuration-service';
import type { DateOnly, SourceRef } from '@/ledger/posting-rules';
import { assertDateOnlyValue, type DateRange } from '@/tools/settlement-scope';
import { toWire } from '@/wire/paise-wire';

import {
  assertRouteReconciliationRange,
  expectedSellerPayout,
  type RoutePaymentSplit,
} from './route-split';

/** A Settlement received by one Razorpay Route Linked_Account. */
export interface RouteSellerSettlement {
  readonly settlement_id: string;
  readonly linked_account_id: string;
  readonly settlement_date: DateOnly;
  readonly received_paise: Paise;
}

export class MarketplaceExceptionError extends Error {
  override readonly name = 'MarketplaceExceptionError';
}

interface DetectionBase {
  readonly range: DateRange;
  readonly detected_at: string;
  readonly evidence_chain_id?: string | null;
}

export interface SellerMismatchDetectionInput extends DetectionBase {
  readonly linked_account_id: string;
  readonly splits: readonly RoutePaymentSplit[];
  readonly settlements: readonly RouteSellerSettlement[];
}
function nonEmpty(value: string, what: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MarketplaceExceptionError(`${what} must be a non-empty stored identifier`);
  }
  return value;
}

function nonNegative(value: Paise, what: string): Paise {
  assertInRange(value);
  if (value < 0n) throw new MarketplaceExceptionError(`${what} must be non-negative paise`);
  return value;
}

const ref = (type: SourceRef['type'], id: string, role: string) => ({ type, id, role });

function inRangeSettlements(
  rows: readonly RouteSellerSettlement[],
  range: DateRange,
  linkedAccountId?: string,
): readonly RouteSellerSettlement[] {
  const seen = new Set<string>();
  const result: RouteSellerSettlement[] = [];
  for (const row of rows) {
    nonEmpty(row.settlement_id, 'settlement_id');
    nonEmpty(row.linked_account_id, `${row.settlement_id}.linked_account_id`);
    assertDateOnlyValue(row.settlement_date, `${row.settlement_id}.settlement_date`);
    nonNegative(row.received_paise, `${row.settlement_id}.received_paise`);
    if (row.settlement_date < range.from || row.settlement_date > range.to) continue;
    if (seen.has(row.settlement_id)) {
      throw new MarketplaceExceptionError(`duplicate in-range Settlement ${row.settlement_id}`);
    }
    seen.add(row.settlement_id);
    if (linkedAccountId === undefined || row.linked_account_id === linkedAccountId) result.push(row);
  }
  return result.sort((a, b) =>
    a.settlement_id < b.settlement_id ? -1 : a.settlement_id > b.settlement_id ? 1 : 0,
  );
}

function sellerContextRefs(
  splits: readonly RoutePaymentSplit[],
  settlements: readonly RouteSellerSettlement[],
  linkedAccountId: string,
) {
  const transfers = splits
    .flatMap((split) => split.transfers)
    .filter(
      (transfer) =>
        transfer.linked_account_id === linkedAccountId && !transfer.on_hold,
    );
  return [
    ...settlements.map((row) => ref('settlement', row.settlement_id, 'received_settlement')),
    ...transfers.map((row) => ref('transfer', row.transfer_id, 'contributing_transfer')),
    ...transfers.flatMap((transfer) =>
      transfer.transfer_reversals.map((row) =>
        ref('transfer_reversal', row.transfer_reversal_id, 'contributing_transfer_reversal'),
      ),
    ),
  ];
}

/** Requirements 7.3 and 7.8: zero received Settlements are pending, never mismatched. */
export function sellerSettlementMismatchExceptionFor(
  input: SellerMismatchDetectionInput,
): ExceptionUpsertInput | null {
  const range = assertRouteReconciliationRange(input.range);
  const linkedAccountId = nonEmpty(input.linked_account_id, 'linked_account_id');
  const settlements = inRangeSettlements(input.settlements, range, linkedAccountId);
  if (settlements.length === 0) return null;

  const expected = expectedSellerPayout(input.splits, linkedAccountId);
  const received = sum(settlements.map((row) => row.received_paise));
  const difference = subtract(expected, received);
  if (difference === 0n) return null;

  return {
    category: 'seller_settlement_mismatch',
    source_refs: [ref('linked_account', linkedAccountId, 'linked_account')],
    context_refs: sellerContextRefs(input.splits, settlements, linkedAccountId),
    scope: range,
    impact_paise: difference < 0n ? -difference : difference,
    direction: difference > 0n ? 'shortfall' : 'excess',
    detail: {
      failing_rule: 'expected_seller_payout_differs_from_received_settlements',
      expected_payout_paise: toWire(expected),
      received_settlement_paise: toWire(received),
      difference_paise: toWire(difference),
      settlement_count: settlements.length,
    },
    evidence_chain_id: input.evidence_chain_id ?? null,
    detected_at: input.detected_at,
  };
}
export interface OverAllocatedSplitDetectionInput extends DetectionBase {
  readonly split: RoutePaymentSplit;
}

/** Requirement 7.7: allocation uses gross Transfers, not reversal-adjusted net Transfers. */
export function overAllocatedSplitExceptionFor(
  input: OverAllocatedSplitDetectionInput,
): ExceptionUpsertInput | null {
  const range = assertRouteReconciliationRange(input.range);
  const split = input.split;
  nonEmpty(split.payment_id, 'payment_id');
  nonNegative(split.amount_paise, `${split.payment_id}.amount_paise`);
  if (split.created_on < range.from || split.created_on > range.to) {
    throw new MarketplaceExceptionError(
      `Payment ${split.payment_id} is outside the reconciliation range ${range.from}..${range.to}`,
    );
  }
  const allocated = sum(
    split.transfers.map((transfer) =>
      nonNegative(transfer.amount_paise, `${transfer.transfer_id}.amount_paise`),
    ),
  );
  const excess = subtract(allocated, split.amount_paise);
  if (excess <= 0n) return null;

  return {
    category: 'over_allocated_split',
    source_refs: [ref('payment', split.payment_id, 'payment')],
    context_refs: split.transfers.map((transfer) =>
      ref('transfer', transfer.transfer_id, 'contributing_transfer'),
    ),
    scope: range,
    impact_paise: excess,
    direction: 'not_applicable',
    detail: {
      failing_rule: 'sum_of_transfers_exceeds_payment',
      payment_paise: toWire(split.amount_paise),
      allocated_transfer_paise: toWire(allocated),
      excess_paise: toWire(excess),
      transfer_count: split.transfers.length,
    },
    evidence_chain_id: input.evidence_chain_id ?? null,
    detected_at: input.detected_at,
  };
}

export interface MarketplaceExceptionRunInput {
  readonly range: DateRange;
  readonly splits: readonly RoutePaymentSplit[];
  readonly settlements: readonly RouteSellerSettlement[];
  readonly detected_at: string;
  readonly seller_evidence_chain_ids?: ReadonlyMap<string, string | null>;
  readonly payment_evidence_chain_ids?: ReadonlyMap<string, string | null>;
}

export interface MarketplaceExceptionDetection {
  readonly exception: ExceptionUpsertInput;
  readonly outcome: ExceptionUpsertResult;
}

export interface MarketplaceExceptionRunReport {
  readonly detections: readonly MarketplaceExceptionDetection[];
  readonly created_count: number;
  readonly updated_count: number;
  readonly not_reopened_count: number;
  readonly not_reopened: readonly ExceptionNotReopened[];
}

export interface MarketplaceExceptionRunner {
  run(input: MarketplaceExceptionRunInput): Promise<MarketplaceExceptionRunReport>;
}

export interface MarketplaceExceptionRunnerDeps {
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

function conditionKey(exception: ExceptionUpsertInput): string {
  const scope = exception.scope as ExceptionScope;
  return `${exception.category}|${sourceRefsSegment(canonicalSourceRefs(exception.source_refs))}|${scope.from}..${scope.to}`;
}

/** Run both Marketplace detectors through the shared range-scoped fingerprint lifecycle. */
export function createMarketplaceExceptionRunner(
  deps: MarketplaceExceptionRunnerDeps,
): MarketplaceExceptionRunner {
  const upserter = createExceptionUpserter({ store: deps.exceptions, tenantId: deps.tenantId });
  return {
    async run(input): Promise<MarketplaceExceptionRunReport> {
      const range = assertRouteReconciliationRange(input.range);
      const paymentIds = new Set<string>();
      const linkedAccountIds = new Set<string>();
      for (const split of input.splits) {
        if (paymentIds.has(split.payment_id)) {
          throw new MarketplaceExceptionError(`duplicate in-scope Payment ${split.payment_id}`);
        }
        paymentIds.add(split.payment_id);
        for (const transfer of split.transfers) linkedAccountIds.add(transfer.linked_account_id);
      }
      for (const row of inRangeSettlements(input.settlements, range)) {
        linkedAccountIds.add(row.linked_account_id);
      }

      const pending: ExceptionUpsertInput[] = [];
      for (const linkedAccountId of [...linkedAccountIds].sort()) {
        const exception = sellerSettlementMismatchExceptionFor({
          range,
          linked_account_id: linkedAccountId,
          splits: input.splits,
          settlements: input.settlements,
          detected_at: input.detected_at,
          evidence_chain_id: input.seller_evidence_chain_ids?.get(linkedAccountId) ?? null,
        });
        if (exception !== null) pending.push(exception);
      }
      for (const split of input.splits) {
        const exception = overAllocatedSplitExceptionFor({
          range,
          split,
          detected_at: input.detected_at,
          evidence_chain_id: input.payment_evidence_chain_ids?.get(split.payment_id) ?? null,
        });
        if (exception !== null) pending.push(exception);
      }

      const identities = new Set<string>();
      for (const exception of pending) {
        const key = conditionKey(exception);
        if (identities.has(key)) throw new MarketplaceExceptionError(`duplicate detector condition ${key}`);
        identities.add(key);
      }
      pending.sort(compareExceptions);

      const detections: MarketplaceExceptionDetection[] = [];
      for (const exception of pending) {
        detections.push({ exception, outcome: await upserter.upsert(exception) });
      }
      const notReopened = detections
        .map(({ outcome }) => outcome)
        .filter((outcome): outcome is ExceptionNotReopened => !outcome.ok);
      const successful = detections
        .map(({ outcome }) => outcome)
        .filter((outcome): outcome is Extract<ExceptionUpsertResult, { ok: true }> => outcome.ok);
      return {
        detections,
        created_count: successful.filter(({ created }) => created).length,
        updated_count: successful.filter(({ created }) => !created).length,
        not_reopened_count: notReopened.length,
        not_reopened: notReopened,
      };
    },
  };
}
