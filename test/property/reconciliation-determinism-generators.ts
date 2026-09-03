/**
 * design.md's `arbitraryTenantDataset` for P5.
 *
 * ## Route objects are part of the dataset, not a placeholder
 *
 * design.md composes this generator from `arbitraryPayment`, `arbitraryRefund`,
 * `arbitrarySettlementWithReconReport`, **`arbitraryRouteSplit`** and `arbitraryInvoice`,
 * and P5 declares `**Validates: Requirements 4.15, 6.12, 7.10, 15.7**` — and 7.10 is the
 * Marketplace_Agent's re-run rule specifically. Until Slice 2 landed there was no
 * Marketplace_Agent to run, so the Route half of the dataset was carried as inert
 * `payment_id -> transfer_ids` rows. Task 20 (the Slice 2 property gate) is where that is
 * closed: the rows below are real Razorpay_Route objects — Linked_Accounts, Transfers with
 * amounts, partial Transfer_Reversals, an on-hold Transfer, a Linked_Account with zero
 * received Settlements, and one deliberately over-allocated split — shaped so both
 * Marketplace detectors fire on every generated dataset.
 *
 * Every Route amount is solved rather than filtered, the same discipline
 * `./route-split-generators.ts` uses for P4: the retained platform commission absorbs
 * whatever the Transfers and their reversals leave behind, so Requirement 7.11's
 * conservation holds by construction on every Payment except the one that is deliberately
 * over-allocated.
 */

import fc from 'fast-check';

import type { Paise } from '@/calc/paise';
import type { DateOnly } from '@/ledger/posting-rules';
import type { ScopedSettlement } from '@/tools/settlement-scope';
import type { PaymentLinks } from '@/agents/reconciliation/match';
import type {
  MarketplaceAgentPayment,
  MarketplaceAgentTransfer,
} from '@/agents/marketplace/agent';
import type { RouteSellerSettlement } from '@/agents/marketplace/marketplace-exceptions';
import type { RouteTransferReversal } from '@/agents/marketplace/route-split';

export interface TenantPayment {
  readonly payment_id: string;
  readonly amount_paise: Paise;
}

export interface TenantRefund {
  readonly refund_id: string;
  readonly payment_id: string;
  readonly amount_paise: Paise;
}

export interface TenantInvoice {
  readonly invoice_id: string;
  readonly payment_id: string;
}

/**
 * The Razorpay_Route half of the dataset: exactly the four record collections a
 * Marketplace_Agent run reads, plus the identities the property asserts a detector fired
 * for.
 */
export interface TenantRouteObjects {
  readonly payments: readonly MarketplaceAgentPayment[];
  readonly transfers: readonly MarketplaceAgentTransfer[];
  readonly transfer_reversals: readonly RouteTransferReversal[];
  /** Settlements received by a Linked_Account, Requirement 7.3's right-hand side. */
  readonly settlements: readonly RouteSellerSettlement[];
  /** The Linked_Account the payout chain answer is built for. */
  readonly focus_linked_account_id: string;
  /** Always mismatched by construction, so `seller_settlement_mismatch` always fires. */
  readonly mismatched_linked_account_id: string;
  /** Zero received Settlements, so Requirement 7.8 classifies them pending instead. */
  readonly pending_linked_account_ids: readonly string[];
  /** Σtransfers exceeds the Payment amount, so `over_allocated_split` always fires. */
  readonly over_allocated_payment_id: string;
}

export interface TenantDataset {
  readonly settlements: readonly ScopedSettlement[];
  readonly payments: readonly TenantPayment[];
  readonly refunds: readonly TenantRefund[];
  readonly invoices: readonly TenantInvoice[];
  readonly route: TenantRouteObjects;
  readonly links: readonly PaymentLinks[];
  readonly tied_settlement_ids: readonly [string, string];
}

export interface TenantDatasetRun {
  readonly dataset: TenantDataset;
  readonly shuffled: TenantDataset;
}

interface SettlementDraw {
  readonly day: number;
  readonly received_paise: Paise;
  readonly residual_paise: Paise;
  readonly refund_amounts: readonly Paise[];
  readonly transfer_count: number;
}

const arbitraryRefundAmounts = fc.array(fc.bigInt({ min: 0n, max: 50_000n }), {
  minLength: 0,
  maxLength: 2,
});

const arbitraryExtraSettlement: fc.Arbitrary<SettlementDraw> = fc.record({
  day: fc.integer({ min: 1, max: 28 }),
  received_paise: fc.bigInt({ min: 500_000n, max: 2_000_000n }),
  residual_paise: fc.bigInt({ min: -100_000n, max: 100_000n }),
  refund_amounts: arbitraryRefundAmounts,
  transfer_count: fc.integer({ min: 0, max: 3 }),
});

function total(values: readonly Paise[]): Paise {
  let result = 0n;
  for (const value of values) result += value;
  return result;
}

function suffix(index: number): string {
  return String(index).padStart(3, '0');
}

function settlementFrom(draw: SettlementDraw, index: number): ScopedSettlement {
  const id = suffix(index);
  const paymentId = `pay_p5_${id}`;
  const refundTotal = total(draw.refund_amounts);
  const paymentAmount = draw.received_paise + refundTotal + draw.residual_paise;
  return {
    settlement_id: `setl_p5_${id}`,
    settlement_date: `2026-07-${String(draw.day).padStart(2, '0')}` as DateOnly,
    received_paise: draw.received_paise,
    record_updated_at: '2026-07-31T00:00:00.000Z',
    recon_report_id: `setlrcn_p5_${id}`,
    payments: [
      {
        line_id: paymentId,
        record_updated_at: '2026-07-31T00:00:00.000Z',
        amount_paise: paymentAmount,
        fee_paise: 0n,
        gst_on_fee_paise: 0n,
      },
    ],
    refunds: draw.refund_amounts.map((amount, refundIndex) => ({
      line_id: `rfnd_p5_${id}_${refundIndex}`,
      record_updated_at: '2026-07-31T00:00:00.000Z',
      amount_paise: amount,
    })),
    chargebacks: [],
    adjustments: [],
  };
}

/* -------------------------------------------------------------------------- */
/* The Razorpay_Route half                                                    */
/* -------------------------------------------------------------------------- */

/** A Razorpay_Fee and its GST, fixed and well under the smallest drawn Payment. */
const ROUTE_FEE_PAISE = 2_360n;
const ROUTE_GST_ON_FEE_PAISE = 424n;

/** Transfers alternate between these two, so one is settled and one stays pending. */
const MISMATCHED_LINKED_ACCOUNT_ID = 'acc_p5_settled';
const PENDING_LINKED_ACCOUNT_ID = 'acc_p5_pending';
/** The destination of the deliberately over-allocated Transfer. */
const OVER_ALLOCATED_LINKED_ACCOUNT_ID = 'acc_p5_over';

const OVER_ALLOCATED_PAYMENT_ID = 'pay_route_p5_over';
const OVER_ALLOCATED_PAYMENT_PAISE = 100_000n;
const ROUTE_SELLER_SETTLEMENT_DATE = '2026-07-15' as DateOnly;

interface RouteBuild {
  readonly payments: MarketplaceAgentPayment[];
  readonly transfers: MarketplaceAgentTransfer[];
  readonly reversals: RouteTransferReversal[];
}

/**
 * One Route Payment per Settlement draw: `transfer_count` Transfers to the drawn
 * Linked_Account, a partial Transfer_Reversal against every other one, one on-hold
 * Transfer where the draw has at least 2, and the retained platform commission solved so
 * `net transfers + commission + fee + GST === payment amount` exactly.
 */
function routePaymentFrom(draw: SettlementDraw, index: number, build: RouteBuild): void {
  const id = suffix(index);
  const paymentId = `pay_route_p5_${id}`;
  const createdAt = `2026-07-${String(draw.day).padStart(2, '0')}T00:00:00.000Z`;
  const amount = draw.received_paise;
  const budget = amount - ROUTE_FEE_PAISE - ROUTE_GST_ON_FEE_PAISE;
  const linkedAccountId =
    index % 2 === 0 ? MISMATCHED_LINKED_ACCOUNT_ID : PENDING_LINKED_ACCOUNT_ID;
  const share = budget / BigInt(draw.transfer_count + 1);

  let net = 0n;
  for (let position = 0; position < draw.transfer_count; position += 1) {
    const transferId = `trf_p5_${id}_${position}`;
    build.transfers.push({
      transfer_id: transferId,
      payment_id: paymentId,
      linked_account_id: linkedAccountId,
      amount_paise: share,
      // Requirement 7.9: held Transfers stay mapped and leave the expected payout.
      on_hold: position === 1,
      created_at: createdAt,
    });
    const reversed = position % 2 === 0 ? share / 4n : 0n;
    if (reversed > 0n) {
      build.reversals.push({
        transfer_reversal_id: `trfr_p5_${id}_${position}`,
        transfer_id: transferId,
        reversed_amount_paise: reversed,
      });
    }
    net += share - reversed;
  }

  build.payments.push({
    payment_id: paymentId,
    created_at: createdAt,
    amount_paise: amount,
    fee_paise: ROUTE_FEE_PAISE,
    gst_on_fee_paise: ROUTE_GST_ON_FEE_PAISE,
    platform_commission_paise: budget - net,
  });
}

/** Requirement 7.7: one Payment whose single Transfer exceeds it by `overage` paise. */
function overAllocatedRoutePayment(overage: Paise, build: RouteBuild): void {
  build.payments.push({
    payment_id: OVER_ALLOCATED_PAYMENT_ID,
    created_at: '2026-07-01T00:00:00.000Z',
    amount_paise: OVER_ALLOCATED_PAYMENT_PAISE,
    fee_paise: 0n,
    gst_on_fee_paise: 0n,
    platform_commission_paise: 0n,
  });
  build.transfers.push({
    transfer_id: 'trf_p5_over',
    payment_id: OVER_ALLOCATED_PAYMENT_ID,
    linked_account_id: OVER_ALLOCATED_LINKED_ACCOUNT_ID,
    amount_paise: OVER_ALLOCATED_PAYMENT_PAISE + overage,
    on_hold: false,
    created_at: '2026-07-01T00:00:00.000Z',
  });
}

/**
 * The expected payout the generator has just constructed for one Linked_Account:
 * eligible (not held) Transfer amounts minus the reversals recorded against them.
 *
 * This is the generator solving its own construction, not a second implementation of
 * Requirement 7.2 — P5 asserts determinism across two runs, never the payout figure, so
 * production's `expectedSellerPayout` is never compared against this.
 */
function constructedEligibleNet(build: RouteBuild, linkedAccountId: string): Paise {
  const eligible = build.transfers.filter(
    (transfer) => transfer.linked_account_id === linkedAccountId && !transfer.on_hold,
  );
  const eligibleIds = new Set(eligible.map((transfer) => transfer.transfer_id));
  const transferred = total(eligible.map((transfer) => transfer.amount_paise));
  const reversed = total(
    build.reversals
      .filter((reversal) => eligibleIds.has(reversal.transfer_id))
      .map((reversal) => reversal.reversed_amount_paise),
  );
  return transferred - reversed;
}

function routeObjectsFrom(
  draws: readonly SettlementDraw[],
  overage: Paise,
  sellerDelta: Paise,
): TenantRouteObjects {
  const build: RouteBuild = { payments: [], transfers: [], reversals: [] };
  draws.forEach((draw, index) => routePaymentFrom(draw, index, build));
  overAllocatedRoutePayment(overage, build);

  // Requirement 7.3: received deliberately differs from expected by `sellerDelta`, so the
  // mismatch is non-zero for every generated dataset rather than only for most of them.
  const received = constructedEligibleNet(build, MISMATCHED_LINKED_ACCOUNT_ID) + sellerDelta;
  return {
    payments: build.payments,
    transfers: build.transfers,
    transfer_reversals: build.reversals,
    settlements: [
      {
        settlement_id: 'setlr_p5_settled',
        linked_account_id: MISMATCHED_LINKED_ACCOUNT_ID,
        settlement_date: ROUTE_SELLER_SETTLEMENT_DATE,
        received_paise: received,
      },
    ],
    focus_linked_account_id: MISMATCHED_LINKED_ACCOUNT_ID,
    mismatched_linked_account_id: MISMATCHED_LINKED_ACCOUNT_ID,
    pending_linked_account_ids: [PENDING_LINKED_ACCOUNT_ID, OVER_ALLOCATED_LINKED_ACCOUNT_ID],
    over_allocated_payment_id: OVER_ALLOCATED_PAYMENT_ID,
  };
}

function datasetFrom(
  draws: readonly SettlementDraw[],
  overage: Paise,
  sellerDelta: Paise,
): TenantDataset {
  const settlements = draws.map(settlementFrom);
  const payments = settlements.map((settlement) => ({
    payment_id: settlement.payments[0]!.line_id,
    amount_paise: settlement.payments[0]!.amount_paise,
  }));
  const refunds = settlements.flatMap((settlement) =>
    settlement.refunds.map((refund) => ({
      refund_id: refund.line_id,
      payment_id: settlement.payments[0]!.line_id,
      amount_paise: refund.amount_paise,
    })),
  );
  const invoices = payments.map((payment, index) => ({
    invoice_id: `inv_p5_${suffix(index)}`,
    payment_id: payment.payment_id,
  }));

  const links = payments.map((payment, index): PaymentLinks => ({
    payment_id: payment.payment_id,
    order_ids: [`order_p5_${suffix(index)}`],
    razorpay_invoice_ids: [invoices[index]!.invoice_id],
    settlement_ids: [settlements[index]!.settlement_id],
    ledger_entry_ids: [`entry_p5_${suffix(index)}`],
  }));
  return {
    settlements,
    payments,
    refunds,
    invoices,
    route: routeObjectsFrom(draws, overage, sellerDelta),
    links,
    tied_settlement_ids: [settlements[0]!.settlement_id, settlements[1]!.settlement_id],
  };
}

/**
 * design.md's `arbitraryTenantDataset`. The first two Settlements always have the
 * same non-zero impact and the same date, forcing the production comparator through
 * both tie-breaks. Payments, Refunds and Invoices remain part of the unchanged dataset
 * even though the Slice 1 Reconciliation_Agent consumes only settlement scope rows and
 * identifier links; the Route objects are consumed by the Slice 2 Marketplace_Agent, so
 * both range-scoped Exception_Categories are exercised on every generated dataset.
 *
 * The second run receives the same rows with **every** collection's insertion order
 * shuffled, Route collections included, which is what makes a run that depended on
 * arrival order fail here.
 */
export const arbitraryTenantDataset: fc.Arbitrary<TenantDatasetRun> = fc
  .tuple(
    fc.bigInt({ min: 1n, max: 100_000n }),
    fc.integer({ min: 1, max: 28 }),
    fc.bigInt({ min: 500_000n, max: 2_000_000n }),
    arbitraryRefundAmounts,
    fc.array(arbitraryExtraSettlement, { minLength: 0, maxLength: 8 }),
    // Requirement 7.7's over-allocation, and Requirement 7.3's non-zero seller difference.
    fc.bigInt({ min: 1n, max: 1_000_000n }),
    fc.bigInt({ min: 1n, max: 1_000_000n }),
  )
  .map(([tieImpact, tieDay, received, refunds, extras, overage, sellerDelta]) => {
    const tieBase = {
      day: tieDay,
      received_paise: received,
      refund_amounts: refunds,
      transfer_count: 1,
    } as const;
    return datasetFrom(
      [
        { ...tieBase, residual_paise: tieImpact },
        { ...tieBase, residual_paise: -tieImpact },
        ...extras,
      ],
      overage,
      sellerDelta,
    );
  })
  .chain((dataset) =>
    fc
      .tuple(
        fullPermutation(dataset.settlements),
        fullPermutation(dataset.payments),
        fullPermutation(dataset.refunds),
        fullPermutation(dataset.invoices),
        fullPermutation(dataset.links),
        fullPermutation(dataset.route.payments),
        fullPermutation(dataset.route.transfers),
        fullPermutation(dataset.route.transfer_reversals),
        fullPermutation(dataset.route.settlements),
      )
      .map(
        ([
          settlements,
          payments,
          refunds,
          invoices,
          links,
          routePayments,
          routeTransfers,
          routeReversals,
          routeSettlements,
        ]) => ({
          dataset,
          shuffled: {
            settlements,
            payments,
            refunds,
            invoices,
            links,
            route: {
              ...dataset.route,
              payments: routePayments,
              transfers: routeTransfers,
              transfer_reversals: routeReversals,
              settlements: routeSettlements,
            },
            tied_settlement_ids: dataset.tied_settlement_ids,
          },
        }),
      ),
  );

function fullPermutation<T>(values: readonly T[]): fc.Arbitrary<readonly T[]> {
  return fc
    .shuffledSubarray([...values], { minLength: values.length, maxLength: values.length })
    .map((shuffled) =>
      values.length > 1 && shuffled.every((value, index) => value === values[index])
        ? [...values].reverse()
        : shuffled,
    );
}
