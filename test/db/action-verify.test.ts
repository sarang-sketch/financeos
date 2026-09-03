/**
 * The Action_Service's VERIFY-stage statements, against Supabase local (task 23.3).
 * Requirements 5.11, 5.12.
 *
 * Same standing as `./action-approval.test.ts` and `./action-execute.test.ts`, and for the
 * same reason: `src/action/verify-execution.ts` exports three statements and no adapter,
 * because a Postgres driver cannot be added (see `pg.ts`). This file stands in for the
 * adapter and runs the **exact exported strings** through `PREPARE` / `EXECUTE`, so
 * Postgres plans them against the live schema.
 *
 * | Claim | Mechanism | Requirement |
 * |---|---|---|
 * | the stored expected outcome, targets and `executed_at` load together | `PROPOSAL_VERIFICATION_LOAD_SQL` | 5.11 |
 * | `executed` → `verified` stamps `verified_at`, `observed_paise` and `difference_paise` in one update | `PROPOSAL_VERIFIED_SQL` | 5.11 |
 * | `executed` → `verification_failed` stores a **signed** difference exactly | `PROPOSAL_VERIFICATION_FAILED_SQL` | 5.12 |
 * | a Proposal that is not `executed` matches no row | the `state = 'executed'` guard | 5.12 |
 * | a figure outside the paise range is refused by the domain, not truncated | `$4::paise`, `$5::paise` | 15.1, 15.8 |
 * | `verification_failure` and `proposal` are real enum labels | the two `::` casts | 5.12 |
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  PROPOSAL_VERIFICATION_FAILED_SQL,
  PROPOSAL_VERIFICATION_LOAD_SQL,
  PROPOSAL_VERIFIED_SQL,
  proposalVerificationLoadParams,
  proposalVerificationParams,
} from '@/action/verify-execution';

import { database, jsonAt, jsonRows, lit, newFixture, provision, rolledBack, runScript } from './pg';

const EXECUTED_AT = '2026-03-01T00:05:00.000Z';
const VERIFIED_AT = '2026-03-01T00:05:30.000Z';
/** ₹3,82,000 in paise, as the decimal string the money wire contract requires. */
const IMPACT_PAISE = '38200000';
/** What was actually observed: 200 paise short. */
const OBSERVED_PAISE = 38199800n;
const EXPECTED_OUTCOME = `{"paise":"${IMPACT_PAISE}","fields":{"lifecycle_state":"resolved"}}`;
const TARGETS = '[{"type":"settlement","id":"setl_1"},{"type":"proposal","id":"prop_0"}]';

const PREPARE_ALL = [
  `prepare proposal_verification_load as\n${PROPOSAL_VERIFICATION_LOAD_SQL};`,
  `prepare proposal_verified as\n${PROPOSAL_VERIFIED_SQL};`,
  `prepare proposal_verification_failed as\n${PROPOSAL_VERIFICATION_FAILED_SQL};`,
].join('\n');

const execute = (name: string, params: readonly string[]): string =>
  `execute ${name}(${params.map((p) => lit(p)).join(', ')});`;

/** A Tenant, an Evidence_Chain and one Proposal in `state`, stamped `executed_at`. */
function fixtureSql(state = 'executed'): { sql: string; tenantId: string; proposalId: string } {
  const f = newFixture();
  const chainId = randomUUID();
  const proposalId = randomUUID();

  return {
    tenantId: f.tenantId,
    proposalId,
    sql: `${provision(f)}
      insert into evidence_chains (id, tenant_id, figure_paise, source_count, as_of, produced_by)
      values (${lit(chainId)}, ${lit(f.tenantId)}, ${IMPACT_PAISE}, 1, now(), 'action_verify_test');
      insert into proposals
        (id, tenant_id, agent_name, action_type, target_source_records, target_fingerprint,
         impact_paise, evidence_chain_id, expected_outcome, state, executed_at)
      values (${lit(proposalId)}, ${lit(f.tenantId)}, 'reconciliation_agent',
        'post_reconciliation_adjustment', ${lit(TARGETS)}::jsonb,
        ${lit(`post_reconciliation_adjustment|settlement:setl_1|${proposalId}`)}, ${IMPACT_PAISE},
        ${lit(chainId)}, ${lit(EXPECTED_OUTCOME)}::jsonb, ${lit(state)},
        ${lit(EXECUTED_AT)}::timestamptz);`,
  };
}

describe.skipIf(!database().reachable)('the Action_Service VERIFY-stage writes', () => {
  it('loads the expected outcome, the targets and executed_at together', () => {
    const f = fixtureSql();
    const params = proposalVerificationLoadParams(f.tenantId, f.proposalId);

    const r = runScript(
      rolledBack(
        [
          f.sql,
          PREPARE_ALL,
          jsonRows(`select state,
              expected_outcome->>'paise' as expected_paise,
              expected_outcome->'fields'->>'lifecycle_state' as expected_state,
              jsonb_array_length(target_source_records) as target_count,
              executed_at = ${lit(EXECUTED_AT)}::timestamptz as stamped_as_passed,
              verified_at is null as not_yet_verified
            from (${PROPOSAL_VERIFICATION_LOAD_SQL.replace('$1', lit(params[0])).replace(
              '$2',
              lit(params[1]),
            )}) loaded`),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    // The money in `expected_outcome` crosses as a decimal string, never a JSON number:
    // `->>` gives the text back byte for byte (Requirement 15.1, 15.8).
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 0)).toEqual([
      {
        state: 'executed',
        expected_paise: IMPACT_PAISE,
        expected_state: 'resolved',
        target_count: 2,
        stamped_as_passed: true,
        not_yet_verified: true,
      },
    ]);
  });

  it('stamps state, verified_at and both figures in one update from executed', () => {
    const f = fixtureSql();
    const params = proposalVerificationParams(
      f.tenantId,
      f.proposalId,
      VERIFIED_AT,
      OBSERVED_PAISE,
      1n,
    );

    const r = runScript(
      rolledBack(
        [
          f.sql,
          PREPARE_ALL,
          execute('proposal_verified', [...params]),
          jsonRows(`select state,
              verified_at = ${lit(VERIFIED_AT)}::timestamptz as stamped_as_passed,
              observed_paise::text as observed_paise,
              difference_paise::text as difference_paise,
              executed_at = ${lit(EXECUTED_AT)}::timestamptz as execution_untouched
            from proposals where id = ${lit(f.proposalId)}`),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    // `RETURNING id, state, verified_at` emitted a line, so the update matched.
    expect(r.out).toHaveLength(2);
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 1)).toEqual([
      {
        state: 'verified',
        stamped_as_passed: true,
        // A 1-paisa difference is a match (Requirement 5.11) and is still recorded.
        observed_paise: '38199800',
        difference_paise: '1',
        execution_untouched: true,
      },
    ]);
  });

  it('stores a signed difference exactly on the failure path', () => {
    // Requirement 5.12's Exception carries the ABSOLUTE difference; the row keeps the sign,
    // which is what tells a shortfall from an excess. `proposals.difference_paise` is on the
    // signed `paise` domain for exactly this.
    const f = fixtureSql();
    const params = proposalVerificationParams(
      f.tenantId,
      f.proposalId,
      VERIFIED_AT,
      OBSERVED_PAISE,
      -200n,
    );

    const r = runScript(
      rolledBack(
        [
          f.sql,
          PREPARE_ALL,
          execute('proposal_verification_failed', [...params]),
          jsonRows(`select state, difference_paise::text as difference_paise,
              pg_typeof(difference_paise)::text as column_type
            from proposals where id = ${lit(f.proposalId)}`),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 1)).toEqual([
      // The column is the `paise` domain, so the range CHECK travels with the value.
      { state: 'verification_failed', difference_paise: '-200', column_type: 'paise' },
    ]);
  });

  it('matches no row for a Proposal that is not executed', () => {
    // The storage half of `VERIFIABLE_STATES`: a second Verification of a verified Proposal,
    // and a Verification of anything that never executed, are both refused by the guard as
    // well as in TypeScript (Requirement 5.12's "no further automatic change").
    for (const state of ['verified', 'verification_failed', 'authorized', 'expired'] as const) {
      const f = fixtureSql(state);
      for (const statement of ['proposal_verified', 'proposal_verification_failed']) {
        const params = proposalVerificationParams(
          f.tenantId,
          f.proposalId,
          VERIFIED_AT,
          OBSERVED_PAISE,
          -200n,
        );

        const r = runScript(
          rolledBack(
            [
              f.sql,
              PREPARE_ALL,
              execute(statement, [...params]),
              jsonRows(`select state, verified_at is null as never_verified,
                  difference_paise is null as no_figures
                from proposals where id = ${lit(f.proposalId)}`),
            ].join('\n'),
          ),
        );

        expect(r.errors, `${state}/${statement}: ${r.rawErr}`).toEqual([]);
        // No `RETURNING` line: the guard declined, which an adapter must throw on.
        expect(r.out, `${state}/${statement}`).toHaveLength(1);
        expect(jsonAt<readonly Record<string, unknown>[]>(r, 0), `${state}/${statement}`).toEqual([
          { state, never_verified: true, no_figures: true },
        ]);
      }
    }
  });

  it('refuses a figure outside the paise range rather than truncating it', () => {
    const f = fixtureSql();

    const r = runScript(
      rolledBack(
        [
          f.sql,
          PREPARE_ALL,
          // One paisa past the domain ceiling. `::paise` is the barrier, not the caller.
          execute('proposal_verified', [f.tenantId, f.proposalId, VERIFIED_AT, '100000000000000', '1']),
        ].join('\n'),
      ) + `\n${jsonRows(`select state from proposals where id = ${lit(f.proposalId)}`)}`,
    );

    expect(r.errors.map((e) => e.sqlstate)).toEqual(['23514']);
    expect(r.errors[0]?.datatype).toBe('paise');
    // Rolled back, so the Proposal is gone with the fixture rather than half-verified.
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 0)).toEqual([]);
  });

  it('has an enum label for the Exception category and for the Proposal as a Source_Record', () => {
    // Requirement 5.12 attaches "the Proposal identifier and target Source_Record
    // identifiers" to a `verification_failure` Exception. Both depend on an enum label
    // existing, so both are asserted against the live types rather than assumed.
    const r = runScript(
      jsonRows(
        `select 'verification_failure'::exception_category::text as category,
                'proposal'::source_record_type::text as record_type`,
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 0)).toEqual([
      { category: 'verification_failure', record_type: 'proposal' },
    ]);
  });
});
