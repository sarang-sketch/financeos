/**
 * The Action_Service's EXECUTE-failure statements, against Supabase local (task 23.4).
 * Requirement 5.17.
 *
 * Same standing as `./action-approval.test.ts`, `./action-execute.test.ts` and
 * `./action-verify.test.ts`, and for the same reason: `src/action/reverse-failed-execution.ts`
 * exports three statements and no adapter, because a Postgres driver cannot be added (see
 * `pg.ts`). This file stands in for the adapter and runs the **exact exported strings**
 * through `PREPARE` / `EXECUTE`, so Postgres plans them against the live schema.
 *
 * | Claim | Mechanism | Requirement |
 * |---|---|---|
 * | the stated impact, targets and state load together, money as a decimal string | `PROPOSAL_FAILURE_LOAD_SQL` | 5.17, 15.1, 15.8 |
 * | `authorized` → `execution_failed` stamps the failure instant in the same update | `PROPOSAL_EXECUTION_FAILED_SQL` | 5.17 |
 * | a Proposal that is not `authorized` matches no row | the `state = 'authorized'` guard | 5.17 |
 * | the applied sets of one Proposal are found by `ledger_entry_sets.proposal_id` | `APPLIED_LEDGER_SETS_SQL` | 5.17 |
 * | a reversal is never read back as an applied change | `s.reverses_set_id IS NULL` | 2.4, 5.17 |
 * | an already-reversed set is reported as such | the `EXISTS` subquery | 2.4, 5.17 |
 * | another Tenant's set with the same `proposal_id` is invisible | `s.tenant_id = $1` | 12.7, 14.1, 14.4 |
 * | `execution_failure` is a real enum label | the `::exception_category` cast | 5.17 |
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  APPLIED_LEDGER_SETS_SQL,
  appliedLedgerSetsParams,
  PROPOSAL_EXECUTION_FAILED_SQL,
  PROPOSAL_FAILURE_LOAD_SQL,
  proposalExecutionFailedParams,
  proposalFailureLoadParams,
} from '@/action/reverse-failed-execution';

import { database, jsonAt, jsonRows, lit, newFixture, provision, rolledBack, runScript } from './pg';

/** The instant of the failed attempt, and the deadline a retry's Authorization must beat. */
const FAILED_AT = '2026-03-01T00:05:00.000Z';
/** ₹3,82,000 in paise, as the decimal string the money wire contract requires. */
const IMPACT_PAISE = '38200000';
const TARGETS = '[{"type":"settlement","id":"setl_1"},{"type":"settlement_recon_report","id":"setlrcn_1"}]';

const PREPARE_ALL = [
  `prepare proposal_failure_load as\n${PROPOSAL_FAILURE_LOAD_SQL};`,
  `prepare applied_ledger_sets as\n${APPLIED_LEDGER_SETS_SQL};`,
  `prepare proposal_execution_failed as\n${PROPOSAL_EXECUTION_FAILED_SQL};`,
].join('\n');

const execute = (name: string, params: readonly string[]): string =>
  `execute ${name}(${params.map((p) => lit(p)).join(', ')});`;

/** A plain SELECT with its two parameters substituted, for use as a subquery. */
const bound = (sql: string, params: readonly [string, string]): string =>
  sql.replace('$1', lit(params[0])).replace('$2', lit(params[1]));

interface Scenario {
  readonly sql: string;
  readonly tenantId: string;
  readonly proposalId: string;
  /** Applied, unreversed. */
  readonly setA: string;
  /** Applied, and already reversed. */
  readonly setB: string;
  /** The reversal of `setB` — never an applied change itself. */
  readonly reversalOfB: string;
}

/**
 * A Tenant, an Evidence_Chain, one Proposal in `state`, and three Ledger_Entry sets: two
 * applied for the Proposal (one of them already reversed) and the reversal itself.
 *
 * The sets carry no `ledger_entries` rows. They do not need any: the balance barrier that
 * compares entries against the header is `DEFERRABLE INITIALLY DEFERRED` and fires at
 * `COMMIT`, and there is no `COMMIT` here (see `pg.ts`). The immediate CHECKs —
 * `ledger_set_balanced`, `ledger_set_totals_positive`, `entry_count BETWEEN 2 AND 20` — are
 * satisfied by the header alone, which is all `APPLIED_LEDGER_SETS_SQL` reads.
 */
function scenario(state = 'authorized', executedAt: string | null = null): Scenario {
  const f = newFixture();
  const chainId = randomUUID();
  const proposalId = randomUUID();
  const setA = randomUUID();
  const setB = randomUUID();
  const reversalOfB = randomUUID();

  const set = (id: string, createdAt: string, opts: { proposal?: string; reverses?: string } = {}): string =>
    `insert into ledger_entry_sets
       (id, tenant_id, entry_date, reverses_set_id, proposal_id, entry_count,
        total_debit_paise, total_credit_paise, created_at, created_by)
     values (${lit(id)}, ${lit(f.tenantId)}, date '2026-02-28',
       ${opts.reverses === undefined ? 'null' : `${lit(opts.reverses)}::uuid`},
       ${opts.proposal === undefined ? 'null' : `${lit(opts.proposal)}::uuid`},
       2, ${IMPACT_PAISE}, ${IMPACT_PAISE}, ${lit(createdAt)}::timestamptz, 'action_failure_test');`;

  return {
    tenantId: f.tenantId,
    proposalId,
    setA,
    setB,
    reversalOfB,
    sql: `${provision(f)}
      insert into evidence_chains (id, tenant_id, figure_paise, source_count, as_of, produced_by)
      values (${lit(chainId)}, ${lit(f.tenantId)}, ${IMPACT_PAISE}, 1, now(), 'action_failure_test');
      insert into proposals
        (id, tenant_id, agent_name, action_type, target_source_records, target_fingerprint,
         impact_paise, evidence_chain_id, expected_outcome, state, executed_at)
      values (${lit(proposalId)}, ${lit(f.tenantId)}, 'reconciliation_agent',
        'post_reconciliation_adjustment', ${lit(TARGETS)}::jsonb,
        ${lit(`post_reconciliation_adjustment|settlement:setl_1|${proposalId}`)}, ${IMPACT_PAISE},
        ${lit(chainId)}, '{"paise":"${IMPACT_PAISE}"}'::jsonb, ${lit(state)},
        ${executedAt === null ? 'null' : `${lit(executedAt)}::timestamptz`});
      ${set(setA, '2026-03-01T00:04:58.000Z', { proposal: proposalId })}
      ${set(setB, '2026-03-01T00:04:59.000Z', { proposal: proposalId })}
      ${set(reversalOfB, '2026-03-01T00:06:00.000Z', { reverses: setB })}`,
  };
}

describe.skipIf(!database().reachable)('the Action_Service EXECUTE-failure writes', () => {
  it('loads the stated impact, the targets and the state, with money as a decimal string', () => {
    const s = scenario();
    const params = proposalFailureLoadParams(s.tenantId, s.proposalId);

    const r = runScript(
      rolledBack(
        [
          s.sql,
          PREPARE_ALL,
          jsonRows(`select state,
              impact_paise,
              action_type,
              jsonb_array_length(target_source_records) as target_count,
              executed_at is null as no_attempt_recorded
            from (${bound(PROPOSAL_FAILURE_LOAD_SQL, params)}) loaded`),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    // `impact_paise::text` crosses as digits, never as a JSON number (Requirement 15.1, 15.8).
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 0)).toEqual([
      {
        state: 'authorized',
        impact_paise: IMPACT_PAISE,
        action_type: 'post_reconciliation_adjustment',
        target_count: 2,
        // Task 23.2 writes nothing on a failed invocation, so the row still says `authorized`
        // with no `executed_at` when this path is handed the failure.
        no_attempt_recorded: true,
      },
    ]);
  });

  it('stamps state and the failure instant in one update from authorized', () => {
    const s = scenario();
    const params = proposalExecutionFailedParams(s.tenantId, s.proposalId, FAILED_AT);

    const r = runScript(
      rolledBack(
        [
          s.sql,
          PREPARE_ALL,
          execute('proposal_execution_failed', [...params]),
          jsonRows(`select state,
              executed_at = ${lit(FAILED_AT)}::timestamptz as stamped_as_passed,
              verified_at is null as never_verified
            from proposals where id = ${lit(s.proposalId)}`),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    // `RETURNING id, state, executed_at` emitted a line, so the update matched.
    expect(r.out).toHaveLength(2);
    // The instant is what `approvalRequirementCheck` compares a retry's Authorization
    // against, so state and instant have to move together (Requirement 5.17).
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 1)).toEqual([
      { state: 'execution_failed', stamped_as_passed: true, never_verified: true },
    ]);
  });

  it('matches no row for a Proposal that is not authorized', () => {
    // The storage half of `FAILURE_RECORDABLE_STATES`' transition guard. A resumption from
    // `execution_failed` is admissible in TypeScript and deliberately does **not** re-run
    // this statement, which is why the guard can stay this narrow.
    for (const state of ['execution_failed', 'executed', 'verified', 'rejected', 'expired'] as const) {
      const s = scenario(state, FAILED_AT);
      const params = proposalExecutionFailedParams(s.tenantId, s.proposalId, '2026-03-01T01:00:00.000Z');

      const r = runScript(
        rolledBack(
          [
            s.sql,
            PREPARE_ALL,
            execute('proposal_execution_failed', [...params]),
            jsonRows(`select state,
                executed_at = ${lit(FAILED_AT)}::timestamptz as instant_untouched
              from proposals where id = ${lit(s.proposalId)}`),
          ].join('\n'),
        ),
      );

      expect(r.errors, `${state}: ${r.rawErr}`).toEqual([]);
      // No `RETURNING` line: the guard declined, which an adapter must throw on.
      expect(r.out, state).toHaveLength(1);
      expect(jsonAt<readonly Record<string, unknown>[]>(r, 0), state).toEqual([
        { state, instant_untouched: true },
      ]);
    }
  });

  it('finds the applied sets of one Proposal, in posting order, with their reversal status', () => {
    const s = scenario();
    const params = appliedLedgerSetsParams(s.tenantId, s.proposalId);

    const r = runScript(
      rolledBack(
        [
          s.sql,
          PREPARE_ALL,
          jsonRows(`select id, total_debit_paise, reversed
                      from (${bound(APPLIED_LEDGER_SETS_SQL, params)}) applied`),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 0)).toEqual([
      // Ordered by `created_at`, so two passes reverse in the same order.
      { id: s.setA, total_debit_paise: IMPACT_PAISE, reversed: false },
      // `reverses_set_id = setB` exists, so this one must be skipped: `reverseSet` is not
      // idempotent and a second reversal would leave the accounts wrong (Requirement 2.4).
      { id: s.setB, total_debit_paise: IMPACT_PAISE, reversed: true },
      // The reversal itself is absent — `s.reverses_set_id IS NULL`. Without that clause a
      // resumed handling would reverse the correction the first pass posted.
    ]);
  });

  it('does not see another Tenant\u2019s set carrying the same proposal_id', () => {
    // Requirement 12.7 and 14.1: `$1` is the adapter's own session Tenant. A foreign set
    // reads back as absent rather than as an error that would confirm it exists (14.4).
    const s = scenario();
    const other = newFixture();
    const foreignSet = randomUUID();

    const r = runScript(
      rolledBack(
        [
          s.sql,
          provision(other),
          `insert into ledger_entry_sets
             (id, tenant_id, entry_date, proposal_id, entry_count,
              total_debit_paise, total_credit_paise, created_by)
           values (${lit(foreignSet)}, ${lit(other.tenantId)}, date '2026-02-28',
             ${lit(s.proposalId)}::uuid, 2, ${IMPACT_PAISE}, ${IMPACT_PAISE}, 'action_failure_test');`,
          jsonRows(
            `select id from (${bound(APPLIED_LEDGER_SETS_SQL, appliedLedgerSetsParams(s.tenantId, s.proposalId))}) applied`,
          ),
          jsonRows(
            `select id from (${bound(APPLIED_LEDGER_SETS_SQL, appliedLedgerSetsParams(other.tenantId, s.proposalId))}) applied`,
          ),
        ].join('\n'),
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    expect(jsonAt<readonly { id: string }[]>(r, 0).map((row) => row.id)).toEqual([s.setA, s.setB]);
    // The other Tenant sees its own set and neither of the first Tenant's.
    expect(jsonAt<readonly { id: string }[]>(r, 1).map((row) => row.id)).toEqual([foreignSet]);
  });

  it('has an enum label for the Exception category and for the Proposal as a Source_Record', () => {
    // Requirement 5.17 creates an Exception in the execution failure Exception_Category
    // identifying the Proposal. Both depend on an enum label existing, so both are asserted
    // against the live types rather than assumed.
    const r = runScript(
      jsonRows(
        `select 'execution_failure'::exception_category::text as category,
                'proposal'::source_record_type::text as record_type,
                'ledger_entry_set'::source_record_type::text as set_type,
                'execution_failed'::proposal_state::text as state`,
      ),
    );

    expect(r.errors, r.rawErr).toEqual([]);
    expect(jsonAt<readonly Record<string, unknown>[]>(r, 0)).toEqual([
      {
        category: 'execution_failure',
        record_type: 'proposal',
        set_type: 'ledger_entry_set',
        state: 'execution_failed',
      },
    ]);
  });
});
