/**
 * `arbitraryMultiTenantDataset` — design.md's P7 generator input (task 26.3).
 *
 * design.md, Property 7: "2 to 5 Tenants, each with an `arbitraryTenantDataset`, with
 * deliberately colliding non-key values across Tenants (equal amounts, equal dates,
 * similar identifiers) so that a leak is detectable rather than coincidentally
 * invisible."
 *
 * THE COLLISION IS EXACT, NOT MERELY LIKELY
 * -----------------------------------------
 * The amounts, the dates and the textual identifiers are drawn ONCE per dataset and
 * every Tenant is seeded from that one {@link CollisionProfile}. So Tenant A's
 * settlement and Tenant D's settlement carry the same `received_paise` to the paisa,
 * the same `settlement_date`, and the same `settlement_id` text. Nothing in a returned
 * row distinguishes the Tenants except `tenant_id` itself, which is precisely the
 * condition under which a filter that silently stopped working would still look
 * plausible. Drawing per Tenant would make collisions rare and the property weak.
 *
 * Only three kinds of value are allowed to differ per Tenant: the Tenant identifier,
 * the User identifier, and the surrogate UUID primary keys — because those are
 * globally unique by construction and cannot collide. Every tenant-scoped uniqueness
 * constraint in the schema is keyed on `tenant_id` first
 * (`razorpay_objects_tenant_rzp_uniq`, `ledger_set_derivation_uniq`,
 * `exceptions_fingerprint_uniq`, `audit_events_sequence_uniq`, `settlement_recon_uniq`,
 * and every composite primary key), so identical text and identical amounts across
 * Tenants are accepted by the database rather than rejected — which is what makes this
 * generator possible at all.
 *
 * MONEY IS `bigint`, NEVER A NUMBER
 * ---------------------------------
 * Amounts are drawn as `bigint` and rendered as digit text into SQL. The columns are
 * `paise`, `paise_positive` and `paise_ingested` — all `BIGINT` domains — and a value
 * near the top of `paise_ingested` (999,999,999,999) is beyond the exact range of a
 * double, so a JSON number would silently change the amount being compared
 * (Requirement 15.1, 15.8). The draw is bounded at 999,999,999,999 so one value is
 * legal in all three domains at once and the same amount can be seeded into every
 * money column.
 *
 * WHY THE GENERATOR PRODUCES A PLAN AND NOT THE IDENTIFIERS
 * ---------------------------------------------------------
 * {@link arbitraryMultiTenantDataset} draws a {@link MultiTenantDatasetPlan} — the
 * collision profile and a Tenant count — and {@link materialize} mints the UUIDs, once
 * per invocation, from `randomUUID()`. The identifiers are deliberately NOT part of the
 * generated value, and the reason is a real failure that was observed before it was
 * fixed: the dataset is COMMITTED (see the header of
 * `p7-tenant-isolation.property.test.ts`), and fast-check replays the same generated
 * value while shrinking, so a value that carried its own UUIDs was seeded twice and the
 * second attempt died on `tenants_pkey`. Minting inside the property body means every
 * invocation, shrink attempts included, gets a disjoint Tenant namespace.
 *
 * Nothing is lost from the counterexample: no property here is about the value of a UUID,
 * and everything that shapes the test — how many Tenants, which amounts, which dates,
 * which identifier stem — is drawn from fast-check and does shrink. It is also what makes
 * a counterexample legible, since a printed plan is four lines rather than a page of
 * random hex.
 *
 * WHAT IS SEEDED
 * --------------
 * All 20 tenant-scoped tables that carry RLS policies today, per Tenant, so that every
 * read path this dataset is queried through has a non-empty own-Tenant answer. A path
 * that returned zero rows for the session Tenant would satisfy "zero foreign rows"
 * vacuously; {@link expectedRowCount} is what lets the property refuse that.
 *
 * The row shapes follow `test/db/rls-per-table.test.ts` (task 26.4), which established
 * the minimal legal insert for each of these tables. Where a production read path needs
 * a particular column populated to match at all — `proposals.state`,
 * `proposals.approval_deadline`, `ledger_entry_sets.proposal_id`,
 * `audit_events.stage`, `audit_events.source_record_refs`,
 * `exceptions.lifecycle_state` — this seed populates it, so those statements are
 * exercised against rows they actually select rather than against an empty table.
 */

import { randomUUID } from 'node:crypto';
import fc from 'fast-check';

import { lit, type Fixture } from '../db/pg';

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The values every Tenant in a dataset shares, so that rows collide across the Tenant
 * boundary on everything except `tenant_id`.
 */
export interface CollisionProfile {
  /** Integer paise, legal in `paise`, `paise_positive` and `paise_ingested` alike. */
  readonly amounts: readonly bigint[];
  /** `YYYY-MM-DD`. One per row index, reused for dates and timestamps. */
  readonly dates: readonly string[];
  /** The identifier stem, so `p7-<stem>-pay-0001` is one Tenant's row and another's. */
  readonly stem: string;
  /** `0001`, `0002`, ... — one per row index. Identifiers differ only here. */
  readonly suffixes: readonly string[];
}

/** One Tenant's identifiers. Extends {@link Fixture} so `provision` accepts it. */
export interface TenantFixture extends Fixture {
  /** Surrogate keys, one per row index of the profile. */
  readonly setIds: readonly string[];
  /** Two entries per set: `[debit, credit]`. */
  readonly entryIds: readonly (readonly [string, string])[];
  readonly exceptionIds: readonly string[];
  readonly chainIds: readonly string[];
  readonly proposalIds: readonly string[];
  readonly authorizationIds: readonly string[];
  readonly auditIds: readonly string[];
  readonly settlementIds: readonly string[];
  readonly razorpayIds: readonly string[];
  readonly ingestionRunIds: readonly string[];
}

/** What the generator draws: a collision profile and how many Tenants share it. */
export interface MultiTenantDatasetPlan {
  readonly profile: CollisionProfile;
  readonly tenantCount: number;
}

/** 2..5 Tenants over one collision profile, with identifiers minted. */
export interface MultiTenantDataset {
  readonly profile: CollisionProfile;
  readonly tenants: readonly TenantFixture[];
}

/** How many rows of `table` this dataset seeds per Tenant. Exact, not a bound. */
export function expectedRowCount(table: string, profile: CollisionProfile): number {
  const n = profile.suffixes.length;
  switch (table) {
    // `provision` seeds exactly one of each of these per Tenant.
    case 'audit_sequence_counters':
    case 'tenant_memberships':
    case 'tenant_configuration':
      return 1;
    // Two accounts from `provision`, nothing added here.
    case 'chart_of_accounts':
      return 2;
    // `provision`'s run, plus one per row index.
    case 'ingestion_runs':
      return n + 1;
    // One debit and one credit per set.
    case 'ledger_entries':
    case 'ledger_entry_sources':
      return 2 * n;
    default:
      return n;
  }
}

/* -------------------------------------------------------------------------- */
/* Generators                                                                 */
/* -------------------------------------------------------------------------- */

/** The first day of the window every generated date falls in. */
const DATE_BASE = Date.UTC(2026, 0, 1);

/** `YYYY-MM-DD`, `offset` days after {@link DATE_BASE}. */
function dayAt(offset: number): string {
  return new Date(DATE_BASE + offset * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Amounts, dates and an identifier stem, shared by every Tenant of one dataset.
 *
 * Two or three row indexes: enough that a within-Tenant identifier set exists (so the
 * `LIKE 'p7-%'` and `IN (...)` read paths match more than one row) without multiplying
 * the seed cost, which is paid on every one of the 100 iterations. The amounts are
 * drawn distinct so that the `ORDER BY amount DESC LIMIT` read path has a definite
 * answer per Tenant; the dates are not, because a repeated date is realistic and
 * harmless.
 */
export const arbitraryCollisionProfile: fc.Arbitrary<CollisionProfile> = fc
  .record({
    rows: fc.integer({ min: 2, max: 3 }),
    amounts: fc.uniqueArray(fc.bigInt({ min: 1n, max: 999_999_999_999n }), {
      minLength: 3,
      maxLength: 3,
    }),
    dayOffsets: fc.array(fc.integer({ min: 0, max: 364 }), { minLength: 3, maxLength: 3 }),
    stem: fc.constantFrom('alpha', 'beta', 'gamma', 'delta'),
  })
  .map(({ rows, amounts, dayOffsets, stem }) => ({
    amounts: amounts.slice(0, rows),
    dates: dayOffsets.slice(0, rows).map(dayAt),
    stem,
    suffixes: ['0001', '0002', '0003'].slice(0, rows),
  }));

/** Fresh identifiers for one Tenant over `rows` row indexes. See the header. */
function newTenantFixture(rows: number): TenantFixture {
  const ids = (): readonly string[] => Array.from({ length: rows }, () => randomUUID());
  return {
    tenantId: randomUUID(),
    userId: randomUUID(),
    runId: randomUUID(),
    debitAccount: '1000',
    creditAccount: '4000',
    setIds: ids(),
    entryIds: Array.from({ length: rows }, () => [randomUUID(), randomUUID()] as const),
    exceptionIds: ids(),
    chainIds: ids(),
    proposalIds: ids(),
    authorizationIds: ids(),
    auditIds: ids(),
    settlementIds: ids(),
    razorpayIds: ids(),
    ingestionRunIds: ids(),
  };
}

/**
 * design.md's P7 input: 2 to 5 Tenants over one shared {@link CollisionProfile}.
 *
 * The Tenant count is the load-bearing draw. With 2 Tenants a leak has one place to
 * come from; with 5 the session Tenant is outnumbered 4 to 1, so an unfiltered read
 * that returned everything would return four times as many foreign rows as own rows.
 */
export const arbitraryMultiTenantDataset: fc.Arbitrary<MultiTenantDatasetPlan> = fc.record({
  profile: arbitraryCollisionProfile,
  tenantCount: fc.integer({ min: 2, max: 5 }),
});

/**
 * Mint one Tenant namespace per Tenant of the plan. Called once per property invocation,
 * never memoised: see the header.
 */
export function materialize(plan: MultiTenantDatasetPlan): MultiTenantDataset {
  return {
    profile: plan.profile,
    tenants: Array.from({ length: plan.tenantCount }, () =>
      newTenantFixture(plan.profile.suffixes.length),
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Identifier naming — shared across Tenants, so it collides                  */
/* -------------------------------------------------------------------------- */

/** Every text identifier this seed writes starts here, so `LIKE 'p7-%'` finds them. */
export const TEXT_ID_PREFIX = 'p7-';

/** `p7-<stem>-<kind>-<suffix>`. Identical for every Tenant of the dataset. */
export function textId(profile: CollisionProfile, kind: string, index: number): string {
  return `${TEXT_ID_PREFIX}${profile.stem}-${kind}-${profile.suffixes[index] ?? '0000'}`;
}

/** The six Permissions, in order; a Tenant is granted the first `rows` of them. */
const PERMISSIONS: readonly string[] = [
  'view_financial_data',
  'run_agents',
  'approve_sensitive_actions',
  'configure_policy',
  'manage_credentials',
  'manage_users',
];

/**
 * `proposals.state` per row index, alternating.
 *
 * `awaiting_approval` with an elapsed `approval_deadline` is what
 * `OVERDUE_PROPOSALS_SQL` selects; `executed` with an `executed_at` is what the
 * duplicate-action lookback selects. Both are seeded so both production read paths
 * have an own-Tenant answer.
 */
export function proposalState(index: number): 'awaiting_approval' | 'executed' {
  return index % 2 === 0 ? 'awaiting_approval' : 'executed';
}

/** The `source_record_refs` entry an Audit_Event of row `index` cites. */
export function auditSourceRef(profile: CollisionProfile, index: number): string {
  return JSON.stringify([{ type: 'payment', id: textId(profile, 'pay', index) }]);
}

/* -------------------------------------------------------------------------- */
/* The seed                                                                   */
/* -------------------------------------------------------------------------- */

/** Digit text for a `BIGINT` money column. Never a JSON number. */
function money(value: bigint): string {
  return value.toString();
}

/**
 * Every row of one Tenant, as SQL, excluding what `provision` already inserts.
 *
 * Written as the table owner, which holds `BYPASSRLS`, so `FORCE ROW LEVEL SECURITY`
 * does not filter the seed. Nothing here runs as `authenticated`; the application role
 * appears only in the read session, which is where the property is actually asserted.
 */
export function tenantRowsSql(profile: CollisionProfile, f: TenantFixture): string {
  const rows = profile.suffixes.length;

  // The membership comes first: `user_permissions` has a composite foreign key onto
  // `tenant_memberships (tenant_id, user_id)`, so a Permission cannot be granted to a
  // User who is not yet a member.
  const parts: string[] = [
    `insert into tenant_memberships (tenant_id, user_id, created_at)
       values (${lit(f.tenantId)}, ${lit(f.userId)}, ${lit(profile.dates[0] ?? '2026-01-01')}::timestamptz);`,
    `insert into tenant_configuration (tenant_id, auto_execute_threshold)
       values (${lit(f.tenantId)}, 10);`,
  ];

  for (let i = 0; i < rows; i += 1) {
    const amount = profile.amounts[i] ?? 1n;
    const date = profile.dates[i] ?? '2026-01-01';
    const setId = f.setIds[i] ?? '';
    const [debitId, creditId] = f.entryIds[i] ?? ['', ''];
    const chainId = f.chainIds[i] ?? '';
    const exceptionId = f.exceptionIds[i] ?? '';
    const proposalId = f.proposalIds[i] ?? '';

    parts.push(
      // -- ingestion -------------------------------------------------------
      `insert into ingestion_runs (id, tenant_id, window_from, window_basis, initiated_by)
         values (${lit(f.ingestionRunIds[i] ?? '')}, ${lit(f.tenantId)}, ${lit(date)}::timestamptz,
                 'first_run_365d', ${lit(f.userId)});`,

      `insert into ingestion_errors
         (tenant_id, ingestion_run_id, object_type, error_code, error_category, requested_at)
       values (${lit(f.tenantId)}, ${lit(f.runId)}, 'payment',
               ${lit(textId(profile, 'err', i))}, 'timeout', ${lit(date)}::timestamptz);`,

      `insert into razorpay_objects
         (id, tenant_id, razorpay_id, object_type, ingestion_run_id, created_at_rzp,
          amount_paise, payload)
       values (${lit(f.razorpayIds[i] ?? '')}, ${lit(f.tenantId)}, ${lit(textId(profile, 'pay', i))},
               'payment', ${lit(f.runId)}, ${lit(date)}::timestamptz, ${money(amount)},
               '{}'::jsonb);`,

      // -- evidence chains, before anything that references them -----------
      `insert into evidence_chains
         (id, tenant_id, figure_paise, source_count, as_of, produced_by)
       values (${lit(chainId)}, ${lit(f.tenantId)}, ${money(amount)}, 1,
               ${lit(date)}::timestamptz, ${lit(textId(profile, 'tool', i))});`,

      `insert into evidence_chain_steps (chain_id, step_index, operation, operands, result_paise)
         values (${lit(chainId)}, 1, 'sum', '[]'::jsonb, ${money(amount)});`,

      `insert into evidence_chain_sources
         (chain_id, tenant_id, source_record_type, source_record_id, field, record_updated_at)
       values (${lit(chainId)}, ${lit(f.tenantId)}, 'payment', ${lit(textId(profile, 'pay', i))},
               'amount', ${lit(date)}::timestamptz);`,

      // -- proposals and authorizations ------------------------------------
      `insert into proposals
         (id, tenant_id, agent_name, action_type, target_source_records, target_fingerprint,
          impact_paise, evidence_chain_id, expected_outcome, state, approval_deadline,
          executed_at, created_at)
       values (${lit(proposalId)}, ${lit(f.tenantId)}, 'reconciliation_agent',
               'post_adjustment', '[]'::jsonb, ${lit(textId(profile, 'tf', i))},
               ${money(amount)}, ${lit(chainId)}, '{}'::jsonb,
               ${lit(proposalState(i))}::proposal_state, ${lit(date)}::timestamptz,
               ${proposalState(i) === 'executed' ? `${lit(date)}::timestamptz` : 'null'},
               ${lit(date)}::timestamptz);`,

      `insert into authorizations (id, tenant_id, proposal_id, actor_kind, decision, decided_at)
         values (${lit(f.authorizationIds[i] ?? '')}, ${lit(f.tenantId)}, ${lit(proposalId)},
                 'policy_engine', 'approved', ${lit(date)}::timestamptz);`,

      // -- ledger: a balanced set, because the seed COMMITS -----------------
      // `ledger_entries_balance_check` is DEFERRABLE INITIALLY DEFERRED and fires at
      // COMMIT, so debits must equal credits and the declared totals and entry_count
      // must match the rows. One debit and one credit of the same amount does that.
      `insert into ledger_entry_sets
         (id, tenant_id, entry_date, source_record_type, source_record_id, proposal_id,
          entry_count, total_debit_paise, total_credit_paise, created_by)
       values (${lit(setId)}, ${lit(f.tenantId)}, ${lit(date)}::date, 'payment',
               ${lit(textId(profile, 'pay', i))}, ${lit(proposalId)}, 2,
               ${money(amount)}, ${money(amount)}, 'p7-property');`,

      `insert into ledger_entries
         (id, tenant_id, set_id, account_code, side, amount_paise, entry_date, line_no)
       values (${lit(debitId ?? '')}, ${lit(f.tenantId)}, ${lit(setId)}, ${lit(f.debitAccount)},
               'debit', ${money(amount)}, ${lit(date)}::date, 1),
              (${lit(creditId ?? '')}, ${lit(f.tenantId)}, ${lit(setId)}, ${lit(f.creditAccount)},
               'credit', ${money(amount)}, ${lit(date)}::date, 2);`,

      `insert into ledger_entry_sources (entry_id, tenant_id, source_record_type, source_record_id)
         values (${lit(debitId ?? '')}, ${lit(f.tenantId)}, 'payment',
                 ${lit(textId(profile, 'pay', i))}),
                (${lit(creditId ?? '')}, ${lit(f.tenantId)}, 'payment',
                 ${lit(textId(profile, 'pay', i))});`,

      // -- exceptions ------------------------------------------------------
      `insert into exceptions
         (id, tenant_id, category, lifecycle_state, impact_paise, direction, fingerprint,
          evidence_chain_id, first_detected_at, last_detected_at)
       values (${lit(exceptionId)}, ${lit(f.tenantId)}, 'settlement_mismatch', 'open',
               ${money(amount)}, 'shortfall', ${lit(textId(profile, 'fp', i))}, ${lit(chainId)},
               ${lit(date)}::timestamptz, ${lit(date)}::timestamptz);`,

      `insert into exception_source_records
         (exception_id, tenant_id, source_record_type, source_record_id, "role")
       values (${lit(exceptionId)}, ${lit(f.tenantId)}, 'settlement',
               ${lit(textId(profile, 'setl', i))}, 'settlement');`,

      // -- settlement reconciliation ---------------------------------------
      `insert into settlement_reconciliations
         (id, tenant_id, settlement_id, settlement_date, received_paise, status, run_id,
          evidence_chain_id)
       values (${lit(f.settlementIds[i] ?? '')}, ${lit(f.tenantId)},
               ${lit(textId(profile, 'setl', i))}, ${lit(date)}::date, ${money(amount)},
               'unreconciled', ${lit(f.runId)}, ${lit(chainId)});`,

      // -- audit log -------------------------------------------------------
      // Inserted directly rather than through app.append_audit_event: the sequence
      // allocator is task 4.4's and asserting on it here would make this seed depend
      // on a function P7 says nothing about. sequence_number is 1..n per Tenant, which
      // is what audit_events_sequence_uniq requires and what makes the numbers collide
      // across Tenants.
      `insert into audit_events
         (id, tenant_id, sequence_number, event_type, stage, actor_kind, actor_id,
          proposal_id, source_record_refs, payload, payload_bytes, occurred_at,
          chain_value, prev_chain_value)
       values (${lit(f.auditIds[i] ?? '')}, ${lit(f.tenantId)}, ${i + 1},
               ${lit(textId(profile, 'evt', i))}, 'DETECT', 'agent', 'reconciliation_agent',
               ${lit(proposalId)}, ${lit(auditSourceRef(profile, i))}::jsonb, '{}'::jsonb, 2,
               ${lit(date)}::timestamptz, repeat('a', 64), repeat('0', 64));`,

      // -- tenancy ---------------------------------------------------------
      `insert into user_permissions (tenant_id, user_id, permission, granted_by, granted_at)
         values (${lit(f.tenantId)}, ${lit(f.userId)},
                 ${lit(PERMISSIONS[i] ?? 'run_agents')}::permission, ${lit(f.userId)},
                 ${lit(date)}::timestamptz);`,
    );
  }

  return parts.join('\n');
}
