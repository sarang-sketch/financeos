import { describe, expect, it } from 'vitest';

import { POLICY_CHECK_IDS } from '@/policy/checks';

import {
  approvalControlsView,
  approvalQueueRows,
  approvalQueueRowView,
  approvalWindowView,
  decisionOutcomeText,
  formatWindowDuration,
  policyCheckViews,
  readPersistedPolicyChecks,
  riskView,
  type SensitiveActionSnapshot,
} from './approval-queue-view-model';

const NOW = '2026-03-14T12:00:00.000Z';

/** design.md's shape, as `src/policy/decide.ts`'s `policyChecksJson` writes it. */
const RECORDED_CHECKS = [
  { id: 'user_permission', result: 'pass' },
  { id: 'accounting_rule', result: 'pass' },
  { id: 'transaction_evidence', result: 'pass' },
  { id: 'duplicate_action', result: 'pass' },
  { id: 'risk_threshold', result: 'pass' },
  { id: 'approval_requirement', result: 'pass' },
];

const SNAPSHOT: SensitiveActionSnapshot = {
  proposal_id: '40000000-0000-4000-8000-000000000001',
  agent_name: 'reconciliation',
  action_type: 'post_reconciliation_adjustment',
  target_source_records: [{ type: 'settlement', id: 'setl_9281' }],
  impact_paise: 66_100n,
  evidence_chain_id: '50000000-0000-4000-8000-000000000001',
  state: 'awaiting_approval',
  policy_checks: RECORDED_CHECKS,
  risk_score: 40,
  threshold_used: 0,
  approval_deadline: '2026-03-15T09:14:00.000Z',
  created_at: '2026-03-14T09:00:00.000Z',
};

describe('persisted Policy_Check results', () => {
  it('reads design.md’s { id, result, detail? } shape and keeps every detail', () => {
    const read = readPersistedPolicyChecks([
      { id: 'risk_threshold', result: 'fail', detail: 'the threshold comparison cannot be made' },
    ]);
    expect(read).toEqual({
      kind: 'recorded',
      checks: [
        {
          id: 'risk_threshold',
          result: 'fail',
          detail: 'the threshold comparison cannot be made',
        },
      ],
    });
  });

  it('reports the { name, passed } fixture shape as unreadable rather than as unevaluated', () => {
    // FINDING 1: test/db/proposals-authorizations.test.ts writes this shape; the
    // Policy_Engine writes design.md's. A divergent column is a defect, not a
    // Proposal nobody evaluated, so the two must not render the same.
    const read = readPersistedPolicyChecks([{ name: 'user_permission', passed: true }]);
    expect(read.kind).toBe('unreadable');
  });

  it('treats a SQL NULL column as absent and a repeated check id as unreadable', () => {
    expect(readPersistedPolicyChecks(null)).toEqual({ kind: 'absent' });
    expect(
      readPersistedPolicyChecks([
        { id: 'duplicate_action', result: 'pass' },
        { id: 'duplicate_action', result: 'fail' },
      ]).kind,
    ).toBe('unreadable');
  });
});

describe('all six Policy_Check results (Requirement 5.4)', () => {
  it('renders six results in POLICY_CHECK_IDS order even when only one failure is stored', () => {
    const views = policyCheckViews(
      readPersistedPolicyChecks([{ id: 'risk_threshold', result: 'fail', detail: 'no score' }]),
    );
    expect(views.map((view) => view.id)).toEqual([...POLICY_CHECK_IDS]);
    expect(views.filter((view) => view.result === 'fail')).toHaveLength(1);
    expect(views.filter((view) => view.result === 'not_recorded')).toHaveLength(5);
    expect(views.map((view) => view.resultText)).not.toContain('Passed');
  });

  it('states every result in words, so no result depends on colour', () => {
    const views = policyCheckViews(readPersistedPolicyChecks(RECORDED_CHECKS));
    expect(views).toHaveLength(6);
    expect(new Set(views.map((view) => view.resultText))).toEqual(new Set(['Passed']));
    expect(views[2]?.label).toBe('transaction evidence');
  });
});

describe('risk score and threshold used (Requirement 5.4, 5.15)', () => {
  it('spells out the comparison that produced require-approval', () => {
    const view = riskView(40, 0);
    expect(view.kind).toBe('scored');
    expect(view.scoreText).toBe('Risk 40 of 100');
    expect(view.thresholdText).toBe('Auto-execute threshold 0');
    expect(view.comparisonText).toContain('exceeds');
  });

  it('renders a null score as not computable and never as 0', () => {
    const view = riskView(null, 0);
    expect(view.kind).toBe('not_computable');
    expect(view.score).toBeNull();
    expect(view.scoreText).toBe('Risk score not computable');
    expect(view.scoreText).not.toMatch(/\b0\b/);
    expect(view.comparisonText).toContain('not a score of 0');
  });

  it('reports an out-of-range stored score and an unresolved threshold rather than showing them', () => {
    expect(riskView(101, 0).kind).toBe('not_computable');
    expect(riskView(40, null).thresholdText).toBe('Auto-execute threshold not resolved');
    expect(riskView(40, null).comparisonText).toContain('was not recorded');
  });

  it('renders a score of 0 as the real score it is', () => {
    const view = riskView(0, 0);
    expect(view.scoreText).toBe('Risk 0 of 100');
    expect(view.comparisonText).toContain('at or below');
  });
});

describe('remaining Approval_Window (Requirement 5.16)', () => {
  it('counts down from approval_deadline, truncated to the minute', () => {
    const view = approvalWindowView('2026-03-15T09:14:59.000Z', NOW);
    expect(view.kind).toBe('remaining');
    expect(view.text).toBe('Expires in 21h 14m');
    expect(view.deadline?.machine).toBe('2026-03-15T14:44:59+05:30');
  });

  it('reports an elapsed window with how long ago, and no remaining time', () => {
    const view = approvalWindowView('2026-03-14T09:30:00.000Z', NOW);
    expect(view.kind).toBe('elapsed');
    expect(view.remainingMs).toBeNull();
    expect(view.text).toBe('Approval window elapsed 2h 30m ago');
  });

  it('distinguishes an absent deadline from an elapsed one', () => {
    const view = approvalWindowView(null, NOW);
    expect(view.kind).toBe('absent');
    expect(view.deadline).toBeNull();
    expect(view.text).toContain('No approval deadline is recorded');
  });

  it('formats sub-hour and sub-minute remainders without rounding up', () => {
    expect(formatWindowDuration(59 * 60_000 + 59_000)).toBe('59m');
    expect(formatWindowDuration(59_000)).toBe('under 1 minute');
    expect(formatWindowDuration(3_600_000)).toBe('1h 0m');
  });
});

describe('approve and reject gating (Requirement 14.6)', () => {
  const remaining = approvalWindowView('2026-03-15T09:14:00.000Z', NOW);

  it('renders both controls for an awaiting_approval Proposal inside the window', () => {
    const view = approvalControlsView('awaiting_approval', remaining, [
      'approve_sensitive_actions',
    ]);
    expect(view).toEqual({
      visible: true,
      reason: null,
      requiredPermission: 'approve_sensitive_actions',
    });
  });

  it('removes both controls and names the Permission when the session does not hold it', () => {
    const view = approvalControlsView('awaiting_approval', remaining, ['view_financial_data']);
    expect(view.visible).toBe(false);
    expect(view.reason).toContain('approve_sensitive_actions');
  });

  it('removes both controls on an expired Proposal and on an elapsed window', () => {
    const elapsed = approvalWindowView('2026-03-14T09:00:00.000Z', NOW);
    expect(
      approvalControlsView('expired', elapsed, ['approve_sensitive_actions']).visible,
    ).toBe(false);
    expect(
      approvalControlsView('awaiting_approval', elapsed, ['approve_sensitive_actions']).reason,
    ).toContain('Approval_Window elapsed');
  });

  it('removes both controls when an awaiting_approval Proposal carries no deadline', () => {
    const absent = approvalWindowView(null, NOW);
    const view = approvalControlsView('awaiting_approval', absent, [
      'approve_sensitive_actions',
    ]);
    expect(view.visible).toBe(false);
    expect(view.reason).toContain('approval deadline');
  });
});

describe('the row and the queue', () => {
  const options = {
    nowIso: NOW,
    grantedPermissions: ['approve_sensitive_actions'] as const,
  };

  it('formats the persisted impact through formatInr and exposes the exact paise', () => {
    const row = approvalQueueRowView(SNAPSHOT, options);
    expect(row.impact.primary).toBe('₹661.00');
    expect(row.impact.machinePaise).toBe('66100');
    expect(row.actionLabel).toBe('Post reconciliation adjustment');
    expect(row.evidenceChainId).toBe(SNAPSHOT.evidence_chain_id);
    expect(row.checks).toHaveLength(6);
    expect(row.controls.visible).toBe(true);
  });

  it('renders all six results and the gate picture on a blocked Proposal', () => {
    const row = approvalQueueRowView(
      {
        ...SNAPSHOT,
        state: 'blocked',
        approval_deadline: null,
        risk_score: null,
        policy_checks: [
          { id: 'user_permission', result: 'pass' },
          { id: 'accounting_rule', result: 'pass' },
          { id: 'transaction_evidence', result: 'pass' },
          { id: 'duplicate_action', result: 'pass' },
          { id: 'risk_threshold', result: 'fail', detail: 'the risk score is absent' },
          { id: 'approval_requirement', result: 'pass' },
        ],
      },
      options,
    );
    expect(row.checks).toHaveLength(6);
    expect(row.failedCheckIds).toEqual(['risk_threshold']);
    expect(row.checks[4]?.detail).toBe('the risk score is absent');
    expect(row.risk.kind).toBe('not_computable');
    expect(row.controls.visible).toBe(false);
    expect(row.announcement).toContain('5 of 6 Policy_Checks passed');
  });

  it('lists only queue states, soonest deadline first, deadlineless rows last', () => {
    const rows = approvalQueueRows(
      [
        { ...SNAPSHOT, proposal_id: 'p-late', approval_deadline: '2026-03-16T00:00:00.000Z' },
        { ...SNAPSHOT, proposal_id: 'p-none', state: 'blocked', approval_deadline: null },
        { ...SNAPSHOT, proposal_id: 'p-soon', approval_deadline: '2026-03-14T18:00:00.000Z' },
        { ...SNAPSHOT, proposal_id: 'p-executed', state: 'executed' },
      ],
      options,
    );
    expect(rows.map((row) => row.proposalId)).toEqual(['p-soon', 'p-late', 'p-none']);
  });
});

describe('decision outcomes (Requirement 5.9, 5.10)', () => {
  it('tells an executed approval apart from a withheld one', () => {
    expect(
      decisionOutcomeText({
        kind: 'executed',
        proposal_id: 'p1',
        authorization_id: 'a1',
        executed_at: NOW,
      }),
    ).toContain('executed');
    expect(
      decisionOutcomeText({
        kind: 'withheld',
        proposal_id: 'p1',
        reason: 'resubmission_blocked',
        detail: 'the resubmitted evaluation returned block',
      }),
    ).toContain('execution was withheld');
  });

  it('tells a discarded rejection apart from a refused one', () => {
    expect(
      decisionOutcomeText({
        kind: 'discarded',
        proposal_id: 'p1',
        authorization_id: 'a1',
        decided_at: NOW,
      }),
    ).toContain('discarded without execution');
    expect(
      decisionOutcomeText({
        kind: 'refused',
        proposal_id: 'p1',
        reason: 'not_awaiting_approval',
        detail: 'the Proposal is not awaiting approval',
      }),
    ).toContain('refused');
  });
});
