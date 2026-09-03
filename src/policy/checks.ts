/**
 * The six independent Policy_Checks (task 22.1).
 * Requirements 5.3, 5.4, 5.13; the gate picture the approval queue renders.
 *
 * This module is the **gate**, and nothing else. It computes no risk score and
 * returns no decision: `src/policy/risk.ts` and `src/policy/decide.ts` (task 22.2)
 * own those, consume {@link PolicyChecksOutcome}, and are deliberately absent from
 * this file so the two halves cannot become circular. What is exported here is the
 * stable shape 22.2 reads: exactly six {@link PolicyCheckResult}s in a fixed order,
 * the matching duplicate Proposal identifier where one was found, and the count of
 * absent Evidence_Chain Source_Records that Requirement 5.15 feeds into the risk
 * score.
 *
 * ## Independence is the whole point, and it is structural
 *
 * Requirement 5.3: evaluate all 6, "each Policy_Check independently of the result
 * of every other Policy_Check". Two things follow, and both are enforced rather
 * than intended:
 *
 * 1. **No short-circuit.** {@link evaluatePolicyChecks} runs all six and always
 *    returns six results — see {@link POLICY_CHECK_COUNT} and the fixed
 *    {@link POLICY_CHECK_IDS} order. A User looking at a blocked Proposal sees the
 *    complete picture, not the first thing that went wrong.
 * 2. **No fault propagation.** Each check is its own exported pure function, and
 *    the runner calls each inside its own `try`. A check that throws — malformed
 *    input, an unknown state label, a `PaiseRangeError` from the ledger rules —
 *    becomes *that* check's `fail` carrying the message as `detail`. It cannot
 *    suppress, skip, or alter the other five. Failing closed is the safe direction:
 *    a fail yields `block` (Requirement 5.5), which retains the Proposal without
 *    execution and changes no Tenant state.
 *
 * The same discipline covers fact gathering. {@link runPolicyChecks} resolves the
 * three I/O-backed facts concurrently under one budget; a source that rejects or
 * overruns fails only the checks that needed it, and the rest still report.
 *
 * ## The 10-second bound (Requirement 5.3)
 *
 * {@link POLICY_EVALUATION_BUDGET_MS} is 10 000 ms, matching `TOOL_TIMEOUT_MS` and
 * enforced the same way `src/tools/tool.ts` enforces its own: a `setTimeout` raced
 * against the work, with an `AbortSignal` handed to any source that can honour it.
 *
 * What the spec does **not** say is what an evaluation that cannot finish should
 * return, and Requirements 5.3 and 5.4 together leave no room for returning nothing
 * — six results and a decision are owed. So an overrun is **not** an exception
 * here: the facts that arrived are used, and every check whose facts did not arrive
 * fails with a detail naming the overrun. Six results, inside the bound, and the
 * derived decision is `block`. That is this module's decision, recorded in
 * FINDING 6 below rather than left for a reader to discover.
 *
 * ## What the requirements fix, and what they leave to this module
 *
 * Requirement 5.3 *names* the six checks. Requirement 5.13 *defines* one of them,
 * to the day. The other five are named and nowhere defined — not in requirements.md,
 * not in design.md's Policy_Engine section, not in the task text. Rather than invent
 * a rule and present it as specified, each check below states the requirement it is
 * derived from and the FINDING list records where the derivation is this module's
 * reading. Nothing here is a silent choice.
 *
 * | Check | Rule | Grounded in |
 * |---|---|---|
 * | `user_permission` | the submitting actor holds every Permission the submission requires | Requirement 14.6, design.md's route table |
 * | `accounting_rule` | the Proposal's stated Ledger_Entry effect satisfies the Semantic_Ledger's rules | Requirement 2.1, 2.4, 2.6, 2.7 |
 * | `transaction_evidence` | the Evidence_Chain is readable and cites every target Source_Record | Requirement 12.2, 12.3, 5.15 |
 * | `duplicate_action` | no matching Proposal in the 30-day lookback | **Requirement 5.13, verbatim** |
 * | `risk_threshold` | the risk score and the Auto_Execute_Threshold are both integers 0..100 | Requirement 5.15, and 5.6/5.7 by elimination |
 * | `approval_requirement` | the approval the Proposal's state requires is on record | Requirement 5.9, 5.10, 5.14, 5.16, 5.17 |
 *
 * ### Why `risk_threshold` does not fail on `risk > threshold`
 *
 * The obvious reading is wrong, and demonstrably so. Requirement 5.7 says all 6
 * checks passing with a risk score *above* the Auto_Execute_Threshold yields
 * `require_approval`. Requirement 5.5 says any check failing yields `block`. If the
 * risk threshold check failed whenever the score exceeded the threshold, then
 * "all 6 pass and risk > threshold" would be unsatisfiable and Requirement 5.7
 * would be dead text — every Sensitive_Action would be blocked instead of queued
 * for approval, which is the opposite of what Requirement 5 exists to do. So the
 * comparison against the threshold is the **decision's** job (task 22.2), and this
 * check verifies only that the two operands exist and are comparable: both integers
 * in 0..100 (Requirement 5.15). An absent or out-of-range score, or an
 * unresolvable threshold, is a real fail — the gate cannot be applied at all.
 *
 * ## FINDINGS — reported, not silently patched
 *
 * 1. **Requirement 5.13 names 2 of the 10 `proposal_state` labels.** "An executed
 *    Proposal or a Proposal awaiting approval" maps cleanly onto `executed` and
 *    `awaiting_approval`, but the enum also holds `verified`,
 *    `verification_failed`, `authorized` and `execution_failed`, and a Proposal in
 *    the first three of those **has executed**: `verified` and
 *    `verification_failed` are post-EXECUTE states, and `authorized` is a Proposal
 *    with a recorded Authorization about to execute. Taking 5.13 at its narrowest
 *    would let a second Proposal for the same action and targets sail past the gate
 *    the moment VERIFY completed, which is precisely the double action the check
 *    exists to stop. {@link DUPLICATE_BLOCKING_STATES} therefore holds five labels,
 *    each with its reasoning. `execution_failed` is deliberately **excluded**:
 *    Requirement 5.17 reverses every applied change, so nothing stands to be
 *    duplicated, and blocking there would leave a Tenant unable to remediate for 30
 *    days. `proposed`, `blocked`, `rejected` and `expired` are excluded because none
 *    of them changed Tenant state.
 * 2. **Requirement 5.13 says "in the Audit_Log", design.md says "over ... Proposals".**
 *    The two disagree about where the lookback reads. `proposals` is the table that
 *    holds `target_fingerprint`, `state` and `executed_at`, so it is what
 *    {@link DUPLICATE_ACTION_LOOKBACK_SQL} queries, and the Audit_Log reading is
 *    satisfied transitively: Requirement 5.2 appends an Audit_Event per stage, so
 *    every executed Proposal is in the Audit_Log by construction. Flagged because a
 *    reader of 5.13 alone would write a different query.
 * 3. **Neither document fixes which instant the 30 days are measured from.** A
 *    Proposal has `created_at`, `executed_at` and `verified_at`. This module uses
 *    `executed_at` where it is set and `created_at` otherwise — see
 *    {@link relevantInstantOf} — because that is the instant at which the candidate
 *    became "executed" or "awaiting approval" in 5.13's sense.
 * 4. **Neither document fixes the `proposals.target_fingerprint` format.** design.md
 *    says only "action_type + sorted target ids". {@link proposalTargetFingerprint}
 *    is the single definition — `action_type|type:id,type:id` over refs canonicalised
 *    by `@/agents/exception-fingerprint`, which already rejects the separators and
 *    control characters that would let two different target sets collide onto one
 *    string. It is stored in plain text rather than hashed, since the approval queue
 *    renders it and there is nothing secret in it. Note that
 *    `test/db/proposals-authorizations.test.ts` writes the ad-hoc literal
 *    `post_reversal:settlement:setl_1` as a fixture value; a fixture is not a format,
 *    and it is not the one implemented here.
 * 5. **`test/db/proposals-authorizations.test.ts` also writes `policy_checks` as
 *    `[{"name":..., "passed":...}]`.** design.md's `PolicyDecision.checks` is
 *    `{ id, result: 'pass' | 'fail', detail? }`. This module follows design.md.
 *    Whoever persists the column in task 22.2 should write design.md's shape and
 *    that fixture should follow, or the approval queue of task 27.1 will read a key
 *    that is not there.
 * 6. **Nothing states what a timed-out evaluation returns.** See the 10-second
 *    section above: it returns six results, failing closed on the checks whose facts
 *    are missing.
 * 7. **`approvals` and `permissions` have no reader yet.** Resolved for `Permission`
 *    itself as of task 26.2: `@/authz/permissions` now owns the single declaration and
 *    this module imports it from there rather than from `@/tools/tool`. The granted set
 *    remains an **input** to this module — `AuthorizationService.permissionsFor` in
 *    `@/authz/authorization-service` is what resolves it, from the session's Tenant —
 *    and this module still checks the set it is given and never resolves one itself.
 *    That reader has no live adapter yet: `authenticated` holds no grant on
 *    `user_permissions` (see that module's grant note).
 *
 * ## Scope — what is deliberately left elsewhere
 *
 * - **The risk score** is `src/policy/risk.ts` (task 22.2). This module reports
 *   {@link PolicyChecksOutcome.absent_evidence_count} so the absent-evidence points
 *   of Requirement 5.15 are counted once, by the check that already had to compute
 *   them, rather than derived a second time from a second read of the chain.
 * - **The decision, the Authorization write and the `proposals` persistence** are
 *   `src/policy/decide.ts` (task 22.2). It must throw when handed fewer than
 *   {@link POLICY_CHECK_COUNT} checks — {@link isCompletePolicyCheckSet} is the
 *   predicate for that — and `block` when {@link anyCheckFailed} is true.
 * - **No store adapter is written here.** `proposals` is RLS `ENABLE`d and `FORCE`d
 *   with no policies until task 26.1, and no Postgres driver can be added (see
 *   `test/db/pg.ts`). {@link DUPLICATE_ACTION_LOOKBACK_SQL} is the statement an
 *   adapter runs; {@link PolicyFactSources} is the seam it implements, and it binds
 *   the Tenant at construction from the session — no method here takes a tenant id
 *   (Requirement 12.7, 14.1).
 * - **Zod is not used.** design.md scopes Zod to tool and transport schemas; this is
 *   an in-process evaluator over already-parsed values, so it follows
 *   `posting-rules.ts` and `chain-builder.ts` and validates with named assertions
 *   whose messages say which field and which rule.
 */

import type { Paise } from '@/calc/paise';
import type { Actor, TenantId } from '@/config/configuration-service';
import { canonicalSourceRefs } from '@/agents/exception-fingerprint';
import {
  assertDraftWellFormed,
  imbalancePaise,
  type LedgerEntrySetDraft,
  type SourceRef,
} from '@/ledger/posting-rules';
import type { Permission } from '@/authz/permissions';

/* -------------------------------------------------------------------------- */
/* The six checks                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The 6 Policy_Check identifiers, in the order Requirement 5.3 names them and
 * design.md's `PolicyCheckId` lists them.
 *
 * The order is load-bearing twice over: {@link evaluatePolicyChecks} returns its
 * results in it, so the approval queue of task 27.1 renders a stable gate picture,
 * and `policy_checks` is persisted in it, so two evaluations of one Proposal are
 * comparable row by row.
 */
export const POLICY_CHECK_IDS = [
  'user_permission',
  'accounting_rule',
  'transaction_evidence',
  'duplicate_action',
  'risk_threshold',
  'approval_requirement',
] as const;

export type PolicyCheckId = (typeof POLICY_CHECK_IDS)[number];

/** Requirement 5.3's "all 6". A constant, so `decide` can assert on it. */
export const POLICY_CHECK_COUNT = POLICY_CHECK_IDS.length;

/**
 * One check's outcome. design.md's shape exactly: pass or fail, with an optional
 * human-readable reason.
 *
 * `detail` is present on **every** fail — a gate the User cannot understand is not
 * a gate picture — and absent on a pass unless the pass itself needs explaining
 * (an action type that writes no Ledger_Entry set, for instance).
 */
export interface PolicyCheckResult {
  readonly id: PolicyCheckId;
  readonly result: 'pass' | 'fail';
  readonly detail?: string;
}

/** Thrown for input this module cannot evaluate at all. Never for a failed check. */
export class PolicyCheckError extends Error {
  override readonly name = 'PolicyCheckError';
}

/* -------------------------------------------------------------------------- */
/* Proposal state, transcribed from the schema                                */
/* -------------------------------------------------------------------------- */

/**
 * The 10 `proposal_state` labels of `20260101000008_proposals_authorizations.sql`,
 * in migration order. First transcription in the TypeScript runtime; task 22.2 and
 * task 23.x should import rather than restate it.
 */
export const PROPOSAL_STATES = [
  'proposed',
  'blocked',
  'awaiting_approval',
  'authorized',
  'executed',
  'verified',
  'verification_failed',
  'execution_failed',
  'rejected',
  'expired',
] as const;

export type ProposalState = (typeof PROPOSAL_STATES)[number];

/* -------------------------------------------------------------------------- */
/* The Proposal as the gate sees it                                           */
/* -------------------------------------------------------------------------- */

/**
 * "This action writes no Ledger_Entry set."
 *
 * A **stated** absence, not an omitted field. {@link ProposalUnderReview.ledger_effect}
 * is mandatory, so a Proposal cannot slip past the accounting rule check by leaving
 * its effect out — the same reason `IncompleteEvidence` in
 * `@/evidence/chain-builder` has no figure field at all. `reason` is rendered in the
 * approval queue, so "why does this action post nothing?" has an answer on the row.
 */
export interface NoLedgerEffect {
  readonly kind: 'none';
  readonly reason: string;
}

/** Whether a stated effect is the absence of one. */
export function statesNoLedgerEffect(
  effect: LedgerEntrySetDraft | NoLedgerEffect,
): effect is NoLedgerEffect {
  return (effect as NoLedgerEffect).kind === 'none';
}

/**
 * The Proposal under evaluation, in `proposals` column terms.
 *
 * `id` is absent on a first submission — the Proposal may not be persisted yet —
 * and present on the resubmission Requirement 5.9 requires after an approval.
 */
export interface ProposalUnderReview {
  /** `proposals.id`. Absent before the first persist. */
  readonly id?: string;
  /** `proposals.action_type`. */
  readonly action_type: string;
  /** `proposals.target_source_records`, the ordered target Source_Record set. */
  readonly target_source_records: readonly SourceRef[];
  /** `proposals.impact_paise`. Integer paise, `bigint` (Requirement 15.1). */
  readonly impact_paise: Paise;
  /** `proposals.evidence_chain_id`. `NOT NULL` in the schema. */
  readonly evidence_chain_id: string;
  /** `proposals.state`. */
  readonly state: ProposalState;
  /**
   * What this action writes to the Semantic_Ledger, or a stated
   * {@link NoLedgerEffect}. Mandatory — see {@link NoLedgerEffect}.
   */
  readonly ledger_effect: LedgerEntrySetDraft | NoLedgerEffect;
  /**
   * The persisted Ledger_Entry set this Proposal corrects, where it corrects one.
   * Requirements 2.4 and 2.7 admit a correction only as a **new reversing set**, so
   * where this is set the effect's `reverses_set_id` must equal it.
   */
  readonly corrects_ledger_set_id?: string | null;
  /** `proposals.approval_deadline`. ISO-8601 UTC. */
  readonly approval_deadline?: string | null;
  /** `proposals.executed_at`. ISO-8601 UTC. */
  readonly executed_at?: string | null;
}

/* -------------------------------------------------------------------------- */
/* The facts the six checks read                                              */
/* -------------------------------------------------------------------------- */

/**
 * The Permission a Proposal submission requires by default.
 *
 * design.md's FinanceOS_API table maps `POST /agents/{agent}/runs` — "Action_Pipeline
 * run" — to `run_agents`, and a Proposal is what an Action_Pipeline run produces, so
 * `run_agents` is the Permission the submitting session must hold. The approval path
 * is different: `POST /proposals/{id}/approve` requires `approve_sensitive_actions`,
 * so task 23.1's resubmission after an approval (Requirement 5.9) passes that
 * instead through {@link PolicySubmission.required_permissions}.
 */
export const PROPOSAL_SUBMISSION_PERMISSION: Permission = 'run_agents';

/**
 * What the Evidence_Chain named by `proposals.evidence_chain_id` actually cites.
 *
 * `null` where the chain could not be read at all — absent row, foreign Tenant, or
 * a source that failed. An unreadable chain is an ungrounded figure, so the
 * transaction evidence check fails and every target record counts as absent.
 */
export interface EvidenceGrounding {
  readonly evidence_chain_id: string;
  /** Every distinct Source_Record the chain cites (`evidence_chain_sources`). */
  readonly cited_source_records: readonly SourceRef[];
}

/**
 * A prior Proposal in the duplicate lookback window.
 *
 * `target_fingerprint` rather than the ref list: it is the stored column, it is what
 * {@link DUPLICATE_ACTION_LOOKBACK_SQL} filters on, and comparing two fingerprints
 * is comparing two canonical target sets by construction.
 */
export interface PriorProposal {
  readonly id: string;
  readonly action_type: string;
  readonly target_fingerprint: string;
  readonly state: ProposalState;
  /** `proposals.created_at`. ISO-8601 UTC. */
  readonly created_at: string;
  /** `proposals.executed_at`, where the Proposal executed. ISO-8601 UTC. */
  readonly executed_at?: string | null;
}

/** One `authorizations` row for the Proposal under review. */
export interface RecordedAuthorization {
  readonly id: string;
  readonly proposal_id: string;
  readonly actor_kind: 'user' | 'policy_engine';
  readonly actor_user_id?: string | null;
  readonly decision: 'approved' | 'rejected';
  /** `authorizations.decided_at`. ISO-8601 UTC. */
  readonly decided_at: string;
}

/**
 * A fact that could not be gathered: which source, and why.
 *
 * Carried as a **value** rather than thrown, so one unavailable fact fails one check
 * instead of the evaluation (Requirement 5.3's independence).
 */
export interface UnavailableFact {
  readonly available: false;
  readonly reason: string;
}

/** A gathered fact, or the reason it is missing. */
export type Fact<T> = { readonly available: true; readonly value: T } | UnavailableFact;

/** Every fact the six checks read, each independently available or not. */
export interface PolicyFacts {
  /** The Evidence_Chain grounding, or `null` for a chain that does not resolve. */
  readonly evidence: Fact<EvidenceGrounding | null>;
  /** Candidate prior Proposals for the duplicate lookback. */
  readonly prior_proposals: Fact<readonly PriorProposal[]>;
  /** Authorizations already recorded against this Proposal. */
  readonly authorizations: Fact<readonly RecordedAuthorization[]>;
}

/**
 * One submission to the gate: the Proposal, who submitted it, and the two numbers
 * the risk threshold check compares.
 *
 * `risk_score` and `auto_execute_threshold` are **inputs**, not computations. The
 * score is task 22.2's (`src/policy/risk.ts`) and the threshold is the
 * Configuration_Service's `auto_execute_threshold` (Requirement 5.15). `null` means
 * "could not be resolved", which the risk threshold check reports as a fail rather
 * than defaulting — a threshold silently defaulted to 0 would auto-execute nothing,
 * and one silently defaulted to 100 would auto-execute everything.
 */
export interface PolicySubmission {
  readonly proposal: ProposalUnderReview;
  /** Who submitted. An Agent for a pipeline run, a User for a resubmission. */
  readonly actor: Actor;
  /** The Permissions the submitting session holds (Requirement 14.6). */
  readonly granted_permissions: readonly Permission[];
  /** Defaults to `[`{@link PROPOSAL_SUBMISSION_PERMISSION}`]`. */
  readonly required_permissions?: readonly Permission[];
  /** Integer 0..100, or `null` when it could not be computed (Requirement 5.15). */
  readonly risk_score: number | null;
  /** Integer 0..100, or `null` when the Tenant configuration did not resolve. */
  readonly auto_execute_threshold: number | null;
  /** `approval_window_hours`, 1..168 (Requirement 5.16). Omit where not resolved. */
  readonly approval_window_hours?: number | null;
  /** The submission instant. ISO-8601 UTC. The 30-day window ends here. */
  readonly submitted_at: string;
}

/** A submission with its facts resolved. What each check function reads. */
export interface PolicyCheckInput {
  readonly submission: PolicySubmission;
  readonly facts: PolicyFacts;
}

/* -------------------------------------------------------------------------- */
/* The outcome                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What the gate returns. The stable contract `src/policy/decide.ts` (task 22.2)
 * consumes.
 *
 * `checks` always holds exactly {@link POLICY_CHECK_COUNT} results, in
 * {@link POLICY_CHECK_IDS} order, one per id, whatever went wrong.
 */
export interface PolicyChecksOutcome {
  readonly checks: readonly PolicyCheckResult[];
  /**
   * The matching Proposal identifier Requirement 5.13 requires recording. Present
   * if and only if the duplicate action check failed on a match.
   */
  readonly duplicate_proposal_id?: string;
  /**
   * Target Source_Records the Evidence_Chain does not cite (Requirement 5.15's
   * "count of absent Evidence_Chain Source_Records"). Every target counts as absent
   * when the chain does not resolve. Reported here so `risk.ts` counts it once.
   */
  readonly absent_evidence_count: number;
  /** Wall-clock milliseconds the evaluation took. Bounded by the budget. */
  readonly elapsed_ms: number;
  /** True when fact gathering hit {@link POLICY_EVALUATION_BUDGET_MS}. */
  readonly timed_out: boolean;
}

/** True when `checks` is a complete set: 6 results, one per id, no repeats. */
export function isCompletePolicyCheckSet(checks: readonly PolicyCheckResult[]): boolean {
  if (checks.length !== POLICY_CHECK_COUNT) {
    return false;
  }
  const seen = new Set(checks.map((c) => c.id));
  return seen.size === POLICY_CHECK_COUNT && POLICY_CHECK_IDS.every((id) => seen.has(id));
}

/** True when 1 or more checks failed — Requirement 5.5's `block` condition. */
export function anyCheckFailed(checks: readonly PolicyCheckResult[]): boolean {
  return checks.some((c) => c.result === 'fail');
}

/** The identifiers Requirement 5.5 requires recording, in check order. */
export function failedCheckIds(checks: readonly PolicyCheckResult[]): readonly PolicyCheckId[] {
  return checks.filter((c) => c.result === 'fail').map((c) => c.id);
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

const pass = (id: PolicyCheckId, detail?: string): PolicyCheckResult =>
  detail === undefined ? { id, result: 'pass' } : { id, result: 'pass', detail };

const fail = (id: PolicyCheckId, detail: string): PolicyCheckResult => ({
  id,
  result: 'fail',
  detail,
});

/** An integer in the inclusive `0..100` range Requirement 5.15 fixes. */
function isScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
}

/** Milliseconds since the epoch, or `null` for anything that is not an instant. */
function instantMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function requireInstant(value: string | null | undefined, what: string): number {
  const ms = instantMs(value);
  if (ms === null) {
    throw new PolicyCheckError(
      `${what} must be an ISO-8601 instant, got ${JSON.stringify(value)}`,
    );
  }
  return ms;
}

const refKey = (ref: SourceRef): string => `${ref.type}:${ref.id}`;

/* -------------------------------------------------------------------------- */
/* The target fingerprint (design.md's `proposals.target_fingerprint`)        */
/* -------------------------------------------------------------------------- */

/** The separator between the action type and the ref list. See FINDING 4. */
const FINGERPRINT_SEPARATOR = '|';

/**
 * `action_type|type:id,type:id` — the identity of "this action against these
 * records", and the single definition of `proposals.target_fingerprint`.
 *
 * Refs are canonicalised by `canonicalSourceRefs` from
 * `@/agents/exception-fingerprint`: deduplicated, sorted on type then id, and
 * rejected outright if an identifier contains `|`, `,`, `:` or a control character.
 * That rejection is the reason this encoding is safe — without it two different
 * target sets could render to one string, and the duplicate action check would
 * block an unrelated Proposal or wave a real duplicate through. Reusing that
 * function rather than writing a second canonicaliser also means the Exception and
 * Proposal identities agree about what a Source_Record identifier may be.
 *
 * @throws {PolicyCheckError} for an empty action type, or one containing the
 * separator — it would make the two segments ambiguous.
 * @throws {ExceptionFingerprintError} for a ref that cannot be encoded.
 */
export function proposalTargetFingerprint(
  actionType: string,
  targets: readonly SourceRef[],
): string {
  if (typeof actionType !== 'string' || actionType.trim().length === 0) {
    throw new PolicyCheckError(
      `action_type must be a non-empty string, got ${JSON.stringify(actionType)}`,
    );
  }
  if (actionType !== actionType.trim() || actionType.includes(FINGERPRINT_SEPARATOR)) {
    throw new PolicyCheckError(
      `action_type ${JSON.stringify(actionType)} carries padding or the ` +
        `${FINGERPRINT_SEPARATOR} separator, so the fingerprint's two segments would be ` +
        `ambiguous and two different actions could render to one string`,
    );
  }
  if (targets.length === 0) {
    throw new PolicyCheckError(
      'a Proposal must name at least 1 target Source_Record; an action with no target has no ' +
        'identity, so the duplicate action Policy_Check could never recognise a repeat',
    );
  }
  const refs = canonicalSourceRefs(targets, 'target_source_records').map(refKey).join(',');
  return `${actionType}${FINGERPRINT_SEPARATOR}${refs}`;
}

/* -------------------------------------------------------------------------- */
/* 1. user permission (Requirement 5.3; Requirement 14.6)                     */
/* -------------------------------------------------------------------------- */

/**
 * Pass when the submitting session holds every Permission the submission requires.
 *
 * The granted set is an input, resolved by the FinanceOS_Authorization_Service
 * (task 26.2) — see FINDING 7. This check does not resolve Permissions and does not
 * read the database.
 *
 * A `policy_engine` actor fails. The Policy_Engine is the authorizing actor of
 * Requirement 5.6, never a submitter: Requirement 5.3 has an Agent submit and
 * Requirement 5.9 has the Action_Service resubmit on a User's approval. Nothing
 * grants the Policy_Engine a Permission, so an evaluation attributed to it would be
 * a self-authorising loop, and failing closed is the safe reading of a case the
 * spec does not describe.
 */
export function userPermissionCheck(input: PolicyCheckInput): PolicyCheckResult {
  const id: PolicyCheckId = 'user_permission';
  const { actor, granted_permissions: granted } = input.submission;
  const required = input.submission.required_permissions ?? [PROPOSAL_SUBMISSION_PERMISSION];

  if (actor.kind === 'policy_engine') {
    return fail(
      id,
      'the Policy_Engine is the authorizing actor of Requirement 5.6, not a submitter; a ' +
        'Proposal is submitted by an Agent (Requirement 5.3) or resubmitted by the ' +
        'Action_Service on a User approval (Requirement 5.9)',
    );
  }
  if (typeof actor.id !== 'string' || actor.id.trim().length === 0) {
    return fail(id, 'the submitting actor carries no identifier, so no Permission set resolves');
  }
  if (required.length === 0) {
    return fail(
      id,
      'no required Permission was stated; an unstated requirement is not an absent one ' +
        '(Requirement 14.6), so the submission is refused rather than waved through',
    );
  }

  const held = new Set(granted);
  const missing = required.filter((permission) => !held.has(permission));
  if (missing.length > 0) {
    return fail(
      id,
      `the submitting ${actor.kind} does not hold ${missing.join(', ')} in this Tenant ` +
        `(Requirement 14.6)`,
    );
  }
  return pass(id);
}

/* -------------------------------------------------------------------------- */
/* 2. accounting rule (Requirement 5.3; Requirement 2.1, 2.4, 2.6, 2.7)       */
/* -------------------------------------------------------------------------- */

/**
 * Pass when the Ledger_Entry set this Proposal would write satisfies the
 * Semantic_Ledger's rules, or when it states that it writes none.
 *
 * The rules are **not restated here.** `assertDraftWellFormed` from
 * `@/ledger/posting-rules` is the single definition of a structurally writable set —
 * 2..20 entries, every amount an integer paise strictly above 0, at least one
 * Source_Record link, a real `entry_date` (Requirement 2.1) — and its rejection
 * message is passed through as the detail so the gate says the same thing the ledger
 * would say. A second transcription would drift, and a Proposal that passed the gate
 * and was then rejected by `ledger_set_balanced` at write time is the worst of both.
 *
 * **Balance is checked separately, and deliberately so.** `assertDraftWellFormed`
 * does not check it: its doc comment routes Requirement 2.6 through `postSet`, which
 * has to *report* the imbalance rather than throw. So `imbalancePaise` — the same
 * function `postSet` uses, computed over `Paise` — is applied here, and the detail
 * carries the imbalance in paise and the Source_Record identifiers involved, exactly
 * as Requirement 2.6 requires the rejection reason to. An unbalanced set that
 * reached the write path would be refused by the `ledger_set_balanced` table
 * constraint, so leaving it to the database would turn a readable gate failure into
 * an opaque one.
 *
 * The one rule added on top belongs to Proposals rather than to drafts: where the
 * Proposal declares that it corrects a persisted set, the effect must be a
 * **reversing** set naming that set. Requirement 2.7 forbids modifying or deleting a
 * persisted Ledger_Entry and Requirement 2.4 gives the correction its only lawful
 * shape, so a correction that is not a reversal is not a correction.
 */
export function accountingRuleCheck(input: PolicyCheckInput): PolicyCheckResult {
  const id: PolicyCheckId = 'accounting_rule';
  const { ledger_effect: effect, corrects_ledger_set_id: corrects } = input.submission.proposal;

  if (statesNoLedgerEffect(effect)) {
    if (typeof corrects === 'string' && corrects.length > 0) {
      return fail(
        id,
        `the Proposal corrects Ledger_Entry set ${corrects} but states no Ledger_Entry effect; ` +
          `Requirement 2.4 admits a correction only as a new reversing set and Requirement 2.7 ` +
          `forbids modifying a persisted entry`,
      );
    }
    if (typeof effect.reason !== 'string' || effect.reason.trim().length === 0) {
      return fail(
        id,
        'the Proposal states no Ledger_Entry effect and gives no reason; an unexplained absence ' +
          'is indistinguishable from a forgotten effect',
      );
    }
    return pass(id, `writes no Ledger_Entry set: ${effect.reason}`);
  }

  try {
    assertDraftWellFormed(effect);
  } catch (error: unknown) {
    return fail(
      id,
      `the Ledger_Entry set this action would write is not writable: ${messageOf(error)} ` +
        `(Requirement 2.1, 2.6, 2.7)`,
    );
  }

  const imbalance = imbalancePaise(effect);
  if (imbalance !== 0n) {
    return fail(
      id,
      `the Ledger_Entry set this action would write is unbalanced by ${imbalance} paise over ` +
        `${effect.source_refs.map(refKey).join(', ')}; total debits must equal total credits ` +
        `(Requirement 2.6, 2.7)`,
    );
  }

  if (typeof corrects === 'string' && corrects.length > 0 && effect.reverses_set_id !== corrects) {
    return fail(
      id,
      `the Proposal corrects Ledger_Entry set ${corrects}, so its effect must be a reversing set ` +
        `naming that set (Requirement 2.4, 2.7); reverses_set_id is ` +
        `${JSON.stringify(effect.reverses_set_id ?? null)}`,
    );
  }
  return pass(id);
}

/* -------------------------------------------------------------------------- */
/* 3. transaction evidence (Requirement 5.3; Requirement 12.2, 12.3, 5.15)    */
/* -------------------------------------------------------------------------- */

/**
 * Target Source_Records the Evidence_Chain does not cite.
 *
 * Requirement 5.15 counts these into the risk score, and Requirement 12.2 wants
 * every contributing Source_Record identifier in the chain. Every target is absent
 * when the chain does not resolve at all — an unreadable chain evidences nothing.
 *
 * Exported so `src/policy/risk.ts` reads the same count the check computed instead
 * of re-deriving it from a second read of the chain.
 */
export function absentEvidenceRefs(
  targets: readonly SourceRef[],
  grounding: EvidenceGrounding | null,
): readonly SourceRef[] {
  const canonical = canonicalSourceRefs(targets, 'target_source_records');
  if (grounding === null) {
    return canonical;
  }
  const cited = new Set(grounding.cited_source_records.map(refKey));
  return canonical.filter((ref) => !cited.has(refKey(ref)));
}

/**
 * Pass when the Proposal's Evidence_Chain resolves and cites every target
 * Source_Record.
 *
 * `proposals.evidence_chain_id` is `NOT NULL`, so a chain that does not resolve is
 * an unreadable one rather than an absent reference — a foreign Tenant, a deleted
 * row, or a source that failed. Either way the Proposal's figures are ungrounded,
 * which is the condition Requirement 12.3 exists to refuse rather than paper over.
 */
export function transactionEvidenceCheck(input: PolicyCheckInput): PolicyCheckResult {
  const id: PolicyCheckId = 'transaction_evidence';
  const { proposal } = input.submission;
  const fact = input.facts.evidence;

  if (!fact.available) {
    return fail(
      id,
      `the Evidence_Chain ${proposal.evidence_chain_id} could not be read: ${fact.reason}`,
    );
  }
  if (fact.value === null) {
    return fail(
      id,
      `Evidence_Chain ${proposal.evidence_chain_id} does not resolve for this Tenant, so every ` +
        `figure in the Proposal is ungrounded (Requirement 12.2, 12.3)`,
    );
  }
  if (fact.value.evidence_chain_id !== proposal.evidence_chain_id) {
    return fail(
      id,
      `the grounding read back belongs to Evidence_Chain ${fact.value.evidence_chain_id}, not to ` +
        `the Proposal's ${proposal.evidence_chain_id}`,
    );
  }

  const absent = absentEvidenceRefs(proposal.target_source_records, fact.value);
  if (absent.length > 0) {
    return fail(
      id,
      `${absent.length} target Source_Record(s) are not cited by Evidence_Chain ` +
        `${proposal.evidence_chain_id}: ${absent.map(refKey).join(', ')} (Requirement 12.2)`,
    );
  }
  return pass(id);
}

/* -------------------------------------------------------------------------- */
/* 4. duplicate action (Requirement 5.13, verbatim)                           */
/* -------------------------------------------------------------------------- */

/** Requirement 5.13's window: the 30 days preceding the submission instant. */
export const DUPLICATE_LOOKBACK_DAYS = 30;

/** {@link DUPLICATE_LOOKBACK_DAYS} in milliseconds. */
export const DUPLICATE_LOOKBACK_MS = DUPLICATE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

/**
 * The `proposal_state` labels that make a prior Proposal a duplicate.
 *
 * Requirement 5.13 names "an executed Proposal or a Proposal awaiting approval".
 * The enum has 10 labels and more than 2 of them describe those 2 conditions — see
 * FINDING 1 for the full argument. Per label:
 *
 * - `awaiting_approval` — **included.** 5.13's second clause, verbatim.
 * - `authorized` — **included.** An Authorization is recorded and execution is
 *   imminent (Requirement 5.6, 5.9). Admitting a second Proposal here would let two
 *   identical actions execute moments apart, which is the harm the check names.
 * - `executed` — **included.** 5.13's first clause, verbatim.
 * - `verified` — **included.** A verified Proposal is an executed one whose VERIFY
 *   stage matched (Requirement 5.11). Its changes stand.
 * - `verification_failed` — **included.** Also post-EXECUTE: its changes stand and
 *   Requirement 5.12 makes no further automatic change, so a second identical
 *   action would apply the effect twice.
 * - `execution_failed` — **excluded.** Requirement 5.17 reverses every change
 *   already applied, so nothing stands to be duplicated. Including it would block a
 *   Tenant from remediating for 30 days.
 * - `proposed` — **excluded.** Not yet through the gate, so neither executed nor
 *   awaiting approval.
 * - `blocked` — **excluded.** Requirement 5.5 retains it without execution and
 *   changes no Tenant state.
 * - `rejected` — **excluded.** Requirement 5.10 discards it with no state change.
 * - `expired` — **excluded.** Requirement 5.16 withholds execution permanently, so
 *   nothing was applied.
 */
export const DUPLICATE_BLOCKING_STATES: readonly ProposalState[] = [
  'awaiting_approval',
  'authorized',
  'executed',
  'verified',
  'verification_failed',
];

/**
 * The instant a candidate became "executed" or "awaiting approval" in 5.13's sense:
 * `executed_at` where set, `created_at` otherwise. See FINDING 3 — neither document
 * fixes this, and the choice is stated rather than assumed.
 */
export function relevantInstantOf(candidate: PriorProposal): string {
  return typeof candidate.executed_at === 'string' && candidate.executed_at.length > 0
    ? candidate.executed_at
    : candidate.created_at;
}

/** The `[from, to]` window the lookback covers, both ISO-8601 UTC. */
export interface DuplicateLookbackWindow {
  readonly from: string;
  readonly to: string;
}

/** The 30 days ending at `submittedAt`, inclusive at both ends. */
export function duplicateLookbackWindow(submittedAt: string): DuplicateLookbackWindow {
  const to = requireInstant(submittedAt, 'submitted_at');
  return {
    from: new Date(to - DUPLICATE_LOOKBACK_MS).toISOString(),
    to: new Date(to).toISOString(),
  };
}

/**
 * What {@link PolicyFactSources.priorProposals} is asked for. **No tenant id** — the
 * adapter binds the session Tenant at construction (Requirement 12.7, 14.1).
 */
export interface DuplicateLookbackQuery {
  readonly target_fingerprint: string;
  readonly states: readonly ProposalState[];
  readonly window: DuplicateLookbackWindow;
  /** Excluded from the result: a Proposal is not its own duplicate. */
  readonly exclude_proposal_id?: string;
}

/**
 * The matching Proposal Requirement 5.13 requires recording, or `null`.
 *
 * Applies the rule **again**, over whatever the adapter returned, rather than
 * trusting the query to have filtered correctly: same fingerprint, a state in
 * {@link DUPLICATE_BLOCKING_STATES}, a relevant instant inside the window, and not
 * the Proposal under review. A store that widened its `WHERE` clause cannot turn an
 * unrelated Proposal into a duplicate, and one that narrowed it cannot hide a real
 * one from a test of this function.
 *
 * Ordering is deterministic and stated, because 5.13 says "the identifier of the
 * matching Proposal" and says nothing about several matches: the **most recent**
 * relevant instant wins, ties broken by ascending identifier. Two evaluations of one
 * Proposal over one dataset therefore record the same id.
 */
export function findDuplicateProposal(
  submission: PolicySubmission,
  candidates: readonly PriorProposal[],
): PriorProposal | null {
  const fingerprint = proposalTargetFingerprint(
    submission.proposal.action_type,
    submission.proposal.target_source_records,
  );
  const window = duplicateLookbackWindow(submission.submitted_at);
  const from = requireInstant(window.from, 'lookback window start');
  const to = requireInstant(window.to, 'lookback window end');
  const self = submission.proposal.id;

  const matches = candidates
    .filter((candidate) => {
      if (candidate.id === self) {
        return false;
      }
      if (candidate.target_fingerprint !== fingerprint) {
        return false;
      }
      if (!DUPLICATE_BLOCKING_STATES.includes(candidate.state)) {
        return false;
      }
      const at = instantMs(relevantInstantOf(candidate));
      return at !== null && at >= from && at <= to;
    })
    .sort((a, b) => {
      const aAt = instantMs(relevantInstantOf(a)) ?? 0;
      const bAt = instantMs(relevantInstantOf(b)) ?? 0;
      return bAt - aAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });

  return matches[0] ?? null;
}

/** The duplicate action check, with the matching Proposal identifier it recorded. */
export interface DuplicateActionOutcome {
  readonly check: PolicyCheckResult;
  readonly duplicate_proposal_id?: string;
}

/**
 * Requirement 5.13, in one function: fail when an executed or awaiting-approval
 * Proposal with the same action type and target Source_Record set exists for the
 * Tenant within the preceding 30 days, and record the matching Proposal id.
 */
export function duplicateActionCheck(input: PolicyCheckInput): DuplicateActionOutcome {
  const id: PolicyCheckId = 'duplicate_action';
  const fact = input.facts.prior_proposals;

  if (!fact.available) {
    return {
      check: fail(
        id,
        `the ${DUPLICATE_LOOKBACK_DAYS}-day duplicate lookback could not be read: ${fact.reason}`,
      ),
    };
  }

  const match = findDuplicateProposal(input.submission, fact.value);
  if (match === null) {
    return { check: pass(id) };
  }
  return {
    check: fail(
      id,
      `Proposal ${match.id} carries the same action type and target Source_Records, is ` +
        `${match.state}, and dates from ${relevantInstantOf(match)} — inside the preceding ` +
        `${DUPLICATE_LOOKBACK_DAYS} days (Requirement 5.13)`,
    ),
    duplicate_proposal_id: match.id,
  };
}

/* -------------------------------------------------------------------------- */
/* 5. risk threshold (Requirement 5.4, 5.15; and 5.6/5.7 by elimination)      */
/* -------------------------------------------------------------------------- */

/**
 * Pass when the risk score and the Auto_Execute_Threshold are both integers in
 * 0..100, so the comparison Requirement 5.15 requires can be made.
 *
 * **It does not fail on `risk_score > auto_execute_threshold`** — see the module doc
 * comment: that reading makes Requirement 5.7 unsatisfiable. Ordering the two is
 * `src/policy/decide.ts`'s job (task 22.2).
 */
export function riskThresholdCheck(input: PolicyCheckInput): PolicyCheckResult {
  const id: PolicyCheckId = 'risk_threshold';
  const { risk_score: score, auto_execute_threshold: threshold } = input.submission;

  const problems: string[] = [];
  if (!isScore(score)) {
    problems.push(
      `the Proposal risk score must be an integer from 0 to 100, got ${JSON.stringify(score)}`,
    );
  }
  if (!isScore(threshold)) {
    problems.push(
      `the Auto_Execute_Threshold must be an integer from 0 to 100, got ` +
        `${JSON.stringify(threshold)}`,
    );
  }
  if (problems.length > 0) {
    return fail(
      id,
      `${problems.join('; ')} (Requirement 5.15); the threshold comparison cannot be made, so ` +
        `the gate is not applied`,
    );
  }
  return pass(id);
}

/* -------------------------------------------------------------------------- */
/* 6. approval requirement (Requirement 5.9, 5.10, 5.14, 5.16, 5.17)          */
/* -------------------------------------------------------------------------- */

/** Requirement 5.16's Approval_Window bounds, in hours. */
export const APPROVAL_WINDOW_MIN_HOURS = 1;
export const APPROVAL_WINDOW_MAX_HOURS = 168;

/**
 * Pass when the approval the Proposal's current state requires is on record.
 *
 * The five requirements this is derived from each fix one row of the mapping. The
 * check is not "does this Proposal need approval?" — Requirements 5.6 and 5.7 derive
 * that from the risk score afterwards — but "may this Proposal proceed, given the
 * approval it does or does not hold?":
 *
 * | State | Result | Why |
 * |---|---|---|
 * | `proposed`, `blocked` | pass | nothing is approved yet, and nothing has executed. 5.6/5.7 raise the requirement; 5.5 retains a blocked Proposal for re-evaluation |
 * | `awaiting_approval` | pass only with a recorded approval inside the Approval_Window | 5.9 records the Authorization and resubmits; 5.16 expires an unanswered one |
 * | `authorized` | pass only with a recorded approval | 5.14: every Proposal reaching EXECUTE has an Authorization |
 * | `execution_failed` | pass only with an approval recorded **after** `executed_at` | 5.17 requires a *new* Authorization before any retry |
 * | `rejected` | fail | 5.10 discards it without execution |
 * | `expired` | fail | 5.16 withholds execution permanently |
 * | `executed`, `verified`, `verification_failed` | fail | already executed; a second run would apply the effect twice (5.11, 5.12) |
 *
 * A recorded **rejection** fails the check wherever it appears: Requirement 5.10
 * discards the Proposal, and a later approval cannot un-discard it.
 *
 * The Approval_Window is checked where it was resolved: outside 1..168 hours no
 * lawful `approval_deadline` can be set (Requirement 5.16), so a Proposal that would
 * need approval could never be answered in time.
 */
export function approvalRequirementCheck(input: PolicyCheckInput): PolicyCheckResult {
  const id: PolicyCheckId = 'approval_requirement';
  const { proposal, approval_window_hours: windowHours } = input.submission;

  if (!(PROPOSAL_STATES as readonly string[]).includes(proposal.state)) {
    return fail(id, `${JSON.stringify(proposal.state)} is not a proposal_state label`);
  }
  if (windowHours !== undefined && windowHours !== null) {
    if (
      !Number.isInteger(windowHours) ||
      windowHours < APPROVAL_WINDOW_MIN_HOURS ||
      windowHours > APPROVAL_WINDOW_MAX_HOURS
    ) {
      return fail(
        id,
        `the Approval_Window must be an integer from ${APPROVAL_WINDOW_MIN_HOURS} to ` +
          `${APPROVAL_WINDOW_MAX_HOURS} hours (Requirement 5.16), got ` +
          `${JSON.stringify(windowHours)}; no lawful approval_deadline can be set`,
      );
    }
  }

  switch (proposal.state) {
    case 'rejected':
      return fail(
        id,
        'the Proposal was rejected and discarded without execution (Requirement 5.10)',
      );
    case 'expired':
      return fail(
        id,
        'the Approval_Window elapsed with no decision, so execution is withheld permanently ' +
          '(Requirement 5.16)',
      );
    case 'executed':
    case 'verified':
    case 'verification_failed':
      return fail(
        id,
        `the Proposal is already ${proposal.state}; its changes stand and a second execution ` +
          `would apply the effect twice (Requirement 5.11, 5.12)`,
      );
    default:
      break;
  }

  const fact = input.facts.authorizations;
  const needsApproval =
    proposal.state === 'awaiting_approval' ||
    proposal.state === 'authorized' ||
    proposal.state === 'execution_failed';

  if (!needsApproval) {
    // `proposed` and `blocked`. A rejection already on record still discards it.
    if (fact.available && fact.value.some((a) => a.decision === 'rejected')) {
      return fail(
        id,
        'a rejection is already recorded against this Proposal, which discards it without ' +
          'execution (Requirement 5.10)',
      );
    }
    return pass(id);
  }

  if (!fact.available) {
    return fail(
      id,
      `the Proposal is ${proposal.state}, so a recorded Authorization is required ` +
        `(Requirement 5.14), and the Authorizations could not be read: ${fact.reason}`,
    );
  }
  if (fact.value.some((a) => a.decision === 'rejected')) {
    return fail(
      id,
      'a rejection is recorded against this Proposal, which discards it without execution ' +
        '(Requirement 5.10)',
    );
  }

  const approvals = fact.value.filter((a) => a.decision === 'approved');
  if (approvals.length === 0) {
    return fail(
      id,
      `the Proposal is ${proposal.state} and no Authorization is recorded against it; ` +
        `Requirement 5.14 requires one for every Proposal reaching EXECUTE`,
    );
  }

  if (proposal.state === 'awaiting_approval') {
    const deadline = instantMs(proposal.approval_deadline);
    if (deadline === null) {
      return fail(
        id,
        'the Proposal is awaiting approval but carries no approval_deadline, so the ' +
          'Approval_Window of Requirement 5.16 cannot be honoured',
      );
    }
    const inTime = approvals.some((a) => {
      const at = instantMs(a.decided_at);
      return at !== null && at <= deadline;
    });
    if (!inTime) {
      return fail(
        id,
        `every recorded approval is dated after the approval_deadline ` +
          `${proposal.approval_deadline}; an approval outside the Approval_Window does not ` +
          `permit execution (Requirement 5.16)`,
      );
    }
    return pass(id);
  }

  if (proposal.state === 'execution_failed') {
    const failedAt = instantMs(proposal.executed_at);
    if (failedAt === null) {
      return fail(
        id,
        'the Proposal is execution_failed but carries no executed_at, so "a new Authorization" ' +
          'cannot be told from the one that authorized the failed attempt (Requirement 5.17)',
      );
    }
    const renewed = approvals.some((a) => {
      const at = instantMs(a.decided_at);
      return at !== null && at > failedAt;
    });
    if (!renewed) {
      return fail(
        id,
        `execution failed at ${proposal.executed_at} and no Authorization has been recorded ` +
          `since; Requirement 5.17 requires a new Authorization before any retry`,
      );
    }
    return pass(id);
  }

  // `authorized`: an approval is on record, which is what Requirement 5.14 asks.
  return pass(id);
}

/* -------------------------------------------------------------------------- */
/* Running all six                                                            */
/* -------------------------------------------------------------------------- */

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Evaluate all six checks over resolved facts. **Pure**: no clock, no I/O, no
 * database.
 *
 * Every check runs, in {@link POLICY_CHECK_IDS} order, inside its own `try`. A check
 * that throws becomes that check's `fail` and nothing else — Requirement 5.3's
 * independence, enforced rather than intended. The result always holds exactly
 * {@link POLICY_CHECK_COUNT} entries.
 *
 * `elapsed_ms` is 0 and `timed_out` is false: this function does no waiting. Use
 * {@link runPolicyChecks} for the bounded, fact-gathering path.
 */
export function evaluatePolicyChecks(input: PolicyCheckInput): PolicyChecksOutcome {
  const results: PolicyCheckResult[] = [];
  let duplicateProposalId: string | undefined;

  const isolate = (id: PolicyCheckId, evaluate: () => PolicyCheckResult): void => {
    try {
      results.push(evaluate());
    } catch (error: unknown) {
      results.push(fail(id, `this Policy_Check could not be evaluated: ${messageOf(error)}`));
    }
  };

  isolate('user_permission', () => userPermissionCheck(input));
  isolate('accounting_rule', () => accountingRuleCheck(input));
  isolate('transaction_evidence', () => transactionEvidenceCheck(input));
  isolate('duplicate_action', () => {
    const outcome = duplicateActionCheck(input);
    duplicateProposalId = outcome.duplicate_proposal_id;
    return outcome.check;
  });
  isolate('risk_threshold', () => riskThresholdCheck(input));
  isolate('approval_requirement', () => approvalRequirementCheck(input));

  let absentEvidenceCount = input.submission.proposal.target_source_records.length;
  try {
    const grounding = input.facts.evidence.available ? input.facts.evidence.value : null;
    absentEvidenceCount = absentEvidenceRefs(
      input.submission.proposal.target_source_records,
      grounding,
    ).length;
  } catch {
    // A target set that cannot be canonicalised has already failed the evidence
    // check; the count stays at "every target absent", the worst case, so
    // `risk.ts` cannot read a smaller number than the truth.
  }

  return {
    checks: results,
    ...(duplicateProposalId === undefined ? {} : { duplicate_proposal_id: duplicateProposalId }),
    absent_evidence_count: absentEvidenceCount,
    elapsed_ms: 0,
    timed_out: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Fact gathering, inside the 10-second bound (Requirement 5.3)               */
/* -------------------------------------------------------------------------- */

/** Requirement 5.3's bound: the evaluation returns within 10 seconds of submission. */
export const POLICY_EVALUATION_BUDGET_MS = 10_000;

/**
 * The three reads the six checks need. Implemented by an adapter that binds the
 * session Tenant at construction — **no method takes a tenant id** (Requirement
 * 12.7, 14.1), and a foreign row is an absent row, never an error that would confirm
 * its existence (Requirement 14.4).
 *
 * Each method is handed the deadline `signal`, so an implementation whose I/O
 * accepts one is genuinely cancelled rather than merely abandoned — the same honest
 * bound `src/tools/tool.ts` documents for `ToolContext.signal`.
 */
export interface PolicyFactSources {
  /** `evidence_chains` + `evidence_chain_sources`. `null` when it does not resolve. */
  evidenceGrounding(chainId: string, signal: AbortSignal): Promise<EvidenceGrounding | null>;
  /** {@link DUPLICATE_ACTION_LOOKBACK_SQL}. */
  priorProposals(
    query: DuplicateLookbackQuery,
    signal: AbortSignal,
  ): Promise<readonly PriorProposal[]>;
  /** `authorizations` for one Proposal. Empty for a Proposal not yet persisted. */
  recordedAuthorizations(
    proposalId: string,
    signal: AbortSignal,
  ): Promise<readonly RecordedAuthorization[]>;
}

/**
 * The duplicate lookback (Requirement 5.13). Parameters:
 * `($1 tenant_id, $2 target_fingerprint, $3 states text[], $4 window_from, $5 window_to,
 * $6 exclude_proposal_id or NULL)`.
 *
 * `$1` is bound by the adapter from the session Tenant, never from a caller argument
 * — the same convention as `EXCEPTION_UPSERT_SQL`. It is belt-and-braces beside the
 * RLS policies of task 26.1 rather than a substitute for them.
 *
 * `coalesce(executed_at, created_at)` is the relevant instant of FINDING 3, and the
 * window is closed at both ends. `state = ANY($3::proposal_state[])` carries the
 * label list rather than hardcoding it, so {@link DUPLICATE_BLOCKING_STATES} stays
 * the single definition. The `ORDER BY` matches {@link findDuplicateProposal}'s
 * tie-break, so the adapter and the pure rule agree about which match is recorded
 * even though the rule re-applies the filter regardless.
 */
export const DUPLICATE_ACTION_LOOKBACK_SQL = `
SELECT id, action_type, target_fingerprint, state, created_at, executed_at
  FROM proposals
 WHERE tenant_id = $1
   AND target_fingerprint = $2
   AND state = ANY($3::proposal_state[])
   AND coalesce(executed_at, created_at) >= $4
   AND coalesce(executed_at, created_at) <= $5
   AND ($6::uuid IS NULL OR id <> $6::uuid)
 ORDER BY coalesce(executed_at, created_at) DESC, id ASC`.trim();

/**
 * The parameter tuple {@link DUPLICATE_ACTION_LOOKBACK_SQL} expects, in order.
 *
 * `tenantId` is the adapter's own session Tenant. It appears here because the
 * statement needs it, not because a caller supplies it.
 */
export function duplicateLookbackParams(
  tenantId: TenantId,
  query: DuplicateLookbackQuery,
): readonly [TenantId, string, readonly ProposalState[], string, string, string | null] {
  return [
    tenantId,
    query.target_fingerprint,
    query.states,
    query.window.from,
    query.window.to,
    query.exclude_proposal_id ?? null,
  ];
}

async function gather<T>(
  what: string,
  work: () => Promise<T>,
  overrun: Promise<never>,
): Promise<Fact<T>> {
  try {
    const value = await Promise.race([work(), overrun]);
    return { available: true, value };
  } catch (error: unknown) {
    return { available: false, reason: `${what}: ${messageOf(error)}` };
  }
}

/**
 * Gather the facts, then evaluate all six checks, within
 * {@link POLICY_EVALUATION_BUDGET_MS} of submission (Requirement 5.3).
 *
 * The three reads run concurrently under one deadline, so the budget bounds the
 * whole evaluation rather than each read. On overrun the facts that arrived are
 * used and the checks that needed the others fail closed with a detail naming the
 * overrun — six results either way, and a derived decision of `block`. See the
 * module doc comment and FINDING 6 for why an overrun is not thrown.
 *
 * A source that rejects fails only the checks that read it. `recordedAuthorizations`
 * is not called at all for a Proposal with no `id`: an unpersisted Proposal cannot
 * have an Authorization, and an empty list is the fact, not a missing one.
 *
 * @throws {PolicyCheckError} only for a `submitted_at` that is not an instant, or a
 * target set that has no fingerprint — neither is a check result, and neither can be
 * evaluated around.
 */
export async function runPolicyChecks(
  submission: PolicySubmission,
  sources: PolicyFactSources,
  options?: { readonly budgetMs?: number; readonly now?: () => number },
): Promise<PolicyChecksOutcome> {
  const budgetMs = options?.budgetMs ?? POLICY_EVALUATION_BUDGET_MS;
  const clock = options?.now ?? (() => Date.now());
  const startedAt = clock();

  // Raised before any I/O: an unusable submission instant or target set would make
  // every duplicate answer meaningless, and a gate that cannot be applied must not
  // look like a gate that passed.
  const window = duplicateLookbackWindow(submission.submitted_at);
  const fingerprint = proposalTargetFingerprint(
    submission.proposal.action_type,
    submission.proposal.target_source_records,
  );

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const overrun = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(
        new PolicyCheckError(`policy evaluation exceeded its ${budgetMs} ms bound`),
      );
      reject(new PolicyCheckError(`exceeded the ${budgetMs} ms evaluation bound`));
    }, budgetMs);
  });
  // Attached before the race so a rejection arriving after a fact already settled
  // cannot surface as an unhandled rejection.
  overrun.catch(() => undefined);

  const proposalId = submission.proposal.id;
  const query: DuplicateLookbackQuery = {
    target_fingerprint: fingerprint,
    states: DUPLICATE_BLOCKING_STATES,
    window,
    ...(proposalId === undefined ? {} : { exclude_proposal_id: proposalId }),
  };

  let facts: PolicyFacts;
  try {
    const [evidence, prior_proposals, authorizations] = await Promise.all([
      gather(
        'reading the Evidence_Chain grounding',
        () =>
          sources.evidenceGrounding(submission.proposal.evidence_chain_id, controller.signal),
        overrun,
      ),
      gather(
        `reading the ${DUPLICATE_LOOKBACK_DAYS}-day duplicate lookback`,
        () => sources.priorProposals(query, controller.signal),
        overrun,
      ),
      proposalId === undefined
        ? Promise.resolve<Fact<readonly RecordedAuthorization[]>>({
            available: true,
            value: [],
          })
        : gather(
            'reading the recorded Authorizations',
            () => sources.recordedAuthorizations(proposalId, controller.signal),
            overrun,
          ),
    ]);
    facts = { evidence, prior_proposals, authorizations };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }

  const outcome = evaluatePolicyChecks({ submission, facts });
  return { ...outcome, elapsed_ms: clock() - startedAt, timed_out: timedOut };
}
