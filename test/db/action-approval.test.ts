/**
 * The Action_Service's approval and rejection writes, against Supabase local (task 23.1).
 * Requirements 5.8, 5.9, 5.10, 5.14.
 *
 * `src/action/action-service.ts` exports three statements and no adapter — `proposals`
 * and `authorizations` are RLS `ENABLE`d and `FORCE`d with no policies until task 26.1,
 * and no Postgres driver can be added (see `pg.ts`). This file stands in for the
 * adapter: it runs the **exact exported strings** through `PREPARE` / `EXECUTE`, so
 * Postgres plans them against the live schema and a wrong column name, a bad cast or a
 * CHECK violation fails here rather than at 26.1.
 *
 * | Claim | Mechanism | Requirement |
 * |---|---|---|
 * | an approval records the User, the Proposal and the timestamp | `USER_AUTHORIZATION_SQL` | 5.9 |
 * | a rejection records the same three values | the same statement, `$4 = 'rejected'` | 5.10 |
 * | the statement cannot write a User row with no User | the `authorizations` CHECK | 5.9, 5.10 |
 * | `awaiting_approval` → `authorized` / `rejected` / `blocked` | `PROPOSAL_STATE_TRANSITION_SQL` | 5.5, 5.9, 5.10 |
 * | a Proposal that moved on matches no row | the `$4` state guard, zero rows | 5.8 |
 * | `impact_paise` crosses as a decimal string | `ACTION_PROPOSAL_LOAD_SQL` | 15.1, 15.8 |
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  ACTION_PROPOSAL_LOAD_SQL,
  actionProposalLoadParams,
  PROPOSAL_STATE_TRANSITION_SQL,
  proposalStateTransitionParams,
  USER_AUTHORIZATION_SQL,
  USER_DECIDABLE_STATES,
  userAuthorizationParams,
} from '@/action/action-service';

import { database, jsonAt, jsonRows, lit, newFixture, provision, rolledBack, runScript } from './pg';

const CHECK_VIOLATION = '23514';

const DECIDED_AT = '2026-03-01T00:00:00.000Z';
const DEADLINE = '2026-03-02T00:00:00.000Z';
/** ₹3,82,000 in paise, as the decimal string the money wire contract requires. */
const IMPACT_PAISE = '38200000';

const PREPARE_ALL = [
  `prepare action_proposal_load as\n${ACTION_PROPOSAL_LOAD_SQL};`,
  `prepare user_authorization as\n${USER_AUTHORIZATION_SQL};`,
  `prepare proposal_state_transition as\n${PROPOSAL_STATE_TRANSITION_SQL};`,
].join('\n');

const execute = (name: string, params: readonly (string | null)[]): string =>
  `execute ${name}(${params.map((p) => (p === null ? 'null' : lit(p))).join(', ')});`;

/** A `proposal_state[]` literal, so `$4::proposal_state[]` gets a real array. */
const stateArray = (states: readonly string[]): string => `{${states.join(',')}}`;

/** A Tenant, a User, an Evidence_Chain and one `awaiting_approval` Proposal. */
function fixtureSql(state = 'awaiting_approval'): {
  sql: string;
  tenantId: string;
  userId: string;
  proposalId: string;
} {
  const f = newFixture();
  const chainId = randomUUID();
  const proposalId = randomUUID();
  return {
    tenantId: f.tenantId,
    userId: f.userId,
    proposalId,
    sql: `${provision(f)}
      insert into evidence_chains (id, tenant_id, figure_paise, source_count, as_of, produced_by)
      values (${lit(chainId)}, ${lit(f.tenantId)}, ${IMPACT_PAISE}, 1, now(), 'action_approval_test');
      insert into proposals
        (id, tenant_id, agent_name, action_type, target_source_records, target_fingerprint,
         impact_paise, evidence_chain_id, expected_outcome, state, approval_deadline)
      values (${lit(proposalId)}, ${lit(f.tenantId)}, 'reconciliation_agent',
        'post_reconciliation_adjustment', '[{"type":"settlement","id":"setl_1"}]'::jsonb,
        'post_reconciliation_adjustment|settlement:setl_1', ${IMPACT_PAISE}, ${lit(chainId)},
        '{"status":"adjusted"}'::jsonb, ${lit(state)}, ${lit(DEADLINE)}::timestamptz);`,
  };
}

describe.skipIf(!database().reachable)('the Action_Service approval writes', () => {
  it('records an approval carrying the User, the Proposal and the decision timestamp', () => {
    const f = fixtureSql();
    const params = userAuthorizationParams(f.tenantId, {
      proposal_id: f.proposalId,
      user_id: f.userId,
      decision: 'approved',
      decided_at: DECIDED_AT,
    });

    const r = runScript(
      rolledBack(
        [
          f.sql,
          PREPARE_ALL,
          execute('user_authorization', [...params]),
          jsonRows(`select actor_kind, decision,
              actor_user_id = ${lit(f.userId)} as names_the_user,
              proposal_id = ${lit(f.proposalId)} as names_the_proposal,
              decided_at = ${lit(DECIDED_AT)}::timestamptz as stamped_as_passed
            from authorizations where proposal_id = ${lit(f.proposalId)}`),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 1)).toEqual([
      {
        actor_kind: 'user',
        decision: 'approved',
        names_the_user: true,
        names_the_proposal: true,
        stamped_as_passed: true,
      },
    ]);
  });

  it('records a rejection through the same statement, with only the decision differing', () => {
    const f = fixtureSql();
    const params = userAuthorizationParams(f.tenantId, {
      proposal_id: f.proposalId,
      user_id: f.userId,
      decision: 'rejected',
      decided_at: DECIDED_AT,
    });

    const r = runScript(
      rolledBack(
        [
          f.sql,
          PREPARE_ALL,
          execute('user_authorization', [...params]),
          execute(
            'proposal_state_transition',
            [
              f.tenantId,
              f.proposalId,
              'rejected',
              stateArray([...USER_DECIDABLE_STATES]),
            ],
          ),
          jsonRows(`select a.decision, a.actor_kind, p.state
            from authorizations a
            join proposals p on p.id = a.proposal_id
           where a.proposal_id = ${lit(f.proposalId)}`),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 2)).toEqual([
      { decision: 'rejected', actor_kind: 'user', state: 'rejected' },
    ]);
  });

  it('moves awaiting_approval to authorized, and blocked on a blocked resubmission', () => {
    for (const to of ['authorized', 'blocked'] as const) {
      const f = fixtureSql();
      const params = proposalStateTransitionParams(
        f.tenantId,
        f.proposalId,
        to,
        USER_DECIDABLE_STATES,
      );

      const r = runScript(
        rolledBack(
          [
            f.sql,
            PREPARE_ALL,
            execute('proposal_state_transition', [
              params[0],
              params[1],
              params[2],
              stateArray([...params[3]]),
            ]),
            jsonRows(`select state from proposals where id = ${lit(f.proposalId)}`),
          ].join('\n'),
        ),
      );

      expect(r.errors, r.rawErr).toEqual([]);
      // `RETURNING id, state` emitted a line, so the update matched.
      expect(r.out, to).toHaveLength(2);
      expect(jsonAt<readonly Record<string, unknown>[]>(r, 1)).toEqual([{ state: to }]);
    }
  });

  it('matches no row once the Proposal has left awaiting_approval', () => {
    // Requirement 5.8's other half at the storage layer: two Users deciding at once both
    // write an Authorization, but only the first transition matches a row. An adapter must
    // treat zero rows as a failed transition rather than a silent success.
    const f = fixtureSql('executed');
    const params = proposalStateTransitionParams(
      f.tenantId,
      f.proposalId,
      'authorized',
      USER_DECIDABLE_STATES,
    );

    const r = runScript(
      rolledBack(
        [
          f.sql,
          PREPARE_ALL,
          execute('proposal_state_transition', [
            params[0],
            params[1],
            params[2],
            stateArray([...params[3]]),
          ]),
          jsonRows(`select state from proposals where id = ${lit(f.proposalId)}`),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    expect(r.out).toHaveLength(1);
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 0)).toEqual([{ state: 'executed' }]);
  });

  it('reads the Proposal back with impact_paise as a decimal string', () => {
    const f = fixtureSql();
    const params = actionProposalLoadParams(f.tenantId, f.proposalId);

    const r = runScript(
      rolledBack(
        [
          f.sql,
          PREPARE_ALL,
          jsonRows(`select impact_paise, state, approval_deadline, expected_outcome
            from (${ACTION_PROPOSAL_LOAD_SQL.replace('$1', lit(params[0])).replace(
              '$2',
              lit(params[1]),
            )}) loaded`),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    const [row] = jsonAt<readonly Record<string, unknown>[]>(r, 0);
    // A string, not a JSON number: `paise` is BIGINT and any parser that reads it as a
    // number coerces it to an IEEE-754 double (Requirement 15.1, 15.8).
    expect(row?.impact_paise).toBe(IMPACT_PAISE);
    expect(typeof row?.impact_paise).toBe('string');
    expect(row?.state).toBe('awaiting_approval');
    expect(row?.expected_outcome).toEqual({ status: 'adjusted' });
  });

  it('cannot be bent into a Policy_Engine row: the actor CHECK forbids the mismatch', () => {
    // Belt-and-braces on the statement's literal `'user'`. The CHECK is
    // `(actor_kind = 'user') = (actor_user_id IS NOT NULL)`, so a `user` row with no User
    // is rejected by the database as well as unreachable through the exported statement.
    const f = fixtureSql();
    const r = runScript(
      rolledBack(`${f.sql}
        insert into authorizations (tenant_id, proposal_id, actor_kind, actor_user_id, decision)
        values (${lit(f.tenantId)}, ${lit(f.proposalId)}, 'user', null, 'approved');`),
    );
    expect(r.errors, r.rawErr).toHaveLength(1);
    expect(r.errors[0]?.sqlstate).toBe(CHECK_VIOLATION);
  });
});
