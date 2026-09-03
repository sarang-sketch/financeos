// Feature: financeos-control-tower, Property 8: Authorization completeness — for all generated
// Action_Pipeline runs, every Proposal that reached the EXECUTE stage has an Authorization record
// referencing that Proposal in the Audit_Log, no Proposal in a blocked, awaiting-approval,
// rejected or expired state has any EXECUTE-stage Audit_Event, and the recorded stage sequence is
// an in-order prefix of DETECT, INVESTIGATE, EXPLAIN, PROPOSE, AUTHORIZE, EXECUTE, VERIFY with
// exactly one Audit_Event per completed stage.
//
// **Validates: Requirements 5.1, 5.6, 5.7, 5.14, 12.10, 13.7**
//
// WHY THIS RUNS IN PROCESS AND NOT AGAINST SUPABASE LOCAL
// ------------------------------------------------------
// design.md puts P8 in the group that "run[s] against Supabase local with a per-iteration
// transactional reset". It cannot today, and the reasons are structural rather than a preference.
// Recorded here rather than left for a reader to rediscover:
//
//   1. **The pipeline is many round trips, and `test/db/pg.ts` opens one `psql` session per
//      script.** One run is an AUTHORIZE evaluation (3 reads, 2 writes), a User decision (1 read,
//      2 writes), an execution (2 reads, 1 write, plus the tool's own), a Verification (1 read,
//      1 write) and 7 audit appends — each a separate TypeScript call, so each would be a separate
//      session. A separate session cannot see an uncommitted row, so "per-iteration transactional
//      reset" and "the services read what the previous step wrote" are mutually exclusive through
//      that seam. P14 resolved the same conflict by committing; here that would mean committing
//      `audit_events` rows, which revoke `DELETE`, so `npx supabase db reset` becomes the only
//      cleanup — at 7+ events per iteration over 300 iterations, for a property whose subject is
//      the control flow rather than the storage.
//   2. **`app.append_audit_event_autonomous` fails with `dblink_connect` `2F003`**, and production
//      `audit_sequence_counters` rows are not seeded (25.1 owns `AUDIT_SEQUENCE_COUNTER_SEED_SQL`,
//      and P9's half B seeds it per fixture Tenant). So the audit append path that a real pipeline
//      would use from inside a transaction is not available at all.
//   3. **`proposals.expected_outcome` has no stated shape** (five tasks have now flagged it), and
//      `proposals` is RLS `ENABLE`d and `FORCE`d with no policies until task 26.1.
//
// What is lost by running in process is stated rather than glossed: P8 here asserts nothing about
// RLS (P7's), nothing about the SQL Chain_Value (P9's, whose half B2 documents the `jsonb::text`
// versus `canonicalJson` divergence that makes the SQL side unrecomputable today), and nothing
// about the append-only barrier (task 25.5's). What is NOT lost is every decision P8 is about:
// the six Policy_Checks, the risk score, the derived decision, the Authorization write ordering,
// the approval, the rejection, the Approval_Window boundary, the EXECUTE gate, the tool's own
// Requirement 12.10 gate, and Requirement 13.7's stage history — all production code, listed in
// `./pipeline-harness.ts`'s doc comment.
//
// THE HARNESS ATTEMPTS; THE ACTION_SERVICE WITHHOLDS
// -------------------------------------------------
// The harness does not decide which Proposals may execute. It attempts EXECUTE for every Proposal
// that reached a decision — blocked, awaiting approval, rejected, expired, unapproved — and
// attempts VERIFY for every Proposal that reached an EXECUTE attempt. The withholding is
// `EXECUTABLE_STATES` and the Authorization lookup's, per Requirement 5.8. That is what makes
// clause 2 a claim about the system rather than about the harness's own arithmetic: widen either
// gate and P8 fails, which the falsification log below shows rather than asserts.
//
// AND THE HARNESS IS THE SLICE 4 CONTRACT, NOT A SUBSTITUTE FOR IT
// ---------------------------------------------------------------
// The Python Agent Engine of Slice 4 must append the same stage Audit_Events this harness appends
// — one per completed stage, `proposal_id` on all seven (which needs the `proposals` row created
// at pipeline start, the conflict `auditAppendPlan` reports and does not resolve), Requirement
// 5.9's resubmission recorded with `stage: null`, and no EXECUTE event for a withheld execution.
// The property is written against `stageHistoryFor` and the stored rows, not against the harness's
// bookkeeping, so a divergence between engine and harness surfaces as a P8 failure rather than as
// an untested gap. That is the whole reason the oracle is the production history function.
//
// ITERATIONS AND SEED
// -------------------
// `numRuns: 300`, above design.md's floor of 100 and below the 1000 of P1, P3, P11 and P12.
// Coverage-driven: the closing test demands all six Policy_Check identifiers observed failing, all
// three decisions, all four approval behaviours, both duplicate window positions, an unresolvable
// threshold, at least one Proposal executed and verified, and at least one resubmission blocked
// after an approval — and 100 runs leave the last of those thin. The whole property is in process,
// so 300 iterations cost about 2 seconds. The seed is explicit and committed, per design.md's
// "seed and record" rule.
//
// "EXACTLY ONE EVENT PER COMPLETED STAGE" AGAINST REQUIREMENT 5.17'S RETRY — THE READING, AND
// WHAT THE SPEC DOES NOT DETERMINE
// -----------------------------------------------------------------------------------------------
// Task 25.4 reported that a **repeated** stage event is possible: Requirement 5.17 permits a
// further attempt at an execution-failed Proposal "with a new Authorization", and that attempt
// appends a second EXECUTE Audit_Event under the same `proposal_id`. `stageHistoryFor` surfaces
// those in `repeated_stage_events` rather than hiding them, so the reading is a choice this
// property has to make rather than one it can avoid. The reading taken, stated:
//
//   - **P8 asserts the strict form — `repeated_stage_events` is empty — over the runs this harness
//     generates, and that is sound here because no generated run retries.** The harness produces no
//     execution failure at all (`pipeline-harness.ts` FINDING 4: 23.4's reversal loop is factually
//     inert because nothing populates `ledger_entry_sets.proposal_id`), and `EXECUTABLE_STATES` is
//     `['authorized']`, so no Proposal in this input space reaches a second EXECUTE. The strict
//     assertion is therefore a real constraint on the runs generated and not a claim about retries.
//   - **What P8 does NOT assert is that a retry is a P8 violation.** The clause it exists for —
//     every EXECUTE Audit_Event has an Authorization behind it — is *strengthened* by a retry, not
//     weakened: Requirement 5.17 demands a new Authorization before the second attempt, so a
//     conforming retry adds an EXECUTE event and an Authorization together.
//
// **This is escalated rather than decided here.** Requirement 13.7 says the stage history returns
// "exactly 1 Audit_Event per completed Action_Pipeline stage", and Requirement 5.17 permits a
// second EXECUTE event for one Proposal. Those two sentences cannot both hold literally for a
// retried Proposal, and neither requirements.md nor design.md says which gives way — whether 13.7
// returns the first EXECUTE event, the last, or all of them with the stage marked completed once.
// Until that is stated, P8 asserts emptiness only over an input space that contains no retry, and a
// future task that generates an execution failure must not simply widen this assertion: it needs
// the specification decision first. `stageHistoryFor` reporting repeats separately is what keeps
// that decision open instead of baking one answer into the oracle.
//
// NO ROWS ARE COMMITTED
// ---------------------
// Nothing here touches Postgres, so there is no cleanup cost of the kind P14's header prices for
// `ledger_entries`. Every run builds a fresh in-memory `proposals`, `authorizations` and
// `audit_events` for one Tenant and discards it; the Audit_Log has no update and no delete method
// at all, which is how Requirement 13.5's immutability is kept here — by there being no statement
// that could break it, as in the database.
//
// NOT VACUOUS
// -----------
// Checked by falsification, one mutation per clause, each reverted. No regression test is committed
// for any of them, because the counterexamples came from deliberately broken code rather than from
// a defect in the system.
//
// A DEFECT FOUND WHILE RE-VERIFYING, AND WHAT IT SAYS ABOUT CLAUSE 3
// ------------------------------------------------------------------
// Clause 3's mutation below was found still applied to production code — `proposalExpiredEvent` in
// `src/action/expire-approval-window.ts` was stamping `stage: 'VERIFY', outcome: 'succeeded'` while
// its own doc comment and FINDING 6 both say `stage` and `outcome` are `null`, and 23.5's unit test
// asserts null. It has been reverted to `stage: null, outcome: null`. Two things follow, and both
// are results rather than housekeeping:
//
//   - P8 caught it on the fourth generated run, with the counterexample recorded below
//     (`{ seed: 20260808, path: "3:0:0:0:0:0:1" }`) — an unreverted mutation to the Audit_Log's
//     stage attribution is exactly the class of defect clause 3 exists to catch, and it caught one
//     it had not been pointed at.
//   - It is a live demonstration, not a replay: the property was run against the repository as
//     found, failed on clause 3, the single production line was reverted, and the property passed.
//
// CLAUSE 1 — THE HARNESS CAN ACTUALLY VIOLATE IT, DEMONSTRATED RATHER THAN ARGUED
// ------------------------------------------------------------------------------
// "Every Proposal with an EXECUTE Audit_Event has at least one Authorization" is the invariant P8
// exists for, and a harness that appends an EXECUTE event only after the executor returns
// non-withheld could be accused of making it true by construction. It does not, and the way that
// was established is one edit and one run:
//
//   The EXECUTE-stage append in `runActionPipeline` was made **unconditional** — appended for every
//   attempt including a withheld one, carrying `attemptedWith` as the `authorization_id` — leaving
//   every production gate intact. Clause 1's first assertion fires immediately:
//
//     Error: Property failed after 1 tests
//     { seed: 20260808, path: "0:0:0:0:0:0", endOnFailure: true }
//     Counterexample: [{"proposal":{"action_type":"post_reconciliation_adjustment","impact_paise":1n,
//       "target_source_records":[{"type":"settlement","id":"setl_P8AAA1"}],
//       "unbalanced_effect":false,"corrects_without_effect":true},
//       "environment":{"holds_run_agents":true,"holds_approval_permission":true,
//       "evidence":"cites_every_target","auto_execute_threshold":0,"approval_window_hours":1,
//       "duplicate":"inside_window","duplicate_state":"proposed","rejection_on_record":false},
//       "behaviour":"approve"}]
//     Shrunk 5 time(s)
//     Caused by: AssertionError: EXECUTE Audit_Event 6 with no Authorization for
//       0a607911-af8c-4776-bb71-e00862a8fe0a: expected 0 to be greater than or equal to 1
//
//   Read it: the Proposal was blocked (`corrects_without_effect` fails the accounting rule check,
//   `duplicate: "inside_window"` fails the duplicate check), so **zero** `authorizations` rows
//   exist, and the EXECUTE event the mutation appended has nothing behind it. Sequence number 6 is
//   the sixth event of the run — DETECT, INVESTIGATE, EXPLAIN, PROPOSE, AUTHORIZE, then the EXECUTE
//   that should not exist. The mutation was reverted.
//
//   So the log **can** carry an EXECUTE event with no Authorization, and the reason it never does is
//   the production refusal: `authorization_unresolvable` and `not_authorized_for_execution` are both
//   demanded above zero by the coverage test, and `syntheticAuthorizationAttempts` counts the runs
//   that pushed an Authorization identifier the store never issued at
//   `executeAuthorized` — 108 of 300 on the committed seed. Those attempts are refused by
//   `executionAuthorizationRefusal`, not skipped by the harness.
//
//   - **Clause 2**, `EXECUTABLE_STATES` in `src/action/execute-authorized.ts` widened to
//     `['authorized', 'blocked']` — a Proposal the gate blocked becoming executable:
//
//       Error: Property failed after 175 tests
//       { seed: 20260808, path: "174:1:1:1:0:0:0:0:0", endOnFailure: true }
//       Counterexample: [{"proposal":{"action_type":"post_reconciliation_adjustment",
//         "impact_paise":1n,"target_source_records":[{"type":"settlement_recon_report",
//         "id":"setl_recon_P8AAA1"}],"unbalanced_effect":false,"corrects_without_effect":false},
//         "environment":{"holds_run_agents":true,"holds_approval_permission":false,
//         "evidence":"cites_every_target","auto_execute_threshold":0,"approval_window_hours":1,
//         "duplicate":"none","duplicate_state":"proposed","rejection_on_record":false},
//         "behaviour":"approve"}]
//       Shrunk 8 time(s)
//       Caused by: Error: markExecuted matched no row:
//                  46404632-255e-446a-b305-88c588004524 is blocked
//
//     Read the shrunk counterexample: it is the one path in the input space that reaches EXECUTE
//     holding a resolvable Authorization over a Proposal the state machine forbids executing —
//     `holds_run_agents` true so the submission passes the gate, `holds_approval_permission`
//     false so Requirement 5.9's resubmission blocks after the User's approval is already on
//     record. And note **which** barrier answered: not the assertion, but
//     `PROPOSAL_EXECUTED_SQL`'s `state = 'authorized'` guard, mirrored in the harness store. The
//     invariant is defended in depth, which is the finding rather than an inconvenience. The
//     coverage test failed alongside it, on `not_authorized_for_execution` dropping to 0 —
//     independent evidence that the mutation changed which gate refused. Re-run as part of this
//     task's verification and reproduced identically — same seed, same path
//     `174:1:1:1:0:0:0:0:0`, same 8 shrinks, same `markExecuted matched no row: … is blocked` —
//     then reverted, so the falsification is reproducible from this file rather than only
//     recorded in it.
//
//     Relaxing that store guard as well (a **harness-side** edit, stated as such) lets the run
//     reach the assertion, and it is clause 2 that fires:
//
//       Caused by: AssertionError: Proposal 9a021c9a-15c7-4aca-9acb-4b6f13e15aa3 carries an
//         EXECUTE Audit_Event although the resubmission after the approval returned block:
//         expected 1 to be +0
//
//     That failure is why clause 2 is read from the Audit_Log and not only from
//     `proposals.state`: with the store guard relaxed the row says `executed`, so a
//     state-only clause would have passed over the exact defect it exists to catch.
//   - **Clause 3**, `proposalExpiredEvent` in `src/action/expire-approval-window.ts` attributing
//     the Approval_Window expiry to a stage (`stage: 'VERIFY'`, `outcome: 'succeeded'` instead of
//     `null`/`null`) — the mistake `history.ts`'s scope statement exists to prevent:
//
//       Error: Property failed after 4 tests
//       { seed: 20260808, path: "3:0:0:0:0:0:0", endOnFailure: true }
//       Counterexample: [{"proposal":{"action_type":"post_reconciliation_adjustment",
//         "impact_paise":1n,"target_source_records":[{"type":"payment","id":"pay_P8BBB2"}], … },
//         "environment":{ …,"duplicate":"outside_window", … },"behaviour":"expire"}]
//       Shrunk 6 time(s)
//       Caused by: AssertionError: stages out of order:
//         completed [DETECT, INVESTIGATE, EXPLAIN, PROPOSE, AUTHORIZE, VERIFY]:
//         expected false to be true
//
//     The message names the violation rather than only reporting one: VERIFY completed with
//     EXECUTE absent, which is not a prefix of the seven stages. `duplicate: "outside_window"`
//     survives shrinking because a duplicate outside the 30 days does **not** fail the check, so
//     the Proposal still reaches `require_approval` and the sweep still expires it.
//   - **Clause 1** could not be falsified by removing any *single* production gate, and that is
//     worth reporting as a result rather than as an absence. Three independent gates stand
//     between an EXECUTE Audit_Event and a missing Authorization: `EXECUTABLE_STATES`,
//     `executionAuthorizationRefusal`'s `decision === 'approved'` clause, and the write-capable
//     tool's own Requirement 12.10 gate. Removing the first two (production) still yields
//     `withheld` because the tool refuses; the tool's gate consults a lookup this harness
//     supplies, so reaching the assertion took four edits — two production
//     (`EXECUTABLE_STATES = ['authorized', 'rejected']` and the `decision !== 'approved'` branch
//     disabled) and two harness-side (the gate lookup and the `markExecuted` guard relaxed):
//
//       Error: Property failed after 15 tests
//       { seed: 20260808, path: "14:2:2:1:1:0:0:0:0:0:0:0:0:0:1:0:0:0:0:0:0:0", endOnFailure: true }
//       Counterexample: [{"proposal":{"action_type":"post_reconciliation_adjustment",
//         "impact_paise":1n,"target_source_records":[{"type":"refund","id":"rfnd_P8CCC3"}], … },
//         "environment":{"holds_run_agents":true,"holds_approval_permission":true, … },
//         "behaviour":"reject"}]
//       Shrunk 33 time(s)
//       Caused by: AssertionError: expected false to be true
//
//     `expected false to be true` is clause 1's second assertion — the Authorization the
//     execution rested on records a **rejection**, so `referencing.some(r => r.decision ===
//     'approved')` is false. Shrinking lands on `behaviour: "reject"` with everything else
//     benign, which is the only shape where an `authorizations` row exists and is not an
//     approval (Requirement 5.10). Every edit was reverted.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { ACTION_PIPELINE_STAGES } from '@/audit/audit-service';
import type { SourceRef } from '@/ledger/posting-rules';
import { DUPLICATE_BLOCKING_STATES, PROPOSAL_STATES, type PolicyCheckId, type ProposalState } from '@/policy/checks';
import type { PolicyDecisionKind } from '@/policy/decide';
import type { WithheldReason } from '@/action/action-service';

import {
  APPROVAL_BEHAVIOURS,
  completedStages,
  executeStageEvents,
  isInOrderPrefix,
  NON_EXECUTED_TERMINAL_STATES,
  PIPELINE_TARGET_POOL,
  PROPOSAL_ACTION_TYPES,
  runActionPipeline,
  type ApprovalBehaviour,
  type GeneratedActionType,
  type GeneratedPolicyEnvironment,
  type GeneratedProposal,
  type GeneratedRun,
} from './pipeline-harness';
import { POST_RECONCILIATION_ADJUSTMENT } from '@/tools/post-reconciliation-adjustment';

/** Explicit and committed, so any counterexample is reproducible from this file alone. */
const SEED = 20260808;

/** Coverage-driven, above design.md's floor of 100. See the header. */
const NUM_RUNS = 300;

const PARAMS = { numRuns: NUM_RUNS, seed: SEED } as const;

/* -------------------------------------------------------------------------- */
/* Generators — design.md's three P8 inputs                                   */
/* -------------------------------------------------------------------------- */

/**
 * Impact in integer paise, biased onto the `IMPACT_BANDS` boundaries.
 *
 * `bigint` throughout: `proposals.impact_paise` is the `paise` domain and Requirement 5.15
 * computes the risk score from it, so a value that had passed through a double would decide what
 * may execute (Requirement 15.1, 15.8). The band edges are drawn explicitly because the risk
 * score is what separates a Safe_Action from a Sensitive_Action (Requirement 5.6, 5.7), and a
 * generator that never sat on a boundary would leave the comparison untested there.
 */
const arbitraryImpactPaise: fc.Arbitrary<bigint> = fc.oneof(
  { weight: 3, arbitrary: fc.bigInt({ min: 1n, max: 99_999_999_999_990n }) },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      1n,
      99_999n,
      100_000n,
      999_999n,
      1_000_000n,
      10_000_000n,
      100_000_000n,
      1_000_000_000n,
      99_999_999_999_990n,
    ),
  },
);

/**
 * At least 1 target Source_Record: a Proposal with no target has no `target_fingerprint`, so the
 * duplicate action Policy_Check could never recognise a repeat and `checks.ts` refuses it
 * outright. `fc.subarray` preserves pool order and never repeats a member.
 */
const arbitraryTargets: fc.Arbitrary<readonly SourceRef[]> = fc.subarray(
  [...PIPELINE_TARGET_POOL],
  { minLength: 1, maxLength: PIPELINE_TARGET_POOL.length },
);

/** design.md's `arbitraryProposal`: action type, impact paise, target set, evidence shortfall. */
const arbitraryProposal: fc.Arbitrary<GeneratedProposal> = fc
  .record({
    action_type: fc.oneof<fc.WeightedArbitrary<GeneratedActionType>[]>(
      { weight: 4, arbitrary: fc.constant(POST_RECONCILIATION_ADJUSTMENT) },
      { weight: 1, arbitrary: fc.constant('mark_exception_resolved') },
      { weight: 1, arbitrary: fc.constant('initiate_payment_retry') },
    ),
    impact_paise: arbitraryImpactPaise,
    target_source_records: arbitraryTargets,
    unbalanced_effect: fc.oneof(
      { weight: 6, arbitrary: fc.constant(false) },
      { weight: 1, arbitrary: fc.constant(true) },
    ),
    corrects_without_effect: fc.oneof(
      { weight: 6, arbitrary: fc.constant(false) },
      { weight: 1, arbitrary: fc.constant(true) },
    ),
  })
  .map((proposal) => proposal satisfies GeneratedProposal);

/**
 * design.md's `arbitraryPolicyEnvironment`: which of the six Policy_Checks fail, the configured
 * Auto_Execute_Threshold 0..100, and whether a duplicate exists within 30 days.
 *
 * Each dimension is the *condition* that makes one check fail, not a flag that forces its result
 * — the checks are production code and they decide:
 *
 * | Check | Condition drawn here |
 * |---|---|
 * | `user_permission` | `holds_run_agents: false` (Requirement 14.6) |
 * | `accounting_rule` | `unbalanced_effect` or `corrects_without_effect` on the Proposal (Requirement 2.4, 2.6) |
 * | `transaction_evidence` | `evidence: 'cites_some_targets' \| 'unreadable'` (Requirement 12.2, 12.3) |
 * | `duplicate_action` | `duplicate: 'inside_window'` with a blocking `duplicate_state` (Requirement 5.13) |
 * | `risk_threshold` | `auto_execute_threshold: null` (Requirement 5.15) |
 * | `approval_requirement` | `rejection_on_record: true` (Requirement 5.10) |
 *
 * `holds_approval_permission: false` is the one that fails a check on the **resubmission** rather
 * than the submission: Requirement 5.9 resubmits with `approve_sensitive_actions` required, so a
 * Proposal can pass the gate, be approved by a User, and block on the way back — which is the
 * only path in this input space that reaches EXECUTE with a resolvable Authorization over a
 * Proposal the state machine forbids executing. Clause 2's falsification lives there.
 */
const arbitraryPolicyEnvironment: fc.Arbitrary<GeneratedPolicyEnvironment> = fc.record({
  holds_run_agents: fc.oneof(
    { weight: 6, arbitrary: fc.constant(true) },
    { weight: 1, arbitrary: fc.constant(false) },
  ),
  holds_approval_permission: fc.oneof(
    { weight: 4, arbitrary: fc.constant(true) },
    { weight: 1, arbitrary: fc.constant(false) },
  ),
  evidence: fc.oneof<fc.WeightedArbitrary<GeneratedPolicyEnvironment['evidence']>[]>(
    { weight: 6, arbitrary: fc.constant('cites_every_target') },
    { weight: 1, arbitrary: fc.constant('cites_some_targets') },
    { weight: 1, arbitrary: fc.constant('unreadable') },
  ),
  auto_execute_threshold: fc.oneof<fc.WeightedArbitrary<number | null>[]>(
    { weight: 10, arbitrary: fc.integer({ min: 0, max: 100 }) },
    { weight: 1, arbitrary: fc.constant(null) },
  ),
  approval_window_hours: fc.oneof(
    { weight: 2, arbitrary: fc.integer({ min: 1, max: 168 }) },
    { weight: 1, arbitrary: fc.constantFrom(1, 24, 168) },
  ),
  duplicate: fc.oneof<fc.WeightedArbitrary<GeneratedPolicyEnvironment['duplicate']>[]>(
    { weight: 5, arbitrary: fc.constant('none') },
    { weight: 2, arbitrary: fc.constant('inside_window') },
    { weight: 1, arbitrary: fc.constant('outside_window') },
  ),
  // All 10 labels, not only the 5 blocking ones: `DUPLICATE_BLOCKING_STATES` is a production
  // decision (`checks.ts` FINDING 1) and drawing only from it would make the check's state
  // filter untested.
  duplicate_state: fc.constantFrom(...PROPOSAL_STATES),
  rejection_on_record: fc.oneof(
    { weight: 8, arbitrary: fc.constant(false) },
    { weight: 1, arbitrary: fc.constant(true) },
  ),
});

/** design.md's `arbitraryApprovalBehaviour`: approve, reject, let expire, approve after the window. */
const arbitraryApprovalBehaviour: fc.Arbitrary<ApprovalBehaviour> = fc.constantFrom(
  ...APPROVAL_BEHAVIOURS,
);

const arbitraryRun: fc.Arbitrary<GeneratedRun> = fc.record({
  proposal: arbitraryProposal,
  environment: arbitraryPolicyEnvironment,
  behaviour: arbitraryApprovalBehaviour,
});

/* -------------------------------------------------------------------------- */
/* Shape coverage, so no required shape can silently stop occurring           */
/* -------------------------------------------------------------------------- */

const coverage = {
  decisions: new Map<PolicyDecisionKind, number>(),
  failedChecks: new Map<PolicyCheckId, number>(),
  behaviours: new Map<ApprovalBehaviour, number>(),
  finalStates: new Map<ProposalState, number>(),
  withheldReasons: new Map<WithheldReason, number>(),
  actionTypes: new Map<GeneratedActionType, number>(),
  /** Runs whose Proposal actually executed, i.e. reached the EXECUTE stage. */
  executed: 0,
  /** Runs whose Verification concluded and matched. */
  verified: 0,
  /** Approvals whose resubmission returned `block` (Requirement 5.9's own condition). */
  resubmissionBlocked: 0,
  /** Duplicate lookback positions, and how often a duplicate actually blocked. */
  duplicateInside: 0,
  duplicateOutside: 0,
  duplicateBlocked: 0,
  /** Runs where the Auto_Execute_Threshold did not resolve (Requirement 5.15). */
  thresholdUnresolved: 0,
  /** The EXECUTE attempts made with an Authorization identifier that was never recorded. */
  syntheticAuthorizationAttempts: 0,
  maxImpactPaise: 0n,
  minImpactPaise: 99_999_999_999_999n,
  maxCompletedStages: 0,
};

function bump<K>(counter: Map<K, number>, key: K): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

/* -------------------------------------------------------------------------- */

describe('Property 8: authorization completeness', () => {
  it('never records an EXECUTE stage without an Authorization, never records one for a withheld Proposal, and records the stages as an in-order prefix', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryRun, async (run) => {
        const result = await runActionPipeline(run);

        /* ---------------------------------------------------------- tallies */
        bump(coverage.decisions, result.decision.decision);
        bump(coverage.behaviours, run.behaviour);
        bump(coverage.finalStates, result.final_state);
        bump(coverage.actionTypes, run.proposal.action_type);
        for (const id of result.decision.failed_check_ids) {
          bump(coverage.failedChecks, id);
        }
        for (const attempt of result.execution_attempts) {
          if (attempt.kind === 'withheld') {
            bump(coverage.withheldReasons, attempt.reason);
          }
        }
        if (result.approval !== null && 'reason' in result.approval) {
          bump(coverage.withheldReasons, result.approval.reason as WithheldReason);
          if (result.approval.reason === 'resubmission_blocked') {
            coverage.resubmissionBlocked += 1;
          }
        }
        if (run.environment.duplicate === 'inside_window') {
          coverage.duplicateInside += 1;
          if (DUPLICATE_BLOCKING_STATES.includes(run.environment.duplicate_state)) {
            coverage.duplicateBlocked += 1;
          }
        }
        if (run.environment.duplicate === 'outside_window') {
          coverage.duplicateOutside += 1;
        }
        if (run.environment.auto_execute_threshold === null) {
          coverage.thresholdUnresolved += 1;
        }
        if (result.attempted_with_authorization_id !== null && result.authorizations.length === 0) {
          coverage.syntheticAuthorizationAttempts += 1;
        }
        if (result.verification.kind === 'verified') {
          coverage.verified += 1;
        }
        coverage.maxImpactPaise =
          run.proposal.impact_paise > coverage.maxImpactPaise
            ? run.proposal.impact_paise
            : coverage.maxImpactPaise;
        coverage.minImpactPaise =
          run.proposal.impact_paise < coverage.minImpactPaise
            ? run.proposal.impact_paise
            : coverage.minImpactPaise;

        const history = result.stage_history;
        const completed = completedStages(history);
        const executes = executeStageEvents(history);
        coverage.maxCompletedStages = Math.max(coverage.maxCompletedStages, completed.length);
        if (executes.length > 0) {
          coverage.executed += 1;
        }

        /* ------------------------------------------------------------------ */
        /* Clause 1 — Requirement 5.14, 5.6: every Proposal that reached      */
        /* EXECUTE has an Authorization referencing it                        */
        /* ------------------------------------------------------------------ */
        for (const event of executes) {
          const referencing = result.authorizations.filter(
            (record) => record.proposal_id === result.proposal_id,
          );
          expect(
            referencing.length,
            `EXECUTE Audit_Event ${event.sequence_number} with no Authorization for ` +
              `${result.proposal_id}`,
          ).toBeGreaterThanOrEqual(1);
          // Requirement 5.6's automatic path and Requirement 5.9's human path both record an
          // *approval*; a rejection is not an authorization to execute (Requirement 5.10), so the
          // clause is asserted on the decision as well as on the count.
          expect(referencing.some((record) => record.decision === 'approved')).toBe(true);
          // The identifier the execution rested on is one of them, so "has an Authorization" is
          // the Authorization it actually executed against and not merely one that exists.
          const restedOn = event.payload['authorization_id'];
          expect(referencing.map((record) => record.id)).toContain(restedOn);
        }

        /* ------------------------------------------------------------------ */
        /* Clause 2 — no blocked, awaiting-approval, rejected or expired      */
        /* Proposal has any EXECUTE-stage Audit_Event                         */
        /* ------------------------------------------------------------------ */
        // Read from the Audit_Log as well as from `proposals.state`, and the reason is that a
        // system which wrongly executed a blocked Proposal would ALSO move its row to
        // `executed` — so a clause asserted on the row alone would be blind to exactly the
        // defect it exists to catch. `audit_events` is append-only, so the record that the
        // Proposal was withheld cannot be erased by the write that should not have happened.
        const authorizeEvent = history.events.find((event) => event.stage === 'AUTHORIZE');
        const withholdings: readonly (readonly [string, boolean])[] = [
          // Requirement 5.5: 1 or more Policy_Checks failed, so the Proposal is retained
          // without execution.
          ['the AUTHORIZE stage recorded outcome blocked', authorizeEvent?.outcome === 'blocked'],
          // Requirement 5.16: the Approval_Window elapsed, so execution is withheld permanently.
          [
            'an Approval_Window expiry is on record',
            result.audit_events.some((event) => event.event_type === 'proposal_expired'),
          ],
          // Requirement 5.9: the resubmitted evaluation returned block.
          [
            'the resubmission after the approval returned block',
            result.audit_events.some(
              (event) =>
                event.event_type === 'proposal_resubmission_evaluated' &&
                event.payload['withheld_reason'] === 'resubmission_blocked',
            ),
          ],
          // Requirement 5.10: a rejection discards the Proposal without execution, and a later
          // approval cannot un-discard it.
          [
            'a rejection is on record',
            result.authorizations.some((record) => record.decision === 'rejected'),
          ],
          // And the state clause as design.md words it.
          [
            `the Proposal is ${result.final_state}`,
            NON_EXECUTED_TERMINAL_STATES.includes(result.final_state),
          ],
        ];
        const withheld = withholdings.filter(([, holds]) => holds).map(([why]) => why);
        if (withheld.length > 0) {
          expect(
            executes.length,
            `Proposal ${result.proposal_id} carries an EXECUTE Audit_Event although ` +
              `${withheld.join('; ')}`,
          ).toBe(0);
          // Requirement 5.5, 5.8 and 5.10's "no change to Tenant state", read on the one write
          // this path could have made: a withheld execution posted no Ledger_Entry set. The
          // write-capable tool's own Requirement 12.10 gate is the second barrier behind
          // `EXECUTABLE_STATES`, and this is what says neither was bypassed.
          expect(result.ledger_sets_posted).toBe(0);
        }

        /* ------------------------------------------------------------------ */
        /* Clause 3 — the recorded stage sequence is an in-order prefix of    */
        /* the seven stages, with exactly one Audit_Event per completed stage */
        /* ------------------------------------------------------------------ */
        expect(
          isInOrderPrefix(history),
          `stages out of order: completed [${completed.join(', ')}]`,
        ).toBe(true);
        // Exactly one per completed stage, and none beyond them.
        expect(history.events).toHaveLength(completed.length);
        expect(history.repeated_stage_events).toEqual([]);
        // The stages with no Audit_Event are named, and they are exactly the suffix
        // (Requirement 13.7's "not completed").
        expect(history.not_completed).toEqual(ACTION_PIPELINE_STAGES.slice(completed.length));
        // Every pipeline completes at least the five stages that do not depend on a gate:
        // DETECT, INVESTIGATE, EXPLAIN, PROPOSE and AUTHORIZE (Requirement 5.1, 5.2, 5.4).
        expect(completed.length).toBeGreaterThanOrEqual(5);
        // Ascending sequence numbers, which is the order Requirement 13.7 returns them in and
        // the order the stages ran in.
        const sequences = history.events.map((event) => event.sequence_number);
        expect([...sequences].sort((a, b) => (a < b ? -1 : 1))).toEqual(sequences);
      }),
      PARAMS,
    );
  });

  it('exercised every Policy_Check failure, all three decisions and all four approval behaviours', () => {
    console.warn(
      `[P8] ${JSON.stringify(
        {
          ...coverage,
          decisions: Object.fromEntries(coverage.decisions),
          failedChecks: Object.fromEntries(coverage.failedChecks),
          behaviours: Object.fromEntries(coverage.behaviours),
          finalStates: Object.fromEntries(coverage.finalStates),
          withheldReasons: Object.fromEntries(coverage.withheldReasons),
          actionTypes: Object.fromEntries(coverage.actionTypes),
        },
        (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
      )}`,
    );

    // All three decisions of Requirement 5.4. Without `auto_execute` the automatic
    // Authorization of Requirement 5.6 is never written, and clause 1 would only ever be
    // asserted over the human path.
    for (const decision of ['block', 'auto_execute', 'require_approval'] as const) {
      expect(coverage.decisions.get(decision) ?? 0, decision).toBeGreaterThan(0);
    }
    // All six Policy_Check identifiers observed failing, so the gate picture is exercised on
    // every check rather than on whichever one the generator happened to reach.
    for (const check of [
      'user_permission',
      'accounting_rule',
      'transaction_evidence',
      'duplicate_action',
      'risk_threshold',
      'approval_requirement',
    ] as const) {
      expect(coverage.failedChecks.get(check) ?? 0, check).toBeGreaterThan(0);
    }
    // All four behaviours design.md's generator names.
    for (const behaviour of APPROVAL_BEHAVIOURS) {
      expect(coverage.behaviours.get(behaviour) ?? 0, behaviour).toBeGreaterThan(0);
    }
    // Every state clause 2 forbids an EXECUTE event under was actually reached, so the clause is
    // not vacuous for any of the four.
    for (const state of NON_EXECUTED_TERMINAL_STATES) {
      expect(coverage.finalStates.get(state) ?? 0, state).toBeGreaterThan(0);
    }
    // The withholding reasons that carry the EXECUTE gate (Requirement 5.14, 12.10) and the
    // Approval_Window boundary (Requirement 5.16).
    for (const reason of [
      'authorization_unresolvable',
      'not_authorized_for_execution',
      'approval_window_elapsed',
      'execution_tool_absent',
    ] as const) {
      expect(coverage.withheldReasons.get(reason) ?? 0, reason).toBeGreaterThan(0);
    }
    // Clause 1 needs Proposals that really executed, and clause 3 needs a full seven-stage run.
    expect(coverage.executed).toBeGreaterThan(0);
    expect(coverage.verified).toBeGreaterThan(0);
    expect(coverage.maxCompletedStages).toBe(ACTION_PIPELINE_STAGES.length);
    // The one path that reaches EXECUTE holding a resolvable Authorization over a Proposal the
    // state machine forbids executing: an approval whose resubmission blocked (Requirement 5.9).
    // Clause 2's falsification lives here, so a generator that stopped producing it would make
    // that falsification unreproducible.
    expect(coverage.resubmissionBlocked).toBeGreaterThan(0);
    // Both duplicate window positions, and at least one duplicate that actually blocked.
    expect(coverage.duplicateInside).toBeGreaterThan(0);
    expect(coverage.duplicateOutside).toBeGreaterThan(0);
    expect(coverage.duplicateBlocked).toBeGreaterThan(0);
    // An unresolvable Auto_Execute_Threshold, which is the risk threshold check's real fail.
    expect(coverage.thresholdUnresolved).toBeGreaterThan(0);
    // EXECUTE attempts carrying an Authorization identifier that was never recorded, which is
    // what Requirement 5.14's gate has to refuse.
    expect(coverage.syntheticAuthorizationAttempts).toBeGreaterThan(0);
    // The impact range was exercised at both ends: the risk score's bands are computed over
    // paise, and a generator confined to small values would only ever produce low-risk
    // Proposals (Requirement 5.15).
    expect(coverage.minImpactPaise).toBeLessThan(1_000_000n);
    expect(coverage.maxImpactPaise).toBeGreaterThan(1_000_000_000n);
    // Every action type design.md's `ACTION_POINTS` scores, including the two that name no
    // write-capable tool (`pipeline-harness.ts` FINDING 2).
    for (const actionType of PROPOSAL_ACTION_TYPES) {
      expect(coverage.actionTypes.get(actionType) ?? 0, actionType).toBeGreaterThan(0);
    }
  });
});
