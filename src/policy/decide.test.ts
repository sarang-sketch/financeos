/**
 * The one decision, the Authorization and the persisted gate picture (task 22.2).
 * Requirements 5.4, 5.5, 5.6, 5.7, 5.14, 5.15.
 *
 * Task 22.3 owns the full mapping table at thresholds 0 and 100. What is pinned here
 * is what a table would not catch:
 *
 * 1. **An incomplete gate raises, and never blocks.** `block` is a verdict about a
 *    Proposal; five results is a caller fault, and filing it as a Tenant-visible
 *    policy outcome would be a lie a User cannot tell from a real failure.
 * 2. **`null <= 0` is true in JavaScript**, so an unscored Proposal must never reach
 *    the comparison. Both guards are asserted: the block branch comes first, and the
 *    operand assertion raises rather than comparing.
 * 3. **The Authorization is written before the decision is persisted** (Requirement
 *    5.14). The fake store records call order, so reversing the two fails here.
 * 4. **The `<=` boundary of Requirement 5.6.** A score exactly equal to the
 *    Auto_Execute_Threshold auto-executes; one above it requires approval.
 * 5. **The two SQL statements** are asserted textually — the columns written, the
 *    literal `policy_engine` actor, the NULL `actor_user_id`, and the state guard that
 *    stops a late evaluation overwriting an executed Proposal's gate picture.
 */

import { describe, expect, it } from 'vitest';

import { PaiseTypeError } from '@/calc/paise';
import type { Actor } from '@/config/configuration-service';
import type { LedgerEntrySetDraft, SourceRef } from '@/ledger/posting-rules';

import {
  POLICY_CHECK_IDS,
  type PolicyCheckId,
  type PolicyCheckResult,
  type PolicyFactSources,
  type PolicySubmission,
  type ProposalUnderReview,
} from './checks';
import {
  authorizeProposal,
  DECIDABLE_STATES,
  decidePolicy,
  POLICY_ENGINE_AUTHORIZATION_SQL,
  policyChecksJson,
  policyEngineAuthorizationParams,
  type PolicyDecision,
  PolicyDecisionError,
  type PolicyDecisionStore,
  PROPOSAL_DECISION_UPDATE_SQL,
  proposalDecisionUpdateParams,
  proposalStateForDecision,
  recordPolicyDecision,
} from './decide';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PROPOSAL = '22222222-2222-4222-8222-222222222222';
const CHAIN = '33333333-3333-4333-8333-333333333333';
const AUTHORIZATION = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-03-01T00:00:00.000Z';

const SETTLEMENT: SourceRef = { type: 'settlement', id: 'setl_SYNTHETIC9282' };
const TARGETS: readonly SourceRef[] = [SETTLEMENT];

/** ₹3,82,000 through `post_reconciliation_adjustment`: 40 + 15 = 55, no absent evidence. */
const SCORE = 55;

const BALANCED: LedgerEntrySetDraft = {
  source_refs: [SETTLEMENT],
  entry_date: '2026-02-28',
  entries: [
    { account_code: 'bank', side: 'debit', amount_paise: 38_200_000n },
    { account_code: 'settlement_pending', side: 'credit', amount_paise: 38_200_000n },
  ],
};

const AGENT: Actor = { kind: 'agent', id: 'reconciliation_agent' };

function proposal(overrides: Partial<ProposalUnderReview> = {}): ProposalUnderReview {
  return {
    id: PROPOSAL,
    action_type: 'post_reconciliation_adjustment',
    target_source_records: TARGETS,
    impact_paise: 38_200_000n,
    evidence_chain_id: CHAIN,
    state: 'proposed',
    ledger_effect: BALANCED,
    ...overrides,
  };
}

function checks(overrides: Partial<Record<PolicyCheckId, 'pass' | 'fail'>> = {}): PolicyCheckResult[] {
  return POLICY_CHECK_IDS.map((id) => {
    const result = overrides[id] ?? 'pass';
    return result === 'pass' ? { id, result } : { id, result, detail: `${id} failed` };
  });
}

/** A store that records what it was asked to do, in order. */
function fakeStore(): PolicyDecisionStore & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async recordPolicyEngineAuthorization(proposalId, decidedAt) {
      calls.push(`authorization:${proposalId}:${decidedAt}`);
      return AUTHORIZATION;
    },
    async persistDecision(proposalId, decision) {
      calls.push(`persist:${proposalId}:${decision.decision}:${decision.authorization_id ?? '-'}`);
    },
  };
}

/** Facts in which nothing is wrong: the chain cites every target, no priors, no approvals. */
function sources(): PolicyFactSources {
  return {
    async evidenceGrounding() {
      return { evidence_chain_id: CHAIN, cited_source_records: [...TARGETS] };
    },
    async priorProposals() {
      return [];
    },
    async recordedAuthorizations() {
      return [];
    },
  };
}

function submission(threshold: number | null): Omit<PolicySubmission, 'risk_score'> {
  return {
    proposal: proposal(),
    actor: AGENT,
    granted_permissions: ['run_agents'],
    auto_execute_threshold: threshold,
    submitted_at: NOW,
  };
}

describe('decidePolicy', () => {
  it('raises on an incomplete check set rather than returning block', () => {
    expect(() =>
      decidePolicy({ checks: checks().slice(0, 5), risk_score: 0, auto_execute_threshold: 0 }),
    ).toThrow(PolicyDecisionError);

    // Six results that repeat an id are six results and not a complete gate.
    const repeated = checks();
    repeated[5] = { id: 'user_permission', result: 'pass' };
    expect(() =>
      decidePolicy({ checks: repeated, risk_score: 0, auto_execute_threshold: 0 }),
    ).toThrow(PolicyDecisionError);
  });

  it('blocks on any failure, records every failed id, and needs no score to do it', () => {
    const decision = decidePolicy({
      checks: checks({ accounting_rule: 'fail', duplicate_action: 'fail' }),
      risk_score: null,
      auto_execute_threshold: null,
    });

    expect(decision.decision).toBe('block');
    expect(decision.failed_check_ids).toEqual(['accounting_rule', 'duplicate_action']);
    expect(decision.risk_score).toBeNull();
    expect(decision.checks).toHaveLength(6);
  });

  it('auto-executes at or below the threshold and requires approval above it', () => {
    const at = decidePolicy({ checks: checks(), risk_score: 55, auto_execute_threshold: 55 });
    const below = decidePolicy({ checks: checks(), risk_score: 54, auto_execute_threshold: 55 });
    const above = decidePolicy({ checks: checks(), risk_score: 56, auto_execute_threshold: 55 });

    expect([at.decision, below.decision, above.decision]).toEqual([
      'auto_execute',
      'auto_execute',
      'require_approval',
    ]);
    expect(at.failed_check_ids).toEqual([]);
    expect(at.authorization_id).toBeUndefined();
  });

  it('refuses to compare a pass-all gate against a score it does not have', () => {
    // `null <= 0` is true in JavaScript. This is the guard that stops an unscored
    // Proposal auto-executing at the default Auto_Execute_Threshold of 0.
    expect(() =>
      decidePolicy({ checks: checks(), risk_score: null, auto_execute_threshold: 0 }),
    ).toThrow(PolicyDecisionError);
    expect(() =>
      decidePolicy({ checks: checks(), risk_score: 0, auto_execute_threshold: null }),
    ).toThrow(PolicyDecisionError);
    expect(() =>
      decidePolicy({ checks: checks(), risk_score: 101, auto_execute_threshold: 0 }),
    ).toThrow(PolicyDecisionError);
  });

  it('carries the duplicate Proposal identifier through to the decision', () => {
    const decision = decidePolicy({
      checks: checks({ duplicate_action: 'fail' }),
      risk_score: 55,
      auto_execute_threshold: 100,
      duplicate_proposal_id: 'aaaaaaaa-0000-4000-8000-000000000001',
    });
    expect(decision.decision).toBe('block');
    expect(decision.duplicate_proposal_id).toBe('aaaaaaaa-0000-4000-8000-000000000001');
  });

  it('maps each decision onto the proposal_state the Action_Service applies', () => {
    expect(proposalStateForDecision('block')).toBe('blocked');
    expect(proposalStateForDecision('require_approval')).toBe('awaiting_approval');
    expect(proposalStateForDecision('auto_execute')).toBe('authorized');
  });
});

describe('recordPolicyDecision', () => {
  it('writes the Authorization before persisting the decision (Requirement 5.14)', async () => {
    const store = fakeStore();
    const decided = decidePolicy({
      checks: checks(),
      risk_score: SCORE,
      auto_execute_threshold: 100,
    });

    const recorded = await recordPolicyDecision(PROPOSAL, decided, store, { decidedAt: NOW });

    expect(recorded.authorization_id).toBe(AUTHORIZATION);
    expect(store.calls).toEqual([
      `authorization:${PROPOSAL}:${NOW}`,
      `persist:${PROPOSAL}:auto_execute:${AUTHORIZATION}`,
    ]);
  });

  it('writes no Authorization on block or require_approval', async () => {
    for (const threshold of [0, 100]) {
      const store = fakeStore();
      const decided = decidePolicy({
        checks: threshold === 0 ? checks() : checks({ user_permission: 'fail' }),
        risk_score: SCORE,
        auto_execute_threshold: threshold,
      });

      const recorded = await recordPolicyDecision(PROPOSAL, decided, store, { decidedAt: NOW });

      expect(recorded.authorization_id).toBeUndefined();
      expect(store.calls).toEqual([`persist:${PROPOSAL}:${recorded.decision}:-`]);
    }
  });

  it('refuses a Proposal that has not been persisted', async () => {
    const decided = decidePolicy({ checks: checks(), risk_score: 0, auto_execute_threshold: 0 });
    await expect(recordPolicyDecision(undefined, decided, fakeStore())).rejects.toThrow(
      PolicyDecisionError,
    );
  });
});

describe('what reaches the database', () => {
  it('persists design.md `{ id, result, detail? }`, not the fixture `{ name, passed }`', () => {
    const json: unknown = JSON.parse(
      policyChecksJson(checks({ risk_threshold: 'fail' })),
    );
    expect(json).toEqual([
      { id: 'user_permission', result: 'pass' },
      { id: 'accounting_rule', result: 'pass' },
      { id: 'transaction_evidence', result: 'pass' },
      { id: 'duplicate_action', result: 'pass' },
      { id: 'risk_threshold', result: 'fail', detail: 'risk_threshold failed' },
      { id: 'approval_requirement', result: 'pass' },
    ]);
  });

  it('writes the three columns task 22.2 names, guarded on a pre-execution state', () => {
    expect(PROPOSAL_DECISION_UPDATE_SQL).toContain('policy_checks  = $3::jsonb');
    expect(PROPOSAL_DECISION_UPDATE_SQL).toContain('risk_score     = $4');
    expect(PROPOSAL_DECISION_UPDATE_SQL).toContain('threshold_used = $5');
    expect(PROPOSAL_DECISION_UPDATE_SQL).toContain('AND state = ANY($6::proposal_state[])');
    expect(PROPOSAL_DECISION_UPDATE_SQL).toContain('RETURNING id, state');
    // The state machine is the Action_Service's; a blind write here would overwrite the
    // gate picture of an evaluation that already authorized an execution.
    expect(PROPOSAL_DECISION_UPDATE_SQL).not.toContain('SET state');
    expect(DECIDABLE_STATES).not.toContain('executed');
    expect(DECIDABLE_STATES).not.toContain('expired');
  });

  it('names the Policy_Engine as the actor with no User attached', () => {
    expect(POLICY_ENGINE_AUTHORIZATION_SQL).toContain(
      "VALUES ($1, $2::uuid, 'policy_engine', NULL, 'approved', $3::timestamptz)",
    );
    expect(policyEngineAuthorizationParams(TENANT, PROPOSAL, NOW)).toEqual([
      TENANT,
      PROPOSAL,
      NOW,
    ]);
  });

  it('binds the update parameters in statement order, with a null score for a block', () => {
    const blocked: PolicyDecision = decidePolicy({
      checks: checks({ risk_threshold: 'fail' }),
      risk_score: null,
      auto_execute_threshold: null,
    });
    const params = proposalDecisionUpdateParams(TENANT, PROPOSAL, blocked);

    expect(params[0]).toBe(TENANT);
    expect(params[1]).toBe(PROPOSAL);
    expect(params[2]).toBe(policyChecksJson(blocked.checks));
    expect(params[3]).toBeNull();
    expect(params[4]).toBeNull();
    expect(params[5]).toEqual(DECIDABLE_STATES);
  });
});

describe('authorizeProposal', () => {
  it('scores the Proposal, passes all six, and auto-executes below the threshold', async () => {
    const store = fakeStore();
    const decision = await authorizeProposal(submission(100), sources(), store, {
      decidedAt: NOW,
    });

    expect(decision.decision).toBe('auto_execute');
    expect(decision.risk_score).toBe(SCORE);
    expect(decision.auto_execute_threshold).toBe(100);
    expect(decision.failed_check_ids).toEqual([]);
    expect(decision.authorization_id).toBe(AUTHORIZATION);
    expect(store.calls[0]).toBe(`authorization:${PROPOSAL}:${NOW}`);
  });

  it('requires approval at the default threshold of 0', async () => {
    const store = fakeStore();
    const decision = await authorizeProposal(submission(0), sources(), store, { decidedAt: NOW });

    expect(decision.decision).toBe('require_approval');
    expect(decision.risk_score).toBe(SCORE);
    expect(store.calls).toEqual([`persist:${PROPOSAL}:require_approval:-`]);
  });

  it('blocks and reports a null score for an action type that carries no points', async () => {
    const store = fakeStore();
    const decision = await authorizeProposal(
      { ...submission(100), proposal: proposal({ action_type: 'post_reversal' }) },
      sources(),
      store,
      { decidedAt: NOW },
    );

    expect(decision.decision).toBe('block');
    expect(decision.risk_score).toBeNull();
    expect(decision.failed_check_ids).toEqual(['risk_threshold']);
    expect(store.calls).toEqual([`persist:${PROPOSAL}:block:-`]);
  });

  it('does not turn a paise discipline violation into a blocked Proposal', async () => {
    // An unlisted action type is a Proposal fault and becomes `block`. A `number` impact
    // is a violation of Requirement 15.1 and must stay loud.
    await expect(
      authorizeProposal(
        {
          ...submission(100),
          proposal: proposal({ impact_paise: 38_200_000 as unknown as bigint }),
        },
        sources(),
        fakeStore(),
        { decidedAt: NOW },
      ),
    ).rejects.toThrow(PaiseTypeError);
  });

  it('counts absent Evidence_Chain Source_Records into the score it reports', async () => {
    const store = fakeStore();
    const ungrounded: PolicyFactSources = {
      ...sources(),
      async evidenceGrounding() {
        return { evidence_chain_id: CHAIN, cited_source_records: [] };
      },
    };

    const decision = await authorizeProposal(submission(100), ungrounded, store, {
      decidedAt: NOW,
    });

    // The evidence term never changes a decision — an absent Source_Record already
    // fails the transaction evidence check — but Requirement 5.4 still returns the score.
    expect(decision.decision).toBe('block');
    expect(decision.failed_check_ids).toEqual(['transaction_evidence']);
    expect(decision.risk_score).toBe(SCORE + 5);
  });
});
