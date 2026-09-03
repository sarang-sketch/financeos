/**
 * Task 8.4: `trialBalance`, against an injectable store.
 *
 * The aggregation itself is SQL and is proven against real rows in
 * `test/db/ledger-derivation-trial-balance.test.ts`. What lives here is everything
 * the service decides on top of it, which is where the arithmetic that property
 * P13 (task 8.7) asserts actually happens:
 *
 * 1. The **closing sign rule per `account_kind`**: `debits − credits` for `asset`
 *    and `expense`, `credits − debits` for `liability`, `equity` and `income`. All
 *    five kinds are covered, both signs each.
 * 2. Shaping: one row per account, ordered by `account_code`, every figure an
 *    integer paise `bigint`, and Σdebit equal to Σcredit across the result.
 * 3. The four range edges — empty, single-day, entirely outside the data, and
 *    boundaries coinciding exactly with entry dates — including that the range the
 *    store is asked for is exactly the range it was given, inclusive at both ends.
 * 4. Faults: an inverted range, a date that is not a real calendar date, a non-UUID
 *    Tenant, and a store that returns an account twice or an account with no
 *    entries.
 *
 * **Validates: Requirements 2.5**
 */

import { describe, expect, it } from 'vitest';

import type { Actor } from '@/config/configuration-service';
import { ACCOUNT, type AccountKind, PostingRuleError } from './posting-rules';
import {
  type AccountPeriodTotals,
  createSemanticLedger,
  type LedgerAuditSink,
  type LedgerStore,
  SemanticLedgerError,
  type TrialBalanceQuery,
  trialBalanceCreditTotalPaise,
  trialBalanceDebitTotalPaise,
} from './semantic-ledger';

const TENANT = '3f1a2b4c-5d6e-4f70-8192-a3b4c5d6e7f8';
const ACTOR: Actor = { kind: 'user', id: 'usr_operator_1' };

const FROM = '2026-02-01';
const TO = '2026-02-28';

const noAudit: LedgerAuditSink = {
  append() {
    return Promise.reject(new Error('the trialBalance tests append no Audit_Event'));
  },
};

/**
 * A store that answers `trialBalanceTotals` with `totals` and records the query it
 * was given, so the inclusive bounds the service passes down are assertable.
 */
function totalsStore(totals: readonly AccountPeriodTotals[]): LedgerStore & {
  readonly queries: readonly TrialBalanceQuery[];
} {
  const queries: TrialBalanceQuery[] = [];
  return {
    queries,
    insertSet() {
      return Promise.reject(new Error('insertSet is not used by the trialBalance tests'));
    },
    findSourceRecord() {
      return Promise.reject(
        new Error('findSourceRecord is not used by the trialBalance tests'),
      );
    },
    findSet() {
      return Promise.reject(new Error('findSet is not used by the trialBalance tests'));
    },
    trialBalanceTotals(query) {
      queries.push(query);
      return Promise.resolve(totals);
    },
  };
}

function ledgerOver(totals: readonly AccountPeriodTotals[]) {
  const store = totalsStore(totals);
  return {
    store,
    ledger: createSemanticLedger({ store, audit: noAudit, actor: ACTOR }),
  };
}

const account = (
  account_code: string,
  kind: AccountKind,
  debit: bigint,
  credit: bigint,
): AccountPeriodTotals => ({
  account_code,
  kind,
  total_debit_paise: debit,
  total_credit_paise: credit,
});

/**
 * The February shape of one Payment (gross 100000, fee 2360, GST 424) settled in
 * full and refunded 40000, as the aggregation would return it. Σdebit = Σcredit =
 * 237216.
 */
const FEBRUARY: readonly AccountPeriodTotals[] = [
  account(ACCOUNT.BANK, 'asset', 97_216n, 0n),
  account(ACCOUNT.SETTLEMENT_PENDING, 'asset', 97_216n, 137_216n),
  account(ACCOUNT.GST_INPUT_CREDIT, 'asset', 424n, 0n),
  account(ACCOUNT.RAZORPAY_FEE_EXPENSE, 'expense', 2_360n, 0n),
  account(ACCOUNT.REVENUE, 'income', 40_000n, 100_000n),
];

/* -------------------------------------------------------------------------- */
/* 1. The closing sign rule, per account kind                                 */
/* -------------------------------------------------------------------------- */

describe('the closing balance sign rule', () => {
  async function closingFor(kind: AccountKind, debit: bigint, credit: bigint) {
    const { ledger } = ledgerOver([account('probe', kind, debit, credit)]);
    const balance = await ledger.trialBalance(TENANT, FROM, TO);
    return balance.rows[0]?.closing_balance_paise;
  }

  it('closes an asset account at debits minus credits', async () => {
    expect(await closingFor('asset', 97_216n, 40_000n)).toBe(57_216n);
    expect(await closingFor('asset', 40_000n, 97_216n)).toBe(-57_216n);
  });

  it('closes an expense account at debits minus credits', async () => {
    expect(await closingFor('expense', 2_360n, 0n)).toBe(2_360n);
    expect(await closingFor('expense', 0n, 2_360n)).toBe(-2_360n);
  });

  it('closes an income account at credits minus debits', async () => {
    // A Payment credits revenue at gross and a Refund debits it, so a Tenant taking
    // more payments than refunds closes positive.
    expect(await closingFor('income', 40_000n, 100_000n)).toBe(60_000n);
    expect(await closingFor('income', 100_000n, 40_000n)).toBe(-60_000n);
  });

  it('closes a liability account at credits minus debits', async () => {
    expect(await closingFor('liability', 1_000n, 25_000n)).toBe(24_000n);
    expect(await closingFor('liability', 25_000n, 1_000n)).toBe(-24_000n);
  });

  it('closes an equity account at credits minus debits', async () => {
    expect(await closingFor('equity', 0n, 500_000n)).toBe(500_000n);
    expect(await closingFor('equity', 500_000n, 0n)).toBe(-500_000n);
  });

  it('reports the kind the rule was applied for alongside the figures', async () => {
    const { ledger } = ledgerOver(FEBRUARY);
    const balance = await ledger.trialBalance(TENANT, FROM, TO);
    expect(
      balance.rows.map((row) => [row.account_code, row.kind, row.closing_balance_paise]),
    ).toEqual([
      [ACCOUNT.BANK, 'asset', 97_216n],
      [ACCOUNT.GST_INPUT_CREDIT, 'asset', 424n],
      [ACCOUNT.RAZORPAY_FEE_EXPENSE, 'expense', 2_360n],
      [ACCOUNT.REVENUE, 'income', 60_000n],
      [ACCOUNT.SETTLEMENT_PENDING, 'asset', -40_000n],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Shaping                                                                 */
/* -------------------------------------------------------------------------- */

describe('the shape of a trial balance', () => {
  it('returns one row per in-range account, ordered by account_code', async () => {
    const { ledger } = ledgerOver(FEBRUARY);
    const balance = await ledger.trialBalance(TENANT, FROM, TO);

    expect(balance.rows.map((r) => r.account_code)).toEqual([
      ACCOUNT.BANK,
      ACCOUNT.GST_INPUT_CREDIT,
      ACCOUNT.RAZORPAY_FEE_EXPENSE,
      ACCOUNT.REVENUE,
      ACCOUNT.SETTLEMENT_PENDING,
    ]);
    expect(new Set(balance.rows.map((r) => r.account_code)).size).toBe(balance.rows.length);
    expect(balance.from).toBe(FROM);
    expect(balance.to).toBe(TO);
  });

  it('holds summed debit equal to summed credit (Requirement 2.5)', async () => {
    const { ledger } = ledgerOver(FEBRUARY);
    const balance = await ledger.trialBalance(TENANT, FROM, TO);

    expect(trialBalanceDebitTotalPaise(balance)).toBe(237_216n);
    expect(trialBalanceCreditTotalPaise(balance)).toBe(
      trialBalanceDebitTotalPaise(balance),
    );
  });

  it('reports every figure as an integer paise bigint', async () => {
    const { ledger } = ledgerOver(FEBRUARY);
    const balance = await ledger.trialBalance(TENANT, FROM, TO);

    for (const row of balance.rows) {
      expect(typeof row.total_debit_paise).toBe('bigint');
      expect(typeof row.total_credit_paise).toBe('bigint');
      expect(typeof row.closing_balance_paise).toBe('bigint');
      expect(row.total_debit_paise >= 0n).toBe(true);
      expect(row.total_credit_paise >= 0n).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 3. The range edges                                                         */
/* -------------------------------------------------------------------------- */

describe('the range edges', () => {
  it('returns zero accounts and 0n totals for a range holding no entries', async () => {
    const { ledger } = ledgerOver([]);
    const balance = await ledger.trialBalance(TENANT, FROM, TO);

    expect(balance.rows).toEqual([]);
    expect(trialBalanceDebitTotalPaise(balance)).toBe(0n);
    expect(trialBalanceCreditTotalPaise(balance)).toBe(0n);
  });

  it('accepts a single-day range and passes the same date as both bounds', async () => {
    const { ledger, store } = ledgerOver([
      account(ACCOUNT.BANK, 'asset', 97_216n, 0n),
      account(ACCOUNT.SETTLEMENT_PENDING, 'asset', 0n, 97_216n),
    ]);
    const balance = await ledger.trialBalance(TENANT, '2026-02-14', '2026-02-14');

    expect(store.queries).toEqual([
      { tenant_id: TENANT, from: '2026-02-14', to: '2026-02-14' },
    ]);
    expect(balance.rows).toHaveLength(2);
    expect(trialBalanceDebitTotalPaise(balance)).toBe(
      trialBalanceCreditTotalPaise(balance),
    );
  });

  it('returns zero accounts for a range entirely outside the data', async () => {
    // The store finds nothing in 2019; the service reports that as no accounts
    // rather than as every account at zero.
    const { ledger, store } = ledgerOver([]);
    const balance = await ledger.trialBalance(TENANT, '2019-01-01', '2019-12-31');

    expect(store.queries[0]).toEqual({
      tenant_id: TENANT,
      from: '2019-01-01',
      to: '2019-12-31',
    });
    expect(balance.rows).toEqual([]);
  });

  it('passes boundary-coincident bounds through unchanged, so both ends are inclusive', async () => {
    // The caller's bounds are the entry dates themselves. Nothing is widened or
    // narrowed on the way down, so an entry dated exactly `from` or exactly `to` is
    // the store's to include.
    const { ledger, store } = ledgerOver(FEBRUARY);
    await ledger.trialBalance(TENANT, '2026-02-14', '2026-02-16');

    expect(store.queries).toEqual([
      { tenant_id: TENANT, from: '2026-02-14', to: '2026-02-16' },
    ]);
  });

  it('accepts a leap day as a bound', async () => {
    const { ledger, store } = ledgerOver([]);
    await ledger.trialBalance(TENANT, '2024-02-29', '2024-02-29');
    expect(store.queries[0]?.from).toBe('2024-02-29');
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Faults                                                                  */
/* -------------------------------------------------------------------------- */

describe('a trial balance request that cannot be answered', () => {
  it('raises on an inverted range rather than returning nothing', async () => {
    const { ledger, store } = ledgerOver(FEBRUARY);
    await expect(ledger.trialBalance(TENANT, TO, FROM)).rejects.toBeInstanceOf(
      SemanticLedgerError,
    );
    expect(store.queries).toEqual([]);
  });

  it('raises on a bound that is not a real calendar date', async () => {
    const { ledger, store } = ledgerOver(FEBRUARY);
    await expect(ledger.trialBalance(TENANT, '2026-02-30', TO)).rejects.toBeInstanceOf(
      PostingRuleError,
    );
    await expect(ledger.trialBalance(TENANT, FROM, '2026-13-01')).rejects.toBeInstanceOf(
      PostingRuleError,
    );
    await expect(ledger.trialBalance(TENANT, FROM, '14-02-2026')).rejects.toBeInstanceOf(
      PostingRuleError,
    );
    expect(store.queries).toEqual([]);
  });

  it('raises on a Tenant identifier that is not a UUID', async () => {
    const { ledger, store } = ledgerOver(FEBRUARY);
    await expect(ledger.trialBalance('tenant-1', FROM, TO)).rejects.toBeInstanceOf(
      SemanticLedgerError,
    );
    expect(store.queries).toEqual([]);
  });

  it('raises when the store returns one account twice', async () => {
    const { ledger } = ledgerOver([
      account(ACCOUNT.BANK, 'asset', 100n, 0n),
      account(ACCOUNT.BANK, 'asset', 0n, 100n),
    ]);
    // Requirement 2.5 gives each in-range account exactly one row; flattening two
    // would hide a store fault behind a plausible-looking trial balance.
    await expect(ledger.trialBalance(TENANT, FROM, TO)).rejects.toBeInstanceOf(
      SemanticLedgerError,
    );
  });

  it('raises when the store returns an account with no debits and no credits', async () => {
    // Every entry amount is paise_positive, so an in-range account cannot total 0
    // on both sides: two zeros means an account with no entry in range got a row.
    const { ledger } = ledgerOver([account(ACCOUNT.BANK, 'asset', 0n, 0n)]);
    await expect(ledger.trialBalance(TENANT, FROM, TO)).rejects.toBeInstanceOf(
      SemanticLedgerError,
    );
  });
});
