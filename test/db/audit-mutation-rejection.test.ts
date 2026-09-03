/**
 * The mutation-rejection guarantee on `audit_events`, against Supabase local
 * (task 25.5, Requirement 13.5 and 13.10).
 *
 * WHAT `append-only.test.ts` (task 4.8) ALREADY PROVES, AND IS NOT REPEATED HERE
 *   - an `UPDATE` or a `DELETE` on `ledger_entries` and on `audit_events` raises
 *     exactly one error and the targeted row survives, compared column by column
 *     over a full `to_jsonb(OLD)` snapshot;
 *   - `it.fails`: the rejection is CLASSIFIED as `23001 restrict_violation` with
 *     the `<table> is append-only: <op> rejected` message;
 *   - `it.fails`: a `mutation_rejected` Audit_Event exists, with a
 *     `targeted_sequence_number` that is merely `not.toBeNull()`;
 *   - barrier 1: `authenticated` is denied `42501` on both tables, both verbs;
 *   - a pin on the present cause: `2F003` raised at `dblink_connect`.
 *
 * WHAT THIS FILE ADDS, all specific to Requirement 13.5 and 13.10
 *   1. The five fields Requirement 13.5 NAMES - sequence number, timestamp, actor
 *      identifier, event payload, Chain_Value - asserted individually and by name,
 *      against a mutation that tries to change exactly those five. Task 4.8's
 *      `UPDATE` is `set tenant_id = tenant_id`, which writes the value it already
 *      holds, so an unchanged row there does not distinguish "the write was
 *      refused" from "the write was a no-op".
 *   2. Requirement 13.10 as a genuinely LATER read, from a NEW session: the same
 *      sequence number, timestamp, actor, payload bytes and Chain_Value come back
 *      out of a connection that was not the one the attempt was made on.
 *   3. WHICH BARRIER FIRED, positively identified per verb rather than "something
 *      failed". As the owner the attempt reaches barrier 2 and the trigger appears
 *      in the error context; as `authenticated` it is stopped at barrier 1 with
 *      `42501` and the trigger never runs at all. Since task 26.1 landed,
 *      `audit_events` carries SELECT and INSERT policies only - so the assertion
 *      that matters is that the REVOKE is what refuses the verb, not an absent
 *      policy: a privilege check is evaluated before RLS, and an absent policy
 *      would filter to zero rows silently rather than raise.
 *   4. `targeted_sequence_number` EQUAL to the targeted event's sequence number,
 *      and the actor equal to the requesting actor, rather than non-null.
 *
 * ---------------------------------------------------------------------------
 * THE SECOND HALF OF REQUIREMENT 13.5 IS STILL BLOCKED - task 4.4's, not 25.5's
 *
 * `reject_mutation_and_audit()` records the attempt through
 * `app.append_audit_event_autonomous()`, which opens a second connection with
 * `dblink_connect('dbname=' || current_database())` so the append survives the
 * rollback the rejecting `RAISE` causes. That connect fails:
 *
 *   ERROR:  2F003: password or GSSAPI delegated credentials required
 *   CONTEXT: SQL statement "SELECT dblink_connect(v_conn, 'dbname=' ||
 *            current_database())"
 *
 * `postgres` on Supabase local holds `BYPASSRLS` but is NOT a superuser, which is
 * the same shape as Supabase-hosted, so this is a production defect rather than a
 * local quirk (FINDING 2 and 8 of `20260101000004_audit_log_append_only.sql`).
 * Consequence: the mutation is still refused and the targeted event is still
 * intact - Requirement 13.5's first two clauses hold and are asserted below as
 * passing tests - but no `mutation_rejected` Audit_Event is appended, so the third
 * clause does not. That single assertion is marked `it.fails` with the CORRECT
 * expectation in its body, so whichever repair lands turns it into a reported
 * error. Nothing here relaxes the revoke, drops a trigger or grants a privilege.
 *
 * WHAT UNBLOCKS IT: `app.append_audit_event_autonomous` needs a connection it can
 * actually open as a non-superuser - a conninfo carrying a credential, which must
 * not live in a migration, so it has to be resolved out of a secret or a foreign
 * server; or an owner that is permitted a passwordless local connect. Both are
 * design.md decisions on top of task 4.4's function.
 *
 * A SECOND, UNREPORTED HAZARD IN THE SAME FUNCTION, found while shaping this file
 * and the reason the target Audit_Event below is COMMITTED rather than appended
 * inside the rolled-back transaction: `app.append_audit_event` takes the Tenant's
 * `audit_sequence_counters` row with `SELECT ... FOR UPDATE`, and the calling
 * transaction holds that lock until it ends. So if a transaction appends an
 * Audit_Event and then, still open, triggers a rejected mutation on `audit_events`
 * or `ledger_entries` for the same Tenant, the autonomous connection blocks on the
 * counter row while the calling transaction blocks on `dblink_exec`. Neither wait
 * is visible to the deadlock detector, because the caller is waiting on a socket
 * read rather than on a lock, so the statement hangs indefinitely. Today the
 * `2F003` above masks it. It is therefore NOT exercised here - a test for it would
 * hang the suite the moment the connect starts succeeding - and it is reported for
 * task 4.4 instead.
 *
 * NOTE ON CLEANUP: everything in this file is rolled back except the minimum a
 * cross-connection append needs to be able to observe - one `tenants` row, its
 * `audit_sequence_counters` row, and the one target Audit_Event. Those are
 * committed because an autonomous append runs on a different connection and can
 * never see uncommitted fixture rows, so the `it.fails` above could not flip on
 * repair without them. `audit_events` revokes `DELETE`, so that row cannot be
 * removed afterwards; every identifier is freshly generated per run, so runs never
 * collide, and `npx supabase db reset` clears them.
 *
 * Requirements: 13.5, 13.10.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  announceIfUnreachable,
  claims,
  database,
  jsonAt,
  jsonRows,
  lit,
  newFixture,
  rolledBack,
  runScript,
  type Fixture,
} from './pg';

/** `restrict_violation`: what `reject_mutation_and_audit()` raises at barrier 2. */
const RESTRICT_VIOLATION = '23001';
/** What `dblink_connect` raises today from inside that same trigger (task 4.4). */
const DBLINK_NO_CREDENTIAL = '2F003';
/** `insufficient_privilege`: barrier 1, the REVOKE, evaluated before any policy. */
const INSUFFICIENT_PRIVILEGE = '42501';

/** The committed target event. Money is digit text in the payload, never a float. */
const TARGET_OCCURRED_AT = '2026-02-14T09:30:00.000Z';
const TARGET_PAYLOAD = '{"note":"mutation_rejection_target","impact_paise":"38200000"}';
const TARGET_SOURCE_REFS = '[{"type":"settlement","id":"setl_SYNTHETIC9281"}]';

/** Exactly the five fields Requirement 13.5 names, plus what pins "nothing else". */
interface TargetSnapshot {
  /** Digit text, so a 64-bit sequence number never passes through a double. */
  readonly sequence_number: string;
  /** The UTC millisecond text form of Requirement 13.1. */
  readonly occurred_at: string;
  readonly actor_id: string;
  readonly actor_kind: string;
  /** `payload::text`, the stored bytes rather than a reparse of them. */
  readonly payload_text: string;
  readonly chain_value: string;
  readonly prev_chain_value: string;
  /** Over the whole row, so a change to any other column is caught too. */
  readonly row_digest: string;
}

interface RejectionEvent {
  readonly actor_id: string;
  readonly actor_kind: string;
  readonly target_table: string;
  readonly operation: string;
  readonly target_id: string;
  /** `payload ->> ...`, so it arrives as digit text like `sequence_number`. */
  readonly targeted_sequence_number: string | null;
}

const f: Fixture = newFixture();
let targetId = '';
let targetSequenceNumber = '';

const targetSnapshotSql = (): string =>
  jsonRows(`
    select x.sequence_number::text as sequence_number,
           to_char(x.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             as occurred_at,
           x.actor_id, x.actor_kind,
           x.payload::text as payload_text,
           x.chain_value, x.prev_chain_value,
           md5(to_jsonb(x)::text) as row_digest
      from audit_events x where x.id = ${lit(targetId)}`);

const rejectionEventsSql = (operation: 'UPDATE' | 'DELETE'): string =>
  jsonRows(`
    select x.actor_id, x.actor_kind,
           x.payload ->> 'table'                    as target_table,
           x.payload ->> 'operation'                as operation,
           x.payload ->> 'target_id'                as target_id,
           x.payload ->> 'targeted_sequence_number' as targeted_sequence_number
      from audit_events x
     where x.tenant_id = ${lit(f.tenantId)}
       and x.event_type = 'mutation_rejected'
       and x.payload ->> 'operation' = ${lit(operation)}
       and x.payload ->> 'target_id' = ${lit(targetId)}`);

/**
 * The mutation each verb attempts. The `UPDATE` sets every one of Requirement
 * 13.5's five named fields to a different value, so "unchanged" means the write
 * was refused rather than that it wrote what was already there.
 */
const mutationSql = (operation: 'UPDATE' | 'DELETE'): string =>
  operation === 'UPDATE'
    ? `update audit_events
          set sequence_number = sequence_number + 1000,
              occurred_at     = occurred_at + interval '1 day',
              actor_id        = 'tampered_actor',
              payload         = '{"tampered":true}'::jsonb,
              chain_value     = repeat('a', 64)
        where id = ${lit(targetId)};`
    : `delete from audit_events where id = ${lit(targetId)};`;

/** One attempted mutation: the row before, the row after, and what was appended. */
interface Attempt {
  readonly sqlstate: string;
  readonly errorCount: number;
  readonly rawErr: string;
  readonly before: TargetSnapshot | undefined;
  readonly after: TargetSnapshot | undefined;
  readonly later: TargetSnapshot | undefined;
  readonly rejectionEvents: readonly RejectionEvent[];
}

function attempt(operation: 'UPDATE' | 'DELETE'): Attempt {
  // No BEGIN: each statement is its own transaction, so the rejection aborts only
  // itself and the reads after it still run. It also means this session holds no
  // lock on the Tenant's counter row while the trigger runs - see the hazard note
  // in the file header.
  const r = runScript(
    [
      claims(f),
      targetSnapshotSql(),
      mutationSql(operation),
      targetSnapshotSql(),
      rejectionEventsSql(operation),
    ].join('\n'),
  );

  // A genuinely later read, on a connection that is not the one the attempt was
  // made on: Requirement 13.10's "reading the Audit_Log at a later time".
  const laterSession = runScript([claims(f), targetSnapshotSql()].join('\n'));
  expect(laterSession.errors, laterSession.rawErr).toHaveLength(0);

  return {
    sqlstate: r.errors[0]?.sqlstate ?? '',
    errorCount: r.errors.length,
    rawErr: r.rawErr,
    before: jsonAt<readonly TargetSnapshot[]>(r, 0)[0],
    after: jsonAt<readonly TargetSnapshot[]>(r, 1)[0],
    later: jsonAt<readonly TargetSnapshot[]>(laterSession, 0)[0],
    rejectionEvents: jsonAt<readonly RejectionEvent[]>(r, 2),
  };
}

beforeAll(announceIfUnreachable);

describe.skipIf(!database().reachable)('rejecting a mutation of an Audit_Event', () => {
  beforeAll(() => {
    // Committed, and no more than a cross-connection append needs to see. See the
    // cleanup note in the file header for why this one fixture cannot be rolled back.
    const created = runScript(
      `begin;
${claims(f)}
insert into tenants (id, name) values (${lit(f.tenantId)}, 'db-test-25-5');
insert into audit_sequence_counters (tenant_id) values (${lit(f.tenantId)});
commit;
select (app.append_audit_event(
  ${lit(f.tenantId)}, 'mutation_rejection_target', 'user', ${lit(f.userId)},
  'VERIFY', 'succeeded', NULL,
  ${lit(TARGET_SOURCE_REFS)}::jsonb, ${lit(TARGET_PAYLOAD)}::jsonb,
  ${lit(TARGET_OCCURRED_AT)}::timestamptz)).id::text;`,
    );
    expect(created.errors, `fixture setup failed:\n${created.rawErr}`).toEqual([]);
    targetId = created.out[0] ?? '';
    expect(targetId, 'the target Audit_Event must exist').not.toBe('');

    const seq = runScript(
      `select sequence_number::text from audit_events where id = ${lit(targetId)};`,
    );
    expect(seq.errors, seq.rawErr).toEqual([]);
    targetSequenceNumber = seq.out[0] ?? '';
    expect(targetSequenceNumber).toBe('1');
  });

  for (const operation of ['UPDATE', 'DELETE'] as const) {
    describe(`${operation} as the table owner, which reaches barrier 2`, () => {
      let a: Attempt;

      beforeAll(() => {
        a = attempt(operation);
      });

      it('is refused, by the append-only trigger rather than by a privilege check', () => {
        expect(a.errorCount, `expected exactly one rejection, got:\n${a.rawErr}`).toBe(1);
        // Which barrier fired, positively. `postgres` owns the table and still holds
        // UPDATE and DELETE - the REVOKE named `authenticated`, `anon` and
        // `service_role` - so this attempt is not stopped at barrier 1, and the
        // trigger's own frame is in the error context to prove it ran.
        expect(a.sqlstate).not.toBe(INSUFFICIENT_PRIVILEGE);
        expect(a.rawErr).toContain('reject_mutation_and_audit');
        // Task 4.8's `it.fails` owns the classification assertion (`23001` with the
        // append-only message). Repair-agnostic here on purpose: `2F003` is raised by
        // `dblink_connect` INSIDE the trigger today, `23001` by the trigger's own
        // RAISE once task 4.4 lands. Either way barrier 2 is where it stopped.
        expect(
          [RESTRICT_VIOLATION, DBLINK_NO_CREDENTIAL],
          `unexpected barrier-2 SQLSTATE ${a.sqlstate}:\n${a.rawErr}`,
        ).toContain(a.sqlstate);
      });

      it('leaves the sequence number, timestamp, actor, payload and Chain_Value alone', () => {
        // Requirement 13.5, field by field and by name, against a mutation that tried
        // to change every one of them.
        expect(a.before, 'the target must exist before the attempt').toBeDefined();
        expect(a.after, 'the target must still exist after the attempt').toBeDefined();

        expect(a.after?.sequence_number).toBe(targetSequenceNumber);
        expect(a.after?.occurred_at).toBe(TARGET_OCCURRED_AT);
        expect(a.after?.actor_id).toBe(f.userId);
        expect(a.after?.chain_value).toBe(a.before?.chain_value);
        expect(a.after?.chain_value).toMatch(/^[0-9a-f]{64}$/);
        // The stored bytes, not a reparse: `jsonb::text` is what the Chain_Value was
        // hashed over, so this is the form a change would have to show up in.
        expect(a.after?.payload_text).toBe(a.before?.payload_text);
        expect(a.after?.payload_text).toContain('"impact_paise": "38200000"');
        // Nothing the five do not name changed either.
        expect(a.after?.row_digest).toBe(a.before?.row_digest);
      });

      it('returns the same five fields to a later read on a different connection', () => {
        // Requirement 13.10. A separate `psql` session, so this is the stored row
        // rather than anything cached by the session that made the attempt.
        expect(a.later, 'the target must be readable later').toBeDefined();
        expect(a.later?.sequence_number).toBe(targetSequenceNumber);
        expect(a.later?.occurred_at).toBe(TARGET_OCCURRED_AT);
        expect(a.later?.actor_id).toBe(f.userId);
        expect(a.later?.payload_text).toBe(a.before?.payload_text);
        expect(a.later?.chain_value).toBe(a.before?.chain_value);
        expect(a.later?.prev_chain_value).toBe('0'.repeat(64));
        expect(a.later?.row_digest).toBe(a.before?.row_digest);
      });

      /**
       * Requirement 13.5's third clause. Blocked on task 4.4's autonomous append -
       * see the file header for the exact failure and what unblocks it. The body is
       * the correct expectation, so a repair turns this into a reported error rather
       * than leaving the gap to be rediscovered.
       *
       * Distinct from task 4.8's `it.fails`, which asserts only that
       * `targeted_sequence_number` is non-null: what Requirement 13.5 requires is
       * the TARGETED sequence number, so it is compared to the targeted event's own.
       */
      it.fails('appends an Audit_Event naming the requesting actor and the targeted sequence number', () => {
        expect(a.rejectionEvents).toHaveLength(1);
        const event = a.rejectionEvents[0];
        expect(event?.actor_id).toBe(f.userId);
        expect(event?.actor_kind).toBe('user');
        expect(event?.target_table).toBe('audit_events');
        expect(event?.operation).toBe(operation);
        expect(event?.target_id).toBe(targetId);
        expect(event?.targeted_sequence_number).toBe(targetSequenceNumber);
      });
    });
  }

  /**
   * Barrier 1, and specifically which of the two possible refusals it is. Task 26.1
   * gave `audit_events` SELECT and INSERT policies and deliberately no UPDATE or
   * DELETE policy, so there are two candidate explanations for a refused write from
   * the application role. They are not equivalent and only one of them is what
   * happens: a privilege check runs BEFORE row-level security, so the REVOKE raises
   * `42501` and policy evaluation is never reached. An absent policy alone would
   * have matched zero rows and reported success, which is not a rejection at all.
   */
  describe('barrier 1: the REVOKE refuses the application role before RLS is consulted', () => {
    for (const operation of ['UPDATE', 'DELETE'] as const) {
      it(`stops ${operation} as authenticated with 42501, without running the trigger`, () => {
        // `SET LOCAL ROLE` reverts with the transaction, so the session never leaks
        // the reduced role. Rolled back regardless.
        const r = runScript(rolledBack(`set local role authenticated;\n${mutationSql(operation)}`));
        expect(r.errors, `expected one denial, got:\n${r.rawErr}`).toHaveLength(1);
        expect(r.errors[0]?.sqlstate).toBe(INSUFFICIENT_PRIVILEGE);
        expect(r.errors[0]?.message).toContain('permission denied for table audit_events');
        // The trigger frame is absent, which is the proof that barrier 1 came first:
        // no row was ever visited, so no `BEFORE UPDATE OR DELETE` trigger ran and
        // nothing was appended even in principle.
        expect(r.rawErr).not.toContain('reject_mutation_and_audit');
        expect(r.rawErr).not.toContain('append_audit_event_autonomous');
      });
    }

    it('holds SELECT and INSERT on audit_events and neither UPDATE nor DELETE', () => {
      // The privilege state the refusal above depends on, read out of the catalog
      // rather than inferred from the migration text.
      const r = runScript(
        jsonRows(`
          select has_table_privilege('authenticated', 'audit_events', 'SELECT') as can_select,
                 has_table_privilege('authenticated', 'audit_events', 'INSERT') as can_insert,
                 has_table_privilege('authenticated', 'audit_events', 'UPDATE') as can_update,
                 has_table_privilege('authenticated', 'audit_events', 'DELETE') as can_delete,
                 has_table_privilege('authenticated', 'audit_events', 'TRUNCATE') as can_truncate`),
      );
      expect(r.errors, r.rawErr).toHaveLength(0);
      expect(jsonAt<readonly Record<string, boolean>[]>(r, 0)).toEqual([
        {
          can_select: true,
          can_insert: true,
          can_update: false,
          can_delete: false,
          can_truncate: false,
        },
      ]);
    });
  });
});
