/**
 * The Policy_Engine's two writes, against Supabase local (task 22.2).
 * Requirements 5.4, 5.5, 5.6, 5.14.
 *
 * `src/policy/decide.ts` exports two statements and no adapter — `proposals` and
 * `authorizations` are RLS `ENABLE`d and `FORCE`d with no policies until task 26.1, and
 * no Postgres driver can be added (see `pg.ts`). This file is what stands in for the
 * adapter: it runs the **exact exported strings** through `PREPARE` / `EXECUTE`, so
 * Postgres plans them against the live schema and a wrong column name, a bad cast or a
 * CHECK violation fails here rather than at task 26.1.
 *
 * What is asserted:
 *
 * | Claim | Mechanism | Requirement |
 * |---|---|---|
 * | the gate picture, the score and the threshold persist together | `PROPOSAL_DECISION_UPDATE_SQL` | 5.4 |
 * | `policy_checks` keeps design.md's `{ id, result, detail? }` shape | read back through `->` | 5.4, 5.5 |
 * | a `block` persists with a NULL score | the same statement with a null `$4` | 5.5 |
 * | an executed Proposal's gate picture is never overwritten | zero rows returned | 5.5, FINDING 3 |
 * | the Authorization names the Policy_Engine and no User | `POLICY_ENGINE_AUTHORIZATION_SQL` | 5.6, 5.14 |
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  DECIDABLE_STATES,
  decidePolicy,
  POLICY_ENGINE_AUTHORIZATION_SQL,
  policyEngineAuthorizationParams,
  PROPOSAL_DECISION_UPDATE_SQL,
  proposalDecisionUpdateParams,
} from '@/policy/decide';
import { POLICY_CHECK_IDS, type PolicyCheckResult } from '@/policy/checks';

import { database, jsonAt, jsonRows, lit, newFixture, provision, rolledBack, runScript } from './pg';

const CHECK_VIOLATION = '23514';

/** All six passing, except any id named in `failed`. */
function checks(...failed: readonly string[]): PolicyCheckResult[] {
  return POLICY_CHECK_IDS.map((id) =>
    failed.includes(id)
      ? { id, result: 'fail', detail: `${id} failed` }
      : { id, result: 'pass' },
  );
}

const PREPARE_ALL = [
  `prepare policy_decision_update as\n${PROPOSAL_DECISION_UPDATE_SQL};`,
  `prepare policy_engine_authorization as\n${POLICY_ENGINE_AUTHORIZATION_SQL};`,
].join('\n');

const execute = (name: string, params: readonly (string | null)[]): string =>
  `execute ${name}(${params.map((p) => (p === null ? 'null' : lit(p))).join(', ')});`;

/** A `proposal_state[]` literal, so `$6::proposal_state[]` gets a real array. */
const stateArray = (states: readonly string[]): string => `{${states.join(',')}}`;

/** `proposalDecisionUpdateParams` rendered for `EXECUTE`. */
function updateArgs(
  tenantId: string,
  proposalId: string,
  decision: ReturnType<typeof decidePolicy>,
): readonly (string | null)[] {
  const [tenant, proposal, json, risk, threshold, states] = proposalDecisionUpdateParams(
    tenantId,
    proposalId,
    decision,
  );
  return [
    tenant,
    proposal,
    json,
    risk === null ? null : String(risk),
    threshold === null ? null : String(threshold),
    stateArray(states),
  ];
}

/** A Tenant, a User, an Evidence_Chain and one `proposed` Proposal with no evaluation yet. */
function fixtureSql(state = 'proposed'): {
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
      values (${lit(chainId)}, ${lit(f.tenantId)}, 38200000, 1, now(), 'policy_decision_test');
      insert into proposals
        (id, tenant_id, agent_name, action_type, target_source_records, target_fingerprint,
         impact_paise, evidence_chain_id, expected_outcome, state)
      values (${lit(proposalId)}, ${lit(f.tenantId)}, 'reconciliation_agent',
        'post_reconciliation_adjustment', '[{"type":"settlement","id":"setl_1"}]'::jsonb,
        'post_reconciliation_adjustment|settlement:setl_1', 38200000, ${lit(chainId)},
        '{"status":"adjusted"}'::jsonb, ${lit(state)});`,
  };
}

describe.skipIf(!database().reachable)('the Policy_Engine decision writes', () => {
  it('persists the six check results, the risk score and the threshold used', () => {
    const f = fixtureSql();
    const decision = decidePolicy({
      checks: checks(),
      risk_score: 55,
      auto_execute_threshold: 100,
    });

    const r = runScript(
      rolledBack(
        [
          f.sql,
          PREPARE_ALL,
          execute('policy_decision_update', updateArgs(f.tenantId, f.proposalId, decision)),
          jsonRows(`select risk_score, threshold_used,
              jsonb_array_length(policy_checks) as check_count,
              policy_checks->0->>'id' as first_id,
              policy_checks->0->>'result' as first_result,
              policy_checks->5->>'id' as last_id
            from proposals where id = ${lit(f.proposalId)}`),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 1)).toEqual([
      {
        risk_score: 55,
        threshold_used: 100,
        check_count: 6,
        first_id: 'user_permission',
        first_result: 'pass',
        last_id: 'approval_requirement',
      },
    ]);
  });

  it('persists a block with a NULL score and keeps every failure detail', () => {
    const f = fixtureSql();
    const decision = decidePolicy({
      checks: checks('risk_threshold'),
      risk_score: null,
      auto_execute_threshold: null,
    });

    const r = runScript(
      rolledBack(
        [
          f.sql,
          PREPARE_ALL,
          execute('policy_decision_update', updateArgs(f.tenantId, f.proposalId, decision)),
          jsonRows(`select risk_score, threshold_used,
              policy_checks->4->>'result' as risk_result,
              policy_checks->4->>'detail' as risk_detail
            from proposals where id = ${lit(f.proposalId)}`),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 1)).toEqual([
      {
        risk_score: null,
        threshold_used: null,
        risk_result: 'fail',
        risk_detail: 'risk_threshold failed',
      },
    ]);
  });

  it('matches no row for an executed Proposal, so its gate picture is not overwritten', () => {
    const f = fixtureSql('executed');
    const decision = decidePolicy({
      checks: checks('approval_requirement'),
      risk_score: null,
      auto_execute_threshold: null,
    });

    const r = runScript(
      rolledBack(
        [
          f.sql,
          PREPARE_ALL,
          execute('policy_decision_update', updateArgs(f.tenantId, f.proposalId, decision)),
          jsonRows(`select policy_checks is null as untouched
            from proposals where id = ${lit(f.proposalId)}`),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    // The state guard held, so `RETURNING id, state` emitted no line at all — which is
    // why an adapter must treat zero rows as a failed persist rather than a success.
    expect(r.out).toHaveLength(1);
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 0)).toEqual([{ untouched: true }]);
    expect(DECIDABLE_STATES).not.toContain('executed');
  });

  it('records an Authorization naming the Policy_Engine with no User attached', () => {
    const f = fixtureSql();
    const decidedAt = '2026-03-01T00:00:00.000Z';
    const params = policyEngineAuthorizationParams(f.tenantId, f.proposalId, decidedAt);

    const r = runScript(
      rolledBack(
        [
          f.sql,
          PREPARE_ALL,
          execute('policy_engine_authorization', [...params]),
          jsonRows(`select actor_kind, decision, actor_user_id is null as no_user,
              decided_at = ${lit(decidedAt)}::timestamptz as stamped_as_passed
            from authorizations where proposal_id = ${lit(f.proposalId)}`),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 1)).toEqual([
      { actor_kind: 'policy_engine', decision: 'approved', no_user: true, stamped_as_passed: true },
    ]);
  });

  it('cannot be bent into a User approval: the actor CHECK forbids a naming mismatch', () => {
    // Belt-and-braces on the statement's literals. The `authorizations` CHECK is
    // `(actor_kind = 'user') = (actor_user_id IS NOT NULL)`, so a Policy_Engine row
    // carrying a User is rejected by the database as well as unreachable through the
    // exported statement.
    const f = fixtureSql();
    const r = runScript(
      rolledBack(`${f.sql}
        insert into authorizations (tenant_id, proposal_id, actor_kind, actor_user_id, decision)
        values (${lit(f.tenantId)}, ${lit(f.proposalId)}, 'policy_engine', ${lit(f.userId)},
                'approved');`),
    );
    expect(r.errors, r.rawErr).toHaveLength(1);
    expect(r.errors[0]?.sqlstate).toBe(CHECK_VIOLATION);
  });
});
