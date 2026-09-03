/**
 * The Audit_Log Chain_Value and the verification walk (task 25.2, Requirement 13.4,
 * 13.8).
 *
 * `src/audit/audit-service.ts` (task 25.1) owns the append and deliberately computes
 * no Chain_Value: `chain_value` and `prev_chain_value` arrive on `AuditEvent` exactly
 * as `app.append_audit_event` stored them. This module owns the other direction —
 * recomputing a Chain_Value from an Audit_Event's stored fields and walking a
 * Tenant's Audit_Log in ascending sequence order to report tampering and gaps.
 *
 * ## THE RECOMPUTATION DOES NOT REPRODUCE EVERY STORED Chain_Value, AND THAT IS
 * ## MEASURED HERE RATHER THAN HIDDEN
 *
 * This is FINDING 6(a)(b)(c) of `20260101000004_audit_log_append_only.sql`, and task
 * 25.2 confirms it against live local Postgres rather than restating it. The SQL
 * hashes `p_source_refs::text` and `v_payload::text` — `jsonb::text`, not
 * `JSON.stringify` text. `jsonb::text` differs in three ways:
 *
 *   a) it orders object keys by **key length first, then bytewise**, so
 *      `{"b":1,"aa":2}` renders `{"b": 1, "aa": 2}` where plain lexicographic
 *      ordering renders `{"aa":2,"b":1}`;
 *   b) it emits `': '` after every key and `', '` between every member;
 *   c) it preserves the numeric scale it parsed, so `1.0` stays `1.0` where
 *      `JSON.stringify` collapses it to `1`.
 *
 * The task specifies {@link canonicalJson} as "sorted keys, preserved array order",
 * which is (b)-free and lexicographic, so it is implemented exactly that way and the
 * consequence is reported. **Measured** against the deployed function (see
 * `test/db/audit-chain-verify.test.ts`, which runs the real append and this real
 * walk):
 *
 * ```
 *   payload {}                      jsonb::text `{}`                    canonicalJson `{}`
 *   source_record_refs []           jsonb::text `[]`                    canonicalJson `[]`
 *     -> all 12 hashed parts agree byte for byte
 *     -> verifyChain reports intact: true against the STORED chain_value
 *
 *   payload {"note":"db-test"}      jsonb::text `{"note": "db-test"}`   (19 bytes)
 *                                   canonicalJson `{"note":"db-test"}`  (18 bytes)
 *     -> one 0x20 inserted at byte offset 8, after the `:` at offset 7
 *     -> verifyChain reports first_mismatched_sequence_number for that row
 *     -> and part 10 is the WHOLE of the difference: substituting the stored
 *        payload::text into that one part reproduces the stored chain_value byte for
 *        byte, so the join, the field order, the '|' separator and the timestamp text
 *        are all confirmed identical
 * ```
 *
 * The digests themselves are not quoted here: `tenant_id` is part 1, so every stored
 * Chain_Value is specific to one Tenant and a pasted pair of digests would be
 * unverifiable. The db test reproduces the relation instead of the constants.
 *
 * So the walk is **correct and useful for an empty payload with no Source_Record
 * references, and reports a false mismatch for every other Audit_Event**. That is
 * not a defect in this module and it is not repaired here, because both available
 * repairs are design.md decisions:
 *
 * 1. Specify `canonicalJson` to reproduce `jsonb::text` exactly —
 *    length-then-bytewise key order, `': '` and `', '` separators, Postgres numeric
 *    text. Cheap to write, but it makes the tamper-evidence value depend on a
 *    Postgres rendering detail, and any Postgres change to `jsonb` output
 *    invalidates every stored Chain_Value in the system.
 * 2. Have `app.append_audit_event` hash a canonical form instead of `jsonb::text`.
 *    Correct in the long run, and it strands every Chain_Value already stored, so it
 *    needs a migration story.
 *
 * Making {@link canonicalJson} quietly emit `jsonb::text` would look like a fix and
 * would instead bake choice 1 in without anyone deciding it, so this module does not
 * do that. {@link chainValueParts} exists so a caller — or property P9's
 * counterexample triage — can see **which** of the 12 parts differs instead of
 * getting only a pair of unequal digests.
 *
 * A fourth, smaller divergence is already closed upstream: `occurred_at` is hashed
 * through `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`, and
 * `AUDIT_EVENT_APPEND_SQL` returns that same expression, so the value on
 * `AuditEvent.occurred_at` is already the hashed text (FINDING 6(d)).
 * {@link normalizeOccurredAt} is therefore idempotent on it, and exists for the
 * callers that hold a raw `TIMESTAMPTZ` rendering instead — it **truncates**
 * sub-millisecond digits rather than rounding them, because that is what `to_char`
 * with `MS` does (verified: `09:30:00.999999` renders `09:30:00.999`).
 *
 * ## The join is still not injective, and this module cannot make it so
 *
 * The 12 parts are joined with a bare `'|'`. Task 25.1 rejects `'|'` in
 * `event_type`, `actor_id` and Source_Record identifiers, which narrows the surface;
 * `canonicalJson(payload)` is unconstrained, so two distinct Audit_Events can still
 * in principle produce the same hashed string. A length-prefixed join, or hashing a
 * JSON array of the 12 parts, would close it. The join is design.md's, transcribed
 * in both the SQL and here, so changing it belongs with the two repairs above.
 *
 * ## `verifyChain` takes no Tenant identifier — a decision, stated
 *
 * design.md's `AuditService.verifyChain(tenantId)` takes one, and task 25.1 flagged
 * that the same session-bound treatment it applies to `append` should apply to the
 * read methods and left the choice open. **The choice made here is session-bound: no
 * Tenant parameter.** {@link AUDIT_CHAIN_WALK_SQL} scopes on
 * `app.current_tenant_id()`, {@link AuditChainStore} takes no argument, and
 * {@link verifyChain} reads each row's `tenant_id` off the row because `tenant_id` is
 * one of the hashed fields.
 *
 * The reason is that a Tenant parameter here would be a *second* source of truth for
 * the Tenant, and the one thing a verification walk must not do is let a caller
 * choose whose Audit_Log it reads (Requirement 14.1, 14.2, 14.7). The walk is
 * additionally guarded: {@link verifyChain} throws if the rows do not all carry one
 * `tenant_id`, so a row source that is not Tenant-scoped fails loudly instead of
 * producing a verification result over a mixture of Tenants.
 *
 * ## Two further deviations from design.md's sketch, both deliberate
 *
 * - `ChainVerification.first_mismatched_sequence_number` and
 *   `first_absent_sequence_number` are `bigint | null`, not design.md's
 *   `number | null`. `audit_events.sequence_number` is `BIGINT`; design.md's own
 *   pseudo-code walks it as `bigint` and then assigns it into a `number` field, which
 *   is an internal inconsistency in the design. `bigint` is the side that cannot
 *   silently lose a value, so that is the side taken. Reported, not resolved.
 * - The walk throws on a row source that is not **strictly** ascending. design.md's
 *   loop would treat a repeated or out-of-order sequence number as a gap at
 *   `expectedSeq` and could walk `expectedSeq` backwards. `UNIQUE (tenant_id,
 *   sequence_number)` plus `ORDER BY sequence_number` makes that unreachable for a
 *   real row source, so it is a broken source rather than a chain anomaly, and
 *   reporting it as a gap would be a wrong answer rather than a missing one.
 *
 * ## Scope
 *
 * `chainValue`, `canonicalJson`, the `occurred_at` normalisation and the walk. The
 * seam property P9 (task 25.3) plugs into is {@link chainValue},
 * {@link INITIAL_CHAIN_VALUE}, {@link chainValueParts} and
 * {@link createChainVerifier} over an in-memory {@link AuditChainStore}; history
 * retrieval is task 25.4 and the mutation-rejection test is task 25.5.
 */

import { createHash } from 'node:crypto';

import type { TenantId } from '@/config/configuration-service';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A value that cannot participate in a Chain_Value recomputation, or a row source
 * that breaks the walk's contract.
 *
 * Never a tamper report: tampering is a {@link ChainVerification} field, because it
 * is the answer the caller asked for. This class is for the cases where there is no
 * answer to give.
 */
export class AuditChainError extends Error {
  override readonly name = 'AuditChainError';
}

/* -------------------------------------------------------------------------- */
/* The fixed initial Chain_Value (Requirement 13.4)                           */
/* -------------------------------------------------------------------------- */

/**
 * The Chain_Value the Audit_Event with sequence number 1 chains from
 * (Requirement 13.4's "fixed initial Chain_Value").
 *
 * 64 zeros, matching design.md's `INITIAL_CHAIN_VALUE` and
 * `audit_sequence_counters.last_chain_value DEFAULT repeat('0', 64)`.
 * `test/db/audit-append.test.ts` already asserts the first event of a Tenant stores
 * exactly this in `prev_chain_value`.
 */
export const INITIAL_CHAIN_VALUE = '0'.repeat(64);

/** 64 lower-case hex characters: `audit_events.chain_value` / `prev_chain_value`. */
const CHAIN_VALUE_RE = /^[0-9a-f]{64}$/;

/* -------------------------------------------------------------------------- */
/* canonicalJson                                                              */
/* -------------------------------------------------------------------------- */

/**
 * `value` as JSON text with object keys sorted and array order preserved.
 *
 * "Sorted" is plain lexicographic over UTF-16 code units — `Array.prototype.sort`'s
 * default comparison, which is what design.md's "sorts object keys" reads as. It is
 * **not** Postgres' length-then-bytewise `jsonb` order; see the divergence note in
 * the module doc comment.
 *
 * Array order is preserved because `source_record_refs` is an ordered JSONB array,
 * not a set: task 25.1 stores the order supplied and keeps duplicates precisely so
 * that what was hashed stays reproducible.
 *
 * Every construct `JSON.stringify` would silently drop, null out, or throw an opaque
 * `TypeError` on becomes a named error carrying the JSON path, for the same reason
 * `sanitizeAuditPayload` does it on the append side: in a Chain_Value input, a field
 * that quietly stopped saying what it said is a false tamper report.
 *
 * `toJSON` is honoured first, exactly as `JSON.stringify` does, so a `Secret` that
 * somehow reached a stored payload renders as its mask rather than being walked.
 */
export function canonicalJson(value: unknown): string {
  return writeCanonical(value, '$', new Set<object>());
}

function writeCanonical(value: unknown, path: string, seen: Set<object>): string {
  if (value !== null && typeof value === 'object') {
    const toJson = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJson === 'function') {
      // Same contract JSON.stringify uses: the key argument, `this` bound to the value.
      return writeCanonical((toJson as (key: string) => unknown).call(value, path), path, seen);
    }
  }

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new AuditChainError(
          `${path} is ${String(value)}, which JSON.stringify writes as null — a Chain_Value ` +
            `input must not silently lose a value (Requirement 13.4)`,
        );
      }
      return JSON.stringify(value);
    case 'bigint':
      throw new AuditChainError(
        `${path} is a bigint, which has no JSON representation. A monetary value crosses a ` +
          `JSON boundary as digit text through encodePaise (Requirement 15.1, 15.8)`,
      );
    case 'undefined':
      throw new AuditChainError(
        `${path} is undefined, which JSON.stringify omits entirely, so the canonical form ` +
          `would not describe the stored Audit_Event`,
      );
    case 'function':
    case 'symbol':
      throw new AuditChainError(`${path} is a ${typeof value}, which has no JSON representation`);
    default:
      break;
  }

  if (value === null) {
    return 'null';
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new AuditChainError(`${path} is a circular reference, which has no JSON representation`);
  }
  seen.add(object);
  try {
    if (Array.isArray(value)) {
      // Order preserved: source_record_refs is an ordered array, not a set.
      return `[${value.map((item, i) => writeCanonical(item, `${path}[${i}]`, seen)).join(',')}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    // Plain lexicographic, NOT Postgres' length-then-bytewise jsonb order.
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const members = entries.map(
      ([key, item]) => `${JSON.stringify(key)}:${writeCanonical(item, `${path}.${key}`, seen)}`,
    );
    return `{${members.join(',')}}`;
  } finally {
    seen.delete(object);
  }
}

/* -------------------------------------------------------------------------- */
/* occurred_at normalisation                                                  */
/* -------------------------------------------------------------------------- */

/** `YYYY-MM-DDTHH:MM:SS.sssZ`, and nothing else (Requirement 13.1). */
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A rendered timestamp in any of the forms a Postgres driver or a caller produces:
 * `T` or a space, optional fractional seconds of any length, and `Z`, `+HH`,
 * `+HH:MM` or `+HHMM`.
 */
const RENDERED_TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * `value` as the exact text the Chain_Value is computed over:
 * `YYYY-MM-DDTHH:MM:SS.sssZ` in UTC (Requirement 13.1, 13.4).
 *
 * Idempotent on a value that is already in that form, which is the normal case —
 * `AUDIT_EVENT_APPEND_SQL` returns `occurred_at` through the same
 * `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` expression the SQL hashes, so
 * `AuditEvent.occurred_at` is already the hashed text (FINDING 6(d) of migration
 * 4.4). This function exists for a row source that hands over a raw `TIMESTAMPTZ`
 * rendering instead, and for that case two details are load-bearing:
 *
 * - Sub-millisecond digits are **truncated, not rounded**, because `to_char` with
 *   `MS` truncates: Postgres renders `09:30:00.999999` as `09:30:00.999`. Rounding
 *   would produce `09:30:01.000` and report a false mismatch on every microsecond
 *   timestamp.
 * - An offset is shifted to UTC, because the SQL hashes
 *   `p_occurred_at AT TIME ZONE 'UTC'`.
 *
 * A missing offset is rejected rather than assumed to be UTC. `TIMESTAMPTZ` is an
 * instant, and guessing a zone for a value that did not state one would hash a
 * different instant than the one stored.
 */
export function normalizeOccurredAt(value: string): string {
  if (typeof value !== 'string') {
    throw new AuditChainError(
      `occurred_at must be a rendered timestamp string, got ${JSON.stringify(value)}`,
    );
  }
  if (ISO_MS_RE.test(value)) {
    return assertRealInstant(value);
  }

  const parsed = RENDERED_TIMESTAMP_RE.exec(value);
  if (parsed === null) {
    throw new AuditChainError(
      `occurred_at ${JSON.stringify(value)} is not a rendered UTC-offset timestamp, so it ` +
        `cannot be normalised to Requirement 13.1's YYYY-MM-DDTHH:MM:SS.sssZ`,
    );
  }
  const [, date = '', time = '', fraction, offset] = parsed;
  if (offset === undefined) {
    throw new AuditChainError(
      `occurred_at ${JSON.stringify(value)} carries no UTC offset. audit_events.occurred_at is ` +
        `TIMESTAMPTZ — an instant — and the Chain_Value is computed over it AT TIME ZONE 'UTC', ` +
        `so a zone cannot be assumed`,
    );
  }
  // Truncate rather than round: this is what to_char(..., 'MS') does.
  const millis = `${fraction ?? ''}000`.slice(0, 3);
  const instant = new Date(`${date}T${time}.${millis}${normalizeOffset(offset)}`);
  if (!Number.isFinite(instant.getTime())) {
    throw new AuditChainError(
      `occurred_at ${JSON.stringify(value)} is not a real instant, so it has no ISO-8601 form`,
    );
  }
  return instant.toISOString();
}

/**
 * `offset` as `Z` or `±HH:MM`, which are the only forms `Date` parses.
 *
 * Postgres renders a zero-minute offset as `+00` and `Asia/Kolkata` as `+05:30`, while
 * some drivers emit `+0530`. `new Date('...+00')` is an Invalid Date, so a raw
 * `TIMESTAMPTZ` rendering would otherwise be rejected as "not a real instant" — which
 * is the wrong diagnosis for a value that is perfectly real.
 */
function normalizeOffset(offset: string): string {
  if (offset === 'Z') {
    return 'Z';
  }
  const sign = offset.slice(0, 1);
  const digits = offset.slice(1).replace(':', '');
  return `${sign}${digits.slice(0, 2)}:${digits.length > 2 ? digits.slice(2, 4) : '00'}`;
}

/**
 * Reject a value that has the right shape but is not the instant it appears to be —
 * `2026-02-30T00:00:00.000Z`, which `Date` maps onto 2 March. A value the database
 * would silently normalise would be hashed as one thing and stored as another.
 */
function assertRealInstant(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new AuditChainError(
      `occurred_at ${JSON.stringify(value)} is not a real instant: it renders back as ` +
        `${JSON.stringify(Number.isFinite(parsed.getTime()) ? parsed.toISOString() : 'Invalid Date')}`,
    );
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* chainValue (Requirement 13.4)                                              */
/* -------------------------------------------------------------------------- */

/**
 * The stored fields a Chain_Value is computed over.
 *
 * Structurally a subset of `AuditEvent` from `@/audit/audit-service`, so a row that
 * came back from the append satisfies it without conversion, and so property P9's
 * in-memory sequences can satisfy it too. `prev_chain_value` is deliberately absent:
 * the walk chains from the **preceding row's stored `chain_value`**, and taking the
 * predecessor's value from the row under test would make a tampered
 * `prev_chain_value` verify against itself.
 */
export interface ChainedAuditEventFields {
  readonly tenant_id: TenantId | string;
  readonly sequence_number: bigint;
  readonly event_type: string;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly stage: string | null;
  readonly outcome: string | null;
  readonly proposal_id: string | null;
  readonly source_record_refs: unknown;
  readonly payload: unknown;
  /** ISO-8601 UTC to millisecond precision; normalised by {@link normalizeOccurredAt}. */
  readonly occurred_at: string;
}

/** One row the walk reads: the hashed fields plus the Chain_Value stored beside them. */
export interface ChainedAuditEvent extends ChainedAuditEventFields {
  readonly chain_value: string;
}

/**
 * The 12 parts {@link chainValue} joins, in design.md's order.
 *
 * Exported so a mismatch can be **localised** rather than merely detected: a caller
 * with the stored and recomputed digests learns only that they differ, while a caller
 * with two part arrays sees which field diverged and by which bytes. That is what
 * made the `jsonb::text` divergence in the module doc comment measurable, and it is
 * what property P9's counterexample triage needs.
 */
export function chainValueParts(
  event: ChainedAuditEventFields,
  prevChainValue: string,
): readonly string[] {
  if (event === null || typeof event !== 'object') {
    throw new AuditChainError(
      `a Chain_Value is computed over an Audit_Event's stored fields, got ${JSON.stringify(event)}`,
    );
  }
  if (typeof event.sequence_number !== 'bigint') {
    throw new AuditChainError(
      `sequence_number must be a bigint (audit_events.sequence_number is BIGINT; it crosses as ` +
        `digit text and becomes BigInt(...), never Number(...)), got ` +
        `${JSON.stringify(String(event.sequence_number))}`,
    );
  }
  if (!CHAIN_VALUE_RE.test(prevChainValue)) {
    throw new AuditChainError(
      `the preceding Chain_Value must be 64 lower-case hex characters (Requirement 13.4), got ` +
        `${JSON.stringify(prevChainValue)}`,
    );
  }

  return [
    String(event.tenant_id),
    event.sequence_number.toString(),
    event.event_type,
    event.actor_kind,
    event.actor_id,
    event.stage ?? '',
    event.outcome ?? '',
    event.proposal_id ?? '',
    canonicalJson(event.source_record_refs),
    canonicalJson(event.payload),
    normalizeOccurredAt(event.occurred_at),
    prevChainValue,
  ];
}

/**
 * The Chain_Value of `event` given the Chain_Value of the Audit_Event holding the
 * immediately preceding sequence number (Requirement 13.4).
 *
 * Only stored fields participate, so recomputation reads the row and reproduces the
 * value with no external input. For sequence number 1 the caller passes
 * {@link INITIAL_CHAIN_VALUE}.
 *
 * A plain SHA-256, not a keyed MAC, matching the SQL's
 * `encode(digest(..., 'sha256'), 'hex')`. The Chain_Value is tamper **evidence** —
 * it must be reproducible by anyone holding the rows — not an authenticator.
 */
export function chainValue(event: ChainedAuditEventFields, prevChainValue: string): string {
  return createHash('sha256')
    .update(chainValueParts(event, prevChainValue).join('|'), 'utf8')
    .digest('hex');
}

/* -------------------------------------------------------------------------- */
/* The verification walk (Requirement 13.8)                                   */
/* -------------------------------------------------------------------------- */

/**
 * design.md's `ChainVerification`, with the two sequence numbers as `bigint`.
 *
 * Requirement 13.8 asks for a result stating **either** that every recomputed
 * Chain_Value equals its stored one and no sequence number is absent, **or** the
 * lowest mismatched sequence number and the lowest absent sequence number. The two
 * anomalies are reported independently because they can coexist: a gap does not mask
 * a mismatch and a mismatch does not mask a gap.
 */
export interface ChainVerification {
  /** Both anomaly fields are `null`. */
  readonly intact: boolean;
  /** The lowest sequence number whose recomputed Chain_Value differs from its stored one. */
  readonly first_mismatched_sequence_number: bigint | null;
  /** The lowest sequence number that should exist and does not. */
  readonly first_absent_sequence_number: bigint | null;
}

/** Rows in ascending sequence order, sync or async — `for await` accepts both. */
export type AuditChainRows = AsyncIterable<ChainedAuditEvent> | Iterable<ChainedAuditEvent>;

/**
 * The one read the walk needs, behind an injectable seam.
 *
 * **No Tenant parameter**: an implementation scopes on the session's Tenant, which is
 * what {@link AUDIT_CHAIN_WALK_SQL} does. See the module doc comment for why that
 * differs from design.md's `verifyChain(tenantId)`.
 */
export interface AuditChainStore {
  eventsAscendingBySequence(): AuditChainRows;
}

/**
 * Walk `rows` in ascending sequence order, reporting the lowest mismatch and the
 * lowest gap independently (Requirement 13.8).
 *
 * `prev` advances to each row's **stored** `chain_value`, never to the recomputed
 * one. Chaining from the recomputed value would make one tampered Audit_Event report
 * every later Audit_Event as mismatched: the "lowest mismatched sequence number"
 * would still be right, but the result would no longer locate the edit, which is the
 * thing the walk exists to do.
 *
 * A gap is reported at the sequence number that **should have been there** — the
 * lowest absent one — not at the row that revealed it. With rows 1, 2, 4 the answer
 * is 3.
 *
 * Read-only. Nothing here writes, and in particular nothing here repairs a
 * Chain_Value: `audit_events` is append-only (Requirement 13.5) and a reported
 * anomaly is evidence, not something to reconcile away.
 */
export async function verifyChain(rows: AuditChainRows): Promise<ChainVerification> {
  let expectedSeq = 1n;
  let prev = INITIAL_CHAIN_VALUE;
  let firstMismatch: bigint | null = null;
  let firstGap: bigint | null = null;
  let tenantId: string | null = null;
  let previousSeq: bigint | null = null;

  for await (const row of rows) {
    if (row === null || typeof row !== 'object') {
      throw new AuditChainError(
        `the row source yielded ${JSON.stringify(row)}; the walk reads Audit_Event rows`,
      );
    }
    if (typeof row.sequence_number !== 'bigint') {
      throw new AuditChainError(
        `the row source yielded sequence_number ${JSON.stringify(String(row.sequence_number))}; ` +
          `audit_events.sequence_number is BIGINT and must arrive as a bigint, never a number`,
      );
    }
    // A row source that is not strictly ascending is broken, not tampered: UNIQUE
    // (tenant_id, sequence_number) plus an ascending order makes it unreachable. Reporting
    // it as a gap would be a wrong answer rather than a missing one.
    if (previousSeq !== null && row.sequence_number <= previousSeq) {
      throw new AuditChainError(
        `the row source yielded sequence number ${row.sequence_number} after ${previousSeq}. ` +
          `The walk of Requirement 13.8 reads a Tenant's Audit_Events in strictly ascending ` +
          `sequence order`,
      );
    }
    // One Tenant per walk. The Tenant is the session's, and a result computed over a
    // mixture of Tenants would be meaningless rather than merely wrong.
    const rowTenant = String(row.tenant_id);
    tenantId ??= rowTenant;
    if (rowTenant !== tenantId) {
      throw new AuditChainError(
        `the row source yielded Audit_Events for more than one Tenant (${tenantId} and ` +
          `${rowTenant}). The verification walk is scoped to the session's Tenant ` +
          `(Requirement 14.1, 14.2)`,
      );
    }

    // Gap detection: the lowest sequence number that should exist and does not.
    if (firstGap === null && row.sequence_number !== expectedSeq) {
      firstGap = expectedSeq;
    }

    // Mismatch detection: recompute over stored fields and compare.
    if (firstMismatch === null && chainValue(row, prev) !== row.chain_value) {
      firstMismatch = row.sequence_number;
    }

    prev = CHAIN_VALUE_RE.test(row.chain_value) ? row.chain_value : INITIAL_CHAIN_VALUE;
    previousSeq = row.sequence_number;
    expectedSeq = row.sequence_number + 1n;
  }

  return Object.freeze({
    intact: firstMismatch === null && firstGap === null,
    first_mismatched_sequence_number: firstMismatch,
    first_absent_sequence_number: firstGap,
  });
}

/**
 * design.md's `AuditService.verifyChain`, minus the Tenant argument.
 *
 * Kept separate from `createAuditService` in `@/audit/audit-service` because the two
 * need different reads — the append path needs no `SELECT` at all — and because
 * nothing in the append path should be able to reach a verification walk. Task 26.1
 * composes them once an adapter exists.
 */
export function createChainVerifier(store: AuditChainStore): {
  verifyChain(): Promise<ChainVerification>;
} {
  return {
    verifyChain: async () => verifyChain(store.eventsAscendingBySequence()),
  };
}

/* -------------------------------------------------------------------------- */
/* The statement an adapter runs                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every Audit_Event of the session's Tenant in ascending sequence order, with exactly
 * the fields a Chain_Value is computed over plus the stored `chain_value`.
 *
 * No parameters, and no Tenant among them: `app.current_tenant_id()` scopes the read,
 * matching {@link AUDIT_EVENT_APPEND_SQL} and closing the same hole (Requirement
 * 14.1, 14.2). `audit_events_sequence_idx` covers `(tenant_id, sequence_number)`, so
 * the ordering is an index scan rather than a sort.
 *
 * Two columns are rendered rather than returned raw, for the reasons task 25.1 gives:
 * `sequence_number::text` so the `BIGINT` becomes a `BigInt(...)` and never a double,
 * and `occurred_at` through the same `to_char` expression the Chain_Value was hashed
 * over, so the walk recomputes from the bytes that were actually hashed rather than
 * from a rendering that may carry microseconds (FINDING 6(d) of migration 4.4).
 *
 * `prev_chain_value` is not selected. The walk chains from the preceding row's stored
 * `chain_value`, so reading it would invite the mistake of verifying a row against a
 * value stored on that same row.
 *
 * **An adapter must run `AUDIT_SESSION_TENANT_PROBE_SQL` first, and this is a
 * reported gap rather than something this statement can close.** With no session
 * claim `app.current_tenant_id()` is `NULL`, `tenant_id = NULL` matches nothing, and
 * {@link verifyChain} then walks zero rows and correctly reports `intact: true` —
 * because a Tenant with no Audit_Events genuinely has nothing mismatched and nothing
 * absent. That answer is right for the rows it saw and misleading for the caller, and
 * it cannot be fixed here: hardening the walk to reject an empty result would make a
 * newly provisioned Tenant unverifiable. The fix is the probe task 25.1 exports, run
 * before the walk, so "no session Tenant" is an authentication failure
 * (Requirement 14.4) rather than a clean verification. Requirement 14.10 additionally
 * wants that rejection audited, which belongs to task 26.x with the rest of the
 * privileged-access path.
 *
 * **Streaming is not addressed here.** This selects a Tenant's whole Audit_Log, which
 * for a Tenant near Requirement 13.9's 2555-day retention is large, and
 * {@link verifyChain} accepts an `AsyncIterable` precisely so an adapter can feed it a
 * cursor or keyset pages instead of one array. Requirement 13.8 states no page size
 * the way 13.6 states 100, so a chunked walk is an adapter decision at task 26.1
 * rather than something to invent here.
 */
export const AUDIT_CHAIN_WALK_SQL = `
SELECT e.tenant_id,
       e.sequence_number::text AS sequence_number,
       e.event_type,
       e.actor_kind,
       e.actor_id,
       e.stage,
       e.outcome,
       e.proposal_id,
       e.source_record_refs,
       e.payload,
       to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
       e.chain_value
  FROM audit_events e
 WHERE e.tenant_id = app.current_tenant_id()
 ORDER BY e.sequence_number`.trim();
