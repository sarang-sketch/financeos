import fc from 'fast-check';

import type { Paise } from '@/calc/calculation-service';
import type {
  RoutePayment,
  RouteSplitMappingInput,
  RouteTransfer,
  RouteTransferReversal,
} from '@/agents/marketplace/route-split';

const RANGE = { from: '2026-01-01', to: '2026-12-31' } as const;
const SELLER_ACCOUNT_ID = 'acc_p4_seller';

export interface GeneratedRouteTransfer {
  readonly transfer: RouteTransfer;
  readonly reversals: readonly RouteTransferReversal[];
  readonly on_hold: boolean;
}

export interface RouteSplitCase {
  readonly input: RouteSplitMappingInput;
  readonly payment: RoutePayment;
  readonly transfers: readonly GeneratedRouteTransfer[];
}

export interface OverAllocatedRouteSplitCase extends RouteSplitCase {
  readonly expected_impact_paise: Paise;
}

function allocateByWeights(total: Paise, weights: readonly number[]): readonly Paise[] {
  const denominator = BigInt(weights.reduce((sum, weight) => sum + weight, 0));
  const allocated = weights.map((weight) => (total * BigInt(weight)) / denominator);
  const allocatedTotal = allocated.reduce((sum, amount) => sum + amount, 0n);
  allocated[0] = (allocated[0] ?? 0n) + total - allocatedTotal;
  return allocated;
}
interface RouteSplitDraw {
  readonly paymentAmount: bigint;
  readonly feeSeed: bigint;
  readonly gstSeed: bigint;
  readonly transferPercent: number;
  readonly splitWeights: readonly number[];
  readonly reversalRatios: readonly number[];
  readonly onHoldFlags: readonly boolean[];
}

function buildRouteSplit(draw: RouteSplitDraw): RouteSplitCase {
  const fee = draw.feeSeed % (draw.paymentAmount + 1n);
  const afterFee = draw.paymentAmount - fee;
  const gst = draw.gstSeed % (afterFee + 1n);
  const availableForTransfers = draw.paymentAmount - fee - gst;
  const grossTransferBudget =
    (availableForTransfers * BigInt(draw.transferPercent)) / 100n;
  const amounts = allocateByWeights(grossTransferBudget, draw.splitWeights);

  const transfers = amounts.map((amount, index): GeneratedRouteTransfer => {
    const transferId = `trf_p4_${index}`;
    const reversalRatio = draw.reversalRatios[index] ?? 0;
    const reversed = (amount * BigInt(reversalRatio)) / 100n;
    const reversals: readonly RouteTransferReversal[] =
      reversed === 0n
        ? []
        : [{
            transfer_reversal_id: `trfr_p4_${index}`,
            transfer_id: transferId,
            reversed_amount_paise: reversed,
          }];
    return {
      transfer: {
        transfer_id: transferId,
        payment_id: 'pay_p4',
        linked_account_id: SELLER_ACCOUNT_ID,
        amount_paise: amount,
        on_hold: draw.onHoldFlags[index] ?? false,
      },
      reversals,
      on_hold: draw.onHoldFlags[index] ?? false,
    };
  });

  const netTransfers = transfers.reduce(
    (sum, item) =>
      sum +
      item.transfer.amount_paise -
      item.reversals.reduce((reversed, reversal) => reversed + reversal.reversed_amount_paise, 0n),
    0n,
  );
  const commission = draw.paymentAmount - fee - gst - netTransfers;
  const payment: RoutePayment = {
    payment_id: 'pay_p4',
    created_on: '2026-07-11',
    amount_paise: draw.paymentAmount,
    fee_paise: fee,
    gst_on_fee_paise: gst,
    platform_commission_paise: commission,
  };
  return {
    payment,
    transfers,
    input: {
      range: RANGE,
      payments: [payment],
      transfers: transfers.map((item) => item.transfer),
      transfer_reversals: transfers.flatMap((item) => item.reversals),
    },
  };
}

/**
 * P4's generator allocates weights, reversal ratios and hold flags, then solves the
 * retained commission. Every generated normal split is therefore satisfiable by
 * construction; no `fc.pre` or filter can discard a difficult draw while shrinking.
 */
export const arbitraryRouteSplit: fc.Arbitrary<RouteSplitCase> = fc
  .record({
    paymentAmount: fc.bigInt({ min: 1n, max: 10_000_000_000n }),
    feeSeed: fc.bigInt({ min: 0n, max: 10_000_000_000n }),
    gstSeed: fc.bigInt({ min: 0n, max: 10_000_000_000n }),
    transferPercent: fc.integer({ min: 0, max: 100 }),
    splitWeights: fc.array(fc.integer({ min: 1, max: 100 }), {
      minLength: 1,
      maxLength: 8,
    }),
    reversalRatios: fc.array(fc.integer({ min: 0, max: 100 }), { maxLength: 8 }),
    onHoldFlags: fc.array(fc.boolean(), { maxLength: 8 }),
  })
  .map(buildRouteSplit);

/** Deliberately exceed the gross Payment amount by a generated positive impact. */
export const arbitraryOverAllocatedRouteSplit: fc.Arbitrary<OverAllocatedRouteSplitCase> =
  arbitraryRouteSplit.chain((normal) =>
    fc.bigInt({ min: 1n, max: 1_000_000_000n }).map((overage) => {
      const gross = normal.transfers.reduce(
        (sum, item) => sum + item.transfer.amount_paise,
        0n,
      );
      const increase = normal.payment.amount_paise - gross + overage;
      const first = normal.transfers[0];
      if (first === undefined) throw new Error('arbitraryRouteSplit must create a Transfer');
      const transfers: readonly GeneratedRouteTransfer[] = [
        {
          ...first,
          transfer: {
            ...first.transfer,
            amount_paise: first.transfer.amount_paise + increase,
          },
        },
        ...normal.transfers.slice(1),
      ];
      return {
        payment: normal.payment,
        transfers,
        expected_impact_paise: overage,
        input: {
          ...normal.input,
          transfers: transfers.map((item) => item.transfer),
          transfer_reversals: transfers.flatMap((item) => item.reversals),
        },
      };
    }),
  );
