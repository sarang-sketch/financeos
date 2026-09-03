/**
 * The three rejection Audit_Events of Requirement 14 (task 26.5, Requirement 14.3,
 * 14.9, 14.10).
 *
 * `cross_tenant_access_rejected`, `unscoped_access_rejected` and `permission_denied`.
 * This module builds them and appends them; it decides nothing. The rejections
 * themselves already happen elsewhere and would still happen with this module deleted:
 * the RLS predicate of migration `20260101000009` returns zero rows, `createServiceClient`
 * in `@/db/clients` refuses an unscoped scope, and `AuthorizationService.require`
 * throws {@link PermissionDeniedError}. What was missing was the record.
 *
 * ## The fields, transcribed from design.md's Error Handling tables
 *
 * Every field is stored exactly once. Where `audit_events` already has a column for
 * it, that column is where it lives — a payload copy of `tenant_id` or of the User
 * identifier would be a second source of truth that could disagree with the row it
 * sits on.
 *
 * `cross_tenant_access_rejected` — design.md: *"with User id, session Tenant id,
 * requested record type and identifier, timestamp"* (Requirement 14.3):
 *
 * | design.md field | stored as |
 * |---|---|
 * | User id | `actor_kind = 'user'`, `actor_id` |
 * | session Tenant id | `audit_events.tenant_id`, bound by `app.current_tenant_id()` |
 * | requested record type | `payload.record_type` |
 * | requested record identifier | `payload.record_id` |
 * | timestamp | `occurred_at` |
 *
 * `unscoped_access_rejected` — design.md: *"with the timestamp"*; Requirement 14.10
 * adds *"recording the rejected request and the timestamp"*:
 *
 * | field | stored as |
 * |---|---|
 * | timestamp | `occurred_at` |
 * | the rejected request (14.10) | `payload.operation`, `payload.record_type` |
 * | *(the Tenant the row is filed under)* | **see the gap below — design.md names no field for it** |
 *
 * `permission_denied` — design.md: *"with User id, session Tenant id, required
 * Permission, action type, timestamp"* (Requirement 14.9), which is exactly the five
 * fields task 26.2 put on {@link PermissionDenialEvent}:
 *
 * | design.md field | stored as |
 * |---|---|
 * | User id | `actor_kind = 'user'`, `actor_id` |
 * | session Tenant id | `audit_events.tenant_id` |
 * | required Permission | `payload.required_permission` |
 * | action type | `payload.action_type` |
 * | timestamp | `occurred_at` |
 *
 * All three carry `outcome = 'blocked'` and no `stage`. `blocked` is the label
 * `LedgerAuditEvent` already uses for a refused write, so "every rejection in the
 * Audit_Log" is one predicate rather than a list of event types that has to be kept
 * up to date. No `stage`, because none of the three is an Action_Pipeline stage —
 * `auditAppendPlan` permits an outcome without a stage precisely for this shape.
 *
 * ## GAP — `unscoped_access_rejected` has no Tenant to be filed under
 *
 * `audit_events.tenant_id` is `NOT NULL`, RLS-policed, and supplied by
 * `app.current_tenant_id()` inside `AUDIT_EVENT_APPEND_SQL` — there is no parameter
 * for it. Requirement 14.10's rejection fires precisely when a privileged path has
 * **no** explicit Tenant scope, which is the same condition that makes
 * `app.current_tenant_id()` `NULL`. So the event Requirement 14.10 requires cannot be
 * appended in the case Requirement 14.10 describes, and **design.md does not say which
 * Tenant it should be filed under**: the Audit record column of that row names the
 * timestamp and nothing else.
 *
 * This is reported, not decided here. What this module does instead is the narrowest
 * thing design.md itself already sanctions: its Requirement 14.4 row says *"Audit_Event
 * only where a Tenant can be attributed; otherwise a platform log entry without Tenant
 * data"*. So {@link RejectionAuditRecorder.unscopedAccessRejected} appends the
 * Audit_Event when the caller can attribute a Tenant — a background path that knows
 * which Tenant it was working on when it issued the unscoped query — and otherwise
 * records a platform log entry carrying no Tenant identifier and returns
 * `{ recorded: false, reason: 'no_attributable_tenant' }` so the caller can see that
 * the audit half of 14.10 did not land. It never invents a Tenant, and it never
 * silently drops the event.
 *
 * Resolving it belongs to design.md. The candidates: a platform-level audit table with
 * a nullable `tenant_id` outside the tenant-scoped RLS set; a reserved platform Tenant
 * row that such events are filed under; or 14.10's Audit_Event being explicitly
 * downgraded to a platform log entry the way 14.4's already is. The third is the only
 * one that needs no migration, and it is the one the 14.4 row implies.
 *
 * ## GAP — a privileged server path is not one of Requirement 13.1's three actors
 *
 * `audit_events.actor_id` is `NOT NULL` and Requirement 13.1 restricts the actor to
 * "exactly one of a User identifier, an Agent name, or the Policy_Engine identifier".
 * An unscoped privileged access path is none of the three, and there is no `system` or
 * `platform` actor kind. {@link UnscopedAccessRejection} therefore **requires** the
 * caller to state the actor rather than defaulting to one: a fabricated actor
 * identifier in the Audit_Log is worse than an argument the caller has to supply.
 * Postgres' own `reject_mutation_and_audit` hits the same wall and substitutes
 * `session_user` for a `user` actor (FINDING 5 of migration 4.4), which is why
 * `auditAppendPlan` does not hold a `user` actor identifier to a UUID.
 *
 * ## GAP — a Tenant with no `audit_sequence_counters` row cannot record its first event
 *
 * FINDING 4 of migration 4.4, and it blocks **all three** of these event types for a
 * Tenant that has never recorded an Audit_Event: `app.append_audit_event` reads the
 * counter row `FOR UPDATE` and never creates it. That is not this module's to fix and
 * not this module's to work around either — task 25.1 already owns the workaround
 * (`AUDIT_SEQUENCE_COUNTER_SEED_SQL`, which an adapter runs before every append), and
 * `test/db/rejection-audit.test.ts` asserts both halves: the bare append fails `23502`,
 * the seeded one succeeds. Production still seeds no counter rows, so the first
 * rejection recorded for a Tenant depends on that seed statement being in the store
 * adapter. No seeding is done here.
 *
 * ## The append runs on its own connection, and it is the only write
 *
 * {@link RejectionAuditDeps.audit} must hold a connection independent of whatever
 * transaction was rejected, exactly as `LedgerAuditSink` does. Two of the three
 * rejections can be caught inside a transaction that then aborts — a cross-Tenant
 * `UPDATE` that matched zero rows, an unscoped `SELECT` — and an audit record that
 * rolls back with the rejected work is no audit record at all.
 *
 * The SQL mechanism design.md names for this, `app.append_audit_event_autonomous`,
 * **does not work**: its `dblink_connect('dbname=' || current_database())` fails with
 * SQLSTATE `2F003`, because `postgres` on Supabase local is not a superuser. So this
 * module follows the established workaround in this codebase rather than `dblink`: a
 * separate connection in TypeScript, behind the sink seam, the same choice
 * `LedgerAuditSink` and `ToolAuditSink` document. Its repair is task 4.4's.
 *
 * For `permission_denied` there is usually no transaction to survive at all, because
 * `AuthorizationService.require` runs before the action reads or changes anything.
 * That is the point of Requirement 14.9's "SHALL make no change to Tenant state", and
 * this module must not weaken it: **the Audit_Event is the only write on the denial
 * path**. `PermissionDeniedError` still carries the required Permission, this module
 * neither catches nor rewrites it, and a failing sink propagates rather than being
 * swallowed — the contract task 26.2 stated for {@link AuthorizationDenialSink}.
 *
 * ## No live store adapter
 *
 * Same reason task 25.1 shipped none: `authenticated` holds no `USAGE` on schema `app`
 * and no privilege on `audit_sequence_counters`, so neither the seed nor the append is
 * executable as the application role today. `test/db/rejection-audit.test.ts` runs the
 * exported statements of `@/audit/audit-service` with the parameters these builders
 * produce, `PREPARE`d against the live schema, which is what proves the three event
 * types are appendable. Wiring the adapter is the composition root's, once the grants
 * land.
 */

import {
  assertAuditTimestamp,
  type NarrowAuditSink,
  type NarrowAuditSinkEvent,
} from '@/audit/audit-service';
import type { Actor, TenantId } from '@/config/configuration-service';
import { redactSecrets } from '@/config/env';

import type { AuthorizationDenialSink, PermissionDenialEvent } from './authorization-service';
import { isPermission, type Permission } from './permissions';

/** The three event types of design.md's Tenancy, permission, and metric layer table. */
export const REJECTION_AUDIT_EVENT_TYPES = [
  'cross_tenant_access_rejected',
  'unscoped_access_rejected',
  'permission_denied',
] as const;

export type RejectionAuditEventType = (typeof REJECTION_AUDIT_EVENT_TYPES)[number];

/**
 * The three labels, named individually so a caller writes the constant rather than a
 * string literal. `audit_events.event_type` is `TEXT`, so a typo would append happily
 * and then never match a read.
 */
export const CROSS_TENANT_ACCESS_REJECTED: RejectionAuditEventType =
  'cross_tenant_access_rejected';
export const UNSCOPED_ACCESS_REJECTED: RejectionAuditEventType = 'unscoped_access_rejected';
export const PERMISSION_DENIED: RejectionAuditEventType = 'permission_denied';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A record identifier is an external string; keep it bounded so a payload stays legible. */
const MAX_RECORD_ID_LENGTH = 256;

/**
 * A rejection that cannot be recorded as stated: a malformed identifier, an absent
 * record type, a required Permission that is not one of the six.
 *
 * Never a value to branch on. The rejection it describes has already happened, so
 * this is a defect in the *reporting* of it, and it must be loud: a rejection with a
 * silently malformed audit record reads as audited when it is not.
 */
export class RejectionAuditError extends Error {
  override readonly name = 'RejectionAuditError';
}

/** design.md's 14.3 fields. The Tenant is the **session's**, never the foreign one. */
export interface CrossTenantAccessRejection {
  /** The session's Tenant. The row is filed under this, not under the record's owner. */
  readonly tenant_id: TenantId;
  readonly user_id: string;
  /**
   * The requested record type. The table or record type the request targeted, e.g.
   * `settlement_reconciliations`.
   *
   * Not held to an enum: the authoritative list is design.md's Row-level security
   * section and migration `20260101000009`, which name 25 tables of which 5 do not
   * exist yet. A TypeScript copy of that list would be a second one to keep in step,
   * and a type the request targeted but the copy omitted would then be unrecordable.
   */
  readonly record_type: string;
  /** The requested record identifier, as supplied by the caller. */
  readonly record_id: string;
  /** UTC, ISO-8601 to millisecond precision. */
  readonly occurred_at: string;
}

/**
 * Requirement 14.10's fields: the rejected request, and the timestamp.
 *
 * `attributed_tenant_id` is the reported gap, not a field design.md names — see the
 * module comment. With it, the event is appended; without it, there is no Tenant for
 * `audit_events.tenant_id` and a platform log entry is recorded instead.
 */
export interface UnscopedAccessRejection {
  /** Required, and deliberately not defaulted: see the actor gap in the module comment. */
  readonly actor: Actor;
  /** Which half of Requirement 14.10's "a read or a write" was rejected. */
  readonly operation: 'read' | 'write';
  /** What the unscoped request targeted. Same free-string reasoning as 14.3's. */
  readonly record_type: string;
  /** UTC, ISO-8601 to millisecond precision. */
  readonly occurred_at: string;
  /** The Tenant the privileged path was working on, where it knows one. */
  readonly attributed_tenant_id?: TenantId;
}

/**
 * Whether the Audit_Event half of Requirement 14.10 landed.
 *
 * Returned rather than thrown: the rejection itself already succeeded, so throwing
 * here would replace a correct refusal with an unrelated failure. Returned rather
 * than ignored, so a caller can surface the gap rather than assume the record exists.
 */
export type UnscopedAuditOutcome =
  | { readonly recorded: true }
  | { readonly recorded: false; readonly reason: 'no_attributable_tenant' };

/**
 * A platform-level line for a rejection that cannot be filed under a Tenant.
 *
 * Carries no Tenant identifier, no record identifier and no credential value —
 * design.md's Requirement 14.4 row calls for "a platform log entry without Tenant
 * data", and that constraint is what this shape enforces.
 */
export interface PlatformLog {
  record(entry: Readonly<Record<string, string>>): void;
}

/** `console.error` with every value redacted by credential **value** (Requirement 13.2). */
export function defaultPlatformLog(): PlatformLog {
  return {
    record(entry) {
      const safe: Record<string, string> = {};
      for (const [key, value] of Object.entries(entry)) {
        safe[redactSecrets(key)] = redactSecrets(value);
      }
      // `console.error` is the platform log: an unattributable rejection has no
      // Tenant-scoped home to be written to. `no-console` permits `error`.
      console.error(JSON.stringify(safe));
    },
  };
}

export interface RejectionAuditDeps {
  /** Must append on a connection independent of the rejected work (see the module doc). */
  readonly audit: NarrowAuditSink;
  /** Where an unattributable `unscoped_access_rejected` goes. Defaults to `console.error`. */
  readonly platformLog?: PlatformLog;
}

export interface RejectionAuditRecorder {
  /** Requirement 14.3. Filed under the session's Tenant. */
  crossTenantAccessRejected(rejection: CrossTenantAccessRejection): Promise<void>;
  /** Requirement 14.10. See {@link UnscopedAuditOutcome} and the module doc's gap. */
  unscopedAccessRejected(rejection: UnscopedAccessRejection): Promise<UnscopedAuditOutcome>;
  /** Requirement 14.9, over task 26.2's {@link PermissionDenialEvent}. */
  permissionDenied(event: PermissionDenialEvent): Promise<void>;
}

function nonEmpty(value: unknown, what: string, max = MAX_RECORD_ID_LENGTH): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RejectionAuditError(
      `${what} must be a non-empty string, got ${JSON.stringify(value)}`,
    );
  }
  if (value.length > max) {
    throw new RejectionAuditError(
      `${what} is ${value.length} characters, over the ${max} this module records`,
    );
  }
  return value;
}

function uuid(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new RejectionAuditError(
      `${what} must be a UUID; a rejection recorded against a malformed identifier ` +
        `names nobody. Got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Requirement 14.10's "a read or a write", normalised.
 *
 * Anything that is not the literal `write` records as `read`, because a value arriving
 * from a JavaScript caller through an `any`-shaped boundary must not land in the
 * Audit_Log as itself. Understating the operation is the safe direction: it never
 * claims a write happened.
 */
function operationOf(rejection: UnscopedAccessRejection): 'read' | 'write' {
  return rejection.operation === 'write' ? 'write' : 'read';
}

/** The required Permission as design.md's field: one label, or the any-of list. */
function requiredPermission(
  required: Permission | readonly Permission[],
): string | readonly string[] {
  const labels = Array.isArray(required) ? [...required] : [required as Permission];
  if (labels.length === 0) {
    throw new RejectionAuditError(
      'a permission denial names no required Permission; Requirement 14.9 records the ' +
        'Permission that was required',
    );
  }
  for (const label of labels) {
    if (!isPermission(label)) {
      throw new RejectionAuditError(
        `the required Permission ${JSON.stringify(label)} is not one of the 6 of ` +
          `Requirement 14.6, so it is not a denial worth recording as one`,
      );
    }
  }
  return Array.isArray(required) ? labels : (labels[0] as string);
}

/* -------------------------------------------------------------------------- */
/* The three events                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Requirement 14.3's event, ready for the sink.
 *
 * Exported separately from the recorder so the exact fields are assertable — by
 * `rejection-audit.test.ts` and by `test/db/rejection-audit.test.ts`, which appends it
 * through the live `AUDIT_EVENT_APPEND_SQL`.
 *
 * The requested record goes in the payload rather than in `source_record_refs`.
 * `source_record_refs` is typed to the 13 `source_record_type` labels, and a
 * cross-Tenant request can target `proposals`, `exceptions` or `evidence_chains` —
 * none of which is a Source_Record type — so using the column for the types it fits
 * and the payload for the rest would make the field's meaning depend on the target.
 * The identifier is also a *foreign* Tenant's, and `sourceHistory` (Requirement 13.6)
 * reads within one Tenant, so filing it as a Source_Record reference of the session's
 * Tenant would put it in a history where it does not belong.
 */
export function crossTenantAccessRejectedEvent(
  rejection: CrossTenantAccessRejection,
): NarrowAuditSinkEvent {
  const tenantId = uuid(rejection.tenant_id, 'tenant_id');
  const actor: Actor = { kind: 'user', id: uuid(rejection.user_id, 'user_id') };
  const event: NarrowAuditSinkEvent = {
    tenantId,
    eventType: CROSS_TENANT_ACCESS_REJECTED,
    actor,
    outcome: 'blocked',
    sourceRefs: [],
    payload: {
      record_type: nonEmpty(rejection.record_type, 'record_type'),
      record_id: nonEmpty(rejection.record_id, 'record_id'),
    },
    occurredAt: assertAuditTimestamp(rejection.occurred_at),
  };
  return Object.freeze(event);
}

/**
 * Requirement 14.10's event, for the case where a Tenant **can** be attributed.
 *
 * @throws {RejectionAuditError} when `attributed_tenant_id` is absent. There is no
 * event to build then, which is the gap the module comment reports;
 * {@link RejectionAuditRecorder.unscopedAccessRejected} is the entry point that
 * handles the absence rather than throwing on it.
 */
export function unscopedAccessRejectedEvent(
  rejection: UnscopedAccessRejection,
): NarrowAuditSinkEvent {
  if (rejection.attributed_tenant_id === undefined) {
    throw new RejectionAuditError(
      'an unscoped access rejection with no attributable Tenant cannot be appended: ' +
        'audit_events.tenant_id is NOT NULL and app.current_tenant_id() is the only source ' +
        'of it. Use RejectionAuditRecorder.unscopedAccessRejected, which records a platform ' +
        'log entry without Tenant data instead (design.md, Requirement 14.4 row)',
    );
  }
  const event: NarrowAuditSinkEvent = {
    tenantId: uuid(rejection.attributed_tenant_id, 'attributed_tenant_id'),
    eventType: UNSCOPED_ACCESS_REJECTED,
    actor: rejection.actor,
    outcome: 'blocked',
    sourceRefs: [],
    payload: {
      operation: operationOf(rejection),
      record_type: nonEmpty(rejection.record_type, 'record_type'),
    },
    occurredAt: assertAuditTimestamp(rejection.occurred_at),
  };
  return Object.freeze(event);
}

/** Requirement 14.9's event, over task 26.2's {@link PermissionDenialEvent}. */
export function permissionDeniedEvent(denial: PermissionDenialEvent): NarrowAuditSinkEvent {
  const tenantId = uuid(denial.tenant_id, 'tenant_id');
  const actor: Actor = { kind: 'user', id: uuid(denial.user_id, 'user_id') };
  const event: NarrowAuditSinkEvent = {
    tenantId,
    eventType: PERMISSION_DENIED,
    actor,
    outcome: 'blocked',
    sourceRefs: [],
    payload: {
      required_permission: requiredPermission(denial.required),
      action_type: nonEmpty(denial.action, 'action'),
    },
    occurredAt: assertAuditTimestamp(denial.occurred_at),
  };
  return Object.freeze(event);
}

/* -------------------------------------------------------------------------- */
/* The recorder                                                               */
/* -------------------------------------------------------------------------- */

export function createRejectionAuditRecorder(
  deps: RejectionAuditDeps,
): RejectionAuditRecorder {
  const platformLog = deps.platformLog ?? defaultPlatformLog();

  return {
    async crossTenantAccessRejected(rejection) {
      await deps.audit.append(crossTenantAccessRejectedEvent(rejection));
    },

    async unscopedAccessRejected(rejection) {
      // Validate before branching, so a malformed rejection is a defect either way
      // rather than one that only surfaces when a Tenant happens to be attributable.
      const operation = operationOf(rejection);
      const recordType = nonEmpty(rejection.record_type, 'record_type');
      const occurredAt = assertAuditTimestamp(rejection.occurred_at);

      if (rejection.attributed_tenant_id === undefined) {
        platformLog.record({
          event: UNSCOPED_ACCESS_REJECTED,
          operation,
          record_type: recordType,
          occurred_at: occurredAt,
          reason: 'no_attributable_tenant',
        });
        return { recorded: false, reason: 'no_attributable_tenant' };
      }

      await deps.audit.append(unscopedAccessRejectedEvent(rejection));
      return { recorded: true };
    },

    async permissionDenied(event) {
      await deps.audit.append(permissionDeniedEvent(event));
    },
  };
}

/**
 * Fill task 26.2's {@link AuthorizationDenialSink} with the `permission_denied` append.
 *
 * Nothing is caught here. A failing append propagates out of
 * `AuthorizationService.require`, which is the contract 26.2 stated: a denial with no
 * audit trail is not an outcome this system produces quietly. The denial itself is
 * unaffected either way — `PermissionDeniedError` names the required Permission and no
 * state was changed, and this sink adds exactly one write and no reads.
 */
export function createAuthorizationDenialSink(
  recorder: RejectionAuditRecorder,
): AuthorizationDenialSink {
  return {
    recordDenial(event) {
      return recorder.permissionDenied(event);
    },
  };
}
