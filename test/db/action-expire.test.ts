/**
 * The Action_Service's Approval_Window statements, against Supabase local (task 23.5).
 * Requirement 5.16.
 *
 * Same standing as `./action-approval.test.ts`, `./action-execute.test.ts` and
 * `./action-verify.test.ts`, and for the same reason: `src/action/expire-approval-window.ts`
 * exports four statements and no adapter, because a Postgres driver cannot be added (see
 * `pg.ts`). This file stands in for the adapter and runs the **exact exported strings**
 * through `PREPARE` / `EXECUTE`, so Postgres plans them against the live schema.
 *
 * | Claim | Mechanism | Requirement |
 * |---|---|---|
 * | the state, the deadline and `created_at` load together | `PROPOSAL_EXPIRY_LOAD_SQL` | 5.16 |
 * | `awaiting_approval` past its deadline → `expired`, and nothing else is written | `PROPOSAL_EXPIRED_SQL` | 5.16 |
 * | a Proposal still inside its window matches no row | `AND approval_deadline < $3` | 5.16 |
 * | no other state and no NULL deadline can be expired | the state and NOT NULL guards | 5.16 |
 * | the sweep sees only overdue Proposals, oldest deadline first, bounded | `OVERDUE_PROPOSALS_SQL` | 5.16 |
 * | the state that starts the window and the deadline are written together | `PROPOSAL_AWAITING_APPROVAL_SQL` | 5.16 |
 * | the expiry Audit_Event appends as a **non-stage** event carrying the elapsed wait | `AUDIT_EVENT_APPEND_SQL` | 5.16, 13.1 |
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  OVERDUE_PROPOSALS_SQL,
  PROPOSAL_AWAITING_APPROVAL_SQL,
  PROPOSAL_EXPIRED_SQL,
  PROPOSAL_EXPIRY_LOAD_SQL,
  elapsedWaitFor,
  proposalExpiredEvent,
} from '@/action/expire-approval-window';
import { AUDIT_EVENT_APPEND_SQL, auditEventAppendParams } from '@/audit/audit-service';

import { database, jsonAt, jsonRows, lit, newFixture, provision, rolledBack, runScript } from './pg';

const CREATED_AT = '2026-03-01T00:00:00.000Z';
/** A 24-hour Approval_Window from `CREATED_AT` (Requirement 5.16's default). */
const DEADLINE = '2026-03-02T00:00:00.000Z';
/** One second past the deadline. */
const EXPIRED_AT = '2026-03-02T00:00:01.000Z';
/** ₹3,82,000 in paise, as the decimal string the money wire contract requires. */
const IMPACT_PAISE = '38200000';
const EXPECTED_OUTCOME = `{"paise":"${IMPACT_PAISE}"}`;

const prepared = (name: string, sql: string): string => `prepare ${name} as\n${sql};`;

const execute = (name: string, params: readonly (string | null)[]): string =>
  `execute ${name}(${params.map((p) => (p === null ? 'null' : lit(p))).join(', ')});`;

const PREPARE_ALL = [
  prepared('proposal_expiry_load', PROPOSAL_EXPIRY_LOAD_SQL),
  prepared('overdue_proposals', OVERDUE_PROPOSALS_SQL),
  prepared('proposal_expired', PROPOSAL_EXPIRED_SQL),
  prepared('proposal_awaiting_approval', PROPOSAL_AWAITING_APPROVAL_SQL),
  prepared('audit_append', AUDIT_EVENT_APPEND_SQL),
].join('\n');

interface Candidate {
  readonly id: string;
  readonly state: string;
  readonly deadline: string | null;
  readonly createdAt?: string;
}

/** A Tenant, an Evidence_Chain and one Proposal row per candidate. */
function fixtureSql(candidates: readonly Candidate[]): { sql: string; tenantId: string } {
  const f = newFixture();
  const chainId = randomUUID();

  const rows = candidates
    .map(
      (c) => `
      insert into proposals
        (id, tenant_id, agent_name, action_type, target_source_records, target_fingerprint,
         impact_paise, evidence_chain_id, expected_outcome, state, approval_deadline, created_at)
      values (${lit(c.id)}, ${lit(f.tenantId)}, 'reconciliation_agent',
        'post_reconciliation_adjustment', '[{"type":"settlement","id":"setl_1"}]'::jsonb,
        ${lit(`post_reconciliation_adjustment|settlement:setl_1|${c.id}`)}, ${IMPACT_PAISE},
        ${lit(chainId)}, ${lit(EXPECTED_OUTCOME)}::jsonb, ${lit(c.state)},
        ${c.deadline === null ? 'null' : `${lit(c.deadline)}::timestamptz`},
        ${lit(c.createdAt ?? CREATED_AT)}::timestamptz);`,
    )
    .join('\n');

  return {
    tenantId: f.tenantId,
    sql: `${provision(f)}
      insert into evidence_chains (id, tenant_id, figure_paise, source_count, as_of, produced_by)
      values (${lit(chainId)}, ${lit(f.tenantId)}, ${IMPACT_PAISE}, 1, now(), 'action_expire_test');
      ${rows}`,
  };
}

const PROPOSAL_A = '22222222-2222-4222-8222-222222222222';
const PROPOSAL_B = '33333333-3333-4333-8333-333333333333';
const PROPOSAL_C = '44444444-4444-4444-8444-444444444444';

const awaiting = (id: string, deadline: string | null = DEADLINE): Candidate => ({
  id,
  state: 'awaiting_approval',
  deadline,
});

describe.skipIf(!database().reachable)('the Action_Service Approval_Window writes', () => {
  it('loads the state, the deadline and created_at together', () => {
    const f = fixtureSql([awaiting(PROPOSAL_A)]);

    const r = runScript(
      rolledBack(
        [
          f.sql,
          PREPARE_ALL,
          execute('proposal_expiry_load', [f.tenantId, PROPOSAL_A]),
          jsonRows(`select state,
              approval_deadline = ${lit(DEADLINE)}::timestamptz as deadline_as_written,
              created_at = ${lit(CREATED_AT)}::timestamptz as created_as_written
            from proposals where id = ${lit(PROPOSAL_A)}`),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    // The load emitted its row, so all four selected columns exist on the live table.
    expect(r.out).toHaveLength(2);
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 1)).toEqual([
      { state: 'awaiting_approval', deadline_as_written: true, created_as_written: true },
    ]);
  });

  it('moves an overdue Proposal to expired and writes nothing else', () => {
    const f = fixtureSql([awaiting(PROPOSAL_A)]);

    const r = runScript(
      rolledBack(
        [
          f.sql,
          PREPARE_ALL,
          execute('proposal_expired', [f.tenantId, PROPOSAL_A, EXPIRED_AT]),
          jsonRows(`select state,
              approval_deadline = ${lit(DEADLINE)}::timestamptz as deadline_untouched,
              executed_at is null as never_executed,
              verified_at is null as never_verified,
              observed_paise is null and difference_paise is null as no_figures
            from proposals where id = ${lit(PROPOSAL_A)}`),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    // `RETURNING id, state, approval_deadline` emitted a line, so the update matched.
    expect(r.out).toHaveLength(2);
    // The row-level form of "execution withheld": nothing was applied, so nothing is stamped.
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 1)).toEqual([
      {
        state: 'expired',
        deadline_untouched: true,
        never_executed: true,
        never_verified: true,
        no_figures: true,
      },
    ]);
  });

  it('matches no row while the Approval_Window is still running', () => {
    // The guard carries the whole of Requirement 5.16's condition, so a caller that
    // miscomputed the boundary cannot expire a Proposal whose window is still open. One
    // millisecond before the deadline is inside the window.
    const f = fixtureSql([awaiting(PROPOSAL_A)]);

    const r = runScript(
      rolledBack(
        [
          f.sql,
          PREPARE_ALL,
          execute('proposal_expired', [f.tenantId, PROPOSAL_A, '2026-03-01T23:59:59.999Z']),
          // Exactly on the deadline is also inside it: the comparison is strictly less-than.
          execute('proposal_expired', [f.tenantId, PROPOSAL_A, DEADLINE]),
          jsonRows(`select state from proposals where id = ${lit(PROPOSAL_A)}`),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    // No `RETURNING` line from either attempt: only the row count query emitted.
    expect(r.out).toHaveLength(1);
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 0)).toEqual([
      { state: 'awaiting_approval' },
    ]);
  });

  it('refuses every other state, and an awaiting Proposal with no deadline', () => {
    for (const candidate of [
      { id: PROPOSAL_A, state: 'authorized', deadline: DEADLINE },
      { id: PROPOSAL_A, state: 'executed', deadline: DEADLINE },
      { id: PROPOSAL_A, state: 'rejected', deadline: DEADLINE },
      { id: PROPOSAL_A, state: 'expired', deadline: DEADLINE },
      { id: PROPOSAL_A, state: 'proposed', deadline: DEADLINE },
      awaiting(PROPOSAL_A, null),
    ] satisfies readonly Candidate[]) {
      const f = fixtureSql([candidate]);

      const r = runScript(
        rolledBack(
          [
            f.sql,
            PREPARE_ALL,
            execute('proposal_expired', [f.tenantId, PROPOSAL_A, EXPIRED_AT]),
            jsonRows(`select state from proposals where id = ${lit(PROPOSAL_A)}`),
          ].join('\n'),
        ),
      );

      const label = `${candidate.state}/${String(candidate.deadline)}`;
      expect(r.errors, `${label}: ${r.rawErr}`).toEqual([]);
      // No `RETURNING` line: the guard declined, which the adapter reports rather than throws.
      expect(r.out, label).toHaveLength(1);
      expect(jsonAt<readonly Record<string, unknown>[]>(r, 0), label).toEqual([
        { state: candidate.state },
      ]);
    }
  });

  it('lists only the overdue Proposals, oldest deadline first, within the batch bound', () => {
    const f = fixtureSql([
      awaiting(PROPOSAL_A, '2026-03-01T23:00:00.000Z'),
      awaiting(PROPOSAL_B, '2026-03-01T12:00:00.000Z'),
      // Still inside its window, and a Proposal that was already answered.
      awaiting(PROPOSAL_C, '2026-03-03T00:00:00.000Z'),
      { id: '55555555-5555-4555-8555-555555555555', state: 'rejected', deadline: DEADLINE },
    ]);

    const r = runScript(
      rolledBack(
        [
          f.sql,
          PREPARE_ALL,
          jsonRows(
            `select id::text as id from (${OVERDUE_PROPOSALS_SQL.replace('$1', lit(f.tenantId))
              .replace('$2', lit(EXPIRED_AT))
              .replace('$3', '10')}) c`,
          ),
          jsonRows(
            `select id::text as id from (${OVERDUE_PROPOSALS_SQL.replace('$1', lit(f.tenantId))
              .replace('$2', lit(EXPIRED_AT))
              .replace('$3', '1')}) c`,
          ),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    // Oldest deadline first, so the longest-overdue Proposal is expired first.
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 0)).toEqual([
      { id: PROPOSAL_B },
      { id: PROPOSAL_A },
    ]);
    // `LIMIT $3` bounds the pass and the ordering makes the slice deterministic.
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 1)).toEqual([{ id: PROPOSAL_B }]);
  });

  it('starts the Approval_Window and its deadline in one update, from proposed only', () => {
    const f = fixtureSql([{ id: PROPOSAL_A, state: 'proposed', deadline: null }]);

    const r = runScript(
      rolledBack(
        [
          f.sql,
          PREPARE_ALL,
          execute('proposal_awaiting_approval', [
            f.tenantId,
            PROPOSAL_A,
            DEADLINE,
            '{proposed,blocked}',
          ]),
          jsonRows(`select state,
              approval_deadline = ${lit(DEADLINE)}::timestamptz as deadline_written
            from proposals where id = ${lit(PROPOSAL_A)}`),
          // An expired Proposal cannot have its window re-opened: the guard list excludes it.
          execute('proposal_expired', [f.tenantId, PROPOSAL_A, EXPIRED_AT]),
          execute('proposal_awaiting_approval', [
            f.tenantId,
            PROPOSAL_A,
            DEADLINE,
            '{proposed,blocked}',
          ]),
          jsonRows(`select state from proposals where id = ${lit(PROPOSAL_A)}`),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 1)).toEqual([
      { state: 'awaiting_approval', deadline_written: true },
    ]);
    // Lines: the first transition's RETURNING, the read, the expiry's RETURNING, the read.
    // The re-open attempt emitted nothing, so execution stays withheld permanently.
    expect(r.out).toHaveLength(4);
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 3)).toEqual([{ state: 'expired' }]);
  });

  it('appends the expiry as a non-stage Audit_Event carrying the elapsed wait', () => {
    const f = fixtureSql([awaiting(PROPOSAL_A)]);
    const elapsed = elapsedWaitFor(
      { created_at: CREATED_AT, approval_deadline: DEADLINE },
      EXPIRED_AT,
    );
    const params = auditEventAppendParams(
      proposalExpiredEvent(PROPOSAL_A, elapsed, {
        kind: 'policy_engine',
        id: 'financeos_action_service_sweep',
      }),
    );

    const r = runScript(
      rolledBack(
        [
          f.sql,
          PREPARE_ALL,
          execute('proposal_expired', [f.tenantId, PROPOSAL_A, EXPIRED_AT]),
          execute('audit_append', [...params]),
          jsonRows(`select event_type, stage, outcome, actor_kind,
              proposal_id::text as proposal_id,
              sequence_number::text as sequence_number,
              payload->>'elapsed_wait_ms' as elapsed_wait_ms,
              payload->>'overdue_ms' as overdue_ms,
              payload->>'execution_withheld' as execution_withheld,
              payload->>'approval_deadline' as approval_deadline
            from audit_events where proposal_id = ${lit(PROPOSAL_A)}`),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 2)).toEqual([
      {
        event_type: 'proposal_expired',
        // An expiry completes no Action_Pipeline stage, and `audit_events.outcome` is
        // nullable for exactly the non-stage events that have no outcome.
        stage: null,
        outcome: null,
        actor_kind: 'policy_engine',
        proposal_id: PROPOSAL_A,
        sequence_number: '1',
        // Requirement 5.16's elapsed wait: 24 h of window plus the second the sweep was late.
        elapsed_wait_ms: String(24 * 3_600_000 + 1000),
        overdue_ms: '1000',
        execution_withheld: 'permanently',
        approval_deadline: DEADLINE,
      },
    ]);
  });
});
