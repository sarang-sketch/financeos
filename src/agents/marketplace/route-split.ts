/**
 * Pure Razorpay Route mapping and payout arithmetic (task 19.1).
 *
 * The reconciliation scope is the inclusive Payment-created date range. Each
 * in-scope Payment is mapped only through stored identifiers to its Transfers
 * and each Transfer's Transfer_Reversals. Money remains range-checked `bigint`
 * paise throughout; there is no division, scaling, or rounding.
 *
 * Requirements 7.1, 7.2, 7.9, 7.11.
 */

import { add, assertInRange, type Paise, subtract, sum } from '@/calc/calculation-service';
import type { DateOnly } from '@/ledger/posting-rules';
import {
  assertDateOnlyValue,
  assertDateRange,
  type DateRange,
  rangeLengthInDays,
} from '@/tools/settlement-scope';

/** Requirement 7.1's maximum inclusive reconciliation range. */
export const MAX_ROUTE_RECONCILIATION_DAYS = 366;

export class RouteSplitError extends Error {
  override readonly name = 'RouteSplitError';
}

/** Payment fields required to map and prove a Route split. */
export interface RoutePayment {
  readonly payment_id: string;
  /** UTC calendar date projected from the stored Payment creation timestamp. */
  readonly created_on: DateOnly;
  readonly amount_paise: Paise;
  readonly fee_paise: Paise;
  readonly gst_on_fee_paise: Paise;
  /** The platform commission retained on this Payment. */
  readonly platform_commission_paise: Paise;
}

/** A stored Transfer linked to its Payment and destination Linked_Account. */
export interface RouteTransfer {
  readonly transfer_id: string;
  readonly payment_id: string;
  readonly linked_account_id: string;
  readonly amount_paise: Paise;
  /** Stored Razorpay payout eligibility; held Transfers remain in conservation. */
  readonly on_hold: boolean;
}
/** A full or partial Transfer_Reversal linked by stored Transfer identifier. */
export interface RouteTransferReversal {
  readonly transfer_reversal_id: string;
  readonly transfer_id: string;
  /** This reversal record's own amount, never the original Transfer amount. */
  readonly reversed_amount_paise: Paise;
}

export interface MappedRouteTransfer extends RouteTransfer {
  readonly transfer_reversals: readonly RouteTransferReversal[];
  readonly reversed_paise: Paise;
  readonly net_amount_paise: Paise;
}

/** One in-scope Payment and its complete identifier-linked Route split. */
export interface RoutePaymentSplit extends RoutePayment {
  readonly transfers: readonly MappedRouteTransfer[];
  readonly net_transfers_paise: Paise;
  /** `net transfers + commission + fee + GST`. */
  readonly accounted_paise: Paise;
  /** `Payment amount - accounted`; Requirement 7.11 requires exactly `0n`. */
  readonly difference_paise: Paise;
}

export interface RouteSplitMappingInput {
  readonly range: DateRange;
  readonly payments: readonly RoutePayment[];
  readonly transfers: readonly RouteTransfer[];
  readonly transfer_reversals: readonly RouteTransferReversal[];
}

export interface RouteSplitConservation {
  readonly net_transfers_paise: Paise;
  readonly platform_commission_paise: Paise;
  readonly fee_paise: Paise;
  readonly gst_on_fee_paise: Paise;
  readonly accounted_paise: Paise;
  readonly payment_paise: Paise;
  readonly difference_paise: Paise;
}

function identifier(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RouteSplitError(`${field} must be a non-empty stored identifier`);
  }
  return value;
}

function nonNegativePaise(value: Paise, field: string): Paise {
  assertInRange(value);
  if (value < 0n) {
    throw new RouteSplitError(`${field} must be a non-negative integer number of paise`);
  }
  return value;
}
/** Validate an inclusive reconciliation range and enforce Requirement 7.1's cap. */
export function assertRouteReconciliationRange(range: DateRange): DateRange {
  assertDateRange(range, 'route reconciliation range');
  const days = rangeLengthInDays(range);
  if (days > MAX_ROUTE_RECONCILIATION_DAYS) {
    throw new RouteSplitError(
      `route reconciliation range covers ${days} inclusive days; the maximum is ${MAX_ROUTE_RECONCILIATION_DAYS}`,
    );
  }
  return range;
}

function validatePayment(payment: RoutePayment): void {
  identifier(payment.payment_id, 'payment_id');
  assertDateOnlyValue(payment.created_on, `${payment.payment_id}.created_on`);
  nonNegativePaise(payment.amount_paise, `${payment.payment_id}.amount_paise`);
  nonNegativePaise(payment.fee_paise, `${payment.payment_id}.fee_paise`);
  nonNegativePaise(payment.gst_on_fee_paise, `${payment.payment_id}.gst_on_fee_paise`);
  nonNegativePaise(
    payment.platform_commission_paise,
    `${payment.payment_id}.platform_commission_paise`,
  );
}

function validateTransfer(transfer: RouteTransfer): void {
  identifier(transfer.transfer_id, 'transfer_id');
  identifier(transfer.payment_id, `${transfer.transfer_id}.payment_id`);
  identifier(transfer.linked_account_id, `${transfer.transfer_id}.linked_account_id`);
  nonNegativePaise(transfer.amount_paise, `${transfer.transfer_id}.amount_paise`);
  if (typeof transfer.on_hold !== 'boolean') {
    throw new RouteSplitError(`${transfer.transfer_id}.on_hold must be a boolean`);
  }
}

function validateReversal(reversal: RouteTransferReversal): void {
  identifier(reversal.transfer_reversal_id, 'transfer_reversal_id');
  identifier(reversal.transfer_id, `${reversal.transfer_reversal_id}.transfer_id`);
  nonNegativePaise(
    reversal.reversed_amount_paise,
    `${reversal.transfer_reversal_id}.reversed_amount_paise`,
  );
}

function unique(id: string, seen: Set<string>, kind: string): void {
  if (seen.has(id)) {
    throw new RouteSplitError(`duplicate ${kind} identifier ${JSON.stringify(id)}`);
  }
  seen.add(id);
}

function total(values: readonly Paise[]): Paise {
  return sum([...values]);
}
/**
 * Map every Payment created in `range` to identifier-linked Transfers and
 * Transfer_Reversals. Unrelated records are ignored so a caller may pass the
 * Tenant's wider stored record set; no amount/date inference is performed.
 */
export function mapRouteSplits(input: RouteSplitMappingInput): readonly RoutePaymentSplit[] {
  const range = assertRouteReconciliationRange(input.range);

  for (const payment of input.payments) {
    identifier(payment.payment_id, 'payment_id');
    assertDateOnlyValue(payment.created_on, `${payment.payment_id}.created_on`);
  }
  const payments = input.payments.filter(
    (payment) => payment.created_on >= range.from && payment.created_on <= range.to,
  );
  const paymentIds = new Set<string>();
  for (const payment of payments) {
    unique(payment.payment_id, paymentIds, 'Payment');
    validatePayment(payment);
  }

  const transfersByPayment = new Map<string, RouteTransfer[]>();
  const transferIds = new Set<string>();
  for (const transfer of input.transfers) {
    if (!paymentIds.has(transfer.payment_id)) continue;
    validateTransfer(transfer);
    unique(transfer.transfer_id, transferIds, 'Transfer');
    const group = transfersByPayment.get(transfer.payment_id) ?? [];
    group.push(transfer);
    transfersByPayment.set(transfer.payment_id, group);
  }

  const reversalsByTransfer = new Map<string, RouteTransferReversal[]>();
  const reversalIds = new Set<string>();
  for (const reversal of input.transfer_reversals) {
    if (!transferIds.has(reversal.transfer_id)) continue;
    validateReversal(reversal);
    unique(reversal.transfer_reversal_id, reversalIds, 'Transfer_Reversal');
    const group = reversalsByTransfer.get(reversal.transfer_id) ?? [];
    group.push(reversal);
    reversalsByTransfer.set(reversal.transfer_id, group);
  }

  return payments.map((payment) => {
    const transfers = (transfersByPayment.get(payment.payment_id) ?? []).map((transfer) => {
      const transferReversals = reversalsByTransfer.get(transfer.transfer_id) ?? [];
      const reversed = total(transferReversals.map((item) => item.reversed_amount_paise));
      return {
        ...transfer,
        transfer_reversals: transferReversals,
        reversed_paise: reversed,
        net_amount_paise: subtract(transfer.amount_paise, reversed),
      };
    });

    const netTransfers = total(transfers.map((transfer) => transfer.net_amount_paise));
    const accounted = add(
      netTransfers,
      payment.platform_commission_paise,
      payment.fee_paise,
      payment.gst_on_fee_paise,
    );
    return {
      ...payment,
      transfers,
      net_transfers_paise: netTransfers,
      accounted_paise: accounted,
      difference_paise: subtract(payment.amount_paise, accounted),
    };
  });
}

/**
 * Requirements 7.2 and 7.9's expected Seller payout over already in-scope
 * mappings. Held Transfers and all reversals against them are payout-ineligible
 * but remain mapped for Requirement 7.11's conservation proof. Every eligible
 * partial reversal contributes its own `reversed_amount_paise`.
 */
export function expectedSellerPayout(
  splits: readonly RoutePaymentSplit[],
  linkedAccountId: string,
): Paise {
  identifier(linkedAccountId, 'linked_account_id');
  const transfers = splits.flatMap((split) =>
    split.transfers.filter(
      (transfer) =>
        transfer.linked_account_id === linkedAccountId && !transfer.on_hold,
    ),
  );
  const transferred = total(transfers.map((transfer) => transfer.amount_paise));
  const reversed = total(
    transfers.flatMap((transfer) =>
      transfer.transfer_reversals.map((reversal) => reversal.reversed_amount_paise),
    ),
  );
  return subtract(transferred, reversed);
}

/** Return all terms of Requirement 7.11's exact conservation equation. */
export function routeSplitConservation(split: RoutePaymentSplit): RouteSplitConservation {
  const accounted = add(
    split.net_transfers_paise,
    split.platform_commission_paise,
    split.fee_paise,
    split.gst_on_fee_paise,
  );
  return {
    net_transfers_paise: split.net_transfers_paise,
    platform_commission_paise: split.platform_commission_paise,
    fee_paise: split.fee_paise,
    gst_on_fee_paise: split.gst_on_fee_paise,
    accounted_paise: accounted,
    payment_paise: split.amount_paise,
    difference_paise: subtract(split.amount_paise, accounted),
  };
}
