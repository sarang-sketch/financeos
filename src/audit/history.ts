/**
 * Audit_Log history retrieval — Source_Record history and Proposal stage history
 * (task 25.4, Requirement 13.6, 13.7).
 *
 * `./audit-service.ts` (task 25.1) owns the append and `./chain.ts` (task 25.2) owns
 * the Chain_Value and the verification walk. This module owns the two reads a User
 * asks for by name: **what happened to this Source_Record**, in pages of at most 100
 * ordered by ascending timestamp then ascending sequence number, and **how far did
 * this Proposal get**, as exactly one Audit_Event per completed Action_Pipeline stage
 * with the absent stages named as not completed.
 *
 * It follows task 25.2's shape exactly: the statements an adapter runs are exported
 * as text, the parameters are built by a function so an adapter cannot reorder them,
 * the reads sit behind an injectable store seam, and **no method takes a Tenant
 * identifier**.
 *
 * ## The Tenant is never a caller argument, in either direction
 *
 * design.md writes `sourceHistory(tenantId, ref, page)` and
 * `proposalHistory(tenantId, proposalId)`. Task 25.1 flagged that the session-bound
 * treatment it applies to `append` should apply to the read methods and left the
 * choice open; task 25.2 made it for `verifyChain`. **The same choice is made here,
 * for the same reason**: {@link AUDIT_SOURCE_HISTORY_SQL} and
 * {@link AUDIT_PROPOSAL_HISTORY_SQL} scope on `app.current_tenant_id()`,
 * {@link AuditHistoryStore} takes no Tenant argument, and the Tenant is read *off*
 * the rows so a row source that is not Tenant-scoped fails loudly. A Tenant
 * parameter on a history read is a parameter a caller could bend to read another
 * Tenant's Audit_Log, and Requirement 14.1, 14.2 and 14.7 exist to make that
 * unexpressible rather than merely discouraged.
 *
 * An adapter must still run `AUDIT_SESSION_TENANT_PROBE_SQL` first, for the reason
 * `AUDIT_CHAIN_WALK_SQL` documents: with no session claim `app.current_tenant_id()`
 * is `NULL`, `tenant_id = NULL` matches nothing, and an unauthenticated caller would
 * otherwise get a clean empty page rather than an authentication failure
 * (Requirement 14.4).
 *
 * ## Pagination is `Page<100>` from `@/tools/paging`, and the indicator is not a total
 *
 * Requirement 13.6 asks for two things — "pages of at most 100 Audit_Events" and
 * "an indicator of whether further Audit_Events remain" — and `@/tools/paging`
 * already declares the first as `Page<100>`: `{ offset, limit }` with `1 <= limit <=
 * 100`, bounds rejected rather than clamped. That module names
 * `AuditService.sourceHistory` as one of the five places design.md uses `Page<N>`
 * without declaring it, so this module consumes it rather than inventing a second
 * page shape.
 *
 * The indicator is a **boolean**, {@link SourceHistoryPage.further_events}, and not
 * `PagedRows.total`. Requirement 13.6 asks whether more remain, not how many exist,
 * and the difference is not cosmetic: a total over a Source_Record's history means a
 * `COUNT(*)` over the whole matched set on every page request, and a Tenant near
 * Requirement 13.9's 2555-day retention has an unbounded one. The indicator is
 * produced instead by asking the store for **one row more than the page**
 * ({@link auditSourceHistoryQuery}), which is the mechanism
 * `EvidenceSourcePageQuery` in `@/evidence/chain-builder` already uses: it
 * distinguishes "the page is full" from "more rows exist" with no second query and
 * with no trailing empty page.
 *
 * Offset paging, not keyset, because `Page<N>` is an offset page and because the
 * order here is already total — `(occurred_at, sequence_number)` with
 * `UNIQUE (tenant_id, sequence_number)` underneath it, so no Audit_Event can be
 * dropped or repeated between two pages of one unchanged Audit_Log. What an offset
 * page cannot promise is stability **across** appends, and for this table that is
 * narrower than usual but not empty: `occurred_at` is the caller-supplied instant
 * the recorded thing happened, so an append can land earlier in the order than a
 * page already served and shift every later window by one. `further_events` is
 * therefore honest about the set as it stood when the page was read, and nothing
 * here claims more.
 *
 * ## The order is `(occurred_at, sequence_number)`, and truncated to the millisecond
 *
 * Requirement 13.6: ascending timestamp, equal timestamps broken by ascending
 * Tenant-scoped sequence number. Requirement 13.1 pins `occurred_at` to UTC
 * millisecond precision and {@link assertAuditTimestamp} enforces it on the append,
 * so for every Audit_Event this system writes, "equal timestamps" is unambiguous.
 *
 * `audit_events.occurred_at` is nevertheless a `TIMESTAMPTZ`, which holds
 * microseconds, and the value a caller **sees** is the `to_char(... 'MS')` rendering
 * — which truncates. So `ORDER BY e.occurred_at` and the order the caller can verify
 * from the returned text are not the same order for a row that somehow carries
 * microseconds: two rows rendering the same millisecond would be ordered by their
 * hidden digits rather than by sequence number, and the page would violate 13.6 as
 * the caller can read it. {@link AUDIT_SOURCE_HISTORY_SQL} therefore orders by
 * `date_trunc('milliseconds', e.occurred_at)`, which is equal exactly when the
 * rendered text is equal, so the tie-break on sequence number applies to precisely
 * the ties 13.6 is talking about. {@link assertSourceHistoryOrder} then checks that
 * relation on the rows themselves rather than trusting it.
 *
 * **Reported: design.md's index set serves neither half of 13.6, and this is
 * measured rather than asserted.** `test/db/audit-history.test.ts` reads the plans:
 *
 * - `audit_events_source_refs_idx` is a GIN index over `source_record_refs`
 *   **alone**, with no `tenant_id`. It does serve the `@>` operator — the db test
 *   proves that with a bare containment query — but 13.6's read is always
 *   Tenant-scoped (Requirement 14.1, 14.2), and combining the two indexes needs a
 *   `BitmapAnd`. The planner instead takes a `tenant_id`-leading btree and applies
 *   the containment as a **Filter**, so the GIN index earns nothing for this read as
 *   specified.
 * - Nothing in the set orders by `occurred_at`, so the page is a sort over the
 *   matched set.
 *
 * Neither affects correctness: the predicate selects the same rows and the sort
 * produces the same order. The fixes are both index changes — a composite
 * `GIN (tenant_id, source_record_refs)` through `btree_gin`, and a
 * `(tenant_id, occurred_at, sequence_number)` btree — which is a migration, and
 * design.md's index list belongs to task 4.4.
 *
 * ## `proposalHistory` names the absent stages rather than omitting them
 *
 * Requirement 13.7 has two halves and the second is the one that is easy to lose:
 * exactly one Audit_Event per completed stage, **and** each of the 7 stages with no
 * Audit_Event identified as not completed. {@link StageHistory} therefore always
 * carries all 7 {@link ACTION_PIPELINE_STAGES} entries in Requirement 5.1's order,
 * each either completed with its Audit_Event or explicitly not completed, plus
 * {@link StageHistory.not_completed} as the list 13.7 asks for by name. A reader
 * cannot mistake "the pipeline stopped at PROPOSE" for "the last four events are
 * missing from this response".
 *
 * A stage counts as completed **iff an Audit_Event records it**, whatever the
 * outcome. Requirement 5.2 appends the event "WHEN an Agent completes an
 * Action_Pipeline stage" and records the outcome as succeeded, failed or blocked, so
 * a `failed` stage is a completed stage that failed — not an absent one. Treating
 * `failed` as not completed would erase the evidence of where a pipeline broke,
 * which is the opposite of what an Audit_Log is for.
 *
 * This is the seam property P8 (task 23.6) consumes: `stages` gives the completed
 * flags in stage order, so the "in-order prefix of the seven" claim is a read over
 * that array, and `events` gives the one-event-per-completed-stage sequence in
 * ascending sequence-number order. {@link stageHistoryFor} is pure and takes rows
 * directly, so P8 needs no store and no database.
 *
 * ## A repeated stage is reported, never silently collapsed
 *
 * Requirement 13.7 says *exactly* one Audit_Event per completed stage, and
 * Requirement 5.1's single ordered pass produces exactly that. A second Audit_Event
 * for a stage already recorded means a second pass over the same Proposal — a retry
 * after Requirement 5.17's execution failure is the reachable case, since it needs a
 * new Authorization and appends its own stage events under the same
 * `proposal_id`. 13.7 does not say which pass a reader gets.
 *
 * The decision here: the **lowest** sequence number wins, because "completed" is a
 * one-way fact and the earliest event is the one that established it, and every
 * later event for that stage is listed in
 * {@link StageHistory.repeated_stage_events} with its sequence number. So the
 * response satisfies 13.7 literally and loses no evidence.
 * `audit_events` is append-only (Requirement 13.5) — the extras cannot be deleted
 * and must not be hidden. **Reported as a design.md gap**, not resolved here: 13.7
 * needs to say whether a Proposal's stage history is per Proposal or per pipeline
 * pass, and if the latter, an Audit_Event needs a pass identifier that no column
 * currently holds.
 *
 * ## Scope
 *
 * Two reads. Nothing here writes — `audit_events` is append-only and a history read
 * is not a place to repair anything. Verification is `./chain.ts`; the rows this
 * module returns satisfy that module's `ChainedAuditEvent` structurally, so a caller
 * holding a page can recompute over it without a second read shape.
 */

import type { Actor, TenantId } from '@/config/configuration-service';
import type { SourceRef } from '@/ledger/posting-rules';
import { MAX_PAGE_SIZE_100, type Page, pageSchema } from '@/tools/paging';

import {
  ACTION_PIPELINE_STAGES,
  type ActionPipelineStage,
  assertAuditTimestamp,
  AUDIT_OUTCOMES,
  AUDIT_PAYLOAD_MAX_BYTES,
  type AuditEvent,
  type AuditOutcome,
  projectAuditSourceRefs,
} from './audit-service';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A history request that cannot be answered, or a row source that breaks this
 * module's contract.
 *
 * Never an empty result: a Source_Record with no Audit_Events and a Proposal with no
 * completed stages are both legitimate answers, returned as an empty page and as
 * seven not-completed stages respectively. This class is for the cases where there
 * is no answer to give — an out-of-range page, an identifier that is not one, a page
 * that arrived in the wrong order, or rows for a Tenant other than the session's.
 */
export class AuditHistoryError extends Error {
  override readonly name = 'AuditHistoryError';
}

/* -------------------------------------------------------------------------- */
/* Row mapping                                                                */
/* -------------------------------------------------------------------------- */

/** `audit_events.actor_kind`. Mirrors {@link Actor}'s `kind`, as task 25.1 does. */
const ACTOR_KINDS: readonly Actor['kind'][] = ['user', 'agent', 'policy_engine'];

/** 64 lower-case hex characters: `chain_value` / `prev_chain_value`. */
const CHAIN_VALUE_RE = /^[0-9a-f]{64}$/;

const DIGITS_RE = /^[0-9]+$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One `audit_events` row exactly as {@link AUDIT_SOURCE_HISTORY_SQL} and
 * {@link AUDIT_PROPOSAL_HISTORY_SQL} return it: the same 16 columns
 * `AUDIT_EVENT_APPEND_SQL` returns, so an appended Audit_Event and a read-back one
 * have one shape (Requirement 13.10).
 *
 * `sequence_number` is **digit text**, not a number, because the column is `BIGINT`
 * and a `BIGINT` that passes through a double has already lost the guarantee.
 * {@link auditEventFromRow} is the single place it becomes a `BigInt(...)`.
 */
export interface AuditEventRow {
  readonly id: string;
  readonly tenant_id: string;
  /** `sequence_number::text`. Digit text for `BigInt(...)`, never `Number(...)`. */
  readonly sequence_number: string;
  readonly event_type: string;
  readonly stage: string | null;
  readonly outcome: string | null;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly proposal_id: string | null;
  readonly source_record_refs: unknown;
  readonly payload: unknown;
  readonly payload_reduced: boolean;
  readonly payload_bytes: number;
  /** The `to_char(... 'MS')` rendering: `YYYY-MM-DDTHH:MM:SS.sssZ`. */
  readonly occurred_at: string;
  readonly chain_value: string;
  readonly prev_chain_value: string;
}

function fail(what: string, value: unknown, why: string): never {
  throw new AuditHistoryError(
    `the Audit_Event row's ${what} is ${JSON.stringify(value)}, which ${why}`,
  );
}

/**
 * A driver row as an {@link AuditEvent}, with every field held to what the append
 * path could have written.
 *
 * The one conversion is the `BIGINT`, and it is the reason this function exists
 * rather than a spread at each call site: `sequence_number` arrives as digit text
 * and becomes a `bigint` here, in one place, so no read path can accidentally reach
 * for `Number(...)`.
 *
 * The rest is validation, and it is deliberately strict. Every field is checked
 * against the same vocabulary `auditAppendPlan` enforces on the way in — the stage
 * and outcome enums, the actor kinds, a 64-hex Chain_Value pair, an ISO-8601
 * millisecond `occurred_at`, a JSON-object payload, `payload_bytes` within
 * Requirement 13.3's limit, and Source_Record references projected to exactly
 * `{ type, id }` through the same {@link projectAuditSourceRefs} the append used. A
 * row that fails any of these could not have been written by this service, so it is
 * a broken row source rather than an Audit_Event to hand on — and Requirement 13.10
 * promises a later read returns what was appended, which is a promise worth
 * checking rather than assuming.
 */
export function auditEventFromRow(row: AuditEventRow): AuditEvent {
  if (row === null || typeof row !== 'object') {
    throw new AuditHistoryError(
      `the row source yielded ${JSON.stringify(row)}; a history read reads audit_events rows`,
    );
  }
  if (typeof row.sequence_number !== 'string' || !DIGITS_RE.test(row.sequence_number)) {
    fail(
      'sequence_number',
      row.sequence_number,
      'is not digit text. audit_events.sequence_number is BIGINT: select it as ' +
        'sequence_number::text so it becomes BigInt(...) and never passes through a double',
    );
  }
  const sequenceNumber = BigInt(row.sequence_number);
  if (sequenceNumber < 1n) {
    fail('sequence_number', row.sequence_number, 'is below 1 (Requirement 13.1)');
  }
  if (typeof row.event_type !== 'string' || row.event_type.length === 0) {
    fail('event_type', row.event_type, 'is not a non-empty string');
  }
  if (row.stage !== null && !(ACTION_PIPELINE_STAGES as readonly string[]).includes(row.stage)) {
    fail(
      'stage',
      row.stage,
      `is not null and not one of the 7 Action_Pipeline stages (${ACTION_PIPELINE_STAGES.join(', ')})`,
    );
  }
  if (row.outcome !== null && !(AUDIT_OUTCOMES as readonly string[]).includes(row.outcome)) {
    fail('outcome', row.outcome, `is not null and not one of ${AUDIT_OUTCOMES.join(', ')}`);
  }
  if (!(ACTOR_KINDS as readonly string[]).includes(row.actor_kind)) {
    fail('actor_kind', row.actor_kind, `is not one of ${ACTOR_KINDS.join(', ')}`);
  }
  if (typeof row.actor_id !== 'string' || row.actor_id.length === 0) {
    fail('actor_id', row.actor_id, 'is not a non-empty identifier (Requirement 13.1)');
  }
  if (row.proposal_id !== null && (typeof row.proposal_id !== 'string' || !UUID_RE.test(row.proposal_id))) {
    fail('proposal_id', row.proposal_id, 'is neither null nor a UUID');
  }
  if (row.payload === null || typeof row.payload !== 'object' || Array.isArray(row.payload)) {
    fail('payload', row.payload, 'is not a JSON object; audit_events.payload is JSONB NOT NULL');
  }
  if (typeof row.payload_reduced !== 'boolean') {
    fail('payload_reduced', row.payload_reduced, "is not Requirement 13.3's boolean indicator");
  }
  if (!Number.isSafeInteger(row.payload_bytes) || row.payload_bytes < 0) {
    fail('payload_bytes', row.payload_bytes, 'is not a non-negative whole number');
  }
  if (row.payload_bytes > AUDIT_PAYLOAD_MAX_BYTES) {
    fail(
      'payload_bytes',
      row.payload_bytes,
      `is over Requirement 13.3's limit of ${AUDIT_PAYLOAD_MAX_BYTES}`,
    );
  }
  for (const [field, value] of [
    ['chain_value', row.chain_value],
    ['prev_chain_value', row.prev_chain_value],
  ] as const) {
    if (typeof value !== 'string' || !CHAIN_VALUE_RE.test(value)) {
      fail(field, value, "is not Requirement 13.4's 64-character lower-case hex SHA-256");
    }
  }

  return Object.freeze({
    id: row.id,
    tenant_id: row.tenant_id as TenantId,
    sequence_number: sequenceNumber,
    event_type: row.event_type,
    stage: row.stage as ActionPipelineStage | null,
    outcome: row.outcome as AuditOutcome | null,
    actor_kind: row.actor_kind as Actor['kind'],
    actor_id: row.actor_id,
    proposal_id: row.proposal_id,
    // The same projection the append applied, so a stored ref that the append could
    // not have written is rejected rather than passed on (Requirement 13.2).
    source_record_refs: projectAuditSourceRefs(row.source_record_refs as readonly SourceRef[]),
    payload: row.payload as Readonly<Record<string, unknown>>,
    payload_reduced: row.payload_reduced,
    payload_bytes: row.payload_bytes,
    occurred_at: assertAuditTimestamp(row.occurred_at),
    chain_value: row.chain_value,
    prev_chain_value: row.prev_chain_value,
  });
}

/** Every row of a driver result as {@link AuditEvent}s, in the order returned. */
export function auditEventsFromRows(rows: readonly AuditEventRow[]): readonly AuditEvent[] {
  if (!Array.isArray(rows)) {
    throw new AuditHistoryError(`a history read expects an array of rows, got ${JSON.stringify(rows)}`);
  }
  return rows.map(auditEventFromRow);
}

/* -------------------------------------------------------------------------- */
/* Source_Record history (Requirement 13.6)                                   */
/* -------------------------------------------------------------------------- */

/** Requirement 13.6's ceiling, which is `@/tools/paging`'s `Page<100>`. */
export const MAX_SOURCE_HISTORY_PAGE_SIZE = MAX_PAGE_SIZE_100;

/** design.md's `Page<100>` on `sourceHistory`, named for readability at call sites. */
export type SourceHistoryPageRequest = Page<typeof MAX_SOURCE_HISTORY_PAGE_SIZE>;

/**
 * One page request as the store receives it.
 *
 * `limit` is the requested page size **plus one** — see
 * {@link auditSourceHistoryQuery}. The page a caller gets back is still capped at
 * {@link MAX_SOURCE_HISTORY_PAGE_SIZE}.
 *
 * No Tenant field: `AUDIT_SOURCE_HISTORY_SQL` scopes on `app.current_tenant_id()`.
 */
export interface AuditSourceHistoryQuery {
  /** Projected to exactly `{ type, id }`, which is how a Source_Record is referenced. */
  readonly ref: SourceRef;
  readonly offset: number;
  /** The page size plus one, so "page full" and "more remain" are distinguishable. */
  readonly limit: number;
}

/**
 * Validate a page request and turn it into the query the store runs.
 *
 * The bounds come from `pageSchema(100)`: `offset >= 0`, `1 <= limit <= 100`, and out
 * of range is a **rejection naming the field**, never a clamp — a caller that asked
 * for 500 Audit_Events of a 100-Audit_Event page asked a question 13.6 does not
 * define, and answering a different one silently is worse than refusing.
 *
 * The `+ 1` is the further-events indicator's whole mechanism, and it is applied here
 * rather than in the service so an adapter reading `AuditSourceHistoryQuery.limit`
 * knows the number it sees is deliberate and may be 101.
 */
export function auditSourceHistoryQuery(
  ref: SourceRef,
  page: SourceHistoryPageRequest,
): AuditSourceHistoryQuery {
  const parsed = pageSchema(MAX_SOURCE_HISTORY_PAGE_SIZE).safeParse(page);
  if (!parsed.success) {
    throw new AuditHistoryError(
      `the page request is not a Page<${MAX_SOURCE_HISTORY_PAGE_SIZE}> ` +
        `(Requirement 13.6: pages of at most ${MAX_SOURCE_HISTORY_PAGE_SIZE} Audit_Events): ` +
        parsed.error.issues
          .map((issue) => `${['page', ...issue.path].join('.')} ${issue.message}`)
          .join('; '),
    );
  }
  const [projected] = projectAuditSourceRefs([ref]);
  if (projected === undefined) {
    throw new AuditHistoryError('sourceHistory requires one Source_Record reference');
  }
  return Object.freeze({
    ref: projected,
    offset: parsed.data.offset,
    limit: parsed.data.limit + 1,
  });
}

/**
 * The 3 parameters of {@link AUDIT_SOURCE_HISTORY_SQL}, in order.
 *
 * `offset` and `limit` cross as digit text so the tuple is uniform for a driver that
 * binds text parameters, and because it costs nothing: both are plain `int` in SQL,
 * bounded by `pageSchema` well inside a double, so unlike `sequence_number` there is
 * no precision question either way.
 */
export type AuditSourceHistoryParams = readonly [refJson: string, offset: string, limit: string];

/**
 * {@link AUDIT_SOURCE_HISTORY_SQL}'s parameters, from a validated query.
 *
 * `$1` is a **single-element JSON array**, because the statement matches with
 * `source_record_refs @> $1::jsonb` and `source_record_refs` is an array: array
 * containment holds when some element of the stored array contains the sought
 * object, which is exactly "Audit_Events referencing that Source_Record"
 * (Requirement 13.6). Object key order is irrelevant to `@>`, so the projection's
 * `{ type, id }` matches a stored `{ id, type }`.
 */
export function auditSourceHistoryParams(query: AuditSourceHistoryQuery): AuditSourceHistoryParams {
  return [
    JSON.stringify([{ type: query.ref.type, id: query.ref.id }]),
    String(query.offset),
    String(query.limit),
  ];
}

/**
 * One page of a Source_Record's history (Requirement 13.6).
 *
 * `page_size` is the size that was **requested**, so a short page is legible: with
 * `page_size` 100 and 7 events and `further_events` false, the caller is at the end
 * of the history rather than looking at a truncated response.
 */
export interface SourceHistoryPage {
  /** The Source_Record asked about, projected to `{ type, id }`. */
  readonly ref: SourceRef;
  readonly offset: number;
  /** The requested page size, `1..100`. Never the number of rows returned. */
  readonly page_size: number;
  /** At most `page_size`, ascending by timestamp then by sequence number. */
  readonly events: readonly AuditEvent[];
  /** Requirement 13.6's indicator: Audit_Events remain after this page. */
  readonly further_events: boolean;
}

/**
 * Hold a page to Requirement 13.6's order, and throw rather than re-sort.
 *
 * A locally applied sort would be the wrong repair: the page was sliced by `OFFSET`
 * under the statement's `ORDER BY`, so if that order was not 13.6's order then this
 * is the wrong *window* of the history, and sorting the rows it happens to contain
 * would hide that behind a page that looks well formed. A mis-ordered row source is a
 * broken row source — the same stance `verifyChain` takes on a non-ascending walk.
 *
 * The comparison is on the rendered `occurred_at`, which is fixed-width
 * `YYYY-MM-DDTHH:MM:SS.sssZ`, so lexicographic order is chronological order and no
 * `Date` parse is needed. That is also precisely the equality the statement's
 * `date_trunc('milliseconds', ...)` produces, so the tie-break on `sequence_number`
 * is checked against the same notion of "equal timestamps" the caller can see.
 */
export function assertSourceHistoryOrder(events: readonly AuditEvent[]): readonly AuditEvent[] {
  for (let i = 1; i < events.length; i += 1) {
    const previous = events[i - 1];
    const current = events[i];
    if (previous === undefined || current === undefined) {
      continue;
    }
    if (current.occurred_at < previous.occurred_at) {
      throw new AuditHistoryError(
        `the row source yielded ${current.occurred_at} after ${previous.occurred_at}. ` +
          `Requirement 13.6 orders a Source_Record's history by ascending timestamp`,
      );
    }
    if (
      current.occurred_at === previous.occurred_at &&
      current.sequence_number <= previous.sequence_number
    ) {
      throw new AuditHistoryError(
        `the row source yielded sequence number ${current.sequence_number} after ` +
          `${previous.sequence_number} at the same timestamp ${current.occurred_at}. ` +
          `Requirement 13.6 breaks equal timestamps by ascending Tenant-scoped sequence number`,
      );
    }
  }
  return events;
}

/**
 * Hold every row to one Tenant, the session's, and report the Tenant it saw.
 *
 * The statements scope on `app.current_tenant_id()`, so a mixture can only come from
 * a row source that is not Tenant-scoped, and a history page assembled over more than
 * one Tenant would be a Requirement 14.7 violation delivered as a normal-looking
 * answer. Task 25.2's walk guards itself the same way and for the same reason.
 */
function assertOneTenant(events: readonly AuditEvent[], what: string): void {
  let tenantId: string | null = null;
  for (const event of events) {
    tenantId ??= event.tenant_id;
    if (event.tenant_id !== tenantId) {
      throw new AuditHistoryError(
        `${what} yielded Audit_Events for more than one Tenant (${tenantId} and ` +
          `${event.tenant_id}). A history read is scoped to the session's Tenant ` +
          `(Requirement 14.1, 14.2, 14.7)`,
      );
    }
  }
}

/** Whether `event` references `ref` — the predicate `source_record_refs @> $1` states. */
function referencesRef(event: AuditEvent, ref: SourceRef): boolean {
  return event.source_record_refs.some(
    (stored) => stored.type === ref.type && stored.id === ref.id,
  );
}

/**
 * Assemble a page from the rows a store returned (Requirement 13.6).
 *
 * Pure, so this is also the seam a caller with rows already in hand uses. `rows` is
 * what {@link AuditSourceHistoryQuery} asked for — at most `page.limit + 1` — and the
 * extra row is consumed here: it sets `further_events` and is then dropped, so the
 * returned page never exceeds the requested size and there is no trailing empty page
 * at the end of a history whose length is an exact multiple of the page size.
 *
 * Three post-conditions, each on a claim the statement makes that a store could break
 * without saying so: every event references the Source_Record asked about, every event
 * belongs to one Tenant, and the order is 13.6's.
 */
export function sourceHistoryPageFor(
  ref: SourceRef,
  page: SourceHistoryPageRequest,
  rows: readonly AuditEvent[],
): SourceHistoryPage {
  const query = auditSourceHistoryQuery(ref, page);
  const pageSize = query.limit - 1;
  if (!Array.isArray(rows)) {
    throw new AuditHistoryError(
      `sourceHistory expects an array of Audit_Events, got ${JSON.stringify(rows)}`,
    );
  }
  if (rows.length > query.limit) {
    throw new AuditHistoryError(
      `the row source yielded ${rows.length} Audit_Events for a page of ${pageSize} with one ` +
        `look-ahead row; at most ${query.limit} were requested (Requirement 13.6)`,
    );
  }
  assertOneTenant(rows, 'sourceHistory');
  assertSourceHistoryOrder(rows);
  for (const event of rows) {
    if (!referencesRef(event, query.ref)) {
      throw new AuditHistoryError(
        `Audit_Event ${event.sequence_number} does not reference ` +
          `${query.ref.type}:${query.ref.id}, so it is not part of that Source_Record's history ` +
          `(Requirement 13.6). Its references are ${JSON.stringify(event.source_record_refs)}`,
      );
    }
  }

  return Object.freeze({
    ref: query.ref,
    offset: query.offset,
    page_size: pageSize,
    events: Object.freeze(rows.slice(0, pageSize)),
    further_events: rows.length > pageSize,
  });
}

/* -------------------------------------------------------------------------- */
/* Proposal stage history (Requirement 13.7)                                  */
/* -------------------------------------------------------------------------- */

/** One of the 7 Action_Pipeline stages, and what the Audit_Log says about it. */
export interface StageHistoryEntry {
  readonly stage: ActionPipelineStage;
  /** An Audit_Event records this stage. `false` is Requirement 13.7's "not completed". */
  readonly completed: boolean;
  /** The one Audit_Event for this stage, or `null` exactly when `completed` is false. */
  readonly event: AuditEvent | null;
}

/** A stage Audit_Event beyond the first for its stage. See the module doc comment. */
export interface RepeatedStageEvent {
  readonly stage: ActionPipelineStage;
  readonly sequence_number: bigint;
}

/**
 * design.md's `StageHistory`, declared here because design.md names it and never
 * declares it — the same gap `@/tools/paging` closed for `Page<N>`.
 *
 * Both halves of Requirement 13.7 are structural rather than conventional: `stages`
 * always has all 7 entries in Requirement 5.1's order so an absent stage is named
 * rather than missing, and `events` holds exactly one Audit_Event per completed stage
 * in ascending sequence-number order.
 */
export interface StageHistory {
  readonly proposal_id: string;
  /** All 7, in DETECT..VERIFY order. */
  readonly stages: readonly StageHistoryEntry[];
  /** Exactly one per completed stage, ascending by sequence number. */
  readonly events: readonly AuditEvent[];
  /** The stages with no Audit_Event: Requirement 13.7's "not completed", by name. */
  readonly not_completed: readonly ActionPipelineStage[];
  /**
   * Stage Audit_Events beyond the first for their stage — a second pipeline pass over
   * the same Proposal. Empty for a Proposal that ran once, which is Requirement 5.1's
   * shape. Reported rather than dropped: `audit_events` is append-only.
   */
  readonly repeated_stage_events: readonly RepeatedStageEvent[];
}

/** Requirement 13.7 resolves a stage history by Proposal identifier, which is a UUID. */
function assertProposalId(proposalId: string): string {
  if (typeof proposalId !== 'string' || !UUID_RE.test(proposalId)) {
    throw new AuditHistoryError(
      `proposalId must be a UUID; audit_events.proposal_id is UUID REFERENCES proposals(id). ` +
        `Got ${JSON.stringify(proposalId)}`,
    );
  }
  return proposalId;
}

/**
 * Build a Proposal's stage history from its stage Audit_Events (Requirement 13.7).
 *
 * Pure and store-free, which is what makes it the seam property P8 (task 23.6)
 * consumes: P8 generates stage event sequences and reads `stages` and `events` back.
 *
 * `events` must be the Proposal's stage Audit_Events in **ascending sequence-number
 * order**, which is what {@link AUDIT_PROPOSAL_HISTORY_SQL} returns. Four things are
 * rejected rather than tolerated, all of them broken row sources rather than history
 * anomalies:
 *
 * - a non-ascending sequence number, for the reason `verifyChain` rejects one: with
 *   `UNIQUE (tenant_id, sequence_number)` and an `ORDER BY`, it is unreachable from a
 *   real query, and 13.7's ordering claim cannot be checked against a source that
 *   does not honour it;
 * - an Audit_Event with `stage: null`. A non-stage Audit_Event citing the Proposal —
 *   an approval, an Approval_Window expiry (Requirement 5.16) — is outside 13.7,
 *   which speaks only of completed Action_Pipeline stages, and the statement filters
 *   it out. Silently ignoring one here would make a caller that passed the wrong rows
 *   believe it got a stage history;
 * - an Audit_Event for a different Proposal;
 * - Audit_Events for more than one Tenant.
 */
export function stageHistoryFor(
  proposalId: string,
  events: readonly AuditEvent[],
): StageHistory {
  const id = assertProposalId(proposalId);
  if (!Array.isArray(events)) {
    throw new AuditHistoryError(
      `proposalHistory expects an array of Audit_Events, got ${JSON.stringify(events)}`,
    );
  }
  assertOneTenant(events, 'proposalHistory');

  const first = new Map<ActionPipelineStage, AuditEvent>();
  const repeated: RepeatedStageEvent[] = [];
  let previousSeq: bigint | null = null;

  for (const event of events) {
    if (previousSeq !== null && event.sequence_number <= previousSeq) {
      throw new AuditHistoryError(
        `the row source yielded sequence number ${event.sequence_number} after ${previousSeq}. ` +
          `Requirement 13.7 orders a Proposal's stage history by ascending Tenant-scoped ` +
          `sequence number`,
      );
    }
    previousSeq = event.sequence_number;

    if (event.stage === null) {
      throw new AuditHistoryError(
        `Audit_Event ${event.sequence_number} (${event.event_type}) records no Action_Pipeline ` +
          `stage. Requirement 13.7 reports one Audit_Event per completed stage, so a non-stage ` +
          `Audit_Event citing the Proposal is outside it`,
      );
    }
    if (event.proposal_id !== id) {
      throw new AuditHistoryError(
        `Audit_Event ${event.sequence_number} cites Proposal ${JSON.stringify(event.proposal_id)}, ` +
          `not ${id}. Requirement 13.7 resolves a stage history by Proposal identifier`,
      );
    }

    // Lowest sequence number wins: "completed" is a one-way fact and the earliest
    // Audit_Event is the one that established it. The rest are reported, not dropped.
    if (first.has(event.stage)) {
      repeated.push(Object.freeze({ stage: event.stage, sequence_number: event.sequence_number }));
    } else {
      first.set(event.stage, event);
    }
  }

  const stages = ACTION_PIPELINE_STAGES.map((stage) => {
    const event = first.get(stage) ?? null;
    return Object.freeze({ stage, completed: event !== null, event });
  });

  return Object.freeze({
    proposal_id: id,
    stages: Object.freeze(stages),
    // Ascending by sequence number, which is the input order minus the repeats.
    events: Object.freeze(
      [...first.values()].sort((a, b) => (a.sequence_number < b.sequence_number ? -1 : 1)),
    ),
    not_completed: Object.freeze(
      ACTION_PIPELINE_STAGES.filter((stage) => !first.has(stage)),
    ),
    repeated_stage_events: Object.freeze(repeated),
  });
}

/* -------------------------------------------------------------------------- */
/* The statements an adapter runs                                             */
/* -------------------------------------------------------------------------- */

/**
 * The 16 columns of an `audit_events` row, rendered exactly as
 * `AUDIT_EVENT_APPEND_SQL` renders them.
 *
 * Shared between the two statements below so they cannot drift apart, and identical
 * to the append's projection so an appended Audit_Event and a read-back one are one
 * shape — which is what makes Requirement 13.10 ("the same sequence number, the same
 * timestamp, the same actor identifier, the same event payload, and the same
 * Chain_Value") checkable by comparing two values rather than two shapes.
 *
 * The two rendered columns are rendered for task 25.1's reasons:
 * `sequence_number::text` so the `BIGINT` becomes a `BigInt(...)` and never a double,
 * and `occurred_at` through the same `to_char` expression the Chain_Value was hashed
 * over, so a page can be handed to `./chain.ts` without a second read.
 */
const AUDIT_EVENT_COLUMNS = `e.id,
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
       e.prev_chain_value`;

/**
 * One page of the Audit_Events referencing a Source_Record, ordered by ascending
 * timestamp then ascending sequence number (Requirement 13.6).
 *
 * Parameters, in {@link auditSourceHistoryParams} order:
 * `($1 single-element refs array as jsonb, $2 offset, $3 limit)`.
 *
 * **No Tenant parameter**: `app.current_tenant_id()` scopes the read, matching
 * `AUDIT_EVENT_APPEND_SQL` and `AUDIT_CHAIN_WALK_SQL` (Requirement 14.1, 14.2). An
 * adapter runs `AUDIT_SESSION_TENANT_PROBE_SQL` first, so an unscoped read is an
 * authentication failure rather than an empty page.
 *
 * `source_record_refs @> $1::jsonb` is array containment: it holds when some element
 * of the stored array contains the sought `{ type, id }` object, which is exactly
 * "the Audit_Events referencing that Source_Record". `$3` is the page size plus one,
 * so the page and the further-events indicator come from one query. See the module
 * doc comment for why `audit_events_source_refs_idx` does not end up serving this
 * read, and what would.
 *
 * `date_trunc('milliseconds', e.occurred_at)` rather than `e.occurred_at` in the
 * `ORDER BY`: the caller sees the `to_char(... 'MS')` rendering, which truncates, so
 * the truncated value is the one whose ties Requirement 13.6 breaks by sequence
 * number. Ordering by the raw `TIMESTAMPTZ` would order two rows rendering the same
 * millisecond by hidden microseconds, and the page would then violate 13.6 as the
 * caller can read it. It costs no index: nothing in design.md's index set orders by
 * `occurred_at`, so this is a sort over the matched set either way.
 */
export const AUDIT_SOURCE_HISTORY_SQL = `
SELECT ${AUDIT_EVENT_COLUMNS}
  FROM audit_events e
 WHERE e.tenant_id = app.current_tenant_id()
   AND e.source_record_refs @> $1::jsonb
 ORDER BY date_trunc('milliseconds', e.occurred_at), e.sequence_number
 OFFSET $2::int
 LIMIT $3::int`.trim();

/**
 * Every stage Audit_Event of one Proposal, ascending by sequence number
 * (Requirement 13.7).
 *
 * Parameter: `($1 proposal_id)`. No Tenant parameter, for the same reason as above,
 * and the Tenant is still in the predicate so `audit_events_proposal_idx`
 * — `(tenant_id, proposal_id, sequence_number)` — serves both the filter and the
 * order.
 *
 * `e.stage IS NOT NULL` because Requirement 13.7 speaks only of completed
 * Action_Pipeline stages. A non-stage Audit_Event citing the same Proposal — an
 * approval, an Approval_Window expiry (Requirement 5.16), a rejected mutation
 * (Requirement 13.5) — is a real part of that Proposal's record and is **not**
 * reported here. That is a scope statement rather than a claim they do not exist: a
 * full per-Proposal timeline is not something 13.6 or 13.7 asks for, and inventing
 * one would be a design.md addition.
 *
 * **No `LIMIT`.** Requirement 13.7 states no page size the way 13.6 states 100, and
 * the result is bounded by construction: Requirement 5.1 runs 7 stages once, so a
 * Proposal that ran once yields 7 rows and a retried one a small multiple of that.
 */
export const AUDIT_PROPOSAL_HISTORY_SQL = `
SELECT ${AUDIT_EVENT_COLUMNS}
  FROM audit_events e
 WHERE e.tenant_id = app.current_tenant_id()
   AND e.proposal_id = $1::uuid
   AND e.stage IS NOT NULL
 ORDER BY e.sequence_number`.trim();

/** The single parameter of {@link AUDIT_PROPOSAL_HISTORY_SQL}. */
export type AuditProposalHistoryParams = readonly [proposalId: string];

/** {@link AUDIT_PROPOSAL_HISTORY_SQL}'s parameter, validated. */
export function auditProposalHistoryParams(proposalId: string): AuditProposalHistoryParams {
  return [assertProposalId(proposalId)];
}

/* -------------------------------------------------------------------------- */
/* Persistence seam                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The two reads history retrieval needs, behind an injectable seam.
 *
 * **No method takes a Tenant identifier** (Requirement 14.1, 14.2), exactly as
 * `AuditChainStore.eventsAscendingBySequence` takes none: an implementation runs the
 * statements above, which scope on the session's Tenant.
 *
 * An implementation returns rows in the order its statement produced them and does no
 * slicing of its own — {@link sourceHistoryPageFor} consumes the look-ahead row, and
 * an adapter that dropped it would silently make `further_events` always false.
 */
export interface AuditHistoryStore {
  /** At most `query.limit` rows, ascending by truncated timestamp then sequence number. */
  sourceHistory(query: AuditSourceHistoryQuery): Promise<readonly AuditEvent[]>;
  /** Every stage Audit_Event of the Proposal, ascending by sequence number. */
  proposalStageEvents(proposalId: string): Promise<readonly AuditEvent[]>;
}

/* -------------------------------------------------------------------------- */
/* The service                                                                */
/* -------------------------------------------------------------------------- */

/**
 * design.md's `AuditService` read methods, minus the Tenant argument.
 *
 * Kept in its own module and its own factory for the reason `createChainVerifier` is:
 * the append path needs no `SELECT` at all, and nothing in it should be able to reach
 * a history read. Task 26.1 composes append, verification and history over one
 * adapter.
 */
export interface AuditHistoryService {
  /** One page of a Source_Record's history (Requirement 13.6). */
  sourceHistory(ref: SourceRef, page: SourceHistoryPageRequest): Promise<SourceHistoryPage>;
  /** A Proposal's 7 stages, completed or not (Requirement 13.7). */
  proposalHistory(proposalId: string): Promise<StageHistory>;
}

export function createAuditHistory(store: AuditHistoryStore): AuditHistoryService {
  return {
    async sourceHistory(
      ref: SourceRef,
      page: SourceHistoryPageRequest,
    ): Promise<SourceHistoryPage> {
      // Validated before the store is touched, so an out-of-range page opens no
      // connection (the stance `@/tools/paging` takes for the Financial_Tool arguments).
      const query = auditSourceHistoryQuery(ref, page);
      return sourceHistoryPageFor(query.ref, page, await store.sourceHistory(query));
    },

    async proposalHistory(proposalId: string): Promise<StageHistory> {
      const id = assertProposalId(proposalId);
      return stageHistoryFor(id, await store.proposalStageEvents(id));
    },
  };
}
