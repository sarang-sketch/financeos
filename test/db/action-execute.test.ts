/**
 * The Action_Service's EXECUTE-stage statements, against Supabase local (task 23.2).
 * Requirements 5.9, 5.14, 12.10.
 *
 * Same standing as `./action-approval.test.ts`, and for the same reason:
 * `src/action/execute-authorized.ts` exports two statements and no adapter, because
 * `proposals` and `authorizations` are RLS `ENABLE`d and `FORCE`d with no policies until
 * task 26.1 and no Postgres driver can be added (see `pg.ts`). This file stands in for
 * the adapter and runs the **exact exported strings** through `PREPARE` / `EXECUTE`, so
 * Postgres plans them against the live schema.
 *
 * | Claim | Mechanism | Requirement |
 * |---|---|---|
 * | the Authorization for a Proposal resolves by both identifiers | `EXECUTION_AUTHORIZATION_LOOKUP_SQL` | 5.14 |
 * | an Authorization recorded against another Proposal does not resolve | the same statement's `proposal_id = $2` | 5.14, 12.10 |
 * | `authorized` → `executed` stamps `executed_at` in the same update | `PROPOSAL_EXECUTED_SQL` | 5.9, 5.11 |
 * | a Proposal that is not `authorized` matches no row | the `state = 'authorized'` guard | 5.8, 5.17 |
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  EXECUTION_AUTHORIZATION_LOOKUP_SQL,
  executionAuthorizationLookupParams,
  PROPOSAL_EXECUTED_SQL,
  proposalExecutedParams,
} from '@/action/execute-authorized';

import { database, jsonAt, jsonRows, lit, newFixture, provision, rolledBack, runScript } from './pg';

const DECIDED_AT = '2026-03-01T00:00:00.000Z';
const EXECUTED_AT = '2026-03-01T00:05:00.000Z';
/** ₹3,82,000 in paise, as the decimal string the money wire contract requires. */
const IMPACT_PAISE = '38200000';

const PREPARE_ALL = [
  `prepare execution_authorization_lookup as\n${EXECUTION_AUTHORIZATION_LOOKUP_SQL};`,
  `prepare proposal_executed as\n${PROPOSAL_EXECUTED_SQL};`,
].join('\n');

const execute = (name: string, params: readonly string[]): string =>
  `execute ${name}(${params.map((p) => lit(p)).join(', ')});`;

/**
 * A Tenant, a User, an Evidence_Chain, one Proposal in `state`, and an approved
 * `authorizations` row against it — the row Requirement 5.14 requires to exist.
 */
function fixtureSql(state = 'authorized'): {
  sql: string;
  tenantId: string;
  proposalId: string;
  authorizationId: string;
  otherProposalId: string;
} {
  const f = newFixture();
  const chainId = randomUUID();
  const proposalId = randomUUID();
  const otherProposalId = randomUUID();
  const authorizationId = randomUUID();
  const proposalRow = (id: string, proposalState: string): string =>
    `insert into proposals
        (id, tenant_id, agent_name, action_type, target_source_records, target_fingerprint,
         impact_paise, evidence_chain_id, expected_outcome, state)
      values (${lit(id)}, ${lit(f.tenantId)}, 'reconciliation_agent',
        'post_reconciliation_adjustment', '[{"type":"settlement","id":"setl_1"}]'::jsonb,
        ${lit(`post_reconciliation_adjustment|settlement:setl_1|${id}`)}, ${IMPACT_PAISE},
        ${lit(chainId)}, '{"status":"adjusted"}'::jsonb, ${lit(proposalState)});`;

  return {
    tenantId: f.tenantId,
    proposalId,
    authorizationId,
    otherProposalId,
    sql: `${provision(f)}
      insert into evidence_chains (id, tenant_id, figure_paise, source_count, as_of, produced_by)
      values (${lit(chainId)}, ${lit(f.tenantId)}, ${IMPACT_PAISE}, 1, now(), 'action_execute_test');
      ${proposalRow(proposalId, state)}
      ${proposalRow(otherProposalId, 'awaiting_approval')}
      insert into authorizations
        (id, tenant_id, proposal_id, actor_kind, actor_user_id, decision, decided_at)
      values (${lit(authorizationId)}, ${lit(f.tenantId)}, ${lit(proposalId)}, 'user',
        ${lit(f.userId)}, 'approved', ${lit(DECIDED_AT)}::timestamptz);`,
  };
}

describe.skipIf(!database().reachable)('the Action_Service EXECUTE-stage writes', () => {
  it('resolves the Authorization by Tenant, Proposal and Authorization together', () => {
    const f = fixtureSql();
    const params = executionAuthorizationLookupParams(f.tenantId, f.proposalId, f.authorizationId);

    const r = runScript(
      rolledBack(
        [
          f.sql,
          PREPARE_ALL,
          jsonRows(`select decision, actor_kind,
              proposal_id = ${lit(f.proposalId)} as names_the_proposal,
              decided_at = ${lit(DECIDED_AT)}::timestamptz as stamped_as_passed
            from (${EXECUTION_AUTHORIZATION_LOOKUP_SQL.replace('$1', lit(params[0]))
              .replace('$2', lit(params[1]))
              .replace('$3', lit(params[2]))}) resolved`),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 0)).toEqual([
      {
        decision: 'approved',
        actor_kind: 'user',
        names_the_proposal: true,
        stamped_as_passed: true,
      },
    ]);
  });

  it('does not resolve an Authorization recorded against another Proposal', () => {
    // Requirement 5.14 ties an execution to an Authorization referencing *that* Proposal,
    // so the crossed-over pair answers zero rows in the database as well as being refused
    // in TypeScript.
    const f = fixtureSql();
    const params = executionAuthorizationLookupParams(
      f.tenantId,
      f.otherProposalId,
      f.authorizationId,
    );

    const r = runScript(
      rolledBack(
        [
          f.sql,
          PREPARE_ALL,
          jsonRows(`select id from (${EXECUTION_AUTHORIZATION_LOOKUP_SQL.replace(
            '$1',
            lit(params[0]),
          )
            .replace('$2', lit(params[1]))
            .replace('$3', lit(params[2]))}) resolved`),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 0)).toEqual([]);
  });

  it('stamps state and executed_at in one update from authorized', () => {
    const f = fixtureSql();
    const params = proposalExecutedParams(f.tenantId, f.proposalId, EXECUTED_AT);

    const r = runScript(
      rolledBack(
        [
          f.sql,
          PREPARE_ALL,
          execute('proposal_executed', [...params]),
          jsonRows(`select state,
              executed_at = ${lit(EXECUTED_AT)}::timestamptz as stamped_as_passed,
              verified_at is null as verification_untouched
            from proposals where id = ${lit(f.proposalId)}`),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    // `RETURNING id, state, executed_at` emitted a line, so the update matched.
    expect(r.out).toHaveLength(2);
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 1)).toEqual([
      { state: 'executed', stamped_as_passed: true, verification_untouched: true },
    ]);
  });

  it('matches no row for a Proposal that is not authorized', () => {
    // The storage half of `EXECUTABLE_STATES`, and of Property P8's "no blocked,
    // awaiting-approval, rejected or expired Proposal reaches EXECUTE".
    for (const state of ['awaiting_approval', 'rejected', 'expired', 'execution_failed'] as const) {
      const f = fixtureSql(state);
      const params = proposalExecutedParams(f.tenantId, f.proposalId, EXECUTED_AT);

      const r = runScript(
        rolledBack(
          [
            f.sql,
            PREPARE_ALL,
            execute('proposal_executed', [...params]),
            jsonRows(`select state, executed_at is null as never_executed
              from proposals where id = ${lit(f.proposalId)}`),
          ].join('\n'),
        ),
      );

      expect(r.errors, r.rawErr).toEqual([]);
      // No `RETURNING` line: the guard declined, which an adapter must throw on.
      expect(r.out, state).toHaveLength(1);
      expect(jsonAt<readonly Record<string, unknown>[]>(r, 0), state).toEqual([
        { state, never_executed: true },
      ]);
    }
  });
});
