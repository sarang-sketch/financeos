/**
 * The three rejection Audit_Events (task 26.5, Requirement 14.3, 14.9, 14.10).
 *
 * Two layers are asserted here and neither is mocked:
 *
 * 1. The events themselves — the exact fields of design.md's Error Handling tables,
 *    and the refusals that keep a malformed rejection from being recorded as a
 *    well-formed one.
 * 2. The composition. The `permission_denied` path runs through the **real**
 *    `createAuthorizationService` and the **real** `createAuditService`, joined by
 *    `auditSinkAdapter`, with only the store faked — so an event that would fail
 *    `auditAppendPlan`, or a denial that stopped naming its Permission, fails here.
 *
 * The statements are exercised against live Postgres in `test/db/rejection-audit.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  type AuditEvent,
  type AuditEventAppendParams,
  type AuditEventStore,
  auditSinkAdapter,
  createAuditService,
  type NarrowAuditSink,
  type NarrowAuditSinkEvent,
} from '@/audit/audit-service';
import { Secret } from '@/config/env';

import {
  createAuthorizationService,
  PermissionDeniedError,
  type PermissionDenialEvent,
  type PermissionReader,
} from './authorization-service';
import {
  CROSS_TENANT_ACCESS_REJECTED,
  createAuthorizationDenialSink,
  createRejectionAuditRecorder,
  crossTenantAccessRejectedEvent,
  PERMISSION_DENIED,
  permissionDeniedEvent,
  REJECTION_AUDIT_EVENT_TYPES,
  RejectionAuditError,
  UNSCOPED_ACCESS_REJECTED,
  unscopedAccessRejectedEvent,
  type CrossTenantAccessRejection,
  type PlatformLog,
  type UnscopedAccessRejection,
} from './rejection-audit';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FOREIGN_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = '11111111-1111-4111-8111-111111111111';
const OCCURRED_AT = '2026-02-14T09:30:00.000Z';

const CROSS_TENANT: CrossTenantAccessRejection = {
  tenant_id: TENANT,
  user_id: USER,
  record_type: 'settlement_reconciliations',
  record_id: '99999999-9999-4999-8999-999999999999',
  occurred_at: OCCURRED_AT,
};

const UNSCOPED: UnscopedAccessRejection = {
  actor: { kind: 'agent', id: 'reconciliation_agent' },
  operation: 'read',
  record_type: 'ledger_entries',
  occurred_at: OCCURRED_AT,
};

const DENIAL: PermissionDenialEvent = {
  tenant_id: TENANT,
  user_id: USER,
  required: 'approve_sensitive_actions',
  action: 'approve_proposal',
  occurred_at: OCCURRED_AT,
};

interface RecordingSink extends NarrowAuditSink {
  readonly events: readonly NarrowAuditSinkEvent[];
}

function recordingSink(options: { readonly fail?: boolean } = {}): RecordingSink {
  const events: NarrowAuditSinkEvent[] = [];
  return {
    events,
    append(event) {
      events.push(event);
      return options.fail === true
        ? Promise.reject(new Error('audit sink unavailable'))
        : Promise.resolve();
    },
  };
}

interface RecordingLog extends PlatformLog {
  readonly entries: readonly Readonly<Record<string, string>>[];
}

function recordingLog(): RecordingLog {
  const entries: Readonly<Record<string, string>>[] = [];
  return {
    entries,
    record(entry) {
      entries.push(entry);
    },
  };
}

/** The thrown value, or `undefined` when the call resolved. */
async function thrownBy(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('cross_tenant_access_rejected (Requirement 14.3)', () => {
  it('records the User, the session Tenant, the requested type and identifier, and the timestamp', () => {
    expect(crossTenantAccessRejectedEvent(CROSS_TENANT)).toEqual({
      tenantId: TENANT,
      eventType: 'cross_tenant_access_rejected',
      actor: { kind: 'user', id: USER },
      outcome: 'blocked',
      sourceRefs: [],
      payload: {
        record_type: 'settlement_reconciliations',
        record_id: '99999999-9999-4999-8999-999999999999',
      },
      occurredAt: OCCURRED_AT,
    });
  });

  it('files the event under the session Tenant, never the record owner', () => {
    // The foreign Tenant is not an input at all: the only Tenant this event can name is
    // the session's, which is what `app.current_tenant_id()` will bind on the append.
    const event = crossTenantAccessRejectedEvent({ ...CROSS_TENANT, tenant_id: TENANT });

    expect(event.tenantId).toBe(TENANT);
    expect(JSON.stringify(event)).not.toContain(FOREIGN_TENANT);
  });

  it('refuses a malformed User or Tenant identifier', () => {
    expect(() => crossTenantAccessRejectedEvent({ ...CROSS_TENANT, user_id: 'nobody' })).toThrow(
      RejectionAuditError,
    );
    expect(() => crossTenantAccessRejectedEvent({ ...CROSS_TENANT, tenant_id: '' })).toThrow(
      RejectionAuditError,
    );
  });

  it('refuses an absent record type or identifier, and a non-millisecond timestamp', () => {
    expect(() => crossTenantAccessRejectedEvent({ ...CROSS_TENANT, record_type: '  ' })).toThrow(
      RejectionAuditError,
    );
    expect(() => crossTenantAccessRejectedEvent({ ...CROSS_TENANT, record_id: '' })).toThrow(
      RejectionAuditError,
    );
    expect(() =>
      crossTenantAccessRejectedEvent({ ...CROSS_TENANT, occurred_at: '2026-02-14T09:30:00Z' }),
    ).toThrow();
  });
});

describe('unscoped_access_rejected (Requirement 14.10)', () => {
  it('records the rejected request and the timestamp under an attributable Tenant', () => {
    expect(
      unscopedAccessRejectedEvent({ ...UNSCOPED, operation: 'write', attributed_tenant_id: TENANT }),
    ).toEqual({
      tenantId: TENANT,
      eventType: 'unscoped_access_rejected',
      actor: { kind: 'agent', id: 'reconciliation_agent' },
      outcome: 'blocked',
      sourceRefs: [],
      payload: { operation: 'write', record_type: 'ledger_entries' },
      occurredAt: OCCURRED_AT,
    });
  });

  it('cannot be built with no attributable Tenant, because audit_events.tenant_id is NOT NULL', () => {
    expect(() => unscopedAccessRejectedEvent(UNSCOPED)).toThrow(RejectionAuditError);
  });

  it('appends the Audit_Event when a Tenant can be attributed', async () => {
    const audit = recordingSink();
    const log = recordingLog();
    const recorder = createRejectionAuditRecorder({ audit, platformLog: log });

    await expect(
      recorder.unscopedAccessRejected({ ...UNSCOPED, attributed_tenant_id: TENANT }),
    ).resolves.toEqual({ recorded: true });

    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.eventType).toBe(UNSCOPED_ACCESS_REJECTED);
    expect(log.entries).toEqual([]);
  });

  it('falls back to a platform log entry carrying no Tenant identifier, and says so', async () => {
    const audit = recordingSink();
    const log = recordingLog();
    const recorder = createRejectionAuditRecorder({ audit, platformLog: log });

    await expect(recorder.unscopedAccessRejected(UNSCOPED)).resolves.toEqual({
      recorded: false,
      reason: 'no_attributable_tenant',
    });

    expect(audit.events).toEqual([]);
    expect(log.entries).toEqual([
      {
        event: 'unscoped_access_rejected',
        operation: 'read',
        record_type: 'ledger_entries',
        occurred_at: OCCURRED_AT,
        reason: 'no_attributable_tenant',
      },
    ]);
    // design.md's Requirement 14.4 row: a platform log entry without Tenant data.
    expect(JSON.stringify(log.entries)).not.toContain(TENANT);
    expect(JSON.stringify(log.entries)).not.toContain(USER);
  });

  it('validates the rejection even when no Tenant is attributable', async () => {
    const recorder = createRejectionAuditRecorder({
      audit: recordingSink(),
      platformLog: recordingLog(),
    });

    await expect(
      recorder.unscopedAccessRejected({ ...UNSCOPED, record_type: '' }),
    ).rejects.toThrow(RejectionAuditError);
  });
});

describe('permission_denied (Requirement 14.9)', () => {
  it('records the User, the session Tenant, the required Permission, the action and the timestamp', () => {
    expect(permissionDeniedEvent(DENIAL)).toEqual({
      tenantId: TENANT,
      eventType: 'permission_denied',
      actor: { kind: 'user', id: USER },
      outcome: 'blocked',
      sourceRefs: [],
      payload: {
        required_permission: 'approve_sensitive_actions',
        action_type: 'approve_proposal',
      },
      occurredAt: OCCURRED_AT,
    });
  });

  it('records both Permissions of an any-of route as a list', () => {
    const event = permissionDeniedEvent({
      ...DENIAL,
      required: ['manage_credentials', 'run_agents'],
      action: 'start_ingestion',
    });

    expect(event.payload).toEqual({
      required_permission: ['manage_credentials', 'run_agents'],
      action_type: 'start_ingestion',
    });
  });

  it('refuses a required Permission that is not one of the six', () => {
    expect(() =>
      permissionDeniedEvent({
        ...DENIAL,
        required: 'delete_everything' as PermissionDenialEvent['required'],
      }),
    ).toThrow(RejectionAuditError);
    expect(() => permissionDeniedEvent({ ...DENIAL, required: [] })).toThrow(RejectionAuditError);
  });
});

describe('the vocabulary', () => {
  it('is exactly the three rejection event types design.md names', () => {
    expect([...REJECTION_AUDIT_EVENT_TYPES]).toEqual([
      CROSS_TENANT_ACCESS_REJECTED,
      UNSCOPED_ACCESS_REJECTED,
      PERMISSION_DENIED,
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Composition: the real Authorization_Service over the real Audit_Service     */
/* -------------------------------------------------------------------------- */

interface FakeStore extends AuditEventStore {
  readonly calls: readonly AuditEventAppendParams[];
}

/** Echoes its parameters back as a stored row, so the service's post-conditions hold. */
function fakeStore(tenantId: string = TENANT): FakeStore {
  const calls: AuditEventAppendParams[] = [];
  return {
    calls,
    append(params: AuditEventAppendParams): Promise<AuditEvent> {
      calls.push(params);
      const payload = JSON.parse(params[7]) as Record<string, unknown>;
      return Promise.resolve({
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
        payload_reduced: false,
        payload_bytes: new TextEncoder().encode(params[7]).length,
        occurred_at: params[8],
        chain_value: 'a'.repeat(64),
        prev_chain_value: '0'.repeat(64),
      });
    },
  };
}

function deniedBy(
  grants: readonly string[],
  store: FakeStore,
): ReturnType<typeof createAuthorizationService> {
  const permissions: PermissionReader = {
    grantedPermissions: () => Promise.resolve(grants),
  };
  const recorder = createRejectionAuditRecorder({
    audit: auditSinkAdapter(createAuditService({ store })),
  });
  return createAuthorizationService({
    permissions,
    denials: createAuthorizationDenialSink(recorder),
    now: () => new Date(OCCURRED_AT),
  });
}

describe('the denial sink filling task 26.2\'s seam', () => {
  it('appends one permission_denied event and still denies with the Permission named', async () => {
    const store = fakeStore();
    const service = deniedBy(['view_financial_data'], store);

    const error = (await thrownBy(
      service.require({ tenant_id: TENANT, user_id: USER }, 'manage_users', 'invite_user'),
    )) as PermissionDeniedError;

    expect(error).toBeInstanceOf(PermissionDeniedError);
    expect(error.required).toBe('manage_users');

    // Exactly one write on the denial path: the Audit_Event (Requirement 14.9).
    expect(store.calls).toHaveLength(1);
    const [eventType, actorKind, actorId, stage, outcome, proposalId, refs, payload, occurredAt] =
      store.calls[0] as AuditEventAppendParams;
    expect(eventType).toBe('permission_denied');
    expect([actorKind, actorId]).toEqual(['user', USER]);
    expect([stage, outcome, proposalId, refs]).toEqual([null, 'blocked', null, '[]']);
    expect(JSON.parse(payload)).toEqual({
      required_permission: 'manage_users',
      action_type: 'invite_user',
    });
    expect(occurredAt).toBe(OCCURRED_AT);
  });

  it('records an any-of denial with both Permissions', async () => {
    const store = fakeStore();
    const service = deniedBy([], store);

    await expect(
      service.requireAny(
        { tenant_id: TENANT, user_id: USER },
        ['manage_credentials', 'run_agents'],
        'start_ingestion',
      ),
    ).rejects.toThrow(PermissionDeniedError);

    expect(JSON.parse((store.calls[0] as AuditEventAppendParams)[7])).toEqual({
      required_permission: ['manage_credentials', 'run_agents'],
      action_type: 'start_ingestion',
    });
  });

  it('appends nothing when the Permission is held', async () => {
    const store = fakeStore();
    const service = deniedBy(['manage_users'], store);

    await expect(
      service.require({ tenant_id: TENANT, user_id: USER }, 'manage_users', 'invite_user'),
    ).resolves.toBeUndefined();

    expect(store.calls).toEqual([]);
  });

  it('propagates a failing append rather than denying with no record', async () => {
    const recorder = createRejectionAuditRecorder({ audit: recordingSink({ fail: true }) });
    const service = createAuthorizationService({
      permissions: { grantedPermissions: () => Promise.resolve([]) },
      denials: createAuthorizationDenialSink(recorder),
      now: () => new Date(OCCURRED_AT),
    });

    await expect(
      service.require({ tenant_id: TENANT, user_id: USER }, 'run_agents'),
    ).rejects.toThrow('audit sink unavailable');
  });

  it('surfaces a Tenant mismatch rather than filing the denial under another Tenant', async () => {
    // The append landed under a different Tenant than the denial claimed: the adapter's
    // post-append cross-check is what makes "session Tenant id" an assertion.
    const store = fakeStore(FOREIGN_TENANT);
    const service = deniedBy([], store);

    await expect(
      service.require({ tenant_id: TENANT, user_id: USER }, 'run_agents'),
    ).rejects.toThrow(/appended for session Tenant/);
  });

  it('excludes a credential value from the recorded action type', async () => {
    // `Secret` enrols its plaintext in the value-keyed registry; the Audit_Service
    // redacts per string leaf, so a credential that reached the action name never lands.
    const value = 'rzp_test_REJECTION_0123456789abcd';
    new Secret('RAZORPAY_KEY_SECRET', value);
    const store = fakeStore();
    const service = deniedBy([], store);

    await expect(
      service.require({ tenant_id: TENANT, user_id: USER }, 'run_agents', `run_${value}`),
    ).rejects.toThrow(PermissionDeniedError);

    expect((store.calls[0] as AuditEventAppendParams)[7]).not.toContain(value);
  });
});
