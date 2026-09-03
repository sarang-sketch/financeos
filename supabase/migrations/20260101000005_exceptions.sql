-- ============================================================================
-- FinanceOS Control Tower - migration 5 of 7 for the schema groups (task 4.5)
--   20260101000005_exceptions.sql
--
-- Runs after 20260101000003_semantic_ledger.sql (task 4.3), which creates the
-- source_record_type enum that exception_source_records reuses. That enum is
-- NOT recreated here.
--
-- Contents (design.md, "Exceptions" and "Indexes"):
--   1. exception_category enum - all 14 categories, in design.md's order
--   2. exception_state enum
--   3. exceptions, with impact_paise on the paise domain CHECKed >= 0, the two
--      separate lifecycle CHECKs, and exceptions_fingerprint_uniq
--   4. exception_source_records
--   5. RLS enabled and forced (policies deferred to task 26.1)
--   6. Indexes exceptions_attention_panel_idx (partial on open, covering),
--      exceptions_drilldown_idx, exception_source_records_lookup_idx
--
-- Requirements: 3.5, 3.6, 4.12, 4.15
--
-- Depends on 20260101000001: the paise domain, tenants, users.
-- Depends on 20260101000003: the source_record_type enum.
--
-- DELIBERATELY DEFERRED
--   - RLS policies bound to app.current_tenant_id() -> task 26.1. RLS is
--     enabled and forced here, which is the fail-closed direction.
--   - evidence_chain_id carries NO foreign key. design.md declares it as a bare
--     UUID because evidence_chains is created by task 4.6, one migration later.
--     Transcribed as written; see FINDING 2.
--   - Runtime verification of every constraint, index and the ON CONFLICT
--     upsert path -> task 4.8. Nothing here has been executed against a
--     database: Supabase local is unavailable in this environment, so this
--     migration was verified statically, object by object, against design.md.
--   - The Attention_Panel query itself, the drill-down pagination, and the
--     Reconciliation_Agent detectors that write these rows land in their own
--     tasks. This file is storage only.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Exception_Category (requirements.md glossary, Exception_Category)
--
-- All 14 categories the requirements enumerate, in design.md's order. Label
-- order is load-bearing, not cosmetic: enum comparison follows declaration
-- order, so this order is the sort order any index on `category` materialises,
-- including exceptions_attention_panel_idx below. Appending a category later is
-- safe; reordering these labels is not.
--
-- Sources of each category:
--   settlement_mismatch          Requirement 4.5
--   possible_duplicate_refund    Requirement 4.8
--   unmatched_credit_note        Requirement 4.9
--   missing_accrual              Requirement 4.10
--   ambiguous_match              Requirement 4.14
--   gst_anomaly                  GST_Agent
--   missing_gst_information      GST_Agent
--   invalid_gstin                GST_Agent
--   itc_discrepancy              GST_Agent
--   record_needing_review        TDS review path
--   seller_settlement_mismatch   Route / seller reconciliation
--   over_allocated_split         Route / seller reconciliation
--   verification_failure         Requirement 5.12
--   execution_failure            Action pipeline
-- ----------------------------------------------------------------------------

CREATE TYPE exception_category AS ENUM (
  'settlement_mismatch', 'possible_duplicate_refund', 'unmatched_credit_note',
  'missing_accrual', 'ambiguous_match', 'gst_anomaly', 'missing_gst_information',
  'invalid_gstin', 'itc_discrepancy', 'record_needing_review',
  'seller_settlement_mismatch', 'over_allocated_split',
  'verification_failure', 'execution_failure'
);

CREATE TYPE exception_state AS ENUM ('open', 'resolved', 'dismissed');


-- ----------------------------------------------------------------------------
-- 2. Exceptions (Requirement 4.12, 4.15)
--
-- impact_paise is the paise domain CHECKed >= 0: an integer number of paise,
-- never a float, and a MAGNITUDE. `direction` carries the sign, exactly as
-- `side` does for a Ledger_Entry. Requirement 4.5 asks for the absolute value
-- of the residual as the impact and a separate shortfall/excess
-- classification, which is why the sign is not allowed to hide inside the
-- amount.
--
-- Two lifecycle CHECKs, kept separate because they are two different claims and
-- a merged CHECK would make a violation ambiguous:
--   (lifecycle_state = 'open') = (resolved_at IS NULL)
--       biconditional: open implies not resolved, resolved_at set implies not
--       open. Combined with DEFAULT 'open' it gives Requirement 4.12's
--       "lifecycle state at creation SHALL be open".
--   last_detected_at >= first_detected_at
--       the re-run upsert may only move last_detected_at forward.
--
-- exceptions_fingerprint_uniq is the database half of Requirement 4.15: it is
-- what makes a re-run an UPDATE rather than a duplicate. The Agent writes
--
--   INSERT ... ON CONFLICT (tenant_id, fingerprint) DO UPDATE
--     SET impact_paise     = EXCLUDED.impact_paise,
--         detail           = EXCLUDED.detail,
--         last_detected_at = EXCLUDED.last_detected_at
--
-- (Requirement 4.15, 6.12, 7.10). The constraint name is fixed by that
-- ON CONFLICT and by task 4.8's duplicate-rejection test; do not rename it.
--
-- fingerprint must be a pure function of WHAT was detected - the tenant, the
-- category, and the sorted set of Source_Record identifiers - and never of WHEN
-- it was detected or of insertion order. That purity is what makes a
-- reconciliation run idempotent (property P5). Timestamps, run identifiers and
-- row order must not enter the fingerprint input.
-- ----------------------------------------------------------------------------

CREATE TABLE exceptions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  category            exception_category NOT NULL,
  lifecycle_state     exception_state NOT NULL DEFAULT 'open',   -- Requirement 4.12
  impact_paise        paise NOT NULL CHECK (impact_paise >= 0),  -- absolute impact, integer paise
  direction           TEXT CHECK (direction IN ('shortfall', 'excess', 'not_applicable')),
  detail              JSONB NOT NULL DEFAULT '{}'::jsonb,        -- named fields, failing rule, counts
  evidence_chain_id   UUID,
  -- deterministic identity for upsert on re-run (Requirement 4.15, 6.12, 7.10)
  fingerprint         TEXT NOT NULL,
  first_detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_detected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at         TIMESTAMPTZ,
  resolved_by         UUID REFERENCES users(id),
  CHECK ((lifecycle_state = 'open') = (resolved_at IS NULL)),
  CHECK (last_detected_at >= first_detected_at),
  CONSTRAINT exceptions_fingerprint_uniq UNIQUE (tenant_id, fingerprint)
);


-- ----------------------------------------------------------------------------
-- 3. Exception -> Source_Record links (Requirement 4.12)
--
-- Every Exception references at least 1 Source_Record. The composite primary
-- key makes the same record un-linkable twice in the same role-free identity,
-- so a re-run that re-links the same records is a no-op rather than a
-- multiplier - the same idempotency stance as the fingerprint above.
--
-- The "at least 1" half of Requirement 4.12 is not expressible as a table
-- constraint on this table: a plain CHECK cannot count rows in another table,
-- and a deferred constraint trigger on exceptions would have to be written
-- against a child table that may legitimately be filled in the same statement.
-- Design.md does not specify one, so none is invented here. The Exception
-- writer inserts the parent and its >= 1 links in a single transaction, and
-- task 4.8 asserts the invariant. Reported as FINDING 1.
--
-- ON DELETE CASCADE mirrors design.md. It is not a deletion path for
-- Exceptions in normal operation: Exceptions are resolved or dismissed, never
-- deleted.
--
-- tenant_id is denormalised onto this table with no foreign key, exactly as
-- design.md declares it, so the RLS predicate and
-- exception_source_records_lookup_idx can both work from this table alone
-- without a join back to exceptions.
--
-- source_record_type reuses the enum created by 20260101000003_semantic_ledger.
-- ----------------------------------------------------------------------------

CREATE TABLE exception_source_records (
  exception_id        UUID NOT NULL REFERENCES exceptions(id) ON DELETE CASCADE,
  tenant_id           UUID NOT NULL,
  source_record_type  source_record_type NOT NULL,
  source_record_id    TEXT NOT NULL,
  role                TEXT,                     -- e.g. 'settlement', 'contributing_refund'
  PRIMARY KEY (exception_id, source_record_type, source_record_id)
);


-- ----------------------------------------------------------------------------
-- 4. Row-level security
--
-- design.md's "Row-level security" section lists both exceptions and
-- exception_source_records among the tenant-scoped tables that get RLS enabled
-- and forced. FORCE ROW LEVEL SECURITY applies the predicate to the table owner
-- too, so there is no privileged read path around the Tenant predicate.
--
-- The policies bound to app.current_tenant_id() land in task 26.1. Until then
-- these tables match zero rows for every non-superuser role, which is the
-- fail-closed direction. Application-level WHERE tenant_id = $1 filters stay in
-- every query as defence in depth; they are never the control.
-- ----------------------------------------------------------------------------

ALTER TABLE exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE exceptions FORCE ROW LEVEL SECURITY;

ALTER TABLE exception_source_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE exception_source_records FORCE ROW LEVEL SECURITY;


-- ----------------------------------------------------------------------------
-- 5. Indexes (design.md, "Indexes")
--
-- The Attention_Panel groups open Exceptions by category with a count and a
-- summed impact. The index is partial on `open` and carries impact_paise as an
-- INCLUDEd column, so the aggregation is index-only: no heap fetch to sum the
-- impact (Requirement 3.5). impact_paise is INCLUDEd rather than keyed because
-- the panel never seeks or orders on it, it only sums it.
--
-- The drill-down uses a second index because its ordering differs from the
-- panel's: descending impact, then ascending id as the tie-break, which is
-- Requirement 3.6's exact ordering rendered as index order so the top page is a
-- prefix scan rather than a sort. Rows of equal impact are ordered by ascending
-- Exception identifier.
--
-- Both are partial on lifecycle_state = 'open', which is also what keeps them
-- small: resolved and dismissed Exceptions accumulate forever and neither
-- surface reads them.
-- ----------------------------------------------------------------------------

CREATE INDEX exceptions_attention_panel_idx
  ON exceptions (tenant_id, category, lifecycle_state)
  INCLUDE (impact_paise)
  WHERE lifecycle_state = 'open';

-- drill-down ordering: descending impact, then ascending id (Requirement 3.6)
CREATE INDEX exceptions_drilldown_idx
  ON exceptions (tenant_id, category, impact_paise DESC, id ASC)
  WHERE lifecycle_state = 'open';

-- "which Exceptions reference this Source_Record?", and the re-run link probe
CREATE INDEX exception_source_records_lookup_idx
  ON exception_source_records (tenant_id, source_record_type, source_record_id);
