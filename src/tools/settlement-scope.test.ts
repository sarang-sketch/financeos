/**
 * The settlement read scope (task 12.1): Requirement 4.7's trailing window and
 * examined counts, and the projection from the read seam's shape onto task 11.1's
 * `ReconReportLines`.
 *
 * Every figure is drawn from `test/fixtures/set-9281.ts` through
 * `test/fixtures/set-9281.scoped.ts`, so a drift between the fixture and this
 * projection is a failure here rather than a wrong answer in the tool.
 */

import { describe, expect, it } from 'vitest';

import { SET_9281 } from '../../test/fixtures/set-9281';
import {
  scopedSettlementFor,
  settlementWithNoReconReport,
} from '../../test/fixtures/set-9281.scoped';

import {
  assertDateRange,
  dateOnlyOf,
  examinedCountsFor,
  inScopeOrder,
  NO_RECORDS_EXAMINED,
  rangeLengthInDays,
  reconReportLinesOf,
  resolveSettlementScope,
  SettlementScopeError,
  shiftDateOnly,
  TRAILING_WINDOW_DAYS,
  unreadableIn,
  unreconciledSourceOf,
} from './settlement-scope';

const RUN_AT = new Date('2026-07-30T09:00:00.000Z');

describe('resolveSettlementScope (Requirement 4.7)', () => {
  it('defaults to the trailing 90 inclusive dates ending at the run timestamp', () => {
    const scope = resolveSettlementScope({ runAt: RUN_AT });
    expect(scope).toEqual({ from: '2026-05-02', to: '2026-07-30' });
    // The range Requirement 4.7 reports is the range the figure was computed over,
    // so a 90-day window is 90 dates and not 91.
    expect(rangeLengthInDays(scope)).toBe(TRAILING_WINDOW_DAYS);
    expect(dateOnlyOf(RUN_AT)).toBe(scope.to);
  });

  it('passes a stated range through unchanged', () => {
    expect(resolveSettlementScope({ from: '2026-07-01', to: '2026-07-31', runAt: RUN_AT })).toEqual({
      from: '2026-07-01',
      to: '2026-07-31',
    });
  });

  it('refuses a half-stated range rather than guessing the other bound', () => {
    expect(() => resolveSettlementScope({ from: '2026-07-01', runAt: RUN_AT })).toThrow(
      SettlementScopeError,
    );
    expect(() => resolveSettlementScope({ to: '2026-07-31', runAt: RUN_AT })).toThrow(
      /both bounds or neither/,
    );
  });

  it('refuses an inverted range and a date that is not a calendar date', () => {
    expect(() => assertDateRange({ from: '2026-07-31', to: '2026-07-01' })).toThrow(
      /runs forward/,
    );
    // Matches YYYY-MM-DD and is not a date. `Date.UTC` would roll it to 2026-03-02.
    expect(() => assertDateRange({ from: '2026-02-30', to: '2026-03-01' })).toThrow(
      /not a real calendar date/,
    );
  });

  it('shifts dates in UTC across a month and a leap boundary', () => {
    expect(shiftDateOnly('2028-03-01', -1)).toBe('2028-02-29');
    expect(shiftDateOnly('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('reconReportLinesOf', () => {
  it('projects SET-9281 onto exactly the lines the fixture states', () => {
    expect(reconReportLinesOf(scopedSettlementFor(SET_9281))).toEqual(SET_9281.lines);
  });

  it('answers null for an absent report, which is Requirement 4.13 first half', () => {
    const absent = settlementWithNoReconReport({
      settlement_id: 'setl_SYNTHETICNONE1',
      settlement_date: '2026-07-30',
      received_paise: 1_000n,
      record_updated_at: '2026-07-30T00:00:00.000Z',
    });
    expect(reconReportLinesOf(absent)).toBeNull();
    expect(unreconciledSourceOf(absent)).toEqual({
      type: 'settlement_recon_report',
      reason: 'absent',
    });
  });

  it('distinguishes an empty report from an absent one', () => {
    const empty = {
      ...settlementWithNoReconReport({
        settlement_id: 'setl_SYNTHETICNONE2',
        settlement_date: '2026-07-30',
        received_paise: 1_000n,
        record_updated_at: '2026-07-30T00:00:00.000Z',
      }),
      recon_report_id: 'setlrcn_SYNTHETICNONE2',
    };
    // A present report enumerating nothing: `reconcileSettlement`'s own
    // `payments.length === 0` test classifies it, so only one module decides what
    // `unreconciled` means.
    expect(reconReportLinesOf(empty)).toEqual({
      payments: [],
      refunds: [],
      chargebacks: [],
      adjustments: [],
      fees: [],
      gst_on_fees: [],
    });
    expect(unreconciledSourceOf(empty)).toEqual({
      type: 'settlement_recon_report',
      reason: 'enumerates_zero_payments',
    });
  });

  it('answers null for a Settlement that reconciles', () => {
    expect(unreconciledSourceOf(scopedSettlementFor(SET_9281))).toBeNull();
  });
});

describe('examinedCountsFor (Requirement 4.7)', () => {
  it('derives the three counts it can see and takes the two it cannot', () => {
    const counts = examinedCountsFor({
      settlements: [scopedSettlementFor(SET_9281)],
      ledger_entries_examined: 6,
      razorpay_invoices_examined: 3,
    });
    expect(counts).toEqual({
      payments_examined: 3,
      settlements_examined: 1,
      refunds_examined: 1,
      ledger_entries_examined: 6,
      razorpay_invoices_examined: 3,
    });
  });

  it('counts nothing for an empty scope', () => {
    expect(
      examinedCountsFor({
        settlements: [],
        ledger_entries_examined: 0,
        razorpay_invoices_examined: 0,
      }),
    ).toEqual(NO_RECORDS_EXAMINED);
  });

  it('refuses a store count that is not a whole non-negative number', () => {
    expect(() =>
      examinedCountsFor({
        settlements: [],
        ledger_entries_examined: -1,
        razorpay_invoices_examined: 0,
      }),
    ).toThrow(/non-negative whole count/);
  });
});

describe('inScopeOrder and unreadableIn', () => {
  it('orders by ascending settlement date then identifier, so the answer is a function of the set', () => {
    const base = scopedSettlementFor(SET_9281);
    const shuffled = [
      { ...base, settlement_id: 'setl_SYNTHETICB', settlement_date: '2026-07-29' },
      { ...base, settlement_id: 'setl_SYNTHETICA', settlement_date: '2026-07-29' },
      { ...base, settlement_id: 'setl_SYNTHETICC', settlement_date: '2026-07-28' },
    ];
    expect(inScopeOrder(shuffled).map((s) => s.settlement_id)).toEqual([
      'setl_SYNTHETICC',
      'setl_SYNTHETICA',
      'setl_SYNTHETICB',
    ]);
    // Order-independent: reversing the input reproduces the same order.
    expect(inScopeOrder([...shuffled].reverse()).map((s) => s.settlement_id)).toEqual(
      inScopeOrder(shuffled).map((s) => s.settlement_id),
    );
  });

  it('gathers every unreadable Source_Record across the scope (Requirement 12.3)', () => {
    const base = scopedSettlementFor(SET_9281);
    expect(unreadableIn([base])).toEqual([]);
    expect(
      unreadableIn([
        base,
        { ...base, unreadable: [{ type: 'settlement_recon_report', id: 'pay_MISSING' }] },
      ]),
    ).toEqual([{ type: 'settlement_recon_report', id: 'pay_MISSING' }]);
  });
});
