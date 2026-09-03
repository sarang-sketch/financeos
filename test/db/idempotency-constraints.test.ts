/**
 * The four idempotency constraints, against Supabase local (task 4.8).
 *
 * Each of these is the database half of an `ON CONFLICT ... DO UPDATE` that some
 * service will write later, which is why every assertion targets the constraint
 * BY NAME rather than merely checking that "a unique violation happened": a rename
 * would silently break the matching `ON CONFLICT` clause, and only the name catches
 * that.
 *
 * | Constraint                        | Key                                          | Requirement |
 * |-----------------------------------|----------------------------------------------|-------------|
 * | `razorpay_objects_tenant_rzp_uniq`| (tenant_id, razorpay_id)                     | 1.3         |
 * | `ledger_set_derivation_uniq`      | (tenant_id, source_record_type, source_record_id) | 2.8    |
 * | `exceptions_fingerprint_uniq`     | (tenant_id, fingerprint)                     | 4.15        |
 * | `audit_events_sequence_uniq`      | (tenant_id, sequence_number)                 | 13.1        |
 *
 * Every attempt runs inside a rolled-back transaction, so the first (accepted)
 * insert of each pair leaves nothing behind. `audit_events` matters here: it is
 * append-only, so a committed probe row could never be cleaned up.
 *
 * Requirements: 1.3, 2.8, 4.15, 13.1. Property: P12.
 */

import { describe, expect, it } from 'vitest';
import {
  database,
  lit,
  newFixture,
  provision,
  rolledBack,
  runScript,
  type Fixture,
} from './pg';

/** `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/**
 * Insert `row` twice inside one rolled-back transaction and assert the second
 * attempt is rejected by `constraint`.
 *
 * Exactly one error is expected: if the fixture or the FIRST insert failed, the
 * second would fail too (or the transaction would be aborted, adding a `25P02`),
 * so the count is what stops a vacuous pass.
 */
function expectDuplicateRejected(build: (f: Fixture) => readonly [string, string], constraint: string): void {
  const f = newFixture();
  const [first, second] = build(f);
  const r = runScript(rolledBack(`${provision(f)}\n${first}\n${second}`));

  expect(r.errors, `expected exactly one rejection, got:\n${r.rawErr}`).toHaveLength(1);
  const [error] = r.errors;
  expect(error?.sqlstate).toBe(UNIQUE_VIOLATION);
  expect(error?.constraint).toBe(constraint);
}

const razorpayObject = (f: Fixture, razorpayId: string): string => `
insert into razorpay_objects
  (tenant_id, razorpay_id, object_type, ingestion_run_id, created_at_rzp, amount_paise, payload)
values (${lit(f.tenantId)}, ${lit(razorpayId)}, 'payment', ${lit(f.runId)}, now(), 50000,
        '{"id":"pay_dup_probe"}'::jsonb);`;

const derivedSet = (f: Fixture, sourceId: string): string => `
insert into ledger_entry_sets
  (tenant_id, entry_date, source_record_type, source_record_id, entry_count,
   total_debit_paise, total_credit_paise, created_by)
values (${lit(f.tenantId)}, current_date, 'payment', ${lit(sourceId)}, 2, 100, 100, 'db-test');`;

const exceptionRow = (f: Fixture, fingerprint: string): string => `
insert into exceptions (tenant_id, category, impact_paise, direction, fingerprint)
values (${lit(f.tenantId)}, 'settlement_mismatch', 12345, 'shortfall', ${lit(fingerprint)});`;

/**
 * Written directly rather than through `app.append_audit_event`, because the
 * append function allocates the sequence number itself and so could never produce
 * a collision. The constraint has to be provoked by naming the sequence number.
 */
const auditEvent = (f: Fixture, sequenceNumber: number): string => `
insert into audit_events
  (tenant_id, sequence_number, event_type, actor_kind, actor_id, source_record_refs,
   payload, payload_bytes, occurred_at, chain_value, prev_chain_value)
values (${lit(f.tenantId)}, ${sequenceNumber}, 'db_test_probe', 'user', ${lit(f.userId)},
        '[]'::jsonb, '{}'::jsonb, 2, now(), repeat('a', 64), repeat('0', 64));`;

describe.skipIf(!database().reachable)('idempotency constraints reject duplicates', () => {
  it('razorpay_objects_tenant_rzp_uniq rejects a second row for one Razorpay identifier', () => {
    expectDuplicateRejected(
      (f) => [razorpayObject(f, 'pay_dup_probe'), razorpayObject(f, 'pay_dup_probe')],
      'razorpay_objects_tenant_rzp_uniq',
    );
  });

  it('ledger_set_derivation_uniq rejects a second set derived from one Source_Record', () => {
    expectDuplicateRejected(
      (f) => [derivedSet(f, 'pay_derivation_probe'), derivedSet(f, 'pay_derivation_probe')],
      'ledger_set_derivation_uniq',
    );
  });

  it('exceptions_fingerprint_uniq rejects a second Exception with one fingerprint', () => {
    expectDuplicateRejected(
      (f) => [exceptionRow(f, 'fp-duplicate-probe'), exceptionRow(f, 'fp-duplicate-probe')],
      'exceptions_fingerprint_uniq',
    );
  });

  it('audit_events_sequence_uniq rejects a second event at one sequence number', () => {
    expectDuplicateRejected((f) => [auditEvent(f, 1), auditEvent(f, 1)], 'audit_events_sequence_uniq');
  });

  // Control: the same four inserts differing only in their key are all accepted, so
  // the rejections above are about the key and not about the row shape.
  it('accepts rows that differ only in the constrained key', () => {
    const f = newFixture();
    const r = runScript(
      rolledBack(
        [
          provision(f),
          razorpayObject(f, 'pay_a'),
          razorpayObject(f, 'pay_b'),
          derivedSet(f, 'pay_a'),
          derivedSet(f, 'pay_b'),
          exceptionRow(f, 'fp-a'),
          exceptionRow(f, 'fp-b'),
          auditEvent(f, 1),
          auditEvent(f, 2),
        ].join('\n'),
      ),
    );
    expect(r.errors, `expected every distinct-key insert to be accepted, got:\n${r.rawErr}`).toEqual(
      [],
    );
  });
});
