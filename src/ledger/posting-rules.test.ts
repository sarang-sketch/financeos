/**
 * Task 8.1 and task 18.1 tests: the chart of accounts, Source_Record links,
 * debit/credit designations, and inputs that admit no posting.
 *
 * Task 8.2 owns the arithmetic assertions — Σdebit = Σcredit for all three
 * tables, the `A − F − G` identity at exactly 0 paise, and the no-fee 2-entry
 * set — so those are deliberately absent here rather than duplicated.
 */

import { describe, expect, it } from 'vitest';

import { PAISE_MAX, PaiseRangeError } from '@/calc/calculation-service';
import {
  ACCOUNT,
  assertDraftWellFormed,
  chartOfAccountsSeedRows,
  ChartOfAccountsSeedError,
  DEFAULT_CHART_OF_ACCOUNTS,
  imbalancePaise,
  paymentPostingDraft,
  postingDraftFor,
  PostingRuleError,
  refundPostingDraft,
  settlementPostingDraft,
  transferPostingDraft,
  transferReversalPostingDraft,
} from './posting-rules';

const DATE = '2026-02-14';
const TENANT = '11111111-2222-4333-8444-555555555555';

describe('the default chart of accounts', () => {
  it('covers every account the five posting tables name', () => {
    const codes = DEFAULT_CHART_OF_ACCOUNTS.map((a) => a.account_code);
    for (const code of Object.values(ACCOUNT)) {
      expect(codes).toContain(code);
    }
  });

  it('assigns the kinds property P13 closes the balance sign on', () => {
    const kindByCode = new Map(DEFAULT_CHART_OF_ACCOUNTS.map((a) => [a.account_code, a.kind]));
    // Debit-positive accounts: closing = debits - credits.
    expect(kindByCode.get(ACCOUNT.BANK)).toBe('asset');
    expect(kindByCode.get(ACCOUNT.SETTLEMENT_PENDING)).toBe('asset');
    expect(kindByCode.get(ACCOUNT.SELLER_PAYOUT_CLEARING)).toBe('asset');
    expect(kindByCode.get(ACCOUNT.GST_INPUT_CREDIT)).toBe('asset');
    expect(kindByCode.get(ACCOUNT.RAZORPAY_FEE_EXPENSE)).toBe('expense');
    // Credit-positive: closing = credits - debits.
    expect(kindByCode.get(ACCOUNT.REVENUE)).toBe('income');
  });

  it('holds no duplicate account code, so the seed cannot self-collide on the primary key', () => {
    const codes = DEFAULT_CHART_OF_ACCOUNTS.map((a) => a.account_code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('produces the same rows on every call, which is what makes re-seeding a no-op', () => {
    const first = chartOfAccountsSeedRows(TENANT);
    const second = chartOfAccountsSeedRows(TENANT);
    expect(second).toEqual(first);
    expect(first).toHaveLength(DEFAULT_CHART_OF_ACCOUNTS.length);
    expect(first.every((row) => row.tenant_id === TENANT && row.is_active)).toBe(true);
  });

  it('refuses a Tenant identifier that is not a UUID', () => {
    expect(() => chartOfAccountsSeedRows('tenant-1')).toThrow(ChartOfAccountsSeedError);
    expect(() => chartOfAccountsSeedRows('')).toThrow(ChartOfAccountsSeedError);
  });
});

describe('the Payment table', () => {
  const payment = {
    payment_id: 'pay_ABC123',
    entry_date: DATE,
    amount_paise: 100000n,
    fee_paise: 2360n,
    gst_on_fee_paise: 424n,
  };

  it('posts the four lines design.md names, on the sides it names', () => {
    const draft = paymentPostingDraft(payment);
    expect(draft.entries).toEqual([
      { account_code: ACCOUNT.SETTLEMENT_PENDING, side: 'debit', amount_paise: 97216n },
      { account_code: ACCOUNT.RAZORPAY_FEE_EXPENSE, side: 'debit', amount_paise: 2360n },
      { account_code: ACCOUNT.GST_INPUT_CREDIT, side: 'debit', amount_paise: 424n },
      { account_code: ACCOUNT.REVENUE, side: 'credit', amount_paise: 100000n },
    ]);
  });

  it('links the Payment as the derivation identity', () => {
    expect(paymentPostingDraft(payment).source_refs).toEqual([
      { type: 'payment', id: 'pay_ABC123' },
    ]);
  });

  it('omits the GST line when there is a fee but no GST on it', () => {
    const draft = paymentPostingDraft({ ...payment, gst_on_fee_paise: 0n });
    expect(draft.entries).toHaveLength(3);
    expect(draft.entries.map((e) => e.account_code)).not.toContain(ACCOUNT.GST_INPUT_CREDIT);
  });

  it('omits the settlement-pending line when the fee and GST consume the whole amount', () => {
    const draft = paymentPostingDraft({
      ...payment,
      amount_paise: 2784n,
      fee_paise: 2360n,
      gst_on_fee_paise: 424n,
    });
    expect(draft.entries.map((e) => e.account_code)).not.toContain(ACCOUNT.SETTLEMENT_PENDING);
    expect(draft.entries).toHaveLength(3);
  });

  it('rejects a 0-paise gross amount rather than drafting a set of fewer than 2 entries', () => {
    expect(() => paymentPostingDraft({ ...payment, amount_paise: 0n })).toThrow(
      expect.objectContaining({ name: 'PostingRuleError', violation: 'zero_amount' }),
    );
  });

  it('rejects a fee and GST that exceed the gross amount', () => {
    expect(() =>
      paymentPostingDraft({ ...payment, amount_paise: 1000n, fee_paise: 2360n }),
    ).toThrow(
      expect.objectContaining({ name: 'PostingRuleError', violation: 'fee_exceeds_amount' }),
    );
  });

  it('rejects a negative component: direction is side, never sign', () => {
    expect(() => paymentPostingDraft({ ...payment, fee_paise: -1n })).toThrow(
      expect.objectContaining({ name: 'PostingRuleError', violation: 'negative_amount' }),
    );
  });

  it('raises the paise range error, not a posting error, for an out-of-range amount', () => {
    expect(() => paymentPostingDraft({ ...payment, amount_paise: 10n ** 15n })).toThrow(
      PaiseRangeError,
    );
  });

  it('rejects an entry_date that is not a real calendar date', () => {
    expect(() => paymentPostingDraft({ ...payment, entry_date: '2026-02-30' })).toThrow(
      expect.objectContaining({ violation: 'invalid_entry_date' }),
    );
    expect(() => paymentPostingDraft({ ...payment, entry_date: '14-02-2026' })).toThrow(
      PostingRuleError,
    );
  });

  it('rejects a blank Payment identifier, which would link to nothing', () => {
    expect(() => paymentPostingDraft({ ...payment, payment_id: '  ' })).toThrow(
      expect.objectContaining({ violation: 'empty_identifier' }),
    );
  });
});

describe('the Refund table', () => {
  const refund = {
    refund_id: 'rfnd_XYZ',
    payment_id: 'pay_ABC123',
    entry_date: DATE,
    amount_paise: 40000n,
  };

  it('uses designations opposite to the Payment set', () => {
    const paymentDraft = paymentPostingDraft({
      payment_id: 'pay_ABC123',
      entry_date: DATE,
      amount_paise: 40000n,
      fee_paise: 0n,
      gst_on_fee_paise: 0n,
    });
    const refundDraft = refundPostingDraft(refund);

    const sideOf = (
      entries: readonly { account_code: string; side: 'debit' | 'credit' }[],
      code: string,
    ): string | undefined => entries.find((e) => e.account_code === code)?.side;

    for (const code of [ACCOUNT.REVENUE, ACCOUNT.SETTLEMENT_PENDING]) {
      expect(sideOf(refundDraft.entries, code)).not.toBe(sideOf(paymentDraft.entries, code));
    }
    expect(refundDraft.entries).toEqual([
      { account_code: ACCOUNT.REVENUE, side: 'debit', amount_paise: 40000n },
      { account_code: ACCOUNT.SETTLEMENT_PENDING, side: 'credit', amount_paise: 40000n },
    ]);
  });

  it('links the Refund and the refunded Payment, Refund first', () => {
    expect(refundPostingDraft(refund).source_refs).toEqual([
      { type: 'refund', id: 'rfnd_XYZ' },
      { type: 'payment', id: 'pay_ABC123' },
    ]);
  });

  it('rejects a 0-paise Refund', () => {
    expect(() => refundPostingDraft({ ...refund, amount_paise: 0n })).toThrow(
      expect.objectContaining({ violation: 'zero_amount' }),
    );
  });
});

describe('the Settlement table', () => {
  const settlement = {
    settlement_id: 'setl_9281',
    settlement_recon_report_id: 'rep_9281',
    entry_date: DATE,
    received_amount_paise: 81940000n,
  };

  it('debits bank and credits settlement_pending by the received amount', () => {
    expect(settlementPostingDraft(settlement).entries).toEqual([
      { account_code: ACCOUNT.BANK, side: 'debit', amount_paise: 81940000n },
      { account_code: ACCOUNT.SETTLEMENT_PENDING, side: 'credit', amount_paise: 81940000n },
    ]);
  });

  it('links the Settlement and its Settlement_Recon_Report', () => {
    expect(settlementPostingDraft(settlement).source_refs).toEqual([
      { type: 'settlement', id: 'setl_9281' },
      { type: 'settlement_recon_report', id: 'rep_9281' },
    ]);
  });

  it('still links the Settlement when no recon report is available', () => {
    const draft = settlementPostingDraft({ ...settlement, settlement_recon_report_id: null });
    expect(draft.source_refs).toEqual([{ type: 'settlement', id: 'setl_9281' }]);
  });

  it('rejects a 0-paise received amount', () => {
    expect(() =>
      settlementPostingDraft({ ...settlement, received_amount_paise: 0n }),
    ).toThrow(expect.objectContaining({ violation: 'zero_amount' }));
  });
});

describe('the Transfer and Transfer_Reversal tables', () => {
  const transfer = {
    transfer_id: 'trf_route_1',
    entry_date: DATE,
    amount_paise: 75_000n,
  };
  const partialReversal = {
    transfer_reversal_id: 'trfr_partial_1',
    entry_date: DATE,
    reversed_amount_paise: 12_345n,
  };

  it('moves a Transfer from settlement_pending to seller_payout_clearing', () => {
    const draft = transferPostingDraft(transfer);
    expect(draft.source_refs).toEqual([{ type: 'transfer', id: 'trf_route_1' }]);
    expect(draft.entries).toEqual([
      { account_code: ACCOUNT.SELLER_PAYOUT_CLEARING, side: 'debit', amount_paise: 75_000n },
      { account_code: ACCOUNT.SETTLEMENT_PENDING, side: 'credit', amount_paise: 75_000n },
    ]);
    expect(imbalancePaise(draft)).toBe(0n);
    expect(draft.entries).toHaveLength(2);
  });

  it('posts a partial Transfer_Reversal at its own reversed amount with opposite sides', () => {
    const draft = transferReversalPostingDraft(partialReversal);
    expect(draft.source_refs).toEqual([
      { type: 'transfer_reversal', id: 'trfr_partial_1' },
    ]);
    expect(draft.entries).toEqual([
      { account_code: ACCOUNT.SETTLEMENT_PENDING, side: 'debit', amount_paise: 12_345n },
      {
        account_code: ACCOUNT.SELLER_PAYOUT_CLEARING,
        side: 'credit',
        amount_paise: 12_345n,
      },
    ]);
    expect(imbalancePaise(draft)).toBe(0n);
    expect(draft.entries).toHaveLength(2);
  });

  it.each([1n, PAISE_MAX])('accepts the positive paise boundary %s', (amount) => {
    expect(transferPostingDraft({ ...transfer, amount_paise: amount }).entries).toHaveLength(2);
    expect(
      transferReversalPostingDraft({ ...partialReversal, reversed_amount_paise: amount }).entries,
    ).toHaveLength(2);
  });

  it.each([
    ['Transfer', () => transferPostingDraft({ ...transfer, amount_paise: 0n }), 'zero_amount'],
    [
      'Transfer_Reversal',
      () => transferReversalPostingDraft({ ...partialReversal, reversed_amount_paise: -1n }),
      'negative_amount',
    ],
  ])('rejects an invalid %s amount', (_label, invoke, violation) => {
    expect(invoke).toThrow(expect.objectContaining({ violation }));
  });

  it('rejects out-of-range values and malformed source identity fields', () => {
    expect(() => transferPostingDraft({ ...transfer, amount_paise: PAISE_MAX + 1n })).toThrow(
      PaiseRangeError,
    );
    expect(() =>
      transferReversalPostingDraft({ ...partialReversal, transfer_reversal_id: ' ' }),
    ).toThrow(expect.objectContaining({ violation: 'empty_identifier' }));
    expect(() => transferPostingDraft({ ...transfer, entry_date: '2026-02-30' })).toThrow(
      expect.objectContaining({ violation: 'invalid_entry_date' }),
    );
  });
});

describe('postingDraftFor dispatches on the Source_Record type', () => {
  it('routes each of the five types to its table', () => {
    expect(
      postingDraftFor({
        type: 'payment',
        payment_id: 'pay_1',
        entry_date: DATE,
        amount_paise: 500n,
        fee_paise: 0n,
        gst_on_fee_paise: 0n,
      }).entries.map((e) => e.account_code),
    ).toEqual([ACCOUNT.SETTLEMENT_PENDING, ACCOUNT.REVENUE]);

    expect(
      postingDraftFor({
        type: 'refund',
        refund_id: 'rfnd_1',
        payment_id: 'pay_1',
        entry_date: DATE,
        amount_paise: 500n,
      }).entries.map((e) => e.account_code),
    ).toEqual([ACCOUNT.REVENUE, ACCOUNT.SETTLEMENT_PENDING]);

    expect(
      postingDraftFor({
        type: 'settlement',
        settlement_id: 'setl_1',
        settlement_recon_report_id: null,
        entry_date: DATE,
        received_amount_paise: 500n,
      }).entries.map((e) => e.account_code),
    ).toEqual([ACCOUNT.BANK, ACCOUNT.SETTLEMENT_PENDING]);

    expect(
      postingDraftFor({
        type: 'transfer',
        transfer_id: 'trf_1',
        entry_date: DATE,
        amount_paise: 500n,
      }).entries.map((e) => e.account_code),
    ).toEqual([ACCOUNT.SELLER_PAYOUT_CLEARING, ACCOUNT.SETTLEMENT_PENDING]);

    expect(
      postingDraftFor({
        type: 'transfer_reversal',
        transfer_reversal_id: 'trfr_1',
        entry_date: DATE,
        reversed_amount_paise: 125n,
      }).entries.map((e) => e.account_code),
    ).toEqual([ACCOUNT.SETTLEMENT_PENDING, ACCOUNT.SELLER_PAYOUT_CLEARING]);
  });
});

describe('assertDraftWellFormed guards what the database would reject', () => {
  const entries = [
    { account_code: ACCOUNT.BANK, side: 'debit' as const, amount_paise: 100n },
    { account_code: ACCOUNT.SETTLEMENT_PENDING, side: 'credit' as const, amount_paise: 100n },
  ];

  it('accepts a 2-entry set with one Source_Record ref', () => {
    expect(() =>
      assertDraftWellFormed({
        source_refs: [{ type: 'settlement', id: 'setl_1' }],
        entry_date: DATE,
        entries,
      }),
    ).not.toThrow();
  });

  it('rejects a set with fewer than 2 entries', () => {
    expect(() =>
      assertDraftWellFormed({
        source_refs: [{ type: 'settlement', id: 'setl_1' }],
        entry_date: DATE,
        entries: entries.slice(0, 1),
      }),
    ).toThrow(expect.objectContaining({ violation: 'entry_count_out_of_range' }));
  });

  it('rejects a set with more than 20 entries', () => {
    expect(() =>
      assertDraftWellFormed({
        source_refs: [{ type: 'settlement', id: 'setl_1' }],
        entry_date: DATE,
        entries: Array.from({ length: 21 }, () => entries[0]!),
      }),
    ).toThrow(expect.objectContaining({ violation: 'entry_count_out_of_range' }));
  });

  it('rejects a 0-paise entry, since paise_positive requires > 0', () => {
    expect(() =>
      assertDraftWellFormed({
        source_refs: [{ type: 'settlement', id: 'setl_1' }],
        entry_date: DATE,
        entries: [{ ...entries[0]!, amount_paise: 0n }, entries[1]!],
      }),
    ).toThrow(expect.objectContaining({ violation: 'entry_count_out_of_range' }));
  });

  it('rejects a draft with no Source_Record ref', () => {
    expect(() =>
      assertDraftWellFormed({ source_refs: [], entry_date: DATE, entries }),
    ).toThrow(expect.objectContaining({ violation: 'missing_source_ref' }));
  });
});
