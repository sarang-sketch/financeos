/**
 * Domain range enforcement against Supabase local (task 4.8).
 *
 * One representative column per money domain. Each domain is checked at its
 * extreme and at ONE unit beyond it - not at some obviously huge value - so an
 * off-by-one in a domain `CHECK` is caught rather than stepped over.
 *
 * The three domains and the columns standing in for them:
 *
 * | Domain           | Range                                | Representative column          |
 * |------------------|--------------------------------------|--------------------------------|
 * | `paise`          | -99999999999999 .. 99999999999999    | `evidence_chains.figure_paise` |
 * | `paise_ingested` | 0 .. 999999999999                    | `razorpay_objects.amount_paise`|
 * | `paise_positive` | 1 .. 99999999999999 (0 excluded)     | `ledger_entries.amount_paise`  |
 *
 * The representatives are chosen for carrying NO column-level `CHECK` of their
 * own, so a rejection can only have come from the domain. `exceptions.impact_paise`
 * and `ledger_entry_sets.total_debit_paise`, for instance, add `>= 0` and `> 0`
 * checks that would mask the domain's lower bound.
 *
 * `paise_ingested` deliberately does not reach ±99999999999999: its range is
 * 0 .. 999999999999, two orders of magnitude narrower, because it holds a value
 * as Razorpay returned it (Requirement 1.7). Testing it at ±99999999999999 would
 * assert a range the schema never claimed.
 *
 * Requirements: 1.7, 2.1, 15.1, 15.8. Property: P12.
 *
 * Role: see the note at the top of `pg.ts`. These are domain checks, not RLS.
 */

import { describe, expect, it } from 'vitest';
import {
  database,
  jsonAt,
  lit,
  newFixture,
  provision,
  rolledBack,
  runScript,
  type Fixture,
  type ScriptResult,
} from './pg';

const PAISE_MAX = 99999999999999n;
const PAISE_MIN = -99999999999999n;
const INGESTED_MAX = 999999999999n;

/** Insert one row carrying `amount` into the representative column of a domain. */
type InsertBuilder = (f: Fixture, amount: bigint) => string;

const insertPaise: InsertBuilder = (f, amount) => `
insert into evidence_chains (tenant_id, figure_paise, source_count, as_of, produced_by)
values (${lit(f.tenantId)}, ${amount}, 1, now(), 'db-test');`;

const insertIngested: InsertBuilder = (f, amount) => `
insert into razorpay_objects
  (tenant_id, razorpay_id, object_type, ingestion_run_id, created_at_rzp, amount_paise, payload)
values (${lit(f.tenantId)}, 'pay_domain_probe', 'payment', ${lit(f.runId)}, now(),
        ${amount}, '{}'::jsonb);`;

const insertPositive: InsertBuilder = (f, amount) => `
insert into ledger_entry_sets
  (id, tenant_id, entry_date, entry_count, total_debit_paise, total_credit_paise, created_by)
values ('11111111-1111-4111-8111-111111111111', ${lit(f.tenantId)}, current_date, 2, 1, 1, 'db-test');
insert into ledger_entries
  (tenant_id, set_id, account_code, side, amount_paise, entry_date, line_no)
values (${lit(f.tenantId)}, '11111111-1111-4111-8111-111111111111',
        ${lit(f.debitAccount)}, 'debit', ${amount}, current_date, 1);`;

/**
 * Attempt one insert inside a transaction that is rolled back either way, so an
 * accepted extreme leaves nothing behind. The fixture is provisioned inside the
 * same transaction, which is why an accepted value must report ZERO errors: a
 * fixture failure would surface as a second error and fail the test rather than
 * hide inside it.
 */
function attempt(build: InsertBuilder, amount: bigint): ScriptResult {
  const f = newFixture();
  return runScript(rolledBack(`${provision(f)}\n${build(f, amount)}`));
}

function expectAccepted(build: InsertBuilder, amount: bigint): void {
  const r = attempt(build, amount);
  expect(r.errors, `expected ${amount} to be accepted, got:\n${r.rawErr}`).toEqual([]);
}

function expectRejected(build: InsertBuilder, amount: bigint, domain: string): void {
  const r = attempt(build, amount);
  expect(r.errors, `expected exactly one rejection for ${amount}, got:\n${r.rawErr}`).toHaveLength(
    1,
  );
  const [error] = r.errors;
  expect(error?.sqlstate).toBe('23514'); // check_violation
  expect(error?.datatype).toBe(domain);
  expect(error?.message).toContain(`value for domain ${domain} violates check constraint`);
}

describe.skipIf(!database().reachable)('money domain range enforcement', () => {
  describe('paise, on evidence_chains.figure_paise', () => {
    it('accepts the upper extreme 99999999999999', () => {
      expectAccepted(insertPaise, PAISE_MAX);
    });

    it('accepts the lower extreme -99999999999999', () => {
      expectAccepted(insertPaise, PAISE_MIN);
    });

    it('rejects one paisa above the upper extreme', () => {
      expectRejected(insertPaise, PAISE_MAX + 1n, 'paise');
    });

    it('rejects one paisa below the lower extreme', () => {
      expectRejected(insertPaise, PAISE_MIN - 1n, 'paise');
    });
  });

  describe('paise_ingested, on razorpay_objects.amount_paise', () => {
    it('accepts the lower extreme 0', () => {
      expectAccepted(insertIngested, 0n);
    });

    it('accepts the upper extreme 999999999999', () => {
      expectAccepted(insertIngested, INGESTED_MAX);
    });

    it('rejects one paisa below zero', () => {
      expectRejected(insertIngested, -1n, 'paise_ingested');
    });

    it('rejects one paisa above the upper extreme', () => {
      expectRejected(insertIngested, INGESTED_MAX + 1n, 'paise_ingested');
    });
  });

  describe('paise_positive, on ledger_entries.amount_paise', () => {
    it('accepts the smallest positive amount, 1', () => {
      expectAccepted(insertPositive, 1n);
    });

    it('accepts the upper extreme 99999999999999', () => {
      expectAccepted(insertPositive, PAISE_MAX);
    });

    // paise_positive is `VALUE > 0`, so 0 is outside it. Direction is carried by
    // `side`, never by a zero or a sign in the amount (Requirement 2.1).
    it('rejects 0, which the domain excludes', () => {
      expectRejected(insertPositive, 0n, 'paise_positive');
    });

    it('rejects one paisa above the upper extreme', () => {
      expectRejected(insertPositive, PAISE_MAX + 1n, 'paise_positive');
    });
  });

  it('declares all three domains over bigint, with no numeric base type', () => {
    const r = runScript(
      `select coalesce(jsonb_agg(jsonb_build_object('d', domain_name, 't', data_type)
         order by domain_name), '[]'::jsonb)::text
       from information_schema.domains
       where domain_schema = 'public' and domain_name in ('paise','paise_ingested','paise_positive');`,
    );
    expect(r.errors).toEqual([]);
    expect(jsonAt(r, 0)).toEqual([
      { d: 'paise', t: 'bigint' },
      { d: 'paise_ingested', t: 'bigint' },
      { d: 'paise_positive', t: 'bigint' },
    ]);
  });
});
