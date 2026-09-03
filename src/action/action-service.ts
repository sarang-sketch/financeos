/**
 * The FinanceOS_Action_Service: approval and rejection (task 23.1).
 * Requirements 5.8, 5.9, 5.10.
 *
 * `src/policy/checks.ts` is the gate and `src/policy/decide.ts` is the derivation.
 * Neither of them writes `proposals.state` and neither of them executes anything —
 * both say so in their own doc comments. This module is the **state machine and the
 * hand-off**: it holds a Sensitive_Action while the require-approval decision stands,
 * records the User's decision on the `authorizations` row the schema was shaped for,
 * resubmits to the Policy_Engine, and reaches execution only through a seam it cannot
 * reach by accident.
 *
 * Three sentences of requirement, transcribed rather than improved on:
 *
 * - 5.8 — WHILE a Sensitive_Action holds the require-approval decision, withhold
 *   execution and make no change to Tenant state for that Proposal.
 * - 5.9 — WHEN a User approves, record an Authorization containing the User
 *   identifier, the Proposal identifier and the decision timestamp; resubmit the
 *   Proposal to the Policy_Engine; execute **only where the resubmitted evaluation
 *   returns a decision other than block**.
 * - 5.10 — WHEN a User rejects, record the rejection with the same three values,
 *   discard the Proposal without execution, and make no change to Tenant state.
 *
 * ## Withholding is structural, not a flag
 *
 * There is exactly one expression in this module that can start an execution:
 * `deps.executor.executeAuthorized(...)` inside {@link approveProposal}, and it sits
 * behind four sequential gates — the Proposal is `awaiting_approval`, the
 * Approval_Window has not elapsed, a User Authorization was written and returned an
 * id, and the resubmitted decision is not `block`. `awaiting_approval` **is** the
 * state that holds the require-approval decision, so 5.8 is satisfied by the absence
 * of any other path: nothing else in this file calls the executor, {@link rejectProposal}
 * does not receive it, and the executor is a required dependency rather than an
 * optional one, so a caller cannot wire the approval path up half-configured and have
 * it silently look like a withholding.
 *
 * Requirement 5.14's invariant — every Proposal reaching EXECUTE has an Authorization —
 * is preserved the same way: the executor is handed the identifier of the Authorization
 * this module has *already* written, so an execution with no Authorization behind it is
 * not expressible here. Property P8 (task 23.6) asserts it over the pipeline; this is
 * the shape that makes it true rather than tested-true.
 *
 * ## Why the Authorization is recorded before the resubmission
 *
 * Requirement 5.9 lists the two in that order, and the order is load-bearing rather
 * than stylistic. The approval requirement Policy_Check reads `authorizations` and
 * fails an `awaiting_approval` Proposal that carries no approval inside the
 * Approval_Window (`checks.ts`, Requirement 5.14, 5.16). Resubmitting *before* writing
 * the approval would therefore fail that check, and every approval a User ever gave
 * would come back `block`. Recording first is what makes the resubmission a real
 * re-evaluation of everything else: a duplicate that appeared in the interval, an
 * Evidence_Chain that stopped resolving, a Permission that was revoked, an elapsed
 * deadline. That is precisely what 5.9 asks the resubmission to catch.
 *
 * The resubmission is not a formality in the other direction either: a `block` here
 * stops the execution the User asked for, and the User's decision still stands on the
 * record. Nothing is un-recorded to make the block tidy.
 *
 * ## The state each path lands on
 *
 * `proposalStateForDecision` from `decide.ts` maps a decision onto a `proposal_state`
 * and is used here for the `block` case only — `blocked`, which Requirement 5.5
 * retains without execution. The non-block case is **`authorized`, whichever non-block
 * decision came back**, and that deliberately diverges from the mapping:
 *
 * - `auto_execute` maps to `authorized` already.
 * - `require_approval` maps to `awaiting_approval`, which is right for the Policy_Engine
 *   (it is the state a Proposal *enters* when approval is first required) and wrong
 *   here. On a resubmission the risk score still exceeds the Auto_Execute_Threshold —
 *   nothing about the Proposal changed — so `require_approval` is the *expected*
 *   answer for an approved Sensitive_Action, and Requirement 5.9 says to execute on
 *   any decision other than `block`. Leaving the Proposal in `awaiting_approval` while
 *   executing it would contradict its own row, and re-entering the approval queue a
 *   Proposal the User has just approved would ask for the same decision twice.
 *
 * This is exactly why `decide.ts` exports the mapping instead of applying it.
 *
 * ## FINDINGS — reported, not silently patched
 *
 * 1. **design.md never defines `ExecutionOutcome`.** `ActionService.approve` and
 *    `executeAuthorized` both return it and no interface for it appears anywhere in
 *    design.md or requirements.md. {@link ExecutionOutcome} here is the minimum the
 *    three requirements need: an executed case carrying the Proposal and the
 *    Authorization behind it, and a withheld case carrying a {@link WithheldReason} and
 *    the resubmitted {@link PolicyDecision} where there was one — because "we withheld"
 *    with no reason is not an answer a User can act on. Tasks 23.2–23.4 own execution,
 *    verification and the failure path and will widen the union (an
 *    `execution_failed` case for Requirement 5.17, at least); the two cases here are
 *    named individually ({@link ExecutedOutcome}, {@link WithheldOutcome}) so widening
 *    the union does not have to rewrite them. Task 23.2 has since added the third,
 *    {@link ExecutionFailedOutcome}, and widened {@link WITHHELD_REASONS} by the three
 *    reasons an execution can be refused; both were additive, as intended.
 * 2. **`ProposalUnderReview.ledger_effect` has no column.** The gate needs the
 *    Ledger_Entry set a Proposal would write (Requirement 2.1, 2.6, 2.7 through the
 *    accounting rule check) and `proposals` stores `expected_outcome JSONB`, which
 *    design.md never gives a shape. So {@link ACTION_PROPOSAL_LOAD_SQL} selects
 *    `expected_outcome` and the adapter has to reconstitute `ledger_effect` from it.
 *    Whoever writes that adapter (task 23.2 or 26.1) is fixing the `expected_outcome`
 *    shape for the whole runtime, including task 23.3's verification comparison, and
 *    should say so where it lands.
 * 3. **Nothing states what an approval arriving *after* the Approval_Window should
 *    do.** Requirement 5.16 makes the expiry condition "receives neither approval nor
 *    rejection within the Approval_Window", so a decision arriving late does not
 *    satisfy the window and the Proposal is expired in fact — but marking it expired,
 *    withholding permanently and auditing the elapsed wait is task 23.5's, and this
 *    module must not preempt the state transition that task owns. So a late approval
 *    or rejection is **refused with no write at all**:
 *    {@link WITHHELD_REASONS}`'approval_window_elapsed'`, no Authorization, no state
 *    change, the Proposal left in `awaiting_approval` for 23.5's sweep to mark
 *    `expired`. The alternative reading — record the Authorization, resubmit, and let
 *    the approval requirement check block it on the deadline, which `checks.ts`
 *    already does — withholds execution just as firmly but writes an Authorization
 *    against a Proposal that can never execute and stamps the state `blocked`, hiding
 *    it from the expiry sweep. Both readings withhold execution; the choice is which
 *    one leaves the row honest. Stated here rather than left for a reader to infer.
 * 4. **An `awaiting_approval` Proposal with a NULL `approval_deadline` is
 *    unanswerable.** `proposals.approval_deadline` is nullable and Requirement 5.16
 *    gives the window a mandatory range, so a Proposal awaiting approval without a
 *    deadline cannot be judged in time or out of time. `checks.ts` fails the approval
 *    requirement check on it; this module refuses the decision with
 *    `'approval_deadline_absent'` and writes nothing, for the same reason as FINDING 3.
 *    Whoever moves a Proposal into `awaiting_approval` (task 23.5's other half, or the
 *    AUTHORIZE stage) owes it a deadline.
 * 5. **A resubmission that returns `auto_execute` writes a second Authorization.**
 *    `authorizeProposal` records one naming the Policy_Engine on the `auto_execute`
 *    path (Requirement 5.6), and this module has already recorded the User's. Two rows
 *    for one execution is not a violation — Requirement 5.14 asks that an Authorization
 *    exist, not that exactly one does — and each row is true about the actor it names.
 *    Flagged because a reader counting `authorizations` rows per Proposal will see 2 on
 *    that path, and the User's is the one handed to the executor: it is the decision
 *    Requirement 5.9 requires execution to rest on.
 *
 * ## Scope — what is deliberately elsewhere
 *
 * - **No execution.** `./execute-authorized.ts` (task 23.2) implements
 *   {@link AuthorizedExecutor} against a write-capable Financial_Tool. This module
 *   decides *whether* and hands over the two identifiers. It stays a separate module
 *   for the reason stated two bullets down: the import list of *this* file is the
 *   evidence that a withheld or rejected Proposal changed no Tenant state, and an
 *   import of the tool layer would spend it.
 * - **No verification** — `./verify-execution.ts` (task 23.3) implements it one module
 *   further out, for the same reason and with the same effect: Requirement 5.12 makes it
 *   create an Exception, and an Exception writer imported here would spend the property the
 *   bullet below claims. **No reversal** (23.4, `SemanticLedger.reverseSet`),
 *   **no expiry sweep** (23.5). This file imports no ledger, no Razorpay client and no
 *   Exception writer, which is what makes Requirement 5.10's "no change to Tenant
 *   state" checkable by reading the import list rather than by trusting a comment.
 * - **No Audit_Event.** Requirement 5.2 appends one per completed Action_Pipeline
 *   stage through the FinanceOS_Audit_Service, whose serialized per-Tenant sequence is
 *   tasks 25.x. AUTHORIZE and EXECUTE events are that service's; the outcomes returned
 *   here are what it records.
 * - **No Permission resolution.** The FinanceOS_Authorization_Service exists as of task
 *   26.2 (`@/authz/authorization-service`), and `Permission` is imported from
 *   `@/authz/permissions` which now owns it. The approving session's granted Permissions
 *   remain an **input** here, exactly as in `checks.ts` (its FINDING 7): the caller holds
 *   the session, so the caller resolves the set through `permissionsFor` and passes it.
 * - **No store adapter.** `proposals` and `authorizations` are RLS `ENABLE`d and
 *   `FORCE`d with no policies until task 26.1 and no Postgres driver can be added (see
 *   `test/db/pg.ts`), so this module exports the three statements an adapter runs and
 *   the {@link ActionProposalStore} seam it implements. `$1` is always the adapter's own
 *   session Tenant, never a caller argument (Requirement 12.7, 14.1) — no method here
 *   takes a tenant id.
 */

import type { Permission } from '@/authz/permissions';
import type { TenantId } from '@/config/configuration-service';
import {
  PROPOSAL_STATES,
  type PolicyFactSources,
  type PolicySubmission,
  type ProposalState,
  type ProposalUnderReview,
} from '@/policy/checks';
import {
  authorizeProposal,
  type PolicyDecision,
  type PolicyDecisionStore,
  proposalStateForDecision,
} from '@/policy/decide';

/* -------------------------------------------------------------------------- */
/* Errors, permissions and the one state a User may decide from               */
/* -------------------------------------------------------------------------- */

/**
 * Thrown for a caller fault or a malformed stored Proposal — never for a withholding.
 *
 * The distinction is the same one `decide.ts` draws between raising and returning
 * `block`: a withholding is a **verdict about a Proposal** that a User can read and
 * act on, and an exception is a programming or data fault that no User can fix.
 */
export class ActionServiceError extends Error {
  override readonly name = 'ActionServiceError';
}

/**
 * The Permission the approval path requires.
 *
 * design.md's FinanceOS_API table maps `POST /proposals/{id}/approve` and
 * `POST /proposals/{id}/reject` to `approve_sensitive_actions` (Requirement 14.6), so
 * the resubmission of Requirement 5.9 passes this through
 * `PolicySubmission.required_permissions` rather than defaulting to the `run_agents`
 * an Agent's first submission requires.
 */
export const APPROVAL_PERMISSION: Permission = 'approve_sensitive_actions';

/**
 * The only `proposal_state` a User may approve or reject from.
 *
 * `awaiting_approval` is the state that holds the require-approval decision
 * (Requirement 5.7, 5.8), so it is the only one where an approval or a rejection is a
 * decision about a pending Sensitive_Action. Every other label is refused with a
 * reason and no write:
 *
 * - `proposed`, `blocked` — no require-approval decision stands, so there is nothing
 *   to approve. `blocked` is retained for re-evaluation (Requirement 5.5), not for
 *   approval; a User cannot approve past a failed Policy_Check.
 * - `authorized` — an Authorization is already on record and execution is the
 *   Action_Service's next step (task 23.2). A second approval would authorize nothing
 *   new.
 * - `executed`, `verified`, `verification_failed` — already executed. A second
 *   execution would apply the effect twice (Requirement 5.11, 5.12).
 * - `execution_failed` — Requirement 5.17 requires a **new** Authorization before any
 *   retry, and the retry path is task 23.4's; it is not a User approval of a pending
 *   Sensitive_Action.
 * - `rejected` — discarded (Requirement 5.10); a later approval cannot un-discard it.
 * - `expired` — execution is withheld permanently (Requirement 5.16).
 */
export const USER_DECIDABLE_STATES: readonly ProposalState[] = ['awaiting_approval'];

/** `authorizations.decision`, both labels the CHECK admits. */
export const USER_DECISIONS = ['approved', 'rejected'] as const;

export type UserDecision = (typeof USER_DECISIONS)[number];

/* -------------------------------------------------------------------------- */
/* Outcomes                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Why execution was withheld. See FINDING 1: design.md defines no `ExecutionOutcome`,
 * and a withholding with no reason is not an answer.
 *
 * - `proposal_absent` — no such Proposal for this Tenant. A foreign row is an absent
 *   row, never an error that would confirm its existence (Requirement 14.4).
 * - `not_awaiting_approval` — the Proposal holds no require-approval decision. See
 *   {@link USER_DECIDABLE_STATES}.
 * - `approval_deadline_absent` — `awaiting_approval` with no `approval_deadline`
 *   (FINDING 4).
 * - `approval_window_elapsed` — the decision arrived after the Approval_Window
 *   (FINDING 3).
 * - `resubmission_blocked` — Requirement 5.9's own condition: the resubmitted
 *   evaluation returned `block`.
 *
 * The last three are the EXECUTE stage's, added by task 23.2 and produced only by
 * `./execute-authorized.ts` — {@link refusalFor} never returns one, because they are
 * facts about an execution rather than about a User decision:
 *
 * - `authorization_unresolvable` — the named Authorization does not resolve to an
 *   approval recorded against this Proposal (Requirement 5.14, 12.10).
 * - `not_authorized_for_execution` — the Proposal is not in `authorized`, so nothing
 *   about it may reach a write-capable tool.
 * - `execution_tool_absent` — the Proposal's `action_type` names no write-capable
 *   Financial_Tool in the catalogue.
 */
export const WITHHELD_REASONS = [
  'proposal_absent',
  'not_awaiting_approval',
  'approval_deadline_absent',
  'approval_window_elapsed',
  'resubmission_blocked',
  'authorization_unresolvable',
  'not_authorized_for_execution',
  'execution_tool_absent',
] as const;

export type WithheldReason = (typeof WITHHELD_REASONS)[number];

/** An execution that ran. Produced by `./execute-authorized.ts` (task 23.2). */
export interface ExecutedOutcome {
  readonly kind: 'executed';
  readonly proposal_id: string;
  /** The Authorization execution rested on (Requirement 5.14). */
  readonly authorization_id: string;
  /** `proposals.executed_at`. ISO-8601 UTC. */
  readonly executed_at: string;
}

/** An execution that did not happen, and why. */
export interface WithheldOutcome {
  readonly kind: 'withheld';
  readonly proposal_id: string;
  readonly reason: WithheldReason;
  /** Human-readable, and always present: a User reads this on the Proposal. */
  readonly detail: string;
  /** The resubmitted evaluation, where one was made (Requirement 5.9). */
  readonly decision?: PolicyDecision;
  /** The Authorization recorded for the approval, where one was recorded. */
  readonly authorization_id?: string;
}

/**
 * An execution that was attempted and did not complete (task 23.2, Requirement 5.17).
 *
 * Distinct from {@link WithheldOutcome} because the two are different facts about
 * Tenant state. A withholding never invoked anything, so nothing changed. A failure
 * invoked a write-capable tool, and whether any part of the write landed is the tool's
 * business — which is precisely why Requirement 5.17 reverses "each change already
 * applied" rather than assuming there were none.
 *
 * **This outcome is the input to task 23.4, not a substitute for it.** Marking the
 * Proposal `execution_failed`, reversing through `SemanticLedger.reverseSet` and raising
 * the `execution_failure` Exception are 23.4's, so `./execute-authorized.ts` writes
 * nothing on this path and says so.
 */
export interface ExecutionFailedOutcome {
  readonly kind: 'execution_failed';
  readonly proposal_id: string;
  /** The Authorization the attempt rested on (Requirement 5.14). */
  readonly authorization_id: string;
  /** The write-capable Financial_Tool that was invoked. */
  readonly tool: string;
  /** The refused `ToolResult`'s discriminant, verbatim. */
  readonly failure: 'schema_violation' | 'incomplete_evidence' | 'tool_failure';
  readonly detail: string;
}

/** design.md's undefined `ExecutionOutcome`, in the minimum shape 5.8–5.10 need. */
export type ExecutionOutcome = ExecutedOutcome | WithheldOutcome | ExecutionFailedOutcome;

/**
 * What a rejection did. design.md types `reject` as `Promise<void>`; this widens it,
 * because the recorded rejection's identifier and the refusal reason are what an API
 * layer answers a User with, and discarding them would make a refused rejection
 * indistinguishable from a successful one.
 */
export type RejectionOutcome =
  | {
      readonly kind: 'discarded';
      readonly proposal_id: string;
      /** The `authorizations` row carrying the rejection (Requirement 5.10). */
      readonly authorization_id: string;
      readonly decided_at: string;
    }
  | {
      readonly kind: 'refused';
      readonly proposal_id: string;
      readonly reason: WithheldReason;
      readonly detail: string;
    };

/* -------------------------------------------------------------------------- */
/* The seams                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One Proposal as the approval path needs it: the gate's view of it, plus the two
 * Tenant configuration values the resubmission compares.
 *
 * The threshold and the window are **inputs** resolved by the Configuration_Service
 * (Requirement 5.15, 5.16), exactly as they are for `authorizeProposal`. `null` means
 * "did not resolve", which fails the risk threshold Policy_Check rather than being
 * defaulted — a threshold silently defaulted to 100 would auto-execute everything.
 */
export interface ActionProposalSnapshot {
  readonly proposal: ProposalUnderReview;
  /** `auto_execute_threshold`, integer 0..100, default 0. */
  readonly auto_execute_threshold: number | null;
  /** `approval_window_hours`, 1..168 (Requirement 5.16). */
  readonly approval_window_hours?: number | null;
}

/** Requirement 5.9 and 5.10's three values, as one row to write. */
export interface UserDecisionRecord {
  readonly proposal_id: string;
  /** The approving or rejecting User. `authorizations.actor_user_id`. */
  readonly user_id: string;
  readonly decision: UserDecision;
  /** The decision timestamp. ISO-8601 UTC. */
  readonly decided_at: string;
}

/**
 * The three writes and one read the approval path needs. Implemented by an adapter
 * that binds the session Tenant at construction — **no method takes a tenant id**
 * (Requirement 12.7, 14.1), and a foreign Proposal reads back as `null`.
 *
 * `recordUserDecision` and `transitionState` must **throw** rather than resolve when
 * they matched no row. A rejection that was not written is not a recorded rejection,
 * and a state transition that silently did nothing would leave a Proposal executing
 * from a row that still says it is awaiting approval.
 */
export interface ActionProposalStore {
  /** {@link ACTION_PROPOSAL_LOAD_SQL}. `null` when the Proposal does not resolve. */
  loadForUserDecision(proposalId: string): Promise<ActionProposalSnapshot | null>;
  /** {@link USER_AUTHORIZATION_SQL}. Returns `authorizations.id`. */
  recordUserDecision(record: UserDecisionRecord): Promise<string>;
  /**
   * {@link PROPOSAL_STATE_TRANSITION_SQL}. `from` is the guard: the update must match
   * only a Proposal still in one of those states, so two concurrent decisions cannot
   * both win.
   */
  transitionState(
    proposalId: string,
    to: ProposalState,
    from: readonly ProposalState[],
  ): Promise<void>;
}

/**
 * The EXECUTE stage, which this module does not implement (task 23.2).
 *
 * Both identifiers are passed because Requirement 5.14 ties an execution to the
 * Authorization behind it and design.md's `executeAuthorized(proposalId,
 * authorizationId)` carries both. A **required** dependency rather than an optional
 * one: an approval path wired without an executor must fail loudly at construction,
 * not resolve as a quiet withholding that looks like Requirement 5.8 working.
 */
export interface AuthorizedExecutor {
  executeAuthorized(proposalId: string, authorizationId: string): Promise<ExecutionOutcome>;
}

/** Everything the approval and rejection paths reach outside themselves. */
export interface ActionServiceDeps {
  readonly store: ActionProposalStore;
  /** The Policy_Engine's own writes, for the resubmission (`decide.ts`). */
  readonly policy: PolicyDecisionStore;
  /** The facts the six Policy_Checks read (`checks.ts`). */
  readonly sources: PolicyFactSources;
  readonly executor: AuthorizedExecutor;
}

/** One User's decision about one Proposal. */
export interface UserDecisionRequest {
  readonly proposal_id: string;
  readonly user_id: string;
  /** What the approving session holds (Requirement 14.6). Resolved by task 26.2. */
  readonly granted_permissions: readonly Permission[];
  /** The decision timestamp. Defaults to now. ISO-8601 UTC. */
  readonly decided_at?: string;
}

/* -------------------------------------------------------------------------- */
/* The statements an adapter runs                                             */
/* -------------------------------------------------------------------------- */

/**
 * One Proposal for the approval path. Parameters: `($1 tenant_id, $2 proposal_id)`.
 *
 * `impact_paise::text` is the money wire contract (Requirement 15.1, 15.8): the
 * `paise` domain is `BIGINT`, and any transport that parses it as a JSON number
 * coerces it to an IEEE-754 double. It crosses as a decimal string and becomes
 * `bigint` in the adapter, never `Number(...)`.
 *
 * `expected_outcome` is selected because it is the only column that can carry the
 * Ledger_Entry set the accounting rule Policy_Check reads — see FINDING 2, which is
 * the adapter's problem to solve and this task's to report.
 */
export const ACTION_PROPOSAL_LOAD_SQL = `
SELECT id,
       action_type,
       target_source_records,
       target_fingerprint,
       impact_paise::text AS impact_paise,
       evidence_chain_id,
       expected_outcome,
       state,
       approval_deadline,
       executed_at,
       risk_score,
       threshold_used
  FROM proposals
 WHERE tenant_id = $1
   AND id = $2::uuid`.trim();

/** The parameter tuple {@link ACTION_PROPOSAL_LOAD_SQL} expects, in order. */
export function actionProposalLoadParams(
  tenantId: TenantId,
  proposalId: string,
): readonly [TenantId, string] {
  return [tenantId, proposalId];
}

/**
 * Requirement 5.9's and 5.10's Authorization: the User identifier, the Proposal
 * identifier and the decision timestamp. Parameters:
 * `($1 tenant_id, $2 proposal_id, $3 actor_user_id, $4 decision, $5 decided_at)`.
 *
 * `actor_kind` is the literal `'user'` and `actor_user_id` is a parameter, which the
 * `authorizations` CHECK `(actor_kind = 'user') = (actor_user_id IS NOT NULL)` turns
 * into a guarantee: this statement cannot write a User decision with no User attached,
 * and it cannot be bent into the `policy_engine` row `POLICY_ENGINE_AUTHORIZATION_SQL`
 * owns. `decision` is a parameter because 5.9 and 5.10 differ in exactly that value
 * and in nothing else — one statement, so an approval and a rejection are recorded
 * with identical provenance.
 */
export const USER_AUTHORIZATION_SQL = `
INSERT INTO authorizations
  (tenant_id, proposal_id, actor_kind, actor_user_id, decision, decided_at)
VALUES ($1, $2::uuid, 'user', $3::uuid, $4, $5::timestamptz)
RETURNING id, decided_at`.trim();

/** The parameter tuple {@link USER_AUTHORIZATION_SQL} expects, in order. */
export function userAuthorizationParams(
  tenantId: TenantId,
  record: UserDecisionRecord,
): readonly [TenantId, string, string, UserDecision, string] {
  return [tenantId, record.proposal_id, record.user_id, record.decision, record.decided_at];
}

/**
 * The state transition the Action_Service owns and the Policy_Engine does not.
 * Parameters: `($1 tenant_id, $2 proposal_id, $3 to state, $4 from states text[])`.
 *
 * `$4` is the guard, and it is the concurrency control: two Users deciding the same
 * Proposal at once both write an Authorization, but only the first `UPDATE` matches a
 * row, so only one transition happens. `RETURNING id, state` is how an adapter tells
 * that apart from a silent no-op — zero rows means the Proposal moved on, and the
 * adapter must throw rather than let the caller believe the transition took.
 *
 * No other column is written. `executed_at` belongs to the EXECUTE stage (task 23.2),
 * `verified_at` and the observed and difference columns to VERIFY (23.3).
 */
export const PROPOSAL_STATE_TRANSITION_SQL = `
UPDATE proposals
   SET state = $3::proposal_state
 WHERE tenant_id = $1
   AND id = $2::uuid
   AND state = ANY($4::proposal_state[])
RETURNING id, state`.trim();

/** The parameter tuple {@link PROPOSAL_STATE_TRANSITION_SQL} expects, in order. */
export function proposalStateTransitionParams(
  tenantId: TenantId,
  proposalId: string,
  to: ProposalState,
  from: readonly ProposalState[],
): readonly [TenantId, string, ProposalState, readonly ProposalState[]] {
  return [tenantId, proposalId, to, from];
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Milliseconds since the epoch, or `null` for anything that is not an instant. */
function instantMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * A non-empty identifier, or a caller fault.
 *
 * Exported so `./execute-authorized.ts` holds its two arguments to the same rule rather
 * than to a second, slightly different one.
 */
export function requireIdentifier(value: string, what: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ActionServiceError(`${what} must be a non-empty identifier, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireInstant(value: string, what: string): string {
  if (instantMs(value) === null) {
    throw new ActionServiceError(
      `${what} must be an ISO-8601 instant, got ${JSON.stringify(value)}; Requirements 5.9 and ` +
        `5.10 record the decision timestamp, and an unparseable one cannot be compared against ` +
        `the Approval_Window`,
    );
  }
  return value;
}

/** Reason and detail for a refusal, or `null` when the decision is admissible. */
interface Refusal {
  readonly reason: WithheldReason;
  readonly detail: string;
}

/**
 * Whether a User decision may be recorded against this Proposal at `decidedAt`, and
 * why not where it may not. **Pure**: no clock, no I/O.
 *
 * Exported because it is the whole of Requirement 5.8's withholding condition plus
 * FINDINGS 3 and 4, and a rule that decides whether an execution may start should be
 * testable without a store, an executor or a Policy_Engine behind it.
 *
 * @throws {ActionServiceError} for a stored `state` that is not a `proposal_state`
 * label. That is a corrupt row rather than a Proposal a User can decide about, and
 * refusing it as "not awaiting approval" would report a data fault as a policy outcome.
 */
export function refusalFor(
  snapshot: ActionProposalSnapshot,
  decidedAt: string,
): Refusal | null {
  const { proposal } = snapshot;

  if (!(PROPOSAL_STATES as readonly string[]).includes(proposal.state)) {
    throw new ActionServiceError(
      `the stored proposal_state ${JSON.stringify(proposal.state)} is not one of ` +
        `${PROPOSAL_STATES.join(', ')}`,
    );
  }

  if (!USER_DECIDABLE_STATES.includes(proposal.state)) {
    return {
      reason: 'not_awaiting_approval',
      detail:
        `the Proposal is ${proposal.state}, so no require-approval decision stands over it; a ` +
        `User decision is admissible only from ${USER_DECIDABLE_STATES.join(', ')} ` +
        `(Requirement 5.7, 5.8)`,
    };
  }

  const deadline = instantMs(proposal.approval_deadline);
  if (deadline === null) {
    return {
      reason: 'approval_deadline_absent',
      detail:
        'the Proposal is awaiting approval but carries no approval_deadline, so the ' +
        'Approval_Window of Requirement 5.16 cannot be honoured and the decision can be judged ' +
        'neither in time nor out of time',
    };
  }

  const at = instantMs(decidedAt);
  if (at !== null && at > deadline) {
    return {
      reason: 'approval_window_elapsed',
      detail:
        `the decision at ${decidedAt} is after the approval_deadline ` +
        `${proposal.approval_deadline}; the Approval_Window elapsed with no decision, so ` +
        `execution is withheld and the expiry is the scheduled sweep's to record ` +
        `(Requirement 5.16)`,
    };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Approval (Requirement 5.8, 5.9)                                            */
/* -------------------------------------------------------------------------- */

/**
 * Requirement 5.9, in order: record the Authorization, resubmit to the Policy_Engine,
 * and execute only where the resubmitted decision is not `block`.
 *
 * Requirement 5.8 is the same function read from the other side. Every early return
 * below is a withholding with no write, and the executor is reachable only after all
 * four gates — see the module doc comment for why that is structural rather than
 * conventional.
 *
 * The resubmission goes through `authorizeProposal`, so it is the **same** evaluation
 * an Agent's first submission gets: all six Policy_Checks, the risk score of
 * Requirement 5.15, the derived decision, the gate picture persisted. The two
 * differences are stated rather than implicit — the actor is the approving User, and
 * the required Permission is {@link APPROVAL_PERMISSION} rather than `run_agents`.
 *
 * @throws {ActionServiceError} for an empty identifier, an unparseable decision
 * timestamp, or a stored state that is not a `proposal_state` label.
 * @throws whatever the store or the Policy_Engine raises. A failed write is not a
 * withholding: if the Authorization could not be recorded, nothing may execute, and
 * the caller must hear about it rather than read a tidy "withheld".
 */
export async function approveProposal(
  request: UserDecisionRequest,
  deps: ActionServiceDeps,
): Promise<ExecutionOutcome> {
  const proposalId = requireIdentifier(request.proposal_id, 'proposal_id');
  const userId = requireIdentifier(request.user_id, 'user_id');
  const decidedAt = requireInstant(
    request.decided_at ?? new Date().toISOString(),
    'the decision timestamp',
  );

  const snapshot = await deps.store.loadForUserDecision(proposalId);
  if (snapshot === null) {
    return {
      kind: 'withheld',
      proposal_id: proposalId,
      reason: 'proposal_absent',
      detail:
        'no Proposal with that identifier resolves for this Tenant, so there is nothing to ' +
        'approve (Requirement 14.4)',
    };
  }

  const refusal = refusalFor(snapshot, decidedAt);
  if (refusal !== null) {
    return { kind: 'withheld', proposal_id: proposalId, ...refusal };
  }

  // Requirement 5.9's first clause. Written before the resubmission because the
  // approval requirement Policy_Check reads it — see the module doc comment.
  const authorizationId = await deps.store.recordUserDecision({
    proposal_id: proposalId,
    user_id: userId,
    decision: 'approved',
    decided_at: decidedAt,
  });

  // Requirement 5.9's second clause: the same evaluation, re-run. A Proposal can have
  // become blocked in the interval — a duplicate executed, the Evidence_Chain stopped
  // resolving, the Permission was revoked — which is exactly what this catches.
  const resubmission: Omit<PolicySubmission, 'risk_score'> = {
    proposal: snapshot.proposal,
    actor: { kind: 'user', id: userId },
    granted_permissions: request.granted_permissions,
    required_permissions: [APPROVAL_PERMISSION],
    auto_execute_threshold: snapshot.auto_execute_threshold,
    ...(snapshot.approval_window_hours === undefined
      ? {}
      : { approval_window_hours: snapshot.approval_window_hours }),
    submitted_at: decidedAt,
  };

  const decision = await authorizeProposal(resubmission, deps.sources, deps.policy, {
    decidedAt,
  });

  // Requirement 5.9's third clause, and the only gate execution passes through.
  if (decision.decision === 'block') {
    await deps.store.transitionState(
      proposalId,
      proposalStateForDecision('block'),
      USER_DECIDABLE_STATES,
    );
    return {
      kind: 'withheld',
      proposal_id: proposalId,
      reason: 'resubmission_blocked',
      detail:
        `the resubmitted evaluation returned block on ` +
        `${decision.failed_check_ids.join(', ')}, so the Proposal is retained without ` +
        `execution (Requirement 5.5, 5.9); the User's approval stays on record`,
      decision,
      authorization_id: authorizationId,
    };
  }

  // `authorized` for any non-block decision, not `proposalStateForDecision(decision)`.
  // See the module doc comment: on a resubmission `require_approval` is the expected
  // answer for an approved Sensitive_Action, and Requirement 5.9 executes on it.
  await deps.store.transitionState(proposalId, 'authorized', USER_DECIDABLE_STATES);

  return deps.executor.executeAuthorized(proposalId, authorizationId);
}

/* -------------------------------------------------------------------------- */
/* Rejection (Requirement 5.10)                                               */
/* -------------------------------------------------------------------------- */

/**
 * Requirement 5.10: record the rejection with the User identifier, the Proposal
 * identifier and the decision timestamp, discard the Proposal without execution, and
 * make no change to Tenant state for that Proposal.
 *
 * "No change to Tenant state" is read the way `decide.ts` reads it for a blocked
 * Proposal: the `authorizations` row and the `state = 'rejected'` transition record
 * the decision, and nothing else moves. There is no Ledger_Entry, no Razorpay call and
 * no Exception lifecycle change on this path — and none is reachable from it, because
 * this module imports no ledger, no Razorpay client and no Exception writer.
 *
 * The two writes are ordered rejection-then-discard, matching the requirement's own
 * order. It is the safe order: a rejection recorded against a Proposal still in
 * `awaiting_approval` is a Proposal that cannot be approved (the approval requirement
 * Policy_Check fails on a recorded rejection, so a racing approval resubmits to
 * `block`), whereas discarding first would leave a window in which the Proposal is
 * `rejected` with no record of who rejected it.
 *
 * @throws {ActionServiceError} for an empty identifier, an unparseable decision
 * timestamp, or a stored state that is not a `proposal_state` label.
 */
export async function rejectProposal(
  request: UserDecisionRequest,
  deps: Pick<ActionServiceDeps, 'store'>,
): Promise<RejectionOutcome> {
  const proposalId = requireIdentifier(request.proposal_id, 'proposal_id');
  const userId = requireIdentifier(request.user_id, 'user_id');
  const decidedAt = requireInstant(
    request.decided_at ?? new Date().toISOString(),
    'the decision timestamp',
  );

  const snapshot = await deps.store.loadForUserDecision(proposalId);
  if (snapshot === null) {
    return {
      kind: 'refused',
      proposal_id: proposalId,
      reason: 'proposal_absent',
      detail:
        'no Proposal with that identifier resolves for this Tenant, so there is nothing to ' +
        'reject (Requirement 14.4)',
    };
  }

  const refusal = refusalFor(snapshot, decidedAt);
  if (refusal !== null) {
    return { kind: 'refused', proposal_id: proposalId, ...refusal };
  }

  const authorizationId = await deps.store.recordUserDecision({
    proposal_id: proposalId,
    user_id: userId,
    decision: 'rejected',
    decided_at: decidedAt,
  });

  await deps.store.transitionState(proposalId, 'rejected', USER_DECIDABLE_STATES);

  return {
    kind: 'discarded',
    proposal_id: proposalId,
    authorization_id: authorizationId,
    decided_at: decidedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* design.md's interface shape                                                */
/* -------------------------------------------------------------------------- */

/**
 * The half of design.md's `ActionService` this task owns.
 *
 * Tasks 23.2–23.5 add `executeAuthorized`, `verify` and `expireOverdue`. Declared as
 * its own interface rather than a partial `ActionService` so nothing has to pretend
 * those three exist yet.
 */
export interface ApprovalActions {
  approve(proposalId: string, userId: string): Promise<ExecutionOutcome>;
  reject(proposalId: string, userId: string): Promise<RejectionOutcome>;
}

/**
 * design.md's `approve(proposalId, userId)` / `reject(proposalId, userId)`, with the
 * session bound at construction.
 *
 * The Tenant is not a parameter here and is not a parameter of any store method: the
 * adapter binds it from the session (Requirement 12.7, 14.1), the same convention
 * `checks.ts` and `decide.ts` follow. The granted Permission set is bound the same way
 * because nothing resolves it yet (task 26.2), which keeps the two-argument signature
 * design.md specifies honest instead of hiding an unresolved dependency inside it.
 */
export function createApprovalActions(
  deps: ActionServiceDeps & { readonly granted_permissions: readonly Permission[] },
): ApprovalActions {
  const { granted_permissions, ...rest } = deps;
  return {
    approve: (proposalId, userId) =>
      approveProposal({ proposal_id: proposalId, user_id: userId, granted_permissions }, rest),
    reject: (proposalId, userId) =>
      rejectProposal({ proposal_id: proposalId, user_id: userId, granted_permissions }, rest),
  };
}
