'use client';

/**
 * The approval queue (task 27.1).
 * Requirements 5.4, 5.9, 5.10, 5.16, 14.6.
 *
 * Sensitive_Actions with **all six** Policy_Check results, the risk score, the
 * Auto_Execute_Threshold used, an Evidence_Chain control on the figure, and the
 * remaining Approval_Window counted down from `approval_deadline`. Approve and reject
 * are rendered only where the session holds `approve_sensitive_actions`.
 *
 * Thin by construction, the convention `MetricCell.tsx` and `AttentionPanel.tsx` set:
 * every wording, format and gating decision is in `./approval-queue-view-model.ts`,
 * every transition is in `./approval-queue-state.ts`, and this file places strings and
 * wires handlers. {@link ApprovalQueueDisplay} is pure — same state in, same markup
 * out — so it renders equally from a server-resolved snapshot and from the
 * self-loading {@link ApprovalQueue}.
 *
 * ## The Tenant and the User are the session's, and neither is a prop
 *
 * {@link ApprovalQueueSource} has no `tenantId` and no `userId`. `loadQueue` reads
 * `proposals` through an adapter that binds the Tenant from the session
 * (Requirement 12.7, 14.1), and `approve`/`reject` take a Proposal identifier only —
 * the approving User is the session's, resolved where `approveProposal` and
 * `rejectProposal` are called. A Tenant or a User a caller could pass is a Tenant or a
 * User a caller could bend, and RLS plus the FinanceOS_Authorization_Service are the
 * controls rather than anything in this file.
 *
 * ## The permission gate here is presentation; the gate is server-side
 *
 * `grantedPermissions` decides whether the two controls are *drawn*
 * (`docs/08_UI_UX_SPEC.md`: an expired proposal "removes both controls rather than
 * leaving them to fail on click", and the controls are gated on
 * `approve_sensitive_actions`). Requirement 14.6's actual verification is
 * `AuthorizationService.require` in `@/authz/authorization-service`, before the action
 * reads or changes any Tenant financial data. A User who reaches the endpoint anyway
 * is refused there, whatever this component drew.
 *
 * ## Accessibility
 *
 * - **All six Policy_Check results are a table** with a caption and row headers, so a
 *   screen reader reads "transaction evidence — Failed — <reason>" rather than six
 *   unlabelled cells. `data-check-result` is for styling and tests only.
 * - **Nothing is conveyed by colour.** Every result carries `Passed`, `Failed` or
 *   `Not recorded` as text; the state, the risk comparison and the remaining window
 *   are sentences.
 * - **Each row has an accessible name** (`<article aria-labelledby>` at its own
 *   heading) and a **stable polite live region** carrying the row's announcement, so a
 *   countdown crossing into the last minutes, or a settled decision, is audible.
 * - **The figure is a real `<button>`** opening its Evidence_Chain (Requirement 12.5),
 *   with an accessible name naming the figure and the Proposal rather than being one of
 *   many identical "View evidence" buttons.
 * - **Approve and reject are real `<button type="button">`s** with names that include
 *   the action and the Proposal, disabled while a decision is in flight, and absent
 *   entirely when the decision cannot be made — with the reason rendered as text.
 * - **Instants are `<time dateTime>`** with the IST text beside the machine value
 *   (Requirement 3.10).
 *
 * Layout and theming are absent on purpose: no stylesheet exists yet and design.md
 * fixes no visual design for this view beyond `docs/08_UI_UX_SPEC.md`'s ordering.
 */

import { useCallback, useEffect, useId, useReducer, type ReactElement } from 'react';

import type { ExecutionOutcome, RejectionOutcome } from '@/action/action-service';
import { SR_ONLY_STYLE } from '@/app/control-tower/MetricCell';
import type { Permission } from '@/authz/permissions';

import {
  approvalQueueReducer,
  APPROVAL_QUEUE_TICK_MS,
  initialApprovalQueueState,
  type ApprovalQueueState,
  type DecisionRecord,
} from './approval-queue-state';
import {
  approvalQueueRows,
  decisionOutcomeText,
  type ApprovalQueueRowView,
  type SensitiveActionSnapshot,
} from './approval-queue-view-model';

/* -------------------------------------------------------------------------- */
/* Seams                                                                      */
/* -------------------------------------------------------------------------- */

export interface EvidenceChainOpenRequest {
  readonly proposalId: string;
  readonly evidenceChainId: string;
}

/**
 * Where the queue's rows and decisions go.
 *
 * `approve` and `reject` are `approveProposal` and `rejectProposal` from
 * `@/action/action-service` with the session's User and the granted Permission set
 * already bound — see the module doc comment for why neither is a prop.
 */
export interface ApprovalQueueSource {
  /** The Sensitive_Actions for the session's Tenant. */
  readonly loadQueue: (signal: AbortSignal) => Promise<readonly SensitiveActionSnapshot[]>;
  /** Requirement 5.9. */
  readonly approve: (proposalId: string) => Promise<ExecutionOutcome>;
  /** Requirement 5.10. */
  readonly reject: (proposalId: string) => Promise<RejectionOutcome>;
  /** What the session holds, from `AuthorizationService.permissionsFor`. */
  readonly grantedPermissions: readonly Permission[];
  /** Injectable clock, so the countdown is assertable. Defaults to the wall clock. */
  readonly now?: () => Date;
}

/* -------------------------------------------------------------------------- */
/* State ownership                                                            */
/* -------------------------------------------------------------------------- */

const LOAD_FAILURE_MESSAGE =
  'The Sensitive_Actions awaiting approval could not be loaded. Nothing was approved or ' +
  'rejected.';

export interface ApprovalQueueProps {
  readonly source: ApprovalQueueSource;
  readonly onOpenEvidence: (request: EvidenceChainOpenRequest) => void;
}

/** The self-loading queue: one reducer, one load effect, one clock effect. */
export function ApprovalQueue({ source, onOpenEvidence }: ApprovalQueueProps): ReactElement {
  const { approve, grantedPermissions, loadQueue, reject } = source;
  const now = source.now ?? ((): Date => new Date());
  const [state, dispatch] = useReducer(
    approvalQueueReducer,
    now().toISOString(),
    initialApprovalQueueState,
  );

  useEffect(() => {
    const controller = new AbortController();
    loadQueue(controller.signal).then(
      (rows) => {
        if (!controller.signal.aborted) {
          dispatch({ type: 'rows_loaded', rows });
        }
      },
      () => {
        if (!controller.signal.aborted) {
          dispatch({ type: 'rows_failed', message: LOAD_FAILURE_MESSAGE });
        }
      },
    );
    return () => {
      controller.abort();
    };
  }, [loadQueue, state.revision]);

  // Requirement 5.16's remaining window is a function of the clock, so the clock is
  // advanced rather than read during render.
  useEffect(() => {
    const timer = setInterval(() => {
      dispatch({ type: 'clock_ticked', nowIso: new Date().toISOString() });
    }, APPROVAL_QUEUE_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const onApprove = useCallback(
    (proposalId: string) => {
      dispatch({ type: 'decision_requested', proposalId, decision: 'approved' });
      approve(proposalId).then(
        (outcome) => {
          dispatch({ type: 'decision_settled', proposalId, outcomeText: decisionOutcomeText(outcome) });
        },
        () => {
          dispatch({
            type: 'decision_failed',
            proposalId,
            message:
              'The approval did not complete. Whether the Authorization was recorded is ' +
              'shown by the reloaded Proposal state.',
          });
        },
      );
    },
    [approve],
  );

  const onReject = useCallback(
    (proposalId: string) => {
      dispatch({ type: 'decision_requested', proposalId, decision: 'rejected' });
      reject(proposalId).then(
        (outcome) => {
          dispatch({ type: 'decision_settled', proposalId, outcomeText: decisionOutcomeText(outcome) });
        },
        () => {
          dispatch({
            type: 'decision_failed',
            proposalId,
            message:
              'The rejection did not complete. Whether it was recorded is shown by the ' +
              'reloaded Proposal state.',
          });
        },
      );
    },
    [reject],
  );

  return (
    <ApprovalQueueDisplay
      state={state}
      grantedPermissions={grantedPermissions}
      onApprove={onApprove}
      onReject={onReject}
      onOpenEvidence={onOpenEvidence}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Presentation                                                               */
/* -------------------------------------------------------------------------- */

export interface ApprovalQueueDisplayProps {
  readonly state: ApprovalQueueState;
  readonly grantedPermissions: readonly Permission[];
  readonly onApprove: (proposalId: string) => void;
  readonly onReject: (proposalId: string) => void;
  readonly onOpenEvidence: (request: EvidenceChainOpenRequest) => void;
}

/** Pure presentation. Native buttons give pointer, Enter and Space activation. */
export function ApprovalQueueDisplay({
  state,
  grantedPermissions,
  onApprove,
  onReject,
  onOpenEvidence,
}: ApprovalQueueDisplayProps): ReactElement {
  const headingId = useId();
  const rows = approvalQueueRows(state.rows, {
    nowIso: state.nowIso,
    grantedPermissions,
  });
  const empty = state.status === 'ready' && rows.length === 0;

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={state.status === 'loading'}
      data-approvals="queue"
    >
      <h2 id={headingId}>Sensitive actions</h2>

      {state.status === 'loading' ? (
        <p role="status">Loading Sensitive_Actions awaiting approval…</p>
      ) : null}
      {state.status === 'failed' ? <p role="alert">{state.error}</p> : null}

      {empty ? (
        <p role="status" data-approvals-empty="none-awaiting-approval">
          No Sensitive_Action is awaiting a decision. Nothing is being withheld.
        </p>
      ) : (
        <ol aria-label="Sensitive actions awaiting a decision">
          {rows.map((row) => (
            <li key={row.proposalId}>
              <ApprovalQueueRow
                row={row}
                decision={state.decisions.get(row.proposalId)}
                onApprove={onApprove}
                onReject={onReject}
                onOpenEvidence={onOpenEvidence}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

interface ApprovalQueueRowProps {
  readonly row: ApprovalQueueRowView;
  readonly decision: DecisionRecord | undefined;
  readonly onApprove: (proposalId: string) => void;
  readonly onReject: (proposalId: string) => void;
  readonly onOpenEvidence: (request: EvidenceChainOpenRequest) => void;
}

/** One Sensitive_Action. */
function ApprovalQueueRow({
  row,
  decision,
  onApprove,
  onReject,
  onOpenEvidence,
}: ApprovalQueueRowProps): ReactElement {
  const titleId = useId();
  const pending = decision?.pending === true;

  return (
    <article
      aria-labelledby={titleId}
      aria-busy={pending}
      data-proposal-id={row.proposalId}
      data-proposal-state={row.state}
    >
      <h3 id={titleId}>
        {row.actionLabel} <code>{row.proposalId}</code>
      </h3>

      <p data-proposal-state-text>
        {row.stateText}, proposed by {row.agentName} at{' '}
        <time dateTime={row.createdAt.machine}>{row.createdAt.text}</time>
      </p>

      {/* Requirement 12.5: the figure itself opens its Evidence_Chain. */}
      <p>
        Impact{' '}
        <button
          type="button"
          data-open-evidence={row.evidenceChainId}
          aria-label={`Open Evidence_Chain for the ${row.impact.primary} impact of ${row.actionLabel} proposal ${row.proposalId}`}
          onClick={() => {
            onOpenEvidence({
              proposalId: row.proposalId,
              evidenceChainId: row.evidenceChainId,
            });
          }}
        >
          <data value={row.impact.machinePaise}>{row.impact.primary}</data>
          {row.impact.secondary === null ? null : (
            <span data-impact-secondary={row.impact.secondaryUnit}> {row.impact.secondary}</span>
          )}
          <span data-evidence-reference>
            {' '}
            Evidence chain <code>{row.evidenceChainId}</code>
          </span>
        </button>
      </p>

      {/* Requirement 5.4: the score, the threshold used, and the comparison. */}
      <p data-risk={row.risk.kind}>
        {row.risk.scoreText}. {row.risk.thresholdText}. {row.risk.comparisonText}
      </p>

      {/* Requirement 5.16: the remaining Approval_Window. */}
      <p data-approval-window={row.window.kind}>
        {row.window.text}
        {row.window.deadline === null ? null : (
          <>
            {' '}
            (deadline{' '}
            <time dateTime={row.window.deadline.machine}>{row.window.deadline.text}</time>)
          </>
        )}
      </p>

      {/* Requirement 5.4: all six results, always. */}
      <table data-policy-checks>
        <caption>Policy checks</caption>
        <thead>
          <tr>
            <th scope="col">Policy check</th>
            <th scope="col">Result</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {row.checks.map((check) => (
            <tr key={check.id} data-check={check.id} data-check-result={check.result}>
              <th scope="row">{check.label}</th>
              <td>{check.resultText}</td>
              <td>{check.detail ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {row.checksNotice === null ? null : <p data-policy-checks-notice>{row.checksNotice}</p>}

      {row.targets.length === 0 ? null : (
        <dl aria-label={`Target records for proposal ${row.proposalId}`}>
          {row.targets.map((target) => (
            <div key={target.key}>
              <dt>{target.type}</dt>
              <dd>{target.id}</dd>
            </div>
          ))}
        </dl>
      )}

      {row.controls.visible ? (
        <p data-approval-controls="visible">
          <button
            type="button"
            data-approve={row.proposalId}
            disabled={pending}
            onClick={() => {
              onApprove(row.proposalId);
            }}
          >
            Approve
            <span style={SR_ONLY_STYLE}>
              {' '}
              {row.actionLabel} proposal {row.proposalId}
            </span>
          </button>{' '}
          <button
            type="button"
            data-reject={row.proposalId}
            disabled={pending}
            onClick={() => {
              onReject(row.proposalId);
            }}
          >
            Reject
            <span style={SR_ONLY_STYLE}>
              {' '}
              {row.actionLabel} proposal {row.proposalId}
            </span>
          </button>
        </p>
      ) : (
        <p data-approval-controls="absent">{row.controls.reason}</p>
      )}

      {pending ? (
        <p role="status">
          {decision?.decision === 'approved' ? 'Approving' : 'Rejecting'} this Proposal…
        </p>
      ) : null}
      {decision !== undefined && !pending && decision.outcomeText !== null ? (
        <p role={decision.failed ? 'alert' : 'status'} data-decision-outcome={decision.decision}>
          {decision.outcomeText}
        </p>
      ) : null}

      {/* Stable polite live region: the text changes, the element does not. */}
      <p style={SR_ONLY_STYLE} aria-live="polite">
        {row.announcement}
      </p>
    </article>
  );
}
