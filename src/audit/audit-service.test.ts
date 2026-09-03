/**
 * The Audit_Service append path (task 25.1, Requirement 13.1, 13.2, 13.3).
 *
 * These are in-process assertions over the draft-to-parameters transformation, the
 * post-conditions the service checks on the row that comes back, and the narrow-sink
 * hand-off. The statements themselves are asserted against live Postgres in
 * `test/db/audit-append.test.ts`, because that is the only place the sequence
 * allocation, the reduction and the Chain_Value actually happen.
 *
 * Requirements: 13.1, 13.2, 13.3.
 */

import { describe, expect, it } from 'vitest';

import { Secret } from '@/config/env';
import type { Actor } from '@/config/configuration-service';
import type { LedgerAuditSink } from '@/ledger/semantic-ledger';
import type { ConfigurationAuditSink } from '@/config/configuration-service';
import type { ToolAuditSink } from '@/tools/tool';
import { encodePaise } from '@/wire/paise-wire';

import {
  ACTION_PIPELINE_STAGES,
  AUDIT_EVENT_APPEND_SQL,
  AUDIT_EVENTS_SEQUENCE_UNIQ,
  AUDIT_PAYLOAD_MAX_BYTES,
  AUDIT_SEQUENCE_COUNTER_SEED_SQL,
  AUDIT_SESSION_TENANT_PROBE_SQL,
  type AuditEvent,
  type AuditEventAppendParams,
  type AuditEventDraft,
  type AuditEventStore,
  auditEventAppendParams,
  auditPayloadBytes,
  AuditServiceError,
  auditSinkAdapter,
  auditTimestamp,
  createAuditService,
  payloadExceedsAuditLimit,
  projectAuditSourceRefs,
  sanitizeAuditPayload,
} from './audit-service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const PROPOSAL = '33333333-3333-4333-8333-333333333333';
const ACTOR: Actor = { kind: 'agent', id: 'reconciliation_agent' };
const OCCURRED_AT = '2026-02-14T09:30:00.000Z';

/** A `Secret` registers its plaintext in the value-keyed redaction registry on construction. */
const CREDENTIAL_VALUE = 'rzp_test_SENTINEL_0123456789abcdef';
const CREDENTIAL = new Secret('RAZORPAY_KEY_SECRET', CREDENTIAL_VALUE);

function draft(overrides: Partial<AuditEventDraft> = {}): AuditEventDraft {
  return {
    eventType: 'ledger_set_rejected',
    actor: ACTOR,
    payload: { reason: 'unbalanced' },
    occurredAt: OCCURRED_AT,
    ...overrides,
  };
}

interface FakeStore extends AuditEventStore {
  readonly calls: readonly AuditEventAppendParams[];
}

/**
 * A store that echoes its parameters back as a stored row, so the service's
 * post-conditions are asserted against a row that is consistent by construction and
 * only the deliberate deviations fail.
 */
function fakeStore(
  patch: (row: AuditEvent, params: AuditEventAppendParams) => AuditEvent = (row) => row,
  tenantId: string = TENANT,
): FakeStore {
  const calls: AuditEventAppendParams[] = [];
  return {
    calls,
    append(params: AuditEventAppendParams): Promise<AuditEvent> {
      calls.push(params);
      const payloadJson = params[7];
      const reduced = new TextEncoder().encode(payloadJson).length > AUDIT_PAYLOAD_MAX_BYTES;
      const payload = reduced
        ? { reduced: true, excerpt: payloadJson.slice(0, 60_000) }
        : (JSON.parse(payloadJson) as Record<string, unknown>);
      const storedJson = JSON.stringify(payload);
      const row: AuditEvent = {
        id: '44444444-4444-4444-8444-444444444444',
        tenant_id: tenantId,
        sequence_number: 1n,
        event_type: params[0],
        stage: params[3],
        outcome: params[4],
        actor_kind: params[1],
        actor_id: params[2],
        proposal_id: params[5],
        source_record_refs: JSON.parse(params[6]) as AuditEvent['source_record_refs'],
        payload,
        payload_reduced: reduced,
        payload_bytes: new TextEncoder().encode(storedJson).length,
        occurred_at: params[8],
        chain_value: 'a'.repeat(64),
        prev_chain_value: '0'.repeat(64),
      };
      return Promise.resolve(patch(row, params));
    },
  };
}

describe('the append parameters (Requirement 13.1)', () => {
  it('binds 9 parameters and none of them is a Tenant identifier', () => {
    const params = auditEventAppendParams(
      draft({
        stage: 'DETECT',
        outcome: 'succeeded',
        proposalId: PROPOSAL,
        sourceRefs: [{ type: 'settlement', id: 'setl_SYNTHETIC9281' }],
      }),
    );

    expect(params).toEqual([
      'ledger_set_rejected',
      'agent',
      'reconciliation_agent',
      'DETECT',
      'succeeded',
      PROPOSAL,
      '[{"type":"settlement","id":"setl_SYNTHETIC9281"}]',
      '{"reason":"unbalanced"}',
      OCCURRED_AT,
    ]);
    expect(params).not.toContain(TENANT);
    // The Tenant is pinned in the statement, not passed in: `$1` is the event type.
    expect(AUDIT_EVENT_APPEND_SQL).toContain('app.current_tenant_id()');
    expect(AUDIT_EVENT_APPEND_SQL).toContain('$1::text, $2::text, $3::text');
    expect(AUDIT_SEQUENCE_COUNTER_SEED_SQL).toContain('app.current_tenant_id()');
    expect(AUDIT_SESSION_TENANT_PROBE_SQL).toContain('app.current_tenant_id()');
  });

  it('returns the sequence number as digit text and the hashed timestamp form', () => {
    // Both are the task 25.2 seam: a BIGINT must not pass through a double, and the
    // recomputation has to hash the bytes the SQL hashed.
    expect(AUDIT_EVENT_APPEND_SQL).toContain('e.sequence_number::text AS sequence_number');
    expect(AUDIT_EVENT_APPEND_SQL).toContain(
      `to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at`,
    );
    // Calling the function from FROM evaluates it once; `(f(...)).*` would append 16 events.
    expect(AUDIT_EVENT_APPEND_SQL).toContain('FROM app.append_audit_event(');
    expect(AUDIT_EVENT_APPEND_SQL).not.toContain(').*');
    expect(AUDIT_EVENTS_SEQUENCE_UNIQ).toBe('audit_events_sequence_uniq');
  });

  it('holds occurredAt to UTC millisecond precision and to being a real instant', () => {
    expect(auditTimestamp(new Date(Date.UTC(2026, 1, 14, 9, 30, 0, 0)))).toBe(OCCURRED_AT);
    // Second precision, an offset other than Z, and a date that does not exist.
    for (const bad of ['2026-02-14T09:30:00Z', '2026-02-14T09:30:00.000+05:30', '2026-02-30T00:00:00.000Z']) {
      expect(() => auditEventAppendParams(draft({ occurredAt: bad }))).toThrow(AuditServiceError);
    }
  });

  it('requires an outcome on a stage event, and rejects an unknown stage', () => {
    for (const stage of ACTION_PIPELINE_STAGES) {
      expect(
        auditEventAppendParams(draft({ stage, outcome: 'succeeded', proposalId: PROPOSAL }))[3],
      ).toBe(stage);
    }
    expect(() => auditEventAppendParams(draft({ stage: 'DETECT', proposalId: PROPOSAL }))).toThrow(
      /must carry an outcome/,
    );
    expect(() =>
      auditEventAppendParams(
        draft({ stage: 'SETTLE' as never, outcome: 'succeeded', proposalId: PROPOSAL }),
      ),
    ).toThrow(/7 Action_Pipeline stages/);
  });

  it('accepts a stage event with no Proposal, because the first three stages have none', () => {
    // Requirement 5.1 orders DETECT, INVESTIGATE, EXPLAIN before PROPOSE, and task 21.1
    // added audit_events_proposal_id_fkey — so requiring the identifier here would make
    // those three stages unappendable. See auditAppendPlan for the reported conflict
    // with Requirement 5.2 and 13.7.
    expect(auditEventAppendParams(draft({ stage: 'DETECT', outcome: 'succeeded' }))[5]).toBeNull();
    expect(() => auditEventAppendParams(draft({ proposalId: 'not-a-uuid' }))).toThrow(
      /must be null or a UUID/,
    );
  });

  it('rejects an actor that is none of the three kinds, and an empty identifier', () => {
    expect(() => auditEventAppendParams(draft({ actor: { kind: 'robot' as never, id: 'x' } }))).toThrow(
      /actor.kind must be one of/,
    );
    expect(() => auditEventAppendParams(draft({ actor: { kind: 'user', id: '' } }))).toThrow(
      /actor.id must be a non-empty identifier/,
    );
    // A role name is a legitimate `user` actor id: reject_mutation_and_audit() writes
    // session_user when app.current_user_id() is NULL (FINDING 5 of migration 4.4).
    expect(auditEventAppendParams(draft({ actor: { kind: 'user', id: 'postgres' } }))[2]).toBe(
      'postgres',
    );
  });
});

describe('credential values are excluded from the payload (Requirement 13.2)', () => {
  it('masks a Secret instance at any depth', () => {
    const params = auditEventAppendParams(
      draft({ payload: { provider: { key: CREDENTIAL }, keys: [CREDENTIAL] } }),
    );

    expect(params[7]).not.toContain(CREDENTIAL_VALUE);
    expect(params[7]).toBe(
      '{"provider":{"key":"[redacted:RAZORPAY_KEY_SECRET]"},"keys":["[redacted:RAZORPAY_KEY_SECRET]"]}',
    );
  });

  it('matches on value, so a credential in an unexpected field is still excluded', () => {
    // The whole point of the value-keyed registry: nothing about this field name
    // suggests a credential, and it is redacted anyway.
    const params = auditEventAppendParams(
      draft({
        payload: {
          note: `request failed for ${CREDENTIAL_VALUE}`,
          [CREDENTIAL_VALUE]: 'even the key',
        },
      }),
    );

    expect(params[7]).not.toContain(CREDENTIAL_VALUE);
    expect(params[7]).toContain('[redacted:RAZORPAY_KEY_SECRET]');
    expect(JSON.parse(params[7])).toEqual({
      note: 'request failed for [redacted:RAZORPAY_KEY_SECRET]',
      '[redacted:RAZORPAY_KEY_SECRET]': 'even the key',
    });
  });

  it('rejects a bigint rather than losing a monetary value to a float', () => {
    expect(() => auditEventAppendParams(draft({ payload: { impact_paise: 77_200n } }))).toThrow(
      /use encodePaise/,
    );
    // Digit text is how paise cross a JSON boundary.
    expect(auditEventAppendParams(draft({ payload: { impact_paise: encodePaise(77_200n) } }))[7]).toBe(
      '{"impact_paise":"77200"}',
    );
  });

  it('rejects every payload construct JSON.stringify would drop, null out, or choke on', () => {
    expect(() => sanitizeAuditPayload({ a: undefined })).toThrow(/JSON.stringify omits entirely/);
    expect(() => sanitizeAuditPayload({ a: Number.NaN })).toThrow(/writes as null/);
    expect(() => sanitizeAuditPayload({ a: Number.POSITIVE_INFINITY })).toThrow(/writes as null/);
    expect(() => sanitizeAuditPayload({ a: () => 1 })).toThrow(/no JSON representation/);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => sanitizeAuditPayload(circular)).toThrow(/circular reference/);
    expect(() => sanitizeAuditPayload([] as unknown as Record<string, unknown>)).toThrow(
      /must be a JSON object/,
    );
  });

  it('rejects U+0000, which jsonb cannot store, rather than rewriting the payload', () => {
    expect(() => sanitizeAuditPayload({ note: 'a\u0000b' })).toThrow(/U\+0000 at index 1/);
    expect(() => sanitizeAuditPayload({ 'a\u0000b': 1 })).toThrow(/U\+0000/);
    expect(() => auditEventAppendParams(draft({ eventType: 'a\u0000b' }))).toThrow(/U\+0000/);
  });

  it('rejects the Chain_Value separator in the scalar fields it controls', () => {
    expect(() => auditEventAppendParams(draft({ eventType: 'a|b' }))).toThrow(/must not contain/);
    expect(() => auditEventAppendParams(draft({ actor: { kind: 'agent', id: 'a|b' } }))).toThrow(
      /must not contain/,
    );
    expect(() => projectAuditSourceRefs([{ type: 'payment', id: 'pay_a|b' }])).toThrow(
      /must not contain/,
    );
  });
});

describe('Source_Records are referenced by identifier only (Requirement 13.2)', () => {
  it('projects every ref onto exactly { type, id } and drops anything else', () => {
    const refs = projectAuditSourceRefs([
      // A caller handing over a whole Source_Record: only the two identifying fields survive.
      {
        type: 'payment',
        id: 'pay_SYNTHETIC01',
        amount_paise: '250000',
        email: 'buyer@example.test',
      } as never,
    ]);

    expect(refs).toEqual([{ type: 'payment', id: 'pay_SYNTHETIC01' }]);
    expect(Object.keys(refs[0] ?? {})).toEqual(['type', 'id']);
  });

  it('preserves order and duplicates, because the array text is hashed', () => {
    const refs = [
      { type: 'settlement', id: 'setl_A' },
      { type: 'payment', id: 'pay_B' },
      { type: 'settlement', id: 'setl_A' },
    ] as const;
    expect(projectAuditSourceRefs(refs)).toEqual([...refs]);
  });

  it('rejects a type outside the source_record_type enum and an empty identifier', () => {
    expect(() => projectAuditSourceRefs([{ type: 'invoice' as never, id: 'x' }])).toThrow(
      /not a source_record_type label/,
    );
    expect(() => projectAuditSourceRefs([{ type: 'payment', id: '' }])).toThrow(
      /non-empty Source_Record identifier/,
    );
  });

  it('defaults to no refs, which is what a rejected invocation has to cite', () => {
    expect(auditEventAppendParams(draft())[6]).toBe('[]');
  });
});

describe('the 65536-byte reduction (Requirement 13.3)', () => {
  it('measures the payload and forecasts the reduction without performing it', () => {
    const small = { note: 'x' };
    expect(auditPayloadBytes(small)).toBe(JSON.stringify(small).length);
    expect(payloadExceedsAuditLimit(small)).toBe(false);

    const oversized = { blob: 'x'.repeat(AUDIT_PAYLOAD_MAX_BYTES) };
    expect(payloadExceedsAuditLimit(oversized)).toBe(true);
    // The reduction is SQL's: the parameter still carries the whole payload.
    expect(auditEventAppendParams(draft({ payload: oversized }))[7]).toHaveLength(
      JSON.stringify(oversized).length,
    );
  });

  it('accepts the stored reduction and keeps the Source_Record identifiers unreduced', async () => {
    const store = fakeStore();
    const service = createAuditService({ store });
    const refs = [
      { type: 'settlement', id: 'setl_SYNTHETIC9281' },
      { type: 'payment', id: 'pay_SYNTHETIC01' },
    ] as const;

    const event = await service.append(
      draft({ payload: { blob: 'x'.repeat(70_000) }, sourceRefs: refs }),
    );

    expect(event.payload_reduced).toBe(true);
    expect(event.payload_bytes).toBeLessThanOrEqual(AUDIT_PAYLOAD_MAX_BYTES);
    expect(event.source_record_refs).toEqual([...refs]);
  });

  it('refuses a stored row that dropped the reduction indicator or the references', async () => {
    const noIndicator = createAuditService({
      store: fakeStore((row) => ({ ...row, payload_reduced: false, payload_bytes: 12 })),
    });
    await expect(
      noIndicator.append(draft({ payload: { blob: 'x'.repeat(70_000) } })),
    ).rejects.toThrow(/does not carry the reduction indicator/);

    const droppedRefs = createAuditService({
      store: fakeStore((row) => ({ ...row, source_record_refs: [] })),
    });
    await expect(
      droppedRefs.append(draft({ sourceRefs: [{ type: 'payment', id: 'pay_SYNTHETIC01' }] })),
    ).rejects.toThrow(/identifiers unreduced/);
  });

  it('refuses a stored row whose sequence number or Chain_Value is not what 13.1 and 13.4 require', async () => {
    const zeroSequence = createAuditService({
      store: fakeStore((row) => ({ ...row, sequence_number: 0n })),
    });
    await expect(zeroSequence.append(draft())).rejects.toThrow(/sequence_number 0/);

    const shortChain = createAuditService({
      store: fakeStore((row) => ({ ...row, chain_value: 'abc' })),
    });
    await expect(shortChain.append(draft())).rejects.toThrow(/64-character lower-case hex/);
  });
});

describe('the narrow-sink hand-off', () => {
  it('satisfies the ledger, tool and configuration sinks with no change to any of them', () => {
    const service = createAuditService({ store: fakeStore() });
    // Compile-time: the three seams task 25.1 promised to be able to fill.
    const ledger: LedgerAuditSink = auditSinkAdapter(service);
    const tools: ToolAuditSink = auditSinkAdapter(service);
    const configuration: ConfigurationAuditSink = auditSinkAdapter(service);
    expect([ledger, tools, configuration].every((sink) => typeof sink.append === 'function')).toBe(
      true,
    );
  });

  it('delegates a ledger rejection with its refs, outcome and digit-string amounts', async () => {
    const store = fakeStore();
    const sink: LedgerAuditSink = auditSinkAdapter(createAuditService({ store }));

    await sink.append({
      tenantId: TENANT,
      eventType: 'ledger_set_rejected',
      actor: ACTOR,
      outcome: 'blocked',
      sourceRefs: [{ type: 'payment', id: 'pay_SYNTHETIC01' }],
      payload: { reason: 'unbalanced', imbalance_paise: encodePaise(-1n) },
      occurredAt: OCCURRED_AT,
    });

    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toEqual([
      'ledger_set_rejected',
      'agent',
      'reconciliation_agent',
      null,
      'blocked',
      null,
      '[{"type":"payment","id":"pay_SYNTHETIC01"}]',
      '{"reason":"unbalanced","imbalance_paise":"-1"}',
      OCCURRED_AT,
    ]);
  });

  it('throws when the caller expected a Tenant other than the session Tenant', async () => {
    const sink = auditSinkAdapter(createAuditService({ store: fakeStore(undefined, OTHER_TENANT) }));

    await expect(
      sink.append({
        tenantId: TENANT,
        eventType: 'configuration_updated',
        actor: { kind: 'user', id: 'postgres' },
        payload: { field: 'auto_execute_threshold' },
        occurredAt: OCCURRED_AT,
      }),
    ).rejects.toThrow(/bound to the wrong session/);
  });
});
