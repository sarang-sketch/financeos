/**
 * Marketplace_Agent Route run and seller payout chain projection.
 *
 * Chain rows are built only from identifier-linked Route mappings, globally
 * ordered before truncation, and retain `bigint` paise throughout.
 * Requirements 7.4 and 7.5.
 */

import type { ExceptionStore } from '@/agents/exception-fingerprint';
import { assertInRange, subtract, sum, type Paise } from '@/calc/calculation-service';
import type { TenantId } from '@/config/configuration-service';
import { formatInr } from '@/format/inr';
import type { DateOnly } from '@/ledger/posting-rules';
import {
  assertDateOnlyValue,
  rangeLengthInDays,
  type DateRange,
} from '@/tools/settlement-scope';

import {
  createMarketplaceExceptionRunner,
  type MarketplaceExceptionRunReport,
  type RouteSellerSettlement,
} from './marketplace-exceptions';
import {
  assertRouteReconciliationRange,
  expectedSellerPayout,
  mapRouteSplits,
  type RoutePayment,
  type RoutePaymentSplit,
  type RouteTransfer,
  type RouteTransferReversal,
} from './route-split';

/** Requirement 7.5's hard cap, applied after the complete total order. */
export const MARKETPLACE_CHAIN_ROW_LIMIT = 200;

export class MarketplaceAgentError extends Error {
  override readonly name = 'MarketplaceAgentError';
}

/** Payment input for a run; `created_on` may be supplied as a consistency check. */
export interface MarketplaceAgentPayment extends Omit<RoutePayment, 'created_on'> {
  readonly created_at: string;
  readonly created_on?: DateOnly;
}

export interface MarketplaceChainRow {
  readonly payment_created_at: string;
  readonly payment_id: string;
  readonly transfer_id: string;
  readonly transfer_reversal_id: string | null;
  readonly razorpay_fee_paise: Paise;
  readonly gst_on_fee_paise: Paise;
  readonly platform_commission_paise: Paise;
}

export interface SellerOnHoldTransfer {
  readonly transfer_id: string;
  readonly amount_paise: Paise;
}

export interface SellerPayoutChain {
  readonly linked_account_id: string;
  /** Whether at least one in-range Settlement exists for comparison. */
  readonly classification: 'pending' | 'settlement_received';
  readonly expected_payout_paise: Paise;
  /** Held Transfers excluded from expected payout, ordered by stored identifier. */
  readonly on_hold: readonly SellerOnHoldTransfer[];
  readonly received_paise: Paise;
  /** Equal to expected payout only while classification is pending. */
  readonly pending_amount_paise: Paise | null;
  readonly pending_amount_inr: string | null;
  /** UTC calendar-day age at detection time; null unless the payout is pending with a Transfer. */
  readonly oldest_transfer_age_days: number | null;
  /** Signed `expected - received`; a payout-short question has a positive value. */
  readonly shortfall_paise: Paise;
  readonly shortfall_inr: string;
  readonly rows: readonly MarketplaceChainRow[];
  /** The task 19.4 tool-contract name for the full pre-truncation count. */
  readonly total_rows: number;
  /** Explicit alias naming what `total_rows` counts. */
  readonly total_contributing_row_count: number;
  readonly truncated: boolean;
}

export interface SellerPayoutChainInput {
  readonly range: DateRange;
  readonly as_of: DateOnly;
  readonly linked_account_id: string;
  readonly splits: readonly RoutePaymentSplit[];
  readonly settlements: readonly RouteSellerSettlement[];
  readonly payment_creation_timestamps: ReadonlyMap<string, string>;
  readonly transfer_creation_dates: ReadonlyMap<string, DateOnly>;
}

/** Transfer input with the stored timestamp needed for Requirement 7.8 ageing. */
export interface MarketplaceAgentTransfer extends RouteTransfer {
  readonly created_at: string;
}

export interface MarketplaceAgentRunInput {
  readonly range: DateRange;
  readonly linked_account_id: string;
  readonly payments: readonly MarketplaceAgentPayment[];
  readonly transfers: readonly MarketplaceAgentTransfer[];
  readonly transfer_reversals: readonly RouteTransferReversal[];
  readonly settlements: readonly RouteSellerSettlement[];
  readonly detected_at: string;
  readonly seller_evidence_chain_ids?: ReadonlyMap<string, string | null>;
  readonly payment_evidence_chain_ids?: ReadonlyMap<string, string | null>;
}

export interface MarketplaceAgentRunReport {
  readonly range: DateRange;
  readonly splits: readonly RoutePaymentSplit[];
  readonly payout_chain: SellerPayoutChain;
  readonly exceptions: MarketplaceExceptionRunReport;
}

export interface MarketplaceAgent {
  run(input: MarketplaceAgentRunInput): Promise<MarketplaceAgentRunReport>;
}

export interface MarketplaceAgentDeps {
  readonly tenantId: TenantId;
  readonly exceptions: ExceptionStore;
}

function identifier(value: string, what: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MarketplaceAgentError(`${what} must be a non-empty stored identifier`);
  }
  return value;
}

/** Normalize an offset-bearing ISO timestamp so lexical order is instant order. */
function creationTimestamp(value: string, paymentId: string): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    throw new MarketplaceAgentError(
      `${paymentId}.created_at must be an ISO-8601 timestamp with a UTC offset`,
    );
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new MarketplaceAgentError(`${paymentId}.created_at is not a real instant`);
  }
  return new Date(millis).toISOString();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Requirement 7.4's complete, deterministic row order. */
export function compareMarketplaceChainRows(
  left: MarketplaceChainRow,
  right: MarketplaceChainRow,
): number {
  return (
    compareText(left.payment_created_at, right.payment_created_at) ||
    compareText(left.payment_id, right.payment_id) ||
    compareText(left.transfer_id, right.transfer_id) ||
    compareText(left.transfer_reversal_id ?? '', right.transfer_reversal_id ?? '')
  );
}

/** Flatten one seller's identifier-linked mappings; no amount/date inferred links. */
export function sellerPayoutChainRows(
  splits: readonly RoutePaymentSplit[],
  linkedAccountId: string,
  paymentCreationTimestamps: ReadonlyMap<string, string>,
): readonly MarketplaceChainRow[] {
  identifier(linkedAccountId, 'linked_account_id');
  const rows: MarketplaceChainRow[] = [];

  for (const split of splits) {
    const createdAt = paymentCreationTimestamps.get(split.payment_id);
    if (createdAt === undefined) {
      throw new MarketplaceAgentError(
        `missing Payment creation timestamp for mapped Payment ${split.payment_id}`,
      );
    }
    for (const transfer of split.transfers) {
      if (transfer.linked_account_id !== linkedAccountId || transfer.on_hold) continue;
      const reversals = transfer.transfer_reversals.length === 0
        ? [null]
        : transfer.transfer_reversals;
      for (const reversal of reversals) {
        rows.push({
          payment_created_at: createdAt,
          payment_id: split.payment_id,
          transfer_id: transfer.transfer_id,
          transfer_reversal_id: reversal?.transfer_reversal_id ?? null,
          razorpay_fee_paise: split.fee_paise,
          gst_on_fee_paise: split.gst_on_fee_paise,
          platform_commission_paise: split.platform_commission_paise,
        });
      }
    }
  }

  return rows.sort(compareMarketplaceChainRows);
}

interface SellerSettlementSummary {
  readonly received_paise: Paise;
  readonly count: number;
}

function receivedForSeller(
  rows: readonly RouteSellerSettlement[],
  range: DateRange,
  linkedAccountId: string,
): SellerSettlementSummary {
  const seen = new Set<string>();
  const contributing: Paise[] = [];
  let count = 0;
  for (const row of rows) {
    identifier(row.settlement_id, 'settlement_id');
    identifier(row.linked_account_id, `${row.settlement_id}.linked_account_id`);
    assertDateOnlyValue(row.settlement_date, `${row.settlement_id}.settlement_date`);
    assertInRange(row.received_paise);
    if (row.received_paise < 0n) {
      throw new MarketplaceAgentError(`${row.settlement_id}.received_paise must be non-negative`);
    }
    if (row.settlement_date < range.from || row.settlement_date > range.to) continue;
    if (seen.has(row.settlement_id)) {
      throw new MarketplaceAgentError(`duplicate in-range Settlement ${row.settlement_id}`);
    }
    seen.add(row.settlement_id);
    if (row.linked_account_id === linkedAccountId) {
      contributing.push(row.received_paise);
      count += 1;
    }
  }
  return { received_paise: sum(contributing), count };
}

function oldestTransferAgeDays(
  splits: readonly RoutePaymentSplit[],
  linkedAccountId: string,
  creationDates: ReadonlyMap<string, DateOnly>,
  asOf: DateOnly,
): number | null {
  assertDateOnlyValue(asOf, 'as_of');
  let oldest: DateOnly | null = null;
  for (const transfer of splits.flatMap((split) => split.transfers)) {
    if (transfer.linked_account_id !== linkedAccountId || transfer.on_hold) continue;
    const createdOn = creationDates.get(transfer.transfer_id);
    if (createdOn === undefined) {
      throw new MarketplaceAgentError(
        `missing Transfer creation timestamp for mapped Transfer ${transfer.transfer_id}`,
      );
    }
    if (createdOn > asOf) {
      throw new MarketplaceAgentError(
        `${transfer.transfer_id}.created_at is after pending payout as_of ${asOf}`,
      );
    }
    if (oldest === null || createdOn < oldest) oldest = createdOn;
  }
  return oldest === null ? null : rangeLengthInDays({ from: oldest, to: asOf }) - 1;
}

function onHoldTransfersForSeller(
  splits: readonly RoutePaymentSplit[],
  linkedAccountId: string,
): readonly SellerOnHoldTransfer[] {
  return splits
    .flatMap((split) => split.transfers)
    .filter(
      (transfer) =>
        transfer.linked_account_id === linkedAccountId && transfer.on_hold,
    )
    .map((transfer) => ({
      transfer_id: transfer.transfer_id,
      amount_paise: transfer.amount_paise,
    }))
    .sort((left, right) => compareText(left.transfer_id, right.transfer_id));
}

/** Build the bounded answer only after counting and ordering every contributing row. */
export function buildSellerPayoutChain(input: SellerPayoutChainInput): SellerPayoutChain {
  const range = assertRouteReconciliationRange(input.range);
  const linkedAccountId = identifier(input.linked_account_id, 'linked_account_id');
  const expected = expectedSellerPayout(input.splits, linkedAccountId);
  const onHold = onHoldTransfersForSeller(input.splits, linkedAccountId);
  const settlementSummary = receivedForSeller(input.settlements, range, linkedAccountId);
  const received = settlementSummary.received_paise;
  const pending = settlementSummary.count === 0;
  const shortfall = subtract(expected, received);
  const allRows = sellerPayoutChainRows(
    input.splits,
    linkedAccountId,
    input.payment_creation_timestamps,
  );
  const total = allRows.length;

  return {
    linked_account_id: linkedAccountId,
    classification: pending ? 'pending' : 'settlement_received',
    expected_payout_paise: expected,
    on_hold: onHold,
    received_paise: received,
    pending_amount_paise: pending ? expected : null,
    pending_amount_inr: pending ? formatInr(expected) : null,
    oldest_transfer_age_days: pending
      ? oldestTransferAgeDays(
          input.splits,
          linkedAccountId,
          input.transfer_creation_dates,
          input.as_of,
        )
      : null,
    shortfall_paise: shortfall,
    shortfall_inr: formatInr(shortfall),
    rows: allRows.slice(0, MARKETPLACE_CHAIN_ROW_LIMIT),
    total_rows: total,
    total_contributing_row_count: total,
    truncated: total > MARKETPLACE_CHAIN_ROW_LIMIT,
  };
}

/** Compose Route mapping, Marketplace detectors, and the seller-specific chain answer. */
export function createMarketplaceAgent(deps: MarketplaceAgentDeps): MarketplaceAgent {
  const exceptionRunner = createMarketplaceExceptionRunner(deps);
  return {
    async run(input): Promise<MarketplaceAgentRunReport> {
      const range = assertRouteReconciliationRange(input.range);
      const detectedAt = creationTimestamp(input.detected_at, 'detected_at');
      const asOf = detectedAt.slice(0, 10) as DateOnly;
      const timestamps = new Map<string, string>();
      const transferCreationDates = new Map<string, DateOnly>();
      for (const transfer of input.transfers) {
        const transferId = identifier(transfer.transfer_id, 'transfer_id');
        const createdAt = creationTimestamp(transfer.created_at, transferId);
        transferCreationDates.set(transferId, createdAt.slice(0, 10) as DateOnly);
      }
      const routePayments: RoutePayment[] = input.payments.map((payment) => {
        const paymentId = identifier(payment.payment_id, 'payment_id');
        const createdAt = creationTimestamp(payment.created_at, paymentId);
        const createdOn = createdAt.slice(0, 10) as DateOnly;
        if (payment.created_on !== undefined) {
          assertDateOnlyValue(payment.created_on, `${paymentId}.created_on`);
          if (payment.created_on !== createdOn) {
            throw new MarketplaceAgentError(
              `${paymentId}.created_on ${payment.created_on} does not match created_at UTC date ${createdOn}`,
            );
          }
        }
        timestamps.set(paymentId, createdAt);
        return { ...payment, payment_id: paymentId, created_on: createdOn };
      });

      const splits = mapRouteSplits({
        range,
        payments: routePayments,
        transfers: input.transfers,
        transfer_reversals: input.transfer_reversals,
      });
      const exceptions = await exceptionRunner.run({
        range,
        splits,
        settlements: input.settlements,
        detected_at: input.detected_at,
        seller_evidence_chain_ids: input.seller_evidence_chain_ids,
        payment_evidence_chain_ids: input.payment_evidence_chain_ids,
      });
      return {
        range,
        splits,
        exceptions,
        payout_chain: buildSellerPayoutChain({
          range,
          as_of: asOf,
          linked_account_id: input.linked_account_id,
          splits,
          settlements: input.settlements,
          payment_creation_timestamps: timestamps,
          transfer_creation_dates: transferCreationDates,
        }),
      };
    },
  };
}
