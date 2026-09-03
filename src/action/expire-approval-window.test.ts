/**
 * Approval_Window expiry (task 23.5).
 * Requirement 5.16.
 *
 * The Audit_Service here is the **real** one — `createAuditService` over an in-memory
 * `AuditEventStore` — so "appends an Audit_Event recording the expiry with the elapsed wait"
 * is asserted through the real `auditAppendPlan`: the real event-type rules, the real
 * stage-requires-an-outcome rule, the real payload sanitiser and the real
 * millisecond-timestamp rule. A stub sink would have accepted a draft the database rejects.
 *
 * What is pinned:
 *
 * 1. **The boundary is strictly after the deadline**, to the millisecond, and it is the same
 *    boundary task 23.1 and `checks.ts` apply to a late decision (Requirement 5.16).
 * 2. **The elapsed wait is a measured duration**, in integer milliseconds, computed from the
 *    row's own instants — and no monetary value passes through it.
 * 3. **The query-time check and the sweep expire identically**, because the sweep is the
 *    check in a loop.
 * 4. **Every refusal writes nothing and appends nothing**, including the racing-decision case
 *    where the guarded transition declines.
 * 5. **Execution is withheld permanently**, structurally: `expired` has no transition to
 *    `authorized`, so a second expiry, an approval and an execution are all refused.
 * 6. **The statements** are asserted textually: the state literals, the guards that carry the
 *    whole of 5.16's condition, and the deadline written with the state that starts the
 *    window.
 */

import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  type AuditEvent,
  type AuditEventAppendParams,
  type AuditEventStore,
  createAuditService,
} from '@/audit/audit-service';
import type { Actor, TenantId } from '@/config/configuration-service';
import { PROPOSAL_STATES, type ProposalState } from '@/policy/checks';

import { ActionServiceError, USER_DECIDABLE_STATES } from './action-service';
import { EXECUTABLE_STATES, PROPOSAL_EXECUTED_SQL } from './execute-authorized';
import {
  APPROVAL_WINDOW_FROM_STATES,
  approvalDeadlineFrom,
  approvalWindowElapsed,
  createApprovalWindowExpiry,
  elapsedWaitFor,
  EXPIRABLE_STATES,
  expireIfOverdue,
  expireOverdueProposals,
  expiryRefusalFor,
  HOUR_MS,
  NOT_EXPIRED_REASONS,
  OVERDUE_PROPOSALS_SQL,
  PROPOSAL_AWAITING_APPROVAL_SQL,
  PROPOSAL_EXPIRED_EVENT_TYPE,
  PROPOSAL_EXPIRED_SQL,
  PROPOSAL_EXPIRY_LOAD_SQL,
  proposalAwaitingApprovalParams,
  proposalExpiredEvent,
  proposalExpiredParams,
  type ApprovalWindowStore,
  type ExpiryDeps,
  type ProposalExpirySnapshot,
} from './expire-approval-window';

const TENANT: TenantId = '11111111-1111-4111-8111-111111111111';
const PROPOSAL_ID = '22222222-2222-4222-8222-222222222222';
/** The Proposal was created here, entered `awaiting_approval`, and was never answered. */
const CREATED_AT = '2026-03-01T00:00:00.000Z';
/** A 24-hour Approval_Window from `CREATED_AT` (Requirement 5.16's default). */
const DEADLINE = '2026-03-02T00:00:00.000Z';
/** One second past the deadline: the earliest a query-time check could expire it. */
const EXPIRED_AT = '2026-03-02T00:00:01.000Z';

const SWEEP_ACTOR: Actor = { kind: 'policy_engine', id: 'financeos_action_service_sweep' };

/* -------------------------------------------------------------------------- */
/* The world                                                                  */
/* -------------------------------------------------------------------------- */

/** `proposals`, in the three columns an expiry reads and the one it writes. */
interface Row {
  state: ProposalState;
  approval_deadline: string | null;
  created_at: string;
}

interface World {
  readonly deps: ExpiryDeps;
  readonly rows: Map<string, Row>;
  /** Every append, in order, exactly as the real Audit_Service produced it. */
  readonly events: AuditEvent[];
  /** Every store write attempt, so "wrote nothing" is assertable. */
  readonly writes: string[];
}

/** An `AuditEventStore` that stores what `app.append_audit_event` would return. */
function memoryAuditStore(events: AuditEvent[]): AuditEventStore {
  let sequence = 0n;
  let previous = '0'.repeat(64);
  return {
    append(params: AuditEventAppendParams): Promise<AuditEvent> {
      sequence += 1n;
      const chain = createHash('sha256').update(`${sequence}|${params.join('|')}`).digest('hex');
      const stored: AuditEvent = {
        id: randomUUID(),
        tenant_id: TENANT,
        sequence_number: sequence,
        event_type: params[0],
        stage: params[3],
        outcome: params[4],
        actor_kind: params[1],
        actor_id: params[2],
        proposal_id: params[5],
        source_record_refs: JSON.parse(params[6]) as never,
        payload: JSON.parse(params[7]) as Record<string, unknown>,
        payload_reduced: false,
        payload_bytes: params[7].length,
        occurred_at: params[8],
        chain_value: chain,
        prev_chain_value: previous,
      };
      previous = chain;
      events.push(stored);
      return Promise.resolve(stored);
    },
  };
}

function world(
  options: {
    readonly rows?: readonly (Row & { readonly id: string })[];
    readonly at?: string;
    /** Make the guarded transition decline, as a racing decision would. */
    readonly declineTransition?: boolean;
  } = {},
): World {
  const rows = new Map<string, Row>();
  for (const row of options.rows ?? [
    { id: PROPOSAL_ID, state: 'awaiting_approval', approval_deadline: DEADLINE, created_at: CREATED_AT },
  ]) {
    rows.set(row.id, {
      state: row.state,
      approval_deadline: row.approval_deadline,
      created_at: row.created_at,
    });
  }
  const events: AuditEvent[] = [];
  const writes: string[] = [];

  const snapshotOf = (id: string, row: Row): ProposalExpirySnapshot => ({
    proposal_id: id,
    state: row.state,
    approval_deadline: row.approval_deadline,
    created_at: row.created_at,
  });

  const store: ApprovalWindowStore = {
    loadForExpiry(proposalId) {
      const row = rows.get(proposalId);
      return Promise.resolve(row === undefined ? null : snapshotOf(proposalId, row));
    },
    overdueProposals(at, limit) {
      // Exactly OVERDUE_PROPOSALS_SQL's predicate, ordering and bound.
      const candidates = [...rows.entries()]
        .filter(
          ([, row]) =>
            row.state === 'awaiting_approval' &&
            row.approval_deadline !== null &&
            Date.parse(row.approval_deadline) < Date.parse(at),
        )
        .sort(([aId, a], [bId, b]) =>
          a.approval_deadline === b.approval_deadline
            ? aId.localeCompare(bId)
            : (a.approval_deadline ?? '').localeCompare(b.approval_deadline ?? ''),
        )
        .slice(0, limit)
        .map(([id, row]) => snapshotOf(id, row));
      return Promise.resolve(candidates);
    },
    markExpired(proposalId, expiredAt) {
      writes.push(`markExpired(${proposalId})`);
      const row = rows.get(proposalId);
      // The guard, verbatim: the state, a deadline that exists, and a deadline in the past.
      if (
        options.declineTransition === true ||
        row === undefined ||
        row.state !== 'awaiting_approval' ||
        row.approval_deadline === null ||
        Date.parse(row.approval_deadline) >= Date.parse(expiredAt)
      ) {
        return Promise.resolve(false);
      }
      row.state = 'expired';
      return Promise.resolve(true);
    },
  };

  return {
    rows,
    events,
    writes,
    deps: {
      store,
      audit: createAuditService({ store: memoryAuditStore(events) }),
      actor: SWEEP_ACTOR,
      now: () => new Date(options.at ?? EXPIRED_AT),
    },
  };
}

const snapshot = (over: Partial<ProposalExpirySnapshot> = {}): ProposalExpirySnapshot => ({
  proposal_id: PROPOSAL_ID,
  state: 'awaiting_approval',
  approval_deadline: DEADLINE,
  created_at: CREATED_AT,
  ...over,
});

/* -------------------------------------------------------------------------- */
/* The boundary and the deadline — pure                                       */
/* -------------------------------------------------------------------------- */

describe('the Approval_Window boundary', () => {
  it('is strictly after the deadline, to the millisecond', () => {
    // Requirement 5.16 expires a Proposal that received no decision WITHIN the window, so a
    // check landing exactly on the deadline is still inside it. Task 23.1's `refusalFor` draws
    // the same line for a late decision (`at > deadline`), and `checks.ts` for a recorded
    // approval — one boundary, three modules.
    expect(approvalWindowElapsed(DEADLINE, new Date(DEADLINE))).toBe(false);
    expect(approvalWindowElapsed(DEADLINE, new Date(Date.parse(DEADLINE) - 1))).toBe(false);
    expect(approvalWindowElapsed(DEADLINE, new Date(Date.parse(DEADLINE) + 1))).toBe(true);
  });

  it('raises for a deadline that is not an instant rather than guessing', () => {
    expect(() => approvalWindowElapsed('not-a-date', new Date(EXPIRED_AT))).toThrowError(
      ActionServiceError,
    );
  });
});

describe('approvalDeadlineFrom', () => {
  it('adds the configured window to the start instant', () => {
    expect(approvalDeadlineFrom(24, new Date(CREATED_AT))).toBe(DEADLINE);
    expect(approvalDeadlineFrom(1, new Date(CREATED_AT))).toBe('2026-03-01T01:00:00.000Z');
    expect(approvalDeadlineFrom(168, new Date(CREATED_AT))).toBe('2026-03-08T00:00:00.000Z');
    expect(Date.parse(approvalDeadlineFrom(168, new Date(CREATED_AT))) - Date.parse(CREATED_AT)).toBe(
      168 * HOUR_MS,
    );
  });

  it('refuses a window outside 1..168 hours instead of defaulting a second time', () => {
    // The default of 24 is the Configuration_Service's (`approval_window_hours`, default 24).
    // An unlawful value here is a caller fault, and substituting one would hide it.
    for (const hours of [0, -1, 169, 24.5, Number.NaN]) {
      expect(() => approvalDeadlineFrom(hours, new Date(CREATED_AT)), `${hours} h`).toThrowError(
        ActionServiceError,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The elapsed wait — pure                                                    */
/* -------------------------------------------------------------------------- */

describe('the elapsed wait', () => {
  it('is measured between the row\u2019s own instants, in integer milliseconds', () => {
    const elapsed = elapsedWaitFor(snapshot(), EXPIRED_AT);

    expect(elapsed).toEqual({
      awaited_since: CREATED_AT,
      approval_deadline: DEADLINE,
      expired_at: EXPIRED_AT,
      // 24 h of window plus the second the check was late.
      elapsed_wait_ms: 24 * HOUR_MS + 1000,
      overdue_ms: 1000,
    });
    expect(Number.isSafeInteger(elapsed.elapsed_wait_ms)).toBe(true);
    expect(Number.isSafeInteger(elapsed.overdue_ms)).toBe(true);
  });

  it('reports a clock that moved backwards rather than absorbing it', () => {
    // An expiry cannot precede the Proposal it expires, and a negative "wait" is a figure
    // nobody waited.
    expect(() => elapsedWaitFor(snapshot(), CREATED_AT)).toThrowError(ActionServiceError);
    expect(() =>
      elapsedWaitFor(snapshot({ created_at: '2026-03-05T00:00:00.000Z' }), EXPIRED_AT),
    ).toThrowError(ActionServiceError);
  });
});

/* -------------------------------------------------------------------------- */
/* The query-time check (thin slice 1)                                        */
/* -------------------------------------------------------------------------- */

describe('the query-time expiry check', () => {
  it('marks the Proposal expired and appends the Audit_Event with the elapsed wait', async () => {
    const w = world();

    const outcome = await expireIfOverdue(PROPOSAL_ID, w.deps);

    expect(outcome.kind).toBe('expired');
    expect(w.rows.get(PROPOSAL_ID)?.state).toBe('expired');
    expect(w.events).toHaveLength(1);

    const event = w.events[0];
    // design.md's error table: "Audit_Event `proposal_expired` with the elapsed wait time".
    expect(event?.event_type).toBe(PROPOSAL_EXPIRED_EVENT_TYPE);
    expect(event?.proposal_id).toBe(PROPOSAL_ID);
    // An expiry completes no Action_Pipeline stage, so it is a non-stage event.
    expect(event?.stage).toBeNull();
    expect(event?.outcome).toBeNull();
    expect(event?.occurred_at).toBe('2026-03-02T00:00:01.000Z');
    expect(event?.payload).toMatchObject({
      proposal_state: 'expired',
      awaited_since: CREATED_AT,
      approval_deadline: DEADLINE,
      expired_at: EXPIRED_AT,
      elapsed_wait_ms: 24 * HOUR_MS + 1000,
      overdue_ms: 1000,
      execution_withheld: 'permanently',
    });
    if (outcome.kind === 'expired') {
      // The sequence number is returned as proof the record exists, not as a claim that it does.
      expect(outcome.audit_sequence_number).toBe(event?.sequence_number);
      expect(outcome.elapsed_wait.elapsed_wait_ms).toBe(24 * HOUR_MS + 1000);
    }
  });

  it('puts no monetary value through the expiry', () => {
    // The elapsed wait is a duration. Nothing here is money, so nothing here goes through
    // `Paise`, `toWire` or the `paise` domain (Requirement 15.1).
    const payload = proposalExpiredEvent(PROPOSAL_ID, elapsedWaitFor(snapshot(), EXPIRED_AT), SWEEP_ACTOR)
      .payload;

    expect(Object.keys(payload).filter((key) => key.includes('paise'))).toEqual([]);
    expect(Object.values(payload).some((value) => typeof value === 'bigint')).toBe(false);
    // Neither statement that reads a Proposal selects a monetary column.
    expect(PROPOSAL_EXPIRY_LOAD_SQL).not.toContain('paise');
    expect(OVERDUE_PROPOSALS_SQL).not.toContain('paise');
    expect(PROPOSAL_EXPIRED_SQL).not.toContain('paise');
  });

  it('withholds the expiry while the Approval_Window is still running', async () => {
    const w = world({ at: '2026-03-01T23:59:59.999Z' });

    const outcome = await expireIfOverdue(PROPOSAL_ID, w.deps);

    expect(outcome.kind).toBe('not_expired');
    if (outcome.kind === 'not_expired') {
      expect(outcome.reason).toBe('within_approval_window');
      expect(outcome.remaining_ms).toBe(1);
    }
    expect(w.rows.get(PROPOSAL_ID)?.state).toBe('awaiting_approval');
    expect(w.writes).toEqual([]);
    expect(w.events).toEqual([]);
  });

  it('refuses every state that holds no require-approval decision, writing nothing', async () => {
    for (const state of PROPOSAL_STATES.filter((s) => !EXPIRABLE_STATES.includes(s))) {
      const w = world({
        rows: [{ id: PROPOSAL_ID, state, approval_deadline: DEADLINE, created_at: CREATED_AT }],
      });

      const outcome = await expireIfOverdue(PROPOSAL_ID, w.deps);

      expect(outcome.kind, state).toBe('not_expired');
      if (outcome.kind === 'not_expired') {
        expect(outcome.reason, state).toBe('not_awaiting_approval');
        expect(outcome.state, state).toBe(state);
      }
      expect(w.rows.get(PROPOSAL_ID)?.state, state).toBe(state);
      expect(w.writes, state).toEqual([]);
      expect(w.events, state).toEqual([]);
    }
  });

  it('cannot expire an awaiting_approval Proposal with no deadline, and says so', async () => {
    // Task 23.1's FINDING 4: such a row can be neither decided nor expired. The pairing in
    // PROPOSAL_AWAITING_APPROVAL_SQL exists so it cannot be created in the first place.
    const w = world({
      rows: [
        { id: PROPOSAL_ID, state: 'awaiting_approval', approval_deadline: null, created_at: CREATED_AT },
      ],
    });

    const outcome = await expireIfOverdue(PROPOSAL_ID, w.deps);

    expect(outcome.kind).toBe('not_expired');
    if (outcome.kind === 'not_expired') {
      expect(outcome.reason).toBe('approval_deadline_absent');
    }
    expect(w.writes).toEqual([]);
    expect(w.events).toEqual([]);
  });

  it('treats a foreign or unknown Proposal as absent', async () => {
    const w = world();

    const outcome = await expireIfOverdue('33333333-3333-4333-8333-333333333333', w.deps);

    expect(outcome.kind).toBe('not_expired');
    if (outcome.kind === 'not_expired') {
      expect(outcome.reason).toBe('proposal_absent');
    }
    expect(w.events).toEqual([]);
  });

  it('appends no Audit_Event when a racing decision wins the guard', async () => {
    // The reason the transition comes first: an Audit_Event cannot be retracted, so an event
    // asserting an expiry that did not happen would be permanent.
    const w = world({ declineTransition: true });

    const outcome = await expireIfOverdue(PROPOSAL_ID, w.deps);

    expect(outcome.kind).toBe('not_expired');
    if (outcome.kind === 'not_expired') {
      expect(outcome.reason).toBe('decided_concurrently');
    }
    expect(w.writes).toEqual([`markExpired(${PROPOSAL_ID})`]);
    expect(w.events).toEqual([]);
  });

  it('raises for a corrupt stored state rather than reporting a verdict', () => {
    expect(() =>
      expiryRefusalFor(snapshot({ state: 'gone' as ProposalState }), new Date(EXPIRED_AT)),
    ).toThrowError(ActionServiceError);
  });

  it('names every refusal reason it can return', () => {
    expect([...NOT_EXPIRED_REASONS]).toEqual([
      'proposal_absent',
      'not_awaiting_approval',
      'approval_deadline_absent',
      'within_approval_window',
      'decided_concurrently',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Permanence (Requirement 5.16's second clause)                              */
/* -------------------------------------------------------------------------- */

describe('execution is withheld permanently', () => {
  it('has no transition out of expired, so a second expiry and an execution are both refused', async () => {
    const w = world();

    await expireIfOverdue(PROPOSAL_ID, w.deps);
    const second = await expireIfOverdue(PROPOSAL_ID, w.deps);

    // One condition, one Audit_Event, one recorded wait.
    expect(w.events).toHaveLength(1);
    expect(second.kind).toBe('not_expired');
    if (second.kind === 'not_expired') {
      expect(second.reason).toBe('not_awaiting_approval');
    }

    // Structural, not asserted by re-checking `expired` anywhere in this module:
    // `authorized` is the only executable state, and the only way into it is an approval,
    // which is admissible only from `awaiting_approval`.
    expect(EXECUTABLE_STATES).toEqual(['authorized']);
    expect(EXECUTABLE_STATES).not.toContain('expired');
    expect(USER_DECIDABLE_STATES).toEqual(['awaiting_approval']);
    expect(PROPOSAL_EXECUTED_SQL).toContain("AND state = 'authorized'");
  });
});

/* -------------------------------------------------------------------------- */
/* The sweep (thin slice 2)                                                   */
/* -------------------------------------------------------------------------- */

describe('the scheduled sweep', () => {
  const OLDER = '44444444-4444-4444-8444-444444444444';
  const NEWER = '55555555-5555-4555-8555-555555555555';
  const INSIDE = '66666666-6666-4666-8666-666666666666';

  const backlog = [
    {
      id: NEWER,
      state: 'awaiting_approval' as ProposalState,
      approval_deadline: '2026-03-01T23:00:00.000Z',
      created_at: CREATED_AT,
    },
    {
      id: OLDER,
      state: 'awaiting_approval' as ProposalState,
      approval_deadline: '2026-03-01T12:00:00.000Z',
      created_at: CREATED_AT,
    },
    {
      id: INSIDE,
      state: 'awaiting_approval' as ProposalState,
      approval_deadline: '2026-03-03T00:00:00.000Z',
      created_at: CREATED_AT,
    },
  ];

  it('expires the overdue Proposals oldest deadline first and leaves the rest alone', async () => {
    const w = world({ rows: backlog });

    const expired = await expireOverdueProposals(w.deps);

    expect(expired).toEqual([OLDER, NEWER]);
    expect(w.rows.get(OLDER)?.state).toBe('expired');
    expect(w.rows.get(NEWER)?.state).toBe('expired');
    // Still inside its window: the decision is still the User's.
    expect(w.rows.get(INSIDE)?.state).toBe('awaiting_approval');
    expect(w.events.map((e) => e.proposal_id)).toEqual([OLDER, NEWER]);
    // Each expiry records its own wait, measured to the same instant of expiry.
    expect(w.events.map((e) => e.payload.overdue_ms)).toEqual([
      12 * HOUR_MS + 1000,
      HOUR_MS + 1000,
    ]);
  });

  it('bounds one pass, and the predicate is self-clearing so a backlog drains over passes', async () => {
    const w = world({ rows: backlog });

    expect(await expireOverdueProposals(w.deps, 1)).toEqual([OLDER]);
    expect(await expireOverdueProposals(w.deps, 1)).toEqual([NEWER]);
    expect(await expireOverdueProposals(w.deps, 1)).toEqual([]);
    expect(w.events).toHaveLength(2);
  });

  it('skips a candidate whose guard declines rather than recording an expiry', async () => {
    const w = world({ rows: backlog, declineTransition: true });

    expect(await expireOverdueProposals(w.deps)).toEqual([]);
    expect(w.events).toEqual([]);
    expect(w.rows.get(OLDER)?.state).toBe('awaiting_approval');
  });

  it('refuses a batch bound that is not a positive integer', async () => {
    const w = world();

    await expect(expireOverdueProposals(w.deps, 0)).rejects.toThrowError(ActionServiceError);
    await expect(expireOverdueProposals(w.deps, 1.5)).rejects.toThrowError(ActionServiceError);
  });

  it('exposes design.md\u2019s two entry points over one bound dependency set', async () => {
    const w = world({ rows: backlog });
    const expiry = createApprovalWindowExpiry(w.deps);

    expect(await expiry.expireIfOverdue(INSIDE)).toMatchObject({ reason: 'within_approval_window' });
    expect(await expiry.expireOverdue()).toEqual([OLDER, NEWER]);
  });
});

/* -------------------------------------------------------------------------- */
/* The statements                                                             */
/* -------------------------------------------------------------------------- */

describe('the statements an adapter runs', () => {
  it('puts the whole of Requirement 5.16\u2019s condition in the expiry guard', () => {
    // The state is a literal, so this statement cannot be bent into another transition; the
    // guard carries the state AND the deadline, so a Proposal inside its window cannot be
    // expired through it even by a caller that miscomputed the boundary.
    expect(PROPOSAL_EXPIRED_SQL).toContain("SET state = 'expired'");
    expect(PROPOSAL_EXPIRED_SQL).toContain("AND state = 'awaiting_approval'");
    expect(PROPOSAL_EXPIRED_SQL).toContain('AND approval_deadline IS NOT NULL');
    expect(PROPOSAL_EXPIRED_SQL).toContain('AND approval_deadline < $3::timestamptz');
    expect(PROPOSAL_EXPIRED_SQL).toContain('RETURNING id, state, approval_deadline');
    // Nothing else is written: no executed_at, no figures, nothing applied.
    expect(PROPOSAL_EXPIRED_SQL).not.toContain('executed_at');
    expect(proposalExpiredParams(TENANT, PROPOSAL_ID, EXPIRED_AT)).toEqual([
      TENANT,
      PROPOSAL_ID,
      EXPIRED_AT,
    ]);
  });

  it('writes the deadline in the same update as the state that starts the window', () => {
    // The other half of this task: nothing wrote `approval_deadline` before, and an
    // `awaiting_approval` row without one is unanswerable.
    expect(PROPOSAL_AWAITING_APPROVAL_SQL).toContain("SET state = 'awaiting_approval'");
    expect(PROPOSAL_AWAITING_APPROVAL_SQL).toContain('approval_deadline = $3::timestamptz');
    expect(PROPOSAL_AWAITING_APPROVAL_SQL).toContain('AND state = ANY($4::proposal_state[])');
    expect(APPROVAL_WINDOW_FROM_STATES).toEqual(['proposed', 'blocked']);
    expect(
      proposalAwaitingApprovalParams(TENANT, PROPOSAL_ID, DEADLINE),
    ).toEqual([TENANT, PROPOSAL_ID, DEADLINE, ['proposed', 'blocked']]);
  });

  it('selects the candidates by the same predicate, ordered and bounded', () => {
    expect(OVERDUE_PROPOSALS_SQL).toContain("AND state = 'awaiting_approval'");
    expect(OVERDUE_PROPOSALS_SQL).toContain('AND approval_deadline < $2::timestamptz');
    expect(OVERDUE_PROPOSALS_SQL).toContain('ORDER BY approval_deadline, id');
    expect(OVERDUE_PROPOSALS_SQL).toContain('LIMIT $3');
    // The candidate list is advisory, so it takes no row locks.
    expect(OVERDUE_PROPOSALS_SQL).not.toContain('FOR UPDATE');
  });

  it('scopes every statement on the session Tenant and takes no Tenant argument', () => {
    for (const sql of [
      PROPOSAL_EXPIRY_LOAD_SQL,
      OVERDUE_PROPOSALS_SQL,
      PROPOSAL_EXPIRED_SQL,
      PROPOSAL_AWAITING_APPROVAL_SQL,
    ]) {
      expect(sql).toContain('tenant_id = $1');
    }
  });
});
