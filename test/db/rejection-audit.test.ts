/**
 * The three rejection Audit_Events against Supabase local (task 26.5).
 * Requirements 14.3, 14.9, 14.10.
 *
 * `src/authz/rejection-audit.ts` builds the events and appends them through the
 * Audit_Service's narrow sink; it exports no SQL of its own, because there is none to
 * export — the append path is `AUDIT_EVENT_APPEND_SQL` and the counter seed is
 * `AUDIT_SEQUENCE_COUNTER_SEED_SQL`, both owned by task 25.1. This file is where the
 * three events stop being plausible: it `PREPARE`s those exported strings so Postgres
 * plans them, and executes them with the exact parameters the builders produce.
 *
 * | Claim | Mechanism | Requirement |
 * |---|---|---|
 * | all three event types append and chain in one Tenant | the three builders, one after another | 14.3, 14.9, 14.10 |
 * | a cross-Tenant rejection is filed under the SESSION Tenant | two Tenants, one claim | 14.3 |
 * | the foreign Tenant's Audit_Log gains nothing | zero rows for Tenant B | 14.3 |
 * | a permission denial records the required Permission and the action type | payload read back | 14.9 |
 * | no credential value reaches the payload | a registered `Secret` in the action name | 13.2 |
 *
 * TWO REPORTED GAPS ARE EXERCISED HERE RATHER THAN PAPERED OVER
 *
 * 1. **`unscoped_access_rejected` has no Tenant to be filed under.** `audit_events`
 *    `.tenant_id` is `NOT NULL` and `AUDIT_EVENT_APPEND_SQL` supplies it from
 *    `app.current_tenant_id()`, which is exactly `NULL` in the condition Requirement
 *    14.10 describes. The append therefore fails `23502`, and so does the counter seed.
 *    Asserted below with the CORRECT expectation of the current schema, so the day
 *    design.md answers "which Tenant?" this test is what has to change.
 * 2. **FINDING 4 of migration 4.4** blocks a Tenant's FIRST rejection event: the
 *    counter row is read `FOR UPDATE` and never created. Both halves are asserted — the
 *    bare append fails `23502`, the seeded one succeeds — because production seeds no
 *    counter rows, so this is the live behaviour for a Tenant's first rejection.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  AUDIT_EVENT_APPEND_SQL,
  AUDIT_SEQUENCE_COUNTER_SEED_SQL,
  type AuditEventDraft,
  auditEventAppendParams,
  type NarrowAuditSinkEvent,
} from '@/audit/audit-service';
import {
  crossTenantAccessRejectedEvent,
  permissionDeniedEvent,
  unscopedAccessRejectedEvent,
} from '@/authz/rejection-audit';
import { Secret } from '@/config/env';

import {
  announceIfUnreachable,
  database,
  jsonAt,
  jsonRows,
  lit,
  newFixture,
  provision,
  rolledBack,
  runScript,
  type Fixture,
} from './pg';

/** `not_null_violation`: what both reported gaps produce. */
const NOT_NULL_VIOLATION = '23502';

const OCCURRED_AT = '2026-02-14T09:30:00.000Z';
const FOREIGN_RECORD_ID = '99999999-9999-4999-8999-999999999999';

interface StoredEvent {
  readonly sequence_number: string;
  readonly tenant_id: string;
  readonly event_type: string;
  readonly stage: string | null;
  readonly outcome: string | null;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly source_record_refs: readonly unknown[];
  readonly payload: Record<string, unknown>;
  readonly occurred_at: string;
}

/** `PREPARE`, so the exported string itself is what Postgres plans. */
const prepared = (name: string, sql: string): string => `prepare ${name} as\n${sql};`;

const execute = (name: string, params: readonly (string | null)[] = []): string =>
  params.length === 0
    ? `execute ${name};`
    : `execute ${name}(${params.map((p) => (p === null ? 'null' : lit(p))).join(', ')});`;

const PREPARE_ALL = [
  prepared('audit_seed', AUDIT_SEQUENCE_COUNTER_SEED_SQL),
  prepared('audit_append', AUDIT_EVENT_APPEND_SQL),
].join('\n');

/**
 * The sink event as a draft.
 *
 * This mirrors `auditSinkAdapter` exactly — the adapter is what performs this mapping
 * in production, and it also cross-checks the Tenant of the row that comes back, which
 * a `psql` script cannot do. Written out here rather than imported so the parameters
 * this test sends are visibly the ones the builders produced.
 */
const draftOf = (event: NarrowAuditSinkEvent): AuditEventDraft => ({
  eventType: event.eventType,
  actor: event.actor,
  outcome: event.outcome ?? null,
  sourceRefs: event.sourceRefs ?? [],
  payload: event.payload,
  occurredAt: event.occurredAt,
});

const appendOf = (event: NarrowAuditSinkEvent): string =>
  execute('audit_append', auditEventAppendParams(draftOf(event)));

const crossTenant = (f: Fixture, recordId = FOREIGN_RECORD_ID): NarrowAuditSinkEvent =>
  crossTenantAccessRejectedEvent({
    tenant_id: f.tenantId,
    user_id: f.userId,
    record_type: 'settlement_reconciliations',
    record_id: recordId,
    occurred_at: OCCURRED_AT,
  });

const unscoped = (tenantId?: string): NarrowAuditSinkEvent =>
  unscopedAccessRejectedEvent({
    actor: { kind: 'agent', id: 'reconciliation_agent' },
    operation: 'read',
    record_type: 'ledger_entries',
    occurred_at: OCCURRED_AT,
    ...(tenantId === undefined ? {} : { attributed_tenant_id: tenantId }),
  });

const permissionDenied = (f: Fixture, action = 'approve_proposal'): NarrowAuditSinkEvent =>
  permissionDeniedEvent({
    tenant_id: f.tenantId,
    user_id: f.userId,
    required: 'approve_sensitive_actions',
    action,
    occurred_at: OCCURRED_AT,
  });

const storedEvents = (tenantId: string): string =>
  jsonRows(
    `select sequence_number::text as sequence_number, tenant_id, event_type, stage, outcome,
            actor_kind, actor_id, source_record_refs, payload,
            to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at
       from audit_events
      where tenant_id = ${lit(tenantId)}
      order by sequence_number`,
  );

/** `provision(f)` seeds the counter row; this removes it to exercise FINDING 4. */
const withoutCounterRow = (f: Fixture): string =>
  `delete from audit_sequence_counters where tenant_id = ${lit(f.tenantId)};`;

/** A claim carrying a User but no Tenant: `app.current_tenant_id()` is NULL. */
const claimsWithoutTenant = (f: Fixture): string =>
  `do $c$ begin perform set_config('request.jwt.claims',
     json_build_object('sub', ${lit(f.userId)})::text, false); end $c$;`;

beforeAll(announceIfUnreachable);

describe.skipIf(!database().reachable)('the three rejection Audit_Events', () => {
  it('appends all three for one Tenant with the fields design.md names', () => {
    const f = newFixture();
    const r = runScript(
      rolledBack(
        [
          provision(f),
          PREPARE_ALL,
          appendOf(crossTenant(f)),
          appendOf(unscoped(f.tenantId)),
          appendOf(permissionDenied(f)),
          storedEvents(f.tenantId),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    const events = jsonAt<readonly StoredEvent[]>(r, 3);
    expect(events.map((e) => e.event_type)).toEqual([
      'cross_tenant_access_rejected',
      'unscoped_access_rejected',
      'permission_denied',
    ]);
    expect(events.map((e) => e.sequence_number)).toEqual(['1', '2', '3']);
    // A rejection is `blocked` and is not an Action_Pipeline stage.
    expect(events.map((e) => [e.stage, e.outcome])).toEqual([
      [null, 'blocked'],
      [null, 'blocked'],
      [null, 'blocked'],
    ]);
    for (const event of events) {
      expect(event.tenant_id).toBe(f.tenantId);
      expect(event.occurred_at).toBe(OCCURRED_AT);
      // Requirement 13.2: no Source_Record content is carried, and none is referenced.
      expect(event.source_record_refs).toEqual([]);
    }

    // Requirement 14.3: the requested record type and identifier, and the User.
    expect(events[0]?.payload).toEqual({
      record_type: 'settlement_reconciliations',
      record_id: FOREIGN_RECORD_ID,
    });
    expect([events[0]?.actor_kind, events[0]?.actor_id]).toEqual(['user', f.userId]);

    // Requirement 14.10: the rejected request, and the timestamp.
    expect(events[1]?.payload).toEqual({ operation: 'read', record_type: 'ledger_entries' });

    // Requirement 14.9: the required Permission and the requested action type.
    expect(events[2]?.payload).toEqual({
      required_permission: 'approve_sensitive_actions',
      action_type: 'approve_proposal',
    });
    expect([events[2]?.actor_kind, events[2]?.actor_id]).toEqual(['user', f.userId]);
  });

  it('files a cross-Tenant rejection under the session Tenant, leaving the other Log empty', () => {
    const session = newFixture();
    const foreign = newFixture();
    const r = runScript(
      rolledBack(
        [
          provision(foreign),
          // Provisioned second, so the session claim is the session Tenant's.
          provision(session),
          PREPARE_ALL,
          appendOf(crossTenant(session, foreign.tenantId)),
          storedEvents(session.tenantId),
          storedEvents(foreign.tenantId),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    const own = jsonAt<readonly StoredEvent[]>(r, 1);
    expect(own).toHaveLength(1);
    expect(own[0]?.tenant_id).toBe(session.tenantId);
    // The requested identifier is recorded, as Requirement 14.3 asks, and it is recorded
    // in the session Tenant's Log rather than in the record owner's.
    expect(own[0]?.payload).toEqual({
      record_type: 'settlement_reconciliations',
      record_id: foreign.tenantId,
    });
    expect(jsonAt<readonly StoredEvent[]>(r, 2)).toEqual([]);
  });

  it('excludes a credential value that reached the recorded action type', () => {
    const value = 'rzp_test_DBREJECTION_0123456789ab';
    new Secret('RAZORPAY_KEY_SECRET', value);
    const f = newFixture();
    const r = runScript(
      rolledBack(
        [
          provision(f),
          PREPARE_ALL,
          appendOf(permissionDenied(f, `approve_${value}`)),
          storedEvents(f.tenantId),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    const events = jsonAt<readonly StoredEvent[]>(r, 1);
    expect(JSON.stringify(events)).not.toContain(value);
    expect(events[0]?.payload['action_type']).toBe('approve_[redacted:RAZORPAY_KEY_SECRET]');
  });
});

describe.skipIf(!database().reachable)('GAP: an unscoped rejection has no Tenant to be filed under', () => {
  it('cannot append with no session Tenant claim, and cannot seed a counter either', () => {
    const f = newFixture();
    // One expected error per script: the first failure aborts the transaction, so a
    // second statement after it would report `25P02` instead of its own cause.
    for (const body of [
      // `audit_sequence_counters.tenant_id` is NOT NULL and the value is
      // `app.current_tenant_id()`, which is NULL here.
      `${provision(f)}\n${claimsWithoutTenant(f)}\n${PREPARE_ALL}\n${execute('audit_seed')}`,
      // And the append itself: the counter lookup matches no row, so `sequence_number`
      // stays NULL. This is Requirement 14.10's Audit_Event being unappendable in
      // exactly the condition Requirement 14.10 describes.
      `${provision(f)}\n${claimsWithoutTenant(f)}\n${PREPARE_ALL}\n${appendOf(unscoped(f.tenantId))}`,
    ]) {
      const r = runScript(rolledBack(body));
      expect(r.errors.map((e) => e.sqlstate), r.rawErr).toEqual([NOT_NULL_VIOLATION]);
      expect(r.out).toHaveLength(0);
    }
  });

  it('appends normally once a Tenant is attributed, which is the only path available', () => {
    const f = newFixture();
    const r = runScript(
      rolledBack(
        [provision(f), PREPARE_ALL, appendOf(unscoped(f.tenantId)), storedEvents(f.tenantId)].join(
          '\n',
        ),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    const events = jsonAt<readonly StoredEvent[]>(r, 1);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe('unscoped_access_rejected');
    expect(events[0]?.tenant_id).toBe(f.tenantId);
  });
});

describe.skipIf(!database().reachable)('GAP: FINDING 4 blocks a Tenant\'s first rejection event', () => {
  it('fails 23502 with no counter row and succeeds once the seed statement has run', () => {
    const f = newFixture();
    const bare = runScript(
      rolledBack(
        [provision(f), withoutCounterRow(f), PREPARE_ALL, appendOf(permissionDenied(f))].join('\n'),
      ),
    );
    expect(bare.errors.map((e) => e.sqlstate), bare.rawErr).toEqual([NOT_NULL_VIOLATION]);

    const seeded = runScript(
      rolledBack(
        [
          provision(f),
          withoutCounterRow(f),
          PREPARE_ALL,
          execute('audit_seed'),
          appendOf(permissionDenied(f)),
          storedEvents(f.tenantId),
        ].join('\n'),
      ),
    );
    expect(seeded.errors, seeded.rawErr).toEqual([]);
    expect(jsonAt<readonly StoredEvent[]>(seeded, 1)).toHaveLength(1);
  });
});
