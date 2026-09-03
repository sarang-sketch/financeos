// Feature: financeos-control-tower, Property 4: Route split conservation
//
// **Validates: Requirements 7.1, 7.2, 7.7, 7.9, 7.11**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  expectedSellerPayout,
  mapRouteSplits,
  type RoutePaymentSplit,
  routeSplitConservation,
} from '@/agents/marketplace/route-split';
import type { Paise } from '@/calc/calculation-service';

import {
  arbitraryOverAllocatedRouteSplit,
  arbitraryRouteSplit,
} from './route-split-generators';

const NUM_RUNS = 100;
const PARAMS = { numRuns: NUM_RUNS, seed: 20260711 } as const;
const SELLER_ACCOUNT_ID = 'acc_p4_seller';

interface ProjectedOverAllocationException {
  readonly category: 'over_allocated_split';
  readonly impact_paise: Paise;
  readonly source_records: readonly { readonly type: 'payment' | 'transfer'; readonly id: string }[];
}

function total(values: readonly Paise[]): Paise {
  return values.reduce((sum, value) => sum + value, 0n);
}

/** Requirement 7.7's independent projection; Task 19.3 owns persistence/fingerprints. */
function projectOverAllocation(split: RoutePaymentSplit): ProjectedOverAllocationException | null {
  const transferred = total(split.transfers.map((transfer) => transfer.amount_paise));
  if (transferred <= split.amount_paise) return null;
  return {
    category: 'over_allocated_split',
    impact_paise: transferred - split.amount_paise,
    source_records: [
      { type: 'payment', id: split.payment_id },
      ...split.transfers.map((transfer) => ({ type: 'transfer' as const, id: transfer.transfer_id })),
    ],
  };
}

describe('Property 4: Route split conservation', () => {
  it('conserves every constructed split exactly and excludes held Transfers only from payout', () => {
    fc.assert(
      fc.property(arbitraryRouteSplit, (c) => {
        const [split] = mapRouteSplits(c.input);
        if (split === undefined) throw new Error('expected one mapped Payment');
        const conservation = routeSplitConservation(split);

        const independentNetTransfers = total(
          c.transfers.map(
            (item) =>
              item.transfer.amount_paise -
              total(item.reversals.map((reversal) => reversal.reversed_amount_paise)),
          ),
        );
        expect(split.net_transfers_paise).toBe(independentNetTransfers);
        expect(
          independentNetTransfers +
            c.payment.platform_commission_paise +
            c.payment.fee_paise +
            c.payment.gst_on_fee_paise,
        ).toBe(c.payment.amount_paise);
        expect(conservation.accounted_paise).toBe(c.payment.amount_paise);
        expect(conservation.difference_paise).toBe(0n);
        expect(split.difference_paise).toBe(0n);

        const expectedPayout = expectedSellerPayout([split], SELLER_ACCOUNT_ID);
        const independentEligiblePayout = total(
          c.transfers
            .filter((item) => !item.on_hold)
            .map(
              (item) =>
                item.transfer.amount_paise -
                total(item.reversals.map((reversal) => reversal.reversed_amount_paise)),
            ),
        );
        expect(expectedPayout).toBe(independentEligiblePayout);

        // Holding affects payout eligibility, not the Payment's conservation proof.
        const heldNet = total(
          c.transfers
            .filter((item) => item.on_hold)
            .map(
              (item) =>
                item.transfer.amount_paise -
                total(item.reversals.map((reversal) => reversal.reversed_amount_paise)),
            ),
        );
        expect(expectedPayout + heldNet).toBe(split.net_transfers_paise);
      }),
      PARAMS,
    );
  });

  it('projects every deliberately over-allocated split as the required Exception impact', () => {
    fc.assert(
      fc.property(arbitraryOverAllocatedRouteSplit, (c) => {
        const [split] = mapRouteSplits(c.input);
        if (split === undefined) throw new Error('expected one mapped Payment');
        const transferred = total(split.transfers.map((item) => item.amount_paise));
        const exception = projectOverAllocation(split);

        expect(transferred > split.amount_paise).toBe(true);
        expect(transferred - split.amount_paise).toBe(c.expected_impact_paise);
        expect(exception).not.toBeNull();
        expect(exception?.category).toBe('over_allocated_split');
        expect(exception?.impact_paise).toBe(transferred - split.amount_paise);
        expect(exception?.source_records).toEqual([
          { type: 'payment', id: split.payment_id },
          ...split.transfers.map((item) => ({ type: 'transfer', id: item.transfer_id })),
        ]);
      }),
      PARAMS,
    );
  });
});
