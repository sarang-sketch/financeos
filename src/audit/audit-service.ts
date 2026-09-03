/**
 * FinanceOS_Audit_Service — the append path (task 25.1, Requirement 13.1, 13.2, 13.3).
 *
 * This module is a **wrapper around `app.append_audit_event`**, not a second
 * implementation of it. The sequence allocation, the 65536-byte payload reduction
 * and the SHA-256 Chain_Value all live in
 * `supabase/migrations/20260101000004_audit_log_append_only.sql` (task 4.4), and
 * nothing here recomputes any of them. What this module owns is everything on the
 * near side of that call: validating the draft, excluding credential values from
 * the payload, reducing a Source_Record reference to a type and an identifier, and
 * checking the row that comes back against the requirement it was supposed to
 * satisfy.
 *
 * ## Where the per-Tenant serialization actually happens
 *
 * In SQL, and only in SQL. `app.append_audit_event` opens with
 *
 *   SELECT last_sequence + 1, last_chain_value INTO v_seq, v_prev
 *     FROM audit_sequence_counters WHERE tenant_id = p_tenant_id FOR UPDATE;
 *
 * and closes by advancing that same row. The `FOR UPDATE` row lock is the whole
 * serialization: two concurrent appends for one Tenant both try to lock one counter
 * row, the second blocks until the first's transaction ends, and so exactly one of
 * them reads `last_sequence + 1` at a time. Because the function is one statement
 * it is one transaction, so the counter advances only on commit — a rolled-back
 * append consumes no sequence number, which is what makes the sequence gapless for
 * the verification walk of Requirement 13.8 rather than merely unique.
 *
 * **This module deliberately adds no serialization of its own.** A TypeScript mutex
 * would be per-process, and appends arrive from every request handler in every
 * instance, so a client-side lock would be a false guarantee that hides the real
 * one. `audit_events_sequence_uniq` ({@link AUDIT_EVENTS_SEQUENCE_UNIQ}) is the
 * backstop underneath the lock, and it is named here so a store adapter classifies
 * SQLSTATE `23505` **by constraint name** rather than treating any unique violation
 * as a sequence collision.
 *
 * ## No store adapter, and why
 *
 * `audit_events` and `audit_sequence_counters` are `ENABLE`d and `FORCE`d for
 * row-level security with no policies until task 26.1, and no grant reaches
 * `audit_sequence_counters` at all, so both tables match zero rows for every role
 * without `BYPASSRLS`. There is also no PostgREST multi-statement adapter in this
 * project. So this module follows the precedent of `EXCEPTION_UPSERT_SQL`,
 * `DUPLICATE_ACTION_LOOKBACK_SQL` and `PROPOSAL_DECISION_UPDATE_SQL`: it exports
 * the exact statements an adapter runs plus the {@link AuditEventStore} seam that
 * runs them, and `test/db/audit-append.test.ts` executes those exact strings
 * against live local Postgres. Task 26.1 wires the adapter;
 * `createSupabaseAuditSink` in `@/config/configuration-store` then delegates here
 * instead of calling the RPC itself.
 *
 * ## The Tenant is never a caller argument
 *
 * {@link AuditEventDraft} carries no Tenant identifier and neither does
 * {@link AuditEventStore.append}. {@link AUDIT_EVENT_APPEND_SQL} passes
 * `app.current_tenant_id()` as `p_tenant_id`, so the Tenant of an Audit_Event is
 * the session's Tenant by construction — there is no parameter a caller could bend
 * (Requirement 14.1, 14.2, 14.10). With no session claim `app.current_tenant_id()`
 * is `NULL`, the counter lookup matches nothing and the append fails, which is the
 * fail-closed direction. {@link AUDIT_SESSION_TENANT_PROBE_SQL} exists so an
 * adapter can report that condition as "no session Tenant" rather than as an opaque
 * `NOT NULL` violation.
 *
 * design.md's `AuditService` interface does take a `tenantId` on its three read
 * methods (`sourceHistory`, `proposalHistory`, `verifyChain`). Those are tasks 25.2
 * and 25.4, and both made the same session-bound choice this module makes: no Tenant
 * parameter on any of the three, with `app.current_tenant_id()` scoping every read.
 *
 * ## Credential values are excluded, matched by value and not by field name
 *
 * Requirement 13.2 says *exclude* every credential value, so
 * {@link sanitizeAuditPayload} does two things rather than one:
 *
 * 1. Every string — object **keys** included — passes through `redactSecrets` from
 *    `@/config/env`, the value-keyed registry every `Secret` enrols itself in on
 *    construction. Key-name redaction only catches the fields someone predicted;
 *    value-keyed redaction catches a credential that reached an unexpected field, a
 *    nested object, or a stringified error (docs/09_SECURITY.md,
 *    docs/12_OBSERVABILITY.md).
 * 2. A `Secret` instance in the payload serialises through its own `toJSON`, which
 *    yields the mask. The walk honours `toJSON` exactly as `JSON.stringify` does,
 *    so this holds for a `Secret` nested at any depth.
 *
 * Redaction happens **per string leaf**, before serialisation, not over the
 * finished JSON text. Over the text it would miss any credential containing a
 * character JSON escapes, and a pathological value could break the document's
 * structure. Per leaf, neither is possible.
 *
 * ## Source_Records are referenced by type and identifier, never carried
 *
 * `sourceRefs` is projected to exactly `{ type, id }` per entry, with the type held
 * to the `source_record_type` enum. Any other field on a supplied ref is dropped
 * rather than stored, which is the structural form of Requirement 13.2's "reference
 * affected Source_Records by identifier rather than storing a copy of the
 * Source_Record field content". The order supplied is the order stored, and
 * duplicates are kept: `source_record_refs` is a JSONB array, not a set, and
 * silently collapsing entries would change what the Chain_Value was computed over.
 *
 * ## The 65536-byte reduction belongs to SQL; the post-condition belongs here
 *
 * `app.append_audit_event` replaces an oversized payload with
 * `{"reduced": true, "excerpt": <first 60000 chars>}`, sets `payload_reduced`,
 * recomputes `payload_bytes`, and never touches `source_record_refs` — which is
 * what keeps the Source_Record identifiers unreduced (Requirement 13.3). This
 * module does not reimplement that. It measures the draft
 * ({@link auditPayloadBytes}) so the decision is legible before the call, and after
 * the call it asserts the two halves of Requirement 13.3 on the row that came back:
 * an oversized draft must return `payload_reduced: true`, and the stored
 * Source_Record references must equal the projected ones exactly.
 *
 * The measured byte count is **not** `payload_bytes`. This module measures
 * `JSON.stringify` text; SQL measures `octet_length(jsonb::text)`, which is longer
 * for every non-scalar payload because `jsonb::text` emits `': '` after each key
 * and `', '` between members. So the local count is a lower bound and the returned
 * `payload_bytes` is authoritative. That difference is one face of FINDING 6 of
 * migration 4.4 — see the chain note below.
 *
 * ## The `chainValue` seam for task 25.2
 *
 * Nothing here computes or verifies a Chain_Value. `chain_value` and
 * `prev_chain_value` arrive on {@link AuditEvent} exactly as stored, and
 * `src/audit/chain.ts` (task 25.2) owns `canonicalJson`, `chainValue` and
 * `verifyChain`.
 *
 * Two things this module does are deliberately shaped for that hand-off, and both
 * are constraints on 25.2 rather than choices 25.2 is free to make:
 *
 * - {@link AUDIT_EVENT_APPEND_SQL} returns `occurred_at` through
 *   `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` — byte for byte the expression
 *   the SQL chain hashes. Returning the raw `TIMESTAMPTZ` would hand 25.2 a value
 *   with microseconds that the hash never saw, and the walk would then mismatch on
 *   every row that has them. `occurred_at` on {@link AuditEvent} is therefore
 *   already the hashed text.
 * - `payload` and `source_record_refs` come back as parsed JSON, and the bytes the
 *   SQL hashed are `jsonb::text`, which is not what `JSON.stringify` produces:
 *   `jsonb` orders object keys by length then bytewise, inserts `': '` and `', '`,
 *   and preserves the numeric scale it parsed. FINDING 6(a)(b)(c) of migration 4.4
 *   records this as unresolved. 25.2 cannot recompute the stored `chain_value` from
 *   a `JSON.stringify`-shaped canonical form; either `canonicalJson` reproduces
 *   `jsonb::text` exactly, or the SQL hashes a canonical form instead. That is a
 *   design.md decision, and this module does not pre-empt it — which is why it
 *   exposes the parsed values and not a canonicalisation of them.
 *
 * ## Scope
 *
 * Append only. `sourceHistory` and `proposalHistory` are `src/audit/history.ts`
 * (task 25.4), `chainValue`
 * and `verifyChain` are task 25.2, property P9 is task 25.3, and the
 * mutation-rejection test is task 25.5.
 */

import type { Actor, TenantId } from '@/config/configuration-service';
import { redactSecrets } from '@/config/env';
import {
  SOURCE_RECORD_TYPES,
  type SourceRecordType,
  type SourceRef,
} from '@/ledger/posting-rules';

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/** The 7 Action_Pipeline stages, in order (Requirement 5.1, `audit_events.stage`). */
export const ACTION_PIPELINE_STAGES = [
  'DETECT',
  'INVESTIGATE',
  'EXPLAIN',
  'PROPOSE',
  'AUTHORIZE',
  'EXECUTE',
  'VERIFY',
] as const;

export type ActionPipelineStage = (typeof ACTION_PIPELINE_STAGES)[number];

/** `audit_events.outcome`, exactly the three labels of Requirement 5.2. */
export const AUDIT_OUTCOMES = ['succeeded', 'failed', 'blocked'] as const;

export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** `audit_events.actor_kind`. Mirrors {@link Actor}'s `kind`. */
const ACTOR_KINDS: readonly Actor['kind'][] = ['user', 'agent', 'policy_engine'];

/**
 * Requirement 13.3's threshold, and the `payload_bytes <= 65536` CHECK on
 * `audit_events`.
 */
export const AUDIT_PAYLOAD_MAX_BYTES = 65536;

/**
 * `UNIQUE (tenant_id, sequence_number)` on `audit_events`: the backstop underneath
 * the counter row lock.
 *
 * Named for the same reason `LEDGER_SET_DERIVATION_UNIQ` is. A store adapter that
 * read any SQLSTATE `23505` as a sequence collision would misreport an unrelated
 * unique violation, and a rename of the constraint must break loudly rather than
 * silently stop being recognised.
 */
export const AUDIT_EVENTS_SEQUENCE_UNIQ = 'audit_events_sequence_uniq';

/**
 * Postgres' generated name for `payload_bytes INT NOT NULL CHECK (payload_bytes <=
 * 65536)` on `audit_events`.
 *
 * This is the failure signature of FINDING 6(e) of migration 4.4: the reduction
 * takes `left(v_payload::text, 60000)`, which counts **characters**, while
 * `payload_bytes` and the 65536 threshold count **bytes**. A payload of multi-byte
 * characters therefore reduces to as much as 240000 bytes and then violates this
 * CHECK, so the append fails instead of reducing — Requirement 13.3 does not hold
 * for such a payload. Fixing it means changing the migration's `left(...)` to count
 * bytes, which is task 4.4's, not this task's. Named here so an adapter can say
 * which defect it hit rather than surfacing an opaque `23514`.
 */
export const AUDIT_PAYLOAD_BYTES_CHECK = 'audit_events_payload_bytes_check';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A draft that cannot be appended, or a stored row that does not satisfy the
 * requirement the append was supposed to satisfy.
 *
 * Every case is a caller fault or a broken post-condition, never a value a caller
 * is expected to branch on: an Audit_Event either gets appended or the operation
 * that wanted it recorded fails. There is no "appended without a record" outcome,
 * which is why nothing here returns a rejection the way `PostResult` does.
 */
export class AuditServiceError extends Error {
  override readonly name = 'AuditServiceError';
}

/* -------------------------------------------------------------------------- */
/* Draft and stored event                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One Audit_Event to append. design.md's `AuditEventDraft`.
 *
 * No Tenant identifier: the Tenant is the session's, bound in
 * {@link AUDIT_EVENT_APPEND_SQL} by `app.current_tenant_id()`. No sequence number,
 * no Chain_Value and no timestamp of record either — the first two are assigned
 * server-side, and `occurredAt` is when the recorded thing happened, which the
 * caller is the only one that knows.
 */
export interface AuditEventDraft {
  /** `audit_events.event_type`. Snake case by convention across the services. */
  readonly eventType: string;
  /** Exactly one of a User identifier, an Agent name, or the Policy_Engine identifier. */
  readonly actor: Actor;
  /** The Action_Pipeline stage this event records, or `null`/absent for a non-stage event. */
  readonly stage?: ActionPipelineStage | null;
  /** Required when {@link stage} is set (Requirement 5.2). */
  readonly outcome?: AuditOutcome | null;
  /**
   * The Proposal this event relates to (Requirement 13.1), or `null`. Not required on
   * a stage event — see {@link auditAppendPlan} for the Requirement 5.2 / 5.1 / 13.7
   * conflict that makes requiring it impossible for the first three stages.
   */
  readonly proposalId?: string | null;
  /** Affected Source_Records, by type and identifier only (Requirement 13.2). */
  readonly sourceRefs?: readonly SourceRef[];
  /**
   * The event payload. Carries no credential value and no copy of Source_Record
   * field content (Requirement 13.2), and no monetary value as a JSON number —
   * paise cross a JSON boundary as digit strings through `encodePaise`.
   */
  readonly payload: Readonly<Record<string, unknown>>;
  /** UTC, ISO-8601 to millisecond precision: `YYYY-MM-DDTHH:MM:SS.sssZ` (Requirement 13.1). */
  readonly occurredAt: string;
}

/**
 * One stored `audit_events` row, as {@link AUDIT_EVENT_APPEND_SQL} returns it.
 *
 * `sequence_number` is `bigint` because the column is `BIGINT`: digit text out of
 * the driver and `BigInt(...)`, never `Number(...)`.
 *
 * `occurred_at` is the `to_char`-rendered UTC millisecond text, which is the exact
 * string the SQL Chain_Value was computed over — see the module doc comment on the
 * task 25.2 seam.
 */
export interface AuditEvent {
  readonly id: string;
  readonly tenant_id: TenantId;
  readonly sequence_number: bigint;
  readonly event_type: string;
  readonly stage: ActionPipelineStage | null;
  readonly outcome: AuditOutcome | null;
  readonly actor_kind: Actor['kind'];
  readonly actor_id: string;
  readonly proposal_id: string | null;
  /** Identifiers only, and unreduced even when the payload was reduced (Requirement 13.3). */
  readonly source_record_refs: readonly SourceRef[];
  readonly payload: Readonly<Record<string, unknown>>;
  /** Requirement 13.3's indicator. */
  readonly payload_reduced: boolean;
  /** `octet_length(payload::text)` as SQL measured it. Always `<= 65536`. */
  readonly payload_bytes: number;
  readonly occurred_at: string;
  /** Hex SHA-256 (Requirement 13.4). Recomputed and verified by task 25.2, not here. */
  readonly chain_value: string;
  readonly prev_chain_value: string;
}

/* -------------------------------------------------------------------------- */
/* Timestamps                                                                 */
/* -------------------------------------------------------------------------- */

/** `YYYY-MM-DDTHH:MM:SS.sssZ`, and nothing else (Requirement 13.1). */
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `at` as UTC ISO-8601 to millisecond precision.
 *
 * Provided so callers do not each decide how to format `occurredAt`.
 * `Date.prototype.toISOString` already emits exactly this form for every year in
 * `0000..9999`; the round-trip check in {@link assertAuditTimestamp} is what rejects
 * anything outside it.
 */
export function auditTimestamp(at: Date): string {
  const ms = at.getTime();
  if (!Number.isFinite(ms)) {
    throw new AuditServiceError(
      'occurredAt must come from a valid Date; got an Invalid Date, which has no ISO-8601 form',
    );
  }
  return assertAuditTimestamp(new Date(ms).toISOString());
}

/**
 * Hold `value` to UTC ISO-8601 millisecond precision, and to being a real instant.
 *
 * The shape check alone would accept `2026-02-30T00:00:00.000Z`, which `Date` maps
 * onto 2 March. The round-trip is what rejects it: a normalised re-render that
 * differs from the input means the input was not the instant it appeared to be. It
 * matters because `occurred_at` is hashed into the Chain_Value, so a value the
 * database silently normalises would be hashed as one thing and stored as another.
 */
export function assertAuditTimestamp(value: string): string {
  if (!ISO_MS_RE.test(value)) {
    throw new AuditServiceError(
      `occurredAt must be UTC ISO-8601 to millisecond precision ` +
        `(YYYY-MM-DDTHH:MM:SS.sssZ, Requirement 13.1), got ${JSON.stringify(value)}`,
    );
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new AuditServiceError(
      `occurredAt ${JSON.stringify(value)} is not a real instant: it renders back as ` +
        `${JSON.stringify(Number.isFinite(parsed.getTime()) ? parsed.toISOString() : 'Invalid Date')}`,
    );
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Text that cannot be stored, and text that would blur the chain              */
/* -------------------------------------------------------------------------- */

/**
 * Reject `U+0000` anywhere in text bound for `audit_events`.
 *
 * Postgres `TEXT` cannot hold a NUL byte and `jsonb` rejects a `\u0000` escape
 * outright (SQLSTATE `22P05`), so a payload carrying one has no representation in
 * the column at all. There are three ways to respond and only one of them is
 * available to this task:
 *
 * - Append with the NUL escaped or replaced. That stores a payload different from
 *   the supplied one with **no indicator**, and Requirement 13.3 defines the only
 *   sanctioned payload modification there is — a reduction, with `payload_reduced`
 *   set. Inventing a second silent one is a design.md change.
 * - Append with the NUL stripped and reuse `payload_reduced`. That overloads an
 *   indicator that means "over 65536 bytes" with a second, unrelated meaning.
 * - Reject the append and name the offending path, which is what happens here.
 *
 * **Reported as a gap, not resolved:** a rejected append means the operation that
 * wanted the record fails, and for a stage Audit_Event that is a stage that cannot
 * complete (Requirement 5.2). Requirement 13.3's wording, and Requirement 13.10's
 * "the same event payload", assume a payload that can be stored as supplied.
 * Closing this properly needs either a stated sanitisation rule with its own
 * indicator, or a stated prohibition on control characters in payloads. Failing
 * loudly at the boundary is the behaviour that hides nothing in the meantime.
 */
function assertNoNul(value: string, what: string): string {
  const at = value.indexOf('\u0000');
  if (at >= 0) {
    throw new AuditServiceError(
      `${what} contains U+0000 at index ${at}. Postgres jsonb and text cannot store it ` +
        `(SQLSTATE 22P05), and Requirement 13.3 allows no silent payload rewrite — the only ` +
        `sanctioned modification is the over-65536-byte reduction, which sets payload_reduced. ` +
        `Strip or escape it in the caller`,
    );
  }
  return value;
}

/**
 * Reject `|` in the scalar fields this module controls.
 *
 * `app.append_audit_event` computes the Chain_Value over its fields joined with a
 * bare `'|'`, so the joined string is only unambiguous while no field contains the
 * separator. `event_type`, `actor_id` and a Source_Record identifier have no
 * legitimate `|` — event types are snake case, `actor_id` is a User UUID, an Agent
 * name, or the Policy_Engine identifier, and a Razorpay identifier is
 * `[A-Za-z0-9_]` — so holding them to that costs nothing and removes the part of
 * the ambiguity this module can remove.
 *
 * **It does not close the hole, and that is a finding for design.md and task 25.2.**
 * `payload::text` is unconstrained and can contain any number of `|`, so the join
 * is not injective and two distinct Audit_Events can in principle produce the same
 * hashed string. A length-prefixed join, or hashing a JSON array of the fields,
 * would make it injective. The SQL body is design.md's, transcribed, so changing it
 * is not this task's call.
 */
function assertNoChainSeparator(value: string, what: string): string {
  if (value.includes('|')) {
    throw new AuditServiceError(
      `${what} must not contain '|': app.append_audit_event joins the Chain_Value input ` +
        `fields with a bare '|' separator, so a '|' inside a field makes the join ambiguous ` +
        `(Requirement 13.4). Got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Payload sanitisation (Requirement 13.2)                                    */
/* -------------------------------------------------------------------------- */

/** A payload measured and serialised, ready to bind to `$8::jsonb`. */
export interface SanitizedAuditPayload {
  /** JSON text of the redacted payload. Always a JSON object. */
  readonly json: string;
  /** UTF-8 byte length of {@link json}. A lower bound on `payload_bytes` — see the module doc. */
  readonly bytes: number;
  /** `bytes > 65536`: the draft is oversized and SQL must reduce it (Requirement 13.3). */
  readonly exceedsLimit: boolean;
}

/** UTF-8 byte length, without a Node-only `Buffer` dependency. */
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/**
 * Walk `value` the way `JSON.stringify` does, redacting every string and rejecting
 * every construct `JSON.stringify` would drop, null out, or throw on.
 *
 * The rejections are the point. `JSON.stringify` silently omits an `undefined`
 * property, silently turns `NaN` and `Infinity` into `null`, and throws an opaque
 * `TypeError` on a `bigint`. In an audit payload each of those is a field that
 * quietly stopped saying what the caller meant, so each becomes a named error with
 * the JSON path that produced it.
 *
 * `toJSON` is honoured first, exactly as `JSON.stringify` does, which is what makes
 * a `Secret` at any depth serialise to its mask rather than being walked as an
 * object.
 */
function sanitizeValue(value: unknown, path: string, seen: Set<object>): unknown {
  if (value !== null && typeof value === 'object') {
    const toJson = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJson === 'function') {
      // Same contract JSON.stringify uses: the key argument, and `this` bound to the value.
      return sanitizeValue((toJson as (key: string) => unknown).call(value, path), path, seen);
    }
  }

  switch (typeof value) {
    case 'string':
      return redactSecrets(assertNoNul(value, `payload at ${path}`));
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new AuditServiceError(
          `payload at ${path} is ${String(value)}, which JSON.stringify writes as null — an ` +
            `Audit_Event payload must not silently lose a value`,
        );
      }
      return value;
    case 'bigint':
      throw new AuditServiceError(
        `payload at ${path} is a bigint, which has no JSON representation. A monetary value ` +
          `crosses a JSON boundary as digit text: use encodePaise from @/wire/paise-wire ` +
          `(Requirement 15.1, 15.8)`,
      );
    case 'undefined':
      throw new AuditServiceError(
        `payload at ${path} is undefined, which JSON.stringify omits entirely. Leave the key ` +
          `out deliberately, or write null`,
      );
    case 'function':
    case 'symbol':
      throw new AuditServiceError(
        `payload at ${path} is a ${typeof value}, which has no JSON representation`,
      );
    default:
      break;
  }

  if (value === null) {
    return null;
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new AuditServiceError(
      `payload at ${path} is a circular reference, which has no JSON representation`,
    );
  }
  seen.add(object);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => sanitizeValue(item, `${path}[${index}]`, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const safeKey = redactSecrets(assertNoNul(key, `payload key at ${path}`));
      out[safeKey] = sanitizeValue(item, `${path}.${key}`, seen);
    }
    return out;
  } finally {
    seen.delete(object);
  }
}

/**
 * Redact, serialise and measure an event payload (Requirement 13.2, 13.3).
 *
 * The payload must be a JSON object. `audit_events.payload` is `JSONB NOT NULL` and
 * the reduction of Requirement 13.3 replaces an oversized payload with an object,
 * so an array or a scalar payload would make the reduced and unreduced forms
 * different shapes — a reader could not treat the column uniformly.
 */
export function sanitizeAuditPayload(
  payload: Readonly<Record<string, unknown>>,
): SanitizedAuditPayload {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AuditServiceError(
      `payload must be a JSON object: audit_events.payload is JSONB NOT NULL and ` +
        `Requirement 13.3's reduction replaces it with an object, so the reduced and ` +
        `unreduced forms must be the same shape. Got ${
          Array.isArray(payload) ? 'an array' : JSON.stringify(payload)
        }`,
    );
  }

  const json = JSON.stringify(sanitizeValue(payload, '$', new Set<object>()));
  const bytes = utf8Bytes(json);
  return Object.freeze({
    json,
    bytes,
    exceedsLimit: bytes > AUDIT_PAYLOAD_MAX_BYTES,
  });
}

/** UTF-8 byte length of the redacted payload's JSON text. See {@link SanitizedAuditPayload}. */
export function auditPayloadBytes(payload: Readonly<Record<string, unknown>>): number {
  return sanitizeAuditPayload(payload).bytes;
}

/**
 * Whether SQL will reduce this payload (Requirement 13.3).
 *
 * One-directional: `true` means `jsonb::text` is longer still, so the reduction
 * certainly fires. `false` does not promise it will not — `jsonb::text` adds `': '`
 * and `', '` to every object, so a payload just under the threshold here can be
 * over it there. `AuditEvent.payload_reduced` is the fact; this is the forecast.
 */
export function payloadExceedsAuditLimit(payload: Readonly<Record<string, unknown>>): boolean {
  return sanitizeAuditPayload(payload).exceedsLimit;
}

/* -------------------------------------------------------------------------- */
/* Source_Record references (Requirement 13.2)                                */
/* -------------------------------------------------------------------------- */

/**
 * Project each supplied ref onto exactly `{ type, id }`.
 *
 * Any other field is dropped rather than stored: that is what makes "referenced by
 * identifier" structural instead of a convention a caller could forget. Order is
 * preserved and duplicates are kept — `source_record_refs` is a JSONB array whose
 * text is hashed into the Chain_Value, so collapsing entries would change what was
 * hashed.
 */
export function projectAuditSourceRefs(
  refs: readonly SourceRef[] | undefined,
): readonly SourceRef[] {
  if (refs === undefined) {
    return [];
  }
  if (!Array.isArray(refs)) {
    throw new AuditServiceError(`sourceRefs must be an array, got ${JSON.stringify(refs)}`);
  }
  return refs.map((ref, index) => {
    const where = `sourceRefs[${index}]`;
    if (ref === null || typeof ref !== 'object') {
      throw new AuditServiceError(`${where} must be a { type, id } object, got ${JSON.stringify(ref)}`);
    }
    const { type, id } = ref;
    if (!(SOURCE_RECORD_TYPES as readonly string[]).includes(type)) {
      throw new AuditServiceError(
        `${where}.type is not a source_record_type label: ${JSON.stringify(type)}. ` +
          `The 13 labels are ${SOURCE_RECORD_TYPES.join(', ')}`,
      );
    }
    if (typeof id !== 'string' || id.length === 0) {
      throw new AuditServiceError(
        `${where}.id must be a non-empty Source_Record identifier, got ${JSON.stringify(id)}`,
      );
    }
    return Object.freeze({
      type: type as SourceRecordType,
      id: redactSecrets(assertNoChainSeparator(assertNoNul(id, `${where}.id`), `${where}.id`)),
    });
  });
}

/* -------------------------------------------------------------------------- */
/* The statements an adapter runs                                             */
/* -------------------------------------------------------------------------- */

/**
 * The Tenant the session is bound to, or `NULL` when there is no session claim.
 *
 * An adapter runs this to turn "no session Tenant" into a legible failure. Without
 * it, an unscoped call reaches {@link AUDIT_EVENT_APPEND_SQL}, the counter lookup
 * matches no row, and the append dies on `audit_events.sequence_number NOT NULL` —
 * a fail-closed outcome with a misleading message. Requirement 14.10 wants an
 * unscoped privileged access path rejected and itself audited; the rejection half is
 * reachable with this probe, and the audit half lands with task 26.x, which owns
 * that path.
 */
export const AUDIT_SESSION_TENANT_PROBE_SQL = `
SELECT app.current_tenant_id() AS tenant_id`.trim();

/**
 * Create the Tenant's `audit_sequence_counters` row if it is absent. Idempotent, no
 * parameters, Tenant from the session.
 *
 * **This exists because of FINDING 4 of migration 4.4, and 25.1 is taking ownership
 * of the workaround.** `app.append_audit_event` reads the counter row with
 * `SELECT ... FOR UPDATE` and never creates it, so with no row `v_seq` and `v_prev`
 * stay `NULL` and the insert dies on `sequence_number NOT NULL`: a Tenant can never
 * record its **first** Audit_Event. design.md's entity diagram states
 * `TENANTS ||--|| AUDIT_SEQUENCE_COUNTERS`, so the row is clearly intended, but no
 * migration, trigger or service in design.md creates it. The db fixtures seed it in
 * `provision()`; production had no owner.
 *
 * The Audit_Service is the only component that reads or writes that table, so the
 * seeding sits here, in the append path, rather than waiting for a tenant
 * provisioning step that does not exist yet. Two consequences worth stating:
 *
 * - It is a **separate statement**, because there is no multi-statement adapter in
 *   this project. So it commits in its own transaction, before the append. That is
 *   safe: `ON CONFLICT DO NOTHING` makes it idempotent, two concurrent first-appends
 *   race harmlessly, and the append that follows still takes the row lock, so the
 *   serialization of Requirement 13.1 is unaffected. It does mean a seeded counter
 *   can outlive a failed append, which is harmless — `last_sequence` is still 0 and
 *   the next append allocates 1.
 * - The **permanent** fix is one of two things, both outside this task: an upsert
 *   inside `app.append_audit_event` (a task 4.4 change, and the only form that puts
 *   the seed in the same transaction as the allocation), or a row written by tenant
 *   provisioning. Until one lands, an adapter must run this before every append
 *   rather than once per Tenant, because it cannot know whether the row exists.
 */
export const AUDIT_SEQUENCE_COUNTER_SEED_SQL = `
INSERT INTO audit_sequence_counters (tenant_id)
VALUES (app.current_tenant_id())
ON CONFLICT (tenant_id) DO NOTHING`.trim();

/**
 * One Audit_Event appended through `app.append_audit_event`, with the stored row
 * returned. Parameters, in {@link auditEventAppendParams} order:
 *
 * `($1 event_type, $2 actor_kind, $3 actor_id, $4 stage, $5 outcome, $6 proposal_id,
 * $7 source_refs json, $8 payload json, $9 occurred_at)`.
 *
 * **There is no Tenant parameter.** `p_tenant_id` is `app.current_tenant_id()`, so
 * the Tenant of an Audit_Event is the session's and no caller can supply another
 * (Requirement 14.1, 14.2). This is stricter than the `$1`-bound convention of
 * `EXCEPTION_UPSERT_SQL` and `DUPLICATE_ACTION_LOOKBACK_SQL`, and deliberately so:
 * those statements are also protected by the RLS policies of task 26.1, whereas
 * `app.append_audit_event` is `SECURITY DEFINER` and therefore runs with the
 * definer's `BYPASSRLS` — the RLS predicate is not underneath it, so the Tenant has
 * to be pinned in the call itself.
 *
 * `FROM app.append_audit_event(...) AS e` rather than `SELECT (app.append_audit_event(...)).*`:
 * the latter re-evaluates the function once per selected column, which would append
 * sixteen Audit_Events. A function returning a composite type belongs in `FROM`.
 *
 * Two columns are rendered rather than returned raw, and both matter downstream:
 *
 * - `sequence_number::text` so the `BIGINT` arrives as digit text for `BigInt(...)`
 *   and never passes through a double (Requirement 15.8's discipline, applied to a
 *   non-monetary bigint for the same reason).
 * - `occurred_at` through the same `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
 *   expression the Chain_Value is computed over, so task 25.2 recomputes from the
 *   bytes that were actually hashed. Returning the raw `TIMESTAMPTZ` would expose
 *   microseconds the hash never saw (FINDING 6(d) of migration 4.4).
 */
export const AUDIT_EVENT_APPEND_SQL = `
SELECT e.id,
       e.tenant_id,
       e.sequence_number::text AS sequence_number,
       e.event_type,
       e.stage,
       e.outcome,
       e.actor_kind,
       e.actor_id,
       e.proposal_id,
       e.source_record_refs,
       e.payload,
       e.payload_reduced,
       e.payload_bytes,
       to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
       e.chain_value,
       e.prev_chain_value
  FROM app.append_audit_event(
         app.current_tenant_id(),
         $1::text, $2::text, $3::text, $4::text, $5::text,
         $6::uuid, $7::jsonb, $8::jsonb, $9::timestamptz) AS e`.trim();

/** The 9 parameters of {@link AUDIT_EVENT_APPEND_SQL}, in order. */
export type AuditEventAppendParams = readonly [
  eventType: string,
  actorKind: Actor['kind'],
  actorId: string,
  stage: ActionPipelineStage | null,
  outcome: AuditOutcome | null,
  proposalId: string | null,
  sourceRefsJson: string,
  payloadJson: string,
  occurredAt: string,
];

/**
 * A validated draft: the parameter tuple, plus what the append is expected to do to
 * the payload so the post-conditions of Requirement 13.3 can be checked afterwards.
 */
export interface AuditAppendPlan {
  readonly params: AuditEventAppendParams;
  /** The projected refs, which the stored row must reproduce exactly (Requirement 13.3). */
  readonly sourceRefs: readonly SourceRef[];
  readonly payload: SanitizedAuditPayload;
}

/**
 * Validate a draft and build the append plan.
 *
 * A stage requires an outcome. Requirement 5.2 states it — a stage Audit_Event
 * records "the stage outcome as exactly one of succeeded, failed, or blocked" — and
 * this is the only place it can be enforced, because `audit_events.outcome` is
 * nullable for the non-stage events that have no outcome.
 *
 * **A stage does not require a Proposal identifier here, and that is a reported
 * conflict rather than a decision.** Requirement 5.2 says a stage Audit_Event
 * records the Proposal identifier, and Requirement 13.7 resolves a Proposal's stage
 * history by Proposal identifier, so a stage event without one is a completed stage
 * that `proposalHistory` must report as not completed. But Requirement 5.1 orders
 * the stages DETECT, INVESTIGATE, EXPLAIN, PROPOSE, ..., and the Proposal is built
 * at PROPOSE — so during the first three stages there is no Proposal identifier to
 * record. Since task 21.1 added
 * `audit_events_proposal_id_fkey REFERENCES proposals(id)`, an early-stage event
 * carrying an identifier for a row that does not exist yet is rejected outright
 * (SQLSTATE `23503`), and requiring one here would make the first three stages of
 * every pipeline unappendable. Requirement 13.1 is the looser of the two readings —
 * "the Proposal identifier **where** the Audit_Event relates to a Proposal" — so
 * that is what is enforced.
 *
 * Resolving it belongs to design.md, and the candidates are: create the `proposals`
 * row in state `proposed` at pipeline start rather than at PROPOSE, so all 7 stages
 * have an identifier to cite; or drop the foreign key so `proposal_id` can be
 * recorded before the row exists; or accept that `proposalHistory` reports the first
 * three stages as not completed. The first is the only one that satisfies both 5.2
 * and 13.7 as written.
 *
 * `actor.id` is **not** held to a UUID even for `kind: 'user'`. Postgres'
 * `reject_mutation_and_audit()` substitutes `session_user` — a role name — when
 * `app.current_user_id()` is `NULL` (FINDING 5 of migration 4.4), so a non-UUID
 * `user` actor identifier is a state the database itself produces, and rejecting it
 * here would make Requirement 13.5's rejected-mutation event unappendable.
 */
export function auditAppendPlan(draft: AuditEventDraft): AuditAppendPlan {
  if (draft === null || typeof draft !== 'object') {
    throw new AuditServiceError(`append requires an AuditEventDraft, got ${JSON.stringify(draft)}`);
  }

  const eventType = draft.eventType;
  if (typeof eventType !== 'string' || eventType.trim().length === 0) {
    throw new AuditServiceError(
      `eventType must be a non-empty string; audit_events.event_type is NOT NULL and it is ` +
        `what the Audit_Log is read by. Got ${JSON.stringify(eventType)}`,
    );
  }
  assertNoChainSeparator(assertNoNul(eventType, 'eventType'), 'eventType');

  const actor = draft.actor;
  if (actor === null || typeof actor !== 'object') {
    throw new AuditServiceError(`actor must be a { kind, id } object, got ${JSON.stringify(actor)}`);
  }
  if (!ACTOR_KINDS.includes(actor.kind)) {
    throw new AuditServiceError(
      `actor.kind must be one of ${ACTOR_KINDS.join(', ')} (Requirement 13.1: a User ` +
        `identifier, an Agent name, or the Policy_Engine identifier). Got ${JSON.stringify(actor.kind)}`,
    );
  }
  if (typeof actor.id !== 'string' || actor.id.length === 0) {
    throw new AuditServiceError(
      `actor.id must be a non-empty identifier; audit_events.actor_id is NOT NULL. ` +
        `Got ${JSON.stringify(actor.id)}`,
    );
  }
  const actorId = redactSecrets(
    assertNoChainSeparator(assertNoNul(actor.id, 'actor.id'), 'actor.id'),
  );

  const stage = draft.stage ?? null;
  if (stage !== null && !(ACTION_PIPELINE_STAGES as readonly string[]).includes(stage)) {
    throw new AuditServiceError(
      `stage must be null or one of the 7 Action_Pipeline stages ` +
        `(${ACTION_PIPELINE_STAGES.join(', ')}), got ${JSON.stringify(stage)}`,
    );
  }

  const outcome = draft.outcome ?? null;
  if (outcome !== null && !(AUDIT_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new AuditServiceError(
      `outcome must be null or one of ${AUDIT_OUTCOMES.join(', ')} (Requirement 5.2), ` +
        `got ${JSON.stringify(outcome)}`,
    );
  }

  const proposalId = draft.proposalId ?? null;
  if (proposalId !== null && !UUID_RE.test(proposalId)) {
    throw new AuditServiceError(
      `proposalId must be null or a UUID; audit_events.proposal_id is UUID. ` +
        `Got ${JSON.stringify(proposalId)}`,
    );
  }

  if (stage !== null && outcome === null) {
    throw new AuditServiceError(
      `an Audit_Event recording stage ${stage} must carry an outcome of succeeded, failed or ` +
        `blocked (Requirement 5.2)`,
    );
  }

  const sourceRefs = projectAuditSourceRefs(draft.sourceRefs);
  const payload = sanitizeAuditPayload(draft.payload);
  const occurredAt = assertAuditTimestamp(draft.occurredAt);

  return Object.freeze({
    params: [
      eventType,
      actor.kind,
      actorId,
      stage,
      outcome,
      proposalId,
      JSON.stringify(sourceRefs),
      payload.json,
      occurredAt,
    ] as AuditEventAppendParams,
    sourceRefs,
    payload,
  });
}

/** The parameter tuple {@link AUDIT_EVENT_APPEND_SQL} expects, from a validated draft. */
export function auditEventAppendParams(draft: AuditEventDraft): AuditEventAppendParams {
  return auditAppendPlan(draft).params;
}

/* -------------------------------------------------------------------------- */
/* Persistence seam                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The one write an append needs, behind an injectable seam.
 *
 * An implementation runs {@link AUDIT_SEQUENCE_COUNTER_SEED_SQL} and then
 * {@link AUDIT_EVENT_APPEND_SQL}, binds the Tenant from the session — **no method
 * takes a Tenant identifier** (Requirement 14.1) — and returns the stored row.
 *
 * It must **throw** rather than resolve on anything other than a successful append.
 * There is no "appended nothing" value: Requirement 13.5's rejected-mutation event,
 * Requirement 5.2's stage events and Requirement 2.6's ledger rejection all require
 * the record, so a silent no-op here would let an operation report itself as audited
 * when it is not.
 *
 * Two rejections are worth classifying by name rather than by SQLSTATE alone:
 * {@link AUDIT_EVENTS_SEQUENCE_UNIQ} on `23505`, which means the counter lock was
 * somehow bypassed, and {@link AUDIT_PAYLOAD_BYTES_CHECK} on `23514`, which is
 * FINDING 6(e) of migration 4.4 — a multi-byte payload whose reduction is still over
 * 65536 bytes.
 */
export interface AuditEventStore {
  append(params: AuditEventAppendParams): Promise<AuditEvent>;
}

/* -------------------------------------------------------------------------- */
/* The service                                                                */
/* -------------------------------------------------------------------------- */

/**
 * design.md's `AuditService`, restricted to the append path.
 *
 * `sourceHistory` and `proposalHistory` are `createAuditHistory` in
 * `src/audit/history.ts` (task 25.4) and `verifyChain` is `createChainVerifier` in
 * `src/audit/chain.ts` (task 25.2). They are absent here rather than stubbed: a
 * `verifyChain` that returned
 * `intact: true` without walking anything would be worse than one that does not
 * exist.
 */
export interface AuditService {
  /** Sequence number and Chain_Value are assigned server-side (Requirement 13.1, 13.4). */
  append(draft: AuditEventDraft): Promise<AuditEvent>;
}

export interface AuditServiceDeps {
  readonly store: AuditEventStore;
}

/** 64 hex characters, `audit_events.chain_value` / `prev_chain_value`. */
const CHAIN_VALUE_RE = /^[0-9a-f]{64}$/;

/**
 * Check the stored row against what the append was supposed to guarantee.
 *
 * These are post-conditions on `app.append_audit_event`, not re-derivations of it.
 * Each one is a requirement that would otherwise be believed rather than observed:
 *
 * - `sequence_number >= 1` and a 64-hex `chain_value` / `prev_chain_value`
 *   (Requirement 13.1, 13.4).
 * - An oversized draft came back with `payload_reduced` set (Requirement 13.3). The
 *   implication runs one way only, because `jsonb::text` is longer than
 *   `JSON.stringify` text for every non-scalar payload — so a draft this module
 *   measured as oversized is certainly oversized in SQL, while the converse does not
 *   hold and is not asserted.
 * - `payload_bytes <= 65536` (Requirement 13.3, and the column CHECK).
 * - The stored Source_Record references equal the projected ones, in order. This is
 *   the "SHALL store the affected Source_Record identifiers unreduced" half of
 *   Requirement 13.3, and it is the half a reduction could plausibly break, so it is
 *   checked on every append rather than only on an oversized one.
 */
function assertAppendPostConditions(event: AuditEvent, plan: AuditAppendPlan): AuditEvent {
  if (typeof event.sequence_number !== 'bigint' || event.sequence_number < 1n) {
    throw new AuditServiceError(
      `the stored Audit_Event has sequence_number ${String(event.sequence_number)}; ` +
        `Requirement 13.1 makes the first Audit_Event of a Tenant 1 and every later one the ` +
        `preceding number plus 1`,
    );
  }
  for (const [field, value] of [
    ['chain_value', event.chain_value],
    ['prev_chain_value', event.prev_chain_value],
  ] as const) {
    if (!CHAIN_VALUE_RE.test(value)) {
      throw new AuditServiceError(
        `the stored Audit_Event has ${field} ${JSON.stringify(value)}, which is not the ` +
          `64-character lower-case hex SHA-256 of Requirement 13.4`,
      );
    }
  }
  if (event.payload_bytes > AUDIT_PAYLOAD_MAX_BYTES) {
    throw new AuditServiceError(
      `the stored Audit_Event has payload_bytes ${event.payload_bytes}, over Requirement ` +
        `13.3's limit of ${AUDIT_PAYLOAD_MAX_BYTES}`,
    );
  }
  if (plan.payload.exceedsLimit && !event.payload_reduced) {
    throw new AuditServiceError(
      `the supplied payload was ${plan.payload.bytes} bytes, over Requirement 13.3's limit of ` +
        `${AUDIT_PAYLOAD_MAX_BYTES}, but the stored Audit_Event does not carry the reduction ` +
        `indicator`,
    );
  }

  const stored = event.source_record_refs;
  const expected = plan.sourceRefs;
  const sameRefs =
    Array.isArray(stored) &&
    stored.length === expected.length &&
    expected.every(
      (ref, index) => stored[index]?.type === ref.type && stored[index]?.id === ref.id,
    );
  if (!sameRefs) {
    throw new AuditServiceError(
      `the stored Audit_Event's Source_Record references are not the ones supplied, so ` +
        `Requirement 13.3's "identifiers unreduced" does not hold. Supplied ` +
        `${JSON.stringify(expected)}, stored ${JSON.stringify(stored)}`,
    );
  }
  return event;
}

export function createAuditService(deps: AuditServiceDeps): AuditService {
  const { store } = deps;

  return {
    async append(draft: AuditEventDraft): Promise<AuditEvent> {
      const plan = auditAppendPlan(draft);
      return assertAppendPostConditions(await store.append(plan.params), plan);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The narrow-sink hand-off (tasks 5.1, 8.3, 12.x)                            */
/* -------------------------------------------------------------------------- */

/**
 * The event shape the three narrow audit sinks already declare, structurally.
 *
 * `LedgerAuditSink` (`@/ledger/semantic-ledger`), `ToolAuditSink` (`@/tools/tool`)
 * and `ConfigurationAuditSink` (`@/config/configuration-service`) were each written
 * before this service existed, and each declared exactly one method over exactly
 * this set of fields — `ConfigurationAuditEvent` without `outcome` and `sourceRefs`,
 * the other two with a narrowed `outcome` union. This is their common shape, so
 * {@link auditSinkAdapter} satisfies all three **without importing any of them and
 * without changing any of their interfaces**, which is what those modules' task 25.1
 * notes promised.
 *
 * `eventType` is `string` rather than a union: each sink owns its own event-type
 * vocabulary, and this service does not adjudicate between them.
 */
export interface NarrowAuditSinkEvent {
  /** Cross-checked against the session Tenant the append actually landed under. */
  readonly tenantId: TenantId;
  readonly eventType: string;
  readonly actor: Actor;
  readonly outcome?: AuditOutcome | null;
  readonly sourceRefs?: readonly SourceRef[];
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

/** The single-method sink shape `LedgerAuditSink`, `ToolAuditSink` and `ConfigurationAuditSink` share. */
export interface NarrowAuditSink {
  append(event: NarrowAuditSinkEvent): Promise<void>;
}

/**
 * Adapt this service to the narrow sink seam the ledger, the tool layer and the
 * configuration service inject.
 *
 * The sink carries a `tenantId` and the append does not, because the Tenant comes
 * from the session (see the module doc comment). Rather than ignore the field, the
 * adapter compares it to the `tenant_id` on the row that came back and throws when
 * they disagree: a caller that believed it was writing for a different Tenant than
 * its session is bound to has a bug worth surfacing, and the check needs no second
 * copy of the session Tenant to make it.
 *
 * The comparison is necessarily **after** the append. The event lands under the
 * session's Tenant, which is where it belongs, and the throw tells the caller its
 * assumption was wrong. The alternative — refusing before the append — would need
 * this module to hold a Tenant identifier of its own, and two sources of truth for
 * the session Tenant is the condition this design exists to avoid.
 *
 * A sink event carries no `stage` and no `proposalId`, so none of these three
 * callers can append a stage Audit_Event through this adapter. That is correct:
 * stage events belong to the Agent Engine, the Policy_Engine and the Action_Service,
 * which use {@link AuditService.append} directly.
 */
export function auditSinkAdapter(service: AuditService): NarrowAuditSink {
  return {
    async append(event: NarrowAuditSinkEvent): Promise<void> {
      const stored = await service.append({
        eventType: event.eventType,
        actor: event.actor,
        outcome: event.outcome ?? null,
        sourceRefs: event.sourceRefs ?? [],
        payload: event.payload,
        occurredAt: event.occurredAt,
      });
      if (stored.tenant_id !== event.tenantId) {
        throw new AuditServiceError(
          `Audit_Event ${stored.event_type} was appended for session Tenant ` +
            `${stored.tenant_id}, but the caller supplied ${event.tenantId}. The Tenant of an ` +
            `Audit_Event is the session's (Requirement 14.1, 14.2, 14.8); a caller that ` +
            `expected another Tenant is bound to the wrong session`,
        );
      }
    },
  };
}
