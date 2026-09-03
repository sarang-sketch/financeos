/**
 * Proposal and Authorization storage against Supabase local (task 21.1).
 * Requirements: 5.4, 5.15, 5.16.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { database, jsonAt, jsonRows, lit, newFixture, provision, rolledBack, runScript } from './pg';

const CHECK_VIOLATION = '23514';

function proposalSql(
  tenantId: string,
  proposalId: string,
  chainId: string,
  riskScore = 61,
  thresholdUsed = 40,
): string {
  return `insert into proposals
    (id, tenant_id, agent_name, action_type, target_source_records, target_fingerprint,
     impact_paise, evidence_chain_id, expected_outcome, risk_score, threshold_used,
     policy_checks, approval_deadline, observed_paise, difference_paise)
   values (${lit(proposalId)}, ${lit(tenantId)}, 'reconciliation_agent', 'post_reversal',
     '[{"type":"settlement","id":"setl_1"}]'::jsonb, 'post_reversal:settlement:setl_1',
     38200000, ${lit(chainId)}, '{"status":"reversed"}'::jsonb, ${riskScore}, ${thresholdUsed},
     '[{"name":"user_permission","passed":true}]'::jsonb,
     now() + interval '24 hours', 38199999, 1);`;
}

function fixtureSql(
  riskScore = 61,
  thresholdUsed = 40,
): { sql: string; tenantId: string; userId: string; proposalId: string } {
  const f = newFixture();
  const chainId = randomUUID();
  const proposalId = randomUUID();
  return {
    tenantId: f.tenantId,
    userId: f.userId,
    proposalId,
    sql: `${provision(f)}
      insert into evidence_chains (id, tenant_id, figure_paise, source_count, as_of, produced_by)
      values (${lit(chainId)}, ${lit(f.tenantId)}, 38200000, 1, now(), 'proposal_test');
      ${proposalSql(f.tenantId, proposalId, chainId, riskScore, thresholdUsed)}`,
  };
}

describe.skipIf(!database().reachable)('proposal and authorization storage', () => {
  it('declares the authoritative proposal states in order', () => {
    const r = runScript(jsonRows(`select enumlabel from pg_enum
      where enumtypid = 'proposal_state'::regtype order by enumsortorder`));
    expect(r.errors, r.rawErr).toEqual([]);
    expect(jsonAt<readonly { enumlabel: string }[]>(r, 0).map((row) => row.enumlabel)).toEqual([
      'proposed', 'blocked', 'awaiting_approval', 'authorized', 'executed', 'verified',
      'verification_failed', 'execution_failed', 'rejected', 'expired',
    ]);
  });

  it('requires Evidence_Chain grounding, uses paise domains, and links audit events', () => {
    const r = runScript([
      jsonRows(`select column_name, is_nullable, domain_name
        from information_schema.columns where table_schema = 'public' and table_name = 'proposals'
          and column_name in ('evidence_chain_id', 'impact_paise', 'observed_paise', 'difference_paise')
        order by column_name`),
      jsonRows(`select conname from pg_constraint
        where conrelid = 'audit_events'::regclass and conname = 'audit_events_proposal_id_fkey'`),
    ].join('\n'));
    expect(r.errors, r.rawErr).toEqual([]);
    expect(jsonAt<readonly unknown[]>(r, 0)).toEqual([
      { column_name: 'difference_paise', is_nullable: 'YES', domain_name: 'paise' },
      { column_name: 'evidence_chain_id', is_nullable: 'NO', domain_name: null },
      { column_name: 'impact_paise', is_nullable: 'NO', domain_name: 'paise' },
      { column_name: 'observed_paise', is_nullable: 'YES', domain_name: 'paise' },
    ]);
    expect(jsonAt<readonly unknown[]>(r, 1)).toEqual([
      { conname: 'audit_events_proposal_id_fkey' },
    ]);
  });
  it('persists proposal evidence, policy, deadline, observed, and paise difference fields', () => {
    const f = fixtureSql();
    const r = runScript(rolledBack(`${f.sql}
      ${jsonRows(`select state, impact_paise::text, risk_score, threshold_used,
        evidence_chain_id is not null as has_evidence, approval_deadline is not null as has_deadline,
        observed_paise::text, difference_paise::text from proposals
        where id = ${lit(f.proposalId)}`)}`));
    expect(r.errors, r.rawErr).toEqual([]);
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 0)).toEqual([{
      state: 'proposed', impact_paise: '38200000', risk_score: 61, threshold_used: 40,
      has_evidence: true, has_deadline: true, observed_paise: '38199999', difference_paise: '1',
    }]);
  });

  it.each([
    ['risk_score', 101, 40],
    ['threshold_used', 61, -1],
  ] as const)('rejects %s outside the inclusive 0..100 range', (_column, risk, threshold) => {
    const f = fixtureSql(risk, threshold);
    const r = runScript(rolledBack(f.sql));
    expect(r.errors, r.rawErr).toHaveLength(1);
    expect(r.errors[0]?.sqlstate).toBe(CHECK_VIOLATION);
  });

  it('accepts user and policy-engine authorizations with the required actor identity shape', () => {
    const f = fixtureSql();
    const r = runScript(rolledBack(`${f.sql}
      insert into authorizations (tenant_id, proposal_id, actor_kind, actor_user_id, decision)
      values (${lit(f.tenantId)}, ${lit(f.proposalId)}, 'user', ${lit(f.userId)}, 'approved'),
             (${lit(f.tenantId)}, ${lit(f.proposalId)}, 'policy_engine', null, 'approved');
      ${jsonRows(`select actor_kind, actor_user_id is not null as has_user
        from authorizations where proposal_id = ${lit(f.proposalId)} order by actor_kind`)}`));
    expect(r.errors, r.rawErr).toEqual([]);
    expect(jsonAt<readonly unknown[]>(r, 0)).toEqual([
      { actor_kind: 'policy_engine', has_user: false },
      { actor_kind: 'user', has_user: true },
    ]);
  });

  it.each([
    ['user', 'null'],
    ['policy_engine', 'fixture-user'],
  ] as const)('rejects actor_kind %s with an invalid actor_user_id shape', (kind, userShape) => {
    const f = fixtureSql();
    const actorUserId = userShape === 'null' ? 'null' : lit(f.userId);
    const r = runScript(rolledBack(`${f.sql}
      insert into authorizations (tenant_id, proposal_id, actor_kind, actor_user_id, decision)
      values (${lit(f.tenantId)}, ${lit(f.proposalId)}, ${lit(kind)}, ${actorUserId}, 'approved');`));
    expect(r.errors, r.rawErr).toHaveLength(1);
    expect(r.errors[0]?.sqlstate).toBe(CHECK_VIOLATION);
  });
});
