/**
 * The trial-balance Evidence_Chain composition (task 12.3). Requirements 2.5, 12.2, 12.8.
 *
 * `./get-trial-balance.test.ts` asserts the shape of the chains an invocation persists.
 * This suite covers what the tool cannot reach without a contrived store: the
 * refusals {@link accountStepBlock} and {@link grandTotalChain} make when a reported
 * figure and the entries behind it disagree, and the fact that step 3's operand order is
 * read off the reported closing balance rather than off the account kind.
 */

import { describe, expect, it } from 'vitest';

import type { TrialBalanceRow } from '@/ledger/semantic-ledger';

import {
  ACCOUNT_CHAIN_STEP_COUNT,
  ACCOUNT_CLOSING_STEP_INDEX,
  ACCOUNT_CREDIT_TOTAL_STEP_INDEX,
  ACCOUNT_DEBIT_TOTAL_STEP_INDEX,
  accountChain,
  accountStepBlock,
  entrySetFieldFor,
  grandTotalChain,
  LedgerEvidenceError,
  sideTotalStep,
} from './ledger-evidence';
import type { AccountEntries, ScopedLedgerEntry } from './ledger-scope';

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

/** `bank`: debited twice, never credited. An asset, so it closes debits − credits. */
const BANK: AccountEntries = {
  account_code: 'bank',
  debits: [entry({ amount_paise: 97_500n }), entry({ set_id: SET_B, amount_paise: 2_500n })],
  credits: [],
};

const BANK_ROW: TrialBalanceRow = {
  account_code: 'bank',
  kind: 'asset',
  total_debit_paise: 100_000n,
  total_credit_paise: 0n,
  closing_balance_paise: 100_000n,
};

/** `revenue`: credited only. Income, so the ledger signs it credits − debits. */
const REVENUE: AccountEntries = {
  account_code: 'revenue',
  debits: [],
  credits: [entry({ account_code: 'revenue', line_no: 4, side: 'credit', amount_paise: 100_000n })],
};

const REVENUE_ROW: TrialBalanceRow = {
  account_code: 'revenue',
  kind: 'income',
  total_debit_paise: 0n,
  total_credit_paise: 100_000n,
  closing_balance_paise: 100_000n,
};

describe('sideTotalStep', () => {
  it('sums one side and cites every entry it read, one field per line', () => {
    const step = sideTotalStep(BANK, 'debit', ACCOUNT_DEBIT_TOTAL_STEP_INDEX);
    expect(step.result_paise).toBe(100_000n);
    expect(step.step.operation).toBe('sum');
    expect(step.step.operands).toEqual([
      { kind: 'source', ref: { type: 'ledger_entry_set', id: SET_A }, field: 'line_1.amount_paise' },
      { kind: 'source', ref: { type: 'ledger_entry_set', id: SET_B }, field: 'line_1.amount_paise' },
    ]);
    expect(step.citations).toHaveLength(2);
    expect(entrySetFieldFor(entry({ line_no: 12 }))).toBe('line_12.amount_paise');
  });

  it('states a literal zero, as a string, for a side with no entry in the range', () => {
    const step = sideTotalStep(BANK, 'credit', ACCOUNT_CREDIT_TOTAL_STEP_INDEX);
    expect(step.result_paise).toBe(0n);
    // A JSON numeric literal would round-trip through an IEEE-754 double.
    expect(step.step.operands).toEqual([{ kind: 'literal', value: '0' }]);
    expect(step.citations).toEqual([]);
  });

  it('refuses a step index that is not a 1-based ordinal', () => {
    expect(() => sideTotalStep(BANK, 'debit', 0)).toThrow(LedgerEvidenceError);
  });
});

describe('accountStepBlock', () => {
  it('reads the closing operand order off the reported figure, not off the kind', () => {
    // An asset closes debits − credits, so the debit total step comes first...
    expect(accountStepBlock(BANK, BANK_ROW).steps[ACCOUNT_CLOSING_STEP_INDEX - 1]?.operands).toEqual(
      [
        { kind: 'step', index: ACCOUNT_DEBIT_TOTAL_STEP_INDEX },
        { kind: 'step', index: ACCOUNT_CREDIT_TOTAL_STEP_INDEX },
      ],
    );
    // ...and income the other way round. `kind` is never read: the row below claims to
    // be an asset and the reported figure is still what fixes the order.
    expect(
      accountStepBlock(REVENUE, { ...REVENUE_ROW, kind: 'asset' }).steps[
        ACCOUNT_CLOSING_STEP_INDEX - 1
      ]?.operands,
    ).toEqual([
      { kind: 'step', index: ACCOUNT_CREDIT_TOTAL_STEP_INDEX },
      { kind: 'step', index: ACCOUNT_DEBIT_TOTAL_STEP_INDEX },
    ]);
  });

  it('makes the closing balance the chain\'s figure and the two totals intermediates', () => {
    const chain = accountChain('get_trial_balance', BANK, BANK_ROW);
    expect(chain.figure_paise).toBe(100_000n);
    expect(chain.steps).toHaveLength(ACCOUNT_CHAIN_STEP_COUNT);
    expect(chain.steps[0]?.result_paise).toBe(BANK_ROW.total_debit_paise);
    expect(chain.steps[1]?.result_paise).toBe(BANK_ROW.total_credit_paise);
    expect(chain.produced_by).toBe('get_trial_balance');
  });

  it('refuses entries paired with another account\'s row', () => {
    expect(() => accountStepBlock(BANK, REVENUE_ROW)).toThrow(/were paired with/);
  });

  it('refuses an account with no entry in the range', () => {
    expect(() =>
      accountStepBlock({ account_code: 'bank', debits: [], credits: [] }, BANK_ROW),
    ).toThrow(/holds no Ledger_Entry in the range/);
  });

  it('refuses a reported total the entries do not reproduce', () => {
    expect(() => accountStepBlock(BANK, { ...BANK_ROW, total_debit_paise: 99_999n })).toThrow(
      /total_debit_paise/,
    );
  });

  it('refuses a closing balance neither subtraction produces', () => {
    expect(() => accountStepBlock(BANK, { ...BANK_ROW, closing_balance_paise: 1n })).toThrow(
      /no replayable step produces it/,
    );
  });
});

describe('grandTotalChain', () => {
  it('states one sum step per account and terminates in a sum over those results', () => {
    const chain = grandTotalChain('get_trial_balance', 'debit', [BANK, REVENUE], 100_000n);
    expect(chain.figure_paise).toBe(100_000n);
    expect(chain.steps).toHaveLength(3);
    expect(chain.steps.at(-1)?.operation).toBe('sum');
    expect(chain.steps.at(-1)?.operands).toEqual([
      { kind: 'step', index: 1 },
      { kind: 'step', index: 2 },
    ]);
    // Only the entries this side's steps read are cited: `revenue` has no debit.
    expect(chain.sources.map((source) => source.ref.id)).toEqual([SET_A, SET_B]);
  });

  it('cites the credit entries for the credit total, a disjoint operand set', () => {
    const chain = grandTotalChain('get_trial_balance', 'credit', [BANK, REVENUE], 100_000n);
    expect(chain.figure_paise).toBe(100_000n);
    expect(chain.sources.map((source) => source.field)).toEqual(['line_4.amount_paise']);
  });

  it('refuses a grand total the per-account sums do not reproduce', () => {
    expect(() => grandTotalChain('get_trial_balance', 'debit', [BANK], 1n)).toThrow(
      /summing the 1 per-account debit totals produces 100000/,
    );
  });

  it('refuses a side with no Ledger_Entry at all, which would cite no Source_Record', () => {
    expect(() => grandTotalChain('get_trial_balance', 'credit', [BANK], 0n)).toThrow(
      /source_count >= 1/,
    );
  });
});
