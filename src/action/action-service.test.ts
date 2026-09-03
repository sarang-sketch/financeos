/**
 * Approval, rejection, and the withholding between them (task 23.1).
 * Requirements 5.8, 5.9, 5.10, 5.14.
 *
 * The fakes are one small in-memory world rather than three unrelated stubs, and that
 * is deliberate: the store's `authorizations` rows are the same rows the Policy_Check
 * facts read back. So the ordering Requirement 5.9 fixes — record the Authorization,
 * *then* resubmit — is load-bearing here rather than merely asserted. Reverse the two
 * lines in `approveProposal` and the approval requirement Policy_Check fails on an
 * `awaiting_approval` Proposal with no approval on record, the resubmission returns
 * `block`, and every approval test in this file goes red.
 *
 * What is pinned:
 *
 * 1. **Execution rests on the Authorization this module wrote** (Requirement 5.14), and
 *    the call order is Authorization → resubmission → state → execute.
 * 2. **Every refusal writes nothing at all** (Requirement 5.8, 5.10's "no change to
 *    Tenant state"): the recorded call list is empty on each one.
 * 3. **A `block` on resubmission stops the execution the User asked for** (5.9), leaves
 *    the approval on record, and retains the Proposal as `blocked` (5.5).
 * 4. **A `require_approval` on resubmission executes.** It is the *expected* answer for
 *    an approved Sensitive_Action — nothing about the Proposal changed, so the score
 *    still exceeds the threshold — and 5.9 executes on any decision other than `block`.
 * 5. **The approval path requires `approve_sensitive_actions`**, not `run_agents`.
 * 6. **The three statements** are asserted textually: the literal `'user'` actor with a
 *    parameterised `actor_user_id`, the state guard on the transition, and the paise
 *    column crossing as text.
 */

import { describe, expect, it } from 'vitest';

import type { LedgerEntrySetDraft, SourceRef } from '@/ledger/posting-rules';
import type {
  PolicyFactSources,
  ProposalState,
  ProposalUnderReview,
  RecordedAuthorization,
} from '@/policy/checks';
import type { PolicyDecisionStore } from '@/policy/decide';
import type { Permission } from '@/tools/tool';

import {
  ACTION_PROPOSAL_LOAD_SQL,
  actionProposalLoadParams,
  ActionServiceError,
  APPROVAL_PERMISSION,
  type ActionProposalSnapshot,
  type ActionProposalStore,
  type ActionServiceDeps,
  approveProposal,
  type AuthorizedExecutor,
  createApprovalActions,
  PROPOSAL_STATE_TRANSITION_SQL,
  proposalStateTransitionParams,
  refusalFor,
  rejectProposal,
  USER_AUTHORIZATION_SQL,
  USER_DECIDABLE_STATES,
  userAuthorizationParams,
  WITHHELD_REASONS,
} from './action-service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PROPOSAL = '22222222-2222-4222-8222-222222222222';
const CHAIN = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';

const NOW = '2026-03-01T00:00:00.000Z';
const DEADLINE = '2026-03-02T00:00:00.000Z';
const AFTER_DEADLINE = '2026-03-02T00:00:00.001Z';

const SETTLEMENT: SourceRef = { type: 'settlement', id: 'setl_SYNTHETIC9282' };

/** Far enough out that a test using the real clock is inside the Approval_Window. */
const OPEN_WINDOW = '2099-01-01T00:00:00.000Z';

const BALANCED: LedgerEntrySetDraft = {
  source_refs: [SETTLEMENT],
  entry_date: '2026-02-28',
  entries: [
    { account_code: 'bank', side: 'debit', amount_paise: 38_200_000n },
    { account_code: 'settlement_pending', side: 'credit', amount_paise: 38_200_000n },
  ],
};

function proposal(overrides: Partial<ProposalUnderReview> = {}): ProposalUnderReview {
  return {
    id: PROPOSAL,
    action_type: 'post_reconciliation_adjustment',
    target_source_records: [SETTLEMENT],
    impact_paise: 38_200_000n,
    evidence_chain_id: CHAIN,
    state: 'awaiting_approval',
    ledger_effect: BALANCED,
    approval_deadline: DEADLINE,
    ...overrides,
  };
}

/**
 * One in-memory Tenant: a `proposals` row, its `authorizations` rows, and a recorded
 * call list. The Policy_Check facts read the same rows the store writes.
 */
function world(
  options: {
    readonly proposal?: Partial<ProposalUnderReview>;
    readonly threshold?: number | null;
    /** `null` makes the Evidence_Chain unresolvable, so the resubmission blocks. */
    readonly cited?: readonly SourceRef[] | null;
  } = {},
): {
  readonly deps: ActionServiceDeps;
  readonly calls: string[];
  readonly authorizations: readonly RecordedAuthorization[];
  state(): ProposalState;
} {
  const calls: string[] = [];
  const authorizations: RecordedAuthorization[] = [];
  let state: ProposalState = options.proposal?.state ?? 'awaiting_approval';

  const snapshot = (): ActionProposalSnapshot => ({
    proposal: { ...proposal(options.proposal), state },
    auto_execute_threshold: options.threshold ?? 0,
    approval_window_hours: 24,
  });

  const store: ActionProposalStore = {
    async loadForUserDecision(proposalId) {
      calls.push(`load:${proposalId}`);
      return proposalId === PROPOSAL ? snapshot() : null;
    },
    async recordUserDecision(record) {
      calls.push(`authorization:${record.decision}:${record.user_id}:${record.decided_at}`);
      const id = `auth-${authorizations.length + 1}`;
      authorizations.push({
        id,
        proposal_id: record.proposal_id,
        actor_kind: 'user',
        actor_user_id: record.user_id,
        decision: record.decision,
        decided_at: record.decided_at,
      });
      return id;
    },
    async transitionState(proposalId, to, from) {
      if (!from.includes(state)) {
        throw new Error(`state guard: ${state} is not in ${from.join(', ')}`);
      }
      calls.push(`state:${proposalId}:${state}->${to}`);
      state = to;
    },
  };

  const policy: PolicyDecisionStore = {
    async recordPolicyEngineAuthorization(proposalId, decidedAt) {
      calls.push(`policy-authorization:${proposalId}:${decidedAt}`);
      const id = `auth-${authorizations.length + 1}`;
      authorizations.push({
        id,
        proposal_id: proposalId,
        actor_kind: 'policy_engine',
        actor_user_id: null,
        decision: 'approved',
        decided_at: decidedAt,
      });
      return id;
    },
    async persistDecision(proposalId, decision) {
      calls.push(`persist:${proposalId}:${decision.decision}`);
    },
  };

  const sources: PolicyFactSources = {
    async evidenceGrounding() {
      const cited = options.cited === undefined ? [SETTLEMENT] : options.cited;
      return cited === null ? null : { evidence_chain_id: CHAIN, cited_source_records: cited };
    },
    async priorProposals() {
      return [];
    },
    async recordedAuthorizations(proposalId) {
      return authorizations.filter((a) => a.proposal_id === proposalId);
    },
  };

  const executor: AuthorizedExecutor = {
    async executeAuthorized(proposalId, authorizationId) {
      calls.push(`execute:${proposalId}:${authorizationId}`);
      return {
        kind: 'executed',
        proposal_id: proposalId,
        authorization_id: authorizationId,
        executed_at: NOW,
      };
    },
  };

  return {
    deps: { store, policy, sources, executor },
    calls,
    authorizations,
    state: () => state,
  };
}

const APPROVER: readonly Permission[] = [APPROVAL_PERMISSION];

const request = (overrides: Partial<Parameters<typeof approveProposal>[0]> = {}) => ({
  proposal_id: PROPOSAL,
  user_id: USER,
  granted_permissions: APPROVER,
  decided_at: NOW,
  ...overrides,
});

describe('approveProposal', () => {
  it('records the Authorization, resubmits, then executes on it (Requirement 5.9, 5.14)', async () => {
    const w = world({ threshold: 0 });

    const outcome = await approveProposal(request(), w.deps);

    // The resubmitted decision is `require_approval` — the score still exceeds the
    // threshold, nothing about the Proposal changed — and 5.9 executes on any decision
    // other than block.
    expect(outcome).toEqual({
      kind: 'executed',
      proposal_id: PROPOSAL,
      authorization_id: 'auth-1',
      executed_at: NOW,
    });
    expect(w.calls).toEqual([
      `load:${PROPOSAL}`,
      `authorization:approved:${USER}:${NOW}`,
      `persist:${PROPOSAL}:require_approval`,
      `state:${PROPOSAL}:awaiting_approval->authorized`,
      `execute:${PROPOSAL}:auth-1`,
    ]);
    expect(w.state()).toBe('authorized');
    expect(w.authorizations).toEqual([
      {
        id: 'auth-1',
        proposal_id: PROPOSAL,
        actor_kind: 'user',
        actor_user_id: USER,
        decision: 'approved',
        decided_at: NOW,
      },
    ]);
  });

  it('executes on a resubmission that comes back auto_execute, second Authorization and all', async () => {
    // FINDING 5: `authorizeProposal` records a Policy_Engine Authorization on the
    // auto_execute path, so this Proposal carries 2 rows. The User's is the one
    // execution rests on, because that is the decision Requirement 5.9 names.
    const w = world({ threshold: 100 });

    const outcome = await approveProposal(request(), w.deps);

    expect(outcome.kind).toBe('executed');
    expect(w.calls).toEqual([
      `load:${PROPOSAL}`,
      `authorization:approved:${USER}:${NOW}`,
      `policy-authorization:${PROPOSAL}:${NOW}`,
      `persist:${PROPOSAL}:auto_execute`,
      `state:${PROPOSAL}:awaiting_approval->authorized`,
      `execute:${PROPOSAL}:auth-1`,
    ]);
    expect(w.authorizations.map((a) => a.actor_kind)).toEqual(['user', 'policy_engine']);
  });

  it('withholds execution when the resubmission blocks, and keeps the approval on record', async () => {
    // The Evidence_Chain stopped resolving in the interval, which is exactly the kind of
    // change Requirement 5.9's resubmission exists to catch.
    const w = world({ threshold: 100, cited: null });

    const outcome = await approveProposal(request(), w.deps);

    expect(outcome.kind).toBe('withheld');
    if (outcome.kind !== 'withheld') {
      throw new Error('unreachable');
    }
    expect(outcome.reason).toBe('resubmission_blocked');
    expect(outcome.authorization_id).toBe('auth-1');
    expect(outcome.decision?.decision).toBe('block');
    expect(outcome.decision?.failed_check_ids).toEqual(['transaction_evidence']);
    expect(w.state()).toBe('blocked');
    expect(w.calls).not.toContain(`execute:${PROPOSAL}:auth-1`);
  });

  it('blocks the approval of a User who does not hold approve_sensitive_actions', async () => {
    const w = world({ threshold: 100 });

    const outcome = await approveProposal(
      request({ granted_permissions: ['run_agents'] }),
      w.deps,
    );

    expect(outcome.kind).toBe('withheld');
    if (outcome.kind !== 'withheld') {
      throw new Error('unreachable');
    }
    expect(outcome.reason).toBe('resubmission_blocked');
    expect(outcome.decision?.failed_check_ids).toEqual(['user_permission']);
    expect(outcome.decision?.checks[0]?.detail).toContain(APPROVAL_PERMISSION);
    expect(w.state()).toBe('blocked');
    expect(w.calls.some((c) => c.startsWith('execute:'))).toBe(false);
  });

  it('withholds with no write at all from every state but awaiting_approval', async () => {
    const held: readonly ProposalState[] = [
      'proposed',
      'blocked',
      'authorized',
      'executed',
      'verified',
      'verification_failed',
      'execution_failed',
      'rejected',
      'expired',
    ];

    for (const state of held) {
      const w = world({ proposal: { state }, threshold: 100 });
      const outcome = await approveProposal(request(), w.deps);

      expect(outcome.kind, state).toBe('withheld');
      if (outcome.kind !== 'withheld') {
        throw new Error('unreachable');
      }
      expect(outcome.reason, state).toBe('not_awaiting_approval');
      expect(outcome.detail, state).toContain(state);
      // Requirement 5.8: no change to Tenant state. The load is the only call.
      expect(w.calls, state).toEqual([`load:${PROPOSAL}`]);
      expect(w.state(), state).toBe(state);
      expect(w.authorizations, state).toEqual([]);
    }
  });

  it('withholds an approval that arrives after the Approval_Window, writing nothing', async () => {
    const w = world({ threshold: 100 });

    const outcome = await approveProposal(request({ decided_at: AFTER_DEADLINE }), w.deps);

    expect(outcome.kind).toBe('withheld');
    if (outcome.kind !== 'withheld') {
      throw new Error('unreachable');
    }
    expect(outcome.reason).toBe('approval_window_elapsed');
    // The Proposal stays awaiting_approval so the expiry sweep of task 23.5 can mark it
    // expired and audit the elapsed wait (Requirement 5.16).
    expect(w.state()).toBe('awaiting_approval');
    expect(w.calls).toEqual([`load:${PROPOSAL}`]);
  });

  it('withholds when an awaiting_approval Proposal carries no approval_deadline', async () => {
    const w = world({ proposal: { approval_deadline: null }, threshold: 100 });

    const outcome = await approveProposal(request(), w.deps);

    expect(outcome.kind).toBe('withheld');
    if (outcome.kind !== 'withheld') {
      throw new Error('unreachable');
    }
    expect(outcome.reason).toBe('approval_deadline_absent');
    expect(w.calls).toEqual([`load:${PROPOSAL}`]);
  });

  it('withholds for a Proposal that does not resolve for this Tenant', async () => {
    const w = world();
    const foreign = '55555555-5555-4555-8555-555555555555';

    const outcome = await approveProposal(request({ proposal_id: foreign }), w.deps);

    expect(outcome.kind).toBe('withheld');
    if (outcome.kind !== 'withheld') {
      throw new Error('unreachable');
    }
    expect(outcome.reason).toBe('proposal_absent');
    expect(w.calls).toEqual([`load:${foreign}`]);
  });

  it('raises on a caller fault rather than reporting it as a withholding', async () => {
    const w = world();
    await expect(approveProposal(request({ proposal_id: '  ' }), w.deps)).rejects.toThrow(
      ActionServiceError,
    );
    await expect(approveProposal(request({ user_id: '' }), w.deps)).rejects.toThrow(
      ActionServiceError,
    );
    await expect(
      approveProposal(request({ decided_at: 'yesterday' }), w.deps),
    ).rejects.toThrow(ActionServiceError);
    expect(w.calls).toEqual([]);
  });
});

describe('rejectProposal', () => {
  it('records the rejection then discards the Proposal, and nothing else (Requirement 5.10)', async () => {
    const w = world();

    const outcome = await rejectProposal(request(), w.deps);

    expect(outcome).toEqual({
      kind: 'discarded',
      proposal_id: PROPOSAL,
      authorization_id: 'auth-1',
      decided_at: NOW,
    });
    expect(w.calls).toEqual([
      `load:${PROPOSAL}`,
      `authorization:rejected:${USER}:${NOW}`,
      `state:${PROPOSAL}:awaiting_approval->rejected`,
    ]);
    expect(w.state()).toBe('rejected');
    expect(w.authorizations[0]?.decision).toBe('rejected');
    expect(w.authorizations[0]?.actor_user_id).toBe(USER);
    // No resubmission, no execution: a rejection consults no Policy_Engine.
    expect(w.calls.some((c) => c.startsWith('persist:') || c.startsWith('execute:'))).toBe(
      false,
    );
  });

  it('needs no executor at all, so no rejection can reach one', async () => {
    // `rejectProposal` takes `Pick<ActionServiceDeps, 'store'>`. Passing a deps object
    // with only a store type-checks, which is the structural half of "discards without
    // execution".
    const w = world();
    const outcome = await rejectProposal(request(), { store: w.deps.store });
    expect(outcome.kind).toBe('discarded');
  });

  it('refuses from any state but awaiting_approval, and after the window, writing nothing', async () => {
    for (const state of ['rejected', 'executed', 'expired'] as const) {
      const w = world({ proposal: { state } });
      const outcome = await rejectProposal(request(), { store: w.deps.store });
      expect(outcome.kind, state).toBe('refused');
      expect(w.calls, state).toEqual([`load:${PROPOSAL}`]);
    }

    const late = world();
    const outcome = await rejectProposal(request({ decided_at: AFTER_DEADLINE }), {
      store: late.deps.store,
    });
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') {
      throw new Error('unreachable');
    }
    expect(outcome.reason).toBe('approval_window_elapsed');
    expect(late.state()).toBe('awaiting_approval');
  });
});

describe('refusalFor', () => {
  it('admits only awaiting_approval inside the window', () => {
    const snapshot: ActionProposalSnapshot = {
      proposal: proposal(),
      auto_execute_threshold: 0,
    };
    expect(refusalFor(snapshot, NOW)).toBeNull();
    // The boundary: a decision exactly at the deadline is inside the window.
    expect(refusalFor(snapshot, DEADLINE)).toBeNull();
    expect(refusalFor(snapshot, AFTER_DEADLINE)?.reason).toBe('approval_window_elapsed');
    expect(USER_DECIDABLE_STATES).toEqual(['awaiting_approval']);
  });

  it('raises on a stored state that is not a proposal_state label', () => {
    const snapshot: ActionProposalSnapshot = {
      proposal: proposal({ state: 'APPROVED' as unknown as ProposalState }),
      auto_execute_threshold: 0,
    };
    expect(() => refusalFor(snapshot, NOW)).toThrow(ActionServiceError);
  });

  it('names every reason it can return, and returns none of the EXECUTE stage reasons', () => {
    // The vocabulary is one union across both paths, so task 23.2's three execution
    // reasons are in `WITHHELD_REASONS` — and `refusalFor` still cannot produce one,
    // which is what keeps the approval path's five reasons about a User decision.
    expect([...WITHHELD_REASONS]).toEqual([
      'proposal_absent',
      'not_awaiting_approval',
      'approval_deadline_absent',
      'approval_window_elapsed',
      'resubmission_blocked',
      'authorization_unresolvable',
      'not_authorized_for_execution',
      'execution_tool_absent',
    ]);
  });
});

describe('what reaches the database', () => {
  it('writes a User Authorization that cannot be a Policy_Engine row', () => {
    expect(USER_AUTHORIZATION_SQL).toContain(
      "VALUES ($1, $2::uuid, 'user', $3::uuid, $4, $5::timestamptz)",
    );
    expect(USER_AUTHORIZATION_SQL).toContain('RETURNING id, decided_at');
    expect(
      userAuthorizationParams(TENANT, {
        proposal_id: PROPOSAL,
        user_id: USER,
        decision: 'rejected',
        decided_at: NOW,
      }),
    ).toEqual([TENANT, PROPOSAL, USER, 'rejected', NOW]);
  });

  it('guards the state transition on the state it is leaving', () => {
    expect(PROPOSAL_STATE_TRANSITION_SQL).toContain('SET state = $3::proposal_state');
    expect(PROPOSAL_STATE_TRANSITION_SQL).toContain('AND state = ANY($4::proposal_state[])');
    expect(PROPOSAL_STATE_TRANSITION_SQL).toContain('RETURNING id, state');
    // The EXECUTE and VERIFY columns belong to tasks 23.2 and 23.3.
    expect(PROPOSAL_STATE_TRANSITION_SQL).not.toContain('executed_at');
    expect(PROPOSAL_STATE_TRANSITION_SQL).not.toContain('verified_at');
    expect(
      proposalStateTransitionParams(TENANT, PROPOSAL, 'rejected', USER_DECIDABLE_STATES),
    ).toEqual([TENANT, PROPOSAL, 'rejected', ['awaiting_approval']]);
  });

  it('reads impact_paise as text, never as a JSON number', () => {
    expect(ACTION_PROPOSAL_LOAD_SQL).toContain('impact_paise::text AS impact_paise');
    expect(ACTION_PROPOSAL_LOAD_SQL).toContain('expected_outcome');
    expect(ACTION_PROPOSAL_LOAD_SQL).toContain('WHERE tenant_id = $1');
    expect(actionProposalLoadParams(TENANT, PROPOSAL)).toEqual([TENANT, PROPOSAL]);
  });
});

describe('createApprovalActions', () => {
  it('binds the session so approve and reject take design.md two arguments', async () => {
    // No `decided_at` reaches these two, by design: design.md's signature is
    // (proposalId, userId), so the decision timestamp is the real clock.
    const w = world({ threshold: 0, proposal: { approval_deadline: OPEN_WINDOW } });
    const actions = createApprovalActions({ ...w.deps, granted_permissions: APPROVER });

    const outcome = await actions.approve(PROPOSAL, USER);

    expect(outcome.kind).toBe('executed');
    expect(w.calls.at(-1)).toBe(`execute:${PROPOSAL}:auth-1`);
  });

  it('rejects through the same bound session', async () => {
    const w = world({ proposal: { approval_deadline: OPEN_WINDOW } });
    const actions = createApprovalActions({ ...w.deps, granted_permissions: APPROVER });

    const outcome = await actions.reject(PROPOSAL, USER);

    expect(outcome.kind).toBe('discarded');
    expect(w.state()).toBe('rejected');
  });
});
