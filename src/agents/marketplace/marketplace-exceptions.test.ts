import { describe, expect, it } from 'vitest';

import { memoryExceptionStore } from '@/agents/reconciliation/agent.test-support';

import {
  createMarketplaceExceptionRunner,
  overAllocatedSplitExceptionFor,
  sellerSettlementMismatchExceptionFor,
  type RouteSellerSettlement,
} from './marketplace-exceptions';
import {
  mapRouteSplits,
  type RoutePayment,
  type RouteTransfer,
  type RouteTransferReversal,
} from './route-split';

const TENANT = '11111111-1111-4111-8111-111111111111';
const RANGE = { from: '2026-01-01', to: '2026-12-31' } as const;
const DETECTED = '2026-07-30T09:15:00.000Z';
const LATER = '2026-07-31T09:15:00.000Z';

function payment(overrides: Partial<RoutePayment> = {}): RoutePayment {
  return {
    payment_id: 'pay_one',
    created_on: '2026-06-01',
    amount_paise: 1_000n,
    fee_paise: 0n,
    gst_on_fee_paise: 0n,
    platform_commission_paise: 300n,
    ...overrides,
  };
}

function transfer(overrides: Partial<RouteTransfer> = {}): RouteTransfer {
  return {
    transfer_id: 'trf_one',
    payment_id: 'pay_one',
    linked_account_id: 'acc_seller',
    amount_paise: 700n,
    on_hold: false,
    ...overrides,
  };
}

function reversal(overrides: Partial<RouteTransferReversal> = {}): RouteTransferReversal {
  return {
    transfer_reversal_id: 'trfr_one',
    transfer_id: 'trf_one',
    reversed_amount_paise: 100n,
    ...overrides,
  };
}
function splits(options: {
  payments?: readonly RoutePayment[];
  transfers?: readonly RouteTransfer[];
  reversals?: readonly RouteTransferReversal[];
} = {}) {
  return mapRouteSplits({
    range: RANGE,
    payments: options.payments ?? [payment()],
    transfers: options.transfers ?? [transfer()],
    transfer_reversals: options.reversals ?? [reversal()],
  });
}

function settlement(overrides: Partial<RouteSellerSettlement> = {}): RouteSellerSettlement {
  return {
    settlement_id: 'setl_one',
    linked_account_id: 'acc_seller',
    settlement_date: '2026-07-15',
    received_paise: 599n,
    ...overrides,
  };
}

describe('seller settlement mismatch detector (Requirements 7.3 and 7.10)', () => {
  it('detects the one-paisa boundary in both directions with absolute impact', () => {
    const mapped = splits(); // 700 Transfer - 100 reversal = 600 expected.
    const shortfall = sellerSettlementMismatchExceptionFor({
      range: RANGE,
      linked_account_id: 'acc_seller',
      splits: mapped,
      settlements: [settlement({ received_paise: 599n })],
      detected_at: DETECTED,
    });
    const excess = sellerSettlementMismatchExceptionFor({
      range: RANGE,
      linked_account_id: 'acc_seller',
      splits: mapped,
      settlements: [settlement({ received_paise: 601n })],
      detected_at: DETECTED,
    });

    expect(shortfall).toMatchObject({
      category: 'seller_settlement_mismatch',
      impact_paise: 1n,
      direction: 'shortfall',
      scope: RANGE,
    });
    expect(excess).toMatchObject({ impact_paise: 1n, direction: 'excess' });
    expect(shortfall?.source_refs).toEqual([
      { type: 'linked_account', id: 'acc_seller', role: 'linked_account' },
    ]);
    expect(shortfall?.context_refs).toEqual([
      { type: 'settlement', id: 'setl_one', role: 'received_settlement' },
      { type: 'transfer', id: 'trf_one', role: 'contributing_transfer' },
      {
        type: 'transfer_reversal',
        id: 'trfr_one',
        role: 'contributing_transfer_reversal',
      },
    ]);
  });

  it('creates no mismatch for exact equality or zero received Settlements', () => {
    const mapped = splits();
    expect(
      sellerSettlementMismatchExceptionFor({
        range: RANGE,
        linked_account_id: 'acc_seller',
        splits: mapped,
        settlements: [settlement({ received_paise: 600n })],
        detected_at: DETECTED,
      }),
    ).toBeNull();
    expect(
      sellerSettlementMismatchExceptionFor({
        range: RANGE,
        linked_account_id: 'acc_seller',
        splits: mapped,
        settlements: [],
        detected_at: DETECTED,
      }),
    ).toBeNull();
  });

  it('sums only Settlements inside the reconciliation range for that Linked_Account', () => {
    const exception = sellerSettlementMismatchExceptionFor({
      range: RANGE,
      linked_account_id: 'acc_seller',
      splits: splits(),
      settlements: [
        settlement({ settlement_id: 'setl_in', received_paise: 500n }),
        settlement({ settlement_id: 'setl_other', linked_account_id: 'acc_other', received_paise: 99n }),
        settlement({ settlement_id: 'setl_old', settlement_date: '2025-12-31', received_paise: 100n }),
      ],
      detected_at: DETECTED,
    });
    expect(exception).toMatchObject({ impact_paise: 100n, direction: 'shortfall' });
    expect(exception?.detail.received_settlement_paise).toBe('500');
  });
});
describe('over-allocated split detector (Requirements 7.7 and 7.10)', () => {
  it('detects exactly one paisa of gross Transfer over-allocation', () => {
    const [split] = splits({
      payments: [payment({ amount_paise: 100n, platform_commission_paise: 0n })],
      transfers: [
        transfer({ transfer_id: 'trf_b', amount_paise: 60n }),
        transfer({ transfer_id: 'trf_a', amount_paise: 41n }),
      ],
      reversals: [],
    });
    if (split === undefined) throw new Error('expected split');
    const exception = overAllocatedSplitExceptionFor({
      range: RANGE,
      split,
      detected_at: DETECTED,
    });
    expect(exception).toMatchObject({
      category: 'over_allocated_split',
      impact_paise: 1n,
      direction: 'not_applicable',
      scope: RANGE,
    });
    expect(exception?.source_refs).toEqual([
      { type: 'payment', id: 'pay_one', role: 'payment' },
    ]);
    expect(exception?.context_refs).toEqual([
      { type: 'transfer', id: 'trf_b', role: 'contributing_transfer' },
      { type: 'transfer', id: 'trf_a', role: 'contributing_transfer' },
    ]);
  });

  it('creates no Exception when gross Transfers equal or remain below the Payment', () => {
    for (const transferPaise of [100n, 99n]) {
      const [split] = splits({
        payments: [payment({ amount_paise: 100n, platform_commission_paise: 0n })],
        transfers: [transfer({ amount_paise: transferPaise })],
        reversals: [],
      });
      if (split === undefined) throw new Error('expected split');
      expect(
        overAllocatedSplitExceptionFor({ range: RANGE, split, detected_at: DETECTED }),
      ).toBeNull();
    }
  });
});

describe('marketplace Exception runner', () => {
  const runSplits = (amountPaise: bigint, transferId: string) =>
    splits({
      payments: [payment({ amount_paise: 500n, platform_commission_paise: 0n })],
      transfers: [transfer({ transfer_id: transferId, amount_paise: amountPaise })],
      reversals: [],
    });

  it('same-range reruns update both open Exceptions and replace contributing refs', async () => {
    const exceptions = memoryExceptionStore();
    const runner = createMarketplaceExceptionRunner({ tenantId: TENANT, exceptions });
    const first = await runner.run({
      range: RANGE,
      splits: runSplits(700n, 'trf_old'),
      settlements: [settlement({ received_paise: 600n })],
      detected_at: DETECTED,
    });
    expect(first.created_count).toBe(2);
    expect(first.detections.map(({ exception }) => exception.category)).toEqual([
      'seller_settlement_mismatch',
      'over_allocated_split',
    ]);

    const second = await runner.run({
      range: RANGE,
      splits: runSplits(650n, 'trf_current'),
      settlements: [settlement({ received_paise: 600n })],
      detected_at: LATER,
    });
    expect(second.created_count).toBe(0);
    expect(second.updated_count).toBe(2);
    expect(exceptions.rows.size).toBe(2);

    const byCategory = new Map([...exceptions.rows.values()].map((row) => [row.category, row]));
    expect(byCategory.get('seller_settlement_mismatch')?.impact_paise).toBe('50');
    expect(byCategory.get('over_allocated_split')?.impact_paise).toBe('150');
    for (const row of exceptions.rows.values()) {
      expect(row.first_detected_at).toBe(DETECTED);
      expect(row.last_detected_at).toBe(LATER);
      expect(row.links.some((link) => link.source_record_id === 'trf_old')).toBe(false);
      expect(row.links.some((link) => link.source_record_id === 'trf_current')).toBe(true);
    }
  });

  it('a shifted date range creates a distinct identity', async () => {
    const exceptions = memoryExceptionStore();
    const runner = createMarketplaceExceptionRunner({ tenantId: TENANT, exceptions });
    const input = {
      splits: runSplits(700n, 'trf_one'),
      settlements: [settlement({ received_paise: 600n })],
      detected_at: DETECTED,
    } as const;
    await runner.run({ ...input, range: RANGE });
    await runner.run({ ...input, range: { from: '2026-01-02', to: '2026-12-31' } });
    expect(exceptions.rows.size).toBe(4);
  });

  it('reports a resolved Exception without reopening it or changing its links', async () => {
    const exceptions = memoryExceptionStore();
    const runner = createMarketplaceExceptionRunner({ tenantId: TENANT, exceptions });
    const input = {
      range: RANGE,
      splits: splits({ transfers: [transfer()], reversals: [] }),
      settlements: [settlement({ received_paise: 600n })],
      detected_at: DETECTED,
    } as const;
    await runner.run(input);
    const stored = [...exceptions.rows.values()][0];
    if (stored === undefined) throw new Error('first run wrote no Exception');
    stored.state = 'resolved';
    const originalLinks = stored.links;

    const report = await runner.run({ ...input, detected_at: LATER });
    expect(report.not_reopened_count).toBe(1);
    expect(report.created_count).toBe(0);
    expect(stored.state).toBe('resolved');
    expect(stored.last_detected_at).toBe(DETECTED);
    expect(stored.links).toBe(originalLinks);
  });
});
