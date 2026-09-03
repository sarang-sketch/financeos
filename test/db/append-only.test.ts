/**
 * Append-only enforcement on `ledger_entries` and `audit_events`, against
 * Supabase local (task 4.8).
 *
 * Two barriers, tested separately because they fail differently:
 *
 *   Barrier 1, PRIVILEGE - migrations 4.3 and 4.4 revoke `UPDATE`, `DELETE` and
 *   `TRUNCATE` on both tables from `authenticated`, `anon` and `service_role`, so
 *   the application role never reaches a trigger at all. Asserted here as
 *   `authenticated`, which is the closest this task can get to "run as the
 *   application role" - see the role note at the top of `pg.ts` for why the rest
 *   of the suite cannot.
 *
 *   Barrier 2, TRIGGER - `reject_mutation_and_audit()` fires `BEFORE UPDATE OR
 *   DELETE`, so the targeted row is never written. Requirement 13.5 asks for two
 *   things from it: the mutation is REJECTED, and the rejected attempt is
 *   APPENDED as a `mutation_rejected` Audit_Event.
 *
 * WHY THE TWO HALVES OF BARRIER 2 ARE ASSERTED SEPARATELY
 * `reject_mutation_and_audit()` appends via `app.append_audit_event_autonomous()`,
 * which opens a second connection with `dblink_connect('dbname=' ||
 * current_database())` so the event survives the rollback the rejecting `RAISE`
 * causes. If that connection cannot be made, the whole statement fails with the
 * dblink error instead of the append-only error - which looks exactly like a
 * broken append-only barrier if the two halves are checked together. So each
 * combination gets three assertions: the mutation was rejected and the row is
 * unchanged (which holds either way), the rejection was CLASSIFIED as the
 * append-only barrier, and the Audit_Event was appended.
 *
 * ---------------------------------------------------------------------------
 * FINDING (task 4.8, confirmed at runtime - the reason for the `it.fails` below)
 *
 * The autonomous append does NOT work on Supabase local, and will not work on
 * Supabase-hosted either. `dblink_connect` refuses a passwordless conninfo for a
 * non-superuser:
 *
 *   ERROR:  2F003: password or GSSAPI delegated credentials required
 *   DETAIL: Non-superusers must provide a password in the connection string or
 *           send delegated GSSAPI credentials.
 *   CONTEXT: SQL statement "SELECT dblink_connect(v_conn, 'dbname=' ||
 *            current_database())"
 *            PL/pgSQL function app.append_audit_event_autonomous(...) line 21
 *
 * On Supabase local the `postgres` role holds `BYPASSRLS` but is NOT a superuser,
 * which is the same shape as Supabase-hosted, so this is a production defect and
 * not a local-environment quirk. Two consequences, both asserted below:
 *
 *   - The mutation is still rejected and the row is still unchanged. The
 *     append-only guarantee of Requirement 2.7 holds.
 *   - The rejection carries SQLSTATE `2F003` from dblink rather than `23001`
 *     `restrict_violation` from the barrier, and NO `mutation_rejected`
 *     Audit_Event is appended. The second half of Requirement 13.5 does not hold.
 *
 * This is FINDING 2/8 of `20260101000004_audit_log_append_only.sql` materialising:
 * that file records that design.md specifies no connection strategy and that a
 * conninfo carrying a credential must not live in a migration. Resolving it is a
 * design.md and task 4.4 decision, not task 4.8's, and the two candidate fixes -
 * a credentialled conninfo, or escalating the definer to a superuser - both have
 * consequences well outside this task. Escalating the role locally would have made
 * these tests pass while leaving the hosted defect in place, so it was not done.
 *
 * The two affected assertions are therefore marked `it.fails`: the test bodies
 * assert the CORRECT behaviour and genuinely fail. When task 4.4 is fixed they
 * will start passing, `it.fails` will report that as an error, and this block has
 * to be removed - so the gap cannot be quietly forgotten.
 * ---------------------------------------------------------------------------
 *
 * Requirements: 2.7, 13.1, 13.5. Property: P12.
 *
 * NOTE ON CLEANUP: this file is the one suite that must commit its fixture, since
 * a rejection can only be attempted against a persisted row - and both tables are
 * append-only, so those rows cannot be removed afterwards. Every identifier is
 * freshly generated, so runs never collide; `npx supabase db reset` clears them.
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  claims,
  database,
  jsonAt,
  lit,
  newFixture,
  provision,
  runScript,
  type Fixture,
  type ScriptResult,
} from './pg';

/** `restrict_violation`, the ERRCODE `reject_mutation_and_audit()` raises. */
const RESTRICT_VIOLATION = '23001';
/** `insufficient_privilege`, what barrier 1 produces for the application role. */
const INSUFFICIENT_PRIVILEGE = '42501';

const f: Fixture = newFixture();
const setId = randomUUID();
const entryId = randomUUID();
let auditEventId = '';

/** Always one output line: a JSON array of 0 or 1 full rows. */
function snapshot(table: string, id: string): string {
  return `select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)::text
          from ${table} x where x.id = ${lit(id)};`;
}

function mutationRejectedEvents(operation: string, targetId: string): string {
  return `select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)::text
          from audit_events x
          where x.tenant_id = ${lit(f.tenantId)}
            and x.event_type = 'mutation_rejected'
            and x.payload ->> 'operation' = ${lit(operation)}
            and x.payload ->> 'target_id' = ${lit(targetId)};`;
}

/** One attempted mutation, with a full row snapshot either side of it. */
interface Attempt {
  readonly result: ScriptResult;
  readonly before: Record<string, unknown>;
  readonly after: Record<string, unknown>;
  readonly auditEvents: readonly Record<string, unknown>[];
}

function attemptMutation(table: string, id: string, operation: 'UPDATE' | 'DELETE'): Attempt {
  const mutation =
    operation === 'UPDATE'
      ? `update ${table} set tenant_id = tenant_id where id = ${lit(id)};`
      : `delete from ${table} where id = ${lit(id)};`;

  // No BEGIN: each statement is its own transaction, so the rejection aborts only
  // itself and the snapshot after it still runs.
  const result = runScript(
    `${claims(f)}
${snapshot(table, id)}
${mutation}
${snapshot(table, id)}
${mutationRejectedEvents(operation, id)}`,
  );

  const beforeRows = jsonAt<readonly Record<string, unknown>[]>(result, 0);
  const afterRows = jsonAt<readonly Record<string, unknown>[]>(result, 1);
  expect(beforeRows, 'the targeted row must exist before the attempt').toHaveLength(1);
  expect(afterRows, 'the targeted row must still exist after the attempt').toHaveLength(1);

  return {
    result,
    before: beforeRows[0] ?? {},
    after: afterRows[0] ?? {},
    auditEvents: jsonAt<readonly Record<string, unknown>[]>(result, 2),
  };
}

/** Compare the two snapshots key by key, not with one deep-equality assertion. */
function expectRowUnchanged(a: Attempt): void {
  const beforeKeys = Object.keys(a.before).sort();
  const afterKeys = Object.keys(a.after).sort();
  expect(afterKeys).toEqual(beforeKeys);
  for (const key of beforeKeys) {
    expect(a.after[key], `column ${key} changed`).toEqual(a.before[key]);
  }
}

describe.skipIf(!database().reachable)('append-only enforcement', () => {
  beforeAll(() => {
    // Committed, because a rejection can only be attempted against a persisted row.
    const created = runScript(
      `begin;
${provision(f)}
insert into ledger_entry_sets
  (id, tenant_id, entry_date, entry_count, total_debit_paise, total_credit_paise, created_by)
values (${lit(setId)}, ${lit(f.tenantId)}, current_date, 2, 100, 100, 'db-test');
insert into ledger_entries
  (id, tenant_id, set_id, account_code, side, amount_paise, entry_date, line_no)
values (${lit(entryId)}, ${lit(f.tenantId)}, ${lit(setId)}, ${lit(f.debitAccount)},
        'debit', 100, current_date, 1);
insert into ledger_entries
  (tenant_id, set_id, account_code, side, amount_paise, entry_date, line_no)
values (${lit(f.tenantId)}, ${lit(setId)}, ${lit(f.creditAccount)},
        'credit', 100, current_date, 2);
commit;
select (app.append_audit_event(
  ${lit(f.tenantId)}, 'db_test_seed', 'user', ${lit(f.userId)},
  NULL, NULL, NULL, '[]'::jsonb, '{"seed":true}'::jsonb, now())).id::text;`,
    );
    expect(created.errors, `fixture setup failed:\n${created.rawErr}`).toEqual([]);
    auditEventId = created.out[0] ?? '';
    expect(auditEventId, 'the seed Audit_Event must exist').not.toBe('');
  });

  // ---------------------------------------------------------------------------
  // Barrier 2, per table and per operation.
  // ---------------------------------------------------------------------------

  const combinations = [
    { table: 'ledger_entries', operation: 'UPDATE' },
    { table: 'ledger_entries', operation: 'DELETE' },
    { table: 'audit_events', operation: 'UPDATE' },
    { table: 'audit_events', operation: 'DELETE' },
  ] as const;

  for (const { table, operation } of combinations) {
    describe(`${operation} on ${table}`, () => {
      let attempt: Attempt;

      beforeAll(() => {
        attempt = attemptMutation(
          table,
          table === 'ledger_entries' ? entryId : auditEventId,
          operation,
        );
      });

      it('fails, and leaves the targeted row unchanged field by field', () => {
        expect(
          attempt.result.errors,
          `expected exactly one rejection, got:\n${attempt.result.rawErr}`,
        ).toHaveLength(1);
        expectRowUnchanged(attempt);
      });

      // See the FINDING at the top of this file: currently 2F003 from dblink, not
      // 23001 from the barrier. The assertion is the correct one and it fails.
      it.fails('is rejected by the append-only barrier itself, not by a dblink failure', () => {
        const [error] = attempt.result.errors;
        expect(error?.sqlstate).toBe(RESTRICT_VIOLATION);
        expect(error?.message).toBe(`${table} is append-only: ${operation} rejected`);
      });

      // See the FINDING at the top of this file: the autonomous append cannot
      // connect, so nothing is appended. Requirement 13.5's second half.
      it.fails('appends a mutation_rejected Audit_Event naming the actor and the target', () => {
        expect(attempt.auditEvents).toHaveLength(1);
        const event = attempt.auditEvents[0];
        const payload = event?.['payload'] as Record<string, unknown> | undefined;
        expect(event?.['actor_id']).toBe(f.userId);
        expect(payload?.['table']).toBe(table);
        expect(payload?.['operation']).toBe(operation);
        expect(payload?.['target_id']).toBe(table === 'ledger_entries' ? entryId : auditEventId);
        // On audit_events the payload also carries the targeted sequence number;
        // on ledger_entries there is no such column and it is NULL (FINDING 7).
        if (table === 'audit_events') {
          expect(payload?.['targeted_sequence_number']).not.toBeNull();
        } else {
          expect(payload?.['targeted_sequence_number']).toBeNull();
        }
      });
    });
  }

  /**
   * Pins the CAUSE of the two `it.fails` above, so the documented finding is
   * machine-checked rather than only described in a comment. Without this, an
   * `it.fails` would keep passing if the rejection started failing for some
   * entirely different reason.
   *
   * DELETE ME when task 4.4 fixes the autonomous append: this test will fail, and
   * that failure is the signal to remove the `it.fails` markers too.
   */
  it('currently fails at dblink_connect rather than at the barrier (task 4.4 finding)', () => {
    const attempt = attemptMutation('ledger_entries', entryId, 'UPDATE');
    const [error] = attempt.result.errors;
    expect(error?.sqlstate).toBe('2F003');
    expect(error?.message).toContain('password or GSSAPI delegated credentials required');
    expect(attempt.result.rawErr).toContain('dblink_connect');
    expect(attempt.result.rawErr).toContain('app.append_audit_event_autonomous');
    expect(attempt.auditEvents, 'no mutation_rejected event can be appended').toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Barrier 1, as the application role. This is the half of "run as the
  // application role" that IS reachable before task 26.1: a privilege check is
  // evaluated before RLS, so the absent policies do not interfere.
  // ---------------------------------------------------------------------------

  describe('barrier 1: the application role holds no UPDATE or DELETE privilege', () => {
    for (const { table, operation } of combinations) {
      it(`denies ${operation} on ${table} to authenticated`, () => {
        const mutation =
          operation === 'UPDATE'
            ? `update ${table} set tenant_id = tenant_id;`
            : `delete from ${table};`;
        // Rolled back regardless. `SET LOCAL ROLE` reverts with the transaction, so
        // the session never leaks the reduced role into a later statement.
        const r = runScript(`begin;\nset local role authenticated;\n${mutation}\nrollback;`);
        expect(r.errors, `expected one denial, got:\n${r.rawErr}`).toHaveLength(1);
        const [error] = r.errors;
        expect(error?.sqlstate).toBe(INSUFFICIENT_PRIVILEGE);
        expect(error?.message).toContain(`permission denied for table ${table}`);
      });
    }
  });
});
