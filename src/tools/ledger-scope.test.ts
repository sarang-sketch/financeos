/**
 * The ledger read scope's pure functions (task 12.3).
 *
 * `./get-trial-balance.test.ts` drives these through the tool, which is where the
 * end-to-end behaviour is asserted. This suite covers the parts a tool-level test
 * cannot reach cheaply: the per-field rejections {@link assertScopedLedgerEntry} makes
 * against a malformed adapter, and the ordering guarantee every Evidence_Chain operand
 * sequence rests on.
 */

import { describe, expect, it } from 'vitest';

import {
  accountEntriesInOrder,
  accountNameOf,
  assertScopedLedgerEntry,
  LedgerScopeError,
  type ScopedLedgerEntry,
  unreadableIn,
} from './ledger-scope';

const SET_A = '92810000-0000-4281-8281-0000000000a1';
const SET_B = '92810000-0000-4281-8281-0000000000a2';

const entry = (over: Partial<ScopedLedgerEntry> = {}): ScopedLedgerEntry => ({
  account_code: 'bank',
  set_id: SET_A,
  line_no: 1,
  side: 'debit',
  amount_paise: 97_500n,
  record_updated_at: '2026-07-05T04:30:00.000Z',
  ...over,
});

describe('assertScopedLedgerEntry', () => {
  it('accepts a well-formed entry unchanged', () => {
    const value = entry();
    expect(assertScopedLedgerEntry(value, 'entries[0]')).toBe(value);
  });

  const malformed: readonly { readonly why: string; readonly over: Partial<ScopedLedgerEntry> }[] = [
    { why: 'an empty account code', over: { account_code: '  ' } },
    { why: 'a set_id that is not a UUID', over: { set_id: 'setl_ABC123' } },
    { why: 'a line_no below 1', over: { line_no: 0 } },
    { why: 'a fractional line_no', over: { line_no: 1.5 } },
    { why: 'a side outside the entry_side enum', over: { side: 'DEBIT' as ScopedLedgerEntry['side'] } },
    // `ledger_entries.amount_paise` is the paise_positive domain; direction is `side`.
    { why: 'a zero amount', over: { amount_paise: 0n } },
    { why: 'a signed amount', over: { amount_paise: -1n } },
    // A locally rendered TIMESTAMPTZ would move the chain's as-of by 5h30m.
    { why: 'a timestamp with no millisecond precision', over: { record_updated_at: '2026-07-05T04:30:00Z' } },
    { why: 'a timestamp in IST', over: { record_updated_at: '2026-07-05T10:00:00.000+05:30' } },
  ];

  for (const testCase of malformed) {
    it(`refuses ${testCase.why}`, () => {
      expect(() => assertScopedLedgerEntry(entry(testCase.over), 'entries[3]')).toThrow(
        LedgerScopeError,
      );
      // The rejection names the position, so a bad row in a long read is findable.
      expect(() => assertScopedLedgerEntry(entry(testCase.over), 'entries[3]')).toThrow(
        /entries\[3]/,
      );
    });
  }
});

describe('accountEntriesInOrder', () => {
  it('groups by account and orders accounts and citations deterministically', () => {
    const shuffled: readonly ScopedLedgerEntry[] = [
      entry({ account_code: 'revenue', set_id: SET_B, line_no: 2, side: 'credit', amount_paise: 2n }),
      entry({ account_code: 'bank', set_id: SET_B, line_no: 1, amount_paise: 5n }),
      entry({ account_code: 'revenue', set_id: SET_A, line_no: 4, side: 'credit', amount_paise: 1n }),
      entry({ account_code: 'bank', set_id: SET_A, line_no: 1, amount_paise: 3n }),
    ];

    const grouped = accountEntriesInOrder(shuffled);
    // Ascending account_code, the order `trialBalance` sorts its rows into.
    expect(grouped.map((account) => account.account_code)).toEqual(['bank', 'revenue']);
    // Ascending (set_id, line_no) within each side, which fixes the operand sequence.
    expect(grouped[0]?.debits.map((debit) => [debit.set_id, debit.line_no])).toEqual([
      [SET_A, 1],
      [SET_B, 1],
    ]);
    expect(grouped[0]?.credits).toEqual([]);
    expect(grouped[1]?.credits.map((credit) => credit.line_no)).toEqual([4, 2]);
  });

  it('is a function of the entry set rather than of the store\'s return order', () => {
    const entries = [
      entry({ set_id: SET_A, line_no: 1 }),
      entry({ set_id: SET_A, line_no: 2 }),
      entry({ set_id: SET_B, line_no: 1 }),
    ];
    expect(accountEntriesInOrder(entries)).toEqual(accountEntriesInOrder([...entries].reverse()));
  });

  it('refuses a repeated (set_id, line_no), the Evidence_Chain citation key', () => {
    expect(() =>
      accountEntriesInOrder([entry(), entry({ amount_paise: 1n })]),
    ).toThrow(/repeats Ledger_Entry set/);
  });

  it('has no row for an account with no entry in the range', () => {
    expect(accountEntriesInOrder([])).toEqual([]);
  });
});

describe('the chart of accounts', () => {
  it('names seeded standard and Route accounts', () => {
    expect(accountNameOf('settlement_pending')).toBe('Settlement Pending');
    expect(accountNameOf('seller_payout_clearing')).toBe('Seller Payout Clearing');
  });

  it('refuses a Tenant-defined code the seeded chart cannot name rather than guessing one', () => {
    expect(() => accountNameOf('tenant_defined_clearing')).toThrow(LedgerScopeError);
    expect(() => accountNameOf('tenant_defined_clearing')).toThrow(/must not be guessed/);
  });
});

describe('unreadableIn', () => {
  it('reports nothing unreadable when the store omitted the field', () => {
    expect(unreadableIn({ entries: [] })).toEqual([]);
  });

  it('reports what the store could not read, in the order it reported it', () => {
    const unreadable = [
      { type: 'ledger_entry_set', id: SET_A },
      { type: 'payment', id: 'pay_1' },
    ] as const;
    expect(unreadableIn({ entries: [], unreadable })).toEqual(unreadable);
  });
});
