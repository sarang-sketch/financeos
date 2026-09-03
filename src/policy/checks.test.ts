/**
 * The six independent Policy_Checks (task 22.1). Requirements 5.3, 5.4, 5.13.
 *
 * Three things are pinned rather than merely exercised:
 *
 * 1. **All six always report.** Requirement 5.3 says each check is evaluated
 *    independently of every other, so the tests below take a submission that fails
 *    *every* check at once and assert six results in {@link POLICY_CHECK_IDS} order —
 *    not "the first failure". A short-circuit anywhere fails here.
 * 2. **A thrown check does not silence the other five.** The runner isolates each
 *    check, and the only way to prove it is to feed one check input it cannot
 *    evaluate (a target identifier carrying a fingerprint separator) and assert the
 *    other five still carry their own verdicts.
 * 3. **Requirement 5.13's window boundaries.** Exactly 30 days back is inside, one
 *    millisecond earlier is outside, and the recorded identifier is the most recent
 *    match — so a `>` written for a `>=` fails here rather than in production 30 days
 *    after a duplicate.
 *
 * `evaluatePolicyChecks` is pure — no clock, no database — so most of this file needs
 * no fakes. `runPolicyChecks` gets a hand-written source stub rather than a mock: the
 * budget and the per-fact isolation are behavioural, and a mock that resolves
 * immediately would prove neither.
 *
 * The risk score, the decision mapping and the `proposals` persistence are task
 * 22.2's and are asserted by task 22.3, not here. This file asserts only that the
 * risk threshold check accepts the two operands and refuses a pair it cannot compare.
 */

import { describe, expect, it } from 'vitest';

import type { Actor } from '@/config/configuration-service';
import type { LedgerEntrySetDraft, SourceRef } from '@/ledger/posting-rules';

import {
  absentEvidenceRefs,
  accountingRuleCheck,
  anyCheckFailed,
  approvalRequirementCheck,
  DUPLICATE_ACTION_LOOKBACK_SQL,
  DUPLICATE_BLOCKING_STATES,
  DUPLICATE_LOOKBACK_MS,
  duplicateActionCheck,
  duplicateLookbackParams,
  duplicateLookbackWindow,
  evaluatePolicyChecks,
  failedCheckIds,
  findDuplicateProposal,
  isCompletePolicyCheckSet,
  POLICY_CHECK_COUNT,
  POLICY_CHECK_IDS,
  POLICY_EVALUATION_BUDGET_MS,
  PolicyCheckError,
  type PolicyCheckInput,
  type PolicyFactSources,
  type PolicyFacts,
  type PolicySubmission,
  type PriorProposal,
  PROPOSAL_STATES,
  type ProposalState,
  type ProposalUnderReview,
  proposalTargetFingerprint,
  type RecordedAuthorization,
  riskThresholdCheck,
  runPolicyChecks,
  transactionEvidenceCheck,
  userPermissionCheck,
} from './checks';

const CHAIN = '9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const PROPOSAL = '11111111-2222-4333-8444-555555555555';
const NOW = '2026-03-01T00:00:00.000Z';

const SETTLEMENT: SourceRef = { type: 'settlement', id: 'setl_SYNTHETIC9282' };
const REPORT: SourceRef = { type: 'settlement_recon_report', id: 'setlrcn_SYNTHETIC9282' };
const TARGETS: readonly SourceRef[] = [SETTLEMENT, REPORT];

const AGENT: Actor = { kind: 'agent', id: 'reconciliation_agent' };

/** A balanced 2-entry set: the minimum Requirement 2.1 admits. */
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
    action_type: 'post_reversal',
    target_source_records: TARGETS,
    impact_paise: 38_200_000n,
    evidence_chain_id: CHAIN,
    state: 'proposed',
    ledger_effect: BALANCED,
    ...overrides,
  };
}

function submission(overrides: Partial<PolicySubmission> = {}): PolicySubmission {
  return {
    proposal: proposal(),
    actor: AGENT,
    granted_permissions: ['run_agents'],
    risk_score: 61,
    auto_execute_threshold: 40,
    submitted_at: NOW,
    ...overrides,
  };
}

/** Facts in which everything is available and nothing is wrong. */
function facts(overrides: Partial<PolicyFacts> = {}): PolicyFacts {
  return {
    evidence: {
      available: true,
      value: { evidence_chain_id: CHAIN, cited_source_records: [...TARGETS] },
    },
    prior_proposals: { available: true, value: [] },
    authorizations: { available: true, value: [] },
    ...overrides,
  };
}

function input(
  submissionOverrides: Partial<PolicySubmission> = {},
  factOverrides: Partial<PolicyFacts> = {},
): PolicyCheckInput {
  return { submission: submission(submissionOverrides), facts: facts(factOverrides) };
}

function prior(overrides: Partial<PriorProposal> = {}): PriorProposal {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    action_type: 'post_reversal',
    target_fingerprint: proposalTargetFingerprint('post_reversal', TARGETS),
    state: 'executed',
    created_at: '2026-02-20T00:00:00.000Z',
    executed_at: '2026-02-20T01:00:00.000Z',
    ...overrides,
  };
}

function approval(overrides: Partial<RecordedAuthorization> = {}): RecordedAuthorization {
  return {
    id: 'bbbbbbbb-0000-4000-8000-000000000001',
    proposal_id: PROPOSAL,
    actor_kind: 'user',
    actor_user_id: '33333333-3333-4333-8333-333333333333',
    decision: 'approved',
    decided_at: '2026-02-28T00:00:00.000Z',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* The shape Requirement 5.4 owes the caller                                  */
/* -------------------------------------------------------------------------- */

describe('the six-check contract', () => {
  it('names the six checks of Requirement 5.3 in design.md order', () => {
    expect(POLICY_CHECK_IDS).toEqual([
      'user_permission',
      'accounting_rule',
      'transaction_evidence',
      'duplicate_action',
      'risk_threshold',
      'approval_requirement',
    ]);
    expect(POLICY_CHECK_COUNT).toBe(6);
  });

  it('returns exactly six results, in order, for a clean submission', () => {
    const outcome = evaluatePolicyChecks(input());
    expect(outcome.checks.map((c) => c.id)).toEqual([...POLICY_CHECK_IDS]);
    expect(outcome.checks.every((c) => c.result === 'pass')).toBe(true);
    expect(isCompletePolicyCheckSet(outcome.checks)).toBe(true);
    expect(anyCheckFailed(outcome.checks)).toBe(false);
    expect(outcome.duplicate_proposal_id).toBeUndefined();
    expect(outcome.absent_evidence_count).toBe(0);
  });

  it('evaluates all six even when every one of them fails', () => {
    const outcome = evaluatePolicyChecks(
      input(
        {
          proposal: proposal({
            state: 'rejected',
            ledger_effect: {
              ...BALANCED,
              entries: [{ account_code: 'bank', side: 'debit', amount_paise: 1n }],
            },
          }),
          granted_permissions: [],
          risk_score: null,
          auto_execute_threshold: 101,
        },
        {
          evidence: { available: true, value: null },
          prior_proposals: { available: true, value: [prior()] },
        },
      ),
    );

    expect(outcome.checks).toHaveLength(POLICY_CHECK_COUNT);
    expect(failedCheckIds(outcome.checks)).toEqual([...POLICY_CHECK_IDS]);
    // Every fail explains itself: a gate picture nobody can read is not a gate picture.
    expect(outcome.checks.every((c) => (c.detail ?? '').length > 0)).toBe(true);
    expect(outcome.duplicate_proposal_id).toBe(prior().id);
    expect(outcome.absent_evidence_count).toBe(TARGETS.length);
  });

  it('turns a check that throws into that check alone failing', () => {
    // `setl|9282` carries the fingerprint separator, so canonicalisation refuses it
    // and both the evidence and duplicate checks raise rather than return.
    const outcome = evaluatePolicyChecks(
      input({
        proposal: proposal({ target_source_records: [{ type: 'settlement', id: 'setl|9282' }] }),
      }),
    );

    expect(outcome.checks.map((c) => c.id)).toEqual([...POLICY_CHECK_IDS]);
    expect(failedCheckIds(outcome.checks)).toEqual(['transaction_evidence', 'duplicate_action']);
    expect(
      outcome.checks.filter((c) => c.result === 'pass').map((c) => c.id),
    ).toEqual(['user_permission', 'accounting_rule', 'risk_threshold', 'approval_requirement']);
    // Worst case, so `risk.ts` never reads a smaller absent count than the truth.
    expect(outcome.absent_evidence_count).toBe(1);
  });

  it('recognises an incomplete check set, which `decide` must refuse', () => {
    const outcome = evaluatePolicyChecks(input());
    expect(isCompletePolicyCheckSet(outcome.checks.slice(0, 5))).toBe(false);
    expect(isCompletePolicyCheckSet([...outcome.checks, outcome.checks[0]!])).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 1. user permission                                                         */
/* -------------------------------------------------------------------------- */

describe('the user permission Policy_Check', () => {
  it('passes an Agent submission holding run_agents by default', () => {
    expect(userPermissionCheck(input())).toEqual({ id: 'user_permission', result: 'pass' });
  });

  it('names every missing Permission', () => {
    const result = userPermissionCheck(
      input({
        granted_permissions: ['view_financial_data'],
        required_permissions: ['run_agents', 'approve_sensitive_actions'],
      }),
    );
    expect(result.result).toBe('fail');
    expect(result.detail).toContain('run_agents');
    expect(result.detail).toContain('approve_sensitive_actions');
  });

  it('passes the approval resubmission path on approve_sensitive_actions', () => {
    const result = userPermissionCheck(
      input({
        actor: { kind: 'user', id: '33333333-3333-4333-8333-333333333333' },
        granted_permissions: ['approve_sensitive_actions'],
        required_permissions: ['approve_sensitive_actions'],
      }),
    );
    expect(result.result).toBe('pass');
  });

  it('refuses the Policy_Engine as a submitter, and an unstated requirement', () => {
    expect(
      userPermissionCheck(input({ actor: { kind: 'policy_engine', id: 'policy_engine' } })).result,
    ).toBe('fail');
    expect(userPermissionCheck(input({ required_permissions: [] })).result).toBe('fail');
  });
});

/* -------------------------------------------------------------------------- */
/* 2. accounting rule                                                         */
/* -------------------------------------------------------------------------- */

describe('the accounting rule Policy_Check', () => {
  it('passes a balanced set and a stated absence of one', () => {
    expect(accountingRuleCheck(input()).result).toBe('pass');
    const none = accountingRuleCheck(
      input({
        proposal: proposal({
          ledger_effect: { kind: 'none', reason: 'this action only re-links a Credit_Note' },
        }),
      }),
    );
    expect(none.result).toBe('pass');
    expect(none.detail).toContain('re-links a Credit_Note');
  });

  it('fails an unbalanced set, reporting what the Semantic_Ledger would say', () => {
    const result = accountingRuleCheck(
      input({
        proposal: proposal({
          ledger_effect: {
            ...BALANCED,
            entries: [
              { account_code: 'bank', side: 'debit', amount_paise: 38_200_000n },
              { account_code: 'settlement_pending', side: 'credit', amount_paise: 38_199_999n },
            ],
          },
        }),
      }),
    );
    expect(result.result).toBe('fail');
    // Requirement 2.6 wants the imbalance amount and the Source_Records named.
    expect(result.detail).toContain('unbalanced by 1 paise');
    expect(result.detail).toContain(SETTLEMENT.id);
  });

  it('fails a structurally unwritable set, reporting the ledger rule that refused it', () => {
    const result = accountingRuleCheck(
      input({
        proposal: proposal({
          ledger_effect: {
            ...BALANCED,
            entries: [{ account_code: 'bank', side: 'debit', amount_paise: 1n }],
          },
        }),
      }),
    );
    expect(result.result).toBe('fail');
    expect(result.detail).toContain('not writable');
    expect(result.detail).toContain('2..20 entries');
  });

  it('fails a correction that is not a reversing set (Requirement 2.4, 2.7)', () => {
    const notReversing = accountingRuleCheck(
      input({ proposal: proposal({ corrects_ledger_set_id: 'set-1' }) }),
    );
    expect(notReversing.result).toBe('fail');

    const reversing = accountingRuleCheck(
      input({
        proposal: proposal({
          corrects_ledger_set_id: 'set-1',
          ledger_effect: { ...BALANCED, reverses_set_id: 'set-1' },
        }),
      }),
    );
    expect(reversing.result).toBe('pass');
  });

  it('fails a correction that states no effect, and an unexplained absence', () => {
    expect(
      accountingRuleCheck(
        input({
          proposal: proposal({
            corrects_ledger_set_id: 'set-1',
            ledger_effect: { kind: 'none', reason: 'nothing to post' },
          }),
        }),
      ).result,
    ).toBe('fail');
    expect(
      accountingRuleCheck(
        input({ proposal: proposal({ ledger_effect: { kind: 'none', reason: '  ' } }) }),
      ).result,
    ).toBe('fail');
  });
});

/* -------------------------------------------------------------------------- */
/* 3. transaction evidence                                                    */
/* -------------------------------------------------------------------------- */

describe('the transaction evidence Policy_Check', () => {
  it('fails an unresolvable chain and counts every target as absent', () => {
    const result = transactionEvidenceCheck(input({}, { evidence: { available: true, value: null } }));
    expect(result.result).toBe('fail');
    expect(absentEvidenceRefs(TARGETS, null)).toHaveLength(2);
  });

  it('fails when a target Source_Record is not cited, naming it', () => {
    const result = transactionEvidenceCheck(
      input(
        {},
        {
          evidence: {
            available: true,
            value: { evidence_chain_id: CHAIN, cited_source_records: [SETTLEMENT] },
          },
        },
      ),
    );
    expect(result.result).toBe('fail');
    expect(result.detail).toContain(REPORT.id);
  });

  it('fails a chain read that came back for a different chain', () => {
    const result = transactionEvidenceCheck(
      input(
        {},
        {
          evidence: {
            available: true,
            value: { evidence_chain_id: 'other-chain', cited_source_records: [...TARGETS] },
          },
        },
      ),
    );
    expect(result.result).toBe('fail');
  });

  it('fails, with the reason, when the chain could not be read at all', () => {
    const result = transactionEvidenceCheck(
      input({}, { evidence: { available: false, reason: 'connection reset' } }),
    );
    expect(result.result).toBe('fail');
    expect(result.detail).toContain('connection reset');
  });

  it('ignores extra citations: a chain may cite more than the targets', () => {
    const result = transactionEvidenceCheck(
      input(
        {},
        {
          evidence: {
            available: true,
            value: {
              evidence_chain_id: CHAIN,
              cited_source_records: [...TARGETS, { type: 'payment', id: 'pay_1' }],
            },
          },
        },
      ),
    );
    expect(result.result).toBe('pass');
  });
});

/* -------------------------------------------------------------------------- */
/* 4. duplicate action (Requirement 5.13)                                     */
/* -------------------------------------------------------------------------- */

describe('the duplicate action Policy_Check', () => {
  it('fingerprints action type plus the canonical target set', () => {
    const forward = proposalTargetFingerprint('post_reversal', [SETTLEMENT, REPORT]);
    expect(forward).toBe(
      `post_reversal|settlement:${SETTLEMENT.id},settlement_recon_report:${REPORT.id}`,
    );
    // A set, not a list: order and repeats do not change the identity.
    expect(proposalTargetFingerprint('post_reversal', [REPORT, SETTLEMENT, SETTLEMENT])).toBe(
      forward,
    );
    // A different action over the same records is a different action.
    expect(proposalTargetFingerprint('post_accrual', [SETTLEMENT, REPORT])).not.toBe(forward);
  });

  it('refuses an ambiguous action type and an empty target set', () => {
    expect(() => proposalTargetFingerprint('post|reversal', TARGETS)).toThrow(PolicyCheckError);
    expect(() => proposalTargetFingerprint('', TARGETS)).toThrow(PolicyCheckError);
    expect(() => proposalTargetFingerprint('post_reversal', [])).toThrow(PolicyCheckError);
  });

  it('records the matching Proposal identifier (Requirement 5.13)', () => {
    const outcome = duplicateActionCheck(
      input({}, { prior_proposals: { available: true, value: [prior()] } }),
    );
    expect(outcome.check.result).toBe('fail');
    expect(outcome.duplicate_proposal_id).toBe(prior().id);
    expect(outcome.check.detail).toContain(prior().id);
  });

  it('opens the window exactly 30 days back and closes it one millisecond earlier', () => {
    const window = duplicateLookbackWindow(NOW);
    expect(Date.parse(window.to) - Date.parse(window.from)).toBe(DUPLICATE_LOOKBACK_MS);

    const onBoundary = prior({ created_at: window.from, executed_at: window.from });
    const justOutside = prior({
      created_at: new Date(Date.parse(window.from) - 1).toISOString(),
      executed_at: new Date(Date.parse(window.from) - 1).toISOString(),
    });
    expect(findDuplicateProposal(submission(), [onBoundary])?.id).toBe(onBoundary.id);
    expect(findDuplicateProposal(submission(), [justOutside])).toBeNull();
  });

  it('matches only the blocking states, and never the Proposal itself', () => {
    for (const state of PROPOSAL_STATES) {
      const blocks = findDuplicateProposal(submission(), [prior({ state })]) !== null;
      expect(blocks, `state ${state}`).toBe(DUPLICATE_BLOCKING_STATES.includes(state));
    }
    expect(findDuplicateProposal(submission(), [prior({ id: PROPOSAL })])).toBeNull();
  });

  it('holds the five blocking states of FINDING 1, and excludes execution_failed', () => {
    expect([...DUPLICATE_BLOCKING_STATES]).toEqual([
      'awaiting_approval',
      'authorized',
      'executed',
      'verified',
      'verification_failed',
    ]);
    const excluded: readonly ProposalState[] = PROPOSAL_STATES.filter(
      (s) => !DUPLICATE_BLOCKING_STATES.includes(s),
    );
    expect([...excluded]).toEqual(['proposed', 'blocked', 'execution_failed', 'rejected', 'expired']);
  });

  it('ignores a different target set and a different action type', () => {
    expect(
      findDuplicateProposal(submission(), [
        prior({ target_fingerprint: proposalTargetFingerprint('post_reversal', [SETTLEMENT]) }),
      ]),
    ).toBeNull();
    expect(
      findDuplicateProposal(submission(), [
        prior({ target_fingerprint: proposalTargetFingerprint('post_accrual', TARGETS) }),
      ]),
    ).toBeNull();
  });

  it('records the most recent match, ties broken by ascending identifier', () => {
    const older = prior({ id: 'aaaaaaaa-0000-4000-8000-00000000000a', executed_at: '2026-02-10T00:00:00.000Z' });
    const newer = prior({ id: 'aaaaaaaa-0000-4000-8000-00000000000b', executed_at: '2026-02-25T00:00:00.000Z' });
    const tie = prior({ id: 'aaaaaaaa-0000-4000-8000-00000000000c', executed_at: '2026-02-25T00:00:00.000Z' });
    expect(findDuplicateProposal(submission(), [older, tie, newer])?.id).toBe(newer.id);
  });

  it('falls back to created_at for a candidate that never executed', () => {
    const awaiting = prior({
      state: 'awaiting_approval',
      created_at: '2026-02-27T00:00:00.000Z',
      executed_at: null,
    });
    expect(findDuplicateProposal(submission(), [awaiting])?.id).toBe(awaiting.id);
  });

  it('fails closed, recording no identifier, when the lookback could not be read', () => {
    const outcome = duplicateActionCheck(
      input({}, { prior_proposals: { available: false, reason: 'statement timeout' } }),
    );
    expect(outcome.check.result).toBe('fail');
    expect(outcome.duplicate_proposal_id).toBeUndefined();
  });

  it('binds the Tenant in the lookback statement, not in the query a caller builds', () => {
    expect(DUPLICATE_ACTION_LOOKBACK_SQL).toContain('tenant_id = $1');
    expect(DUPLICATE_ACTION_LOOKBACK_SQL).toContain('state = ANY($3::proposal_state[])');
    expect(DUPLICATE_ACTION_LOOKBACK_SQL).toContain('coalesce(executed_at, created_at) >= $4');

    const window = duplicateLookbackWindow(NOW);
    expect(
      duplicateLookbackParams('44444444-4444-4444-8444-444444444444', {
        target_fingerprint: 'post_reversal|settlement:setl_1',
        states: DUPLICATE_BLOCKING_STATES,
        window,
      }),
    ).toEqual([
      '44444444-4444-4444-8444-444444444444',
      'post_reversal|settlement:setl_1',
      DUPLICATE_BLOCKING_STATES,
      window.from,
      window.to,
      null,
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. risk threshold                                                          */
/* -------------------------------------------------------------------------- */

describe('the risk threshold Policy_Check', () => {
  it('passes a comparable pair, including a score above the threshold', () => {
    // Requirement 5.7 needs "all six pass and risk > threshold" to be reachable, so
    // this check must NOT fail on the comparison. See the module doc comment.
    expect(riskThresholdCheck(input({ risk_score: 100, auto_execute_threshold: 0 })).result).toBe(
      'pass',
    );
    expect(riskThresholdCheck(input({ risk_score: 0, auto_execute_threshold: 100 })).result).toBe(
      'pass',
    );
  });

  it('fails an absent, fractional or out-of-range score or threshold', () => {
    for (const [score, threshold] of [
      [null, 40],
      [61, null],
      [-1, 40],
      [101, 40],
      [61, 101],
      [60.5, 40],
    ] as const) {
      expect(
        riskThresholdCheck(input({ risk_score: score, auto_execute_threshold: threshold })).result,
        `score ${String(score)} threshold ${String(threshold)}`,
      ).toBe('fail');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 6. approval requirement                                                    */
/* -------------------------------------------------------------------------- */

describe('the approval requirement Policy_Check', () => {
  it('passes a fresh Proposal and a blocked one awaiting re-evaluation', () => {
    expect(approvalRequirementCheck(input()).result).toBe('pass');
    expect(
      approvalRequirementCheck(input({ proposal: proposal({ state: 'blocked' }) })).result,
    ).toBe('pass');
  });

  it('fails a rejected, expired or already-executed Proposal', () => {
    for (const state of ['rejected', 'expired', 'executed', 'verified', 'verification_failed'] as const) {
      expect(
        approvalRequirementCheck(input({ proposal: proposal({ state }) })).result,
        `state ${state}`,
      ).toBe('fail');
    }
  });

  it('requires a recorded approval inside the Approval_Window (Requirement 5.9, 5.16)', () => {
    const awaiting = proposal({
      state: 'awaiting_approval',
      approval_deadline: '2026-02-28T12:00:00.000Z',
    });
    expect(approvalRequirementCheck(input({ proposal: awaiting })).result).toBe('fail');
    expect(
      approvalRequirementCheck(
        input({ proposal: awaiting }, { authorizations: { available: true, value: [approval()] } }),
      ).result,
    ).toBe('pass');
    // One millisecond past the deadline is outside the Approval_Window.
    expect(
      approvalRequirementCheck(
        input(
          { proposal: awaiting },
          {
            authorizations: {
              available: true,
              value: [approval({ decided_at: '2026-02-28T12:00:00.001Z' })],
            },
          },
        ),
      ).result,
    ).toBe('fail');
  });

  it('fails an awaiting-approval Proposal carrying no deadline', () => {
    expect(
      approvalRequirementCheck(
        input(
          { proposal: proposal({ state: 'awaiting_approval' }) },
          { authorizations: { available: true, value: [approval()] } },
        ),
      ).result,
    ).toBe('fail');
  });

  it('fails wherever a rejection is on record (Requirement 5.10)', () => {
    const rejected = { available: true as const, value: [approval({ decision: 'rejected' })] };
    expect(approvalRequirementCheck(input({}, { authorizations: rejected })).result).toBe('fail');
    expect(
      approvalRequirementCheck(
        input({ proposal: proposal({ state: 'authorized' }) }, { authorizations: rejected }),
      ).result,
    ).toBe('fail');
  });

  it('requires an Authorization for an authorized Proposal (Requirement 5.14)', () => {
    const authorized = proposal({ state: 'authorized' });
    expect(approvalRequirementCheck(input({ proposal: authorized })).result).toBe('fail');
    expect(
      approvalRequirementCheck(
        input({ proposal: authorized }, { authorizations: { available: true, value: [approval()] } }),
      ).result,
    ).toBe('pass');
  });

  it('requires a NEW Authorization after an execution failure (Requirement 5.17)', () => {
    const failed = proposal({
      state: 'execution_failed',
      executed_at: '2026-02-28T06:00:00.000Z',
    });
    // The Authorization that authorized the failed attempt does not authorize a retry.
    expect(
      approvalRequirementCheck(
        input(
          { proposal: failed },
          {
            authorizations: {
              available: true,
              value: [approval({ decided_at: '2026-02-28T05:00:00.000Z' })],
            },
          },
        ),
      ).result,
    ).toBe('fail');
    expect(
      approvalRequirementCheck(
        input(
          { proposal: failed },
          {
            authorizations: {
              available: true,
              value: [approval({ decided_at: '2026-02-28T07:00:00.000Z' })],
            },
          },
        ),
      ).result,
    ).toBe('pass');
  });

  it('fails an Approval_Window outside 1..168 hours (Requirement 5.16)', () => {
    for (const hours of [0, 169, 24.5]) {
      expect(
        approvalRequirementCheck(input({ approval_window_hours: hours })).result,
        `window ${hours}`,
      ).toBe('fail');
    }
    expect(approvalRequirementCheck(input({ approval_window_hours: 24 })).result).toBe('pass');
  });

  it('fails an unknown state label rather than assuming it is safe', () => {
    expect(
      approvalRequirementCheck(
        input({ proposal: proposal({ state: 'settled' as ProposalState }) }),
      ).result,
    ).toBe('fail');
  });
});

/* -------------------------------------------------------------------------- */
/* The bounded, fact-gathering path (Requirement 5.3's 10 seconds)            */
/* -------------------------------------------------------------------------- */

function sources(overrides: Partial<PolicyFactSources> = {}): PolicyFactSources {
  return {
    evidenceGrounding: () =>
      Promise.resolve({ evidence_chain_id: CHAIN, cited_source_records: [...TARGETS] }),
    priorProposals: () => Promise.resolve([]),
    recordedAuthorizations: () => Promise.resolve([]),
    ...overrides,
  };
}

describe('runPolicyChecks', () => {
  it("fixes the bound at Requirement 5.3's 10 seconds", () => {
    expect(POLICY_EVALUATION_BUDGET_MS).toBe(10_000);
  });

  it('gathers the three facts and passes all six', async () => {
    const seen: string[] = [];
    const outcome = await runPolicyChecks(
      submission(),
      sources({
        priorProposals: (query) => {
          seen.push(query.target_fingerprint);
          // The Tenant is the adapter's, never the query's (Requirement 12.7).
          expect(Object.keys(query)).not.toContain('tenant_id');
          expect(query.exclude_proposal_id).toBe(PROPOSAL);
          expect([...query.states]).toEqual([...DUPLICATE_BLOCKING_STATES]);
          return Promise.resolve([]);
        },
      }),
    );
    expect(seen).toEqual([proposalTargetFingerprint('post_reversal', TARGETS)]);
    expect(anyCheckFailed(outcome.checks)).toBe(false);
    expect(outcome.timed_out).toBe(false);
  });

  it('does not read Authorizations for a Proposal that is not persisted yet', async () => {
    let called = 0;
    const outcome = await runPolicyChecks(
      submission({ proposal: proposal({ id: undefined }) }),
      sources({
        recordedAuthorizations: () => {
          called += 1;
          return Promise.resolve([]);
        },
      }),
    );
    expect(called).toBe(0);
    expect(anyCheckFailed(outcome.checks)).toBe(false);
  });

  it('fails only the checks whose source rejected', async () => {
    const outcome = await runPolicyChecks(
      submission(),
      sources({ priorProposals: () => Promise.reject(new Error('statement timeout')) }),
    );
    expect(failedCheckIds(outcome.checks)).toEqual(['duplicate_action']);
    expect(outcome.checks).toHaveLength(POLICY_CHECK_COUNT);
  });

  it('returns six results inside the budget when a source never settles', async () => {
    const outcome = await runPolicyChecks(
      submission(),
      sources({ evidenceGrounding: () => new Promise(() => undefined) }),
      { budgetMs: 25 },
    );
    expect(outcome.timed_out).toBe(true);
    expect(outcome.checks).toHaveLength(POLICY_CHECK_COUNT);
    // Failing closed: the derived decision is `block`, and the other five still report.
    expect(failedCheckIds(outcome.checks)).toEqual(['transaction_evidence']);
    expect(outcome.checks.find((c) => c.id === 'transaction_evidence')?.detail).toContain(
      'evaluation bound',
    );
  });

  it('aborts the signal it handed the sources on overrun', async () => {
    let signal: AbortSignal | undefined;
    await runPolicyChecks(
      submission(),
      sources({
        evidenceGrounding: (_chainId, s) => {
          signal = s;
          return new Promise(() => undefined);
        },
      }),
      { budgetMs: 25 },
    );
    expect(signal?.aborted).toBe(true);
  });

  it('raises rather than reporting six passes for an unusable submission instant', async () => {
    await expect(
      runPolicyChecks(submission({ submitted_at: 'not-an-instant' }), sources()),
    ).rejects.toThrow(PolicyCheckError);
  });
});
