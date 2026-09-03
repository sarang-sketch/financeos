import { describe, expect, it } from 'vitest';

import { memoryExceptionStore } from '@/agents/reconciliation/agent.test-support';

import {
  createMarketplaceAgent,
  MARKETPLACE_CHAIN_ROW_LIMIT,
  MarketplaceAgentError,
  type MarketplaceAgentPayment,
  type MarketplaceAgentTransfer,
} from './agent';
import type { RouteSellerSettlement } from './marketplace-exceptions';
import type { RouteTransferReversal } from './route-split';

const TENANT = '11111111-1111-4111-8111-111111111111';
const RANGE = { from: '2026-01-01', to: '2026-12-31' } as const;
const DETECTED = '2026-07-30T09:15:00.000Z';

function payment(
  paymentId: string,
  createdAt: string,
  overrides: Partial<MarketplaceAgentPayment> = {},
): MarketplaceAgentPayment {
  return {
    payment_id: paymentId,
    created_at: createdAt,
    amount_paise: 10n,
    fee_paise: 1n,
    gst_on_fee_paise: 1n,
    platform_commission_paise: 3n,
    ...overrides,
  };
}

function transfer(
  transferId: string,
  paymentId: string,
  amount = 5n,
  createdAt = '2026-06-01T00:00:00.000Z',
  onHold = false,
): MarketplaceAgentTransfer {
  return {
    transfer_id: transferId,
    payment_id: paymentId,
    linked_account_id: 'acc_seller',
    amount_paise: amount,
    created_at: createdAt,
    on_hold: onHold,
  };
}

function reversal(
  reversalId: string,
  transferId: string,
  amount = 1n,
): RouteTransferReversal {
  return {
    transfer_reversal_id: reversalId,
    transfer_id: transferId,
    reversed_amount_paise: amount,
  };
}

function settlement(received: bigint): RouteSellerSettlement {
  return {
    settlement_id: 'setl_seller',
    linked_account_id: 'acc_seller',
    settlement_date: '2026-07-15',
    received_paise: received,
  };
}

function agent() {
  return createMarketplaceAgent({ tenantId: TENANT, exceptions: memoryExceptionStore() });
}

describe('Marketplace_Agent chain ordering (Requirement 7.4)', () => {
  it('orders all identifier-linked rows by timestamp, Payment, Transfer, then reversal', async () => {
    const report = await agent().run({
      range: RANGE,
      linked_account_id: 'acc_seller',
      payments: [
        payment('pay_b', '2026-06-02T00:00:00.000Z'),
        payment('pay_early', '2026-06-01T23:59:59.000Z', {
          fee_paise: 1n,
          gst_on_fee_paise: 1n,
          platform_commission_paise: 0n,
        }),
        payment('pay_a', '2026-06-02T00:00:00.000Z'),
      ],
      transfers: [
        transfer('trf_b', 'pay_b'),
        transfer('trf_z', 'pay_early'),
        transfer('trf_a', 'pay_early'),
        transfer('trf_a_account', 'pay_a'),
      ],
      transfer_reversals: [
        reversal('trfr_b', 'trf_a'),
        reversal('trfr_a', 'trf_a'),
      ],
      settlements: [settlement(18n)],
      detected_at: DETECTED,
    });

    expect(
      report.payout_chain.rows.map((row) => [
        row.payment_id,
        row.transfer_id,
        row.transfer_reversal_id,
      ]),
    ).toEqual([
      ['pay_early', 'trf_a', 'trfr_a'],
      ['pay_early', 'trf_a', 'trfr_b'],
      ['pay_early', 'trf_z', null],
      ['pay_a', 'trf_a_account', null],
      ['pay_b', 'trf_b', null],
    ]);
    expect(report.payout_chain.rows[0]).toMatchObject({
      razorpay_fee_paise: 1n,
      gst_on_fee_paise: 1n,
      platform_commission_paise: 0n,
    });
    expect(report.payout_chain).toMatchObject({
      expected_payout_paise: 18n,
      received_paise: 18n,
      shortfall_paise: 0n,
      shortfall_inr: '₹0.00',
      total_rows: 5,
      total_contributing_row_count: 5,
      truncated: false,
    });
  });
});

describe('Marketplace_Agent chain truncation (Requirement 7.5)', () => {
  it('orders first, returns the first 200 rows, and reports the full contributing count', async () => {
    const transfers = Array.from({ length: 201 }, (_, index) =>
      transfer(`trf_${index.toString().padStart(3, '0')}`, 'pay_many', 1n),
    ).reverse();
    const report = await agent().run({
      range: RANGE,
      linked_account_id: 'acc_seller',
      payments: [
        payment('pay_many', '2026-06-01T00:00:00.000Z', {
          amount_paise: 201n,
          fee_paise: 0n,
          gst_on_fee_paise: 0n,
          platform_commission_paise: 0n,
        }),
      ],
      transfers,
      transfer_reversals: [],
      settlements: [settlement(201n)],
      detected_at: DETECTED,
    });

    expect(report.payout_chain.rows).toHaveLength(MARKETPLACE_CHAIN_ROW_LIMIT);
    expect(report.payout_chain.total_contributing_row_count).toBe(201);
    expect(report.payout_chain.truncated).toBe(true);
    expect(report.payout_chain.rows[0]?.transfer_id).toBe('trf_000');
    expect(report.payout_chain.rows[199]?.transfer_id).toBe('trf_199');
  });
});

describe('Marketplace_Agent on-hold payout handling (Requirement 7.9)', () => {
  it('excludes held Transfers from payout and chain rows, then reports them by identifier', async () => {
    const report = await agent().run({
      range: RANGE,
      linked_account_id: 'acc_seller',
      payments: [
        payment('pay_hold', '2026-06-01T00:00:00.000Z', {
          amount_paise: 20n,
          platform_commission_paise: 4n,
        }),
      ],
      transfers: [
        transfer('trf_hold_z', 'pay_hold', 4n, '2026-06-01T00:00:00.000Z', true),
        transfer('trf_eligible', 'pay_hold', 10n),
        transfer('trf_hold_a', 'pay_hold', 3n, '2026-06-01T00:00:00.000Z', true),
      ],
      transfer_reversals: [
        reversal('trfr_eligible_partial', 'trf_eligible', 2n),
        reversal('trfr_held_partial', 'trf_hold_z', 1n),
      ],
      settlements: [settlement(8n)],
      detected_at: DETECTED,
    });

    expect(report.payout_chain).toMatchObject({
      expected_payout_paise: 8n,
      received_paise: 8n,
      shortfall_paise: 0n,
      on_hold: [
        { transfer_id: 'trf_hold_a', amount_paise: 3n },
        { transfer_id: 'trf_hold_z', amount_paise: 4n },
      ],
      total_contributing_row_count: 1,
    });
    expect(report.payout_chain.rows.map((row) => row.transfer_id)).toEqual([
      'trf_eligible',
    ]);
    expect(report.splits[0]).toMatchObject({
      net_transfers_paise: 14n,
      difference_paise: 0n,
    });
    expect(
      report.exceptions.detections.some(
        ({ exception }) => exception.category === 'seller_settlement_mismatch',
      ),
    ).toBe(false);
  });
});

describe('Marketplace_Agent pending payout classification (Requirement 7.8)', () => {
  it('reports exact pending paise and oldest Transfer age without a seller mismatch', async () => {
    const report = await agent().run({
      range: RANGE,
      linked_account_id: 'acc_seller',
      payments: [
        payment('pay_pending', '2026-06-01T00:00:00.000Z', {
          amount_paise: 17n,
        }),
      ],
      transfers: [
        transfer('trf_newer', 'pay_pending', 7n, '2026-07-30T23:59:59.000Z'),
        transfer('trf_oldest', 'pay_pending', 5n, '2026-06-01T23:59:59.000Z'),
      ],
      transfer_reversals: [],
      settlements: [],
      detected_at: DETECTED,
    });

    expect(report.payout_chain).toMatchObject({
      classification: 'pending',
      expected_payout_paise: 12n,
      received_paise: 0n,
      pending_amount_paise: 12n,
      pending_amount_inr: '₹0.12',
      oldest_transfer_age_days: 59,
    });
    expect(
      report.exceptions.detections.some(
        ({ exception }) => exception.category === 'seller_settlement_mismatch',
      ),
    ).toBe(false);
  });
});

describe('Marketplace_Agent run composition', () => {
  it('maps Route records and runs both existing Marketplace detectors', async () => {
    const report = await agent().run({
      range: RANGE,
      linked_account_id: 'acc_seller',
      payments: [
        payment('pay_over', '2026-06-01T00:00:00.000Z', {
          amount_paise: 100n,
          fee_paise: 0n,
          gst_on_fee_paise: 0n,
          platform_commission_paise: 0n,
        }),
      ],
      transfers: [transfer('trf_over', 'pay_over', 101n)],
      transfer_reversals: [],
      settlements: [settlement(100n)],
      detected_at: DETECTED,
    });

    expect(report.splits[0]).toMatchObject({ payment_id: 'pay_over' });
    expect(report.exceptions.detections.map(({ exception }) => exception.category)).toEqual([
      'seller_settlement_mismatch',
      'over_allocated_split',
    ]);
    expect(report.payout_chain.shortfall_paise).toBe(1n);
    expect(report.payout_chain.shortfall_inr).toBe('₹0.01');
  });

  it('rejects timestamps without an explicit offset and inconsistent UTC dates', async () => {
    const base = {
      range: RANGE,
      linked_account_id: 'acc_seller',
      transfers: [] as MarketplaceAgentTransfer[],
      transfer_reversals: [] as RouteTransferReversal[],
      settlements: [] as RouteSellerSettlement[],
      detected_at: DETECTED,
    };
    await expect(
      agent().run({ ...base, payments: [payment('pay_bad', '2026-06-01T00:00:00')] }),
    ).rejects.toThrow(MarketplaceAgentError);
    await expect(
      agent().run({
        ...base,
        payments: [
          payment('pay_bad_date', '2026-06-01T23:30:00-02:00', {
            created_on: '2026-06-01',
          }),
        ],
      }),
    ).rejects.toThrow(/does not match created_at UTC date/);
  });
});
