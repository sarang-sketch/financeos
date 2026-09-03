/**
 * Row-level security: that migration 20260101000009 applied, covers every table
 * design.md names, and that the predicate actually behaves (task 26.1).
 *
 * SCOPE - deliberately narrow.
 * Task 26.4 owns the per-table RLS matrix and task 26.3 owns property P7
 * (tenant isolation across every read path). Neither is written here. This file
 * asserts only what task 26.1 itself claims:
 *
 *   1. COVERAGE, read out of the catalog: every table in design.md's
 *      "Row-level security" list that exists has RLS enabled AND forced, and
 *      carries exactly the policy set design.md specifies - four commands, or
 *      SELECT and INSERT only on `ledger_entries` and `audit_events` where
 *      UPDATE and DELETE are revoked outright (Requirement 2.7, 13.5).
 *   2. NOTHING LEFT OUT: no table in `public` carrying a `tenant_id` column is
 *      absent from that list. This is the assertion that catches a table added
 *      later without policies.
 *   3. BEHAVIOUR: the predicate filters rather than errors, and the INSERT
 *      `WITH CHECK` rejects a foreign `tenant_id`.
 *
 * WHY THE BEHAVIOUR HALF IS SHAPED THE WAY IT IS
 * The suite runs as `postgres`, which holds BYPASSRLS, so policies never apply
 * to it - see the role note in `pg.ts`. Behaviour therefore has to be asserted
 * under `SET LOCAL ROLE authenticated`, and that needs table privileges, which
 * `authenticated` holds only on `ledger_entries` and `audit_events`
 * (`auto_expose_new_tables` is unset in `supabase/config.toml`, and issuing the
 * remaining grants is not task 26.1's).
 *
 * So the mutable-table cases grant `authenticated` the privileges it needs
 * INSIDE the same transaction that is rolled back. `GRANT` is transactional in
 * Postgres, so the grant does not outlive the test and no migration is
 * weakened: no policy is dropped, `FORCE ROW LEVEL SECURITY` is untouched, and
 * nothing is granted on an append-only table. The append-only tables keep their
 * privilege barrier exactly as `append-only.test.ts` asserts it.
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.7, 14.10.
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  claims,
  database,
  jsonAt,
  jsonRows,
  lit,
  newFixture,
  provision,
  runOk,
  runScript,
  type Fixture,
} from './pg';

/** design.md, "Row-level security", in the order that section lists them. */
const LISTED_TABLES = [
  'ingestion_runs',
  'ingestion_errors',
  'razorpay_objects',
  'chart_of_accounts',
  'ledger_entry_sets',
  'ledger_entries',
  'ledger_entry_sources',
  'exceptions',
  'exception_source_records',
  'evidence_chains',
  'evidence_chain_steps',
  'evidence_chain_sources',
  'proposals',
  'authorizations',
  'audit_events',
  'audit_sequence_counters',
  'tds_review_items',
  'cash_forecasts',
  'cash_forecast_days',
  'cash_forecast_components',
  'model_requests',
  'tenant_configuration',
  'settlement_reconciliations',
  'tenant_memberships',
  'user_permissions',
] as const;

/** UPDATE and DELETE revoked outright, so design.md omits those two policies. */
const APPEND_ONLY = ['ledger_entries', 'audit_events'] as const;

/**
 * Created by tasks 31.4, 33.6 and 34.1, all of which sort after migration
 * 20260101000009. Named explicitly so this list shrinking is a deliberate edit
 * rather than a silent one, and so the coverage assertion below cannot pass by
 * quietly skipping a table that DOES exist.
 */
const NOT_YET_CREATED = [
  'cash_forecast_components',
  'cash_forecast_days',
  'cash_forecasts',
  'model_requests',
  'tds_review_items',
] as const;

/** `insufficient_privilege`. */
const INSUFFICIENT_PRIVILEGE = '42501';

interface PolicyRow {
  readonly table_name: string;
  readonly enabled: boolean;
  readonly forced: boolean;
  /** polcmd letters, sorted: 'r' SELECT, 'a' INSERT, 'w' UPDATE, 'd' DELETE. */
  readonly commands: readonly string[];
  /** Policies whose role list is exactly {authenticated}. */
  readonly authenticated_only: number;
  /** INSERT/UPDATE policies with no WITH CHECK expression. Must be 0. */
  readonly missing_with_check: number;
  /** Every USING/WITH CHECK expression must mention app.current_tenant_id(). */
  readonly bound_to_tenant: number;
  readonly total: number;
}

describe.skipIf(!database().reachable)('RLS policy coverage (migration 26.1)', () => {
  let byTable: Map<string, PolicyRow>;

  beforeAll(() => {
    const list = LISTED_TABLES.map((t) => lit(t)).join(', ');
    const r = runOk(
      jsonRows(`
        select c.relname                                as table_name,
               c.relrowsecurity                         as enabled,
               c.relforcerowsecurity                    as forced,
               coalesce(p.commands, array[]::text[])    as commands,
               coalesce(p.authenticated_only, 0)        as authenticated_only,
               coalesce(p.missing_with_check, 0)        as missing_with_check,
               coalesce(p.bound_to_tenant, 0)           as bound_to_tenant,
               coalesce(p.total, 0)                     as total
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          left join lateral (
            select array_agg(distinct pol.polcmd::text order by pol.polcmd::text) as commands,
                   count(*) as total,
                   count(*) filter (
                     where pol.polroles
                           = array[(select r.oid from pg_roles r
                                     where r.rolname = 'authenticated')]::oid[]
                   ) as authenticated_only,
                   count(*) filter (
                     where pol.polcmd in ('a', 'w') and pol.polwithcheck is null
                   ) as missing_with_check,
                   count(*) filter (
                     where coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
                             || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
                           -- Either the direct column comparison, or - on
                           -- evidence_chain_steps only - the parent-qualified
                           -- helper, which reads app.current_tenant_id() itself.
                           similar to
                             '%(current_tenant_id|evidence_chain_in_session_tenant)%'
                   ) as bound_to_tenant
              from pg_policy pol where pol.polrelid = c.oid
          ) p on true
         where n.nspname = 'public' and c.relkind = 'r' and c.relname in (${list})`),
    );
    byTable = new Map(jsonAt<readonly PolicyRow[]>(r, 0).map((row) => [row.table_name, row]));
  });

  it('applied, and is recorded in the local migration history', () => {
    const r = runOk(
      jsonRows(
        `select version, name from supabase_migrations.schema_migrations
          where version = '20260101000009'`,
      ),
    );
    expect(jsonAt<readonly { version: string; name: string }[]>(r, 0)).toEqual([
      { version: '20260101000009', name: 'rls_policies' },
    ]);
  });

  it('covers every design.md table that exists, and only those are missing', () => {
    const present = [...byTable.keys()].sort();
    const absent = LISTED_TABLES.filter((t) => !byTable.has(t)).sort();
    expect(absent, 'a design.md table went missing, or a later one now exists').toEqual([
      ...NOT_YET_CREATED,
    ]);
    expect(present).toHaveLength(LISTED_TABLES.length - NOT_YET_CREATED.length);
  });

  it('leaves no table carrying tenant_id outside design.md list', () => {
    const list = LISTED_TABLES.map((t) => lit(t)).join(', ');
    const r = runOk(
      jsonRows(`
        select c.relname as table_name
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
           and c.relname not in (${list})
           and exists (
             select 1 from pg_attribute a
              where a.attrelid = c.oid and a.attname = 'tenant_id'
                and a.attnum > 0 and not a.attisdropped
           )`),
    );
    expect(
      jsonAt<readonly { table_name: string }[]>(r, 0),
      'a tenant-scoped table with no RLS policy: add it to design.md and to the migration',
    ).toEqual([]);
  });

  for (const table of LISTED_TABLES) {
    // NOT_YET_CREATED is asserted as a whole above; skipping here keeps the
    // per-table report readable rather than 5 duplicate failures.
    describe.skipIf((NOT_YET_CREATED as readonly string[]).includes(table))(table, () => {
      it('has row-level security enabled and forced', () => {
        const row = byTable.get(table);
        expect(row?.enabled, 'ENABLE ROW LEVEL SECURITY').toBe(true);
        expect(row?.forced, 'FORCE ROW LEVEL SECURITY').toBe(true);
      });

      it('carries exactly the policy set design.md specifies, all tenant-bound', () => {
        const row = byTable.get(table);
        const appendOnly = (APPEND_ONLY as readonly string[]).includes(table);
        // 'r' SELECT, 'a' INSERT, 'w' UPDATE, 'd' DELETE
        expect(row?.commands).toEqual(appendOnly ? ['a', 'r'] : ['a', 'd', 'r', 'w']);
        expect(row?.total).toBe(appendOnly ? 2 : 4);
        expect(row?.authenticated_only, 'every policy scoped TO authenticated').toBe(row?.total);
        expect(row?.missing_with_check, 'WITH CHECK on every INSERT and UPDATE policy').toBe(0);
        expect(row?.bound_to_tenant, 'every policy bound to app.current_tenant_id()').toBe(
          row?.total,
        );
      });
    });
  }

  /**
   * Pins the one documented deviation so it stays a deviation. Every other table
   * compares its own tenant_id column; `evidence_chain_steps` has no such column
   * in design.md's DDL, so its predicate resolves through
   * `evidence_chains.tenant_id`. If someone later adds the column and switches to
   * the verbatim pattern, this fails and the migration comment gets updated with
   * it rather than going stale.
   */
  it('uses the parent-qualified predicate on evidence_chain_steps, and only there', () => {
    const r = runOk(
      jsonRows(`
        select c.relname as table_name
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_policy pol on pol.polrelid = c.oid
         where n.nspname = 'public'
           and coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
                 || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
               like '%evidence_chain_in_session_tenant%'
         group by c.relname`),
    );
    expect(jsonAt<readonly { table_name: string }[]>(r, 0)).toEqual([
      { table_name: 'evidence_chain_steps' },
    ]);
  });
});

/**
 * The predicate in operation, as `authenticated`.
 *
 * `exceptions` is design.md's own representative table, so it is the one used
 * here. It is mutable, so all four commands are observable, unlike the two
 * append-only tables.
 */
describe.skipIf(!database().reachable)('RLS behaviour as the application role', () => {
  const a: Fixture = newFixture();
  const b: Fixture = newFixture();
  const exceptionA = randomUUID();
  const exceptionB = randomUUID();

  /** Both Tenants and one Exception each, plus the temporary grant. Rolled back. */
  function seed(): string {
    const row = (f: Fixture, id: string, fp: string): string =>
      `insert into exceptions (id, tenant_id, category, impact_paise, fingerprint)
         values (${lit(id)}, ${lit(f.tenantId)}, 'settlement_mismatch', 100, ${lit(fp)});`;
    return `${provision(a)}
${provision(b)}
${row(a, exceptionA, 'fp-a')}
${row(b, exceptionB, 'fp-b')}
-- Transactional, so it is gone at ROLLBACK. See the header note.
grant select, insert, update, delete on exceptions to authenticated;`;
  }

  const bothRows = `select coalesce(jsonb_agg(x.tenant_id order by x.tenant_id), '[]'::jsonb)::text
      from exceptions x where x.tenant_id in (${lit(a.tenantId)}, ${lit(b.tenantId)});`;

  it('returns only the session Tenant rows, with no application-level filter', () => {
    const r = runScript(`begin;
${seed()}
set local role authenticated;
${claims(a)}
${bothRows}
rollback;`);
    expect(r.errors, r.rawErr).toEqual([]);
    expect(jsonAt<readonly string[]>(r, 0)).toEqual([a.tenantId]);
  });

  /**
   * Requirement 14.4 / 14.10: an unscoped session matches zero rows rather than
   * raising, so the response cannot confirm the row exists.
   *
   * The claim is set to `{}` - a session carrying claims but no `tenant_id` -
   * because that is the reachable unscoped shape here: every `runScript` session
   * that seeds data has to call `provision`, which sets the claim, and once a
   * session parameter has been assigned it cannot be returned to absent.
   * `set_config(..., NULL, ...)` assigns the empty string, not absence.
   *
   * FINDING, recorded not fixed: with the claim assigned the EMPTY STRING,
   * `app.current_tenant_id()` raises 22P02 `invalid input syntax for type json`
   * on `''::jsonb` rather than returning NULL. PostgREST never produces that
   * shape - it either omits the setting or writes a JSON object - so no request
   * path reaches it, and the truly-absent case is asserted in the next test.
   * The function belongs to migration 20260101000001 and hardening it is not
   * task 26.1's, so it is reported rather than changed.
   */
  it('returns zero rows for a session claim carrying no tenant_id', () => {
    const r = runScript(`begin;
${seed()}
set local role authenticated;
do $c$ begin perform set_config('request.jwt.claims', '{}', false); end $c$;
${bothRows}
rollback;`);
    expect(r.errors, 'an unscoped claim must filter, not error').toEqual([]);
    expect(jsonAt<readonly string[]>(r, 0)).toEqual([]);
  });

  /**
   * The truly-absent case: a fresh session that never sets `request.jwt.claims`
   * at all, so `app.current_tenant_id()` returns NULL and `tenant_id = NULL` is
   * never true. Unconditional zero rows regardless of what any other suite has
   * committed, which is what makes the assertion meaningful without seeding.
   */
  it('returns zero rows, no error, when no session claim was ever set', () => {
    // app.current_tenant_id() is read BEFORE the role switch. `authenticated`
    // holds no USAGE on schema `app`, so a direct call from that role raises
    // 42501 - which does NOT affect policy evaluation, because the function
    // reference in a policy expression was resolved when the policy was created.
    // Reported, not fixed: the missing grant is not task 26.1's to issue.
    const r = runScript(`begin;
select 'tenant=' || coalesce(app.current_tenant_id()::text, 'NULL');
grant select on exceptions to authenticated;
set local role authenticated;
select count(*)::text from exceptions;
rollback;`);
    expect(r.errors, 'an unauthenticated read must filter, not error').toEqual([]);
    expect(r.out[0]).toBe('tenant=NULL');
    expect(r.out[1], 'zero rows for every table with no claim').toBe('0');
  });

  it('rejects an INSERT carrying a foreign tenant_id via WITH CHECK', () => {
    const r = runScript(`begin;
${seed()}
set local role authenticated;
${claims(a)}
insert into exceptions (tenant_id, category, impact_paise, fingerprint)
  values (${lit(b.tenantId)}, 'settlement_mismatch', 100, 'fp-foreign');
rollback;`);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.sqlstate).toBe(INSUFFICIENT_PRIVILEGE);
    expect(r.errors[0]?.message).toContain('violates row-level security policy');
  });

  it('accepts an INSERT carrying the session tenant_id', () => {
    const r = runScript(`begin;
${seed()}
set local role authenticated;
${claims(a)}
insert into exceptions (tenant_id, category, impact_paise, fingerprint)
  values (${lit(a.tenantId)}, 'settlement_mismatch', 100, 'fp-own');
${bothRows}
rollback;`);
    expect(r.errors, r.rawErr).toEqual([]);
    expect(jsonAt<readonly string[]>(r, 0)).toEqual([a.tenantId, a.tenantId]);
  });

  it('matches zero rows on a cross-Tenant UPDATE and leaves the row unchanged', () => {
    const r = runScript(`begin;
${seed()}
set local role authenticated;
${claims(a)}
update exceptions set impact_paise = 999 where id = ${lit(exceptionB)};
reset role;
select coalesce(jsonb_agg(x.impact_paise), '[]'::jsonb)::text
  from exceptions x where x.id = ${lit(exceptionB)};
rollback;`);
    expect(r.errors, 'a foreign target must filter, not error').toEqual([]);
    expect(jsonAt<readonly number[]>(r, 0), 'the foreign row is untouched').toEqual([100]);
  });

  it('matches zero rows on a cross-Tenant DELETE and leaves the row present', () => {
    const r = runScript(`begin;
${seed()}
set local role authenticated;
${claims(a)}
delete from exceptions where id = ${lit(exceptionB)};
reset role;
select coalesce(jsonb_agg(x.id), '[]'::jsonb)::text
  from exceptions x where x.id = ${lit(exceptionB)};
rollback;`);
    expect(r.errors, 'a foreign target must filter, not error').toEqual([]);
    expect(jsonAt<readonly string[]>(r, 0), 'the foreign row still exists').toEqual([exceptionB]);
  });

  /**
   * `evidence_chain_steps` has no tenant_id column, so its policies qualify
   * through `evidence_chains.tenant_id` (migration 26.1, scope note 3). The
   * deviation is asserted to behave, not just to exist.
   */
  it('isolates evidence_chain_steps through its parent chain', () => {
    const chainA = randomUUID();
    const chainB = randomUUID();
    const chain = (f: Fixture, id: string): string =>
      `insert into evidence_chains
         (id, tenant_id, figure_paise, source_count, as_of, produced_by)
       values (${lit(id)}, ${lit(f.tenantId)}, 100, 1, now(), 'db-test');
       insert into evidence_chain_steps (chain_id, step_index, operation, operands, result_paise)
       values (${lit(id)}, 1, 'sum', '[]'::jsonb, 100);`;

    const r = runScript(`begin;
${provision(a)}
${provision(b)}
${chain(a, chainA)}
${chain(b, chainB)}
grant select on evidence_chain_steps to authenticated;
set local role authenticated;
${claims(a)}
select coalesce(jsonb_agg(s.chain_id order by s.chain_id), '[]'::jsonb)::text
  from evidence_chain_steps s where s.chain_id in (${lit(chainA)}, ${lit(chainB)});
rollback;`);
    expect(r.errors, r.rawErr).toEqual([]);
    expect(jsonAt<readonly string[]>(r, 0)).toEqual([chainA]);
  });
});
