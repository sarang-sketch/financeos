import { describe, expect, it } from 'vitest';

import {
  approvalQueueReducer,
  initialApprovalQueueState,
  isDecisionPending,
  type ApprovalQueueState,
} from './approval-queue-state';
import type { SensitiveActionSnapshot } from './approval-queue-view-model';

const NOW = '2026-03-14T12:00:00.000Z';

const ROW: SensitiveActionSnapshot = {
  proposal_id: 'p1',
  agent_name: 'reconciliation',
  action_type: 'post_reconciliation_adjustment',
  target_source_records: [{ type: 'settlement', id: 'setl_9281' }],
  impact_paise: 66_100n,
  evidence_chain_id: '50000000-0000-4000-8000-000000000001',
  state: 'awaiting_approval',
  policy_checks: null,
  risk_score: 40,
  threshold_used: 0,
  approval_deadline: '2026-03-15T09:14:00.000Z',
  created_at: '2026-03-14T09:00:00.000Z',
};

const READY: ApprovalQueueState = approvalQueueReducer(initialApprovalQueueState(NOW), {
  type: 'rows_loaded',
  rows: [ROW],
});

describe('approval queue state', () => {
  it('starts loading and becomes ready with the rows it was given', () => {
    expect(initialApprovalQueueState(NOW).status).toBe('loading');
    expect(READY.status).toBe('ready');
    expect(READY.rows).toEqual([ROW]);
    expect(READY.error).toBeNull();
  });

  it('keeps a load failure as a message and shows no rows', () => {
    const failed = approvalQueueReducer(initialApprovalQueueState(NOW), {
      type: 'rows_failed',
      message: 'nope',
    });
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('nope');
    expect(failed.rows).toEqual([]);
  });

  it('advances the clock the remaining Approval_Window is measured against', () => {
    const ticked = approvalQueueReducer(READY, {
      type: 'clock_ticked',
      nowIso: '2026-03-14T12:00:30.000Z',
    });
    expect(ticked.nowIso).toBe('2026-03-14T12:00:30.000Z');
    expect(ticked.rows).toBe(READY.rows);
  });

  it('marks one decision pending and ignores a second while it is in flight', () => {
    const pending = approvalQueueReducer(READY, {
      type: 'decision_requested',
      proposalId: 'p1',
      decision: 'approved',
    });
    expect(isDecisionPending(pending, 'p1')).toBe(true);

    const again = approvalQueueReducer(pending, {
      type: 'decision_requested',
      proposalId: 'p1',
      decision: 'rejected',
    });
    expect(again).toBe(pending);
    expect(again.decisions.get('p1')?.decision).toBe('approved');
  });

  it('keeps the settled outcome on the row and asks for a reload', () => {
    const pending = approvalQueueReducer(READY, {
      type: 'decision_requested',
      proposalId: 'p1',
      decision: 'approved',
    });
    const settled = approvalQueueReducer(pending, {
      type: 'decision_settled',
      proposalId: 'p1',
      outcomeText: 'Approved, but execution was withheld: blocked on duplicate action',
    });
    expect(settled.decisions.get('p1')).toEqual({
      decision: 'approved',
      pending: false,
      outcomeText: 'Approved, but execution was withheld: blocked on duplicate action',
      failed: false,
    });
    expect(settled.revision).toBe(READY.revision + 1);
  });

  it('marks a failed call as failed, keeps its message and still asks for a reload', () => {
    const pending = approvalQueueReducer(READY, {
      type: 'decision_requested',
      proposalId: 'p1',
      decision: 'rejected',
    });
    const failed = approvalQueueReducer(pending, {
      type: 'decision_failed',
      proposalId: 'p1',
      message: 'The rejection did not complete.',
    });
    expect(failed.decisions.get('p1')?.failed).toBe(true);
    expect(failed.decisions.get('p1')?.pending).toBe(false);
    expect(failed.revision).toBe(READY.revision + 1);
  });

  it('ignores an outcome for a Proposal no decision was requested for', () => {
    expect(
      approvalQueueReducer(READY, {
        type: 'decision_settled',
        proposalId: 'unknown',
        outcomeText: 'x',
      }),
    ).toBe(READY);
  });

  it('returns to loading on a reload request', () => {
    const reloading = approvalQueueReducer(READY, { type: 'reload_requested' });
    expect(reloading.status).toBe('loading');
    expect(reloading.revision).toBe(READY.revision + 1);
  });
});
