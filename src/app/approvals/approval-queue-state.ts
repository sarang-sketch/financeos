/**
 * The approval queue's async state (task 27.1).
 * Requirements 5.4, 5.9, 5.10, 5.16.
 *
 * Same split `src/app/control-tower/attention-panel-state.ts` set: a pure reducer here,
 * one `useReducer` and a couple of effects in `./ApprovalQueue.tsx`. Every transition is
 * therefore testable with no DOM, which is what the repository's `environment: 'node'`
 * test projects allow.
 *
 * Three things this reducer owns and the component does not:
 *
 * 1. **The clock.** The remaining Approval_Window is a function of `now`
 *    (Requirement 5.16), so `now` is state: {@link APPROVAL_QUEUE_TICK_MS} apart, the
 *    component dispatches `clock_ticked` and the countdown re-renders. Reading
 *    `Date.now()` inside the view model instead would make the countdown untestable
 *    and the render impure.
 * 2. **One in-flight decision per Proposal.** `decision_requested` marks the row
 *    pending, which is what removes the second click: a User cannot approve a Proposal
 *    twice while the first approval is in flight, and cannot approve and reject the
 *    same Proposal concurrently.
 * 3. **The outcome of a settled decision, kept on the row.** Requirements 5.9 and 5.10
 *    both have outcomes a User must be told about — an approval whose resubmission
 *    came back `block` executed nothing, and a rejection that was refused discarded
 *    nothing. Dropping the outcome and refreshing the list would make those two
 *    indistinguishable from success.
 *
 * A settled decision also bumps `revision`, which is the component's reload trigger:
 * the row's stored state has moved (`authorized`, `rejected`, `blocked`) and the queue
 * is re-read rather than patched in place, so what is on screen is what is in
 * `proposals`.
 *
 * Pure and synchronous. No React, no DOM, no clock of its own.
 */

import type { UserDecision } from '@/action/action-service';

import type { SensitiveActionSnapshot } from './approval-queue-view-model';

/**
 * How often the component advances the clock.
 *
 * The countdown is rendered to the minute (`formatWindowDuration`), so a 30-second
 * tick keeps the displayed minute honest — at 60 seconds a `21h 14m` could be shown
 * for a minute after it became `21h 13m`, which for the last minute of an
 * Approval_Window is the difference between "you have time" and "you do not".
 */
export const APPROVAL_QUEUE_TICK_MS = 30_000;

export type ApprovalQueueStatus = 'loading' | 'ready' | 'failed';

/** A decision the User asked for, and what came back. */
export interface DecisionRecord {
  readonly decision: UserDecision;
  /** `true` while the Action_Service call is in flight. */
  readonly pending: boolean;
  /** The outcome in words, from `decisionOutcomeText`. `null` while pending. */
  readonly outcomeText: string | null;
  /** `true` when the call itself rejected, rather than returning an outcome. */
  readonly failed: boolean;
}

export interface ApprovalQueueState {
  readonly status: ApprovalQueueStatus;
  readonly rows: readonly SensitiveActionSnapshot[];
  readonly error: string | null;
  /** The instant the remaining Approval_Window is measured against. ISO-8601. */
  readonly nowIso: string;
  /** Keyed by `proposals.id`. A row with no entry has no decision this session. */
  readonly decisions: ReadonlyMap<string, DecisionRecord>;
  /** Bumped when the queue must be re-read. */
  readonly revision: number;
}

export function initialApprovalQueueState(nowIso: string): ApprovalQueueState {
  return {
    status: 'loading',
    rows: [],
    error: null,
    nowIso,
    decisions: new Map(),
    revision: 0,
  };
}

export type ApprovalQueueAction =
  | { readonly type: 'rows_loaded'; readonly rows: readonly SensitiveActionSnapshot[] }
  | { readonly type: 'rows_failed'; readonly message: string }
  | { readonly type: 'clock_ticked'; readonly nowIso: string }
  | {
      readonly type: 'decision_requested';
      readonly proposalId: string;
      readonly decision: UserDecision;
    }
  | {
      readonly type: 'decision_settled';
      readonly proposalId: string;
      readonly outcomeText: string;
    }
  | {
      readonly type: 'decision_failed';
      readonly proposalId: string;
      readonly message: string;
    }
  | { readonly type: 'reload_requested' };

function withDecision(
  state: ApprovalQueueState,
  proposalId: string,
  record: DecisionRecord,
): ReadonlyMap<string, DecisionRecord> {
  const next = new Map(state.decisions);
  next.set(proposalId, record);
  return next;
}

/** True when a decision for this Proposal is in flight. */
export function isDecisionPending(state: ApprovalQueueState, proposalId: string): boolean {
  return state.decisions.get(proposalId)?.pending === true;
}

export function approvalQueueReducer(
  state: ApprovalQueueState,
  action: ApprovalQueueAction,
): ApprovalQueueState {
  switch (action.type) {
    case 'rows_loaded':
      return { ...state, status: 'ready', rows: [...action.rows], error: null };
    case 'rows_failed':
      return { ...state, status: 'failed', error: action.message };
    case 'clock_ticked':
      return { ...state, nowIso: action.nowIso };
    case 'decision_requested': {
      // A second request while one is in flight is ignored rather than queued: the
      // Action_Service records one Authorization per accepted decision (Requirement
      // 5.9, 5.10), and two concurrent decisions on one Proposal is not something a
      // User can have meant.
      if (isDecisionPending(state, action.proposalId)) {
        return state;
      }
      return {
        ...state,
        decisions: withDecision(state, action.proposalId, {
          decision: action.decision,
          pending: true,
          outcomeText: null,
          failed: false,
        }),
      };
    }
    case 'decision_settled': {
      const existing = state.decisions.get(action.proposalId);
      if (existing === undefined) {
        return state;
      }
      return {
        ...state,
        decisions: withDecision(state, action.proposalId, {
          ...existing,
          pending: false,
          outcomeText: action.outcomeText,
          failed: false,
        }),
        // The stored state has moved, so the queue is re-read rather than patched.
        revision: state.revision + 1,
      };
    }
    case 'decision_failed': {
      const existing = state.decisions.get(action.proposalId);
      if (existing === undefined) {
        return state;
      }
      return {
        ...state,
        decisions: withDecision(state, action.proposalId, {
          ...existing,
          pending: false,
          outcomeText: action.message,
          failed: true,
        }),
        // A failed call may still have written the Authorization before failing, so the
        // queue is re-read for the same reason as a settled one.
        revision: state.revision + 1,
      };
    }
    case 'reload_requested':
      return { ...state, status: 'loading', error: null, revision: state.revision + 1 };
  }
}
