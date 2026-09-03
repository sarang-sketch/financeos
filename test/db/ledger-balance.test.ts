/**
 * The two ledger balance barriers, against Supabase local (task 4.8).
 *
 * `20260101000003_semantic_ledger.sql` puts two independent barriers in front of
 * an unbalanced Ledger_Entry_Set, and they catch different failures:
 *
 *   Barrier 1, IMMEDIATE - the `ledger_set_balanced` table `CHECK` rejects a set
 *   whose DECLARED totals disagree, at statement time, before any entry row is
 *   written.
 *
 *   Barrier 2, DEFERRED - declared totals can agree while the persisted entry
 *   rows disagree, which is only provable once every entry of the set is in. So
 *   `ledger_entries_balance_check` is a `DEFERRABLE INITIALLY DEFERRED` constraint
 *   trigger and fires at `COMMIT`.
 *
 * Both must persist ZERO Ledger_Entries (Requirement 2.6's atomic rejection). The
 * deferred case is the interesting one: the entry rows ARE visible inside the
 * transaction, so the test asserts they are there before `COMMIT` and gone after
 * the abort. Without the inside-the-transaction count, a test that only checked
 * the final count would pass even if the entries had never been inserted.
 *
 * `assert_ledger_set_balanced()` has two distinct `RAISE`s and both are exercised:
 * entries disagreeing with each other, and entries agreeing with each other but
 * disagreeing with the set's declared totals. A balanced set is committed too, as
 * a control - otherwise a broken fixture would make every rejection above vacuous.
 *
 * Requirements: 2.1, 2.6, 2.7. Property: P12.
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  claims,
  database,
  jsonAt,
  jsonScalar,
  lit,
  newFixture,
  provision,
  rolledBack,
  runScript,
  type Fixture,
  type ScriptResult,
} from './pg';

/** `integrity_constraint_violation`, the ERRCODE both `RAISE`s in the trigger use. */
const INTEGRITY_CONSTRAINT_VIOLATION = '23000';
/** `check_violation`, raised by the `ledger_set_balanced` table CHECK. */
const CHECK_VIOLATION = '23514';

function insertSet(
  f: Fixture,
  setId: string,
  opts: { readonly debit: bigint; readonly credit: bigint; readonly entryCount: number },
): string {
  return `
insert into ledger_entry_sets
  (id, tenant_id, entry_date, entry_count, total_debit_paise, total_credit_paise, created_by)
values (${lit(setId)}, ${lit(f.tenantId)}, current_date, ${opts.entryCount},
        ${opts.debit}, ${opts.credit}, 'db-test');`;
}

function insertEntry(
  f: Fixture,
  setId: string,
  opts: { readonly side: 'debit' | 'credit'; readonly amount: bigint; readonly line: number },
): string {
  const account = opts.side === 'debit' ? f.debitAccount : f.creditAccount;
  return `
insert into ledger_entries
  (tenant_id, set_id, account_code, side, amount_paise, entry_date, line_no)
values (${lit(f.tenantId)}, ${lit(setId)}, ${lit(account)}, ${lit(opts.side)},
        ${opts.amount}, current_date, ${opts.line});`;
}

const countEntriesFor = (f: Fixture): string =>
  jsonScalar(`(select count(*)::int from ledger_entries where tenant_id = ${lit(f.tenantId)})`);

/**
 * One transaction that inserts a set and its entries and then tries to commit.
 * Both counts are emitted: index 0 from inside the transaction, index 1 after it.
 */
function commitAttempt(
  f: Fixture,
  setId: string,
  declared: { readonly debit: bigint; readonly credit: bigint },
  entries: readonly { readonly side: 'debit' | 'credit'; readonly amount: bigint }[],
): ScriptResult {
  const rows = entries
    .map((e, i) => insertEntry(f, setId, { side: e.side, amount: e.amount, line: i + 1 }))
    .join('\n');
  return runScript(
    `begin;
${provision(f)}
${insertSet(f, setId, { debit: declared.debit, credit: declared.credit, entryCount: entries.length })}
${rows}
${countEntriesFor(f)}
commit;
${countEntriesFor(f)}`,
  );
}

describe.skipIf(!database().reachable)('ledger balance barriers', () => {
  describe('barrier 1: declared totals mismatched, rejected immediately', () => {
    const f = newFixture();
    let result: ScriptResult;

    beforeAll(() => {
      // The attempt sits inside a rolled-back transaction, so the count query that
      // follows it runs outside and sees exactly what would have persisted.
      result = runScript(
        `${rolledBack(
          `${provision(f)}\n${insertSet(f, randomUUID(), {
            debit: 100n,
            credit: 200n,
            entryCount: 2,
          })}`,
        )}
${countEntriesFor(f)}`,
      );
    });

    it('is rejected at statement time by the ledger_set_balanced CHECK', () => {
      expect(result.errors, `expected one rejection, got:\n${result.rawErr}`).toHaveLength(1);
      const [error] = result.errors;
      expect(error?.sqlstate).toBe(CHECK_VIOLATION);
      expect(error?.constraint).toBe('ledger_set_balanced');
      expect(error?.table).toBe('ledger_entry_sets');
    });

    it('persists zero ledger_entries', () => {
      expect(jsonAt<number>(result, 0)).toBe(0);
    });
  });

  describe('barrier 2: declared totals agree, entries disagree with each other', () => {
    const f = newFixture();
    let result: ScriptResult;

    beforeAll(() => {
      // A real COMMIT, not `SET CONSTRAINTS ALL IMMEDIATE`: the point of the test is
      // that the rejection happens at commit time. The commit failure rolls the whole
      // transaction back, fixture included, so nothing is left behind.
      result = commitAttempt(f, randomUUID(), { debit: 100n, credit: 100n }, [
        { side: 'debit', amount: 100n },
        { side: 'credit', amount: 90n },
      ]);
    });

    it('accepts both entry inserts, so the imbalance is only provable at commit', () => {
      expect(jsonAt<number>(result, 0)).toBe(2);
    });

    it('is rejected at commit by the deferred ledger_entries_balance_check trigger', () => {
      expect(result.errors, `expected one rejection, got:\n${result.rawErr}`).toHaveLength(1);
      const [error] = result.errors;
      expect(error?.sqlstate).toBe(INTEGRITY_CONSTRAINT_VIOLATION);
      expect(error?.message).toContain('unbalanced');
      // debit 100, credit 90: the trigger reports the imbalance, not just the fact.
      expect(error?.message).toContain('imbalance 10 paise');
    });

    it('persists zero ledger_entries once the transaction aborts', () => {
      expect(jsonAt<number>(result, 1)).toBe(0);
    });
  });

  describe('barrier 2: entries agree with each other but not with the declared totals', () => {
    const f = newFixture();
    let result: ScriptResult;

    beforeAll(() => {
      result = commitAttempt(f, randomUUID(), { debit: 100n, credit: 100n }, [
        { side: 'debit', amount: 250n },
        { side: 'credit', amount: 250n },
      ]);
    });

    it('holds both entries until commit', () => {
      expect(jsonAt<number>(result, 0)).toBe(2);
    });

    it('is rejected at commit as a declared-totals mismatch', () => {
      expect(result.errors, `expected one rejection, got:\n${result.rawErr}`).toHaveLength(1);
      const [error] = result.errors;
      expect(error?.sqlstate).toBe(INTEGRITY_CONSTRAINT_VIOLATION);
      expect(error?.message).toContain('declared totals do not match its entries');
    });

    it('persists zero ledger_entries once the transaction aborts', () => {
      expect(jsonAt<number>(result, 1)).toBe(0);
    });
  });

  // Control. Without this, every rejection above could be produced by a fixture
  // that cannot insert a Ledger_Entry at all.
  it('commits a set whose declared totals and entries all agree', () => {
    const f = newFixture();
    const setId = randomUUID();

    const created = runScript(
      `begin;
${provision(f)}
${insertSet(f, setId, { debit: 100n, credit: 100n, entryCount: 2 })}
${insertEntry(f, setId, { side: 'debit', amount: 100n, line: 1 })}
${insertEntry(f, setId, { side: 'credit', amount: 100n, line: 2 })}
commit;`,
    );
    expect(created.errors, `expected a clean commit, got:\n${created.rawErr}`).toEqual([]);

    const after = runScript(`${claims(f)}\n${countEntriesFor(f)}`);
    expect(after.errors).toEqual([]);
    expect(jsonAt<number>(after, 0)).toBe(2);
  });
});
