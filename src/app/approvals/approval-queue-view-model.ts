/**
 * The approval queue's **view model** (task 27.1).
 * Requirements 5.4, 5.9, 5.10, 5.16, 14.6.
 *
 * Same convention `src/app/control-tower/metric-view-model.ts` set and this module
 * follows: every decision about what a Sensitive_Action looks like is made here, in
 * pure functions with no React and no DOM, and `./ApprovalQueue.tsx` only places the
 * strings. There is no DOM environment in this repository (`vitest.config.ts` runs
 * every project with `environment: 'node'`), so a mapping that lives here is tested
 * under the existing `unit` project and a mapping that lives in the component is not.
 *
 * ## What Requirement 5.4 obliges the queue to show
 *
 * "A pass or fail result for each of the 6 Policy_Checks, the computed Proposal risk
 * score, the Auto_Execute_Threshold value used, and exactly one decision". So:
 *
 * - {@link policyCheckViews} returns **exactly six** views in `POLICY_CHECK_IDS`
 *   order, always, whatever the stored column holds. A User seeing only the check
 *   that failed cannot tell whether the other five were evaluated
 *   (`docs/08_UI_UX_SPEC.md`), so a check with no recorded result renders as
 *   `not_recorded` **in its own row** rather than being omitted.
 * - `detail` is carried through untouched. It is what makes a blocked Proposal
 *   legible — `src/policy/decide.ts`'s `policyChecksJson` persists it for exactly
 *   this reader — so it is rendered, not summarised.
 * - {@link riskView} shows the score and the threshold side by side with the
 *   comparison spelled out, so the decision is legible rather than opaque.
 *
 * ## Money
 *
 * `impact_paise` is `Paise` (`bigint`) and reaches the screen only through
 * {@link moneyValueView}, which is `formatInr` and `secondaryUnit` from
 * `@/format/inr`. There is no `Intl.NumberFormat`, no `toFixed` and no `Number(...)`
 * on a monetary value anywhere in this file, and the figure is not recomputed here —
 * it is the persisted `proposals.impact_paise` the Policy_Engine scored
 * (Requirement 15.1, 15.2, 15.8).
 *
 * ## The risk score is nullable, and `null` is not `0`
 *
 * `proposals.risk_score` is nullable and `src/policy/decide.ts` (its FINDING 2) says
 * exactly when it is NULL: the score was **not computable**, because the action type
 * is outside design.md's three. Rendering that as `0` would be a lie in the most
 * dangerous direction — 0 is a real score meaning "least risky", and at the default
 * Auto_Execute_Threshold of 0 it auto-executes. So {@link riskView} has a
 * `not_computable` kind carrying its own sentence, and no numeral.
 *
 * The same reading is applied to a stored score that is out of range: the column has
 * `CHECK (risk_score BETWEEN 0 AND 100)`, so a value outside it cannot be trusted as
 * a score at all and is reported rather than displayed.
 *
 * ## The Approval_Window is counted down, not stated
 *
 * Requirement 5.16 gives the window 1..168 hours and expires a Proposal that receives
 * no decision inside it. What a User needs on the row is therefore the **remaining**
 * time, so {@link approvalWindowView} subtracts `approval_deadline` from the current
 * instant. Two deliberate choices:
 *
 * 1. **Truncated, never rounded up.** `21h 14m` means at least 21 hours 14 minutes
 *    remain. Rounding up would promise time that is not there.
 * 2. **A `null` deadline is its own state.** `proposals.approval_deadline` is
 *    nullable, and `src/action/action-service.ts` (its FINDING 4) refuses a decision
 *    on an `awaiting_approval` Proposal that carries none. The queue says so rather
 *    than rendering a countdown from an instant it does not have.
 *
 * ## Approve and reject are gated, and the gate is not this module
 *
 * Requirement 14.6 requires the FinanceOS_Authorization_Service to verify
 * `approve_sensitive_actions` **before the action reads or changes any Tenant
 * financial data**, and that check is server-side, in
 * `@/authz/authorization-service`. {@link approvalControlsView} decides only whether
 * the two controls are *rendered*: a control a User cannot use is worse than no
 * control (`docs/08_UI_UX_SPEC.md`: an expired proposal "removes both controls rather
 * than leaving them to fail on click"). Hiding a button is presentation; the refusal
 * is the service's, and it stands whether or not this module ran.
 *
 * ## FINDINGS — reported, not silently patched
 *
 * 1. **`test/db/proposals-authorizations.test.ts` writes `policy_checks` as
 *    `[{"name":…,"passed":…}]`.** design.md's shape — and what
 *    `src/policy/decide.ts`'s `policyChecksJson` actually persists — is
 *    `{ id, result, detail? }`. Tasks 22.1 (FINDING 5) and 22.2 (FINDING 1) both
 *    reported it and deliberately left the fixture alone; **this task has not changed
 *    it either.** {@link readPersistedPolicyChecks} reads design.md's shape and
 *    reports anything else as `unreadable` with the divergence named in the message,
 *    rather than silently rendering six "Not recorded" rows — a row that looks
 *    un-evaluated and a row whose results were written under other keys are different
 *    facts, and only one of them is a defect.
 * 2. **Nothing fixes the queue's row order.** Requirements 3.5 and 3.6 fix the
 *    Attention_Panel's; nothing does the same for the approval queue.
 *    {@link approvalQueueRows} orders by soonest deadline first, since the window is
 *    the only thing on the row that runs out, then by Proposal identifier so the
 *    order is total and two renders of one queue agree. Rows with no deadline sort
 *    last, because "no deadline" is not "due now".
 * 3. **`proposals.expected_outcome` has no stated shape** (design.md, and
 *    `src/action/action-service.ts` FINDING 2), so the queue does not render it. The
 *    Ledger_Entry effect a Proposal would write is the one thing about a Sensitive_Action
 *    a User might reasonably want and cannot be shown yet; the Evidence_Chain control
 *    and the six check details are what stands in for it.
 *
 * ## Deliberately not here
 *
 * - **No decision is taken.** `approveProposal` and `rejectProposal` in
 *   `@/action/action-service` own Requirements 5.9 and 5.10 end to end. This module
 *   words their outcomes ({@link decisionOutcomeText}) and nothing more.
 * - **No load.** `./approval-queue-state.ts` owns the async state; the adapter that
 *   reads `proposals` binds the Tenant from the session (Requirement 12.7, 14.1), and
 *   no function here takes a Tenant identifier.
 * - **No expiry.** Marking an unanswered Proposal `expired` is task 23.5's
 *   (Requirement 5.16). A window that has elapsed renders as elapsed here even while
 *   the stored state still says `awaiting_approval`, which is the honest reading: the
 *   time is a fact about the clock, not about the row.
 *
 * Pure and synchronous. No module state, no React, no DOM.
 */

import { APPROVAL_PERMISSION } from '@/action/action-service';
import type { ExecutionOutcome, RejectionOutcome } from '@/action/action-service';
import { categoryLabel } from '@/app/control-tower/attention-panel-view-model';
import {
  istStamp,
  moneyValueView,
  type IstStamp,
  type MoneyValueView,
} from '@/app/control-tower/metric-view-model';
import type { Permission } from '@/authz/permissions';
import type { Paise } from '@/calc/paise';
import type { SourceRef } from '@/ledger/posting-rules';
import {
  APPROVAL_WINDOW_MAX_HOURS,
  APPROVAL_WINDOW_MIN_HOURS,
  POLICY_CHECK_IDS,
  type PolicyCheckId,
  type PolicyCheckResult,
  type ProposalState,
} from '@/policy/checks';

/* -------------------------------------------------------------------------- */
/* The row, in `proposals` column terms                                       */
/* -------------------------------------------------------------------------- */

/**
 * One `proposals` row as the queue reads it.
 *
 * Column names rather than invented ones, so a reader can line the view up against
 * `20260101000008_proposals_authorizations.sql`. `policy_checks` arrives as `unknown`
 * because the column is untyped `JSONB` with no constraint — see FINDING 1 and
 * {@link readPersistedPolicyChecks}; typing it as `PolicyCheckResult[]` at this seam
 * would assert what the seam cannot know.
 *
 * There is **no `tenant_id`**. The adapter that produces these rows binds the Tenant
 * from the session (Requirement 12.7, 14.1), and a Tenant a caller could supply is
 * a Tenant a caller could bend.
 */
export interface SensitiveActionSnapshot {
  /** `proposals.id`. */
  readonly proposal_id: string;
  /** `proposals.agent_name`. */
  readonly agent_name: string;
  /** `proposals.action_type`. */
  readonly action_type: string;
  /** `proposals.target_source_records`. */
  readonly target_source_records: readonly SourceRef[];
  /** `proposals.impact_paise`. Integer paise as `bigint` (Requirement 15.1). */
  readonly impact_paise: Paise;
  /** `proposals.evidence_chain_id`. `NOT NULL` in the schema. */
  readonly evidence_chain_id: string;
  /** `proposals.state`. */
  readonly state: ProposalState;
  /** `proposals.policy_checks`. Untyped `JSONB`; may be SQL NULL. */
  readonly policy_checks: unknown;
  /** `proposals.risk_score`. `null` where the score was not computable. */
  readonly risk_score: number | null;
  /** `proposals.threshold_used`. `null` where the Tenant configuration did not resolve. */
  readonly threshold_used: number | null;
  /** `proposals.approval_deadline`. ISO-8601 UTC, or NULL. */
  readonly approval_deadline: string | null;
  /** `proposals.created_at`. ISO-8601 UTC. */
  readonly created_at: string;
}

/**
 * The three `proposal_state` labels the queue lists.
 *
 * `awaiting_approval` is the queue proper — the Sensitive_Actions holding the
 * require-approval decision (Requirement 5.7, 5.8). The other two are here because
 * `docs/08_UI_UX_SPEC.md` renders the gate picture on a blocked Proposal
 * specifically, and because an expired Proposal has to be visible for its missing
 * controls to mean anything. Every other label is history: `executed`, `verified`,
 * `verification_failed` and `execution_failed` have run, `authorized` is mid-execution,
 * `rejected` is discarded (Requirement 5.10), and `proposed` has not been evaluated.
 */
export const APPROVAL_QUEUE_STATES: readonly ProposalState[] = [
  'awaiting_approval',
  'blocked',
  'expired',
];

/* -------------------------------------------------------------------------- */
/* Labels                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `post_reconciliation_adjustment` -> `Post reconciliation adjustment`.
 *
 * `categoryLabel` from the Attention_Panel's view model is reused rather than
 * reimplemented: it is a general snake_case-to-sentence labeller that already keeps
 * the finance acronyms (GST, GSTIN, ITC, TDS) upper-case, and two labellers would
 * eventually disagree about one of them.
 */
export function actionTypeLabel(actionType: string): string {
  return categoryLabel(actionType);
}

/** `awaiting_approval` -> `Awaiting approval`. */
export function proposalStateLabel(state: ProposalState): string {
  return categoryLabel(state);
}

/** `transaction_evidence` -> `transaction evidence`, as Requirement 5.3 names it. */
export function policyCheckLabel(id: PolicyCheckId): string {
  return id.replace(/_/g, ' ');
}

/* -------------------------------------------------------------------------- */
/* The six Policy_Check results (Requirement 5.4)                             */
/* -------------------------------------------------------------------------- */

/** What `proposals.policy_checks` turned out to hold. */
export type PolicyChecksRead =
  | { readonly kind: 'recorded'; readonly checks: readonly PolicyCheckResult[] }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly detail: string };

const CHECK_ID_SET: ReadonlySet<string> = new Set<string>(POLICY_CHECK_IDS);

function readOne(entry: unknown): PolicyCheckResult | null {
  if (typeof entry !== 'object' || entry === null) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const { id, result, detail } = record;
  if (typeof id !== 'string' || !CHECK_ID_SET.has(id)) {
    return null;
  }
  if (result !== 'pass' && result !== 'fail') {
    return null;
  }
  const base: PolicyCheckResult = {
    id: id as PolicyCheckId,
    result: result === 'pass' ? 'pass' : 'fail',
  };
  return typeof detail === 'string' ? { ...base, detail } : base;
}

/**
 * Read the persisted gate picture in design.md's `{ id, result, detail? }` shape.
 *
 * Anything else is `unreadable` **with the divergence named**, not quietly dropped.
 * See FINDING 1: the `{ name, passed }` fixture in
 * `test/db/proposals-authorizations.test.ts` is the shape this will report, and a row
 * whose results were written under other keys is a defect rather than a Proposal
 * nobody evaluated. Duplicate ids are also `unreadable` — two results for one check
 * is not a gate picture, and picking one of them would be picking silently.
 */
export function readPersistedPolicyChecks(value: unknown): PolicyChecksRead {
  if (value === null || value === undefined) {
    return { kind: 'absent' };
  }
  if (!Array.isArray(value)) {
    return {
      kind: 'unreadable',
      detail:
        'the stored Policy_Check results are not an array of ' +
        '{ id, result, detail? } entries, which is the shape the Policy_Engine writes',
    };
  }
  const checks: PolicyCheckResult[] = [];
  const seen = new Set<PolicyCheckId>();
  for (const entry of value as readonly unknown[]) {
    const check = readOne(entry);
    if (check === null) {
      return {
        kind: 'unreadable',
        detail:
          'a stored Policy_Check result does not carry an `id` from the 6 of ' +
          'Requirement 5.3 and a `result` of pass or fail, so the gate picture cannot be ' +
          'read as recorded',
      };
    }
    if (seen.has(check.id)) {
      return {
        kind: 'unreadable',
        detail: `the stored Policy_Check results name ${policyCheckLabel(check.id)} more than once`,
      };
    }
    seen.add(check.id);
    checks.push(check);
  }
  return { kind: 'recorded', checks };
}

/** One Policy_Check as a row renders it. `not_recorded` is neither pass nor fail. */
export interface PolicyCheckView {
  readonly id: PolicyCheckId;
  /** `transaction evidence`. */
  readonly label: string;
  readonly result: 'pass' | 'fail' | 'not_recorded';
  /** `Passed`, `Failed`, `Not recorded` — the result in words, never colour alone. */
  readonly resultText: string;
  /** The Policy_Engine's own reason, verbatim. `null` where it recorded none. */
  readonly detail: string | null;
}

const RESULT_TEXT = {
  pass: 'Passed',
  fail: 'Failed',
  not_recorded: 'Not recorded',
} as const;

/**
 * Exactly six views, in `POLICY_CHECK_IDS` order, one per Policy_Check id.
 *
 * The order is the one Requirement 5.3 names the checks in and the one the
 * Policy_Engine persists them in, so two renders of one Proposal are comparable row
 * by row. A check the column does not carry is `not_recorded` rather than absent —
 * see the module doc comment.
 */
export function policyCheckViews(read: PolicyChecksRead): readonly PolicyCheckView[] {
  const recorded = new Map<PolicyCheckId, PolicyCheckResult>(
    read.kind === 'recorded' ? read.checks.map((check) => [check.id, check]) : [],
  );
  return POLICY_CHECK_IDS.map((id) => {
    const check = recorded.get(id);
    const result = check === undefined ? 'not_recorded' : check.result;
    return {
      id,
      label: policyCheckLabel(id),
      result,
      resultText: RESULT_TEXT[result],
      detail: check?.detail ?? null,
    };
  });
}

/** The failed check identifiers, in check order (Requirement 5.5). */
export function failedCheckIdsOf(views: readonly PolicyCheckView[]): readonly PolicyCheckId[] {
  return views.filter((view) => view.result === 'fail').map((view) => view.id);
}

/** One sentence about the gate picture as a whole, or `null` when all six are recorded. */
export function policyChecksNotice(read: PolicyChecksRead): string | null {
  switch (read.kind) {
    case 'absent':
      return (
        'No Policy_Check results are recorded on this Proposal, so none of the 6 results ' +
        'can be shown. The Policy_Engine records all 6 when it evaluates a Proposal ' +
        '(Requirement 5.4).'
      );
    case 'unreadable':
      return `The recorded Policy_Check results could not be read: ${read.detail}.`;
    default:
      return read.checks.length === POLICY_CHECK_IDS.length
        ? null
        : `Only ${String(read.checks.length)} of ${String(POLICY_CHECK_IDS.length)} ` +
          'Policy_Check results are recorded on this Proposal; the remainder are shown as ' +
          'not recorded rather than as passing.';
  }
}

/* -------------------------------------------------------------------------- */
/* The risk score and the threshold used (Requirement 5.4, 5.15)              */
/* -------------------------------------------------------------------------- */

/** An integer in the inclusive 0..100 range Requirement 5.15 fixes. */
function isScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
}

/**
 * The two numbers the decision turned on, and the comparison between them.
 *
 * `score` is `null` exactly when no numeral may be shown. See the module doc comment:
 * `null` means "not computable", and 0 is a real score.
 */
export interface RiskView {
  readonly kind: 'scored' | 'not_computable';
  readonly score: number | null;
  /** `Risk 40 of 100`, or a sentence-free statement that no score was computed. */
  readonly scoreText: string;
  readonly threshold: number | null;
  /** `Auto-execute threshold 0`, or that it did not resolve. */
  readonly thresholdText: string;
  /** Requirement 5.6 / 5.7 spelled out, or why no comparison was made. */
  readonly comparisonText: string;
}

/** Requirement 5.4's score and threshold, with the comparison made legible. */
export function riskView(riskScore: number | null, thresholdUsed: number | null): RiskView {
  const scored = isScore(riskScore);
  const resolved = isScore(thresholdUsed);

  const scoreText = scored
    ? `Risk ${String(riskScore)} of 100`
    : riskScore === null
      ? 'Risk score not computable'
      : 'Risk score not readable';
  const thresholdText = resolved
    ? `Auto-execute threshold ${String(thresholdUsed)}`
    : 'Auto-execute threshold not resolved';

  let comparisonText: string;
  if (scored && resolved) {
    comparisonText =
      (riskScore as number) > (thresholdUsed as number)
        ? `Risk ${String(riskScore)} exceeds the Auto-execute threshold of ` +
          `${String(thresholdUsed)}, so this is a Sensitive_Action and a User decision is ` +
          'required (Requirement 5.7).'
        : `Risk ${String(riskScore)} is at or below the Auto-execute threshold of ` +
          `${String(thresholdUsed)} (Requirement 5.6).`;
  } else if (!scored && riskScore === null) {
    comparisonText =
      'No risk score was computed for this Proposal, so it was never compared against the ' +
      'Auto-execute threshold. A missing score is not a score of 0 (Requirement 5.15).';
  } else if (!scored) {
    comparisonText =
      `The recorded risk score ${JSON.stringify(riskScore)} is not an integer from 0 to 100, ` +
      'so no comparison against the Auto-execute threshold can be shown (Requirement 5.15).';
  } else {
    comparisonText =
      'The Auto-execute threshold used was not recorded, so the comparison behind the ' +
      'decision cannot be shown (Requirement 5.4).';
  }

  return {
    kind: scored ? 'scored' : 'not_computable',
    score: scored ? (riskScore as number) : null,
    scoreText,
    threshold: resolved ? (thresholdUsed as number) : null,
    thresholdText,
    comparisonText,
  };
}

/* -------------------------------------------------------------------------- */
/* The remaining Approval_Window (Requirement 5.16)                           */
/* -------------------------------------------------------------------------- */

const MS_PER_MINUTE = 60_000;

/** Milliseconds since the epoch, or `null` for anything that is not an instant. */
function instantMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * `21h 14m`, truncated to the minute. Never rounded up — see the module doc comment.
 *
 * Hours rather than days, because the Approval_Window tops out at
 * {@link APPROVAL_WINDOW_MAX_HOURS} hours and `167h 59m` is unambiguous where
 * `6d 23h` invites a "plus how many minutes?".
 */
export function formatWindowDuration(ms: number): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / MS_PER_MINUTE);
  if (totalMinutes < 1) {
    return 'under 1 minute';
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours === 0 ? `${String(minutes)}m` : `${String(hours)}h ${String(minutes)}m`;
}

/** What is left of the Approval_Window, and whether there is any. */
export interface ApprovalWindowView {
  readonly kind: 'remaining' | 'elapsed' | 'absent' | 'unreadable';
  /** `Expires in 21h 14m`. Always present, always without colour. */
  readonly text: string;
  /** Milliseconds left, truncated at 0. `null` unless `remaining`. */
  readonly remainingMs: number | null;
  /** Milliseconds since the deadline passed. `null` unless `elapsed`. */
  readonly elapsedMs: number | null;
  /** The deadline itself, IST, whole seconds (Requirement 3.10). `null` when absent. */
  readonly deadline: IstStamp | null;
}

/**
 * The **remaining** Approval_Window, counted down from `approval_deadline`.
 *
 * `nowIso` is an argument rather than a `Date.now()` call, so this is a pure function
 * of two instants and a test can assert the countdown without a fake clock.
 */
export function approvalWindowView(
  approvalDeadline: string | null,
  nowIso: string,
): ApprovalWindowView {
  if (approvalDeadline === null) {
    return {
      kind: 'absent',
      text:
        'No approval deadline is recorded, so the remaining Approval_Window cannot be ' +
        `shown. The Approval_Window is ${String(APPROVAL_WINDOW_MIN_HOURS)} to ` +
        `${String(APPROVAL_WINDOW_MAX_HOURS)} hours (Requirement 5.16).`,
      remainingMs: null,
      elapsedMs: null,
      deadline: null,
    };
  }

  const deadlineMs = instantMs(approvalDeadline);
  const nowMs = instantMs(nowIso);
  if (deadlineMs === null || nowMs === null) {
    return {
      kind: 'unreadable',
      text: 'The approval deadline is not a readable instant, so no countdown is shown.',
      remainingMs: null,
      elapsedMs: null,
      deadline: null,
    };
  }

  const deadline = istStamp(approvalDeadline);
  const difference = deadlineMs - nowMs;
  if (difference <= 0) {
    return {
      kind: 'elapsed',
      text: `Approval window elapsed ${formatWindowDuration(-difference)} ago`,
      remainingMs: null,
      elapsedMs: -difference,
      deadline,
    };
  }
  return {
    kind: 'remaining',
    text: `Expires in ${formatWindowDuration(difference)}`,
    remainingMs: difference,
    elapsedMs: null,
    deadline,
  };
}

/* -------------------------------------------------------------------------- */
/* The approve and reject controls (Requirement 5.9, 5.10, 14.6)              */
/* -------------------------------------------------------------------------- */

/** Whether the two controls are rendered, and the reason when they are not. */
export interface ApprovalControlsView {
  readonly visible: boolean;
  /** Why the controls are absent, in words. `null` when they are present. */
  readonly reason: string | null;
  /** The Permission the approval path requires (Requirement 14.6). */
  readonly requiredPermission: Permission;
}

/**
 * Requirement 14.6's gate as presentation, and `docs/08_UI_UX_SPEC.md`'s rule that an
 * expired Proposal removes both controls rather than leaving them to fail on click.
 *
 * The four reasons are ordered most-specific-about-the-User first: a session without
 * `approve_sensitive_actions` cannot decide any Proposal, so saying that is more use
 * than saying this particular row is out of time. The remaining three mirror
 * `refusalFor` in `@/action/action-service` exactly — `not_awaiting_approval`,
 * `approval_deadline_absent`, `approval_window_elapsed` — so a control is rendered
 * only where the Action_Service would accept a decision.
 */
export function approvalControlsView(
  state: ProposalState,
  window: ApprovalWindowView,
  grantedPermissions: readonly Permission[],
): ApprovalControlsView {
  const requiredPermission = APPROVAL_PERMISSION;

  if (!grantedPermissions.includes(requiredPermission)) {
    return {
      visible: false,
      reason:
        `Approving or rejecting a Sensitive_Action requires the ${requiredPermission} ` +
        'Permission, which this session does not hold (Requirement 14.6).',
      requiredPermission,
    };
  }
  if (state !== 'awaiting_approval') {
    return {
      visible: false,
      reason:
        `This Proposal is ${proposalStateLabel(state).toLowerCase()}, not awaiting approval, ` +
        'so there is no pending decision to make.',
      requiredPermission,
    };
  }
  if (window.kind === 'absent' || window.kind === 'unreadable') {
    return {
      visible: false,
      reason:
        'This Proposal is awaiting approval but carries no readable approval deadline, so a ' +
        'decision cannot be judged inside the Approval_Window (Requirement 5.16).',
      requiredPermission,
    };
  }
  if (window.kind === 'elapsed') {
    return {
      visible: false,
      reason:
        'The Approval_Window elapsed with no decision, so execution is withheld ' +
        '(Requirement 5.16). A decision made now would be refused.',
      requiredPermission,
    };
  }
  return { visible: true, reason: null, requiredPermission };
}

/* -------------------------------------------------------------------------- */
/* The row                                                                    */
/* -------------------------------------------------------------------------- */

/** One target Source_Record, split for a description list. */
export interface TargetView {
  readonly key: string;
  /** `settlement recon report`, readable mid-sentence. */
  readonly type: string;
  readonly id: string;
}

/** Everything one queue row renders. */
export interface ApprovalQueueRowView {
  readonly proposalId: string;
  readonly agentName: string;
  readonly actionType: string;
  /** `Post reconciliation adjustment`. */
  readonly actionLabel: string;
  readonly state: ProposalState;
  /** `Awaiting approval`, so the state is never conveyed by colour. */
  readonly stateText: string;
  /** The persisted `impact_paise`, formatted. Never recomputed here. */
  readonly impact: MoneyValueView;
  readonly targets: readonly TargetView[];
  /** Requirement 12.5: the figure is a control that opens this chain. */
  readonly evidenceChainId: string;
  /** Exactly 6, in `POLICY_CHECK_IDS` order (Requirement 5.4). */
  readonly checks: readonly PolicyCheckView[];
  /** One sentence when the gate picture is incomplete or unreadable. */
  readonly checksNotice: string | null;
  readonly failedCheckIds: readonly PolicyCheckId[];
  readonly risk: RiskView;
  readonly window: ApprovalWindowView;
  readonly controls: ApprovalControlsView;
  readonly createdAt: IstStamp;
  /** What a live region says about this row, so nothing is announced by colour. */
  readonly announcement: string;
}

export interface ApprovalQueueViewOptions {
  /** The instant the countdown is measured against. ISO-8601. */
  readonly nowIso: string;
  /** The Permissions the session holds, resolved by `AuthorizationService`. */
  readonly grantedPermissions: readonly Permission[];
}

function targetViews(refs: readonly SourceRef[]): readonly TargetView[] {
  return refs.map((ref) => ({
    key: `${ref.type}\u0000${ref.id}`,
    type: ref.type.replace(/_/g, ' '),
    id: ref.id,
  }));
}

/** One Sensitive_Action, rendered. Total on every state and every stored column value. */
export function approvalQueueRowView(
  snapshot: SensitiveActionSnapshot,
  options: ApprovalQueueViewOptions,
): ApprovalQueueRowView {
  const read = readPersistedPolicyChecks(snapshot.policy_checks);
  const checks = policyCheckViews(read);
  const window = approvalWindowView(snapshot.approval_deadline, options.nowIso);
  const impact = moneyValueView(snapshot.impact_paise);
  const risk = riskView(snapshot.risk_score, snapshot.threshold_used);
  const failed = failedCheckIdsOf(checks);
  const passedCount = checks.filter((check) => check.result === 'pass').length;
  const actionLabel = actionTypeLabel(snapshot.action_type);

  return {
    proposalId: snapshot.proposal_id,
    agentName: snapshot.agent_name,
    actionType: snapshot.action_type,
    actionLabel,
    state: snapshot.state,
    stateText: proposalStateLabel(snapshot.state),
    impact,
    targets: targetViews(snapshot.target_source_records),
    evidenceChainId: snapshot.evidence_chain_id,
    checks,
    checksNotice: policyChecksNotice(read),
    failedCheckIds: failed,
    risk,
    window,
    controls: approvalControlsView(snapshot.state, window, options.grantedPermissions),
    createdAt: istStamp(snapshot.created_at),
    announcement:
      `${actionLabel}, impact ${impact.primary}, ` +
      `${proposalStateLabel(snapshot.state).toLowerCase()}. ` +
      `${String(passedCount)} of ${String(POLICY_CHECK_IDS.length)} Policy_Checks passed` +
      `${failed.length === 0 ? '' : `, failing ${failed.map(policyCheckLabel).join(' and ')}`}. ` +
      `${risk.scoreText}, ${risk.thresholdText}. ${window.text}.`,
  };
}

/**
 * The queue: the rows in {@link APPROVAL_QUEUE_STATES}, soonest deadline first.
 *
 * The order is a total order and it is this module's decision, not a requirement's —
 * see FINDING 2. Rows with no readable deadline sort after every row that has one,
 * and ties break on the Proposal identifier so two renders of one queue agree.
 */
export function approvalQueueRows(
  snapshots: readonly SensitiveActionSnapshot[],
  options: ApprovalQueueViewOptions,
): readonly ApprovalQueueRowView[] {
  return snapshots
    .filter((snapshot) => APPROVAL_QUEUE_STATES.includes(snapshot.state))
    .map((snapshot) => approvalQueueRowView(snapshot, options))
    .sort((left, right) => {
      const leftDeadline = instantMs(left.window.deadline === null ? null : left.window.deadline.machine);
      const rightDeadline = instantMs(right.window.deadline === null ? null : right.window.deadline.machine);
      if (leftDeadline !== rightDeadline) {
        if (leftDeadline === null) return 1;
        if (rightDeadline === null) return -1;
        return leftDeadline < rightDeadline ? -1 : 1;
      }
      return left.proposalId < right.proposalId ? -1 : left.proposalId > right.proposalId ? 1 : 0;
    });
}

/* -------------------------------------------------------------------------- */
/* Wording the Action_Service's outcomes (Requirement 5.9, 5.10)              */
/* -------------------------------------------------------------------------- */

/**
 * What happened, in words a User can act on.
 *
 * The union is switched on non-exhaustively on purpose: tasks 23.2–23.5 widen
 * `ExecutionOutcome` (its FINDING 1 says so), and a queue that fails to compile every
 * time the Action_Service gains a case would be a queue that discourages the
 * Action_Service from gaining one. An unrecognised outcome is reported as itself
 * rather than swallowed.
 */
export function decisionOutcomeText(outcome: ExecutionOutcome | RejectionOutcome): string {
  switch (outcome.kind) {
    case 'executed':
      return 'Approved and executed. The Authorization behind the execution is on record.';
    case 'withheld':
      return `Approved, but execution was withheld: ${outcome.detail}`;
    case 'execution_failed':
      return `Approved, but execution failed: ${outcome.detail}`;
    case 'discarded':
      return 'Rejected and discarded without execution. The rejection is on record.';
    case 'refused':
      return `The rejection was refused: ${outcome.detail}`;
    default:
      return `The decision returned an outcome this view does not recognise: ${
        (outcome as { readonly kind: string }).kind
      }.`;
  }
}
