-- ============================================================================
-- FinanceOS Control Tower - row-level security policies (task 26.1)
--
-- Authoritative source: design.md, "Row-level security". This file is the point
-- at which Tenant isolation stops being aspirational: migrations 4.1..4.7 and
-- 21.1 set ENABLE / FORCE ROW LEVEL SECURITY on every tenant-scoped table and
-- deliberately deferred the policies to here, so until this migration ran those
-- tables matched zero rows for every role without BYPASSRLS - fail-closed, but
-- also unusable. This file supplies the predicate.
--
-- Requirements: 14.1, 14.2, 14.3, 14.7, 14.10.
--
-- THE PATTERN, exactly as design.md writes it for the representative table
-- `exceptions`, repeated verbatim per table:
--
--   ALTER TABLE t ENABLE ROW LEVEL SECURITY;
--   ALTER TABLE t FORCE  ROW LEVEL SECURITY;   -- applies to the table owner too
--   CREATE POLICY t_select ON t FOR SELECT TO authenticated
--     USING (tenant_id = app.current_tenant_id());
--   CREATE POLICY t_insert ON t FOR INSERT TO authenticated
--     WITH CHECK (tenant_id = app.current_tenant_id());
--   CREATE POLICY t_update ON t FOR UPDATE TO authenticated
--     USING (tenant_id = app.current_tenant_id())
--     WITH CHECK (tenant_id = app.current_tenant_id());
--   CREATE POLICY t_delete ON t FOR DELETE TO authenticated
--     USING (tenant_id = app.current_tenant_id());
--
-- The ENABLE / FORCE statements are re-issued here even though the creating
-- migrations already ran them. Both are idempotent in Postgres, and repeating
-- them makes this file self-sufficient: the isolation boundary for a table is
-- legible in one place rather than split across two migrations.
--
-- WHY THIS IS THE BOUNDARY AND NOT A CONVENIENCE (Requirement 14.2, 14.7, 14.10)
--
--   - FORCE ROW LEVEL SECURITY means the predicate applies to the table owner
--     too. There is no privileged read path around it. (A role holding
--     BYPASSRLS still bypasses; on Supabase local that is `postgres`, which is
--     the migration/fixture role, not an application role.)
--   - app.current_tenant_id() returns NULL when no session claim exists
--     (migration 20260101000001), and `tenant_id = NULL` is never true, so an
--     unauthenticated or unscoped request matches zero rows rather than raising
--     a permission error that would confirm the row exists (Requirement 14.4,
--     14.10).
--   - The WITH CHECK clause on INSERT is what makes a write carrying another
--     Tenant's tenant_id fail rather than land (Requirement 14.3, 14.7).
--   - A cross-Tenant UPDATE or DELETE matches zero rows instead of erroring,
--     because USING filters rather than rejects (Requirement 14.3).
--
-- SCOPE NOTES - read these before assuming something is missing.
--
-- 1. NO GRANTS ARE ISSUED HERE. Policies and privileges are separate gates and
--    a privilege check is evaluated first. `supabase/config.toml` leaves
--    `auto_expose_new_tables` unset, so `authenticated` holds table grants only
--    where a migration granted them explicitly (ledger_entries, audit_events).
--    Granting the rest is not task 26.1's, and issuing a blanket grant here
--    would widen the surface in the same change that narrows it.
--
-- 2. APPEND-ONLY TABLES GET TWO POLICIES, NOT FOUR. `ledger_entries` and
--    `audit_events` have UPDATE, DELETE and TRUNCATE revoked from every
--    application role by migrations 4.3 and 4.4 (Requirement 2.7, 13.5), with a
--    rejecting trigger as the second barrier. design.md omits their UPDATE and
--    DELETE policies for exactly that reason. Nothing here re-grants those
--    privileges - a policy cannot grant a privilege, and adding UPDATE/DELETE
--    policies would only create the false impression that the operations are
--    permitted.
--
-- 3. evidence_chain_steps IS THE ONE DEVIATION, AND IT IS FORCED.
--    design.md names it in the verbatim list, but design.md's own DDL for the
--    table carries no tenant_id column - its primary key is
--    (chain_id, step_index). See FINDING 1 in
--    20260101000006_evidence_chains.sql. `tenant_id = app.current_tenant_id()`
--    cannot compile against it, so its four policies qualify through
--    evidence_chains.tenant_id instead. design.md's own text in the same
--    section warrants this: "A join-based policy would be correct but would put
--    the isolation guarantee behind query planning." Correct, and enforced now,
--    is better than deferred. Resolving the DDL inconsistency (adding the
--    redundant tenant_id column design.md's narrative assumes) is a design.md
--    decision, not this task's.
--
-- 4. FIVE TABLES design.md NAMES DO NOT EXIST YET. `tds_review_items`,
--    `cash_forecasts`, `cash_forecast_days`, `cash_forecast_components` and
--    `model_requests` are created by later tasks (33.6, 34.1, 34.1, 34.1, 31.4
--    respectively), all of which sort after this migration. They are not
--    omitted by choice and they are not silently dropped: each creating
--    migration must carry the block above for its own tables, and task 26.4's
--    per-table RLS tests should fail loudly for any that does not. The
--    verification query at the foot of this file is the mechanism - it names
--    every table it checked.
--
-- 5. `tenants` and `users` are NOT tenant-scoped rows and are correctly absent
--    from design.md's list. Neither carries a tenant_id column and neither has
--    RLS enabled. They are named here only so their absence is a recorded
--    decision rather than an oversight.
--
-- Application-level `WHERE tenant_id = $1` filters stay in every query as
-- defence in depth. They are never the control (Requirement 14.2).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Ingestion (20260101000002)
-- ----------------------------------------------------------------------------

ALTER TABLE ingestion_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY ingestion_runs_select ON ingestion_runs
  FOR SELECT TO authenticated
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY ingestion_runs_insert ON ingestion_runs
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY ingestion_runs_update ON ingestion_runs
  FOR UPDATE TO authenticated
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY ingestion_runs_delete ON ingestion_runs
  FOR DELETE TO authenticated
  USING (tenant_id = app.current_tenant_id());


ALTER TABLE ingestion_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_errors FORCE ROW LEVEL SECURITY;

CREATE POLICY ingestion_errors_select ON ingestion_errors
  FOR SELECT TO authenticated
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY ingestion_errors_insert ON ingestion_errors
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY ingestion_errors_update ON ingestion_errors
  FOR UPDATE TO authenticated
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY ingestion_errors_delete ON ingestion_errors
  FOR DELETE TO authenticated
  USING (tenant_id = app.current_tenant_id());


ALTER TABLE razorpay_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE razorpay_objects FORCE ROW LEVEL SECURITY;

CREATE POLICY razorpay_objects_select ON razorpay_objects
  FOR SELECT TO authenticated
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY razorpay_objects_insert ON razorpay_objects
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY razorpay_objects_update ON razorpay_objects
  FOR UPDATE TO authenticated
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY razorpay_objects_delete ON razorpay_objects
  FOR DELETE TO authenticated
  USING (tenant_id = app.current_tenant_id());


-- ----------------------------------------------------------------------------
-- 2. Semantic ledger (20260101000003)
--
-- ledger_entries takes SELECT and INSERT only: UPDATE and DELETE are revoked
-- outright (Requirement 2.7). See scope note 2 in the header.
-- ----------------------------------------------------------------------------

ALTER TABLE chart_of_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE chart_of_accounts FORCE ROW LEVEL SECURITY;

CREATE POLICY chart_of_accounts_select ON chart_of_accounts
  FOR SELECT TO authenticated
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY chart_of_accounts_insert ON chart_of_accounts
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY chart_of_accounts_update ON chart_of_accounts
  FOR UPDATE TO authenticated
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY chart_of_accounts_delete ON chart_of_accounts
  FOR DELETE TO authenticated
  USING (tenant_id = app.current_tenant_id());


ALTER TABLE ledger_entry_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entry_sets FORCE ROW LEVEL SECURITY;

CREATE POLICY ledger_entry_sets_select ON ledger_entry_sets
  FOR SELECT TO authenticated
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY ledger_entry_sets_insert ON ledger_entry_sets
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY ledger_entry_sets_update ON ledger_entry_sets
  FOR UPDATE TO authenticated
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY ledger_entry_sets_delete ON ledger_entry_sets
  FOR DELETE TO authenticated
  USING (tenant_id = app.current_tenant_id());


-- Append-only: no UPDATE policy, no DELETE policy. Those privileges are revoked
-- from authenticated, anon and service_role in 20260101000003 and are NOT
-- re-granted here (Requirement 2.7, 13.5).
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY ledger_entries_select ON ledger_entries
  FOR SELECT TO authenticated
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY ledger_entries_insert ON ledger_entries
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = app.current_tenant_id());


ALTER TABLE ledger_entry_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entry_sources FORCE ROW LEVEL SECURITY;

CREATE POLICY ledger_entry_sources_select ON ledger_entry_sources
  FOR SELECT TO authenticated
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY ledger_entry_sources_insert ON ledger_entry_sources
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY ledger_entry_sources_update ON ledger_entry_sources
  FOR UPDATE TO authenticated
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY ledger_entry_sources_delete ON ledger_entry_sources
  FOR DELETE TO authenticated
  USING (tenant_id = app.current_tenant_id());


-- ----------------------------------------------------------------------------
-- 3. Audit log (20260101000004)
--
-- audit_events takes SELECT and INSERT only, for the same reason as
-- ledger_entries (Requirement 13.5). audit_sequence_counters is mutable - the
-- sequence counter is updated on every append - so it takes all four.
-- ----------------------------------------------------------------------------

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_events_select ON audit_events
  FOR SELECT TO authenticated
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY audit_events_insert ON audit_events
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = app.current_tenant_id());


ALTER TABLE audit_sequence_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_sequence_counters FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_sequence_counters_select ON audit_sequence_counters
  FOR SELECT TO authenticated
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY audit_sequence_counters_insert ON audit_sequence_counters
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY audit_sequence_counters_update ON audit_sequence_counters
  FOR UPDATE TO authenticated
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY audit_sequence_counters_delete ON audit_sequence_counters
  FOR DELETE TO authenticated
  USING (tenant_id = app.current_tenant_id());


-- ----------------------------------------------------------------------------
-- 4. Exceptions (20260101000005)
-- ----------------------------------------------------------------------------

ALTER TABLE exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE exceptions FORCE ROW LEVEL SECURITY;

CREATE POLICY exceptions_select ON exceptions
  FOR SELECT TO authenticated
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY exceptions_insert ON exceptions
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY exceptions_update ON exceptions
  FOR UPDATE TO authenticated
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY exceptions_delete ON exceptions
  FOR DELETE TO authenticated
  USING (tenant_id = app.current_tenant_id());


ALTER TABLE exception_source_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE exception_source_records FORCE ROW LEVEL SECURITY;

CREATE POLICY exception_source_records_select ON exception_source_records
  FOR SELECT TO authenticated
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY exception_source_records_insert ON exception_source_records
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY exception_source_records_update ON exception_source_records
  FOR UPDATE TO authenticated
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY exception_source_records_delete ON exception_source_records
  FOR DELETE TO authenticated
  USING (tenant_id = app.current_tenant_id());


-- ----------------------------------------------------------------------------
-- 5. Evidence chains (20260101000006)
--
-- evidence_chain_steps is the single deviation from the verbatim pattern. See
-- scope note 3 in the header: the table has no tenant_id column, so the
-- predicate qualifies through its parent's. The EXISTS subquery reads
-- evidence_chains, whose own RLS is not applied inside a policy expression, so
-- the comparison is against the stored parent tenant_id directly and cannot be
-- short-circuited by the parent's own policy.
-- ----------------------------------------------------------------------------

ALTER TABLE evidence_chains ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_chains FORCE ROW LEVEL SECURITY;

CREATE POLICY evidence_chains_select ON evidence_chains
  FOR SELECT TO authenticated
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY evidence_chains_insert ON evidence_chains
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY evidence_chains_update ON evidence_chains
  FOR UPDATE TO authenticated
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY evidence_chains_delete ON evidence_chains
  FOR DELETE TO authenticated
  USING (tenant_id = app.current_tenant_id());


CREATE FUNCTION app.evidence_chain_in_session_tenant(p_chain_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.evidence_chains c
     WHERE c.id = p_chain_id
       AND c.tenant_id = app.current_tenant_id()
  )
$$;

COMMENT ON FUNCTION app.evidence_chain_in_session_tenant(UUID) IS
  'Parent-qualified tenant predicate for evidence_chain_steps, which carries no '
  'tenant_id column in design.md''s DDL (task 26.1, FINDING 1 of migration 06). '
  'Returns false when app.current_tenant_id() is NULL, so an unscoped session '
  'matches zero rows.';

ALTER TABLE evidence_chain_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_chain_steps FORCE ROW LEVEL SECURITY;

CREATE POLICY evidence_chain_steps_select ON evidence_chain_steps
  FOR SELECT TO authenticated
  USING (app.evidence_chain_in_session_tenant(chain_id));

CREATE POLICY evidence_chain_steps_insert ON evidence_chain_steps
  FOR INSERT TO authenticated
  WITH CHECK (app.evidence_chain_in_session_tenant(chain_id));

CREATE POLICY evidence_chain_steps_update ON evidence_chain_steps
  FOR UPDATE TO authenticated
  USING (app.evidence_chain_in_session_tenant(chain_id))
  WITH CHECK (app.evidence_chain_in_session_tenant(chain_id));

CREATE POLICY evidence_chain_steps_delete ON evidence_chain_steps
  FOR DELETE TO authenticated
  USING (app.evidence_chain_in_session_tenant(chain_id));


ALTER TABLE evidence_chain_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_chain_sources FORCE ROW LEVEL SECURITY;

CREATE POLICY evidence_chain_sources_select ON evidence_chain_sources
  FOR SELECT TO authenticated
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY evidence_chain_sources_insert ON evidence_chain_sources
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY evidence_chain_sources_update ON evidence_chain_sources
  FOR UPDATE TO authenticated
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY evidence_chain_sources_delete ON evidence_chain_sources
  FOR DELETE TO authenticated
  USING (tenant_id = app.current_tenant_id());


-- ----------------------------------------------------------------------------
-- 6. Settlement reconciliation (20260101000007)
-- ----------------------------------------------------------------------------

ALTER TABLE settlement_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_reconciliations FORCE ROW LEVEL SECURITY;

CREATE POLICY settlement_reconciliations_select ON settlement_reconciliations
  FOR SELECT TO authenticated
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY settlement_reconciliations_insert ON settlement_reconciliations
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY settlement_reconciliations_update ON settlement_reconciliations
  FOR UPDATE TO authenticated
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY settlement_reconciliations_delete ON settlement_reconciliations
  FOR DELETE TO authenticated
  USING (tenant_id = app.current_tenant_id());


-- ----------------------------------------------------------------------------
-- 7. Proposals and authorizations (20260101000008)
--
-- Migration 21.1 enabled and forced RLS on both and deferred the policies here.
-- This is that deferral being picked up, not a duplicate of it.
-- ----------------------------------------------------------------------------

ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposals FORCE ROW LEVEL SECURITY;

CREATE POLICY proposals_select ON proposals
  FOR SELECT TO authenticated
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY proposals_insert ON proposals
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY proposals_update ON proposals
  FOR UPDATE TO authenticated
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY proposals_delete ON proposals
  FOR DELETE TO authenticated
  USING (tenant_id = app.current_tenant_id());


ALTER TABLE authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE authorizations FORCE ROW LEVEL SECURITY;

CREATE POLICY authorizations_select ON authorizations
  FOR SELECT TO authenticated
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY authorizations_insert ON authorizations
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY authorizations_update ON authorizations
  FOR UPDATE TO authenticated
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY authorizations_delete ON authorizations
  FOR DELETE TO authenticated
  USING (tenant_id = app.current_tenant_id());


-- ----------------------------------------------------------------------------
-- 8. Tenancy and configuration (20260101000001)
--
-- Last in the file rather than first, because these were the first tables
-- created. Order has no semantic effect - policies are independent.
-- ----------------------------------------------------------------------------

ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_memberships_select ON tenant_memberships
  FOR SELECT TO authenticated
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_memberships_insert ON tenant_memberships
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_memberships_update ON tenant_memberships
  FOR UPDATE TO authenticated
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_memberships_delete ON tenant_memberships
  FOR DELETE TO authenticated
  USING (tenant_id = app.current_tenant_id());


ALTER TABLE user_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_permissions FORCE ROW LEVEL SECURITY;

CREATE POLICY user_permissions_select ON user_permissions
  FOR SELECT TO authenticated
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY user_permissions_insert ON user_permissions
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY user_permissions_update ON user_permissions
  FOR UPDATE TO authenticated
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY user_permissions_delete ON user_permissions
  FOR DELETE TO authenticated
  USING (tenant_id = app.current_tenant_id());


ALTER TABLE tenant_configuration ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_configuration FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_configuration_select ON tenant_configuration
  FOR SELECT TO authenticated
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_configuration_insert ON tenant_configuration
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_configuration_update ON tenant_configuration
  FOR UPDATE TO authenticated
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_configuration_delete ON tenant_configuration
  FOR DELETE TO authenticated
  USING (tenant_id = app.current_tenant_id());


-- ----------------------------------------------------------------------------
-- 9. Self-verification
--
-- This migration's whole value is completeness, so it checks its own coverage
-- rather than trusting that 20 hand-written blocks are all present and correct.
-- Three assertions, all fatal, plus two notices:
--
--   A. Every table in design.md's list that exists has RLS enabled AND forced.
--   B. Every such table has exactly the policy set it should - four commands,
--      or SELECT and INSERT only for the two append-only tables - each scoped
--      to `authenticated`, and every INSERT and UPDATE policy carries a
--      WITH CHECK expression.
--   C. No table in `public` carrying a tenant_id column is missing from
--      design.md's list. This is the assertion that catches a future table
--      added without policies: it fails the migration rather than leaving a
--      quiet hole. (`tenants` and `users` carry no tenant_id, so they are
--      excluded by the predicate itself, not by a name exception.)
--
--   Notice 1: the design.md tables that do not exist yet (scope note 4).
--   Notice 2: the tables that were covered, so the applied log names them.
-- ----------------------------------------------------------------------------

DO $verify$
DECLARE
  -- design.md, "Row-level security", in the order that section lists them.
  k_listed        TEXT[] := ARRAY[
    'ingestion_runs', 'ingestion_errors', 'razorpay_objects', 'chart_of_accounts',
    'ledger_entry_sets', 'ledger_entries', 'ledger_entry_sources', 'exceptions',
    'exception_source_records', 'evidence_chains', 'evidence_chain_steps',
    'evidence_chain_sources', 'proposals', 'authorizations', 'audit_events',
    'audit_sequence_counters', 'tds_review_items', 'cash_forecasts',
    'cash_forecast_days', 'cash_forecast_components', 'model_requests',
    'tenant_configuration', 'settlement_reconciliations', 'tenant_memberships',
    'user_permissions'
  ];
  -- UPDATE and DELETE revoked outright (Requirement 2.7, 13.5).
  k_append_only   TEXT[] := ARRAY['ledger_entries', 'audit_events'];
  v_present       TEXT[];
  v_absent        TEXT[];
  v_bad           TEXT;
  v_unlisted      TEXT;
BEGIN
  SELECT coalesce(array_agg(t ORDER BY t) FILTER (WHERE to_regclass('public.' || t) IS NOT NULL), '{}'),
         coalesce(array_agg(t ORDER BY t) FILTER (WHERE to_regclass('public.' || t) IS NULL), '{}')
    INTO v_present, v_absent
    FROM unnest(k_listed) AS t;

  -- A. enabled and forced
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_bad
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = ANY (v_present)
     AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'task 26.1: RLS not enabled and forced on: %', v_bad;
  END IF;

  -- B. exact policy set, role, and WITH CHECK on every write policy
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO v_bad FROM (
    SELECT c.relname || ' has commands [' || coalesce(pol.cmds, '') || '], expected [' ||
           CASE WHEN c.relname = ANY (k_append_only) THEN 'a,r' ELSE 'a,d,r,w' END || ']'
             AS detail
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN LATERAL (
        SELECT string_agg(DISTINCT p.polcmd::text, ',' ORDER BY p.polcmd::text) AS cmds,
               count(*) AS n,
               count(*) FILTER (
                 WHERE p.polroles
                       = ARRAY[(SELECT r.oid FROM pg_roles r WHERE r.rolname = 'authenticated')]::oid[]
               ) AS n_authenticated,
               count(*) FILTER (
                 WHERE p.polcmd IN ('a', 'w') AND p.polwithcheck IS NULL
               ) AS n_missing_check
          FROM pg_policy p WHERE p.polrelid = c.oid
      ) pol ON TRUE
     WHERE n.nspname = 'public'
       AND c.relname = ANY (v_present)
       AND (
         -- 'r' SELECT, 'a' INSERT, 'w' UPDATE, 'd' DELETE; sorted ascending
         coalesce(pol.cmds, '') <>
           CASE WHEN c.relname = ANY (k_append_only) THEN 'a,r' ELSE 'a,d,r,w' END
         OR pol.n <> CASE WHEN c.relname = ANY (k_append_only) THEN 2 ELSE 4 END
         OR pol.n_authenticated <> pol.n
         OR pol.n_missing_check > 0
       )
  ) bad;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'task 26.1: wrong policy set: %', v_bad;
  END IF;

  -- C. nothing tenant-scoped left out of design.md's list
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO v_unlisted
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND NOT (c.relname = ANY (k_listed))
     AND EXISTS (
       SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
          AND a.attnum > 0 AND NOT a.attisdropped
     );
  IF v_unlisted IS NOT NULL THEN
    RAISE EXCEPTION
      'task 26.1: table(s) carry tenant_id but are absent from design.md''s '
      'row-level security list, so they have no policy: %. Add them to '
      'design.md and to this migration rather than leaving them unprotected.',
      v_unlisted;
  END IF;

  RAISE NOTICE 'task 26.1: policies applied to % table(s): %',
    cardinality(v_present), array_to_string(v_present, ', ');
  IF cardinality(v_absent) > 0 THEN
    RAISE NOTICE
      'task 26.1: % design.md table(s) do not exist yet and must carry the same '
      'four-policy block in their creating migration: % (tasks 31.4, 33.6, 34.1)',
      cardinality(v_absent), array_to_string(v_absent, ', ');
  END IF;
END
$verify$;
