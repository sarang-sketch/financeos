// Feature: financeos-control-tower, Property 7: Tenant isolation — for all generated
// multi-tenant datasets and for all queries issued through any read path, the count of
// returned rows whose `tenant_id` differs from the executing session's Tenant identifier
// equals 0.
//
// **Validates: Requirements 12.7, 14.2, 14.3, 14.7, 14.10**
//
// WHAT THIS FILE OWNS, AND WHAT IT DELIBERATELY DOES NOT
// -----------------------------------------------------
// `test/db/rls-per-table.test.ts` (task 26.4) owns the per-table, per-verb matrix: two
// Tenants, one claim, one statement at a time, 102 example-based tests. Its header
// records which barrier fires per verb, and this file does not repeat that matrix.
// `test/db/rls-migration-coverage.test.ts` (task 26.1) owns the catalog-level coverage
// assertions — RLS enabled and forced, the right policy set per table.
//
// P7 is the same guarantee quantified the other way: over GENERATED multi-Tenant
// datasets, across EVERY READ PATH, with the application-level Tenant filter removed.
// Three things here exist nowhere else:
//
//   1. **Production read paths, not synthetic SQL.** Sixteen of the statements below are
//      the exported `*_SQL` constants the application actually issues — the membership
//      read from `src/authz/session.ts`, the granted-Permission read from
//      `src/authz/authorization-service.ts`, the Audit_Log history and chain walk, the
//      duplicate-action lookback, the Proposal loads, the applied-ledger-set read, the
//      Exception probes. They are imported, not copied, so a change to a production
//      statement changes what this property tests. That is what makes this an assertion
//      about Requirement 12.7 — a Financial_Tool restricting its reads to the session
//      Tenant — rather than about SQL invented for the test.
//   2. **The application-level filter deliberately omitted.** Every production statement
//      that carries `WHERE tenant_id = $1` is ALSO run with that clause surgically
//      removed (see {@link stripped}). If the stripped statement returns a foreign row,
//      the application filter was the boundary and RLS was not — which is exactly the
//      failure Requirement 14.2 and design.md's "RLS is the boundary; application filters
//      are defence in depth" forbid. Nothing else in the suite runs a production
//      statement without its Tenant predicate. For three of them, stripping removes the
//      only parameter that could have named a foreign record, so the stripped form is
//      asserted on an exact own-Tenant row count instead of on zero — the first run of
//      this property failed on exactly that confusion, and
//      {@link foreignCollapsesUnderStrip} records the counterexample and why the test
//      rather than the database was wrong.
//   3. **Colliding data.** Every Tenant in a dataset is seeded from ONE collision
//      profile, so amounts match to the paisa, dates match, and text identifiers are
//      equal across Tenants. A read filtered only on an amount, a date, or a
//      `LIKE 'p7-%'` identifier therefore names every Tenant's rows at once, and the only
//      thing that can be keeping the others out is the policy.
//
// TWO DIFFERENT EXPECTED OUTCOMES, NOT ONE
// ----------------------------------------
// Conflating these would hide a real defect, so they are asserted separately:
//
//   SELECT / UPDATE / DELETE naming a foreign row -> ZERO ROWS, NO ERROR, ROW UNCHANGED.
//     `USING` filters; it does not reject. A permission error would confirm the row
//     exists, which is itself a cross-Tenant leak (Requirement 14.3, 14.4; design.md's
//     Error Handling table). So the property asserts `r.errors` is empty on every read
//     session, asserts zero affected rows, and re-reads every row of the dataset as the
//     owner afterwards, comparing the complete `to_jsonb` text of each row against the
//     snapshot taken before the session. "The targeted row is unchanged" is therefore a
//     whole-row equality over every column of every table, not a probe of one column.
//
//   INSERT carrying a foreign `tenant_id` -> REJECTED, 42501, "violates row-level
//     security policy". `WITH CHECK` rejects rather than filters (Requirement 14.3,
//     14.7). One generated table per iteration is exercised this way, in a `SAVEPOINT`, so
//     the transaction survives; the per-table exhaustive version is 26.4's.
//
//   UPDATE / DELETE on `ledger_entries` and `audit_events` -> not exercised here. Those
//     privileges are revoked outright, a privilege check precedes RLS, and the resulting
//     42501 is a privilege denial rather than a filtered zero. That distinction is 26.4's
//     to pin, and an error mid-transaction would abort the session this property needs
//     intact. Their SELECT paths ARE exercised.
//
// THE TWO HARNESS FACTS THAT DETERMINE HOW THIS IS WRITTEN
// -------------------------------------------------------
// Both established by tasks 26.1 and 26.4 and inherited unchanged:
//
//   - The suite connects as `postgres`, which holds BYPASSRLS, so policies never apply to
//     it. Every isolation assertion below is made under `SET LOCAL ROLE authenticated`.
//     The seed and the before/after snapshots are deliberately made as the owner, which
//     is what lets them see the rows the application role must not.
//   - `authenticated` holds table privileges on `ledger_entries` and `audit_events` only;
//     migration 26.1 issued no grants. A privilege check is evaluated BEFORE RLS, so
//     without a grant the answer is 42501 rather than a filtered result. The four
//     privileges are therefore granted on the 18 mutable tables INSIDE the transaction
//     that is rolled back — `GRANT` is transactional in Postgres, so nothing outlives the
//     session, no policy is dropped, `FORCE ROW LEVEL SECURITY` is untouched, and nothing
//     is granted on an append-only table.
//
// A THIRD FACT, WORTH REPORTING RATHER THAN WORKING AROUND
// -------------------------------------------------------
// `AUDIT_SOURCE_HISTORY_SQL`, `AUDIT_PROPOSAL_HISTORY_SQL` and `AUDIT_CHAIN_WALK_SQL`
// put `app.current_tenant_id()` in their own predicate. `authenticated` holds no `USAGE`
// on schema `app`, so those three statements raise 42501 for the application role today —
// they cannot run at all as written, quite apart from RLS. That is the same gap
// `src/authz/session.ts` reports for `tenant_memberships`, it belongs to whoever composes
// the live adapters, and it is NOT closed here: granting `USAGE` on `app` would widen the
// surface inside a test. The consequence for this file is that those three are exercised
// in their stripped form only — which is the form P7 is about anyway, since removing
// `e.tenant_id = app.current_tenant_id()` is precisely "the application-level tenant
// filter deliberately omitted". Policy evaluation is unaffected by the missing grant: the
// function reference inside a policy expression was resolved when the policy was created.
//
// THE RESET: COMMITTED, LOCAL-ONLY, AND SERIALISED
// -------------------------------------------------
// P7 needs separate sessions to observe the same rows, so each generated dataset is
// committed. Before every seed, the local-only database harness truncates the exact
// allow-list below and reseeds in the same transaction. This is safe here because:
//
//   - `test/db/pg.ts` can only reach a Docker container named `supabase_db_*` (or an
//     explicit test override), never a hosted database;
//   - the property project has `fileParallelism: false`, so no sibling test writes while
//     the reset and committed read are in progress;
//   - `TRUNCATE` is issued as the owner, which is required for the append-only tables and
//     deliberately does not weaken their application-role UPDATE/DELETE barriers;
//   - the exact table allow-list is guarded against the live policy catalogue below, so a
//     newly protected table cannot be silently left outside the reset or the property;
//   - an `afterAll` reset removes the final committed dataset even on assertion failure.
//
// Identifiers are still minted afresh inside each property invocation. Fast-check may call
// the body repeatedly while shrinking, and fresh UUIDs keep a failed/shrunk invocation
// independent even if a process interruption occurs between commit and cleanup.
//
// SESSION BUDGET
// --------------
// `numRuns: 100`, as design.md and task 26.3 both state; P7 is not one of the four
// properties raised to 1000. Two `psql` sessions per iteration: one that truncates,
// seeds and COMMITS, and one that reads and rolls back. The read session first has no JWT
// claim at all, then rebinds the claim to two distinct generated Tenants in turn. This
// proves both fail-closed no-session behaviour and per-statement claim re-evaluation
// without paying for one connection per Tenant.
//
// NOT VACUOUS
// -----------
// Two mechanisms, because "zero foreign rows" is trivially true of a query that returns
// nothing at all:
//
//   - Every read path carries an own-Tenant positive control in the same session: an
//     exact expected row count for the unfiltered scans (`expectedRowCount`), an exact
//     count for the production statements, and `n >= 1` for the collision-filtered paths.
//     A path that returned zero own rows fails.
//   - Falsification. Checked by weakening a policy for the duration of one transaction —
//     `ALTER POLICY exceptions_select ON exceptions USING (true)` issued inside the read
//     session, which is transactional in Postgres and rolled back with everything else, so
//     the migration was never edited and no policy outlived the experiment:
//
//       Error: Property failed after 1 tests
//       { seed: 20260603, path: "0:0:0", endOnFailure: true }
//       Counterexample: [{"profile":{"amounts":["1","2"],"dates":["2026-01-01","2026-01-01"],
//         "stem":"alpha","suffixes":["0001","0002"]},"tenants":2}, ...]
//       Caused by: AssertionError: exceptions/scan_unfiltered returned rows of another
//         Tenant: expected [ '…d41' ] to deeply equal [ '…d41', '…8ac' ]
//
//     Reverted by discarding the transaction. No regression test is committed for it: the
//     counterexample came from a deliberately weakened policy rather than from a defect in
//     the system.
//
// MONEY
// -----
// Every amount is an integer count of paise on a `BIGINT` domain, drawn as `bigint` and
// rendered as digit text. No NUMERIC and no JSON number ever holds a paise value here:
// the before/after row comparison is made over the raw `to_jsonb(t)::text` of each row and
// is never parsed into JavaScript, so a value near the top of `paise_ingested` cannot lose
// precision on its way through the assertion (Requirement 15.1, 15.8).

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { PROPOSAL_STATE_TRANSITION_SQL, ACTION_PROPOSAL_LOAD_SQL } from '@/action/action-service';
import { EXECUTION_AUTHORIZATION_LOOKUP_SQL } from '@/action/execute-authorized';
import { OVERDUE_PROPOSALS_SQL, PROPOSAL_EXPIRY_LOAD_SQL } from '@/action/expire-approval-window';
import {
  APPLIED_LEDGER_SETS_SQL,
  PROPOSAL_FAILURE_LOAD_SQL,
} from '@/action/reverse-failed-execution';
import { PROPOSAL_VERIFICATION_LOAD_SQL } from '@/action/verify-execution';
import { EXCEPTION_STATE_PROBE_SQL } from '@/agents/exception-fingerprint';
import { AUDIT_CHAIN_WALK_SQL } from '@/audit/chain';
import { AUDIT_PROPOSAL_HISTORY_SQL, AUDIT_SOURCE_HISTORY_SQL } from '@/audit/history';
import { GRANTED_PERMISSIONS_SQL } from '@/authz/authorization-service';
import { TENANT_MEMBERSHIPS_SQL } from '@/authz/session';
import { DUPLICATE_ACTION_LOOKBACK_SQL } from '@/policy/checks';
import {
  EXCEPTION_RESOLUTION_STATE_PROBE_SQL,
  EXCEPTION_RESOLVE_SQL,
} from '@/tools/mark-exception-resolved';
import {
  announceIfUnreachable,
  claims,
  database,
  jsonAt,
  lit,
  provision,
  runOk,
  runScript,
} from '../db/pg';
import {
  arbitraryMultiTenantDataset,
  auditSourceRef,
  expectedRowCount,
  materialize,
  proposalState,
  type CollisionProfile,
  type MultiTenantDataset,
  type TenantFixture,
  TEXT_ID_PREFIX,
  tenantRowsSql,
  textId,
} from './multi-tenant-dataset-generators';

announceIfUnreachable();

const reachable = database().reachable;

/** design.md's stated minimum for P7, and task 26.3's stated count. */
const NUM_RUNS = 100;

/** Explicit and committed, so any counterexample is reproducible from this file alone. */
const SEED = 20260603;

const PARAMS = { numRuns: NUM_RUNS, seed: SEED } as const;

/** `insufficient_privilege`: the `WITH CHECK` rejection. */
const INSUFFICIENT_PRIVILEGE = '42501';

/* -------------------------------------------------------------------------- */
/* The 20 tenant-scoped tables, and how to read each one                      */
/* -------------------------------------------------------------------------- */

/**
 * One table, with everything needed to build a read path over it.
 *
 * `ident` is the expression that yields a returned row's Tenant identity. It is
 * `tenant_id` everywhere except `evidence_chain_steps`, which carries no `tenant_id`
 * column at all — its policies qualify through `evidence_chains.tenant_id` via
 * `app.evidence_chain_in_session_tenant(chain_id)` (migration 26.1, scope note 3), so its
 * identity is the parent chain and `identOf` answers the session Tenant's chain
 * identifiers. The comparison is made in TypeScript against the seeded dataset rather than
 * by joining to `evidence_chains` in SQL, because that join would itself be filtered by
 * the policy under test and the check would be circular.
 */
interface TableRead {
  readonly table: string;
  readonly ident: string;
  readonly identOf: (f: TenantFixture) => readonly string[];
  /** A `BIGINT` money column carrying the collision profile's amount. */
  readonly money?: string;
  /** An expression comparable to a `DATE` literal. */
  readonly dateExpr?: string;
  /** A text column carrying a `p7-` identifier, so `LIKE` names every Tenant's rows. */
  readonly text?: string;
  /** A predicate naming exactly row `i` of Tenant `f`, Tenant identifier included. */
  readonly key: (f: TenantFixture, profile: CollisionProfile, i: number) => string;
  /** The own-row control mutation, and hence the shape of the foreign-target probe. */
  readonly update?: string;
  /** `UPDATE`/`DELETE` revoked outright: no DML probe here (Requirement 2.7, 13.5). */
  readonly appendOnly?: boolean;
}

const byTenant = (f: TenantFixture): readonly string[] => [f.tenantId];

const TABLES: readonly TableRead[] = [
  {
    table: 'ingestion_runs',
    ident: 'tenant_id',
    identOf: byTenant,
    dateExpr: 'window_from::date',
    key: (f, _p, i) => `tenant_id = ${lit(f.tenantId)} and id = ${lit(f.ingestionRunIds[i] ?? '')}`,
    update: 'per_type_errors = 7',
  },
  {
    table: 'ingestion_errors',
    ident: 'tenant_id',
    identOf: byTenant,
    dateExpr: 'requested_at::date',
    text: 'error_code',
    key: (f, p, i) =>
      `tenant_id = ${lit(f.tenantId)} and error_code = ${lit(textId(p, 'err', i))}`,
    // `ingestion_errors_error_category_check` admits four values only (migration 2); the
    // seed writes 'timeout', so this is a real change to the row and not a no-op.
    update: "error_category = 'provider_error'",
  },
  {
    table: 'razorpay_objects',
    ident: 'tenant_id',
    identOf: byTenant,
    money: 'amount_paise',
    dateExpr: 'created_at_rzp::date',
    text: 'razorpay_id',
    key: (f, _p, i) => `tenant_id = ${lit(f.tenantId)} and id = ${lit(f.razorpayIds[i] ?? '')}`,
    update: 'fee_paise = 1',
  },
  {
    table: 'chart_of_accounts',
    ident: 'tenant_id',
    identOf: byTenant,
    key: (f) => `tenant_id = ${lit(f.tenantId)} and account_code = ${lit(f.debitAccount)}`,
    update: "account_name = 'p7-mutated'",
  },
  {
    table: 'ledger_entry_sets',
    ident: 'tenant_id',
    identOf: byTenant,
    money: 'total_debit_paise',
    dateExpr: 'entry_date',
    text: 'source_record_id',
    key: (f, _p, i) => `tenant_id = ${lit(f.tenantId)} and id = ${lit(f.setIds[i] ?? '')}`,
    update: "created_by = 'p7-mutated'",
  },
  {
    table: 'ledger_entries',
    ident: 'tenant_id',
    identOf: byTenant,
    money: 'amount_paise',
    dateExpr: 'entry_date',
    appendOnly: true,
    key: (f, _p, i) => `tenant_id = ${lit(f.tenantId)} and id = ${lit(f.entryIds[i]?.[0] ?? '')}`,
  },
  {
    table: 'ledger_entry_sources',
    ident: 'tenant_id',
    identOf: byTenant,
    text: 'source_record_id',
    key: (f, _p, i) =>
      `tenant_id = ${lit(f.tenantId)} and entry_id = ${lit(f.entryIds[i]?.[0] ?? '')}`,
    update: "source_record_id = 'p7-mutated'",
  },
  {
    table: 'exceptions',
    ident: 'tenant_id',
    identOf: byTenant,
    money: 'impact_paise',
    dateExpr: 'first_detected_at::date',
    text: 'fingerprint',
    key: (f, _p, i) => `tenant_id = ${lit(f.tenantId)} and id = ${lit(f.exceptionIds[i] ?? '')}`,
    update: 'impact_paise = 1',
  },
  {
    table: 'exception_source_records',
    ident: 'tenant_id',
    identOf: byTenant,
    text: 'source_record_id',
    key: (f, _p, i) =>
      `tenant_id = ${lit(f.tenantId)} and exception_id = ${lit(f.exceptionIds[i] ?? '')}`,
    update: `"role" = 'p7-mutated'`,
  },
  {
    table: 'evidence_chains',
    ident: 'tenant_id',
    identOf: byTenant,
    money: 'figure_paise',
    dateExpr: 'as_of::date',
    text: 'produced_by',
    key: (f, _p, i) => `tenant_id = ${lit(f.tenantId)} and id = ${lit(f.chainIds[i] ?? '')}`,
    update: 'figure_paise = 1',
  },
  {
    table: 'evidence_chain_steps',
    ident: 'chain_id',
    identOf: (f) => f.chainIds,
    money: 'result_paise',
    key: (f, _p, i) => `chain_id = ${lit(f.chainIds[i] ?? '')}`,
    update: 'result_paise = 1',
  },
  {
    table: 'evidence_chain_sources',
    ident: 'tenant_id',
    identOf: byTenant,
    dateExpr: 'record_updated_at::date',
    text: 'source_record_id',
    key: (f, _p, i) => `tenant_id = ${lit(f.tenantId)} and chain_id = ${lit(f.chainIds[i] ?? '')}`,
    update: "field = 'p7-mutated'",
  },
  {
    table: 'proposals',
    ident: 'tenant_id',
    identOf: byTenant,
    money: 'impact_paise',
    dateExpr: 'created_at::date',
    text: 'target_fingerprint',
    key: (f, _p, i) => `tenant_id = ${lit(f.tenantId)} and id = ${lit(f.proposalIds[i] ?? '')}`,
    update: "agent_name = 'p7-mutated'",
  },
  {
    table: 'authorizations',
    ident: 'tenant_id',
    identOf: byTenant,
    dateExpr: 'decided_at::date',
    key: (f, _p, i) =>
      `tenant_id = ${lit(f.tenantId)} and id = ${lit(f.authorizationIds[i] ?? '')}`,
    update: "decision = 'rejected'",
  },
  {
    table: 'audit_events',
    ident: 'tenant_id',
    identOf: byTenant,
    dateExpr: 'occurred_at::date',
    text: 'event_type',
    appendOnly: true,
    key: (f, _p, i) => `tenant_id = ${lit(f.tenantId)} and id = ${lit(f.auditIds[i] ?? '')}`,
  },
  {
    table: 'audit_sequence_counters',
    ident: 'tenant_id',
    identOf: byTenant,
    key: (f) => `tenant_id = ${lit(f.tenantId)}`,
    update: 'last_sequence = 7',
  },
  {
    table: 'tenant_memberships',
    ident: 'tenant_id',
    identOf: byTenant,
    dateExpr: 'created_at::date',
    key: (f) => `tenant_id = ${lit(f.tenantId)} and user_id = ${lit(f.userId)}`,
    update: "created_at = '2030-01-01T00:00:00Z'",
  },
  {
    table: 'user_permissions',
    ident: 'tenant_id',
    identOf: byTenant,
    dateExpr: 'granted_at::date',
    key: (f) => `tenant_id = ${lit(f.tenantId)} and user_id = ${lit(f.userId)}`,
    update: "granted_at = '2030-01-01T00:00:00Z'",
  },
  {
    table: 'tenant_configuration',
    ident: 'tenant_id',
    identOf: byTenant,
    key: (f) => `tenant_id = ${lit(f.tenantId)}`,
    update: 'auto_execute_threshold = 90',
  },
  {
    table: 'settlement_reconciliations',
    ident: 'tenant_id',
    identOf: byTenant,
    money: 'received_paise',
    dateExpr: 'settlement_date',
    text: 'settlement_id',
    key: (f, _p, i) => `tenant_id = ${lit(f.tenantId)} and id = ${lit(f.settlementIds[i] ?? '')}`,
    update: 'received_paise = 1',
  },
];

/** The 18 tables the four privileges are granted on for the life of one transaction. */
const MUTABLE_TABLES: readonly string[] = TABLES.filter((t) => t.appendOnly !== true).map(
  (t) => t.table,
);

/**
 * Exact local-test reset allow-list. Parent tables are included so each iteration starts
 * from a genuinely empty committed database rather than retaining orphaned Tenant/User
 * identities. `CASCADE` handles foreign-key order; no application policy or privilege is
 * changed by a truncate issued as the local fixture owner.
 */
const RESET_TABLES: readonly string[] = [
  ...TABLES.map((t) => t.table),
  'tenants',
  'users',
];

function truncateCommittedDatasetSql(): string {
  return `truncate table ${RESET_TABLES.join(', ')} restart identity cascade;`;
}

function truncateCommittedDataset(): void {
  runOk(`begin;\n${truncateCommittedDatasetSql()}\ncommit;`);
}

/* -------------------------------------------------------------------------- */
/* Production read paths: the statements the application actually issues       */
/* -------------------------------------------------------------------------- */

/** What a read path is given: the session Tenant, one foreign Tenant, and a row index. */
interface ReadContext {
  readonly profile: CollisionProfile;
  readonly session: TenantFixture;
  readonly other: TenantFixture;
  readonly index: number;
}

/**
 * One exported production statement, with the arguments to run it under.
 *
 * `own` names a row of the session Tenant and must match exactly `ownRows` of them —
 * an exact count rather than a lower bound, so a statement that started matching too
 * much fails here as loudly as one that leaked.
 *
 * `foreign` names the SAME row of a foreign Tenant. It must match zero rows and must
 * not raise (Requirement 14.3). It is absent only where the statement takes no
 * per-Tenant argument at all — the Audit_Log source history, whose `source_record_refs`
 * argument collides across Tenants by construction, and the chain walk and the overdue
 * sweep, which take no record identifier. For those the stripped run with own arguments
 * IS the leak detector: it names every Tenant's rows and must return only the session's.
 */
interface ProductionRead {
  readonly name: string;
  readonly table: string;
  readonly sql: string;
  /** The application-level Tenant predicate, and what the statement reads without it. */
  readonly strip?: { readonly from: string; readonly to: string };
  readonly own: (c: ReadContext) => readonly string[];
  readonly foreign?: (c: ReadContext) => readonly string[];
  readonly ownRows: (c: ReadContext) => number;
  /** Set when the statement selects `tenant_id`, so the identity can be asserted too. */
  readonly identColumn?: string;
  /** False for the three statements that call `app.current_tenant_id()`. See the header. */
  readonly verbatimRunnable?: boolean;
  /** A data-modifying statement: every run of it is wrapped in a rolled-back SAVEPOINT. */
  readonly mutates?: boolean;
}

/** Timestamps wide enough to bracket every generated date. */
const BEFORE_ALL = lit('2020-01-01T00:00:00Z');
const AFTER_ALL = lit('2030-01-01T00:00:00Z');

/** How many of a Tenant's Proposals are `awaiting_approval` with an elapsed deadline. */
function awaitingCount(profile: CollisionProfile): number {
  return profile.suffixes.filter((_s, i) => proposalState(i) === 'awaiting_approval').length;
}

const PRODUCTION_READS: readonly ProductionRead[] = [
  {
    // The one production statement that already carries NO Tenant predicate: it is the
    // read that ESTABLISHES the scope, so it filters on `user_id` alone
    // (`src/authz/session.ts`). Requirement 14.2's "independently of any Tenant filter
    // supplied by application code" is therefore not a thought experiment here — this
    // statement has no such filter to fall back on, and RLS is the only thing standing
    // between a foreign User identifier and a foreign membership row.
    name: 'TENANT_MEMBERSHIPS_SQL',
    table: 'tenant_memberships',
    sql: TENANT_MEMBERSHIPS_SQL,
    identColumn: 'tenant_id',
    own: (c) => [lit(c.session.userId)],
    foreign: (c) => [lit(c.other.userId)],
    ownRows: () => 1,
  },
  {
    name: 'GRANTED_PERMISSIONS_SQL',
    table: 'user_permissions',
    sql: GRANTED_PERMISSIONS_SQL,
    strip: { from: ' WHERE tenant_id = $1\n   AND user_id = $2', to: ' WHERE user_id = $2' },
    own: (c) => [lit(c.session.tenantId), lit(c.session.userId)],
    foreign: (c) => [lit(c.other.tenantId), lit(c.other.userId)],
    ownRows: (c) => c.profile.suffixes.length,
  },
  {
    // The fingerprint is identical in every Tenant, so the stripped form of this
    // statement names one row per Tenant and must answer with exactly one.
    name: 'EXCEPTION_STATE_PROBE_SQL',
    table: 'exceptions',
    sql: EXCEPTION_STATE_PROBE_SQL,
    strip: { from: ' WHERE tenant_id = $1\n   AND fingerprint = $2', to: ' WHERE fingerprint = $2' },
    own: (c) => [lit(c.session.tenantId), lit(textId(c.profile, 'fp', c.index))],
    foreign: (c) => [lit(c.other.tenantId), lit(textId(c.profile, 'fp', c.index))],
    ownRows: () => 1,
  },
  {
    name: 'EXCEPTION_RESOLUTION_STATE_PROBE_SQL',
    table: 'exceptions',
    sql: EXCEPTION_RESOLUTION_STATE_PROBE_SQL,
    strip: { from: ' WHERE tenant_id = $1\n   AND id = $2::uuid', to: ' WHERE id = $2::uuid' },
    own: (c) => [lit(c.session.tenantId), lit(c.session.exceptionIds[c.index] ?? '')],
    foreign: (c) => [lit(c.other.tenantId), lit(c.other.exceptionIds[c.index] ?? '')],
    ownRows: () => 1,
  },
  {
    name: 'DUPLICATE_ACTION_LOOKBACK_SQL',
    table: 'proposals',
    sql: DUPLICATE_ACTION_LOOKBACK_SQL,
    strip: {
      from: ' WHERE tenant_id = $1\n   AND target_fingerprint = $2',
      to: ' WHERE target_fingerprint = $2',
    },
    own: (c) => [
      lit(c.session.tenantId),
      lit(textId(c.profile, 'tf', c.index)),
      `array[${lit(proposalState(c.index))}]`,
      BEFORE_ALL,
      AFTER_ALL,
      'null',
    ],
    foreign: (c) => [
      lit(c.other.tenantId),
      lit(textId(c.profile, 'tf', c.index)),
      `array[${lit(proposalState(c.index))}]`,
      BEFORE_ALL,
      AFTER_ALL,
      'null',
    ],
    ownRows: () => 1,
  },
  {
    name: 'ACTION_PROPOSAL_LOAD_SQL',
    table: 'proposals',
    sql: ACTION_PROPOSAL_LOAD_SQL,
    strip: { from: ' WHERE tenant_id = $1\n   AND id = $2::uuid', to: ' WHERE id = $2::uuid' },
    own: (c) => [lit(c.session.tenantId), lit(c.session.proposalIds[c.index] ?? '')],
    foreign: (c) => [lit(c.other.tenantId), lit(c.other.proposalIds[c.index] ?? '')],
    ownRows: () => 1,
  },
  {
    name: 'PROPOSAL_EXPIRY_LOAD_SQL',
    table: 'proposals',
    sql: PROPOSAL_EXPIRY_LOAD_SQL,
    strip: { from: ' WHERE tenant_id = $1\n   AND id = $2::uuid', to: ' WHERE id = $2::uuid' },
    own: (c) => [lit(c.session.tenantId), lit(c.session.proposalIds[c.index] ?? '')],
    foreign: (c) => [lit(c.other.tenantId), lit(c.other.proposalIds[c.index] ?? '')],
    ownRows: () => 1,
  },
  {
    name: 'PROPOSAL_VERIFICATION_LOAD_SQL',
    table: 'proposals',
    sql: PROPOSAL_VERIFICATION_LOAD_SQL,
    strip: { from: ' WHERE tenant_id = $1\n   AND id = $2::uuid', to: ' WHERE id = $2::uuid' },
    own: (c) => [lit(c.session.tenantId), lit(c.session.proposalIds[c.index] ?? '')],
    foreign: (c) => [lit(c.other.tenantId), lit(c.other.proposalIds[c.index] ?? '')],
    ownRows: () => 1,
  },
  {
    name: 'PROPOSAL_FAILURE_LOAD_SQL',
    table: 'proposals',
    sql: PROPOSAL_FAILURE_LOAD_SQL,
    strip: { from: ' WHERE tenant_id = $1\n   AND id = $2::uuid', to: ' WHERE id = $2::uuid' },
    own: (c) => [lit(c.session.tenantId), lit(c.session.proposalIds[c.index] ?? '')],
    foreign: (c) => [lit(c.other.tenantId), lit(c.other.proposalIds[c.index] ?? '')],
    ownRows: () => 1,
  },
  {
    // The sweep: no record identifier at all, so its stripped form reads every Tenant's
    // overdue Proposals and must answer with only the session Tenant's.
    name: 'OVERDUE_PROPOSALS_SQL',
    table: 'proposals',
    sql: OVERDUE_PROPOSALS_SQL,
    strip: {
      from: " WHERE tenant_id = $1\n   AND state = 'awaiting_approval'",
      to: " WHERE state = 'awaiting_approval'",
    },
    own: (c) => [lit(c.session.tenantId), AFTER_ALL, '50'],
    foreign: (c) => [lit(c.other.tenantId), AFTER_ALL, '50'],
    ownRows: (c) => awaitingCount(c.profile),
  },
  {
    name: 'EXECUTION_AUTHORIZATION_LOOKUP_SQL',
    table: 'authorizations',
    sql: EXECUTION_AUTHORIZATION_LOOKUP_SQL,
    strip: {
      from: ' WHERE tenant_id = $1\n   AND proposal_id = $2::uuid',
      to: ' WHERE proposal_id = $2::uuid',
    },
    own: (c) => [
      lit(c.session.tenantId),
      lit(c.session.proposalIds[c.index] ?? ''),
      lit(c.session.authorizationIds[c.index] ?? ''),
    ],
    foreign: (c) => [
      lit(c.other.tenantId),
      lit(c.other.proposalIds[c.index] ?? ''),
      lit(c.other.authorizationIds[c.index] ?? ''),
    ],
    ownRows: () => 1,
  },
  {
    // Carries a correlated EXISTS over the same table. The subquery is RLS-filtered too,
    // which is the interesting part: `reversed` must be computed from the session
    // Tenant's rows only. Its `r.tenant_id = s.tenant_id` is a correlation, not an
    // application filter, so it is left in place when the outer filter is stripped.
    name: 'APPLIED_LEDGER_SETS_SQL',
    table: 'ledger_entry_sets',
    sql: APPLIED_LEDGER_SETS_SQL,
    strip: {
      from: ' WHERE s.tenant_id = $1\n   AND s.proposal_id = $2::uuid',
      to: ' WHERE s.proposal_id = $2::uuid',
    },
    own: (c) => [lit(c.session.tenantId), lit(c.session.proposalIds[c.index] ?? '')],
    foreign: (c) => [lit(c.other.tenantId), lit(c.other.proposalIds[c.index] ?? '')],
    ownRows: () => 1,
  },
  {
    name: 'AUDIT_SOURCE_HISTORY_SQL',
    table: 'audit_events',
    sql: AUDIT_SOURCE_HISTORY_SQL,
    verbatimRunnable: false,
    strip: {
      from: ' WHERE e.tenant_id = app.current_tenant_id()\n   AND e.source_record_refs @> $1::jsonb',
      to: ' WHERE e.source_record_refs @> $1::jsonb',
    },
    own: (c) => [lit(auditSourceRef(c.profile, c.index)), '0', '100'],
    ownRows: () => 1,
  },
  {
    name: 'AUDIT_PROPOSAL_HISTORY_SQL',
    table: 'audit_events',
    sql: AUDIT_PROPOSAL_HISTORY_SQL,
    verbatimRunnable: false,
    strip: {
      from: ' WHERE e.tenant_id = app.current_tenant_id()\n   AND e.proposal_id = $1::uuid',
      to: ' WHERE e.proposal_id = $1::uuid',
    },
    own: (c) => [lit(c.session.proposalIds[c.index] ?? '')],
    foreign: (c) => [lit(c.other.proposalIds[c.index] ?? '')],
    ownRows: () => 1,
  },
  {
    // The whole Tenant's Audit_Log, unfiltered once stripped. It selects `tenant_id`, so
    // this is the one production path where design.md's literal assertion —
    // `rows.every(r => r.tenant_id === session.tenant_id)` — is made on the statement's
    // own output columns rather than on a count.
    name: 'AUDIT_CHAIN_WALK_SQL',
    table: 'audit_events',
    sql: AUDIT_CHAIN_WALK_SQL,
    verbatimRunnable: false,
    identColumn: 'tenant_id',
    strip: {
      from: ' WHERE e.tenant_id = app.current_tenant_id()\n ORDER BY',
      to: ' ORDER BY',
    },
    own: () => [],
    ownRows: (c) => c.profile.suffixes.length,
  },
  {
    // A write path with a foreign target: Requirement 14.3's "SHALL return zero rows,
    // SHALL leave the stored record unchanged". Every run is inside a SAVEPOINT, so the
    // own-Tenant control proves the statement matches without disturbing the snapshot.
    name: 'EXCEPTION_RESOLVE_SQL',
    table: 'exceptions',
    sql: EXCEPTION_RESOLVE_SQL,
    mutates: true,
    strip: { from: ' WHERE tenant_id = $1\n   AND id = $2::uuid', to: ' WHERE id = $2::uuid' },
    own: (c) => [
      lit(c.session.tenantId),
      lit(c.session.exceptionIds[c.index] ?? ''),
      lit('p7-resolution-note'),
      AFTER_ALL,
      lit(c.session.userId),
    ],
    foreign: (c) => [
      lit(c.other.tenantId),
      lit(c.other.exceptionIds[c.index] ?? ''),
      lit('p7-resolution-note'),
      AFTER_ALL,
      lit(c.other.userId),
    ],
    ownRows: () => 1,
  },
  {
    name: 'PROPOSAL_STATE_TRANSITION_SQL',
    table: 'proposals',
    sql: PROPOSAL_STATE_TRANSITION_SQL,
    mutates: true,
    strip: { from: ' WHERE tenant_id = $1\n   AND id = $2::uuid', to: ' WHERE id = $2::uuid' },
    own: (c) => [
      lit(c.session.tenantId),
      lit(c.session.proposalIds[c.index] ?? ''),
      lit('rejected'),
      `array[${lit(proposalState(c.index))}]`,
    ],
    foreign: (c) => [
      lit(c.other.tenantId),
      lit(c.other.proposalIds[c.index] ?? ''),
      lit('rejected'),
      `array[${lit(proposalState(c.index))}]`,
    ],
    ownRows: () => 1,
  },
];

/* -------------------------------------------------------------------------- */
/* SQL emission                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Substitute SQL literal fragments for `$1..$n`, highest index first so `$1` cannot
 * eat the `$1` of a `$10`.
 *
 * Throws when a placeholder is left unbound: a production statement that grew a
 * parameter must fail here rather than reach `psql` as a syntax error inside a
 * property iteration, where the message would be attributed to a counterexample.
 */
function bind(sql: string, params: readonly string[]): string {
  let out = sql;
  for (let i = params.length; i >= 1; i -= 1) {
    out = out.replaceAll(`$${i}`, params[i - 1] ?? 'null');
  }
  if (/\$\d/.test(out)) {
    throw new Error(`unbound parameter in:\n${out}`);
  }
  return out;
}

/**
 * The production statement with its application-level Tenant predicate removed.
 *
 * `from` must be present verbatim. If a production statement is reformatted this throws,
 * which is deliberate: silently failing to strip would turn the whole point of this file
 * into a test that the application filter works.
 */
function stripped(path: ProductionRead): string {
  const strip = path.strip;
  if (strip === undefined) {
    return path.sql;
  }
  if (!path.sql.includes(strip.from)) {
    throw new Error(
      `${path.name}: the Tenant predicate to strip is no longer present verbatim. ` +
        `Expected to find:\n${strip.from}\nin:\n${path.sql}`,
    );
  }
  return path.sql.replace(strip.from, strip.to);
}

/**
 * True when a path's foreign arguments differ from its own arguments ONLY in the
 * parameter that stripping removed — so the stripped statement bound to foreign
 * arguments is character-for-character the stripped statement bound to own arguments.
 *
 * FINDING, from the first run of this property. This started life as an unconditional
 * "stripped + foreign arguments -> zero rows" probe, and it failed on
 * `EXCEPTION_STATE_PROBE_SQL`, seed 20260603, after 87 shrinks:
 *
 *   Counterexample: [{"profile":{"amounts":[1n,2n],"dates":["2026-01-01","2026-01-01"],
 *     "stem":"alpha","suffixes":["0001","0002"]},"tenantCount":2},0,0,0,0]
 *   AssertionError: tenant=a1746928
 *     EXCEPTION_STATE_PROBE_SQL/tenant_filter_omitted_foreign_target must match zero rows,
 *     not error and not match: expected 1 to be +0
 *
 * That was the TEST being wrong, not the database, and the distinction matters enough to
 * write down. `EXCEPTION_STATE_PROBE_SQL` is `WHERE tenant_id = $1 AND fingerprint = $2`.
 * Strip `tenant_id = $1` and the only surviving predicate is the fingerprint — which this
 * generator makes IDENTICAL in every Tenant on purpose. The foreign Tenant identifier
 * lived in `$1` and `$1` is gone, so the stripped statement names no foreign record at
 * all: it names one row per Tenant, and the correct answer under the policy is the
 * session's own row. The one row returned was the session's own, and the neighbouring
 * `exceptions/scan_unfiltered` probe — no predicate whatever, exactly
 * `expectedRowCount` rows, all of them the session Tenant's — had already passed in the
 * same session and the same statement batch, which is what establishes that. Demanding
 * zero would have demanded that RLS hide the session's own data.
 *
 * Three paths collapse this way, and each is the case where the surviving predicate is a
 * deliberately colliding value rather than a surrogate key: the Exception fingerprint
 * probe, the duplicate-action lookback (`target_fingerprint`), and the overdue sweep
 * (no record identifier at all). For them the leak detector is the STRIPPED OWN probe,
 * which is the same statement and asserts an exact own-Tenant row count — a query naming
 * every Tenant's colliding rows at once, which returns 2..5 times as many rows the moment
 * the policy stops filtering. Nothing is lost by not asserting the duplicate.
 *
 * Derived by comparing the bound text rather than declared in a flag, so that a statement
 * that later grows or loses a per-Tenant parameter reclassifies itself instead of leaving
 * a stale annotation behind. {@link COLLAPSING_PATHS} pins the current answer.
 */
function foreignCollapsesUnderStrip(path: ProductionRead, c: ReadContext): boolean {
  const foreignArgs = path.foreign;
  if (path.strip === undefined || foreignArgs === undefined) {
    return false;
  }
  const bare = stripped(path);
  return bind(bare, foreignArgs(c)) === bind(bare, path.own(c));
}

/** The paths {@link foreignCollapsesUnderStrip} answers true for today. */
const COLLAPSING_PATHS: readonly string[] = [
  'DUPLICATE_ACTION_LOOKBACK_SQL',
  'EXCEPTION_STATE_PROBE_SQL',
  'OVERDUE_PROPOSALS_SQL',
];

/**
 * What a probe's single output line must say.
 *
 * `allowed` is the set of Tenant identities a returned row may carry. It is empty for the
 * DML probes and for the production statements that do not select `tenant_id`, where the
 * row count is the whole assertion.
 */
type Expectation =
  | { readonly kind: 'rows'; readonly count: number; readonly allowed: readonly string[] }
  | { readonly kind: 'atLeastOne'; readonly allowed: readonly string[] }
  | { readonly kind: 'zero' };

interface Probe {
  readonly label: string;
  readonly sql: string;
  readonly expect: Expectation;
}

/** `{ n, ids }` for a statement whose inner query yields a column `v`. */
function identRead(inner: string): string {
  return `select jsonb_build_object('n', count(*), 'ids',
  coalesce(jsonb_agg(distinct v), '[]'::jsonb))::text from (${inner}) q;`;
}

/** `{ n, ids }` for a production statement, wrapped so its own text is untouched. */
function wrappedRead(sql: string, identColumn: string | undefined): string {
  const ids =
    identColumn === undefined
      ? `'[]'::jsonb`
      : `(select coalesce(jsonb_agg(distinct ${identColumn}::text), '[]'::jsonb) from q)`;
  return `with q as (\n${sql}\n)
select jsonb_build_object('n', (select count(*) from q), 'ids', ${ids})::text;`;
}

/** Rows actually affected by a DML statement, as a tuple rather than a command tag. */
function affectedRows(dml: string): string {
  return `with c as (${dml} returning 1)
select jsonb_build_object('n', count(*), 'ids', '[]'::jsonb)::text from c;`;
}

let savepoints = 0;

/** Run `sql` and discard whatever it did. Used for every own-Tenant write control. */
function inSavepoint(sql: string): string {
  savepoints += 1;
  const name = `p7_sp_${savepoints}`;
  return `savepoint ${name};\n${sql}\nrollback to savepoint ${name};`;
}

/**
 * Every row of the dataset's Tenants in one table, whole, as JSON text.
 *
 * Read as the owner before and after the read session and compared as TEXT, never
 * parsed: `to_jsonb` renders a `BIGINT` paise amount exactly, and turning it into a
 * JavaScript number to compare it would be the one thing this codebase does not do with
 * money. Every column is included, so "the targeted row is unchanged" covers columns no
 * probe names.
 */
function snapshotSql(t: TableRead, tenants: readonly TenantFixture[]): string {
  const where =
    t.ident === 'chain_id'
      ? `chain_id in (${tenants.flatMap((f) => f.chainIds).map(lit).join(', ')})`
      : `tenant_id in (${tenants.map((f) => lit(f.tenantId)).join(', ')})`;
  return `select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb)::text
  from ${t.table} t where ${where};`;
}

/* -------------------------------------------------------------------------- */
/* The read paths, per session Tenant                                         */
/* -------------------------------------------------------------------------- */

/**
 * Every read path exercised under one session Tenant.
 *
 * design.md's generator note asks for `fc.constantFrom(...allReadPaths)` crossed with
 * generated arguments. The arguments are generated — which row index, which session
 * Tenant, which foreign Tenant, which table takes the `WITH CHECK` probe — but the path
 * list itself is exhaustive rather than sampled. With 20 tables and 17 production
 * statements, sampling one path per iteration would leave most of them exercised a
 * handful of times in 100 runs, and the paths are cheap once the session is open: the
 * connection is the cost, not the statement.
 */
function probesFor(c: ReadContext, tenants: readonly TenantFixture[]): readonly Probe[] {
  const probes: Probe[] = [];
  const amount = (c.profile.amounts[c.index] ?? 1n).toString();
  const date = lit(c.profile.dates[0] ?? '2026-01-01');
  const others = tenants.filter((f) => f.tenantId !== c.session.tenantId);

  for (const t of TABLES) {
    const allowed = [...t.identOf(c.session)].sort();

    // 1. The application filter is not merely omitted here, it does not exist: no
    //    predicate of any kind. Every row of every Tenant in the table is a candidate,
    //    including every row every earlier iteration and every other suite committed.
    probes.push({
      label: `${t.table}/scan_unfiltered`,
      sql: identRead(`select ${t.ident}::text as v from ${t.table}`),
      expect: {
        kind: 'rows',
        count: expectedRowCount(t.table, c.profile),
        allowed,
      },
    });

    // 2. Filtered on a colliding amount alone. Every Tenant holds this exact paise
    //    value, so the predicate names one row per Tenant.
    if (t.money !== undefined) {
      probes.push({
        label: `${t.table}/collision_amount`,
        sql: identRead(
          `select ${t.ident}::text as v from ${t.table} where ${t.money} = ${amount}`,
        ),
        expect: { kind: 'atLeastOne', allowed },
      });

      // 3. The dashboard shape: order by money, take the top. With amounts colliding
      //    across Tenants, a leak puts a foreign row in the first page.
      probes.push({
        label: `${t.table}/top_by_amount`,
        sql: identRead(
          `select ${t.ident}::text as v from ${t.table}
             order by ${t.money} desc, ${t.ident} limit 3`,
        ),
        expect: { kind: 'atLeastOne', allowed },
      });
    }

    // 4. Filtered on a colliding date alone.
    if (t.dateExpr !== undefined) {
      probes.push({
        label: `${t.table}/collision_date`,
        sql: identRead(
          `select ${t.ident}::text as v from ${t.table} where ${t.dateExpr} = ${date}::date`,
        ),
        expect: { kind: 'atLeastOne', allowed },
      });
    }

    // 5. Filtered on the shared identifier prefix: every Tenant's rows at once.
    if (t.text !== undefined) {
      probes.push({
        label: `${t.table}/similar_identifier`,
        sql: identRead(
          `select ${t.ident}::text as v from ${t.table}
             where ${t.text} like ${lit(`${TEXT_ID_PREFIX}%`)}`,
        ),
        expect: { kind: 'atLeastOne', allowed },
      });
    }

    // 6. Arguments naming foreign Tenants' records explicitly — the Tenant identifier
    //    of every Tenant in the dataset appears in the statement text.
    probes.push({
      label: `${t.table}/foreign_keys_named`,
      sql: identRead(
        `select ${t.ident}::text as v from ${t.table} where ${tenants
          .map((f) => `(${t.key(f, c.profile, c.index)})`)
          .join(' or ')}`,
      ),
      expect: { kind: 'atLeastOne', allowed },
    });

    if (t.update !== undefined) {
      // 7. A foreign UPDATE target: zero rows, no error, row unchanged. The "unchanged"
      //    half is the before/after snapshot; the "no error" half is the assertion that
      //    the session raised nothing at all.
      for (const f of others) {
        probes.push({
          label: `${t.table}/foreign_update`,
          sql: affectedRows(
            `update ${t.table} set ${t.update} where ${t.key(f, c.profile, c.index)}`,
          ),
          expect: { kind: 'zero' },
        });
        probes.push({
          label: `${t.table}/foreign_delete`,
          sql: affectedRows(`delete from ${t.table} where ${t.key(f, c.profile, c.index)}`),
          expect: { kind: 'zero' },
        });
      }

      // 8. The same statement against the session Tenant's own row, so the zeros above
      //    are attributable to the policy rather than to a predicate matching nothing.
      //    Discarded immediately: the snapshot comparison must see no change at all.
      probes.push({
        label: `${t.table}/own_update_control`,
        sql: inSavepoint(
          affectedRows(
            `update ${t.table} set ${t.update} where ${t.key(c.session, c.profile, c.index)}`,
          ),
        ),
        expect: { kind: 'atLeastOne', allowed: [] },
      });
    }
  }

  for (const path of PRODUCTION_READS) {
    const identityAllowed = path.identColumn === undefined ? [] : [c.session.tenantId];
    const wrap = (sql: string): string => (path.mutates === true ? inSavepoint(sql) : sql);

    if (path.verbatimRunnable !== false) {
      probes.push({
        label: `${path.name}/verbatim_own`,
        sql: wrap(wrappedRead(bind(path.sql, path.own(c)), path.identColumn)),
        expect: { kind: 'rows', count: path.ownRows(c), allowed: identityAllowed },
      });
      if (path.foreign !== undefined) {
        probes.push({
          label: `${path.name}/verbatim_foreign_target`,
          sql: wrap(wrappedRead(bind(path.sql, path.foreign(c)), path.identColumn)),
          expect: { kind: 'zero' },
        });
      }
    }

    if (path.strip !== undefined) {
      const bare = stripped(path);
      probes.push({
        label: `${path.name}/tenant_filter_omitted_own`,
        sql: wrap(wrappedRead(bind(bare, path.own(c)), path.identColumn)),
        expect: { kind: 'rows', count: path.ownRows(c), allowed: identityAllowed },
      });
      // A foreign-target probe is only meaningful where the stripped statement can still
      // NAME a foreign record. For three of these paths it cannot: see
      // {@link foreignCollapsesUnderStrip}. Asserting zero there would be asserting that
      // RLS hides the session's OWN rows.
      if (path.foreign !== undefined && !foreignCollapsesUnderStrip(path, c)) {
        probes.push({
          label: `${path.name}/tenant_filter_omitted_foreign_target`,
          sql: wrap(wrappedRead(bind(bare, path.foreign(c)), path.identColumn)),
          expect: { kind: 'zero' },
        });
      }
    }
  }

  return probes;
}

/**
 * Every read path in a fresh application-role session that has never assigned
 * `request.jwt.claims`. There is deliberately no positive own-Tenant control in this
 * phase: with no scope, no row is own. The same committed dataset receives scoped
 * positive controls immediately afterwards in the same database session.
 *
 * Statements carrying an application Tenant predicate are run stripped, because the
 * no-session invariant is about the RLS boundary rather than `tenant_id = $1`. The three
 * audit statements that call `app.current_tenant_id()` also become runnable after that
 * stripping despite `authenticated` having no direct `USAGE` on schema `app`.
 */
function unscopedProbes(c: ReadContext): readonly Probe[] {
  const probes: Probe[] = TABLES.map((t) => ({
    label: `no_session/${t.table}/scan_unfiltered`,
    sql: identRead(`select ${t.ident}::text as v from ${t.table}`),
    expect: { kind: 'zero' },
  }));

  for (const path of PRODUCTION_READS) {
    if (path.mutates === true) {
      continue;
    }
    const sql = path.strip === undefined ? path.sql : stripped(path);
    probes.push({
      label: `no_session/${path.name}`,
      sql: wrappedRead(bind(sql, path.own(c)), path.identColumn),
      expect: { kind: 'zero' },
    });
  }

  return probes;
}

/* -------------------------------------------------------------------------- */
/* The other direction: an INSERT carrying a foreign Tenant identity          */
/* -------------------------------------------------------------------------- */

/**
 * `WITH CHECK` rejects rather than filters, so this direction is an ERROR and not a
 * silent zero (Requirement 14.3, 14.7).
 *
 * Three single-row templates, one drawn per iteration. Each carries a freshly generated
 * primary key and a freshly generated text identifier, so the rejection cannot be a
 * unique-constraint violation wearing a row-level-security message. The exhaustive
 * per-table version of this is task 26.4's; what is added here is that the target Tenant
 * is one the session can see rows collide with, drawn from the generated dataset.
 */
const CHECK_INSERTS: readonly {
  readonly table: string;
  readonly sql: (f: TenantFixture, p: CollisionProfile, i: number, fresh: string) => string;
}[] = [
  {
    table: 'exceptions',
    sql: (f, p, i, fresh) =>
      `insert into exceptions
         (id, tenant_id, category, lifecycle_state, impact_paise, fingerprint)
       values (${lit(fresh)}, ${lit(f.tenantId)}, 'settlement_mismatch', 'open',
               ${(p.amounts[i] ?? 1n).toString()}, ${lit(`p7-check-${fresh}`)});`,
  },
  {
    table: 'settlement_reconciliations',
    sql: (f, p, i, fresh) =>
      `insert into settlement_reconciliations
         (id, tenant_id, settlement_id, settlement_date, received_paise, status, run_id)
       values (${lit(fresh)}, ${lit(f.tenantId)}, ${lit(`p7-check-${fresh}`)},
               ${lit(p.dates[i] ?? '2026-01-01')}::date, ${(p.amounts[i] ?? 1n).toString()},
               'unreconciled', ${lit(f.runId)});`,
  },
  {
    table: 'razorpay_objects',
    sql: (f, p, i, fresh) =>
      `insert into razorpay_objects
         (id, tenant_id, razorpay_id, object_type, ingestion_run_id, created_at_rzp,
          amount_paise, payload)
       values (${lit(fresh)}, ${lit(f.tenantId)}, ${lit(`p7-check-${fresh}`)}, 'payment',
               ${lit(f.runId)}, ${lit(p.dates[i] ?? '2026-01-01')}::timestamptz,
               ${(p.amounts[i] ?? 1n).toString()}, '{}'::jsonb);`,
  },
];

/* -------------------------------------------------------------------------- */
/* Running one iteration                                                      */
/* -------------------------------------------------------------------------- */

/** The dataset, committed after an explicit local truncate-and-reseed transaction. */
function seed(dataset: MultiTenantDataset): void {
  const body = dataset.tenants
    .map((f) => `${provision(f)}\n${tenantRowsSql(dataset.profile, f)}`)
    .join('\n');
  // `runOk` throws with the raw stderr, so a fixture/reset fault is never reported as a
  // property failure. The COMMIT is what exposes rows to the read session and fires the
  // deferred ledger balance trigger.
  runOk(`begin;\n${truncateCommittedDatasetSql()}\n${body}\ncommit;`);
}

interface ProbeOutcome {
  readonly n: number;
  readonly ids: readonly string[];
}

function checkProbe(label: string, outcome: ProbeOutcome, e: Expectation): void {
  const foreign = e.kind === 'zero' ? outcome.ids : outcome.ids.filter((id) => !e.allowed.includes(id));
  expect(foreign, `${label} returned rows of another Tenant`).toEqual([]);
  switch (e.kind) {
    case 'rows':
      expect(outcome.n, `${label} row count`).toBe(e.count);
      break;
    case 'atLeastOne':
      expect(
        outcome.n,
        `${label} matched nothing for the session Tenant, so its zero-foreign result is vacuous`,
      ).toBeGreaterThan(0);
      break;
    case 'zero':
      expect(outcome.n, `${label} must match zero rows, not error and not match`).toBe(0);
      break;
  }
}

/* -------------------------------------------------------------------------- */
/* The property                                                               */
/* -------------------------------------------------------------------------- */

describe.skipIf(!reachable)('P7: Tenant isolation (task 26.3)', () => {
  afterAll(() => {
    truncateCommittedDataset();
  });

  it('returns zero foreign rows on every read path, for every session', () => {
    fc.assert(
      fc.property(
        arbitraryMultiTenantDataset,
        fc.nat({ max: 15 }),
        fc.nat({ max: 15 }),
        fc.nat({ max: 15 }),
        fc.nat({ max: 15 }),
        (plan, rawIndex, rawFirst, rawStep, rawCheck) => {
          // Identifiers are minted here rather than drawn, so a shrink replay of this
          // same plan gets a disjoint Tenant namespace and cannot collide with the
          // committed rows of the invocation that produced it.
          const dataset = materialize(plan);
          const { profile, tenants } = dataset;
          const index = rawIndex % profile.suffixes.length;

          // Two session Tenants per iteration, distinct, drawn from the dataset. The
          // remaining 0..3 are foreign for this iteration. See the header's session
          // budget note.
          const first = rawFirst % tenants.length;
          const second = (first + 1 + (rawStep % (tenants.length - 1))) % tenants.length;
          const sessions = [tenants[first], tenants[second]].filter(
            (f): f is TenantFixture => f !== undefined,
          );

          seed(dataset);

          const before = TABLES.map((t) => snapshotSql(t, tenants));
          const after = before;

          const blocks = sessions.map((session) => {
            const other =
              tenants.find((f) => f.tenantId !== session.tenantId) ?? session;
            return { session, probes: probesFor({ profile, session, other, index }, tenants) };
          });
          const unscopedSession = sessions[0];
          if (unscopedSession === undefined) {
            throw new Error('a generated dataset must provide a session Tenant');
          }
          const unscopedOther =
            tenants.find((f) => f.tenantId !== unscopedSession.tenantId) ?? unscopedSession;
          const unscoped = unscopedProbes({
            profile,
            session: unscopedSession,
            other: unscopedOther,
            index,
          });

          const checkTarget = tenants[(first + 1) % tenants.length] ?? tenants[0];
          const checkTemplate = CHECK_INSERTS[rawCheck % CHECK_INSERTS.length];
          const fresh = randomUUID();
          const checkInsert =
            checkTarget === undefined || checkTemplate === undefined
              ? ''
              : `savepoint p7_check;\n${checkTemplate.sql(checkTarget, profile, index, fresh)}\nrollback to savepoint p7_check;`;

          const script = `begin;
${before.join('\n')}
-- Transactional GRANT: gone at ROLLBACK, and never on an append-only table.
grant select, insert, update, delete on ${MUTABLE_TABLES.join(', ')} to authenticated;
set local role authenticated;
-- This connection has never assigned request.jwt.claims: every read must fail closed.
${unscoped.map((p) => p.sql).join('\n')}
${blocks
  .map(
    (b, i) =>
      `${claims(b.session)}\n${b.probes.map((p) => p.sql).join('\n')}` +
      (i === 0 ? `\n${checkInsert}` : ''),
  )
  .join('\n')}
reset role;
${after.join('\n')}
rollback;`;

          const r = runScript(script);

          // Exactly one error, and it is the WITH CHECK rejection. Everything else in the
          // session — unscoped reads and every foreign SELECT, UPDATE and DELETE — must
          // have filtered rather than raised, so any extra error is a failure.
          expect(r.errors.map((e) => e.sqlstate), r.rawErr).toEqual([INSUFFICIENT_PRIVILEGE]);
          expect(r.errors[0]?.message, r.rawErr).toContain(
            'violates row-level security policy',
          );

          const probeCount = blocks.reduce((sum, b) => sum + b.probes.length, 0);
          expect(r.out.length, 'one output line per snapshot and per probe').toBe(
            before.length + unscoped.length + probeCount + after.length,
          );

          // Every row of every Tenant in the dataset, whole and unparsed, before and
          // after: "the targeted row is unchanged", over every column.
          for (const [i, t] of TABLES.entries()) {
            expect(
              r.out[before.length + unscoped.length + probeCount + i],
              `${t.table} changed during a session that only rolled back own-row controls`,
            ).toBe(r.out[i]);
          }

          let line = before.length;
          for (const p of unscoped) {
            checkProbe(p.label, jsonAt<ProbeOutcome>(r, line), p.expect);
            line += 1;
          }
          for (const b of blocks) {
            for (const p of b.probes) {
              checkProbe(
                `tenant=${b.session.tenantId.slice(0, 8)} ${p.label}`,
                jsonAt<ProbeOutcome>(r, line),
                p.expect,
              );
              line += 1;
            }
          }
        },
      ),
      PARAMS,
    );
  });

  /**
   * Guards the table list, exactly as 26.4 guards its own: a table given policies later
   * but not added here would otherwise be silently unquantified, which is the failure
   * mode this file exists to make impossible.
   */
  it('exercises every table in public that carries a policy', () => {
    const r = runOk(`select coalesce(jsonb_agg(distinct c.relname), '[]'::jsonb)::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_policy p on p.polrelid = c.oid
 where n.nspname = 'public' and c.relkind = 'r';`);
    expect(
      [...jsonAt<readonly string[]>(r, 0)].sort(),
      'a table carries RLS policies but no entry in TABLES: add it to the read paths',
    ).toEqual(TABLES.map((t) => t.table).sort());
  });
});

/* -------------------------------------------------------------------------- */
/* Catalogue self-checks. No database: these are about the statement text.     */
/* -------------------------------------------------------------------------- */

describe('P7 read-path catalogue', () => {
  /**
   * Regression for seed 20260603, shrunk path
   * `0:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:2:1:1:1:1:1:1:1:1:2:2:4:4:4`.
   * A generated index of 2 used to query `tenant_memberships.created_at` at the third
   * row's date even though that table has one row seeded at `profile.dates[0]`, making
   * the own-row control vacuous. Every date-bearing table has a row at the first date.
   */
  it('uses the shared first-row date for collision-date positive controls', () => {
    const profile: CollisionProfile = {
      amounts: [1n, 2n, 3n],
      dates: ['2026-01-01', '2026-01-01', '2026-01-02'],
      stem: 'alpha',
      suffixes: ['0001', '0002', '0003'],
    };
    const dataset = materialize({ profile, tenantCount: 2 });
    const [session, other] = dataset.tenants;
    if (session === undefined || other === undefined) {
      throw new Error('the regression dataset must hold two Tenants');
    }

    const probe = probesFor({ profile, session, other, index: 2 }, dataset.tenants).find(
      (candidate) => candidate.label === 'tenant_memberships/collision_date',
    );
    expect(probe?.sql).toContain("'2026-01-01'::date");
    expect(probe?.sql).not.toContain("'2026-01-02'::date");
  });

  it('strips the application-level Tenant predicate out of every statement that has one', () => {
    for (const path of PRODUCTION_READS) {
      if (path.strip === undefined) {
        continue;
      }
      const bare = stripped(path);
      expect(bare, `${path.name} was not changed by stripping`).not.toBe(path.sql);
      expect(bare, `${path.name} still filters on a Tenant after stripping`).not.toMatch(
        /tenant_id\s*=\s*\$1|tenant_id\s*=\s*app\.current_tenant_id\(\)/,
      );
    }
  });

  /**
   * Pins which stripped statements can no longer name a foreign record, and asserts the
   * reason rather than the list alone: for a collapsing path the two bound texts are
   * equal, and for every other path they differ. See {@link foreignCollapsesUnderStrip}.
   *
   * A path that joins or leaves this set changes what the property asserts about it, so it
   * fails here first and is decided deliberately.
   */
  it('records the stripped paths whose foreign arguments collapse onto their own', () => {
    const [plan] = fc.sample(arbitraryMultiTenantDataset, { numRuns: 1, seed: SEED });
    if (plan === undefined) {
      throw new Error('the generator produced no dataset plan');
    }
    const dataset = materialize(plan);
    const [session, other] = dataset.tenants;
    if (session === undefined || other === undefined) {
      throw new Error('a dataset must hold at least two Tenants');
    }
    const c: ReadContext = { profile: dataset.profile, session, other, index: 0 };

    const collapsing = PRODUCTION_READS.filter((p) => foreignCollapsesUnderStrip(p, c)).map(
      (p) => p.name,
    );
    expect(collapsing.sort()).toEqual([...COLLAPSING_PATHS]);

    for (const path of PRODUCTION_READS) {
      const foreignArgs = path.foreign;
      if (path.strip === undefined || foreignArgs === undefined) {
        continue;
      }
      const bare = stripped(path);
      const ownBound = bind(bare, path.own(c));
      const foreignBound = bind(bare, foreignArgs(c));
      if (COLLAPSING_PATHS.includes(path.name)) {
        expect(
          foreignBound,
          `${path.name}: the foreign argument survives stripping, so it should be probed for zero rows`,
        ).toBe(ownBound);
      } else {
        expect(
          foreignBound,
          `${path.name}: stripping left nothing that names the foreign record`,
        ).not.toBe(ownBound);
      }
    }
  });

  it('binds every parameter of every catalogued statement, verbatim and stripped', () => {
    const [plan] = fc.sample(arbitraryMultiTenantDataset, { numRuns: 1, seed: SEED });
    if (plan === undefined) {
      throw new Error('the generator produced no dataset plan');
    }
    const dataset = materialize(plan);
    const [session, other] = dataset.tenants;
    if (session === undefined || other === undefined) {
      throw new Error('a dataset must hold at least two Tenants');
    }
    const c: ReadContext = { profile: dataset.profile, session, other, index: 0 };
    for (const path of PRODUCTION_READS) {
      const foreignArgs = path.foreign;
      for (const sql of [path.sql, stripped(path)]) {
        expect(() => bind(sql, path.own(c)), `${path.name} own arguments`).not.toThrow();
        if (foreignArgs !== undefined) {
          expect(() => bind(sql, foreignArgs(c)), `${path.name} foreign arguments`).not.toThrow();
        }
      }
    }
  });

  /**
   * The reason three statements are stripped-only. If a later task gives `authenticated`
   * `USAGE` on schema `app`, or rewrites these predicates to take a Tenant parameter,
   * this test fails and `verbatimRunnable` should be reconsidered — which is the point of
   * asserting it rather than leaving it in a comment.
   */
  it('records which statements cannot run as the application role today', () => {
    const unrunnable = PRODUCTION_READS.filter((p) => p.verbatimRunnable === false).map(
      (p) => p.name,
    );
    expect(unrunnable.sort()).toEqual([
      'AUDIT_CHAIN_WALK_SQL',
      'AUDIT_PROPOSAL_HISTORY_SQL',
      'AUDIT_SOURCE_HISTORY_SQL',
    ]);
    for (const path of PRODUCTION_READS) {
      const callsAppSchema = path.sql.includes('app.current_tenant_id()');
      expect(callsAppSchema, `${path.name}: app schema use and verbatimRunnable disagree`).toBe(
        path.verbatimRunnable === false,
      );
    }
  });
});
