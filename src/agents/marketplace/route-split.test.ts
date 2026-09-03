import { describe, expect, it } from 'vitest';

import type { Paise } from '@/calc/calculation-service';

import {
  assertRouteReconciliationRange,
  expectedSellerPayout,
  mapRouteSplits,
  type RoutePayment,
  type RouteTransfer,
  type RouteTransferReversal,
  routeSplitConservation,
  RouteSplitError,
} from './route-split';

const RANGE = { from: '2026-01-01', to: '2026-12-31' } as const;

function payment(overrides: Partial<RoutePayment> = {}): RoutePayment {
  return {
    payment_id: 'pay_1',
    created_on: '2026-06-01',
    amount_paise: 100_000n,
    fee_paise: 2_000n,
    gst_on_fee_paise: 360n,
    platform_commission_paise: 17_640n,
    ...overrides,
  };
}

function transfer(overrides: Partial<RouteTransfer> = {}): RouteTransfer {
  return {
    transfer_id: 'trf_1',
    payment_id: 'pay_1',
    linked_account_id: 'acc_seller_a',
    amount_paise: 70_000n,
    on_hold: false,
    ...overrides,
  };
}

function reversal(overrides: Partial<RouteTransferReversal> = {}): RouteTransferReversal {
  return {
    transfer_reversal_id: 'trfr_1',
    transfer_id: 'trf_1',
    reversed_amount_paise: 10_000n,
    ...overrides,
  };
}

function mapped(options: {
  payments?: readonly RoutePayment[];
  transfers?: readonly RouteTransfer[];
  reversals?: readonly RouteTransferReversal[];
} = {}) {
  return mapRouteSplits({
    range: RANGE,
    payments: options.payments ?? [payment()],
    transfers:
      options.transfers ??
      [transfer(), transfer({ transfer_id: 'trf_2', linked_account_id: 'acc_seller_b', amount_paise: 20_000n })],
    transfer_reversals: options.reversals ?? [reversal()],
  });
}

describe('mapRouteSplits (Requirements 7.1 and 7.11)', () => {
  it('maps in-range Payments through stored Transfer and Transfer_Reversal identifiers', () => {
    const [split] = mapped();

    expect(split).toBeDefined();
    expect(split?.payment_id).toBe('pay_1');
    expect(split?.platform_commission_paise).toBe(17_640n);
    expect(split?.transfers).toHaveLength(2);
    expect(split?.transfers[0]).toMatchObject({
      transfer_id: 'trf_1',
      reversed_paise: 10_000n,
      net_amount_paise: 60_000n,
    });
    expect(split?.transfers[0]?.transfer_reversals).toEqual([reversal()]);
    expect(split?.net_transfers_paise).toBe(80_000n);
  });

  it('excludes out-of-range Payments and ignores records unrelated to an in-scope Payment', () => {
    const splits = mapped({
      payments: [payment(), payment({ payment_id: 'pay_old', created_on: '2025-12-31' })],
      transfers: [
        transfer(),
        transfer({ transfer_id: 'trf_old', payment_id: 'pay_old' }),
        transfer({ transfer_id: 'trf_unknown', payment_id: 'pay_unknown' }),
      ],
      reversals: [
        reversal(),
        reversal({ transfer_reversal_id: 'trfr_old', transfer_id: 'trf_old' }),
      ],
    });

    expect(splits.map((split) => split.payment_id)).toEqual(['pay_1']);
    expect(splits[0]?.transfers.map((item) => item.transfer_id)).toEqual(['trf_1']);
  });

  it('exposes an exact zero-paise conservation difference', () => {
    const [split] = mapped();
    if (split === undefined) throw new Error('expected one mapped split');

    expect(routeSplitConservation(split)).toEqual({
      net_transfers_paise: 80_000n,
      platform_commission_paise: 17_640n,
      fee_paise: 2_000n,
      gst_on_fee_paise: 360n,
      accounted_paise: 100_000n,
      payment_paise: 100_000n,
      difference_paise: 0n,
    });
    expect(split.difference_paise).toBe(0n);
  });
});

describe('expectedSellerPayout (Requirement 7.2)', () => {
  it('sums only the Linked_Account Transfers and subtracts each partial reversal own amount', () => {
    const splits = mapped({
      payments: [
        payment(),
        payment({
          payment_id: 'pay_2',
          amount_paise: 20_000n,
          fee_paise: 400n,
          gst_on_fee_paise: 72n,
          platform_commission_paise: 12_028n,
        }),
      ],
      transfers: [
        transfer(),
        transfer({ transfer_id: 'trf_2', linked_account_id: 'acc_seller_b', amount_paise: 20_000n }),
        transfer({ transfer_id: 'trf_3', payment_id: 'pay_2', amount_paise: 10_000n }),
      ],
      reversals: [
        reversal(),
        reversal({
          transfer_reversal_id: 'trfr_partial',
          transfer_id: 'trf_3',
          reversed_amount_paise: 2_500n,
        }),
      ],
    });

    expect(expectedSellerPayout(splits, 'acc_seller_a')).toBe(67_500n);
    expect(expectedSellerPayout(splits, 'acc_seller_b')).toBe(20_000n);
    expect(expectedSellerPayout(splits, 'acc_no_transfers')).toBe(0n);
  });

  it('excludes held Transfers and their partial reversals without changing conservation', () => {
    const [split] = mapped({
      payments: [payment({ platform_commission_paise: 22_640n })],
      transfers: [
        transfer(),
        transfer({
          transfer_id: 'trf_held',
          amount_paise: 20_000n,
          on_hold: true,
        }),
      ],
      reversals: [
        reversal(),
        reversal({
          transfer_reversal_id: 'trfr_held_partial',
          transfer_id: 'trf_held',
          reversed_amount_paise: 5_000n,
        }),
      ],
    });
    if (split === undefined) throw new Error('expected one mapped split');

    expect(expectedSellerPayout([split], 'acc_seller_a')).toBe(60_000n);
    expect(split.net_transfers_paise).toBe(75_000n);
    expect(routeSplitConservation(split).difference_paise).toBe(0n);
  });
});

describe('Route reconciliation validation', () => {
  it('accepts 366 inclusive calendar days and rejects 367', () => {
    expect(
      assertRouteReconciliationRange({ from: '2024-01-01', to: '2024-12-31' }),
    ).toEqual({ from: '2024-01-01', to: '2024-12-31' });
    expect(() =>
      assertRouteReconciliationRange({ from: '2024-01-01', to: '2025-01-01' }),
    ).toThrow(RouteSplitError);
  });

  it('rejects duplicate contributing identifiers and negative mapped money', () => {
    expect(() => mapped({ transfers: [transfer(), transfer()] })).toThrow(/duplicate Transfer/);
    expect(() =>
      mapped({ payments: [payment({ platform_commission_paise: -1n as Paise })] }),
    ).toThrow(/non-negative integer number of paise/);
  });
});
