/**
 * The one decision (task 22.2, second half).
 * Requirements 5.4, 5.5, 5.6, 5.7, 5.14, 5.15.
 *
 * `./checks.ts` is the gate and `./risk.ts` is the number. This module is the
 * **derivation**: six check results plus a risk score plus the Auto_Execute_Threshold
 * in, exactly one of `block`, `auto_execute` or `require_approval` out, an
 * Authorization naming the Policy_Engine written on the automatic path, and the gate
 * picture persisted on the Proposal.
 *
 * design.md's `decide` is four lines and they are transcribed rather than improved on:
 *
 * ```ts
 * if (checks.length !== 6) throw new Error('policy evaluation incomplete');
 * if (checks.some(c => c.result === 'fail')) return 'block';        // Requirement 5.5
 * if (risk <= threshold)                     return 'auto_execute'; // Requirement 5.6
 * return 'require_approval';                                        // Requirement 5.7
 * ```
 *
 * ## Why the incomplete set throws instead of blocking
 *
 * `block` is a **verdict about a Proposal**: Requirement 5.5 retains it, records the
 * failed check identifiers and changes no Tenant state, and a User reading a blocked
 * Proposal is entitled to conclude that six checks ran and at least one failed. Fewer
 * than six checks is not that. It is a caller that has not evaluated the gate — a
 * programming fault — and returning `block` would file it as a Tenant-visible policy
 * outcome, indistinguishable from a real failure. So it raises
 * {@link PolicyDecisionError}. {@link isCompletePolicyCheckSet} from `./checks.ts` is
 * the predicate, which is stricter than design.md's `length !== 6` in the direction
 * that matters: six results that repeat an id, or carry an unknown one, are also not
 * a complete gate even though they count to six.
 *
 * ## `risk <= threshold` is only ever reached with two real numbers
 *
 * `null <= 0` is **true** in JavaScript: `null` coerces to `0`. A Proposal whose risk
 * score could not be computed would therefore auto-execute at the default threshold
 * of 0 if the comparison were reached with a `null` in it — the worst possible failure
 * of this module, arrived at by doing nothing wrong syntactically. Two things prevent
 * it, deliberately belt-and-braces:
 *
 * 1. the risk threshold Policy_Check fails when either operand is not an integer
 *    0..100 (`./checks.ts`), so an unscored Proposal is already `block` by
 *    Requirement 5.5 before the comparison is reached; and
 * 2. {@link decidePolicy} nonetheless re-asserts both operands with
 *    {@link isRiskScore} after the block branch and raises rather than comparing. A
 *    caller that passed all-pass checks alongside a `null` score has contradicted
 *    itself, and that contradiction is louder as an exception than as an execution.
 *
 * ## The Authorization is written before execution begins
 *
 * Requirement 5.6 has the Policy_Engine record an Authorization identifying itself as
 * the authorizing actor; Requirement 5.14 makes "every Proposal reaching EXECUTE has
 * an Authorization record" an invariant over the Audit_Log, which property P8 (task
 * 23.6) proves. {@link recordPolicyDecision} therefore writes the `authorizations`
 * row **first** and persists the decision afterwards, and it is the only order that
 * cannot break the invariant: if the write fails, nothing is authorized and nothing
 * executes; if the persistence then fails, the caller gets an exception and still
 * nothing executes, because execution is the Action_Service's separate step and it
 * refuses to run without a resolvable Authorization (task 23.2). The reverse order
 * has a window in which a Proposal is recorded as auto-executed with no Authorization
 * behind it, which is precisely the state P8 exists to rule out.
 *
 * `actor_kind = 'policy_engine'` with `actor_user_id` NULL is the shape the
 * `authorizations` CHECK admits — `(actor_kind = 'user') = (actor_user_id IS NOT NULL)`
 * — so the automatic actor is unrepresentable as a User and no User is ever implicated
 * in a decision they did not make.
 *
 * ## What is persisted, and what is deliberately not
 *
 * Task 22.2 names three columns: the six check results, the risk score and the
 * threshold used. {@link PROPOSAL_DECISION_UPDATE_SQL} writes exactly those three and
 * nothing else. `proposals.state` is **not** written here — see FINDING 3 — and
 * neither is `approval_deadline`, which needs the Approval_Window of Requirement 5.16
 * and belongs to the FinanceOS_Action_Service (task 23.1, 23.5).
 *
 * ## FINDINGS — reported, not silently patched
 *
 * 1. **`test/db/proposals-authorizations.test.ts` writes a different `policy_checks`
 *    shape.** Its fixture inserts `[{"name":"user_permission","passed":true}]`, while
 *    design.md's `PolicyDecision.checks` — and therefore `./checks.ts`'s
 *    `PolicyCheckResult` and {@link policyChecksJson} below — is
 *    `{ id, result: 'pass' | 'fail', detail? }`. This module follows design.md, so a
 *    reader of that column will find `id`/`result`, not `name`/`passed`. The fixture
 *    should be aligned when task 21.1's test is next touched; changing it is outside
 *    this task, and task 27.1's approval queue will otherwise read a key that is not
 *    there. `policy_checks` is untyped `JSONB` with no constraint, so nothing in the
 *    database notices the divergence. (22.1 recorded the same conflict as its FINDING
 *    5; it is repeated here because this is the module that does the writing.)
 * 2. **Requirement 5.4 requires returning "the computed Proposal risk score", and it
 *    is not always computable.** An action type outside design.md's three has no
 *    points at all (`./risk.ts` FINDING 1). {@link PolicyDecision.risk_score} is
 *    therefore `number | null` where design.md's interface says `number`: `null` says
 *    "not computable" and appears **only** on the `block` path, since an absent score
 *    fails the risk threshold check. `proposals.risk_score` is nullable, so it
 *    persists as SQL NULL. Scoring the unknown case as 0 would have been the
 *    alternative, and 0 is a real score meaning "least risky" — at the default
 *    threshold of 0 it auto-executes.
 * 3. **Nothing states which `proposal_state` a decision moves the Proposal to.**
 *    `blocked`, `awaiting_approval` and `authorized` map onto the three decisions so
 *    obviously that {@link proposalStateForDecision} is exported for whoever applies
 *    it — but this module does **not** write it, because a blind write would be
 *    destructive: a resubmission of an already-executed Proposal fails the approval
 *    requirement check (Requirement 5.11, 5.12), and `UPDATE ... SET state = 'blocked'`
 *    would then overwrite the record of the evaluation that authorized the execution
 *    that already happened. The state machine belongs to the FinanceOS_Action_Service
 *    (Requirement 5.8–5.10, 5.16, 5.17), which knows what stage it is in.
 *    {@link DECIDABLE_STATES} is the same argument applied to the columns this module
 *    *does* write: the update matches only a Proposal that has not executed, so a late
 *    evaluation cannot overwrite the gate picture of the one that did.
 * 4. **Requirement 5.5's "no change to Tenant state" versus persisting the gate
 *    picture.** Writing `policy_checks`, `risk_score` and `threshold_used` on a
 *    blocked Proposal is a write, and it is read here as recording the evaluation
 *    rather than changing Tenant state: no Ledger_Entry, no Razorpay call, no
 *    Exception lifecycle change, and the Proposal is retained exactly as 5.5 requires.
 *    Requirement 5.4 obliges the Policy_Engine to return all six results, task 21.1
 *    created the columns to hold them, and `docs/08_UI_UX_SPEC.md` renders all six on
 *    a blocked Proposal specifically — a gate picture that is not persisted cannot be
 *    rendered. Flagged because "no change to Tenant state" read at its widest would
 *    forbid it.
 * 5. **The risk score's third input is an output of the gate.** Requirement 5.15
 *    computes the score partly from the count of absent Evidence_Chain Source_Records,
 *    and that count is produced by the transaction evidence check — while the risk
 *    threshold check needs a score as its input. {@link authorizeProposal} resolves
 *    the circle without reading the Evidence_Chain twice, and the argument that it is
 *    exact is written out at that function rather than left implicit.
 *
 * ## Scope
 *
 * - **No Audit_Event is appended here.** Requirement 5.2 appends one per completed
 *   Action_Pipeline stage through the FinanceOS_Audit_Service, whose serialized
 *   per-Tenant sequence is tasks 25.x. The AUTHORIZE stage event is that service's,
 *   and this module returning a decision is what it records.
 * - **No execution.** `auto_execute` is a decision plus an Authorization. The EXECUTE
 *   stage is the FinanceOS_Action_Service's (tasks 23.2, 24.3).
 * - **No store adapter.** `proposals` and `authorizations` are RLS `ENABLE`d and
 *   `FORCE`d with no policies until task 26.1 and no Postgres driver can be added, so
 *   this module exports the two statements an adapter runs and the
 *   {@link PolicyDecisionStore} seam it implements — the same precedent as
 *   `EXCEPTION_UPSERT_SQL` and 22.1's `DUPLICATE_ACTION_LOOKBACK_SQL`. Neither
 *   statement's parameters include a Tenant supplied by a caller: `$1` is the
 *   adapter's own session Tenant (Requirement 12.7, 14.1).
 */

import type { TenantId } from '@/config/configuration-service';

import {
  anyCheckFailed,
  failedCheckIds,
  isCompletePolicyCheckSet,
  POLICY_CHECK_COUNT,
  type PolicyCheckId,
  type PolicyCheckResult,
  type PolicyFactSources,
  type PolicySubmission,
  type ProposalState,
  runPolicyChecks,
} from './checks';
import { isRiskScore, riskScore, RiskScoreError, riskScoreFromChecks } from './risk';

/* -------------------------------------------------------------------------- */
/* The decision                                                               */
/* -------------------------------------------------------------------------- */

/** Requirement 5.4's "exactly one decision", in design.md's order. */
export const POLICY_DECISIONS = ['block', 'auto_execute', 'require_approval'] as const;

export type PolicyDecisionKind = (typeof POLICY_DECISIONS)[number];

/** Thrown when a decision cannot be derived from what the caller supplied. */
export class PolicyDecisionError extends Error {
  override readonly name = 'PolicyDecisionError';
}

/** What {@link decidePolicy} needs: the gate's output and the two operands. */
export interface PolicyDecisionInput {
  /** Exactly {@link POLICY_CHECK_COUNT} results, one per Policy_Check id. */
  readonly checks: readonly PolicyCheckResult[];
  /** Requirement 5.15's score, or `null` where it was not computable (FINDING 2). */
  readonly risk_score: number | null;
  /** The Auto_Execute_Threshold used. Integer 0..100, default 0. `null` if unresolved. */
  readonly auto_execute_threshold: number | null;
  /** Carried through from the gate when the duplicate action check failed. */
  readonly duplicate_proposal_id?: string;
}

/**
 * design.md's `PolicyDecision`, with two additions it does not name and Requirement 5
 * does: `failed_check_ids`, which Requirement 5.5 requires be recorded, and a nullable
 * `risk_score` (FINDING 2).
 */
export interface PolicyDecision {
  /** Exactly 6, in `POLICY_CHECK_IDS` order, whatever the decision. */
  readonly checks: readonly PolicyCheckResult[];
  /** Requirement 5.5's "identifier of each failed Policy_Check". Empty on a pass-all. */
  readonly failed_check_ids: readonly PolicyCheckId[];
  readonly risk_score: number | null;
  readonly auto_execute_threshold: number | null;
  readonly decision: PolicyDecisionKind;
  /** Set once the Authorization of Requirement 5.6 is on record. */
  readonly authorization_id?: string;
  /** Set when the duplicate action check failed (Requirement 5.13). */
  readonly duplicate_proposal_id?: string;
}

/**
 * Requirements 5.5, 5.6 and 5.7 as one total function. Pure: no clock, no I/O.
 *
 * The three branches are mutually exclusive and jointly exhaustive over a complete
 * check set with two comparable operands, so exactly one decision comes back — which
 * is what Requirement 5.4 asks for in those words.
 *
 * @throws {PolicyDecisionError} when the check set is not complete (see the module
 * doc comment), or when the checks all pass but the score and the threshold are not
 * both integers 0..100 — a self-contradictory input, since the risk threshold
 * Policy_Check fails on exactly that condition.
 */
export function decidePolicy(input: PolicyDecisionInput): PolicyDecision {
  const { checks, risk_score, auto_execute_threshold } = input;

  if (!isCompletePolicyCheckSet(checks)) {
    throw new PolicyDecisionError(
      `policy evaluation incomplete: ${checks.length} of ${POLICY_CHECK_COUNT} Policy_Check ` +
        `results, ids [${checks.map((c) => c.id).join(', ')}]. All ${POLICY_CHECK_COUNT} are ` +
        `evaluated independently and the decision is derived afterwards (Requirement 5.3, 5.4), ` +
        `so a short set is a caller fault and not a blocked Proposal`,
    );
  }

  const decided = {
    checks,
    failed_check_ids: failedCheckIds(checks),
    risk_score,
    auto_execute_threshold,
    ...(input.duplicate_proposal_id === undefined
      ? {}
      : { duplicate_proposal_id: input.duplicate_proposal_id }),
  };

  // Requirement 5.5. Ordered first, so an unscored Proposal never reaches the
  // comparison below.
  if (anyCheckFailed(checks)) {
    return { ...decided, decision: 'block' };
  }

  if (!isRiskScore(risk_score) || !isRiskScore(auto_execute_threshold)) {
    throw new PolicyDecisionError(
      `all ${POLICY_CHECK_COUNT} Policy_Checks passed, which includes the risk threshold check, ` +
        `so the risk score and the Auto_Execute_Threshold must both be integers from 0 to 100 ` +
        `(Requirement 5.15); got ${JSON.stringify(risk_score)} and ` +
        `${JSON.stringify(auto_execute_threshold)}. Comparing them anyway would auto-execute an ` +
        `unscored Proposal, because null <= 0 is true`,
    );
  }

  // Requirement 5.6 at or below, Requirement 5.7 above. `<=` is load-bearing: the
  // Auto_Execute_Threshold is the boundary "at or below which" a Proposal is a
  // Safe_Action, so a score exactly equal to it auto-executes.
  return {
    ...decided,
    decision: risk_score <= auto_execute_threshold ? 'auto_execute' : 'require_approval',
  };
}

/**
 * The `proposal_state` each decision implies. Exported for the FinanceOS_Action_Service,
 * which owns the transition — this module does not write it. See FINDING 3.
 */
export function proposalStateForDecision(decision: PolicyDecisionKind): ProposalState {
  switch (decision) {
    case 'block':
      return 'blocked'; // Requirement 5.5: retained, not executed
    case 'require_approval':
      return 'awaiting_approval'; // Requirement 5.7, 5.8: the Approval_Window starts
    default:
      return 'authorized'; // Requirement 5.6: an Authorization is on record
  }
}

/* -------------------------------------------------------------------------- */
/* Persisting the gate picture (Requirement 5.4)                              */
/* -------------------------------------------------------------------------- */

/**
 * The states from which an evaluation may be recorded on a Proposal.
 *
 * Every one of them is pre-execution, which is the point: a Proposal that has already
 * executed carries the gate picture of the evaluation that authorized it, and a later
 * evaluation — which fails the approval requirement check and therefore blocks — must
 * not overwrite it. `executed`, `verified` and `verification_failed` are excluded for
 * that reason; `rejected` and `expired` because Requirements 5.10 and 5.16 discard the
 * Proposal, so there is nothing left to re-evaluate. The four included states are the
 * ones the requirements re-submit from: a first submission (`proposed`), a
 * re-evaluation after a block (5.5 retains it), the resubmission on approval (5.9),
 * and the retry after a failed execution with a new Authorization (5.17).
 */
export const DECIDABLE_STATES: readonly ProposalState[] = [
  'proposed',
  'blocked',
  'awaiting_approval',
  'authorized',
];

/**
 * `proposals.policy_checks`, in design.md's shape: an array of
 * `{ id, result, detail? }` in `POLICY_CHECK_IDS` order.
 *
 * A plain `JSON.stringify` of the results the gate returned, with no key renaming and
 * no field dropped — `detail` is what makes a blocked Proposal legible to a User, so
 * it is persisted, not summarised. See FINDING 1 for the fixture that disagrees.
 */
export function policyChecksJson(checks: readonly PolicyCheckResult[]): string {
  return JSON.stringify(
    checks.map((check) => ({
      id: check.id,
      result: check.result,
      ...(check.detail === undefined ? {} : { detail: check.detail }),
    })),
  );
}

/**
 * The three columns task 22.2 names, and no others. Parameters:
 * `($1 tenant_id, $2 proposal_id, $3 policy_checks json, $4 risk_score, $5 threshold_used,
 * $6 states text[])`.
 *
 * `$1` is the adapter's session Tenant, never a caller argument — belt-and-braces
 * beside the RLS policies of task 26.1, exactly as `DUPLICATE_ACTION_LOOKBACK_SQL`
 * treats it. `$6` carries {@link DECIDABLE_STATES} rather than hardcoding the labels,
 * so that list stays the single definition.
 *
 * `RETURNING id, state` matters: zero rows means the Proposal does not exist for this
 * Tenant or has moved past a decidable state, and an adapter must surface that rather
 * than treat a silent no-op as a successful persist.
 */
export const PROPOSAL_DECISION_UPDATE_SQL = `
UPDATE proposals
   SET policy_checks  = $3::jsonb,
       risk_score     = $4,
       threshold_used = $5
 WHERE tenant_id = $1
   AND id = $2::uuid
   AND state = ANY($6::proposal_state[])
RETURNING id, state`.trim();

/** The parameter tuple {@link PROPOSAL_DECISION_UPDATE_SQL} expects, in order. */
export function proposalDecisionUpdateParams(
  tenantId: TenantId,
  proposalId: string,
  decision: PolicyDecision,
): readonly [TenantId, string, string, number | null, number | null, readonly ProposalState[]] {
  return [
    tenantId,
    proposalId,
    policyChecksJson(decision.checks),
    decision.risk_score,
    decision.auto_execute_threshold,
    DECIDABLE_STATES,
  ];
}

/**
 * The Authorization of Requirement 5.6: the Policy_Engine as the authorizing actor.
 * Parameters: `($1 tenant_id, $2 proposal_id, $3 decided_at)`.
 *
 * `actor_kind` and `decision` are literals rather than parameters — this statement
 * writes one kind of row and a caller cannot bend it into a User approval or a
 * rejection. `actor_user_id` is NULL, which the `authorizations` CHECK requires for a
 * non-`user` actor.
 */
export const POLICY_ENGINE_AUTHORIZATION_SQL = `
INSERT INTO authorizations
  (tenant_id, proposal_id, actor_kind, actor_user_id, decision, decided_at)
VALUES ($1, $2::uuid, 'policy_engine', NULL, 'approved', $3::timestamptz)
RETURNING id, decided_at`.trim();

/** The parameter tuple {@link POLICY_ENGINE_AUTHORIZATION_SQL} expects, in order. */
export function policyEngineAuthorizationParams(
  tenantId: TenantId,
  proposalId: string,
  decidedAt: string,
): readonly [TenantId, string, string] {
  return [tenantId, proposalId, decidedAt];
}

/**
 * The two writes a decision needs. Implemented by an adapter that binds the session
 * Tenant at construction — **no method takes a tenant id** (Requirement 12.7, 14.1).
 *
 * Both methods must **throw** rather than resolve on a write that matched no row: an
 * Authorization that was not inserted, or a Proposal that was not updated, is not a
 * recorded decision, and a silent no-op here would break Requirement 5.14's invariant
 * without anything noticing.
 */
export interface PolicyDecisionStore {
  /**
   * {@link POLICY_ENGINE_AUTHORIZATION_SQL}. Returns `authorizations.id`.
   * Called only on `auto_execute`, and before execution begins.
   */
  recordPolicyEngineAuthorization(proposalId: string, decidedAt: string): Promise<string>;
  /** {@link PROPOSAL_DECISION_UPDATE_SQL}. */
  persistDecision(proposalId: string, decision: PolicyDecision): Promise<void>;
}

/**
 * Record the decision: the Authorization first where one is owed, then the gate
 * picture on the Proposal.
 *
 * The order is the module doc comment's, and it is the whole safety argument for the
 * automatic path — see there for why the reverse order has a window in which
 * Requirement 5.14 can be violated.
 *
 * @throws {PolicyDecisionError} for a Proposal with no identifier. A Proposal must be
 * persisted by the PROPOSE stage before AUTHORIZE, since an Authorization references
 * `proposals.id` and the gate picture is stored on the row.
 */
export async function recordPolicyDecision(
  proposalId: string | undefined,
  decision: PolicyDecision,
  store: PolicyDecisionStore,
  options?: { readonly decidedAt?: string },
): Promise<PolicyDecision> {
  if (typeof proposalId !== 'string' || proposalId.trim().length === 0) {
    throw new PolicyDecisionError(
      'the Proposal carries no identifier, so neither the Authorization of Requirement 5.6 nor ' +
        'the gate picture of Requirement 5.4 can reference it; the PROPOSE stage persists the ' +
        'Proposal before AUTHORIZE evaluates it',
    );
  }

  if (decision.decision !== 'auto_execute') {
    await store.persistDecision(proposalId, decision);
    return decision;
  }

  const decidedAt = options?.decidedAt ?? new Date().toISOString();
  const authorization_id = await store.recordPolicyEngineAuthorization(proposalId, decidedAt);
  const authorized: PolicyDecision = { ...decision, authorization_id };
  await store.persistDecision(proposalId, authorized);
  return authorized;
}

/* -------------------------------------------------------------------------- */
/* The AUTHORIZE stage, end to end                                            */
/* -------------------------------------------------------------------------- */

/**
 * A submission with no risk score, because the Policy_Engine computes it
 * (Requirement 5.15) rather than being told it. The Auto_Execute_Threshold is still an
 * input: it is the Tenant's configuration, resolved by the Configuration_Service.
 */
export type ProposalForAuthorization = Omit<PolicySubmission, 'risk_score'>;

/**
 * The AUTHORIZE stage: score the Proposal, evaluate all six Policy_Checks, derive the
 * one decision, record the Authorization where the decision is `auto_execute`, and
 * persist the gate picture. The entry point Requirement 5.9's resubmission calls.
 *
 * ### How the score and the gate are ordered, and why it is exact
 *
 * Requirement 5.15's third input — the count of absent Evidence_Chain Source_Records —
 * is produced by the transaction evidence check, while the risk threshold check reads
 * a score. FINDING 5. The circle is closed without reading the Evidence_Chain twice:
 *
 * 1. a **provisional** score is computed from the impact and the action type with an
 *    absent count of 0, and the six checks are evaluated with it;
 * 2. the **final** score is recomputed from the outcome's `absent_evidence_count`, and
 *    it is the one returned, persisted and compared.
 *
 * That gives the same decision a single-pass evaluation with the true score would,
 * exactly rather than approximately. The risk threshold check tests only that both
 * operands are integers 0..100, and provisional and final both are by construction, so
 * its verdict is identical either way. And any absent count above 0 fails the
 * transaction evidence check, so whenever the two scores could differ the decision is
 * already `block` — where the score is reported but never compared. Where the decision
 * does turn on the comparison, the absent count is 0 and the two scores are equal.
 *
 * An action type outside design.md's three has no score at all (`./risk.ts` FINDING 1).
 * That is not an exception here: the score is carried as `null`, the risk threshold
 * check fails on it, and the decision is `block` with the reason on the check — which
 * is a Proposal the User can see and fix, rather than a stack trace.
 *
 * @throws {PolicyDecisionError} for an incomplete gate or an unpersisted Proposal.
 * @throws {PolicyCheckError} for a `submitted_at` that is not an instant or a target
 * set with no fingerprint, both raised by `runPolicyChecks` before any I/O.
 */
export async function authorizeProposal(
  submission: ProposalForAuthorization,
  sources: PolicyFactSources,
  store: PolicyDecisionStore,
  options?: {
    readonly budgetMs?: number;
    readonly now?: () => number;
    readonly decidedAt?: string;
  },
): Promise<PolicyDecision> {
  const { proposal } = submission;

  const provisional = scoreOrNull({
    impact_paise: proposal.impact_paise,
    action_type: proposal.action_type,
    absent_evidence_source_count: 0,
  });

  const outcome = await runPolicyChecks({ ...submission, risk_score: provisional }, sources, {
    ...(options?.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
    ...(options?.now === undefined ? {} : { now: options.now }),
  });

  const decision = decidePolicy({
    checks: outcome.checks,
    risk_score: provisional === null ? null : riskScoreFromChecks(proposal, outcome),
    auto_execute_threshold: submission.auto_execute_threshold,
    ...(outcome.duplicate_proposal_id === undefined
      ? {}
      : { duplicate_proposal_id: outcome.duplicate_proposal_id }),
  });

  return recordPolicyDecision(proposal.id, decision, store, {
    ...(options?.decidedAt === undefined ? {} : { decidedAt: options.decidedAt }),
  });
}

/**
 * The score, or `null` where the Proposal does not admit one.
 *
 * The only swallowed error in this module, and it is narrowed to {@link RiskScoreError}
 * — an action type outside design.md's three, or an absent count that is not a
 * non-negative integer. Those are **Proposal** faults, and turning them into a `null`
 * score makes the risk threshold Policy_Check fail, so the reason reaches the User as a
 * check detail on a blocked Proposal rather than as a stack trace; Requirements 5.3 and
 * 5.4 owe six results and a decision for every submission.
 *
 * A `PaiseTypeError` or `PaiseRangeError` from the impact is deliberately **not**
 * caught. Those say a monetary value is not in-range `bigint` paise, which is a
 * violation of the discipline the whole runtime rests on (Requirement 15.1, 15.8) and
 * not something a User can fix on a Proposal. It propagates, loudly.
 */
function scoreOrNull(input: Parameters<typeof riskScore>[0]): number | null {
  try {
    return riskScore(input);
  } catch (error: unknown) {
    if (error instanceof RiskScoreError) {
      return null;
    }
    throw error;
  }
}
