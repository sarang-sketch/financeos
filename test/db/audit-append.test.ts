/**
 * The Audit_Service append path against Supabase local (task 25.1).
 *
 * `src/audit/audit-service.ts` exports the two statements an adapter runs and the
 * `AuditEventStore` seam that runs them, following the precedent of
 * `EXCEPTION_UPSERT_SQL` and `PROPOSAL_DECISION_UPDATE_SQL` — there is no PostgREST
 * multi-statement adapter in this project, and `audit_events` and
 * `audit_sequence_counters` are `FORCE ROW LEVEL SECURITY` with no policies until
 * task 26.1, so they match zero rows for every role without `BYPASSRLS`. This file
 * is therefore where those exact strings are proven: it `PREPARE`s them so Postgres
 * plans the exported text itself, and executes them as `postgres`.
 *
 * | Claim | Mechanism | Requirement |
 * |---|---|---|
 * | the Tenant-scoped sequence starts at 1 and increments by 1 | `AUDIT_EVENT_APPEND_SQL` three times | 13.1 |
 * | each event chains to the one before, the first to 64 zeros | `prev_chain_value` read back | 13.4 |
 * | a rolled-back append consumes no sequence number | `SAVEPOINT` + `ROLLBACK TO` | 13.1, 13.8 |
 * | serialization is the counter row lock | `pg_get_functiondef` over the deployed function | 13.1 |
 * | the Tenant comes from the session, never a parameter | `app.current_tenant_id()` in the statement | 14.1, 14.2 |
 * | an oversized payload is reduced, its indicator set, its refs unreduced | a 70 KB payload | 13.3 |
 * | `occurred_at` returns the exact text the Chain_Value was hashed over | `to_char` in the statement | 13.1, 13.4 |
 *
 * TWO KNOWN DEFECTS ARE EXERCISED HERE RATHER THAN PAPERED OVER
 *
 * 1. FINDING 4 of `20260101000004_audit_log_append_only.sql`:
 *    `app.append_audit_event` reads an `audit_sequence_counters` row it never
 *    creates, so a Tenant with no counter row cannot record its FIRST Audit_Event.
 *    Task 25.1 takes ownership of the workaround — `AUDIT_SEQUENCE_COUNTER_SEED_SQL`
 *    — and both halves are asserted below: the bare append fails `23502`, and the
 *    seeded append succeeds. The permanent fix is an upsert inside
 *    `app.append_audit_event`, which is task 4.4's.
 * 2. FINDING 6(e) of the same migration: the reduction takes
 *    `left(v_payload::text, 60000)`, which counts CHARACTERS, while `payload_bytes`
 *    and the 65536 threshold count BYTES. A multi-byte payload therefore reduces to
 *    a value that still violates `payload_bytes <= 65536`, and the append fails
 *    instead of reducing — Requirement 13.3 does not hold for it. That case is
 *    marked `it.fails` with the CORRECT expectation in the body, so it starts
 *    reporting an error the moment task 4.4 fixes the migration.
 *
 * Requirements: 13.1, 13.2, 13.3.
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  AUDIT_EVENT_APPEND_SQL,
  AUDIT_EVENTS_SEQUENCE_UNIQ,
  AUDIT_PAYLOAD_BYTES_CHECK,
  AUDIT_PAYLOAD_MAX_BYTES,
  AUDIT_SEQUENCE_COUNTER_SEED_SQL,
  AUDIT_SESSION_TENANT_PROBE_SQL,
  type AuditEventDraft,
  auditEventAppendParams,
} from '@/audit/audit-service';
import type { SourceRef } from '@/ledger/posting-rules';

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

/** `not_null_violation`: what an absent counter row produces (FINDING 4). */
const NOT_NULL_VIOLATION = '23502';
/** `check_violation`: what FINDING 6(e)'s over-long reduction produces. */
const CHECK_VIOLATION = '23514';
/** The fixed initial Chain_Value of Requirement 13.4. */
const INITIAL_CHAIN_VALUE = '0'.repeat(64);

const OCCURRED_AT = '2026-02-14T09:30:00.000Z';
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface StoredEvent {
  readonly sequence_number: string;
  readonly event_type: string;
  readonly stage: string | null;
  readonly outcome: string | null;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly proposal_id: string | null;
  readonly source_record_refs: readonly SourceRef[];
  readonly payload: Record<string, unknown>;
  readonly payload_reduced: boolean;
  readonly payload_bytes: number;
  readonly occurred_at: string;
  readonly chain_value: string;
  readonly prev_chain_value: string;
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
  prepared('audit_tenant_probe', AUDIT_SESSION_TENANT_PROBE_SQL),
].join('\n');

function draft(overrides: Partial<AuditEventDraft> = {}): AuditEventDraft {
  return {
    eventType: 'agent_stage_completed',
    actor: { kind: 'agent', id: 'reconciliation_agent' },
    payload: { note: 'db-test' },
    occurredAt: OCCURRED_AT,
    ...overrides,
  };
}

/** One append through the exported statement. */
const append = (overrides: Partial<AuditEventDraft> = {}): string =>
  execute('audit_append', auditEventAppendParams(draft(overrides)));

/**
 * `provision(f)` seeds `audit_sequence_counters` to work around FINDING 4. This
 * removes it again, so the tests below exercise the seed statement task 25.1 owns
 * rather than the fixture's workaround.
 */
const withoutCounterRow = (f: Fixture): string =>
  `delete from audit_sequence_counters where tenant_id = ${lit(f.tenantId)};`;

/** A session claim carrying a User but no Tenant: `app.current_tenant_id()` is NULL. */
const claimsWithoutTenant = (f: Fixture): string =>
  `do $c$ begin perform set_config('request.jwt.claims',
     json_build_object('sub', ${lit(f.userId)})::text, false); end $c$;`;

/**
 * A minimal `proposals` row, so a stage Audit_Event can cite it.
 *
 * Needed because task 21.1 added `audit_events_proposal_id_fkey`, which migration 4.4
 * had deferred (its FINDING 3). `proposals.evidence_chain_id` is `NOT NULL REFERENCES
 * evidence_chains(id)`, so the chain comes first.
 */
const withProposal = (f: Fixture, chainId: string, proposalId: string): string => `
insert into evidence_chains (id, tenant_id, figure_paise, source_count, as_of, produced_by)
values (${lit(chainId)}, ${lit(f.tenantId)}, 38200000, 1, now(), 'audit_append_test');
insert into proposals
  (id, tenant_id, agent_name, action_type, target_source_records, target_fingerprint,
   impact_paise, evidence_chain_id, expected_outcome, state)
values (${lit(proposalId)}, ${lit(f.tenantId)}, 'reconciliation_agent',
  'post_reconciliation_adjustment', '[{"type":"settlement","id":"setl_SYNTHETIC9281"}]'::jsonb,
  'post_reconciliation_adjustment|settlement:setl_SYNTHETIC9281', 38200000, ${lit(chainId)},
  '{"status":"adjusted"}'::jsonb, 'proposed');`;

const storedEvents = (f: Fixture): string =>
  jsonRows(
    `select sequence_number::text as sequence_number, event_type, stage, outcome,
            actor_kind, actor_id, proposal_id, source_record_refs, payload,
            payload_reduced, payload_bytes,
            to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at,
            chain_value, prev_chain_value
       from audit_events
      where tenant_id = ${lit(f.tenantId)}`,
  );

function readEvents(script: string, index: number): readonly StoredEvent[] {
  const r = runScript(script);
  expect(r.errors, r.rawErr).toHaveLength(0);
  return [...jsonAt<readonly StoredEvent[]>(r, index)].sort(
    (a, b) => Number(BigInt(a.sequence_number) - BigInt(b.sequence_number)),
  );
}

beforeAll(announceIfUnreachable);

describe.skipIf(!database().reachable)('the Audit_Event append (Requirement 13.1)', () => {
  it('allocates 1, 2, 3 for a Tenant and chains each event to the one before', () => {
    const f = newFixture();
    const events = readEvents(
      rolledBack(
        [
          provision(f),
          withoutCounterRow(f),
          PREPARE_ALL,
          execute('audit_seed'),
          append({ payload: { note: 'first' } }),
          append({ payload: { note: 'second' } }),
          append({ payload: { note: 'third' } }),
          storedEvents(f),
        ].join('\n'),
      ),
      3,
    );

    expect(events.map((e) => e.sequence_number)).toEqual(['1', '2', '3']);
    // Requirement 13.4: a fixed initial Chain_Value, then each event over its predecessor's.
    expect(events[0]?.prev_chain_value).toBe(INITIAL_CHAIN_VALUE);
    expect(events[1]?.prev_chain_value).toBe(events[0]?.chain_value);
    expect(events[2]?.prev_chain_value).toBe(events[1]?.chain_value);
    for (const event of events) {
      expect(event.chain_value).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('returns the Tenant from the session and the timestamp in the form the chain hashed', () => {
    const f = newFixture();
    const chainId = randomUUID();
    const proposalId = randomUUID();
    const r = runScript(
      rolledBack(
        [
          provision(f),
          withProposal(f, chainId, proposalId),
          PREPARE_ALL,
          execute('audit_tenant_probe'),
          append({
            stage: 'AUTHORIZE',
            outcome: 'succeeded',
            proposalId,
            sourceRefs: [{ type: 'settlement', id: 'setl_SYNTHETIC9281' }],
          }),
        ].join('\n'),
      ),
    );
    expect(r.errors, r.rawErr).toHaveLength(0);

    // The probe an adapter uses to report "no session Tenant" legibly.
    expect(r.out[0]).toBe(f.tenantId);

    // The statement returns 16 columns; none of the values here contains a '|'.
    const returned = (r.out[1] ?? '').split('|');
    expect(returned).toHaveLength(16);
    const [, tenantId, sequenceNumber] = returned;
    expect(tenantId).toBe(f.tenantId);
    // Digit text out of the driver, for BigInt(...) rather than Number(...).
    expect(sequenceNumber).toBe('1');
    expect(returned[3]).toBe('agent_stage_completed');
    expect(returned[4]).toBe('AUTHORIZE');
    expect(returned[5]).toBe('succeeded');
    expect(returned[6]).toBe('agent');
    expect(returned[8]).toBe(proposalId);
    // The task 25.2 seam: exactly the text `to_char` produced for the hash input.
    expect(returned[13]).toBe(OCCURRED_AT);
    expect(returned[13]).toMatch(ISO_MS_RE);
  });

  it('serializes allocation on the counter row lock, with the unique constraint underneath', () => {
    // Where the serialization lives is a property of the deployed function, so it is
    // read back from the database rather than asserted against the migration text. A
    // genuinely concurrent pair of appends needs two overlapping sessions, which this
    // harness cannot open (`runScript` is one synchronous `docker exec` per call).
    const r = runScript(
      [
        jsonRows(
          `select pg_get_functiondef(p.oid) as body
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app' and p.proname = 'append_audit_event'`,
        ),
        jsonRows(
          `select conname from pg_constraint
            where conrelid = 'audit_events'::regclass and conname = ${lit(AUDIT_EVENTS_SEQUENCE_UNIQ)}`,
        ),
      ].join('\n'),
    );
    expect(r.errors, r.rawErr).toHaveLength(0);

    const body = jsonAt<readonly { readonly body: string }[]>(r, 0)[0]?.body ?? '';
    expect(body).toContain('FROM audit_sequence_counters WHERE tenant_id = p_tenant_id FOR UPDATE');
    expect(body).toContain('UPDATE audit_sequence_counters');
    expect(jsonAt<readonly { readonly conname: string }[]>(r, 1)).toEqual([
      { conname: AUDIT_EVENTS_SEQUENCE_UNIQ },
    ]);
  });

  it('leaves no gap when an append is rolled back', () => {
    // The counter advances only on commit, which is why allocation uses a row rather
    // than a Postgres sequence: a rolled-back append must consume no number, or the
    // verification walk of Requirement 13.8 would report a gap that is not tampering.
    const f = newFixture();
    const events = readEvents(
      rolledBack(
        [
          provision(f),
          PREPARE_ALL,
          append({ payload: { note: 'kept' } }),
          'savepoint attempted;',
          append({ payload: { note: 'abandoned' } }),
          'rollback to savepoint attempted;',
          append({ payload: { note: 'next' } }),
          storedEvents(f),
        ].join('\n'),
      ),
      3,
    );

    expect(events.map((e) => e.sequence_number)).toEqual(['1', '2']);
    expect(events.map((e) => e.payload.note)).toEqual(['kept', 'next']);
    expect(events[1]?.prev_chain_value).toBe(events[0]?.chain_value);
  });
});

describe.skipIf(!database().reachable)('the counter row a Tenant needs (FINDING 4)', () => {
  it('cannot record a first Audit_Event with no counter row, and can with the seed', () => {
    const f = newFixture();
    const bare = runScript(
      rolledBack([provision(f), withoutCounterRow(f), PREPARE_ALL, append()].join('\n')),
    );
    // v_seq and v_prev stay NULL, so the insert dies on sequence_number NOT NULL.
    expect(bare.errors, bare.rawErr).toHaveLength(1);
    expect(bare.errors[0]?.sqlstate).toBe(NOT_NULL_VIOLATION);

    const seeded = runScript(
      rolledBack(
        [
          provision(f),
          withoutCounterRow(f),
          PREPARE_ALL,
          execute('audit_seed'),
          append(),
          storedEvents(f),
        ].join('\n'),
      ),
    );
    expect(seeded.errors, seeded.rawErr).toHaveLength(0);
    expect(jsonAt<readonly StoredEvent[]>(seeded, 1)[0]?.sequence_number).toBe('1');
  });

  it('seeds idempotently, so an adapter can run it before every append', () => {
    const f = newFixture();
    const r = runScript(
      rolledBack(
        [
          provision(f),
          withoutCounterRow(f),
          PREPARE_ALL,
          execute('audit_seed'),
          execute('audit_seed'),
          append(),
          jsonRows(
            `select last_sequence::text as last_sequence from audit_sequence_counters
              where tenant_id = ${lit(f.tenantId)}`,
          ),
        ].join('\n'),
      ),
    );
    expect(r.errors, r.rawErr).toHaveLength(0);
    expect(jsonAt<readonly { readonly last_sequence: string }[]>(r, 1)).toEqual([
      { last_sequence: '1' },
    ]);
  });

  it('refuses both statements when the session carries no Tenant', () => {
    // A session with no `request.jwt.claims` at all, and one carrying a User but no
    // tenant claim, both leave `app.current_tenant_id()` NULL. Each statement is run in
    // its own script so the second rejection is its own rather than
    // `25P02 in_failed_sql_transaction` inherited from the first.
    const f = newFixture();
    for (const body of [
      `${PREPARE_ALL}\n${execute('audit_seed')}`,
      `${PREPARE_ALL}\n${append()}`,
      `${claimsWithoutTenant(f)}\n${PREPARE_ALL}\n${append()}`,
    ]) {
      const r = runScript(rolledBack(body));
      // Fail-closed: with no session Tenant the counter lookup matches nothing, so
      // `sequence_number` stays NULL and nothing can be written.
      expect(r.errors.map((e) => e.sqlstate), r.rawErr).toEqual([NOT_NULL_VIOLATION]);
      expect(r.out).toHaveLength(0);
    }
  });
});

describe.skipIf(!database().reachable)('the 65536-byte reduction (Requirement 13.3)', () => {
  it('reduces an oversized payload, sets the indicator, and leaves the refs unreduced', () => {
    const f = newFixture();
    const refs: readonly SourceRef[] = [
      { type: 'settlement', id: 'setl_SYNTHETIC9281' },
      { type: 'payment', id: 'pay_SYNTHETIC01' },
    ];
    const events = readEvents(
      rolledBack(
        [
          provision(f),
          PREPARE_ALL,
          append({ payload: { blob: 'x'.repeat(70_000) }, sourceRefs: refs }),
          storedEvents(f),
        ].join('\n'),
      ),
      1,
    );

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.payload_reduced).toBe(true);
    expect(event?.payload_bytes).toBeLessThanOrEqual(AUDIT_PAYLOAD_MAX_BYTES);
    // design.md's reduction replaces the payload rather than truncating it in place.
    expect(Object.keys(event?.payload ?? {}).sort()).toEqual(['excerpt', 'reduced']);
    // The Source_Record identifiers are stored unreduced: SQL never touches the column.
    expect(event?.source_record_refs).toEqual([...refs]);
  });

  it('leaves a payload under the threshold alone and reports its stored byte count', () => {
    const f = newFixture();
    const events = readEvents(
      rolledBack([provision(f), PREPARE_ALL, append(), storedEvents(f)].join('\n')),
      1,
    );

    expect(events[0]?.payload_reduced).toBe(false);
    expect(events[0]?.payload).toEqual({ note: 'db-test' });
    // `octet_length(jsonb::text)`, which is longer than the JSON.stringify text the
    // service measures — see the module doc comment on FINDING 6.
    expect(events[0]?.payload_bytes).toBe('{"note": "db-test"}'.length);
  });

  /**
   * FINDING 6(e) of migration 4.4. `left(v_payload::text, 60000)` counts characters
   * while `payload_bytes` counts bytes, so a payload of 40000 two-byte characters is
   * over the threshold, reduces to an excerpt that is still ~80 KB, and then violates
   * `payload_bytes <= 65536`. Requirement 13.3 requires it to be appended reduced.
   *
   * The body asserts the correct behaviour and genuinely fails, so fixing the
   * migration's `left(...)` to count bytes turns this into a reported error rather
   * than leaving the gap forgotten. The payload is built in SQL with `U&'\00E9'` so
   * the script stays pure ASCII and no client encoding is involved.
   */
  it.fails('reduces a multi-byte oversized payload instead of rejecting it', () => {
    const f = newFixture();
    const r = runScript(
      rolledBack(
        [
          provision(f),
          `select e.payload_reduced, e.payload_bytes
             from app.append_audit_event(
                    app.current_tenant_id(), 'oversized_multibyte', 'user', ${lit(f.userId)},
                    null, null, null, '[]'::jsonb,
                    jsonb_build_object('blob', repeat(U&'\\00E9', 40000)),
                    ${lit(OCCURRED_AT)}::timestamptz) AS e;`,
        ].join('\n'),
      ),
    );

    expect(r.errors.map((e) => `${e.sqlstate}:${e.constraint ?? ''}`)).toEqual([]);
    expect(r.out[0]).toBe(`t|${AUDIT_PAYLOAD_MAX_BYTES}`);
  });

  it('records what that defect currently produces, by constraint name', () => {
    const f = newFixture();
    const r = runScript(
      rolledBack(
        [
          provision(f),
          `select 1 from app.append_audit_event(
             app.current_tenant_id(), 'oversized_multibyte', 'user', ${lit(f.userId)},
             null, null, null, '[]'::jsonb,
             jsonb_build_object('blob', repeat(U&'\\00E9', 40000)),
             ${lit(OCCURRED_AT)}::timestamptz);`,
        ].join('\n'),
      ),
    );

    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.sqlstate).toBe(CHECK_VIOLATION);
    expect(r.errors[0]?.constraint).toBe(AUDIT_PAYLOAD_BYTES_CHECK);
  });
});

describe.skipIf(!database().reachable)('what jsonb cannot store (Requirement 13.2 boundary)', () => {
  it('rejects U+0000 outright, which is why the service refuses it in a payload', () => {
    // `sanitizeAuditPayload` rejects a NUL rather than rewriting the payload, because
    // Requirement 13.3 sanctions exactly one payload modification and this is not it.
    const r = runScript(`select '{"a":"\\u0000"}'::jsonb;`);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.sqlstate).toBe('22P05');
    expect(r.out).toHaveLength(0);
  });
});

describe.skipIf(!database().reachable)('the exported statements', () => {
  it('carry no Tenant parameter at all', () => {
    for (const sql of [AUDIT_EVENT_APPEND_SQL, AUDIT_SEQUENCE_COUNTER_SEED_SQL]) {
      expect(sql).toContain('app.current_tenant_id()');
    }
    // `$1` is the event type: the Tenant is not bindable, so it cannot be supplied.
    expect(AUDIT_EVENT_APPEND_SQL).toMatch(/\$1::text, \$2::text, \$3::text/);
    expect(AUDIT_SEQUENCE_COUNTER_SEED_SQL).not.toContain('$1');
  });
});
