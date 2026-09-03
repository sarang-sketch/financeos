/**
 * Approval_Window expiry for the FinanceOS_Action_Service (task 23.5).
 * Requirement 5.16.
 *
 * One sentence of requirement, transcribed rather than improved on:
 *
 * > **5.16** — IF a Proposal holding the require-approval decision receives neither
 * > approval nor rejection within the Approval_Window, which is an integer from 1 hour to
 * > 168 hours and defaults to 24 hours, THEN THE FinanceOS_Action_Service SHALL mark the
 * > Proposal as expired, SHALL withhold execution permanently for that Proposal, and SHALL
 * > append an Audit_Event recording the expiry with the elapsed wait time.
 *
 * design.md gives it one signature — `expireOverdue(tenantId): Promise<string[]>  //
 * scheduled sweep` — and one row of the error table: *"Scheduled `expireOverdue` sweep
 * against `approval_deadline`… Audit_Event `proposal_expired` with the elapsed wait time…
 * Execution withheld **permanently** for that Proposal; a new Proposal is required; no
 * Tenant state change."*
 *
 * ## The thin slice, in design.md's own order
 *
 * design.md marks this thin-sliceable: *"the Approval_Window expiry sweep (5.16) can start
 * as a query-time check before it becomes a scheduled job"*. So the module is built in that
 * order and both halves ship, because the second is the first in a loop:
 *
 * 1. **The query-time check** — {@link approvalWindowElapsed} and {@link elapsedWaitFor} are
 *    pure, and {@link expireIfOverdue} expires **one** Proposal when whoever is looking at
 *    it (the approval queue of task 27.1, an API read, the approval path itself) finds its
 *    deadline past. Nothing schedules it: the check happens where the Proposal is already
 *    being loaded.
 * 2. **The sweep** — {@link expireOverdueProposals} asks
 *    {@link OVERDUE_PROPOSALS_SQL} for the Proposals whose deadline is past and applies step
 *    1 to each. It adds a query and a batch bound and nothing else; the expiry rule, the
 *    guard, the elapsed wait and the Audit_Event are one implementation shared by both
 *    entry points, so a query-time expiry and a swept expiry cannot disagree about what
 *    expiring means.
 *
 * ## Why this is a fourth file rather than more of `./action-service.ts`
 *
 * Task 23.1's module doc makes a checkable claim: *"this file imports no ledger, no Razorpay
 * client and no Exception writer, which is what makes Requirement 5.10's 'no change to
 * Tenant state' checkable by reading the import list rather than by trusting a comment."*
 * This module imports the FinanceOS_Audit_Service, which writes. Task 23.2 added
 * `./execute-authorized.ts` and task 23.3 added `./verify-execution.ts` one module further
 * out for exactly that reason; this is the same move a third time. Nothing here duplicates
 * approval, rejection, execution or verification: `ActionServiceError`,
 * `requireIdentifier` and the `proposal_state` vocabulary are imported.
 *
 * Task 23.1 deferred this deliberately and said so — its FINDING 3 refuses a late approval
 * with `approval_window_elapsed` and **no write at all**, leaving the Proposal in
 * `awaiting_approval` "for 23.5's sweep to mark `expired`". That is the row this module
 * picks up, and its rule for lateness is the same one, to the millisecond: a decision or a
 * check **exactly at** the deadline is inside the window, and only `at > deadline` is
 * outside it. `checks.ts`'s approval requirement check draws the boundary the same way. One
 * boundary, three modules, no restatement.
 *
 * ## "Withholds execution permanently" is already structural — this module adds no check
 *
 * Requirement 5.16's second clause needs no code here, and saying why is better than adding
 * a redundant guard that would suggest it did:
 *
 * - task 23.2's `EXECUTABLE_STATES` is `['authorized']` and nothing else, and its
 *   `PROPOSAL_EXECUTED_SQL` carries `AND state = 'authorized'` in the `WHERE` clause, so an
 *   `expired` Proposal is refused with `not_authorized_for_execution` in TypeScript and
 *   refused again by the database if a caller somehow reached the statement;
 * - task 23.1's `USER_DECIDABLE_STATES` is `['awaiting_approval']` and nothing else, so an
 *   `expired` Proposal cannot be approved, which is the only route by which a User could
 *   move one to `authorized`;
 * - `authorizeProposal` in `decide.ts` writes no state at all (its FINDING 3), so a
 *   re-evaluation cannot lift an expired Proposal out of `expired` either.
 *
 * `expired` therefore has no outgoing edge to `authorized`, and `authorized` is the only
 * state an execution starts from. Permanence is the **absence** of a transition rather than
 * a flag, which is the same kind of evidence 23.1 offers for Requirement 5.8. See FINDING 3
 * for the one place that shape is weaker than it looks, which is reported and not patched.
 *
 * ## The elapsed wait is a duration, and it is measured rather than described
 *
 * {@link ElapsedWait} carries two figures, both computed from instants **stored on the row**
 * and the instant of expiry, so neither depends on a configuration value that may have
 * changed since the deadline was set:
 *
 * - `elapsed_wait_ms` — `expired_at − created_at`. Requirement 5.16's "elapsed wait time":
 *   how long the Proposal stood with no approval and no rejection.
 * - `overdue_ms` — `expired_at − approval_deadline`. How late the check or the sweep was,
 *   which is what tells a query-time expiry (usually seconds past the deadline) from a
 *   scheduled one, and what a reader needs before believing the first figure is the whole
 *   wait.
 *
 * Both are **integer milliseconds**. A duration is not money: it does not go through
 * `Paise`, `toWire` or the `paise` domain, and putting it there would claim a monetary
 * meaning it does not have. Equally, nothing monetary goes through this module's arithmetic
 * — the Proposal's `impact_paise` is not read, not selected by either statement and not
 * carried on the Audit_Event, so there is no monetary value here for a float to damage. The
 * millisecond figures are checked with `Number.isSafeInteger`, and they are integers by
 * construction because `Date.parse` returns integer milliseconds; a wait of 168 hours is
 * 604800000 ms, nine digits, so the exact-integer range of a double is not remotely in
 * question.
 *
 * ## The order of the two writes, and why it inverts task 23.3's
 *
 * The state transition is written **first** and the Audit_Event second. Task 23.3 does the
 * opposite for the Exception, and the reasoning is the same reasoning reaching a different
 * answer, so both are stated:
 *
 * - 23.3's Exception upsert is **idempotent by fingerprint**, so writing it first risks only
 *   a repeat that lands on the same row.
 * - An Audit_Event append is **not** idempotent and cannot be made so: it allocates a
 *   sequence number and extends the Chain_Value (Requirement 13.1, 13.4), and the Audit_Log
 *   refuses update and delete (Requirement 13.5). A second attempt appends a second event.
 *
 * So appending first would risk an **immutable** Audit_Event asserting an expiry that then
 * did not happen — the guard declines because a User approved in the interval — and nothing
 * in this system can retract it. Transitioning first risks an `expired` Proposal whose
 * Audit_Event is missing, which is at least **detectable**: `state = 'expired'` with no
 * `proposal_expired` event for that Proposal is a discrepancy anyone holding both tables can
 * see. A false record is worse than a missing one, so the append happens only after the
 * guarded `UPDATE` has said the expiry really occurred, and an append failure
 * **propagates** rather than being swallowed (FINDING 2).
 *
 * ## FINDINGS — reported, not silently patched
 *
 * 1. **Nothing stamps the instant a Proposal entered `awaiting_approval`, so the elapsed
 *    wait is measured from `created_at`.** `proposals` carries `created_at`,
 *    `approval_deadline`, `executed_at` and `verified_at`, and no column for the instant the
 *    Approval_Window started. The two candidates were:
 *    - `created_at`, which is what {@link elapsedWaitFor} uses. It overstates the wait by
 *      however long the DETECT..AUTHORIZE stages took, which is the Policy_Engine's
 *      10-second evaluation bound at worst (Requirement 5.3) against a window of at least an
 *      hour.
 *    - `approval_deadline` minus the Approval_Window. Exact when the configured window is
 *      still the one the deadline was computed from, and **silently wrong** the moment a
 *      User changes `approval_window_hours` — which Requirement 5.15's permission gate makes
 *      an expected thing to happen, not a hypothetical.
 *    A figure that is off by seconds and always off in the same direction beats one that is
 *    exact until a configuration change makes it arbitrary. The fix is a column
 *    (`awaiting_approval_since`) written by the same statement that sets the deadline, which
 *    is a migration and therefore above this task. `elapsed_wait_ms` is reported alongside
 *    `awaited_since` so a reader can see which instant it was measured from rather than
 *    having to assume.
 * 2. **A crash between the transition and the append leaves an expired Proposal with no
 *    Audit_Event, and this module cannot close that window.** The two writes are separate
 *    statements because there is no multi-statement adapter in this project — the same
 *    constraint task 25.1 records for its counter-row seed — so they commit separately.
 *    Requirement 5.16 wants both. The append failure propagates so the caller hears about
 *    it, and the sweep stops rather than expiring the rest silently; the ids it had already
 *    expired are on their rows. The permanent fix is one transaction around both, which
 *    means a SQL function like `app.append_audit_event`'s neighbours, and that is a
 *    migration.
 * 3. **`PROPOSAL_STATE_TRANSITION_SQL` (task 23.1) can write any state from any state.** The
 *    permanence argument above rests on every *caller* passing a narrow `from` list, not on
 *    the statement refusing. Today both callers do (`approveProposal` and `rejectProposal`
 *    pass `USER_DECIDABLE_STATES`), and every other transition in the Action_Service is a
 *    dedicated statement with its state as a literal and its guard baked in —
 *    `PROPOSAL_EXECUTED_SQL`, `PROPOSAL_VERIFIED_SQL`,
 *    `PROPOSAL_VERIFICATION_FAILED_SQL`, and {@link PROPOSAL_EXPIRED_SQL} here. So the
 *    generic one is the single statement through which a future caller could move an
 *    `expired` Proposal to `authorized`. Narrowing it is a change to task 23.1's published
 *    contract and to its tests, so it is **escalated rather than done here**.
 * 4. **`expireOverdue`'s Tenant argument is dropped, as everywhere else in this service.**
 *    design.md types it `expireOverdue(tenantId)`; every statement here scopes on
 *    `tenant_id = $1` bound by the **adapter's own session** Tenant, and no method of
 *    {@link ApprovalWindowStore} takes a Tenant identifier (Requirement 12.7, 14.1). A
 *    Tenant parameter would be a parameter a caller could bend, which is exactly what 12.7
 *    forbids. `createApprovalWindowExpiry` therefore exposes `expireOverdue()`, the same
 *    divergence `createChainVerifier` documents for `verifyChain(tenantId)`.
 * 5. **No `actor_kind` names the Action_Service's scheduled sweep.** `audit_events.actor_kind`
 *    is CHECKed `IN ('user', 'agent', 'policy_engine')` and both columns are `NOT NULL`, and
 *    an expiry is performed by no User and no Agent. {@link ExpiryDeps.actor} is therefore a
 *    **required** dependency the caller binds rather than a value invented here: a scheduler
 *    naming itself is at least true about who ran, whereas a hardcoded `policy_engine` would
 *    put this service's write under another component's name. Migration 4.4's own FINDING 5
 *    records the same gap for its rejected-mutation event. A `system` actor kind is a
 *    design.md decision.
 * 6. **The Audit_Event is a non-stage event.** `stage` is `null` and so is `outcome`, because
 *    an expiry is not the completion of one of Requirement 5.1's seven stages: the Proposal
 *    never got past AUTHORIZE, and stamping `stage: 'AUTHORIZE', outcome: 'blocked'` would
 *    put a completed AUTHORIZE stage in Requirement 13.7's stage history for a Proposal that
 *    was abandoned. `src/audit/history.ts` already anticipates this exact event as a
 *    non-stage one ("an approval, an Approval_Window expiry (Requirement 5.16)"), and
 *    design.md's error table names the event `proposal_expired` without naming a stage,
 *    unlike every neighbouring row. `auditAppendPlan` requires an `outcome` only where a
 *    `stage` is set, so this is expressible as it stands.
 * 7. **A first Audit_Event for a Tenant with no `audit_sequence_counters` row cannot be
 *    appended**, which would mean an expiry that transitions and then fails to record
 *    (FINDING 2). That is task 25.1's known gap, and it already owns the workaround:
 *    an {@link AuditService} implementation runs `AUDIT_SEQUENCE_COUNTER_SEED_SQL` before
 *    every append. Nothing is re-derived here — this module names the obligation and
 *    depends on the seam that carries it. `app.append_audit_event_autonomous` is not an
 *    option: it fails with `dblink_connect` → `2F003`, so the append is on the caller's own
 *    connection, which is also why the append can fail as part of this operation rather than
 *    beside it.
 *
 * ## The other half: who writes `approval_deadline`
 *
 * Nobody did, and without it nothing can ever expire. `decide.ts` says so explicitly —
 * *"neither is `approval_deadline`, which needs the Approval_Window of Requirement 5.16 and
 * belongs to the FinanceOS_Action_Service (task 23.1, 23.5)"* — and task 23.1 wrote no
 * deadline either: its FINDING 4 refuses an `awaiting_approval` Proposal with a NULL
 * `approval_deadline` and says *"whoever moves a Proposal into `awaiting_approval` (task
 * 23.5's other half, or the AUTHORIZE stage) owes it a deadline"*. This is that other half:
 * {@link approvalDeadlineFrom} computes it and {@link PROPOSAL_AWAITING_APPROVAL_SQL} writes
 * it in the same update as `state = 'awaiting_approval'`, so the state that starts the
 * Approval_Window and the instant it ends cannot be written apart.
 *
 * The 1..168-hour bound is `checks.ts`'s ({@link APPROVAL_WINDOW_MIN_HOURS},
 * {@link APPROVAL_WINDOW_MAX_HOURS}), imported rather than restated. The default of 24 hours
 * is the **Configuration_Service's** and stays there: `tenant_configuration`'s
 * `approval_window_hours` declares `default: 24`, so a resolved configuration always carries
 * a lawful number and {@link approvalDeadlineFrom} raises on anything else instead of
 * defaulting a second time in a second place.
 */

import type { Actor, TenantId } from '@/config/configuration-service';
import {
  auditTimestamp,
  type AuditEventDraft,
  type AuditService,
} from '@/audit/audit-service';
import {
  APPROVAL_WINDOW_MAX_HOURS,
  APPROVAL_WINDOW_MIN_HOURS,
  PROPOSAL_STATES,
  type ProposalState,
} from '@/policy/checks';

import { ActionServiceError, requireIdentifier } from './action-service';

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The only `proposal_state` an Approval_Window can elapse from.
 *
 * `awaiting_approval` **is** the state that holds the require-approval decision
 * (Requirement 5.7, 5.8), which is Requirement 5.16's subject. Every other label is refused
 * with a reason and no write:
 *
 * - `proposed`, `blocked` — no require-approval decision stands, so no window is running.
 *   `blocked` is retained for re-evaluation (Requirement 5.5); expiring it would discard a
 *   Proposal the Policy_Engine is still allowed to be asked about again.
 * - `authorized`, `executed`, `verified`, `verification_failed`, `execution_failed` — the
 *   window was answered and the Proposal moved on. Expiring an executed Proposal would say
 *   its effect was withheld when it was applied.
 * - `rejected` — a User answered inside the window (Requirement 5.10). An expiry would
 *   overwrite the record of who decided with "nobody did".
 * - `expired` — already expired. A second expiry would append a second Audit_Event for one
 *   condition and report a longer wait than the one that actually elapsed.
 */
export const EXPIRABLE_STATES: readonly ProposalState[] = ['awaiting_approval'];

/**
 * `audit_events.event_type` for the expiry, verbatim from design.md's error table:
 * *"Audit_Event `proposal_expired` with the elapsed wait time"*.
 */
export const PROPOSAL_EXPIRED_EVENT_TYPE = 'proposal_expired';

/** One hour in milliseconds. The Approval_Window is configured in hours (Requirement 5.16). */
export const HOUR_MS = 3_600_000;

/**
 * How many overdue Proposals one sweep pass expires.
 *
 * Neither requirements.md nor design.md states a batch size, so this is a **bound chosen
 * here** rather than a specification: an unbounded sweep over a Tenant that has been
 * unattended for a week would hold one connection for an unbounded number of appends, and
 * every append is a row lock on that Tenant's audit sequence counter (Requirement 13.1).
 * A pass is safe to repeat — {@link OVERDUE_PROPOSALS_SQL} answers with what is *still*
 * `awaiting_approval` and past its deadline — so a backlog drains over consecutive passes
 * rather than needing one long transaction. Overridable per call.
 */
export const EXPIRY_SWEEP_BATCH = 100;

/**
 * Why a Proposal was not expired. None of these is an expiry that failed: nothing was
 * written and no Audit_Event was appended.
 *
 * - `proposal_absent` — no such Proposal for this Tenant. A foreign row is an absent row,
 *   never an error that would confirm its existence (Requirement 14.4).
 * - `not_awaiting_approval` — the Proposal holds no require-approval decision. See
 *   {@link EXPIRABLE_STATES}.
 * - `approval_deadline_absent` — `awaiting_approval` with a NULL `approval_deadline`. Task
 *   23.1's FINDING 4 refuses a decision on such a Proposal and `checks.ts` fails the
 *   approval requirement check on it; it cannot be expired either, because there is no
 *   window for it to be outside of. Such a row is **stuck**, and that is the point of
 *   writing the deadline and the state together
 *   ({@link PROPOSAL_AWAITING_APPROVAL_SQL}).
 * - `within_approval_window` — the deadline has not passed. The window is still the User's.
 * - `decided_concurrently` — the guarded `UPDATE` matched no row, so between the load and
 *   the transition the Proposal was approved, rejected or expired by someone else. The
 *   racing writer won and this pass wrote nothing, which is what the guard is for.
 */
export const NOT_EXPIRED_REASONS = [
  'proposal_absent',
  'not_awaiting_approval',
  'approval_deadline_absent',
  'within_approval_window',
  'decided_concurrently',
] as const;

export type NotExpiredReason = (typeof NOT_EXPIRED_REASONS)[number];

/* -------------------------------------------------------------------------- */
/* The elapsed wait                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Requirement 5.16's "elapsed wait time", as two measured durations and the three instants
 * they were measured between.
 *
 * A duration, not money: integer milliseconds, never `Paise`, never the `paise` domain,
 * never a float. See the module doc comment, and FINDING 1 for why `awaited_since` is
 * `created_at`.
 */
export interface ElapsedWait {
  /** `proposals.created_at`. The earliest instant the row evidences (FINDING 1). */
  readonly awaited_since: string;
  /** `proposals.approval_deadline`, the end of the Approval_Window. */
  readonly approval_deadline: string;
  /** The instant the expiry was recorded. ISO-8601 UTC. */
  readonly expired_at: string;
  /** `expired_at − awaited_since`, integer milliseconds. Requirement 5.16's figure. */
  readonly elapsed_wait_ms: number;
  /** `expired_at − approval_deadline`, integer milliseconds. How late the expiry was. */
  readonly overdue_ms: number;
}

/** A parseable instant, or a fault naming the field. Narrows away a NULL column. */
function requireInstant(value: string | null | undefined, what: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ActionServiceError(
      `${what} is ${JSON.stringify(value)}, which is not an ISO-8601 instant; Requirement ` +
        `5.16's elapsed wait is measured between instants, and a figure derived from an ` +
        `unparseable one would be a number with no meaning`,
    );
  }
  return value;
}

/** An instant as integer milliseconds, or a fault naming the field. */
function instantMs(value: string | null | undefined, what: string): number {
  return Date.parse(requireInstant(value, what));
}

/** A duration that is a non-negative safe integer of milliseconds, or a fault. */
function durationMs(fromMs: number, toMs: number, what: string): number {
  const ms = toMs - fromMs;
  if (ms < 0 || !Number.isSafeInteger(ms)) {
    throw new ActionServiceError(
      `${what} works out to ${ms} ms, which is not a non-negative duration; the clock moved ` +
        `backwards between the two instants, and absorbing that would report an elapsed wait ` +
        `nobody waited (Requirement 5.16)`,
    );
  }
  return ms;
}

/**
 * Whether the Approval_Window has elapsed by `at`. **Pure** — no store, no clock.
 *
 * Strictly after: a Proposal is overdue only where `at > approval_deadline`, so an instant
 * exactly on the deadline is **inside** the window. That is the same boundary task 23.1's
 * `refusalFor` applies to a late decision (`at > deadline`) and the same one `checks.ts`'s
 * approval requirement check applies to a recorded approval, so a decision arriving on the
 * last millisecond is admissible and the Proposal is not simultaneously expirable.
 *
 * Exported so the approval queue (task 27.1) can render "expired" from the same expression
 * that expires, rather than from a second, slightly different comparison.
 *
 * @throws {ActionServiceError} for an unparseable deadline.
 */
export function approvalWindowElapsed(approvalDeadline: string, at: Date): boolean {
  return at.getTime() > instantMs(approvalDeadline, 'proposals.approval_deadline');
}

/**
 * `approval_deadline` for an Approval_Window of `hours` starting at `from`: ISO-8601 UTC.
 *
 * The other half of this task — see the module doc comment. Exported so whoever moves a
 * Proposal into `awaiting_approval` computes the deadline the same way this module measures
 * against it.
 *
 * @throws {ActionServiceError} for a window outside 1..168 hours or not an integer
 * (Requirement 5.16), and for a `from` that is not an instant. Not defaulted: the default of
 * 24 hours belongs to the Configuration_Service, whose `approval_window_hours` column
 * declares it, and a second default here would be a second place for it to drift.
 */
export function approvalDeadlineFrom(hours: number, from: Date): string {
  if (
    !Number.isInteger(hours) ||
    hours < APPROVAL_WINDOW_MIN_HOURS ||
    hours > APPROVAL_WINDOW_MAX_HOURS
  ) {
    throw new ActionServiceError(
      `the Approval_Window must be an integer from ${APPROVAL_WINDOW_MIN_HOURS} to ` +
        `${APPROVAL_WINDOW_MAX_HOURS} hours (Requirement 5.16), got ${JSON.stringify(hours)}; ` +
        `the Configuration_Service resolves it and defaults it to 24, so an unlawful value ` +
        `here is a caller fault rather than a value to substitute`,
    );
  }
  const startMs = from.getTime();
  if (!Number.isFinite(startMs)) {
    throw new ActionServiceError(
      'the Approval_Window must start at a valid Date; got an Invalid Date, which has no ' +
        'ISO-8601 form and no deadline',
    );
  }
  return new Date(startMs + hours * HOUR_MS).toISOString();
}

/**
 * Requirement 5.16's elapsed wait for one Proposal. **Pure.**
 *
 * @throws {ActionServiceError} for an unparseable `created_at` or `approval_deadline`, or for
 * an `expiredAt` before either of them — a clock that moved backwards, reported rather than
 * absorbed for the same reason `verificationWindowElapsed` reports it.
 */
export function elapsedWaitFor(
  snapshot: Pick<ProposalExpirySnapshot, 'created_at' | 'approval_deadline'>,
  expiredAt: string,
): ElapsedWait {
  const createdAt = requireInstant(snapshot.created_at, 'proposals.created_at');
  const deadline = requireInstant(snapshot.approval_deadline, 'proposals.approval_deadline');
  const createdMs = Date.parse(createdAt);
  const deadlineMs = Date.parse(deadline);
  const expiredMs = instantMs(expiredAt, 'the instant of expiry');

  return {
    awaited_since: createdAt,
    approval_deadline: deadline,
    expired_at: expiredAt,
    elapsed_wait_ms: durationMs(createdMs, expiredMs, 'the elapsed wait'),
    overdue_ms: durationMs(deadlineMs, expiredMs, 'the overdue interval'),
  };
}

/* -------------------------------------------------------------------------- */
/* Outcomes                                                                   */
/* -------------------------------------------------------------------------- */

/** One Proposal expired: the state transition and the Audit_Event both landed. */
export interface ExpiredOutcome {
  readonly kind: 'expired';
  readonly proposal_id: string;
  /** ISO-8601 UTC, millisecond precision — the same instant on the row and on the event. */
  readonly expired_at: string;
  readonly elapsed_wait: ElapsedWait;
  /**
   * The Audit_Event's sequence number, as proof the record exists rather than as a claim
   * that it does (Requirement 5.16, 13.1). `bigint`, because the column is `BIGINT`.
   */
  readonly audit_sequence_number: bigint;
}

/** No expiry, and why. Nothing was written and no Audit_Event was appended. */
export interface NotExpiredOutcome {
  readonly kind: 'not_expired';
  readonly proposal_id: string;
  readonly reason: NotExpiredReason;
  /** Human-readable, and always present: a User reads this on the Proposal. */
  readonly detail: string;
  /** The state the Proposal was found in, where it resolved. */
  readonly state?: ProposalState;
  /** How much of the Approval_Window is left, where the window is still running. */
  readonly remaining_ms?: number;
}

export type ExpiryOutcome = ExpiredOutcome | NotExpiredOutcome;

/* -------------------------------------------------------------------------- */
/* Seams                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One Proposal as the expiry check needs it.
 *
 * Deliberately narrower than task 23.1's `ActionProposalSnapshot`: an expiry re-evaluates no
 * Policy_Check, computes no risk score and reads no money, so it asks for none of those and
 * cannot be mistaken for something that does. `created_at` is the field the siblings' load
 * statements do not select — see FINDING 1.
 */
export interface ProposalExpirySnapshot {
  readonly proposal_id: string;
  readonly state: ProposalState;
  /** `proposals.approval_deadline`. `null` is FINDING 4 of task 23.1: unanswerable. */
  readonly approval_deadline: string | null;
  /** `proposals.created_at`, `NOT NULL` in the schema. ISO-8601 UTC. */
  readonly created_at: string;
}

/**
 * The two reads and one write the expiry needs.
 *
 * Implemented by an adapter that binds the session Tenant at construction — **no method
 * takes a tenant id** (Requirement 12.7, 14.1, FINDING 4) — and a foreign Proposal reads
 * back as `null` rather than as an error that would confirm it exists (Requirement 14.4).
 */
export interface ApprovalWindowStore {
  /** {@link PROPOSAL_EXPIRY_LOAD_SQL}. `null` when the Proposal does not resolve. */
  loadForExpiry(proposalId: string): Promise<ProposalExpirySnapshot | null>;
  /**
   * {@link OVERDUE_PROPOSALS_SQL}. At most `limit` rows, oldest deadline first.
   *
   * The sweep's candidate list only. Every row it returns is checked again by the pure rule
   * and again by {@link markExpired}'s guard, so a store that widened its `WHERE` clause
   * cannot expire a Proposal that is not overdue.
   */
  overdueProposals(at: string, limit: number): Promise<readonly ProposalExpirySnapshot[]>;
  /**
   * {@link PROPOSAL_EXPIRED_SQL}. `true` where the guarded `UPDATE` matched a row, `false`
   * where it matched none.
   *
   * The one store method in the Action_Service that reports a no-op instead of throwing on
   * it, and the reason is that here a no-op is an **expected** outcome rather than a fault:
   * a User approving or rejecting between the load and the update is the Approval_Window
   * working, not a broken write. The distinction matters because the Audit_Event is appended
   * only for a `true` — an event for a transition that did not happen cannot be retracted
   * (see the module doc comment).
   */
  markExpired(proposalId: string, expiredAt: string): Promise<boolean>;
}

/** Everything the expiry reaches outside itself. */
export interface ExpiryDeps {
  readonly store: ApprovalWindowStore;
  /**
   * The FinanceOS_Audit_Service's append path (`createAuditService`), bound to the session
   * Tenant. Requirement 5.16's third clause. Appends on the caller's own connection, because
   * `app.append_audit_event_autonomous` fails with `2F003` (FINDING 7).
   */
  readonly audit: Pick<AuditService, 'append'>;
  /** Who ran the expiry. Required, and not invented here — see FINDING 5. */
  readonly actor: Actor;
  /** Injectable clock, so the boundary and `expired_at` are assertable. */
  readonly now?: () => Date;
}

/** design.md's `expireOverdue`, less the Tenant argument (FINDING 4). */
export interface ApprovalWindowExpiry {
  /** The identifiers of the Proposals this pass expired, in the order it expired them. */
  expireOverdue(limit?: number): Promise<readonly string[]>;
  /** The query-time half: expire this one Proposal if its Approval_Window has elapsed. */
  expireIfOverdue(proposalId: string): Promise<ExpiryOutcome>;
}

/* -------------------------------------------------------------------------- */
/* The statements an adapter runs                                             */
/* -------------------------------------------------------------------------- */

/**
 * One Proposal for the query-time check. Parameters: `($1 tenant_id, $2 proposal_id)`.
 *
 * Four columns, and no `impact_paise`: an expiry compares instants and writes a state, so
 * selecting a monetary figure would suggest it reasoned about one. `created_at` is here and
 * in no sibling load statement (FINDING 1).
 *
 * `to_char` is not used for the two timestamps: unlike an Audit_Event's `occurred_at`, whose
 * exact text is hashed into the Chain_Value, these are read to be compared as instants, and
 * an adapter that hands over whatever its driver renders is free to as long as it is
 * parseable — {@link instantMs} is where that is enforced.
 */
export const PROPOSAL_EXPIRY_LOAD_SQL = `
SELECT id,
       state,
       approval_deadline,
       created_at
  FROM proposals
 WHERE tenant_id = $1
   AND id = $2::uuid`.trim();

/** The parameter tuple {@link PROPOSAL_EXPIRY_LOAD_SQL} expects, in order. */
export function proposalExpiryLoadParams(
  tenantId: TenantId,
  proposalId: string,
): readonly [TenantId, string] {
  return [tenantId, proposalId];
}

/**
 * The sweep's candidates: Proposals whose Approval_Window has elapsed. Parameters:
 * `($1 tenant_id, $2 at, $3 limit)`.
 *
 * The `WHERE` clause is Requirement 5.16's condition and nothing else — the state that holds
 * the require-approval decision, a deadline that exists, and `approval_deadline < $2`, which
 * is the strict boundary the pure rule uses so an instant exactly on the deadline is not
 * swept.
 *
 * `ORDER BY approval_deadline, id` makes the pass deterministic: the longest-overdue Proposal
 * is expired first, and the tie-break on `id` means two passes over the same backlog take the
 * same rows in the same order rather than an arbitrary slice each. `LIMIT $3` is the batch
 * bound of {@link EXPIRY_SWEEP_BATCH}, and it is safe precisely because the predicate is
 * self-clearing: an expired Proposal is no longer `awaiting_approval`, so it cannot be
 * returned twice.
 *
 * `FOR UPDATE` is deliberately absent. The candidate list is advisory — {@link
 * PROPOSAL_EXPIRED_SQL} re-checks every clause of it under its own guard — so holding row
 * locks across an unbounded number of Audit_Event appends would serialize the sweep against
 * the Users it exists to protect, for no additional guarantee.
 */
export const OVERDUE_PROPOSALS_SQL = `
SELECT id,
       state,
       approval_deadline,
       created_at
  FROM proposals
 WHERE tenant_id = $1
   AND state = 'awaiting_approval'
   AND approval_deadline IS NOT NULL
   AND approval_deadline < $2::timestamptz
 ORDER BY approval_deadline, id
 LIMIT $3`.trim();

/** The parameter tuple {@link OVERDUE_PROPOSALS_SQL} expects, in order. */
export function overdueProposalsParams(
  tenantId: TenantId,
  at: string,
  limit: number,
): readonly [TenantId, string, number] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ActionServiceError(
      `the sweep batch bound must be a positive integer, got ${JSON.stringify(limit)}`,
    );
  }
  return [tenantId, at, limit];
}

/**
 * Requirement 5.16's transition. Parameters: `($1 tenant_id, $2 proposal_id, $3 at)`.
 *
 * Four things about it are load-bearing:
 *
 * - **`state` is the literal `'expired'`**, so this statement cannot be bent into task 23.2's
 *   `executed`, task 23.3's two verification labels or task 23.4's `execution_failed`. It is
 *   also the reason the permanence argument holds: there is no statement in the
 *   Action_Service that moves `expired` anywhere.
 * - **`AND state = 'awaiting_approval'`** is the guard and the concurrency control. A User
 *   approving or rejecting in the interval wins, and a second sweep pass over the same
 *   Proposal matches nothing, so exactly one expiry can be recorded.
 * - **`AND approval_deadline < $3::timestamptz`** puts the *whole* of Requirement 5.16's
 *   condition in the database rather than only in TypeScript. A caller that miscomputed the
 *   boundary, or one that passed an instant inside the window, matches no row: a Proposal
 *   whose window is still open cannot be expired through this statement at all.
 * - **`RETURNING id, state, approval_deadline`** is how an adapter tells a real transition
 *   from a silent no-op. Unlike its siblings the adapter must **not** throw on the no-op —
 *   see {@link ApprovalWindowStore.markExpired} — it must report it, because the Audit_Event
 *   is appended only for a real transition.
 *
 * No other column is written. There is no `expired_at` column and none is invented here: the
 * instant of expiry is on the Audit_Event, where Requirement 5.16 puts it. `executed_at`,
 * `verified_at`, `observed_paise` and `difference_paise` stay NULL, which is the row-level
 * form of "execution withheld" — an expired Proposal carries no execution instant and no
 * figures because nothing was applied. That is also why `DUPLICATE_BLOCKING_STATES` in
 * `checks.ts` excludes `expired`: a later Proposal for the same targets is not a duplicate of
 * an action that never happened, and this statement's leaving those columns NULL is the same
 * fact from the storage side.
 */
export const PROPOSAL_EXPIRED_SQL = `
UPDATE proposals
   SET state = 'expired'
 WHERE tenant_id = $1
   AND id = $2::uuid
   AND state = 'awaiting_approval'
   AND approval_deadline IS NOT NULL
   AND approval_deadline < $3::timestamptz
RETURNING id, state, approval_deadline`.trim();

/** The parameter tuple {@link PROPOSAL_EXPIRED_SQL} expects, in order. */
export function proposalExpiredParams(
  tenantId: TenantId,
  proposalId: string,
  at: string,
): readonly [TenantId, string, string] {
  return [tenantId, proposalId, at];
}

/**
 * The transition that **starts** an Approval_Window, deadline and all. Parameters:
 * `($1 tenant_id, $2 proposal_id, $3 approval_deadline, $4 from states text[])`.
 *
 * The other half of this task — see the module doc comment for why it was nobody's until now.
 *
 * - **`state` is the literal `'awaiting_approval'` and `approval_deadline` moves with it.**
 *   That pairing is the whole point: an `awaiting_approval` row with a NULL deadline is
 *   unanswerable (task 23.1's FINDING 4 refuses a decision on it, `checks.ts` fails its
 *   approval requirement check, and this module cannot expire it), so the two columns are
 *   written by one statement and no statement writes either alone.
 * - **`$4` is the guard**, and unlike the states list of task 23.1's generic transition it is
 *   passed as a list because a Proposal reaches this state from two places: `proposed`, on a
 *   first evaluation that returns require-approval (Requirement 5.7), and `blocked`, on a
 *   re-evaluation of a Proposal Requirement 5.5 retained. {@link APPROVAL_WINDOW_FROM_STATES}
 *   is that list, and passing it explicitly means a caller cannot re-open a window on an
 *   `expired`, `rejected` or `executed` Proposal.
 * - **`RETURNING id, state, approval_deadline`** so an adapter can tell a real transition
 *   from a no-op and throw on the latter: a Proposal the Policy_Engine has decided needs
 *   approval, whose row still says `proposed`, is invisible to the approval queue.
 *
 * `$3` is computed by {@link approvalDeadlineFrom} rather than as `now() + interval` in SQL,
 * so the deadline and the expiry boundary come from one expression in one place, and a test
 * can inject the clock for both.
 */
export const PROPOSAL_AWAITING_APPROVAL_SQL = `
UPDATE proposals
   SET state = 'awaiting_approval',
       approval_deadline = $3::timestamptz
 WHERE tenant_id = $1
   AND id = $2::uuid
   AND state = ANY($4::proposal_state[])
RETURNING id, state, approval_deadline`.trim();

/**
 * The states a Proposal may enter `awaiting_approval` from.
 *
 * `proposed` is the first evaluation's (Requirement 5.7). `blocked` is a re-evaluation's:
 * Requirement 5.5 retains a blocked Proposal for re-evaluation, and an evaluation that now
 * passes all six checks above the threshold returns require-approval, which is exactly what
 * `proposalStateForDecision('require_approval')` maps to. Nothing else: `authorized` and
 * beyond have been answered, and `rejected` and `expired` are final.
 */
export const APPROVAL_WINDOW_FROM_STATES: readonly ProposalState[] = ['proposed', 'blocked'];

/** The parameter tuple {@link PROPOSAL_AWAITING_APPROVAL_SQL} expects, in order. */
export function proposalAwaitingApprovalParams(
  tenantId: TenantId,
  proposalId: string,
  approvalDeadline: string,
  from: readonly ProposalState[] = APPROVAL_WINDOW_FROM_STATES,
): readonly [TenantId, string, string, readonly ProposalState[]] {
  return [tenantId, proposalId, approvalDeadline, from];
}

/* -------------------------------------------------------------------------- */
/* Requirement 5.16's Audit_Event — pure                                      */
/* -------------------------------------------------------------------------- */

/**
 * Requirement 5.16's Audit_Event, as an {@link AuditEventDraft}. **Pure** — no store, no
 * clock — so what the event says is assertable without a database.
 *
 * Every clause of the requirement and of design.md's error table is one line of it:
 *
 * - **`proposal_expired`** — design.md's event type, verbatim
 *   ({@link PROPOSAL_EXPIRED_EVENT_TYPE}).
 * - **recording the expiry** — `proposalId` is a first-class column of `audit_events`
 *   (Requirement 13.1), so the Proposal is named by the row rather than only inside the
 *   payload, and `proposal_state: 'expired'` records what it was marked.
 * - **with the elapsed wait time** — `elapsed_wait_ms` and `overdue_ms` as integer
 *   milliseconds, alongside the three instants they were measured between so a reader can
 *   check the arithmetic rather than trust it.
 * - **withholds execution permanently** — `execution_withheld: 'permanently'`, and the rule
 *   text that makes it so, because an Audit_Log entry that records a consequence should say
 *   which rule produced it.
 *
 * `stage` and `outcome` are both `null`: an expiry completes no Action_Pipeline stage
 * (FINDING 6). No `sourceRefs`: Requirement 5.16 attaches none, and Requirement 13.2 wants
 * payloads carrying no Source_Record field content — the Proposal's targets are on the
 * Proposal, reachable from the identifier this event carries.
 *
 * **No monetary value.** The payload has no paise field, no `impact_paise` and no figure a
 * float could damage; the two numbers in it are durations in milliseconds.
 */
export function proposalExpiredEvent(
  proposalId: string,
  elapsed: ElapsedWait,
  actor: Actor,
): AuditEventDraft {
  return {
    eventType: PROPOSAL_EXPIRED_EVENT_TYPE,
    actor,
    stage: null,
    outcome: null,
    proposalId,
    payload: {
      proposal_state: 'expired',
      awaited_since: elapsed.awaited_since,
      approval_deadline: elapsed.approval_deadline,
      expired_at: elapsed.expired_at,
      elapsed_wait_ms: elapsed.elapsed_wait_ms,
      overdue_ms: elapsed.overdue_ms,
      elapsed_wait_measured_from: 'proposals.created_at',
      execution_withheld: 'permanently',
      failing_rule:
        'Requirement 5.16: a Proposal holding the require-approval decision that receives ' +
        'neither approval nor rejection within the Approval_Window is marked expired and its ' +
        'execution is withheld permanently; a new Proposal is required',
    },
    occurredAt: auditTimestamp(new Date(elapsed.expired_at)),
  };
}

/* -------------------------------------------------------------------------- */
/* The query-time check (thin slice 1)                                        */
/* -------------------------------------------------------------------------- */

function notExpired(
  proposalId: string,
  reason: NotExpiredReason,
  detail: string,
  extra: Pick<NotExpiredOutcome, 'state' | 'remaining_ms'> = {},
): NotExpiredOutcome {
  return {
    kind: 'not_expired',
    proposal_id: proposalId,
    reason,
    detail,
    ...(extra.state === undefined ? {} : { state: extra.state }),
    ...(extra.remaining_ms === undefined ? {} : { remaining_ms: extra.remaining_ms }),
  };
}

/**
 * Why this Proposal may not be expired at `at`, or `null` where it may. **Pure**: no store,
 * no clock, no audit sink.
 *
 * Exported because it is the whole of Requirement 5.16's condition, and a rule that decides
 * whether a Proposal is discarded should be testable without a database behind it. The
 * sweep, the query-time check and the approval queue all read the same answer from it.
 *
 * @throws {ActionServiceError} for a stored `state` that is not a `proposal_state` label, or
 * for an unparseable `approval_deadline`. Both are corrupt rows rather than Proposals an
 * expiry can be refused *about* — the same distinction all three siblings draw.
 */
export function expiryRefusalFor(
  snapshot: ProposalExpirySnapshot,
  at: Date,
): NotExpiredOutcome | null {
  if (!(PROPOSAL_STATES as readonly string[]).includes(snapshot.state)) {
    throw new ActionServiceError(
      `the stored proposal_state ${JSON.stringify(snapshot.state)} is not one of ` +
        `${PROPOSAL_STATES.join(', ')}`,
    );
  }

  if (!EXPIRABLE_STATES.includes(snapshot.state)) {
    return notExpired(
      snapshot.proposal_id,
      'not_awaiting_approval',
      `the Proposal is ${snapshot.state}, so no Approval_Window is running over it; an expiry ` +
        `is admissible only from ${EXPIRABLE_STATES.join(', ')} (Requirement 5.7, 5.8, 5.16)`,
      { state: snapshot.state },
    );
  }

  if (snapshot.approval_deadline === null || snapshot.approval_deadline === undefined) {
    return notExpired(
      snapshot.proposal_id,
      'approval_deadline_absent',
      'the Proposal is awaiting approval but carries no approval_deadline, so there is no ' +
        'Approval_Window for it to be outside of; it can be neither decided (task 23.1) nor ' +
        'expired, and whoever moved it into awaiting_approval owed it a deadline ' +
        '(PROPOSAL_AWAITING_APPROVAL_SQL writes the two together for exactly this reason)',
      { state: snapshot.state },
    );
  }

  if (!approvalWindowElapsed(snapshot.approval_deadline, at)) {
    const remaining = durationMs(
      at.getTime(),
      instantMs(snapshot.approval_deadline, 'proposals.approval_deadline'),
      'the remaining Approval_Window',
    );
    return notExpired(
      snapshot.proposal_id,
      'within_approval_window',
      `the Approval_Window runs to ${snapshot.approval_deadline} and ${at.toISOString()} is ` +
        `not past it, so the decision is still the User's to make (Requirement 5.16)`,
      { state: snapshot.state, remaining_ms: remaining },
    );
  }

  return null;
}

/**
 * The query-time half of Requirement 5.16: expire **this** Proposal if its Approval_Window
 * has elapsed.
 *
 * design.md marks the sweep thin-sliceable behind exactly this — "a query-time check before
 * it becomes a scheduled job" — and it is also the whole of the sweep's per-Proposal work.
 * In order: resolve the Proposal, apply the pure rule, transition under the guard, and append
 * Requirement 5.16's Audit_Event **only** where the transition really happened. Every refusal
 * returns a {@link NotExpiredOutcome} having written nothing.
 *
 * @throws {ActionServiceError} for an empty identifier, a corrupt `state`, an unparseable
 * instant, or a clock reading before the Proposal's own instants — faults rather than
 * verdicts.
 * @throws whatever the store or the Audit_Service raises. An append failure propagates: an
 * expiry with no Audit_Event does not satisfy Requirement 5.16, and reporting it as a tidy
 * success would hide FINDING 2 rather than surface it.
 */
export async function expireIfOverdue(
  proposalId: string,
  deps: ExpiryDeps,
): Promise<ExpiryOutcome> {
  const proposal = requireIdentifier(proposalId, 'proposal_id');
  const now = deps.now ?? ((): Date => new Date());

  const snapshot = await deps.store.loadForExpiry(proposal);
  if (snapshot === null) {
    return notExpired(
      proposal,
      'proposal_absent',
      'no Proposal with that identifier resolves for this Tenant, so there is no ' +
        'Approval_Window to expire (Requirement 14.4)',
    );
  }

  // One clock read for the boundary, for the transition guard, for `expired_at` and for the
  // Audit_Event, so an expiry cannot be recorded at an instant it was not judged against.
  const at = now();
  return expireSnapshot(snapshot, at, deps);
}

/**
 * The shared per-Proposal step: the pure rule, the guarded transition, the Audit_Event.
 *
 * Private because both entry points must go through it — a sweep with its own copy of this
 * sequence would be a second definition of what expiring means.
 */
async function expireSnapshot(
  snapshot: ProposalExpirySnapshot,
  at: Date,
  deps: ExpiryDeps,
): Promise<ExpiryOutcome> {
  const refusal = expiryRefusalFor(snapshot, at);
  if (refusal !== null) {
    return refusal;
  }

  const expiredAt = at.toISOString();
  // Requirement 5.16's first two clauses. The guard carries the whole condition, so a racing
  // approval or rejection wins and nothing is written here.
  const transitioned = await deps.store.markExpired(snapshot.proposal_id, expiredAt);
  if (!transitioned) {
    return notExpired(
      snapshot.proposal_id,
      'decided_concurrently',
      `the Proposal was ${snapshot.state} with a deadline of ${snapshot.approval_deadline} when ` +
        `it was read, and the guarded transition matched no row at ${expiredAt}: a User's ` +
        `approval or rejection, or another pass of this sweep, got there first. Nothing was ` +
        `written and no Audit_Event was appended`,
      { state: snapshot.state },
    );
  }

  // Requirement 5.16's third clause. After the transition, because an Audit_Event cannot be
  // retracted — see the module doc comment. A failure here propagates.
  const elapsed = elapsedWaitFor(snapshot, expiredAt);
  const event = await deps.audit.append(
    proposalExpiredEvent(snapshot.proposal_id, elapsed, deps.actor),
  );

  return {
    kind: 'expired',
    proposal_id: snapshot.proposal_id,
    expired_at: expiredAt,
    elapsed_wait: elapsed,
    audit_sequence_number: event.sequence_number,
  };
}

/* -------------------------------------------------------------------------- */
/* The sweep (thin slice 2)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * design.md's `expireOverdue`: the scheduled sweep, returning the Proposal identifiers it
 * expired.
 *
 * The query-time check in a loop, and nothing more. Each candidate goes through the same
 * {@link expiryRefusalFor} rule and the same guarded transition, so a row the query returned
 * and that stopped being overdue in the meantime is skipped rather than expired — the
 * candidate list is advisory and the guard is the authority.
 *
 * The Tenant is the session's, bound in the store (FINDING 4). `limit` bounds one pass
 * ({@link EXPIRY_SWEEP_BATCH}); a backlog larger than one batch drains over consecutive
 * passes, because an expired Proposal is no longer a candidate.
 *
 * @throws whatever the store or the Audit_Service raises, and it stops the pass. The
 * identifiers already returned by the store are not lost — the Proposals this pass expired
 * carry `state = 'expired'` on their rows — but the caller should treat the pass as
 * incomplete and read FINDING 2 before assuming every expiry it made was recorded.
 */
export async function expireOverdueProposals(
  deps: ExpiryDeps,
  limit: number = EXPIRY_SWEEP_BATCH,
): Promise<readonly string[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ActionServiceError(
      `the sweep batch bound must be a positive integer, got ${JSON.stringify(limit)}`,
    );
  }
  const now = deps.now ?? ((): Date => new Date());

  // One clock read for the candidate query, so the set the sweep considers and the boundary
  // it judges each candidate against are the same instant.
  const at = now();
  const candidates = await deps.store.overdueProposals(at.toISOString(), limit);

  const expired: string[] = [];
  for (const candidate of candidates) {
    // Sequential on purpose. Every append takes the row lock on this Tenant's audit sequence
    // counter (Requirement 13.1), so concurrency here would buy contention rather than speed.
    const outcome = await expireSnapshot(candidate, at, deps);
    if (outcome.kind === 'expired') {
      expired.push(outcome.proposal_id);
    }
  }
  return expired;
}

/**
 * design.md's `expireOverdue` with its dependencies bound at construction, ready to sit
 * beside `createApprovalActions`, `createAuthorizedExecutor` and `createExecutionVerifier`.
 *
 * The Tenant is the session's, supplied through the store and the Audit_Service
 * (Requirement 12.7) — no argument here carries one.
 */
export function createApprovalWindowExpiry(deps: ExpiryDeps): ApprovalWindowExpiry {
  return {
    expireOverdue: (limit) => expireOverdueProposals(deps, limit),
    expireIfOverdue: (proposalId) => expireIfOverdue(proposalId, deps),
  };
}
