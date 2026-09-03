/**
 * The EXECUTE-failure reversal path (task 23.4).
 * Requirement 5.17.
 *
 * The Exception writer here is the **real** one — `createExceptionUpserter` over the same
 * in-memory `exceptions_fingerprint_uniq` store the Reconciliation_Agent's and task 23.3's
 * tests use — so "creates an `execution_failure` Exception identifying the Proposal and the
 * failure reason" is asserted by the row that lands, through the real fingerprint, the real
 * `impact_paise >= 0` rule and the real direction-against-zero rule. A stub would have
 * accepted an Exception the database rejects.
 *
 * What is pinned:
 *
 * 1. **All four obligations land together**, in the order state → Exception → reversals, and
 *    one `reverseSet` per applied set.
 * 2. **An already-reversed set is skipped.** `reverseSet` is not idempotent (task 24.2's P14
 *    asserts that reversing twice yields two independent reversal sets), so this is what
 *    makes the path repeat-safe.
 * 3. **A resumption from `execution_failed`** finishes an interrupted handling: no second
 *    transition, `failed_at` unmoved, the same Exception row, the remaining set reversed.
 * 4. **The applied sets are not part of the Exception's identity**, so a resumption that
 *    sees a different number of them cannot open a second Exception (FINDING 3).
 * 5. **Obligation 4 agrees with the gate rather than restating it**: the row this module
 *    leaves fails `approvalRequirementCheck` on the old Authorization and passes on one
 *    dated after the failure instant.
 * 6. **The statements**: the failure transition is task 23.2's `executed` one with the state
 *    literal changed and nothing else, and the applied-sets query cannot read a reversal
 *    back as an applied change.
 */

import { describe, expect, it } from 'vitest';

import { createExceptionUpserter } from '@/agents/exception-fingerprint';
import {
  memoryExceptionStore,
  type MemoryExceptionStore,
} from '@/agents/reconciliation/agent.test-support';
import type { Actor, TenantId } from '@/config/configuration-service';
import type { SourceRef } from '@/ledger/posting-rules';
import type { PostResult } from '@/ledger/semantic-ledger';
import {
  approvalRequirementCheck,
  PROPOSAL_STATES,
  type PolicyCheckInput,
  type ProposalState,
  type RecordedAuthorization,
} from '@/policy/checks';
import { toWire } from '@/wire/paise-wire';

import { ActionServiceError, type ExecutionFailedOutcome } from './action-service';
import { EXECUTABLE_STATES, PROPOSAL_EXECUTED_SQL } from './execute-authorized';
import {
  APPLIED_LEDGER_SETS_SQL,
  appliedDebitTotalPaise,
  appliedLedgerSetsParams,
  createExecutionFailureRecorder,
  EXECUTION_FAILURE_CATEGORY,
  executionFailureException,
  FAILURE_RECORDABLE_STATES,
  failureRecordingRefusalFor,
  NOT_RECORDED_REASONS,
  PROPOSAL_EXECUTION_FAILED_SQL,
  PROPOSAL_FAILURE_LOAD_SQL,
  proposalExecutionFailedParams,
  proposalFailureLoadParams,
  recordExecutionFailure,
  withExecutionFailureReversal,
  type AppliedLedgerSet,
  type ExecutionFailureOutcome,
  type ExecutionFailureRecorded,
  type FailureReversalDeps,
  type FailureReversalStore,
  type ProposalFailureSnapshot,
} from './reverse-failed-execution';

const TENANT: TenantId = '11111111-1111-4111-8111-111111111111';
const PROPOSAL_ID = '22222222-2222-4222-8222-222222222222';
const AUTHORIZATION_ID = '44444444-4444-4444-8444-444444444444';
const CHAIN_ID = '33333333-3333-4333-8333-333333333333';
const SET_A = '55555555-5555-4555-8555-555555555555';
const SET_B = '66666666-6666-4666-8666-666666666666';
/** ₹3,82,000 in paise: the impact the Proposal stated. */
const IMPACT_PAISE = 38200000n;
const FAILED_AT = '2026-03-01T00:05:00.000Z';
const ACTOR: Actor = { kind: 'user', id: '77777777-7777-4777-8777-777777777777' };

const TARGETS: readonly SourceRef[] = [
  { type: 'settlement', id: 'setl_SYNTHETIC9281' },
  { type: 'settlement_recon_report', id: 'setlrcn_SYNTHETIC9281' },
];

/** Task 23.2's own output: the value this module is handed. */
const FAILURE: ExecutionFailedOutcome = {
  kind: 'execution_failed',
  proposal_id: PROPOSAL_ID,
  authorization_id: AUTHORIZATION_ID,
  tool: 'post_reconciliation_adjustment',
  failure: 'tool_failure',
  detail: 'post_reconciliation_adjustment failed with cause upstream_error',
};

const applied = (setId: string, reversed = false): AppliedLedgerSet => ({
  set_id: setId,
  total_debit_paise: IMPACT_PAISE,
  reversed,
});

/* -------------------------------------------------------------------------- */
/* The world                                                                  */
/* -------------------------------------------------------------------------- */

/** `proposals`, in the two columns this path writes. */
interface Row {
  state: ProposalState;
  executed_at: string | null;
}

interface World {
  readonly deps: FailureReversalDeps;
  /** Every write, in order, so state → Exception → reversals is assertable. */
  readonly log: string[];
  readonly exceptions: MemoryExceptionStore;
  readonly row: Row;
  /** One entry per `reverseSet` call, in order. */
  readonly reversed: string[];
  /** Mutable, so a resumption can be given a different answer than the first pass. */
  sets: AppliedLedgerSet[];
}

function world(
  options: {
    readonly state?: ProposalState;
    readonly executedAt?: string | null;
    readonly sets?: readonly AppliedLedgerSet[];
    readonly absent?: boolean;
    readonly reverse?: (setId: string) => PostResult;
    readonly at?: string;
  } = {},
): World {
  const log: string[] = [];
  const exceptions = memoryExceptionStore(() => log.push('exception'));
  const row: Row = {
    state: options.state ?? 'authorized',
    executed_at: options.executedAt === undefined ? null : options.executedAt,
  };
  const sets: AppliedLedgerSet[] = [...(options.sets ?? [])];
  const reversed: string[] = [];

  const snapshot = (): ProposalFailureSnapshot => ({
    proposal_id: PROPOSAL_ID,
    action_type: 'post_reconciliation_adjustment',
    state: row.state,
    executed_at: row.executed_at,
    target_source_records: TARGETS,
    evidence_chain_id: CHAIN_ID,
    impact_paise: IMPACT_PAISE,
  });

  const store: FailureReversalStore = {
    loadForFailure: (id) =>
      Promise.resolve(options.absent === true || id !== PROPOSAL_ID ? null : snapshot()),
    appliedLedgerSets: () => {
      log.push('load_applied');
      return Promise.resolve(sets.map((set) => ({ ...set })));
    },
    // The `AND state = 'authorized'` guard, and the throw-on-no-row rule the seam states.
    markExecutionFailed: (_id, failedAt) => {
      if (row.state !== 'authorized') {
        throw new Error(`markExecutionFailed matched no row: the Proposal is ${row.state}`);
      }
      row.state = 'execution_failed';
      row.executed_at = failedAt;
      log.push('execution_failed');
      return Promise.resolve();
    },
  };

  const world: World = {
    log,
    exceptions,
    row,
    reversed,
    sets,
    deps: {
      store,
      ledger: {
        reverseSet: (tenantId, setId, actor) => {
          expect(tenantId, 'reverseSet takes the session Tenant, never a caller argument').toBe(
            TENANT,
          );
          expect(actor, 'the reversal is attributed to the session actor').toEqual(ACTOR);
          reversed.push(setId);
          log.push(`reverse:${setId}`);
          const result = options.reverse?.(setId) ?? {
            ok: true,
            set_id: `rev-${setId}`,
            created: true,
          };
          if (result.ok) {
            // The ledger is append-only: a posted reversal is what makes the original
            // "already reversed" for every later pass.
            const index = sets.findIndex((set) => set.set_id === setId);
            const original = sets[index];
            if (original !== undefined) {
              sets[index] = { ...original, reversed: true };
            }
          }
          return Promise.resolve(result);
        },
      },
      exceptions: createExceptionUpserter({ store: exceptions, tenantId: TENANT }),
      tenantId: TENANT,
      actor: ACTOR,
      now: () => new Date(options.at ?? FAILED_AT),
    },
  };
  return world;
}

const recorded = (outcome: ExecutionFailureOutcome): ExecutionFailureRecorded => {
  if (outcome.kind !== 'execution_failure_recorded') {
    throw new Error(`expected the failure to be recorded, got ${outcome.kind}: ${outcome.detail}`);
  }
  return outcome;
};

/* -------------------------------------------------------------------------- */
/* All four obligations                                                       */
/* -------------------------------------------------------------------------- */

describe('Requirement 5.17: the four obligations land together', () => {
  it('marks the Proposal, reverses each applied set, raises the Exception, and stamps the failure instant', async () => {
    const w = world({ sets: [applied(SET_A), applied(SET_B)] });

    const outcome = recorded(await recordExecutionFailure(FAILURE, w.deps));

    // Obligation 1: marked execution-failed, with the instant of the failed attempt.
    expect(w.row).toEqual({ state: 'execution_failed', executed_at: FAILED_AT });
    expect(outcome.failed_at).toBe(FAILED_AT);
    expect(outcome.transitioned).toBe(true);

    // Obligation 2: one reversing set per applied set, in posting order.
    expect(w.reversed).toEqual([SET_A, SET_B]);
    expect(outcome.reversals).toEqual([
      { set_id: SET_A, outcome: 'reversed', reversal_set_id: `rev-${SET_A}` },
      { set_id: SET_B, outcome: 'reversed', reversal_set_id: `rev-${SET_B}` },
    ]);

    // Obligation 3: one `execution_failure` Exception, naming the Proposal and the reason.
    const rows = [...w.exceptions.rows.values()];
    expect(rows).toHaveLength(1);
    const exception = rows[0];
    if (exception === undefined) {
      throw new Error('no Exception was written');
    }
    expect(exception.category).toBe(EXECUTION_FAILURE_CATEGORY);
    expect(exception.state).toBe('open');
    expect(outcome.exception_id).toBe(exception.id);
    expect(outcome.exception_open).toBe(true);
    // The Proposal is attached as a Source_Record, so it reaches the Attention_Panel's
    // evidence rather than only `detail`; the targets follow it.
    expect(exception.links).toEqual([
      { source_record_type: 'proposal', source_record_id: PROPOSAL_ID, role: 'proposal' },
      { source_record_type: 'settlement', source_record_id: 'setl_SYNTHETIC9281', role: 'target' },
      {
        source_record_type: 'settlement_recon_report',
        source_record_id: 'setlrcn_SYNTHETIC9281',
        role: 'target',
      },
    ]);
    const detail = JSON.parse(exception.detail) as Record<string, unknown>;
    expect(detail.proposal_id).toBe(PROPOSAL_ID);
    expect(detail.failure).toBe('tool_failure');
    expect(detail.failure_detail).toBe(FAILURE.detail);
    expect(detail.failed_at).toBe(FAILED_AT);
    // Money in `detail` is the decimal string `toWire` produces, never a JSON number.
    expect(detail.applied_debit_total_paise).toBe(toWire(IMPACT_PAISE * 2n));
    expect(detail.proposal_impact_paise).toBe(toWire(IMPACT_PAISE));
    expect(detail.pending_reversal_set_ids).toEqual([SET_A, SET_B]);
    // The impact is the Proposal's stated magnitude, with no direction: once every applied
    // change is reversed nothing is short and nothing is in excess (FINDING 2).
    expect(exception.impact_paise).toBe(toWire(IMPACT_PAISE));
    expect(exception.direction).toBe('not_applicable');
    expect(exception.evidence_chain_id).toBe(CHAIN_ID);
  });

  it('writes the state first, then the Exception, then the reversals', async () => {
    const w = world({ sets: [applied(SET_A), applied(SET_B)] });

    await recordExecutionFailure(FAILURE, w.deps);

    // The state stamp is first because until it lands the Proposal is `authorized`, which is
    // the one state task 23.2 executes from — so the same Authorization could drive a second
    // invocation. The Exception precedes the only fallible, multi-step part of the path.
    expect(w.log).toEqual([
      'execution_failed',
      'load_applied',
      'exception',
      `reverse:${SET_A}`,
      `reverse:${SET_B}`,
    ]);
  });

  it('records the failure for a Proposal that applied nothing', async () => {
    // An invocation can fail before it writes anything, and that is also what FINDING 1
    // makes the answer for every Proposal until `ledger_entry_sets.proposal_id` is written.
    const w = world();

    const outcome = recorded(await recordExecutionFailure(FAILURE, w.deps));

    expect(outcome.reversals).toEqual([]);
    expect(w.reversed).toEqual([]);
    // The other three obligations still land: 5.17 does not make them conditional on there
    // being something to reverse.
    expect(w.row.state).toBe('execution_failed');
    expect(w.exceptions.rows.size).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Repeat safety: reverseSet is not idempotent                                */
/* -------------------------------------------------------------------------- */

describe('an already-reversed set is skipped', () => {
  it('never asks the ledger to reverse a set that already carries a reversal', async () => {
    // Task 24.2's P14: reversing twice yields two independent reversal sets, so a second
    // reversal would leave the accounts wrong by the original amount rather than being a
    // no-op. The record of what is reversed is the ledger's own `reverses_set_id`.
    const w = world({ sets: [applied(SET_A, true), applied(SET_B)] });

    const outcome = recorded(await recordExecutionFailure(FAILURE, w.deps));

    expect(w.reversed).toEqual([SET_B]);
    expect(outcome.reversals).toEqual([
      { set_id: SET_A, outcome: 'already_reversed' },
      { set_id: SET_B, outcome: 'reversed', reversal_set_id: `rev-${SET_B}` },
    ]);
  });

  it('resumes an interrupted handling from execution_failed without moving the failure instant', async () => {
    // First pass: the state stamp and the Exception land, and SET_A is reversed. Then it is
    // interrupted — modelled by handing the resumption a world already in that shape.
    const first = world({ sets: [applied(SET_A), applied(SET_B)] });
    await recordExecutionFailure(FAILURE, first.deps);
    expect(first.row.executed_at).toBe(FAILED_AT);

    // The resumption runs later, and both remaining writes must be repeat-safe.
    const later = '2026-03-01T00:09:00.000Z';
    const resumed = world({
      state: 'execution_failed',
      executedAt: FAILED_AT,
      sets: [applied(SET_A, true), applied(SET_B)],
      at: later,
    });
    const outcome = recorded(await recordExecutionFailure(FAILURE, resumed.deps));

    // The transition is not re-run: `executed_at` is the deadline a retry's Authorization
    // must beat, and moving it forward would invalidate an approval already given.
    expect(outcome.transitioned).toBe(false);
    expect(outcome.failed_at).toBe(FAILED_AT);
    expect(resumed.row).toEqual({ state: 'execution_failed', executed_at: FAILED_AT });
    expect(resumed.log).toEqual(['load_applied', 'exception', `reverse:${SET_B}`]);
    expect(outcome.reversals).toEqual([
      { set_id: SET_A, outcome: 'already_reversed' },
      { set_id: SET_B, outcome: 'reversed', reversal_set_id: `rev-${SET_B}` },
    ]);
  });

  it('re-raises one Exception rather than a second one, whatever the applied set count', () => {
    // FINDING 3: the applied sets are in `detail`, not in `source_refs`. `execution_failure`
    // is not range-scoped, so its whole ref set is its identity (Requirement 4.15) — putting
    // the sets there would make a resumption that saw a different number of them compute a
    // different fingerprint and open a second Exception for one failure.
    const base = {
      proposal_id: PROPOSAL_ID,
      authorization_id: AUTHORIZATION_ID,
      action_type: 'post_reconciliation_adjustment',
      tool: 'post_reconciliation_adjustment',
      failure: 'tool_failure' as const,
      failure_detail: FAILURE.detail,
      target_source_records: TARGETS,
      evidence_chain_id: CHAIN_ID,
      impact_paise: IMPACT_PAISE,
      failed_at: FAILED_AT,
      detected_at: FAILED_AT,
    };

    const one = executionFailureException({ ...base, applied: [applied(SET_A)] });
    const two = executionFailureException({
      ...base,
      applied: [applied(SET_A, true), applied(SET_B)],
    });

    expect(one.source_refs).toEqual(two.source_refs);
    // `context_refs` would be rejected for a non-range-scoped category, so there is no
    // second place the sets could have gone.
    expect(one.context_refs).toBeUndefined();
    // The sets live where a re-run may rewrite them.
    expect(two.detail.pending_reversal_set_ids).toEqual([SET_B]);
    expect(two.detail.already_reversed_set_ids).toEqual([SET_A]);
  });
});

/* -------------------------------------------------------------------------- */
/* Refusals: nothing written, nothing reversed                                */
/* -------------------------------------------------------------------------- */

describe('refusals', () => {
  it('refuses a Proposal that does not resolve for this Tenant', async () => {
    const w = world({ absent: true });

    const outcome = await recordExecutionFailure(FAILURE, w.deps);

    expect(outcome.kind).toBe('not_recorded');
    expect(outcome).toMatchObject({ reason: 'proposal_absent' });
    expect(w.log).toEqual([]);
  });

  it('refuses every state but authorized and execution_failed, writing nothing', async () => {
    for (const state of PROPOSAL_STATES) {
      if (FAILURE_RECORDABLE_STATES.includes(state)) {
        continue;
      }
      const w = world({ state, sets: [applied(SET_A)] });

      const outcome = await recordExecutionFailure(FAILURE, w.deps);

      expect(outcome.kind, state).toBe('not_recorded');
      expect(outcome, state).toMatchObject({ reason: 'not_a_failed_execution', state });
      // No transition, no Exception, and above all no reversal of a change no requirement
      // asks to be reversed.
      expect(w.log, state).toEqual([]);
      expect(w.reversed, state).toEqual([]);
      expect(w.row.state, state).toBe(state);
    }
  });

  it('says a completed execution is left in place for human review', () => {
    const refusal = failureRecordingRefusalFor({
      proposal_id: PROPOSAL_ID,
      action_type: 'post_reconciliation_adjustment',
      state: 'verification_failed',
      executed_at: FAILED_AT,
      target_source_records: TARGETS,
      evidence_chain_id: CHAIN_ID,
      impact_paise: IMPACT_PAISE,
    });

    expect(refusal?.reason).toBe('not_a_failed_execution');
    expect(refusal?.detail).toContain('human review');
    expect(NOT_RECORDED_REASONS).toContain(refusal?.reason);
  });

  it('treats a stored state that is not a proposal_state label as a corrupt row', async () => {
    const w = world({ state: 'nonsense' as ProposalState });

    await expect(recordExecutionFailure(FAILURE, w.deps)).rejects.toThrow(ActionServiceError);
    expect(w.log).toEqual([]);
  });

  it('treats an execution_failed Proposal with no failure instant as a corrupt row', async () => {
    // Only task 23.1's generic transition statement can produce one, and the gate cannot
    // tell a new Authorization from the old one for it — so it is reported, not defaulted.
    const w = world({ state: 'execution_failed', executedAt: null, sets: [applied(SET_A)] });

    await expect(recordExecutionFailure(FAILURE, w.deps)).rejects.toThrow(/not an instant/);
    expect(w.reversed).toEqual([]);
  });

  it('throws when the ledger refuses a reversal, with the Exception already open', async () => {
    // FINDING 5: unreachable for a correctly persisted set, and a fault rather than an
    // outcome if reached. "Handled" must not be available for a Proposal whose money stands.
    const w = world({
      sets: [applied(SET_A)],
      reverse: () => ({
        ok: false,
        kind: 'unbalanced',
        imbalance_paise: 100n,
        source_refs: TARGETS,
      }),
    });

    await expect(recordExecutionFailure(FAILURE, w.deps)).rejects.toThrow(
      /refused the reversal of Ledger_Entry set/,
    );
    // The Exception is written before the reversals precisely so this case is visible.
    expect(w.exceptions.rows.size).toBe(1);
    expect(w.row.state).toBe('execution_failed');
  });
});

/* -------------------------------------------------------------------------- */
/* Obligation 4: no further execution without a new Authorization             */
/* -------------------------------------------------------------------------- */

describe('no further execution without a new Authorization', () => {
  it('leaves a state task 23.2 will not execute from', () => {
    // The other half of obligation 4, and it is task 23.2's: `execution_failed` is not an
    // executable state, in TypeScript and in `PROPOSAL_EXECUTED_SQL`'s own guard.
    expect(EXECUTABLE_STATES).not.toContain('execution_failed');
  });

  it('leaves a row the gate reads as needing a NEW Authorization', async () => {
    const w = world({ sets: [applied(SET_A)] });
    const outcome = recorded(await recordExecutionFailure(FAILURE, w.deps));

    // The row as this module leaves it, handed to `approvalRequirementCheck` — the one place
    // the retry rule lives (`src/policy/checks.ts`). Nothing here restates it.
    const gateInput = (authorizations: readonly RecordedAuthorization[]): PolicyCheckInput => ({
      submission: {
        proposal: {
          id: PROPOSAL_ID,
          action_type: 'post_reconciliation_adjustment',
          target_source_records: TARGETS,
          impact_paise: IMPACT_PAISE,
          evidence_chain_id: CHAIN_ID,
          state: w.row.state,
          ledger_effect: { kind: 'none', reason: 'the retry has not been drafted yet' },
          executed_at: w.row.executed_at,
        },
        actor: ACTOR,
        granted_permissions: ['approve_sensitive_actions'],
        risk_score: 40,
        auto_execute_threshold: 0,
        submitted_at: '2026-03-01T00:10:00.000Z',
      },
      facts: {
        evidence: { available: true, value: null },
        prior_proposals: { available: true, value: [] },
        authorizations: { available: true, value: authorizations },
      },
    });

    const authorization = (decidedAt: string): RecordedAuthorization => ({
      id: AUTHORIZATION_ID,
      proposal_id: PROPOSAL_ID,
      actor_kind: 'user',
      actor_user_id: ACTOR.id,
      decision: 'approved',
      decided_at: decidedAt,
    });

    // The Authorization the failed attempt rested on is not a new one.
    const onOldApproval = approvalRequirementCheck(gateInput([authorization('2026-03-01T00:04:00.000Z')]));
    expect(onOldApproval.result).toBe('fail');
    expect(onOldApproval.detail).toContain('new Authorization');

    // One recorded after the failure instant this module stamped is.
    const onNewApproval = approvalRequirementCheck(
      gateInput([authorization('2026-03-01T00:06:00.000Z')]),
    );
    expect(onNewApproval.result).toBe('pass');
    // And the instant they are compared against is the one the outcome reports.
    expect(w.row.executed_at).toBe(outcome.failed_at);
  });
});

/* -------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* -------------------------------------------------------------------------- */

describe('wiring', () => {
  it('records a failure returned by the executor and leaves other outcomes alone', async () => {
    const w = world({ sets: [applied(SET_A)] });
    const wrapped = withExecutionFailureReversal(
      { executeAuthorized: () => Promise.resolve(FAILURE) },
      w.deps,
    );

    expect(await wrapped.executeAuthorized(PROPOSAL_ID, AUTHORIZATION_ID)).toEqual(FAILURE);
    expect(w.row.state).toBe('execution_failed');
    expect(w.reversed).toEqual([SET_A]);

    const clean = world({ sets: [applied(SET_A)] });
    const executed = withExecutionFailureReversal(
      {
        executeAuthorized: () =>
          Promise.resolve({
            kind: 'executed' as const,
            proposal_id: PROPOSAL_ID,
            authorization_id: AUTHORIZATION_ID,
            executed_at: FAILED_AT,
          }),
      },
      clean.deps,
    );

    await executed.executeAuthorized(PROPOSAL_ID, AUTHORIZATION_ID);
    expect(clean.log).toEqual([]);
    expect(clean.row.state).toBe('authorized');
  });

  it('binds the session Tenant and the actor at construction', async () => {
    const w = world({ sets: [applied(SET_A)] });
    const recorder = createExecutionFailureRecorder(w.deps);

    // `record(failure)` carries no tenant id: the Tenant is the session's (Requirement 12.7),
    // and `reverseSet`'s first argument is checked against it inside the fake.
    const outcome = recorded(await recorder.record(FAILURE));
    expect(outcome.proposal_id).toBe(PROPOSAL_ID);
    expect(outcome.authorization_id).toBe(AUTHORIZATION_ID);
  });

  it('rejects an empty identifier as a caller fault rather than a refusal', async () => {
    const w = world();

    await expect(
      recordExecutionFailure({ ...FAILURE, proposal_id: '  ' }, w.deps),
    ).rejects.toThrow(ActionServiceError);
    await expect(
      recordExecutionFailure({ ...FAILURE, authorization_id: '' }, w.deps),
    ).rejects.toThrow(ActionServiceError);
    expect(w.log).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The statements an adapter runs                                             */
/* -------------------------------------------------------------------------- */

describe('the statements an adapter runs', () => {
  it('is task 23.2 executed transition with the state literal changed and nothing else', () => {
    expect(PROPOSAL_EXECUTION_FAILED_SQL).toContain("SET state = 'execution_failed'");
    expect(PROPOSAL_EXECUTION_FAILED_SQL).toContain('executed_at = $3::timestamptz');
    expect(PROPOSAL_EXECUTION_FAILED_SQL).toContain("AND state = 'authorized'");
    expect(PROPOSAL_EXECUTION_FAILED_SQL).toContain('RETURNING id, state, executed_at');
    // The two directions of the EXECUTE stage, recorded with identical provenance.
    expect(PROPOSAL_EXECUTED_SQL.replace("'executed'", "'execution_failed'")).toBe(
      PROPOSAL_EXECUTION_FAILED_SQL,
    );
    // The state is a literal, so this statement cannot be bent into a sibling's transition.
    expect(PROPOSAL_EXECUTION_FAILED_SQL).not.toContain('verified');
    expect(PROPOSAL_EXECUTION_FAILED_SQL).not.toContain('expired');

    expect(proposalExecutionFailedParams(TENANT, PROPOSAL_ID, FAILED_AT)).toEqual([
      TENANT,
      PROPOSAL_ID,
      FAILED_AT,
    ]);
  });

  it('cannot read a reversal back as an applied change, and answers whether one exists', () => {
    expect(APPLIED_LEDGER_SETS_SQL).toContain('s.proposal_id = $2::uuid');
    // Without this a resumed handling would reverse the corrections the first pass posted.
    expect(APPLIED_LEDGER_SETS_SQL).toContain('s.reverses_set_id IS NULL');
    expect(APPLIED_LEDGER_SETS_SQL).toContain('r.reverses_set_id = s.id');
    expect(APPLIED_LEDGER_SETS_SQL).toContain('AS reversed');
    // Deterministic order, so two passes report the same list.
    expect(APPLIED_LEDGER_SETS_SQL).toContain('ORDER BY s.created_at, s.id');
    // Money crosses as a decimal string (Requirement 15.1, 15.8).
    expect(APPLIED_LEDGER_SETS_SQL).toContain('s.total_debit_paise::text');
    expect(APPLIED_LEDGER_SETS_SQL).not.toContain('SUM(');

    expect(appliedLedgerSetsParams(TENANT, PROPOSAL_ID)).toEqual([TENANT, PROPOSAL_ID]);
  });

  it('loads the impact as a decimal string and does not read expected_outcome', () => {
    expect(PROPOSAL_FAILURE_LOAD_SQL).toContain('impact_paise::text AS impact_paise');
    expect(PROPOSAL_FAILURE_LOAD_SQL).toContain('executed_at');
    // A failed execution has no observed outcome to compare against the expected one.
    expect(PROPOSAL_FAILURE_LOAD_SQL).not.toContain('expected_outcome');
    expect(PROPOSAL_FAILURE_LOAD_SQL).toContain('WHERE tenant_id = $1');

    expect(proposalFailureLoadParams(TENANT, PROPOSAL_ID)).toEqual([TENANT, PROPOSAL_ID]);
  });

  it('sums the applied debit totals on bigint, and gives 0 for none', () => {
    expect(appliedDebitTotalPaise([])).toBe(0n);
    expect(appliedDebitTotalPaise([applied(SET_A), applied(SET_B)])).toBe(IMPACT_PAISE * 2n);
  });
});
