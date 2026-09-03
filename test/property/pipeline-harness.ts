/**
 * The Action_Pipeline harness property P8 drives (task 23.6).
 *
 * design.md runs the seven Action_Pipeline stages from the Agent Engine, and the Agent
 * Engine is Python and does not exist until Slice 4. P8 is a Slice 3 gate
 * ("**P7**, **P8**, **P9** and **P14** all pass"), so it cannot wait for a runtime that
 * is two slices away. This module is what closes that gap: it drives the **production**
 * Policy_Engine and the **production** FinanceOS_Action_Service directly, in stage order,
 * and appends the same stage Audit_Events an engine run would.
 *
 * ## What is production here and what is not
 *
 * Every decision P8 asserts about is made by production code. Nothing below re-implements
 * a rule:
 *
 * | Stage | Driven through |
 * |---|---|
 * | DETECT, INVESTIGATE, EXPLAIN, PROPOSE | this harness (they are the Agent's, and the Agent is Python) |
 * | AUTHORIZE | `authorizeProposal` — all six `checks.ts` Policy_Checks, `risk.ts`, `decidePolicy`, `recordPolicyDecision` |
 * | approval, rejection | `approveProposal`, `rejectProposal` (task 23.1) |
 * | Approval_Window expiry | `expireIfOverdue` (task 23.5) |
 * | EXECUTE | `executeAuthorizedProposal` (task 23.2), over the real `post_reconciliation_adjustment`, the real `createToolInvoker` funnel and the real `createSemanticLedger` |
 * | VERIFY | `verifyExecutedProposal` (task 23.3) |
 * | the stage history oracle | `stageHistoryFor` (task 25.4), which was written store-free for exactly this |
 * | the Audit_Log | `createAuditService` + `auditAppendPlan`, over an in-memory append-only `AuditEventStore` whose Chain_Value is `chain.ts`'s `chainValue` |
 *
 * What is in-memory is **persistence only**: the `proposals`, `authorizations`,
 * `audit_events`, `evidence_chains` and `ledger_entry_sets` adapters. Each one is the
 * store seam the production module already declares, and each enforces the guard its SQL
 * statement enforces — `DECIDABLE_STATES` on the decision update,
 * `USER_DECIDABLE_STATES` on a User decision, `authorized` on `markExecuted`,
 * `awaiting_approval AND approval_deadline < $at` on the expiry — because a fake that
 * enforced less would make P8 pass over a state machine that does not hold.
 *
 * `transitionState` enforces its guard from the `from` list its caller passes rather than
 * from a list of its own, which is why `USER_DECIDABLE_STATES` is named here but not
 * imported: `approveProposal` and `rejectProposal` supply it, and a harness that
 * substituted its own list would be asserting against itself.
 *
 * ## Why the pipeline is driven as *attempts*, and why that is what makes P8 mean anything
 *
 * The harness does not decide which Proposals may execute. It **attempts** EXECUTE for
 * every Proposal that reached a decision, and attempts VERIFY for every Proposal that
 * reached an EXECUTE attempt, exactly as Requirement 5.8 describes the division of labour:
 * *"WHILE a Sensitive_Action holds the require-approval decision, THE
 * FinanceOS_Action_Service SHALL withhold execution"*. The withholding is the
 * Action_Service's, not the caller's.
 *
 * That is deliberate and it is the whole non-vacuity argument. A harness that only invoked
 * the executor for Proposals it had already decided were executable would make P8's second
 * clause — *no blocked, awaiting-approval, rejected or expired Proposal has an EXECUTE
 * Audit_Event* — true by the harness's own arithmetic rather than by the system's gates.
 * Here every blocked, rejected, expired and unapproved Proposal really is pushed at
 * `executeAuthorized`, and the reason no EXECUTE Audit_Event appears is that
 * `EXECUTABLE_STATES` and the Authorization lookup refuse it. Widen either and P8 fails —
 * which the property file's falsification log demonstrates rather than claims.
 *
 * ## The stage Audit_Events, and the Slice 4 contract this fixes
 *
 * One Audit_Event per **completed** stage (Requirement 5.2, 13.7), appended through the
 * production Audit_Service:
 *
 * - the four Agent stages are appended by this harness with `outcome: 'succeeded'`;
 * - AUTHORIZE carries `blocked` for a `block` decision and `succeeded` otherwise
 *   (Requirement 5.2's three labels, and 5.5's verdict);
 * - EXECUTE is appended **only** where the Action_Service reports `executed`
 *   (`succeeded`) or `execution_failed` (`failed`). A withholding completed no stage, so it
 *   appends nothing — that is the difference between "the stage failed" and "the stage did
 *   not happen", and P8's second clause is a statement about the latter;
 * - VERIFY is appended only where Verification concluded, `succeeded` on a match and
 *   `failed` on a difference (Requirement 5.11, 5.12). A `not_verified` outcome appends
 *   nothing.
 *
 * **Requirement 5.9's resubmission is not a stage event.** It is the second half of one
 * approval, not a second pass of the pipeline, so it is recorded as a non-stage Audit_Event
 * (`stage: null`), which `AUDIT_PROPOSAL_HISTORY_SQL` filters out and `stageHistoryFor`
 * therefore never sees. Appending it as a second AUTHORIZE stage event would put a
 * `repeated_stage_event` on every approved Proposal and make "exactly one Audit_Event per
 * completed stage" false for the ordinary case. The same holds for the Approval_Window
 * expiry, which `expire-approval-window.ts` already appends with `stage: null` (its
 * FINDING 6).
 *
 * **The `proposals` row is created before DETECT, in state `proposed`.** This is the
 * conflict `auditAppendPlan` reports and does not resolve: Requirement 5.2 records the
 * Proposal identifier on every stage Audit_Event, Requirement 13.7 resolves a stage history
 * *by* Proposal identifier, and Requirement 5.1 builds the Proposal at PROPOSE — so an
 * engine that created the row at PROPOSE would leave DETECT, INVESTIGATE and EXPLAIN
 * invisible to 13.7 and P8's prefix clause would fail on every run. Of the three candidate
 * resolutions that module lists, this harness takes the one it names as the only one
 * satisfying both requirements: create the row at pipeline start. **The Slice 4 Python
 * engine must do the same.** If it does not, P8 fails against the engine — which is the
 * point of writing the property against `stageHistoryFor` rather than against this
 * harness's own bookkeeping. A divergence between harness and engine surfaces as a P8
 * failure, not as an untested gap.
 *
 * ## FINDINGS — reported, not worked around
 *
 * 1. **`proposals.expected_outcome` still has no stated shape.** The fifth task to flag it
 *    (23.1 FINDING 2, 23.2 finding 1, 23.3 FINDING 1, 23.4). This harness writes
 *    `verify-execution.ts`'s assumed shape — `{ paise: <digit string>, fields }` — because
 *    that is the only shape `verifiableOutcomeFrom` accepts, and it derives the figure from
 *    the Ledger_Entry set the Proposal would post, so the VERIFY comparison is against a
 *    real observation rather than a restatement.
 * 2. **Nothing binds a Proposal's `action_type` to the tool the gate authorizes.** 23.2
 *    closed it on its own entry point only. The harness generates all three action types
 *    design.md names and registers one write-capable tool, so
 *    `mark_exception_resolved` and `initiate_payment_retry` reach EXECUTE and are withheld
 *    as `execution_tool_absent`. That is the current system behaviour, recorded rather than
 *    dodged: two of the three action types cannot execute at all today.
 * 3. **The Audit_Log here is TypeScript-chained.** `chainValue` is the producer *and* the
 *    verifier, so P8 asserts nothing about Chain_Value correctness — that is P9's, and P9's
 *    half B2 documents the `jsonb::text` versus `canonicalJson` divergence that makes the
 *    SQL side unrecomputable today. P8 needs an append-only log with a per-Tenant
 *    contiguous sequence, which is what this store provides.
 * 4. **No execution failure is generated**, so `reverse-failed-execution.ts` (23.4) is not
 *    on this harness's path. 23.4 reported its reversal loop as factually inert because
 *    `ledger_entry_sets.proposal_id` is never populated; generating a failure here would
 *    exercise a loop that finds nothing, and P8 asserts nothing about reversal (that is
 *    P14). The EXECUTE stage's `failed` outcome is nevertheless implemented above, so an
 *    engine that does produce one is covered by the same property.
 * 5. **`app.append_audit_event_autonomous` fails with `dblink_connect` `2F003`** and
 *    production `audit_sequence_counters` rows are not seeded (25.1 owns
 *    `AUDIT_SEQUENCE_COUNTER_SEED_SQL`). Both are why this harness is in-process rather
 *    than against Supabase local; see the property file's header for the full argument,
 *    including the `audit_events` append-only cleanup cost that P14's header prices.
 */

import { randomUUID } from 'node:crypto';

import type { Paise } from '@/calc/paise';
import type { Actor, TenantId } from '@/config/configuration-service';
import {
  ACTION_PIPELINE_STAGES,
  auditTimestamp,
  createAuditService,
  type ActionPipelineStage,
  type AuditEvent,
  type AuditEventAppendParams,
  type AuditEventDraft,
  type AuditEventStore,
  type AuditOutcome,
  type AuditService,
} from '@/audit/audit-service';
import { chainValue, INITIAL_CHAIN_VALUE } from '@/audit/chain';
import { stageHistoryFor, type StageHistory } from '@/audit/history';
import type { ExceptionUpsertInput, ExceptionUpserter, ExceptionUpsertResult } from '@/agents/exception-fingerprint';
import type { LedgerEntrySetDraft, SourceRef } from '@/ledger/posting-rules';
import { createSemanticLedger, type LedgerAuditEvent } from '@/ledger/semantic-ledger';
import {
  proposalTargetFingerprint,
  relevantInstantOf,
  type NoLedgerEffect,
  type EvidenceGrounding,
  type PolicyFactSources,
  type PriorProposal,
  type ProposalState,
  type ProposalUnderReview,
  type RecordedAuthorization,
} from '@/policy/checks';
import {
  authorizeProposal,
  DECIDABLE_STATES,
  proposalStateForDecision,
  type PolicyDecision,
  type PolicyDecisionStore,
} from '@/policy/decide';
import type { Permission } from '@/authz/permissions';
import {
  approveProposal,
  rejectProposal,
  type ActionProposalSnapshot,
  type ActionProposalStore,
  type ExecutionOutcome,
  type RejectionOutcome,
  type UserDecisionRecord,
} from '@/action/action-service';
import {
  adjustmentArgumentsFrom,
  createAuthorizedExecutor,
  type ExecutionStore,
  type ProposalExecutionSnapshot,
} from '@/action/execute-authorized';
import {
  approvalDeadlineFrom,
  expireIfOverdue,
  type ApprovalWindowStore,
  type ExpiryOutcome,
  type ProposalExpirySnapshot,
} from '@/action/expire-approval-window';
import {
  verifyExecutedProposal,
  type OutcomeObserver,
  type ProposalVerificationSnapshot,
  type VerifiableOutcome,
  type VerificationOutcome,
  type VerificationStore,
} from '@/action/verify-execution';
import { createPostReconciliationAdjustment, POST_RECONCILIATION_ADJUSTMENT } from '@/tools/post-reconciliation-adjustment';
import { createToolRegistry } from '@/tools/registry';
import { createToolInvoker, type ToolConnection, type ToolConnections, type ToolDbClient, type ToolMode } from '@/tools/tool';
import { MemoryEvidenceStore } from '@/tools/exception-tools.test-support';
import {
  adjustmentSourceStore,
  ADJUSTMENT_DATE,
  balancedEntries,
  citedRecord,
  MemoryLedgerStore,
  recordingWriteAudit,
  WRITE_TENANT,
  WRITE_USER,
  writeGate,
} from '@/tools/write-tools.test-support';
import { encodePaise } from '@/wire/paise-wire';

/* -------------------------------------------------------------------------- */
/* Fixed identifiers                                                          */
/* -------------------------------------------------------------------------- */

/** The session Tenant. Shared with the write-tool fixtures so one Tenant runs the path. */
export const PIPELINE_TENANT: TenantId = WRITE_TENANT;

/** The approving User. `authorizations.actor_user_id`. */
export const PIPELINE_USER = WRITE_USER;

/** Who runs DETECT..PROPOSE. An Agent name, per Requirement 13.1. */
export const PIPELINE_AGENT: Actor = { kind: 'agent', id: 'reconciliation_agent' };

/** Who runs the Approval_Window sweep (`expire-approval-window.ts` FINDING 5). */
export const SWEEP_ACTOR: Actor = { kind: 'user', id: 'financeos_scheduler' };

/**
 * The three action types design.md's `ACTION_POINTS` scores. Only the first names a
 * registered write-capable tool — see FINDING 2.
 */
export const PROPOSAL_ACTION_TYPES = [
  POST_RECONCILIATION_ADJUSTMENT,
  'mark_exception_resolved',
  'initiate_payment_retry',
] as const;

export type GeneratedActionType = (typeof PROPOSAL_ACTION_TYPES)[number];

/**
 * An `authorizations.id` that is never inserted.
 *
 * What the engine's EXECUTE attempt carries when no Authorization was recorded — a blocked
 * Proposal, an expired one, an approval that arrived after the Approval_Window. The
 * Authorization lookup must refuse it (Requirement 5.14, 12.10), and P8's first clause is
 * exactly the claim that it does.
 */
export const SYNTHETIC_AUTHORIZATION_ID = 'deadbeef-0000-4000-8000-000000000000';

/** Where every run's clock starts. A real instant, fixed so counterexamples replay. */
export const PIPELINE_BASE_INSTANT = '2026-08-01T00:00:00.000Z';

/** Every generated Proposal's Evidence_Chain identifier is drawn fresh; this is the pool. */
const TARGET_REF_POOL: readonly SourceRef[] = Object.freeze([
  { type: 'settlement', id: 'setl_P8AAA1' },
  { type: 'settlement_recon_report', id: 'setl_recon_P8AAA1' },
  { type: 'payment', id: 'pay_P8BBB2' },
  { type: 'refund', id: 'rfnd_P8CCC3' },
]);

export const PIPELINE_TARGET_POOL = TARGET_REF_POOL;

/* -------------------------------------------------------------------------- */
/* The generated input                                                        */
/* -------------------------------------------------------------------------- */

/** design.md's `arbitraryProposal`, in the fields the gate and the ledger read. */
export interface GeneratedProposal {
  readonly action_type: GeneratedActionType;
  /** `proposals.impact_paise`. Integer paise, `bigint` (Requirement 15.1). */
  readonly impact_paise: Paise;
  /** `proposals.target_source_records`, at least 1 (the fingerprint needs one). */
  readonly target_source_records: readonly SourceRef[];
  /** Makes the stated Ledger_Entry set unbalanced by 1 paisa (Requirement 2.6). */
  readonly unbalanced_effect: boolean;
  /** States a correction with no Ledger_Entry effect (Requirement 2.4, 2.7). */
  readonly corrects_without_effect: boolean;
}

/** design.md's `arbitraryPolicyEnvironment`: which checks fail, the threshold, the duplicate. */
export interface GeneratedPolicyEnvironment {
  /** Withhold it and the user permission Policy_Check fails at submission. */
  readonly holds_run_agents: boolean;
  /** Withhold it and the resubmission of Requirement 5.9 blocks. */
  readonly holds_approval_permission: boolean;
  /** What the Evidence_Chain cites: everything, some targets, or nothing readable. */
  readonly evidence: 'cites_every_target' | 'cites_some_targets' | 'unreadable';
  /** Integer 0..100, or `null` for a Tenant configuration that did not resolve. */
  readonly auto_execute_threshold: number | null;
  /** Requirement 5.16's Approval_Window, 1..168 hours. */
  readonly approval_window_hours: number;
  /** A prior Proposal for the 30-day lookback (Requirement 5.13). */
  readonly duplicate: 'none' | 'inside_window' | 'outside_window';
  /** The prior Proposal's state. Only `DUPLICATE_BLOCKING_STATES` make it a duplicate. */
  readonly duplicate_state: ProposalState;
  /** A rejection already on record, which fails the approval requirement check. */
  readonly rejection_on_record: boolean;
}

/** design.md's `arbitraryApprovalBehaviour`. */
export const APPROVAL_BEHAVIOURS = [
  'approve',
  'reject',
  'expire',
  'approve_after_window',
] as const;

export type ApprovalBehaviour = (typeof APPROVAL_BEHAVIOURS)[number];

/** One generated Action_Pipeline run. */
export interface GeneratedRun {
  readonly proposal: GeneratedProposal;
  readonly environment: GeneratedPolicyEnvironment;
  readonly behaviour: ApprovalBehaviour;
}

/* -------------------------------------------------------------------------- */
/* The `proposals` row, in column terms                                       */
/* -------------------------------------------------------------------------- */

/**
 * One `proposals` row as the four Action_Service modules and the Policy_Engine read it.
 *
 * Mutable on purpose: this is a row, and the pipeline's whole subject is the state machine
 * that moves it. Every mutation below goes through one of the store methods, each of which
 * carries the guard its SQL statement carries.
 */
interface ProposalRow {
  readonly id: string;
  readonly action_type: GeneratedActionType;
  readonly target_source_records: readonly SourceRef[];
  readonly impact_paise: Paise;
  readonly evidence_chain_id: string;
  readonly target_fingerprint: string;
  readonly ledger_effect: LedgerEntrySetDraft | NoLedgerEffect;
  readonly corrects_ledger_set_id: string | null;
  readonly expected_outcome: unknown;
  readonly tool_arguments: unknown;
  readonly created_at: string;
  readonly auto_execute_threshold: number | null;
  readonly approval_window_hours: number;
  state: ProposalState;
  approval_deadline: string | null;
  executed_at: string | null;
  verified_at: string | null;
  /** The gate picture of the last recorded evaluation (Requirement 5.4). */
  decision: PolicyDecision | null;
}

/** `proposals.state`, `approval_deadline` and `executed_at` as the gate wants them. */
function underReview(row: ProposalRow): ProposalUnderReview {
  return {
    id: row.id,
    action_type: row.action_type,
    target_source_records: row.target_source_records,
    impact_paise: row.impact_paise,
    evidence_chain_id: row.evidence_chain_id,
    state: row.state,
    ledger_effect: row.ledger_effect,
    corrects_ledger_set_id: row.corrects_ledger_set_id,
    approval_deadline: row.approval_deadline,
    executed_at: row.executed_at,
  };
}

/* -------------------------------------------------------------------------- */
/* The append-only Audit_Log                                                  */
/* -------------------------------------------------------------------------- */

/**
 * An in-memory `audit_events` table: a per-Tenant sequence starting at 1, a Chain_Value
 * over the previous row, and **no update and no delete method at all**.
 *
 * Requirement 13.5's immutability is kept the way it is kept in the database — by there
 * being no statement that could break it — rather than by a rejecting branch. The
 * `AuditEventStore` seam has one method, so this is not a narrowing.
 *
 * `payload_reduced` is always `false` and `payload_bytes` is the UTF-8 length of the
 * sanitized JSON: no generated payload here approaches Requirement 13.3's 65536 bytes, and
 * an oversized one is P9's subject, not P8's.
 */
function auditLog(tenantId: TenantId): {
  readonly store: AuditEventStore;
  events(): readonly AuditEvent[];
} {
  const rows: AuditEvent[] = [];

  const store: AuditEventStore = {
    append(params: AuditEventAppendParams): Promise<AuditEvent> {
      const [eventType, actorKind, actorId, stage, outcome, proposalId, refsJson, payloadJson, occurredAt] =
        params;
      const previous = rows[rows.length - 1];
      const sequence_number = BigInt(rows.length + 1);
      const source_record_refs = JSON.parse(refsJson) as readonly SourceRef[];
      const payload = JSON.parse(payloadJson) as Readonly<Record<string, unknown>>;
      const chained = {
        tenant_id: tenantId,
        sequence_number,
        event_type: eventType,
        actor_kind: actorKind,
        actor_id: actorId,
        stage,
        outcome,
        proposal_id: proposalId,
        source_record_refs,
        payload,
        occurred_at: occurredAt,
      };
      const prev_chain_value = previous === undefined ? INITIAL_CHAIN_VALUE : previous.chain_value;
      const row: AuditEvent = {
        id: randomUUID(),
        tenant_id: tenantId,
        sequence_number,
        event_type: eventType,
        stage,
        outcome,
        actor_kind: actorKind,
        actor_id: actorId,
        proposal_id: proposalId,
        source_record_refs,
        payload,
        payload_reduced: false,
        payload_bytes: Buffer.byteLength(payloadJson, 'utf8'),
        occurred_at: occurredAt,
        chain_value: chainValue(chained, prev_chain_value),
        prev_chain_value,
      };
      rows.push(row);
      return Promise.resolve(row);
    },
  };

  return { store, events: () => [...rows] };
}

/** The event type each stage's Audit_Event carries. Snake case, by the shared convention. */
const STAGE_EVENT_TYPES: Readonly<Record<ActionPipelineStage, string>> = Object.freeze({
  DETECT: 'agent_stage_completed',
  INVESTIGATE: 'agent_stage_completed',
  EXPLAIN: 'agent_stage_completed',
  PROPOSE: 'agent_stage_completed',
  AUTHORIZE: 'policy_decision_recorded',
  EXECUTE: 'proposal_executed',
  VERIFY: 'proposal_verified',
});

/* -------------------------------------------------------------------------- */
/* One run's world                                                            */
/* -------------------------------------------------------------------------- */

/** What one driven pipeline produced. Everything P8 asserts over comes from here. */
export interface PipelineRunResult {
  readonly proposal_id: string;
  /** The AUTHORIZE stage's decision (Requirement 5.4). */
  readonly decision: PolicyDecision;
  /** `proposals.state` when the run finished. */
  readonly final_state: ProposalState;
  /** Requirement 13.7's answer over the stage Audit_Events, from `stageHistoryFor`. */
  readonly stage_history: StageHistory;
  /** Every Audit_Event the run appended, in sequence order. */
  readonly audit_events: readonly AuditEvent[];
  /** Every `authorizations` row recorded against this Proposal. */
  readonly authorizations: readonly RecordedAuthorization[];
  /** The User decision, the expiry, or `null` where the behaviour was not reached. */
  readonly approval: ExecutionOutcome | RejectionOutcome | ExpiryOutcome | null;
  /** Every EXECUTE attempt the run made, in order. Never empty. */
  readonly execution_attempts: readonly ExecutionOutcome[];
  /** The VERIFY attempt. Made for every run, whatever the state. */
  readonly verification: VerificationOutcome;
  /** The `authorizations.id` the engine's EXECUTE attempt carried, where it made one. */
  readonly attempted_with_authorization_id: string | null;
  /** Ledger_Entry sets the write-capable tool actually posted. */
  readonly ledger_sets_posted: number;
}

/**
 * Drive one Action_Pipeline run end to end and return what it recorded.
 *
 * The seven stages in Requirement 5.1's order, each completed before the next begins, none
 * omitted from the attempt. What is *recorded* is what the production modules allowed —
 * see the module doc comment on why the harness attempts rather than decides.
 */
export async function runActionPipeline(run: GeneratedRun): Promise<PipelineRunResult> {
  const { proposal: generated, environment: env, behaviour } = run;

  /* ---------------------------------------------------------------- clock */
  const base = new Date(PIPELINE_BASE_INSTANT);
  /** Every production module that takes a clock reads this. Set before each step. */
  let clock = new Date(base.getTime());
  const now = (): Date => clock;

  /* ------------------------------------------------------- the row itself */
  const proposalId = randomUUID();
  const evidenceChainId = randomUUID();
  const amount: Paise = generated.impact_paise;

  const balanced: LedgerEntrySetDraft = {
    source_refs: [...generated.target_source_records],
    entry_date: ADJUSTMENT_DATE,
    entries: generated.unbalanced_effect
      ? [...balancedEntries(amount), { account_code: 'fees', side: 'debit', amount_paise: 1n }]
      : balancedEntries(amount),
  };
  const noEffect: NoLedgerEffect = {
    kind: 'none',
    reason: 'this action moves no money and writes no Ledger_Entry set',
  };
  /**
   * Only `post_reconciliation_adjustment` states a Ledger_Entry effect. The other two
   * action types state {@link NoLedgerEffect}, and `corrects_without_effect` turns that
   * stated absence into an accounting rule failure (Requirement 2.4, 2.7).
   */
  const effect: LedgerEntrySetDraft | NoLedgerEffect =
    generated.action_type === POST_RECONCILIATION_ADJUSTMENT ? balanced : noEffect;
  const correctsLedgerSetId = generated.corrects_without_effect ? randomUUID() : null;

  /** FINDING 1: `verify-execution.ts`'s assumed shape, over the figure the set would post. */
  const expectedPaise: Paise =
    generated.action_type === POST_RECONCILIATION_ADJUSTMENT && !generated.unbalanced_effect
      ? amount
      : 0n;

  const row: ProposalRow = {
    id: proposalId,
    action_type: generated.action_type,
    target_source_records: generated.target_source_records,
    impact_paise: amount,
    evidence_chain_id: evidenceChainId,
    target_fingerprint: proposalTargetFingerprint(
      generated.action_type,
      generated.target_source_records,
    ),
    ledger_effect: effect,
    corrects_ledger_set_id: correctsLedgerSetId,
    expected_outcome: { paise: encodePaise(expectedPaise), fields: {} },
    tool_arguments:
      generated.action_type === POST_RECONCILIATION_ADJUSTMENT && !generated.unbalanced_effect
        ? adjustmentArgumentsFrom(balanced)
        : { entry_date: ADJUSTMENT_DATE, entries: [], source_refs: [] },
    created_at: base.toISOString(),
    auto_execute_threshold: env.auto_execute_threshold,
    approval_window_hours: env.approval_window_hours,
    state: 'proposed',
    approval_deadline: null,
    executed_at: null,
    verified_at: null,
    decision: null,
  };

  /* -------------------------------------------------------- authorizations */
  const authorizations: RecordedAuthorization[] = [];
  const recordAuthorization = (record: Omit<RecordedAuthorization, 'id'>): string => {
    const id = randomUUID();
    authorizations.push({ id, ...record });
    return id;
  };
  if (env.rejection_on_record) {
    // A rejection already on record fails the approval requirement Policy_Check from every
    // state (Requirement 5.10), which is how this environment makes check 6 fail.
    recordAuthorization({
      proposal_id: proposalId,
      actor_kind: 'user',
      actor_user_id: PIPELINE_USER,
      decision: 'rejected',
      decided_at: base.toISOString(),
    });
  }

  /* ------------------------------------------------------- Evidence_Chain */
  const grounding: EvidenceGrounding | null =
    env.evidence === 'unreadable'
      ? null
      : {
          evidence_chain_id: evidenceChainId,
          cited_source_records:
            env.evidence === 'cites_every_target'
              ? generated.target_source_records
              : generated.target_source_records.slice(0, -1),
        };

  /* ------------------------------------------- the 30-day duplicate window */
  const priorProposals: readonly PriorProposal[] =
    env.duplicate === 'none'
      ? []
      : [
          {
            id: randomUUID(),
            action_type: generated.action_type,
            target_fingerprint: row.target_fingerprint,
            state: env.duplicate_state,
            created_at: new Date(
              base.getTime() - (env.duplicate === 'inside_window' ? 3 : 31) * 86_400_000,
            ).toISOString(),
            executed_at: null,
          },
        ];

  /* ----------------------------------------------------------- Audit_Log */
  const log = auditLog(PIPELINE_TENANT);
  const audit: AuditService = createAuditService({ store: log.store });

  const appendStage = async (
    stage: ActionPipelineStage,
    outcome: AuditOutcome,
    actor: Actor,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<AuditEvent> =>
    audit.append({
      eventType: STAGE_EVENT_TYPES[stage],
      actor,
      stage,
      outcome,
      proposalId,
      sourceRefs: generated.target_source_records,
      payload,
      occurredAt: auditTimestamp(clock),
    } satisfies AuditEventDraft);

  /* ------------------------------------------------------------------------ */
  /* The store seams, each carrying its statement's guard                     */
  /* ------------------------------------------------------------------------ */

  /** `checks.ts`'s three reads. No method takes a Tenant (Requirement 12.7, 14.1). */
  const sources: PolicyFactSources = {
    evidenceGrounding(chainId: string): Promise<EvidenceGrounding | null> {
      return Promise.resolve(chainId === evidenceChainId ? grounding : null);
    },
    priorProposals(query): Promise<readonly PriorProposal[]> {
      // `DUPLICATE_ACTION_LOOKBACK_SQL`'s own filters, so the adapter answers what the
      // statement would answer rather than handing the rule everything it holds.
      const from = Date.parse(query.window.from);
      const to = Date.parse(query.window.to);
      return Promise.resolve(
        priorProposals
          .filter(
            (candidate) =>
              candidate.target_fingerprint === query.target_fingerprint &&
              query.states.includes(candidate.state) &&
              candidate.id !== query.exclude_proposal_id,
          )
          .filter((candidate) => {
            const at = Date.parse(relevantInstantOf(candidate));
            return at >= from && at <= to;
          }),
      );
    },
    recordedAuthorizations(id: string): Promise<readonly RecordedAuthorization[]> {
      return Promise.resolve(authorizations.filter((record) => record.proposal_id === id));
    },
  };

  /** `decide.ts`'s two writes. The Authorization first, then the gate picture. */
  const policy: PolicyDecisionStore = {
    recordPolicyEngineAuthorization(id: string, decidedAt: string): Promise<string> {
      if (id !== proposalId) {
        return Promise.reject(new Error(`no Proposal ${id} for this Tenant`));
      }
      return Promise.resolve(
        recordAuthorization({
          proposal_id: id,
          actor_kind: 'policy_engine',
          actor_user_id: null,
          decision: 'approved',
          decided_at: decidedAt,
        }),
      );
    },
    persistDecision(id: string, decision: PolicyDecision): Promise<void> {
      // `PROPOSAL_DECISION_UPDATE_SQL`'s `state = ANY($6)` guard: a Proposal past a
      // decidable state keeps the gate picture of the evaluation that authorized it.
      if (id !== proposalId || !DECIDABLE_STATES.includes(row.state)) {
        return Promise.reject(
          new Error(`decision update matched no row: ${id} is ${row.state}`),
        );
      }
      row.decision = decision;
      return Promise.resolve();
    },
  };

  const snapshot = (): ActionProposalSnapshot => ({
    proposal: underReview(row),
    auto_execute_threshold: row.auto_execute_threshold,
    approval_window_hours: row.approval_window_hours,
  });

  /** Task 23.1's read and two writes. */
  const proposalStore: ActionProposalStore = {
    loadForUserDecision(id: string): Promise<ActionProposalSnapshot | null> {
      return Promise.resolve(id === proposalId ? snapshot() : null);
    },
    recordUserDecision(record: UserDecisionRecord): Promise<string> {
      if (record.proposal_id !== proposalId) {
        return Promise.reject(new Error(`no Proposal ${record.proposal_id} for this Tenant`));
      }
      return Promise.resolve(
        recordAuthorization({
          proposal_id: record.proposal_id,
          actor_kind: 'user',
          actor_user_id: record.user_id,
          decision: record.decision,
          decided_at: record.decided_at,
        }),
      );
    },
    transitionState(
      id: string,
      to: ProposalState,
      from: readonly ProposalState[],
    ): Promise<void> {
      // `PROPOSAL_STATE_TRANSITION_SQL`'s `state = ANY($4)` guard. A transition that
      // matched no row throws: the seam's contract, and the reason two concurrent
      // decisions cannot both win.
      if (id !== proposalId || !from.includes(row.state)) {
        return Promise.reject(
          new Error(`transition to ${to} matched no row: ${id} is ${row.state}`),
        );
      }
      row.state = to;
      return Promise.resolve();
    },
  };

  /** Task 23.2's read, lookup and write. */
  const executionStore: ExecutionStore = {
    loadForExecution(id: string): Promise<ProposalExecutionSnapshot | null> {
      return Promise.resolve(
        id === proposalId
          ? {
              proposal_id: proposalId,
              action_type: row.action_type,
              state: row.state,
              tool_arguments: row.tool_arguments,
            }
          : null,
      );
    },
    findAuthorization(id: string, authorizationId: string): Promise<RecordedAuthorization | null> {
      // Both identifiers in the lookup, as `EXECUTION_AUTHORIZATION_LOOKUP_SQL` has them.
      return Promise.resolve(
        authorizations.find(
          (record) => record.id === authorizationId && record.proposal_id === id,
        ) ?? null,
      );
    },
    markExecuted(id: string, executedAt: string): Promise<void> {
      // `PROPOSAL_EXECUTED_SQL`'s `state = 'authorized'` guard.
      if (id !== proposalId || row.state !== 'authorized') {
        return Promise.reject(
          new Error(`markExecuted matched no row: ${id} is ${row.state}`),
        );
      }
      row.state = 'executed';
      row.executed_at = executedAt;
      return Promise.resolve();
    },
  };

  /** Task 23.5's two reads and one write. `markExpired` reports a no-op, not a fault. */
  const expirySnapshot = (): ProposalExpirySnapshot => ({
    proposal_id: proposalId,
    state: row.state,
    approval_deadline: row.approval_deadline,
    created_at: row.created_at,
  });
  const approvalWindowStore: ApprovalWindowStore = {
    loadForExpiry(id: string): Promise<ProposalExpirySnapshot | null> {
      return Promise.resolve(id === proposalId ? expirySnapshot() : null);
    },
    overdueProposals(at: string, limit: number): Promise<readonly ProposalExpirySnapshot[]> {
      const overdue =
        row.state === 'awaiting_approval' &&
        row.approval_deadline !== null &&
        Date.parse(row.approval_deadline) < Date.parse(at);
      return Promise.resolve(overdue && limit > 0 ? [expirySnapshot()] : []);
    },
    markExpired(id: string, expiredAt: string): Promise<boolean> {
      // `PROPOSAL_EXPIRED_SQL` carries the whole condition in its `WHERE`.
      const eligible =
        id === proposalId &&
        row.state === 'awaiting_approval' &&
        row.approval_deadline !== null &&
        Date.parse(row.approval_deadline) < Date.parse(expiredAt);
      if (!eligible) {
        return Promise.resolve(false);
      }
      row.state = 'expired';
      return Promise.resolve(true);
    },
  };

  /* --------------------------------------------------- the real write path */
  const ledgerStore = new MemoryLedgerStore();
  const ledgerAudit: LedgerAuditEvent[] = [];
  const ledger = createSemanticLedger({
    store: ledgerStore,
    audit: {
      append: (event: LedgerAuditEvent): Promise<void> => {
        ledgerAudit.push(event);
        return Promise.resolve();
      },
    },
    actor: PIPELINE_AGENT,
    now,
  });
  /**
   * The gate's Authorization lookup, over the **live** rows.
   *
   * Requirement 12.10's own gate, and it is deliberately not the fixture's static list: an
   * Authorization recorded halfway through this run has to be visible to it, and a
   * synthetic identifier has to be invisible. `decision === 'approved'` is the rule the
   * fixture states and it is kept.
   */
  const gateLookup = {
    isAuthorized(ref: {
      readonly tenantId: TenantId;
      readonly proposalId: string;
      readonly authorizationId: string;
    }): Promise<boolean> {
      return Promise.resolve(
        ref.tenantId === PIPELINE_TENANT &&
          authorizations.some(
            (record) =>
              record.id === ref.authorizationId &&
              record.proposal_id === ref.proposalId &&
              record.decision === 'approved',
          ),
      );
    },
  };
  const writeAudit = recordingWriteAudit();
  const tool = createPostReconciliationAdjustment(
    {
      ledger: () => ledger,
      sources: () =>
        adjustmentSourceStore(
          generated.target_source_records.map((ref) => citedRecord(ref.type, ref.id)),
        ),
      chains: () => new MemoryEvidenceStore(),
      now,
    },
    writeGate({ authorization: gateLookup, audit: writeAudit, actor: PIPELINE_AGENT, now }),
  );
  const connections: ToolConnections = {
    acquire(mode: ToolMode): Promise<ToolConnection> {
      return Promise.resolve({
        db: {} as ToolDbClient,
        mode,
        release: (): Promise<void> => Promise.resolve(),
      });
    },
  };
  const executor = createAuthorizedExecutor({
    store: executionStore,
    registry: createToolRegistry([tool]),
    invoker: createToolInvoker({
      connections,
      audit: writeAudit,
      actor: PIPELINE_AGENT,
      authorization: gateLookup,
      now,
    }),
    session: {
      tenant_id: PIPELINE_TENANT,
      user_id: PIPELINE_USER,
      permissions: ['run_agents', 'approve_sensitive_actions'],
    },
    now,
  });

  /* ------------------------------------------------------- the VERIFY seam */
  const verificationStore: VerificationStore = {
    loadForVerification(id: string): Promise<ProposalVerificationSnapshot | null> {
      return Promise.resolve(
        id === proposalId
          ? {
              proposal_id: proposalId,
              action_type: row.action_type,
              state: row.state,
              executed_at: row.executed_at,
              target_source_records: row.target_source_records,
              evidence_chain_id: row.evidence_chain_id,
              expected_outcome: row.expected_outcome,
            }
          : null,
      );
    },
    markVerified(id: string, verifiedAt: string): Promise<void> {
      if (id !== proposalId || row.state !== 'executed') {
        return Promise.reject(new Error(`markVerified matched no row: ${id} is ${row.state}`));
      }
      row.state = 'verified';
      row.verified_at = verifiedAt;
      return Promise.resolve();
    },
    markVerificationFailed(id: string, verifiedAt: string): Promise<void> {
      if (id !== proposalId || row.state !== 'executed') {
        return Promise.reject(
          new Error(`markVerificationFailed matched no row: ${id} is ${row.state}`),
        );
      }
      row.state = 'verification_failed';
      row.verified_at = verifiedAt;
      return Promise.resolve();
    },
  };
  /**
   * The observed post-execution state: the Ledger_Entry sets the tool actually posted,
   * summed over `total_debit_paise`.
   *
   * A real observation rather than a restatement of the expectation — nothing was posted
   * unless the write-capable tool ran, so a Proposal that did not execute observes `0n`,
   * which is a difference and is reported as one (Requirement 5.12).
   */
  const observer: OutcomeObserver = {
    observe(): Promise<VerifiableOutcome> {
      const posted = ledgerStore.writes.reduce(
        (total, write) => total + write.total_debit_paise,
        0n as Paise,
      );
      return Promise.resolve({ paise: posted, fields: {} });
    },
  };
  /** Requirement 5.12's Exception writer. Reached only on a Verification difference. */
  const raisedExceptions: ExceptionUpsertInput[] = [];
  const exceptions: ExceptionUpserter = {
    upsert(input: ExceptionUpsertInput): Promise<ExceptionUpsertResult> {
      raisedExceptions.push(input);
      return Promise.resolve({
        ok: true,
        exception_id: randomUUID(),
        fingerprint: `p8:${input.category}`,
        created: true,
      });
    },
  };

  /* ------------------------------------------------------------------------ */
  /* The seven stages, in Requirement 5.1's order                             */
  /* ------------------------------------------------------------------------ */

  const granted: readonly Permission[] = [
    'view_financial_data',
    ...(env.holds_run_agents ? (['run_agents'] as const) : []),
    ...(env.holds_approval_permission ? (['approve_sensitive_actions'] as const) : []),
  ];

  const stagePayload: Readonly<Record<string, unknown>> = Object.freeze({
    action_type: generated.action_type,
    // Money crosses into the payload as digit text, never as a JSON number
    // (Requirement 13.2's shape plus 15.1, 15.8).
    impact_paise: encodePaise(amount),
    target_count: generated.target_source_records.length,
    evidence_chain_id: evidenceChainId,
  });

  // DETECT, INVESTIGATE, EXPLAIN — the Agent's, and the Agent is Python (Slice 4). The
  // Proposal row already exists in `proposed`, so every stage event can cite it; see the
  // module doc comment for the Requirement 5.2 / 13.7 / 5.1 conflict this resolves.
  await appendStage('DETECT', 'succeeded', PIPELINE_AGENT, stagePayload);
  await appendStage('INVESTIGATE', 'succeeded', PIPELINE_AGENT, stagePayload);
  await appendStage('EXPLAIN', 'succeeded', PIPELINE_AGENT, stagePayload);
  await appendStage('PROPOSE', 'succeeded', PIPELINE_AGENT, stagePayload);

  // AUTHORIZE — the Policy_Engine's, in full: six independent Policy_Checks, the risk
  // score of Requirement 5.15, one derived decision, and the Authorization of
  // Requirement 5.6 written before anything can execute.
  const decision = await authorizeProposal(
    {
      proposal: underReview(row),
      actor: PIPELINE_AGENT,
      granted_permissions: granted,
      auto_execute_threshold: row.auto_execute_threshold,
      approval_window_hours: row.approval_window_hours,
      submitted_at: base.toISOString(),
    },
    sources,
    policy,
    { decidedAt: base.toISOString() },
  );
  await appendStage(
    'AUTHORIZE',
    decision.decision === 'block' ? 'blocked' : 'succeeded',
    { kind: 'policy_engine', id: 'policy_engine' },
    {
      decision: decision.decision,
      failed_check_ids: [...decision.failed_check_ids],
      risk_score: decision.risk_score,
      auto_execute_threshold: decision.auto_execute_threshold,
      ...(decision.authorization_id === undefined
        ? {}
        : { authorization_id: decision.authorization_id }),
    },
  );

  // The state each decision implies (`decide.ts` FINDING 3: the Action_Service owns the
  // transition, and this harness stands in for the Action_Service's caller).
  const decided = proposalStateForDecision(decision.decision);
  if (decided === 'awaiting_approval') {
    // `PROPOSAL_AWAITING_APPROVAL_SQL` writes the state and the deadline together, so a
    // Proposal is never awaiting approval with no Approval_Window over it.
    await proposalStore.transitionState(proposalId, 'awaiting_approval', ['proposed']);
    row.approval_deadline = approvalDeadlineFrom(env.approval_window_hours, base);
  } else {
    await proposalStore.transitionState(proposalId, decided, ['proposed']);
  }

  /* --------------------------------------------- the generated User behaviour */
  let approval: ExecutionOutcome | RejectionOutcome | ExpiryOutcome | null = null;
  const executionAttempts: ExecutionOutcome[] = [];

  const deadlineMs =
    row.approval_deadline === null ? base.getTime() : Date.parse(row.approval_deadline);

  if (row.state === 'awaiting_approval') {
    if (behaviour === 'approve' || behaviour === 'approve_after_window') {
      // The strict boundary `at > deadline` that 23.1, 23.5 and `checks.ts` share: one
      // millisecond past the deadline is outside the Approval_Window, and the millisecond
      // before it is inside.
      clock = new Date(behaviour === 'approve' ? deadlineMs - 1 : deadlineMs + 1);
      const outcome = await approveProposal(
        {
          proposal_id: proposalId,
          user_id: PIPELINE_USER,
          granted_permissions: granted,
          decided_at: clock.toISOString(),
        },
        { store: proposalStore, policy, sources, executor },
      );
      approval = outcome;
      // Requirement 5.9's resubmission is not an eighth stage and not a second AUTHORIZE:
      // it is recorded with `stage: null`, which `AUDIT_PROPOSAL_HISTORY_SQL` filters out.
      await audit.append({
        eventType: 'proposal_resubmission_evaluated',
        actor: { kind: 'user', id: PIPELINE_USER },
        stage: null,
        outcome: null,
        proposalId,
        payload: {
          outcome_kind: outcome.kind,
          ...(outcome.kind === 'withheld' ? { withheld_reason: outcome.reason } : {}),
        },
        occurredAt: auditTimestamp(clock),
      });
      if (outcome.kind !== 'withheld') {
        executionAttempts.push(outcome);
        await appendStage(
          'EXECUTE',
          outcome.kind === 'executed' ? 'succeeded' : 'failed',
          { kind: 'user', id: PIPELINE_USER },
          {
            outcome_kind: outcome.kind,
            authorization_id: outcome.authorization_id,
            ...(outcome.kind === 'executed' ? { executed_at: outcome.executed_at } : {}),
          },
        );
      }
    } else if (behaviour === 'reject') {
      clock = new Date(deadlineMs - 1);
      approval = await rejectProposal(
        {
          proposal_id: proposalId,
          user_id: PIPELINE_USER,
          granted_permissions: granted,
          decided_at: clock.toISOString(),
        },
        { store: proposalStore },
      );
    } else {
      // The scheduled sweep, one millisecond past the deadline. It appends its own
      // non-stage `proposal_expired` Audit_Event (Requirement 5.16).
      clock = new Date(deadlineMs + 1);
      approval = await expireIfOverdue(proposalId, {
        store: approvalWindowStore,
        audit,
        actor: SWEEP_ACTOR,
        now,
      });
    }
  }

  /* ------------------------------------------------------------------------ */
  /* EXECUTE — attempted for every Proposal that reached a decision           */
  /* ------------------------------------------------------------------------ */

  /**
   * The engine attempts; the Action_Service withholds (Requirement 5.8). See the module
   * doc comment: this is what makes P8's second clause a claim about the system's gates
   * rather than about this harness's arithmetic.
   */
  let attemptedWith: string | null = null;
  if (!executionAttempts.some((outcome) => outcome.kind === 'executed')) {
    const approved = [...authorizations].reverse().find((record) => record.decision === 'approved');
    const last = authorizations[authorizations.length - 1];
    attemptedWith =
      decision.authorization_id ?? approved?.id ?? last?.id ?? SYNTHETIC_AUTHORIZATION_ID;
    clock = new Date(Math.max(clock.getTime(), deadlineMs) + 1_000);
    const outcome = await executor.executeAuthorized(proposalId, attemptedWith);
    executionAttempts.push(outcome);
    if (outcome.kind !== 'withheld') {
      await appendStage(
        'EXECUTE',
        outcome.kind === 'executed' ? 'succeeded' : 'failed',
        PIPELINE_AGENT,
        {
          outcome_kind: outcome.kind,
          authorization_id: outcome.authorization_id,
          ...(outcome.kind === 'executed' ? { executed_at: outcome.executed_at } : {}),
        },
      );
    }
  }

  /* ------------------------------------------------------------------------ */
  /* VERIFY — attempted for every Proposal that reached an EXECUTE attempt    */
  /* ------------------------------------------------------------------------ */

  clock = new Date(
    (row.executed_at === null ? clock.getTime() : Date.parse(row.executed_at)) + 1_000,
  );
  const verification = await verifyExecutedProposal(proposalId, {
    store: verificationStore,
    observer,
    exceptions,
    now,
  });
  if (verification.kind !== 'not_verified') {
    await appendStage(
      'VERIFY',
      verification.kind === 'verified' ? 'succeeded' : 'failed',
      PIPELINE_AGENT,
      {
        outcome_kind: verification.kind,
        expected_paise: encodePaise(verification.expected_paise),
        observed_paise: encodePaise(verification.observed_paise),
        difference_paise: encodePaise(verification.difference_paise),
      },
    );
  }

  /* ------------------------------------------------------------------------ */
  /* What the run recorded                                                    */
  /* ------------------------------------------------------------------------ */

  const auditEvents = log.events();
  // Exactly what `AUDIT_PROPOSAL_HISTORY_SQL` selects: this Proposal's Audit_Events with a
  // stage, ascending by sequence number. `stageHistoryFor` refuses a non-stage event, and
  // filtering here rather than inside it is the statement's job, not the function's.
  const stageEvents = auditEvents.filter(
    (event) => event.proposal_id === proposalId && event.stage !== null,
  );

  return {
    proposal_id: proposalId,
    decision,
    final_state: row.state,
    stage_history: stageHistoryFor(proposalId, stageEvents),
    audit_events: auditEvents,
    authorizations: [...authorizations],
    approval,
    execution_attempts: executionAttempts,
    verification,
    attempted_with_authorization_id: attemptedWith,
    ledger_sets_posted: ledgerStore.writes.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Oracles P8 reads                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The stages a history records as completed, in `ACTION_PIPELINE_STAGES` order.
 *
 * Derived from `stages[].completed` rather than from `events`, so "in-order prefix" and
 * "one Audit_Event per completed stage" are two independent claims rather than one
 * restated.
 */
export function completedStages(history: StageHistory): readonly ActionPipelineStage[] {
  return history.stages.filter((entry) => entry.completed).map((entry) => entry.stage);
}

/**
 * Is the completed set an **in-order prefix** of the seven stages?
 *
 * True when the completed stages are the first `n` of `ACTION_PIPELINE_STAGES` for some
 * `n` — which is Requirement 5.1's "SHALL complete each stage before beginning the next
 * stage, and SHALL omit no stage" read as a statement about the Audit_Log.
 */
export function isInOrderPrefix(history: StageHistory): boolean {
  const completed = completedStages(history);
  return ACTION_PIPELINE_STAGES.slice(0, completed.length).every(
    (stage, index) => completed[index] === stage,
  );
}

/** The Audit_Events recording the EXECUTE stage for this Proposal. P8's first clause. */
export function executeStageEvents(history: StageHistory): readonly AuditEvent[] {
  return history.events.filter((event) => event.stage === 'EXECUTE');
}

/** The four `proposal_state` labels P8 forbids an EXECUTE-stage Audit_Event under. */
export const NON_EXECUTED_TERMINAL_STATES: readonly ProposalState[] = [
  'blocked',
  'awaiting_approval',
  'rejected',
  'expired',
];
