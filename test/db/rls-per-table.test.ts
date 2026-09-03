/**
 * Row-level security, one table at a time, one verb at a time (task 26.4).
 *
 * WHAT THIS FILE OWNS, AND WHAT IT DELIBERATELY DOES NOT
 * `rls-migration-coverage.test.ts` (task 26.1) asserts COVERAGE out of the
 * catalog - RLS enabled and forced, the right policy set per table, every
 * predicate bound to the Tenant - plus BEHAVIOUR on `exceptions` alone as
 * design.md's representative table. Its header says the per-table matrix is
 * this task's. This file is that matrix and nothing else: for each of the 20
 * tenant-scoped tables that exist, two Tenants are seeded and the claim is set
 * to Tenant A, then each verb is exercised against Tenant B's row.
 *
 * Property P7 (task 26.3) is the same guarantee across every read path over
 * generated multi-Tenant datasets. It is not written here.
 *
 * WHICH BARRIER FIRES, PER VERB - THE DISTINCTION THIS FILE EXISTS TO PIN
 * Three different outcomes, and conflating them would hide a real defect:
 *
 *   SELECT / UPDATE / DELETE against a foreign row -> ZERO ROWS, NO ERROR.
 *     `USING` filters; it does not reject. Requirement 14.3 and design.md's
 *     Error Handling table are explicit that this must not be a permission
 *     error, because an error confirms the row exists. Each of those tests also
 *     runs the identical statement against Tenant A's own row and asserts it
 *     matches 1 row, so a zero is attributable to the policy rather than to a
 *     WHERE clause that matches nothing.
 *
 *   INSERT carrying a foreign `tenant_id` -> REJECTED, 42501,
 *     "violates row-level security policy". `WITH CHECK` rejects rather than
 *     filters (Requirement 14.3, 14.7). The test asserts no row landed.
 *
 *   UPDATE / DELETE on `ledger_entries` and `audit_events` -> REJECTED, 42501,
 *     "permission denied for table". Those privileges are revoked outright from
 *     every application role (Requirement 2.7, 13.5) and a privilege check is
 *     evaluated BEFORE row-level security, so the policy is never reached and no
 *     row-filtering is observable. Zero rows change either way, but by a
 *     different mechanism, and the assertion says so. The append-only barrier
 *     itself, including the rejecting trigger, is `append-only.test.ts`.
 *
 * THE UNSCOPED REPEAT (Requirement 14.4, 14.10)
 * Two reachable unscoped shapes, both asserted:
 *   - a claim of `{}` - claims present, no `tenant_id` - per table, with both
 *     Tenants' rows seeded and visible to the owner. This is the stronger of
 *     the two: rows exist and are still not returned.
 *   - a fresh session that never set `request.jwt.claims` at all, asserted once
 *     across all 20 tables.
 * There is no third shape. Once a session parameter is assigned it cannot be
 * returned to absent - `set_config(..., NULL, ...)` assigns the empty string -
 * and with the empty string `app.current_tenant_id()` raises 22P02 rather than
 * returning NULL. That finding belongs to migration 20260101000001 and task
 * 26.1 recorded it; PostgREST never produces that shape.
 *
 * HOW THE ROLE AND THE GRANTS WORK (both inherited from task 26.1)
 * The suite connects as `postgres`, which holds BYPASSRLS, so policies never
 * apply to it - see the role note in `pg.ts`. Every behavioural assertion is
 * therefore made under `SET LOCAL ROLE authenticated`. That role holds table
 * privileges only on `ledger_entries` and `audit_events`, so the mutable tables
 * are granted the four privileges INSIDE the transaction that is rolled back.
 * `GRANT` is transactional in Postgres: nothing outlives the test, no policy is
 * dropped, `FORCE ROW LEVEL SECURITY` is untouched, and nothing is granted on
 * an append-only table.
 *
 * Every session is wrapped in a transaction that is rolled back, so the two
 * append-only tables leave no committed rows and need no cleanup. Statements
 * that are expected to raise run under a `SAVEPOINT`, so the transaction is
 * usable afterwards and the "did anything land?" probe can still run.
 *
 * Every monetary value seeded here is an integer count of paise on a BIGINT
 * domain. No NUMERIC appears.
 *
 * Requirements: 14.2, 14.3, 14.4, 14.10.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
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

/** `insufficient_privilege`: both the WITH CHECK rejection and the privilege denial. */
const INSUFFICIENT_PRIVILEGE = '42501';

/** Tenant A holds the session claim in every test; Tenant B is the foreign Tenant. */
const A: Fixture = newFixture();
const B: Fixture = newFixture();

/**
 * Three rows per table per Tenant, distinguished by tag:
 *   marker  - seeded, then read, updated and deleted across the Tenant boundary
 *   own     - inserted by `authenticated` under its own claim, the INSERT control
 *   foreign - inserted carrying the other Tenant's identity, the WITH CHECK case
 */
type Tag = 'marker' | 'own' | 'foreign';

/** For tables whose key needs an ordinal rather than a name. */
const ORDINAL: Record<Tag, number> = { marker: 1, own: 2, foreign: 3 };

/** For `user_permissions`, whose primary key varies by Permission rather than by id. */
const PERMISSION: Record<Tag, string> = {
  marker: 'view_financial_data',
  own: 'run_agents',
  foreign: 'approve_sensitive_actions',
};

const generated = new Map<string, string>();

/** A stable UUID per (purpose, Tenant), so a table's keys agree across its tests. */
function uid(purpose: string, f: Fixture): string {
  const key = `${purpose}|${f.tenantId}`;
  let value = generated.get(key);
  if (value === undefined) {
    value = randomUUID();
    generated.set(key, value);
  }
  return value;
}

interface TableSpec {
  readonly table: string;
  /** Rows the marker row depends on. Inserted as `postgres`, before any role switch. */
  readonly parents?: (f: Fixture) => string;
  /** One row for `f` keyed by `tag`. NO trailing semicolon: callers wrap it. */
  readonly row: (f: Fixture, tag: Tag) => string;
  /** WHERE clause matching exactly that row. Bare column names, so DML can reuse it. */
  readonly key: (f: Fixture, tag: Tag) => string;
  /** The value the SELECT assertion aggregates. Defaults to `tenant_id`. */
  readonly identity?: string;
  /** What `identity` holds for `f`. Defaults to `f.tenantId`. */
  readonly identityOf?: (f: Fixture) => string;
  /** The cross-Tenant UPDATE: what it sets, and the value that must survive it. */
  readonly update: {
    readonly set: string;
    readonly probe: string;
    readonly before: unknown;
  };
  /** Grants beyond the four table privileges, e.g. USAGE on a BIGSERIAL sequence. */
  readonly extraGrant?: string;
  /** The primary key is the Tenant, so `tag` cannot vary the row. */
  readonly singleRowPerTenant?: boolean;
  /** `provision` already inserts this table's row, so the seed must not repeat it. */
  readonly seededByProvision?: boolean;
  /** UPDATE and DELETE revoked outright (Requirement 2.7, 13.5). */
  readonly appendOnly?: boolean;
}

/** design.md's "Row-level security" order, minus the five tables that do not exist yet. */
const SPECS: readonly TableSpec[] = [
  {
    table: 'ingestion_runs',
    row: (f, tag) =>
      `insert into ingestion_runs (id, tenant_id, window_from, window_basis, initiated_by)
         values (${lit(uid(`ingestion_runs:${tag}`, f))}, ${lit(f.tenantId)},
                 now() - interval '1 day', 'first_run_365d', ${lit(f.userId)})`,
    key: (f, tag) => `id = ${lit(uid(`ingestion_runs:${tag}`, f))}`,
    update: { set: 'per_type_errors = 7', probe: 'per_type_errors', before: 0 },
  },
  {
    table: 'ingestion_errors',
    // The run comes from `provision`, which gives each Tenant exactly one.
    row: (f, tag) =>
      `insert into ingestion_errors
         (tenant_id, ingestion_run_id, object_type, error_code, error_category, requested_at)
       values (${lit(f.tenantId)}, ${lit(f.runId)}, 'payment', ${lit(`rls-${tag}`)},
               'timeout', now())`,
    key: (f, tag) => `tenant_id = ${lit(f.tenantId)} and error_code = ${lit(`rls-${tag}`)}`,
    update: { set: 'retry_count = 5', probe: 'retry_count', before: 0 },
    // BIGSERIAL: without USAGE on the sequence the INSERT would fail on the
    // default expression, before the policy is ever consulted.
    extraGrant: 'grant usage on sequence ingestion_errors_id_seq to authenticated;',
  },
  {
    table: 'razorpay_objects',
    row: (f, tag) =>
      `insert into razorpay_objects
         (tenant_id, razorpay_id, object_type, ingestion_run_id, created_at_rzp,
          amount_paise, payload)
       values (${lit(f.tenantId)}, ${lit(`rzp-${tag}`)}, 'payment', ${lit(f.runId)},
               now(), 100, '{}'::jsonb)`,
    key: (f, tag) => `tenant_id = ${lit(f.tenantId)} and razorpay_id = ${lit(`rzp-${tag}`)}`,
    update: { set: 'amount_paise = 999', probe: 'amount_paise', before: 100 },
  },
  {
    table: 'chart_of_accounts',
    row: (f, tag) =>
      `insert into chart_of_accounts (tenant_id, account_code, account_name, kind)
         values (${lit(f.tenantId)}, ${lit(`RLS-${tag}`)}, 'marker', 'asset')`,
    key: (f, tag) => `tenant_id = ${lit(f.tenantId)} and account_code = ${lit(`RLS-${tag}`)}`,
    update: { set: "account_name = 'changed'", probe: 'account_name', before: 'marker' },
  },
  {
    table: 'ledger_entry_sets',
    row: (f, tag) =>
      `insert into ledger_entry_sets
         (id, tenant_id, entry_date, entry_count, total_debit_paise, total_credit_paise,
          created_by)
       values (${lit(uid(`ledger_entry_sets:${tag}`, f))}, ${lit(f.tenantId)}, current_date,
               2, 100, 100, 'db-test')`,
    key: (f, tag) => `id = ${lit(uid(`ledger_entry_sets:${tag}`, f))}`,
    update: { set: "created_by = 'changed'", probe: 'created_by', before: 'db-test' },
  },
  {
    table: 'ledger_entries',
    appendOnly: true,
    // The set's DEFERRABLE INITIALLY DEFERRED balance trigger fires at COMMIT
    // only, and there is no COMMIT here, so a single entry is a legal fixture.
    parents: (f) =>
      `insert into ledger_entry_sets
         (id, tenant_id, entry_date, entry_count, total_debit_paise, total_credit_paise,
          created_by)
       values (${lit(uid('ledger_entries:set', f))}, ${lit(f.tenantId)}, current_date,
               2, 100, 100, 'db-test');`,
    row: (f, tag) =>
      `insert into ledger_entries
         (id, tenant_id, set_id, account_code, side, amount_paise, entry_date, line_no)
       values (${lit(uid(`ledger_entries:${tag}`, f))}, ${lit(f.tenantId)},
               ${lit(uid('ledger_entries:set', f))}, ${lit(f.debitAccount)}, 'debit',
               100, current_date, ${ORDINAL[tag]})`,
    key: (f, tag) => `id = ${lit(uid(`ledger_entries:${tag}`, f))}`,
    update: { set: 'amount_paise = 999', probe: 'amount_paise', before: 100 },
  },
  {
    table: 'ledger_entry_sources',
    parents: (f) =>
      `insert into ledger_entry_sets
         (id, tenant_id, entry_date, entry_count, total_debit_paise, total_credit_paise,
          created_by)
       values (${lit(uid('ledger_entry_sources:set', f))}, ${lit(f.tenantId)}, current_date,
               2, 100, 100, 'db-test');
       insert into ledger_entries
         (id, tenant_id, set_id, account_code, side, amount_paise, entry_date, line_no)
       values (${lit(uid('ledger_entry_sources:entry', f))}, ${lit(f.tenantId)},
               ${lit(uid('ledger_entry_sources:set', f))}, ${lit(f.debitAccount)}, 'debit',
               100, current_date, 1);`,
    row: (f, tag) =>
      `insert into ledger_entry_sources
         (entry_id, tenant_id, source_record_type, source_record_id)
       values (${lit(uid('ledger_entry_sources:entry', f))}, ${lit(f.tenantId)}, 'payment',
               ${lit(`src-${tag}`)})`,
    key: (f, tag) => `tenant_id = ${lit(f.tenantId)} and source_record_id = ${lit(`src-${tag}`)}`,
    update: {
      set: "source_record_id = 'src-changed'",
      probe: 'source_record_id',
      before: 'src-marker',
    },
  },
  {
    table: 'exceptions',
    row: (f, tag) =>
      `insert into exceptions (id, tenant_id, category, impact_paise, fingerprint)
         values (${lit(uid(`exceptions:${tag}`, f))}, ${lit(f.tenantId)},
                 'settlement_mismatch', 100, ${lit(`fp-${tag}`)})`,
    key: (f, tag) => `id = ${lit(uid(`exceptions:${tag}`, f))}`,
    update: { set: 'impact_paise = 999', probe: 'impact_paise', before: 100 },
  },
  {
    table: 'exception_source_records',
    parents: (f) =>
      `insert into exceptions (id, tenant_id, category, impact_paise, fingerprint)
         values (${lit(uid('exception_source_records:exception', f))}, ${lit(f.tenantId)},
                 'settlement_mismatch', 100, 'fp-esr-parent');`,
    row: (f, tag) =>
      `insert into exception_source_records
         (exception_id, tenant_id, source_record_type, source_record_id, "role")
       values (${lit(uid('exception_source_records:exception', f))}, ${lit(f.tenantId)},
               'settlement', ${lit(`esr-${tag}`)}, 'settlement')`,
    key: (f, tag) => `tenant_id = ${lit(f.tenantId)} and source_record_id = ${lit(`esr-${tag}`)}`,
    update: { set: `"role" = 'changed'`, probe: '"role"', before: 'settlement' },
  },
  {
    table: 'evidence_chains',
    row: (f, tag) =>
      `insert into evidence_chains
         (id, tenant_id, figure_paise, source_count, as_of, produced_by)
       values (${lit(uid(`evidence_chains:${tag}`, f))}, ${lit(f.tenantId)}, 100, 1,
               now(), 'db-test')`,
    key: (f, tag) => `id = ${lit(uid(`evidence_chains:${tag}`, f))}`,
    update: { set: 'figure_paise = 999', probe: 'figure_paise', before: 100 },
  },
  {
    table: 'evidence_chain_steps',
    // The one table with no tenant_id column, so its policies qualify through
    // evidence_chains.tenant_id via app.evidence_chain_in_session_tenant(chain_id)
    // (migration 26.1, scope note 3). Its identity is therefore the parent chain.
    parents: (f) =>
      `insert into evidence_chains
         (id, tenant_id, figure_paise, source_count, as_of, produced_by)
       values (${lit(uid('evidence_chain_steps:chain', f))}, ${lit(f.tenantId)}, 100, 1,
               now(), 'db-test');`,
    row: (f, tag) =>
      `insert into evidence_chain_steps
         (chain_id, step_index, operation, operands, result_paise)
       values (${lit(uid('evidence_chain_steps:chain', f))}, ${ORDINAL[tag]}, 'sum',
               '[]'::jsonb, 100)`,
    key: (f, tag) =>
      `chain_id = ${lit(uid('evidence_chain_steps:chain', f))} and step_index = ${ORDINAL[tag]}`,
    identity: 'chain_id',
    identityOf: (f) => uid('evidence_chain_steps:chain', f),
    update: { set: 'result_paise = 999', probe: 'result_paise', before: 100 },
  },
  {
    table: 'evidence_chain_sources',
    parents: (f) =>
      `insert into evidence_chains
         (id, tenant_id, figure_paise, source_count, as_of, produced_by)
       values (${lit(uid('evidence_chain_sources:chain', f))}, ${lit(f.tenantId)}, 100, 1,
               now(), 'db-test');`,
    row: (f, tag) =>
      `insert into evidence_chain_sources
         (chain_id, tenant_id, source_record_type, source_record_id, field,
          record_updated_at)
       values (${lit(uid('evidence_chain_sources:chain', f))}, ${lit(f.tenantId)},
               'settlement', ${lit(`ecs-${tag}`)}, 'amount', '2024-01-01T00:00:00Z')`,
    key: (f, tag) => `tenant_id = ${lit(f.tenantId)} and source_record_id = ${lit(`ecs-${tag}`)}`,
    update: {
      set: "record_updated_at = '2030-01-01T00:00:00Z'",
      probe: `to_char(record_updated_at at time zone 'UTC', 'YYYY-MM-DD')`,
      before: '2024-01-01',
    },
  },
  {
    table: 'proposals',
    parents: (f) =>
      `insert into evidence_chains
         (id, tenant_id, figure_paise, source_count, as_of, produced_by)
       values (${lit(uid('proposals:chain', f))}, ${lit(f.tenantId)}, 100, 1,
               now(), 'db-test');`,
    row: (f, tag) =>
      `insert into proposals
         (id, tenant_id, agent_name, action_type, target_source_records, target_fingerprint,
          impact_paise, evidence_chain_id, expected_outcome)
       values (${lit(uid(`proposals:${tag}`, f))}, ${lit(f.tenantId)}, 'reconciliation_agent',
               'post_adjustment', '[]'::jsonb, ${lit(`tf-${tag}`)}, 100,
               ${lit(uid('proposals:chain', f))}, '{}'::jsonb)`,
    key: (f, tag) => `id = ${lit(uid(`proposals:${tag}`, f))}`,
    update: { set: 'impact_paise = 999', probe: 'impact_paise', before: 100 },
  },
  {
    table: 'authorizations',
    parents: (f) =>
      `insert into evidence_chains
         (id, tenant_id, figure_paise, source_count, as_of, produced_by)
       values (${lit(uid('authorizations:chain', f))}, ${lit(f.tenantId)}, 100, 1,
               now(), 'db-test');
       insert into proposals
         (id, tenant_id, agent_name, action_type, target_source_records, target_fingerprint,
          impact_paise, evidence_chain_id, expected_outcome)
       values (${lit(uid('authorizations:proposal', f))}, ${lit(f.tenantId)},
               'reconciliation_agent', 'post_adjustment', '[]'::jsonb, 'tf-authz', 100,
               ${lit(uid('authorizations:chain', f))}, '{}'::jsonb);`,
    row: (f, tag) =>
      `insert into authorizations (id, tenant_id, proposal_id, actor_kind, decision)
         values (${lit(uid(`authorizations:${tag}`, f))}, ${lit(f.tenantId)},
                 ${lit(uid('authorizations:proposal', f))}, 'policy_engine', 'approved')`,
    key: (f, tag) => `id = ${lit(uid(`authorizations:${tag}`, f))}`,
    update: { set: "decision = 'rejected'", probe: 'decision', before: 'approved' },
  },
  {
    table: 'audit_events',
    appendOnly: true,
    // Inserted directly rather than through app.append_audit_event: this file
    // asserts the policy, not the sequence allocator, and a direct insert keeps
    // the fixture inside the rolled-back transaction.
    row: (f, tag) =>
      `insert into audit_events
         (id, tenant_id, sequence_number, event_type, actor_kind, actor_id,
          source_record_refs, payload, payload_bytes, occurred_at, chain_value,
          prev_chain_value)
       values (${lit(uid(`audit_events:${tag}`, f))}, ${lit(f.tenantId)}, ${ORDINAL[tag]},
               'rls_marker', 'user', ${lit(f.userId)}, '[]'::jsonb, '{}'::jsonb, 2, now(),
               repeat('a', 64), repeat('0', 64))`,
    key: (f, tag) => `id = ${lit(uid(`audit_events:${tag}`, f))}`,
    update: { set: "event_type = 'changed'", probe: 'event_type', before: 'rls_marker' },
  },
  {
    table: 'audit_sequence_counters',
    singleRowPerTenant: true,
    seededByProvision: true,
    row: (f) => `insert into audit_sequence_counters (tenant_id) values (${lit(f.tenantId)})`,
    key: (f) => `tenant_id = ${lit(f.tenantId)}`,
    update: { set: 'last_sequence = 7', probe: 'last_sequence', before: 0 },
  },
  {
    table: 'tenant_memberships',
    singleRowPerTenant: true,
    row: (f) =>
      `insert into tenant_memberships (tenant_id, user_id, created_at)
         values (${lit(f.tenantId)}, ${lit(f.userId)}, '2024-01-01T00:00:00Z')`,
    key: (f) => `tenant_id = ${lit(f.tenantId)} and user_id = ${lit(f.userId)}`,
    update: {
      set: "created_at = '2030-01-01T00:00:00Z'",
      probe: `to_char(created_at at time zone 'UTC', 'YYYY-MM-DD')`,
      before: '2024-01-01',
    },
  },
  {
    table: 'user_permissions',
    parents: (f) =>
      `insert into tenant_memberships (tenant_id, user_id)
         values (${lit(f.tenantId)}, ${lit(f.userId)});`,
    row: (f, tag) =>
      `insert into user_permissions (tenant_id, user_id, permission, granted_by, granted_at)
         values (${lit(f.tenantId)}, ${lit(f.userId)}, ${lit(PERMISSION[tag])},
                 ${lit(f.userId)}, '2024-01-01T00:00:00Z')`,
    key: (f, tag) =>
      `tenant_id = ${lit(f.tenantId)} and permission = ${lit(PERMISSION[tag])}`,
    update: {
      set: "granted_at = '2030-01-01T00:00:00Z'",
      probe: `to_char(granted_at at time zone 'UTC', 'YYYY-MM-DD')`,
      before: '2024-01-01',
    },
  },
  {
    table: 'tenant_configuration',
    singleRowPerTenant: true,
    row: (f) =>
      `insert into tenant_configuration (tenant_id, auto_execute_threshold)
         values (${lit(f.tenantId)}, 10)`,
    key: (f) => `tenant_id = ${lit(f.tenantId)}`,
    update: { set: 'auto_execute_threshold = 90', probe: 'auto_execute_threshold', before: 10 },
  },
  {
    table: 'settlement_reconciliations',
    row: (f, tag) =>
      `insert into settlement_reconciliations
         (id, tenant_id, settlement_id, settlement_date, received_paise, status, run_id)
       values (${lit(uid(`settlement_reconciliations:${tag}`, f))}, ${lit(f.tenantId)},
               ${lit(`setl-${tag}`)}, current_date, 100, 'unreconciled', gen_random_uuid())`,
    key: (f, tag) => `id = ${lit(uid(`settlement_reconciliations:${tag}`, f))}`,
    update: { set: 'received_paise = 999', probe: 'received_paise', before: 100 },
  },
];

// ---------------------------------------------------------------------------
// SQL the matrix is driven from
// ---------------------------------------------------------------------------

function identityExpr(s: TableSpec): string {
  return s.identity ?? 'tenant_id';
}

function identityOf(s: TableSpec, f: Fixture): string {
  return s.identityOf === undefined ? f.tenantId : s.identityOf(f);
}

/**
 * The four table privileges `authenticated` needs, granted inside the caller's
 * transaction and gone at ROLLBACK. Nothing is granted on an append-only table:
 * those hold SELECT and INSERT from their own migration and must keep UPDATE and
 * DELETE revoked.
 */
function grants(s: TableSpec): string {
  if (s.appendOnly === true) {
    return '';
  }
  return `grant select, insert, update, delete on ${s.table} to authenticated;
${s.extraGrant ?? ''}`;
}

/** Both Tenants, this table's dependencies, one marker row each, and the grants. */
function seed(s: TableSpec): string {
  const parents = s.parents === undefined ? '' : `${s.parents(A)}\n${s.parents(B)}\n`;
  const markers =
    s.seededByProvision === true ? '' : `${s.row(A, 'marker')};\n${s.row(B, 'marker')};\n`;
  return `${provision(A)}
${provision(B)}
${parents}${markers}${grants(s)}`;
}

/** The identities of the two marker rows the current role can actually see. */
function visible(s: TableSpec): string {
  return `select coalesce(jsonb_agg(v order by v), '[]'::jsonb)::text
    from (select ${identityExpr(s)}::text as v from ${s.table}
           where (${s.key(A, 'marker')}) or (${s.key(B, 'marker')})) q;`;
}

/** Row count actually affected by a DML statement, as a tuple rather than a command tag. */
function affected(dml: string): string {
  return `with c as (${dml} returning 1) select count(*)::text from c;`;
}

/** The value that must have survived a cross-Tenant write, read back as the owner. */
function probeForeign(s: TableSpec): string {
  return `select coalesce(jsonb_agg(to_jsonb(${s.update.probe})), '[]'::jsonb)::text
    from ${s.table} where ${s.key(B, 'marker')};`;
}

const bothIdentities = (s: TableSpec): readonly string[] =>
  [identityOf(s, A), identityOf(s, B)].sort();

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

describe.skipIf(!database().reachable)('RLS per table (task 26.4)', () => {
  /**
   * Guards the matrix itself. A table added later with policies but no entry
   * here would otherwise be silently untested - the failure mode this file is
   * supposed to make impossible. Task 26.1 compares the catalog against
   * design.md's list; this compares it against what is actually exercised below.
   */
  it('exercises every table in public that carries a policy', () => {
    const r = runOk(
      jsonRows(`
        select c.relname as table_name
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_policy p on p.polrelid = c.oid
         where n.nspname = 'public' and c.relkind = 'r'
         group by c.relname`),
    );
    const withPolicies = jsonAt<readonly { table_name: string }[]>(r, 0)
      .map((row) => row.table_name)
      .sort();
    expect(
      withPolicies,
      'a table carries RLS policies but no entry in SPECS: add it to the matrix',
    ).toEqual(SPECS.map((s) => s.table).sort());
  });

  for (const s of SPECS) {
    describe(s.table, () => {
      it('SELECT returns Tenant A rows only, with both Tenants present in the table', () => {
        const r = runScript(`begin;
${seed(s)}
-- As the owner first: BYPASSRLS, so this proves the seed landed and that the
-- filtering below is the policy rather than a row that was never there.
${visible(s)}
set local role authenticated;
${claims(A)}
${visible(s)}
rollback;`);
        expect(r.errors, r.rawErr).toEqual([]);
        expect(jsonAt<readonly string[]>(r, 0), 'one marker row per Tenant').toEqual(
          bothIdentities(s),
        );
        expect(jsonAt<readonly string[]>(r, 1), 'only the session Tenant is visible').toEqual([
          identityOf(s, A),
        ]);
      });

      it('SELECT returns zero rows for a session claim carrying no tenant_id', () => {
        const r = runScript(`begin;
${seed(s)}
set local role authenticated;
do $c$ begin perform set_config('request.jwt.claims', '{}', false); end $c$;
${visible(s)}
rollback;`);
        expect(r.errors, 'an unscoped claim must filter, not error').toEqual([]);
        expect(jsonAt<readonly string[]>(r, 0)).toEqual([]);
      });

      if (s.appendOnly === true) {
        /**
         * No policy is reached on these two verbs: the privilege was revoked, and
         * a privilege check precedes row-level security. So the outcome is a
         * denial rather than a silent zero. Asserted as a denial on purpose - if
         * this ever became a filtered zero it would mean UPDATE or DELETE had
         * been re-granted, which Requirement 2.7 and 13.5 forbid.
         */
        it('UPDATE is refused by the privilege barrier, before RLS is reached', () => {
          const r = runScript(`begin;
${seed(s)}
set local role authenticated;
${claims(A)}
savepoint attempt;
update ${s.table} set ${s.update.set} where ${s.key(B, 'marker')};
rollback to savepoint attempt;
reset role;
${probeForeign(s)}
rollback;`);
          expect(r.errors, r.rawErr).toHaveLength(1);
          expect(r.errors[0]?.sqlstate).toBe(INSUFFICIENT_PRIVILEGE);
          expect(r.errors[0]?.message).toContain(`permission denied for table ${s.table}`);
          expect(jsonAt<readonly unknown[]>(r, 0), 'the foreign row is untouched').toEqual([
            s.update.before,
          ]);
        });

        it('DELETE is refused by the privilege barrier, before RLS is reached', () => {
          const r = runScript(`begin;
${seed(s)}
set local role authenticated;
${claims(A)}
savepoint attempt;
delete from ${s.table} where ${s.key(B, 'marker')};
rollback to savepoint attempt;
reset role;
select count(*)::text from ${s.table} where ${s.key(B, 'marker')};
rollback;`);
          expect(r.errors, r.rawErr).toHaveLength(1);
          expect(r.errors[0]?.sqlstate).toBe(INSUFFICIENT_PRIVILEGE);
          expect(r.errors[0]?.message).toContain(`permission denied for table ${s.table}`);
          expect(r.out[0], 'the foreign row still exists').toBe('1');
        });
      } else {
        it('cross-Tenant UPDATE matches zero rows and leaves the foreign row unchanged', () => {
          const r = runScript(`begin;
${seed(s)}
set local role authenticated;
${claims(A)}
${affected(`update ${s.table} set ${s.update.set} where ${s.key(B, 'marker')}`)}
${affected(`update ${s.table} set ${s.update.set} where ${s.key(A, 'marker')}`)}
reset role;
${probeForeign(s)}
rollback;`);
          expect(r.errors, 'a foreign target must filter, not error').toEqual([]);
          expect(r.out[0], 'USING filtered the foreign row out of the UPDATE').toBe('0');
          expect(
            r.out[1],
            'the identical statement against the session Tenant row matches, so the zero above is the policy',
          ).toBe('1');
          expect(jsonAt<readonly unknown[]>(r, 2), 'the foreign row is untouched').toEqual([
            s.update.before,
          ]);
        });

        it('cross-Tenant DELETE matches zero rows and leaves the foreign row present', () => {
          const r = runScript(`begin;
${seed(s)}
set local role authenticated;
${claims(A)}
${affected(`delete from ${s.table} where ${s.key(B, 'marker')}`)}
${affected(`delete from ${s.table} where ${s.key(A, 'marker')}`)}
reset role;
select count(*)::text from ${s.table} where ${s.key(B, 'marker')};
rollback;`);
          expect(r.errors, 'a foreign target must filter, not error').toEqual([]);
          expect(r.out[0], 'USING filtered the foreign row out of the DELETE').toBe('0');
          expect(
            r.out[1],
            'the identical statement against the session Tenant row matches, so the zero above is the policy',
          ).toBe('1');
          expect(r.out[2], 'the foreign row still exists').toBe('1');
        });
      }

      it('INSERT carrying the foreign Tenant identity is rejected by WITH CHECK', () => {
        // Tables keyed by Tenant alone cannot hold a second row per Tenant, so
        // both rows are cleared as the owner first: the own-Tenant control and
        // the foreign attempt then each insert into an empty slot, and the
        // rejection below cannot be a key collision wearing an RLS message.
        const clear =
          s.singleRowPerTenant === true
            ? `delete from ${s.table} where tenant_id in (${lit(A.tenantId)}, ${lit(B.tenantId)});\n`
            : '';
        const r = runScript(`begin;
${seed(s)}
${clear}set local role authenticated;
${claims(A)}
${affected(s.row(A, 'own'))}
savepoint attempt;
${s.row(B, 'foreign')};
rollback to savepoint attempt;
reset role;
select count(*)::text from ${s.table} where ${s.key(B, 'foreign')};
rollback;`);
        expect(r.errors, r.rawErr).toHaveLength(1);
        expect(r.errors[0]?.sqlstate).toBe(INSUFFICIENT_PRIVILEGE);
        expect(r.errors[0]?.message).toContain('violates row-level security policy');
        expect(r.out[0], 'the session Tenant identity is accepted').toBe('1');
        expect(r.out[1], 'nothing landed for the foreign Tenant').toBe('0');
      });
    });
  }

  /**
   * Requirement 14.4 and 14.10, the truly-absent claim: a fresh session that
   * never assigned `request.jwt.claims`, so `app.current_tenant_id()` is NULL
   * and no predicate can be true. Asserted across all 20 tables at once and
   * without seeding, so it holds regardless of what any other suite committed -
   * which is exactly what makes it meaningful.
   */
  it('every table returns zero rows in a session that never set a claim', () => {
    const mutable = SPECS.filter((s) => s.appendOnly !== true).map((s) => s.table);
    // app.current_tenant_id() is read BEFORE the role switch: `authenticated`
    // holds no USAGE on schema `app`, so a direct call from that role raises
    // 42501. Policy evaluation is unaffected - the function reference in a
    // policy expression was resolved when the policy was created. Pre-existing,
    // and not this task's to change.
    const r = runScript(`begin;
select 'tenant=' || coalesce(app.current_tenant_id()::text, 'NULL');
grant select on ${mutable.join(', ')} to authenticated;
set local role authenticated;
${SPECS.map((s) => `select count(*)::text from ${s.table};`).join('\n')}
rollback;`);
    expect(r.errors, 'an unauthenticated read must filter, not error').toEqual([]);
    expect(r.out[0]).toBe('tenant=NULL');
    const counts = r.out.slice(1);
    expect(counts).toHaveLength(SPECS.length);
    expect(
      counts.map((count, i) => `${SPECS[i]?.table ?? '?'}=${count}`),
      'zero rows on every table with no session claim',
    ).toEqual(SPECS.map((s) => `${s.table}=0`));
  });
});
