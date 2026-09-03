-- ============================================================================
-- FinanceOS Control Tower - migration 7 of 7 for the schema groups (task 4.7)
--
--   20260101000001_money_domains_tenancy_configuration.sql   (task 4.1)
--   20260101000002_ingestion.sql                             (task 4.2)
--   20260101000003_semantic_ledger.sql                       (task 4.3)
--   20260101000004_audit_log_append_only.sql                 (task 4.4)
--   20260101000005_exceptions.sql                            (task 4.5)
--   20260101000006_evidence_chains.sql                       (task 4.6)
--   20260101000007_settlement_reconciliations.sql            (task 4.7, this file)
--
-- This is the last of the seven schema-group migrations. It depends on
-- 20260101000001 for the paise domain, tenants and the app schema, and on
-- 20260101000006 for evidence_chains(id).
--
-- Contents (design.md, "Data Models" -> "Proposals, authorizations, settlement
-- reconciliation results", plus two entries of "Data Models" -> "Indexes"):
--   1. recon_status enum
--   2. settlement_reconciliations, with settlement_recon_uniq and the three
--      CHECKs unreconciled_has_no_figures, difference_decomposes_exactly and
--      explained_iff_zero_residual
--   3. Indexes settlement_recon_tenant_date_idx and the partial
--      settlement_recon_open_residual_idx
--   4. RLS enabled and forced (policies deferred to task 26.1)
--
-- Requirements: 4.2, 4.3, 4.4, 4.5, 4.13
--
-- SCOPE - the design.md block this DDL is transcribed from covers three
-- things: proposal_state / proposals / authorizations, and then recon_status /
-- settlement_reconciliations. Only the latter two belong to task 4.7. The
-- proposal_state enum, the proposals table and the authorizations table are
-- deliberately NOT created here; they are task 21.1 (Slice 3), which also adds
-- the audit_events.proposal_id foreign key that 20260101000004 left as a bare
-- UUID for the same reason.
--
-- This table is the persisted result of the Reconciliation_Agent computation in
-- design.md's "Settlement Expected Amount and the three-way Difference
-- decomposition". Expected Amount is read from the Settlement_Recon_Report and
-- is never inferred from dates or amounts (Requirement 4.2); received_paise
-- comes from the Settlement object itself.
--
-- Every monetary column here is on the signed `paise` domain from task 4.1.
-- Signed is required, not incidental: difference_paise is expected − received
-- and residual_paise is difference − fee − gst, and both are legitimately
-- negative (Requirement 4.5's unexplained excess is exactly the negative
-- residual case). paise_ingested and paise_positive would reject those rows.
-- No NUMERIC, DECIMAL, REAL, DOUBLE PRECISION, FLOAT or MONEY column appears.
--
-- Deliberately deferred, not missing:
--   - RLS policies. RLS is enabled and forced here; the four policies per
--     table bound to app.current_tenant_id() land in task 26.1.
--   - The Reconciliation_Agent that writes these rows, the shortfall breakdown
--     query of Requirement 4.6 and the settlement_mismatch Exception of
--     Requirement 4.5 are Slice 2 (task 13.x). This migration only provides
--     the storage and the invariants those behaviours must respect.
--   - Runtime verification against Supabase local, including the
--     settlement_recon_uniq duplicate-rejection test and the
--     information_schema.columns type audit, is task 4.8.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. recon_status (Requirement 4.4, 4.5, 4.13)
--
-- Exactly three outcomes, matching design.md's ReconStatus:
--   difference_explained - the unexplained residual is exactly 0 paise
--                          (Requirement 4.4)
--   mismatch             - a non-zero residual, positive for an unexplained
--                          shortfall and negative for an unexplained excess
--                          (Requirement 4.5)
--   unreconciled         - the Settlement_Recon_Report is absent or enumerates
--                          0 Payments, so no Expected Amount and no Difference
--                          were computed (Requirement 4.13)
-- ----------------------------------------------------------------------------

CREATE TYPE recon_status AS ENUM ('difference_explained', 'mismatch', 'unreconciled');


-- ----------------------------------------------------------------------------
-- 2. settlement_reconciliations
--
-- The computed per-Settlement result of Requirement 4.2 to 4.5, 4.13.
--
-- recon_report_id is NULL when the report is absent. An empty report is the
-- other half of Requirement 4.13 and is distinguishable from an absent one:
-- recon_report_id is present while payments_counted is 0. Both produce
-- status = 'unreconciled', which is what excludes the Settlement from the
-- reported total shortfall figure.
--
-- The four *_counted columns are the examined-record counts Requirement 4.7
-- reports alongside a total shortfall figure; they are counts, not money, so
-- they are INT and not on a money domain.
--
-- run_id ties the row to the Reconciliation_Agent run that computed it. It is
-- a bare UUID in design.md - no foreign key - so it is transcribed as one.
--
-- ORDERING: evidence_chain_id references evidence_chains(id), which is created
-- by task 4.6 in 20260101000006_evidence_chains.sql. That file sorts before
-- this one and is on disk, so the reference resolves when the directory is
-- applied in filename order. This is unlike the audit_events.proposal_id case
-- in 20260101000004, where the referenced table lands in a much later migration
-- (task 21.1) and the foreign key had to be deferred to it. Here the foreign
-- key is stated exactly as design.md writes it.
--
-- FINDING 1 (reported, implemented as written): design.md's SettlementRecon
-- interface in "Settlement Expected Amount and the three-way Difference
-- decomposition" carries a `direction` field
-- ('unexplained_shortfall' | 'unexplained_excess' | 'not_applicable',
-- Requirement 4.5), but this table has no direction column. It is derivable
-- from sign(residual_paise), so nothing is lost, but the DDL and the TypeScript
-- interface do not correspond field for field. No column was invented here.
--
-- FINDING 2 (reported, implemented as written): nothing in the three CHECKs
-- forces a row that is NOT 'unreconciled' to carry non-NULL figures. Every
-- column that unreconciled_has_no_figures makes NULL is nullable, and in SQL a
-- CHECK passes when it evaluates to NULL rather than to false. So a row with
-- status = 'mismatch' and expected/difference/fee/gst/residual all NULL
-- satisfies all three constraints: difference_decomposes_exactly evaluates
-- NULL, and explained_iff_zero_residual evaluates NULL. The intended converse -
-- a reconciled Settlement always has all five figures - is therefore enforced
-- only by the writing code, not by the database. A fourth constraint would
-- close it:
--
--   CONSTRAINT reconciled_has_all_figures CHECK (
--     status = 'unreconciled'
--     OR (expected_paise IS NOT NULL AND difference_paise IS NOT NULL
--         AND fee_component_paise IS NOT NULL AND gst_component_paise IS NOT NULL
--         AND residual_paise IS NOT NULL))
--
-- It is NOT added here: design.md specifies three named CHECKs and the task
-- names the same three. Adding a constraint would be a silent deviation from an
-- authoritative document. Raising it belongs with design.md.
-- ----------------------------------------------------------------------------

-- The computed per-Settlement result of Requirement 4.2 to 4.5, 4.13.
CREATE TABLE settlement_reconciliations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  settlement_id         TEXT NOT NULL,                 -- Razorpay settlement identifier
  recon_report_id       TEXT,                          -- NULL when absent (Requirement 4.13)
  settlement_date       DATE NOT NULL,
  expected_paise        paise,                         -- NULL when unreconciled
  received_paise        paise NOT NULL,
  difference_paise      paise,                         -- expected - received
  fee_component_paise   paise,
  gst_component_paise   paise,
  residual_paise        paise,
  status                recon_status NOT NULL,
  payments_counted      INT NOT NULL DEFAULT 0,
  refunds_counted       INT NOT NULL DEFAULT 0,
  chargebacks_counted   INT NOT NULL DEFAULT 0,
  adjustments_counted   INT NOT NULL DEFAULT 0,
  evidence_chain_id     UUID REFERENCES evidence_chains(id),
  computed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  run_id                UUID NOT NULL,
  CONSTRAINT settlement_recon_uniq UNIQUE (tenant_id, settlement_id),
  -- an unreconciled Settlement computes no Expected Amount and no Difference
  CONSTRAINT unreconciled_has_no_figures CHECK (
    status <> 'unreconciled'
    OR (expected_paise IS NULL AND difference_paise IS NULL
        AND fee_component_paise IS NULL AND gst_component_paise IS NULL
        AND residual_paise IS NULL)),
  -- the decomposition is exact, enforced in the database (Requirement 4.3)
  CONSTRAINT difference_decomposes_exactly CHECK (
    status = 'unreconciled'
    OR difference_paise = fee_component_paise + gst_component_paise + residual_paise),
  -- "difference explained" means and only means zero residual (Requirement 4.4, 4.5)
  CONSTRAINT explained_iff_zero_residual CHECK (
    status = 'unreconciled'
    OR (status = 'difference_explained') = (residual_paise = 0))
);

-- What the three CHECKs are doing, and why none of them is merged into another:
--
-- settlement_recon_uniq (Requirement 4.2)
--   One reconciliation result per Settlement per Tenant. Named explicitly so a
--   re-run can write ON CONFLICT (tenant_id, settlement_id) DO UPDATE instead
--   of accumulating a second result row, and so the task 4.8 duplicate-
--   rejection test can target the constraint by name.
--
-- unreconciled_has_no_figures (Requirement 4.4, 4.13)
--   A one-way implication, and correctly so: unreconciled => no figures. It
--   deliberately does not constrain rows that are reconciled, and it
--   deliberately does not constrain received_paise, which is read from the
--   Settlement object rather than from the report and is therefore known even
--   when the report is absent. The point of the constraint is that the row
--   cannot carry figures it could not compute. A 0n in expected_paise or
--   difference_paise would silently understate the reported total shortfall,
--   because 0 aggregates as a real value while NULL is excluded; NULL is what
--   keeps the Settlement out of the total (Requirement 4.13). See FINDING 2 on
--   the converse, which this constraint does not cover.
--
-- difference_decomposes_exactly (Requirement 4.3)
--   Integer paise addition with zero slack. This is what makes property P3 a
--   database invariant and not merely a test assertion: no row can exist in
--   which the Razorpay_Fee component, the GST_On_Fee component and the
--   unexplained residual fail to reconstruct the Difference exactly. There is
--   no epsilon and no rounding step anywhere in the expression, and there is
--   nothing to round: all four columns are BIGINT paise under the domain. The
--   agent computes residual = difference - fee - gst, so the identity holds by
--   construction on every input; this constraint is what guarantees no other
--   write path can violate it.
--
-- explained_iff_zero_residual (Requirement 4.4, 4.5)
--   A BICONDITIONAL, written with `=` between two boolean expressions, not an
--   implication. Both directions are load-bearing:
--     ->  status = 'difference_explained' requires residual_paise = 0, so a
--         Settlement cannot be reported as explained while carrying an
--         unexplained residual.
--     <-  residual_paise = 0 requires status = 'difference_explained', so a
--         fully explained Settlement cannot be parked as a 'mismatch' and
--         counted into the shortfall it does not contribute to.
--   The comparison is against exactly 0. There is no tolerance band, and one
--   must not be added: a tolerance is where a systematic error hides, and
--   Requirement 4.4 defines "difference explained" as the residual equalling
--   0 paise, not approximating it. Weakening the `=` to an implication, or
--   admitting a band, would break Requirement 4.4 and Requirement 4.5 in
--   opposite directions.

COMMENT ON TABLE settlement_reconciliations IS
'Per-Settlement reconciliation result (Requirement 4.2-4.5, 4.13). Expected '
'Amount is read from the Settlement_Recon_Report, never inferred from dates or '
'amounts. difference_decomposes_exactly makes the three-way decomposition a '
'database invariant (property P3); explained_iff_zero_residual makes '
'"difference explained" mean exactly a zero residual, with no tolerance.';

COMMENT ON COLUMN settlement_reconciliations.residual_paise IS
'Difference minus the Razorpay_Fee component minus the GST_On_Fee component. '
'Signed: positive is an unexplained shortfall, negative an unexplained excess '
'(Requirement 4.5). Exactly 0 is the sole definition of difference explained.';


-- ----------------------------------------------------------------------------
-- 3. Indexes (design.md, "Indexes" - reconciliation hot path)
--
-- settlement_recon_tenant_date_idx  - the Reconciliation_Agent scope query and
--                                     the trailing-90-day settlement date range
--                                     of Requirement 4.7
-- settlement_recon_open_residual_idx - the unexplained-residual scan behind the
--                                     shortfall breakdown of Requirement 4.6,
--                                     ordered by descending absolute Difference
--
-- The second is PARTIAL on status = 'mismatch', which is exactly the set of
-- Settlements with a non-zero unexplained residual: explained_iff_zero_residual
-- guarantees 'mismatch' and non-zero residual are the same set, so the partial
-- predicate needs no residual test of its own. 'unreconciled' rows are outside
-- the index, which is the same exclusion Requirement 4.13 applies to the
-- reported total, and their difference_paise is NULL anyway.
--
-- abs(difference_paise) is an immutable BIGINT function, so it is indexable as
-- an expression; the DESC ordering serves Requirement 4.6's descending
-- absolute-Difference ordering without a sort.
-- ----------------------------------------------------------------------------

CREATE INDEX settlement_recon_tenant_date_idx
  ON settlement_reconciliations (tenant_id, settlement_date DESC);

-- unexplained-residual scan for the shortfall answer, ordered by |difference|
CREATE INDEX settlement_recon_open_residual_idx
  ON settlement_reconciliations (tenant_id, abs(difference_paise) DESC)
  WHERE status = 'mismatch';


-- ----------------------------------------------------------------------------
-- 4. Row-level security (Requirement 14.1, 14.2, 14.7, 14.10)
--
-- settlement_reconciliations appears in design.md's "Row-level security" list
-- of tenant-scoped tables that get RLS enabled and forced. It is not one of the
-- two tables (ledger_entries, audit_events) whose UPDATE and DELETE policies
-- are omitted, so it takes the full four-policy set in task 26.1.
--
-- FORCE ROW LEVEL SECURITY applies the predicate to the table owner too, so
-- there is no privileged read path around the Tenant predicate.
--
-- The four policies bound to app.current_tenant_id() land in task 26.1,
-- matching 20260101000001 through 20260101000004. Until then this table matches
-- zero rows for every role without BYPASSRLS, which is the fail-closed
-- direction.
-- ----------------------------------------------------------------------------

ALTER TABLE settlement_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_reconciliations FORCE ROW LEVEL SECURITY;
