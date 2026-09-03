-- ============================================================================
-- FinanceOS Control Tower - migration 3 of 7 for the schema groups (task 4.3)
--
--   20260101000001_money_domains_tenancy_configuration.sql   (task 4.1)
--   20260101000002_ingestion.sql                             (task 4.2)
--   20260101000003_semantic_ledger.sql                       (task 4.3, this file)
--   20260101000004_audit_log_append_only.sql                 (task 4.4)
--   20260101000005_exceptions.sql                            (task 4.5)
--   20260101000006_evidence_chains.sql                       (task 4.6)
--   20260101000007_settlement_reconciliations.sql            (task 4.7)
--
-- Contents (design.md, "Chart of accounts and Semantic Ledger"):
--   1. account_kind enum, chart_of_accounts
--   2. source_record_type enum, ledger_entry_sets with ledger_set_balanced,
--      ledger_set_totals_positive, ledger_set_derivation_uniq and
--      entry_count BETWEEN 2 AND 20
--   3. entry_side enum, ledger_entries on paise_positive, ledger_entry_sources
--   4. assert_ledger_set_balanced() and the DEFERRABLE INITIALLY DEFERRED
--      constraint trigger ledger_entries_balance_check
--   5. Append-only privileges on ledger_entries
--   6. RLS enable + force
--   7. Indexes ledger_entry_sources_lookup_idx,
--      ledger_entries_account_date_idx, ledger_entry_sets_derivation_idx
--
-- Requirements: 2.1, 2.2, 2.5, 2.6, 2.7, 2.8
--
-- Depends on 20260101000001: the paise and paise_positive domains, tenants,
-- and the app schema.
--
-- SCOPE SPLIT WITH TASK 4.4 - READ BEFORE EDITING
--   design.md's "Append-only enforcement" block covers ledger_entries and
--   audit_events together. audit_events, audit_sequence_counters,
--   app.append_audit_event(...), the shared reject_mutation_and_audit()
--   function, and the audit_events append-only trigger all belong to
--   20260101000004_audit_log_append_only.sql.
--   The ledger_entries BEFORE UPDATE OR DELETE trigger
--   (ledger_entries_append_only) is ALSO created in
--   20260101000004_audit_log_append_only.sql, because it executes
--   reject_mutation_and_audit(), which does not exist yet at this point in the
--   migration order. Only the REVOKE/GRANT half of the append-only story lives
--   here, since privileges have no such dependency.
--
-- RLS policies are NOT in this file. RLS is enabled and forced here on the four
-- tenant-scoped tables this migration creates; the policies bound to
-- app.current_tenant_id() land in task 26.1. Per design.md's "Row-level
-- security" section, ledger_entries gets no UPDATE or DELETE policy at all -
-- those privileges are revoked outright below.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Chart of accounts (Requirement 2.1)
--
-- Every Ledger_Entry posts to exactly 1 account of the Tenant chart of
-- accounts, enforced by the composite foreign key on ledger_entries below.
-- ----------------------------------------------------------------------------

CREATE TYPE account_kind AS ENUM ('asset', 'liability', 'equity', 'income', 'expense');

CREATE TABLE chart_of_accounts (
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  account_code  TEXT NOT NULL,
  account_name  TEXT NOT NULL,
  kind          account_kind NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, account_code)
);

-- ----------------------------------------------------------------------------
-- 2. Ledger_Entry sets (Requirement 2.1, 2.4, 2.6, 2.7, 2.8)
--
-- source_record_type and source_record_id are nullable because reversal sets
-- and Proposal-posted adjustment sets are not derived from a single Razorpay
-- Source_Record. Postgres treats NULL as distinct in a unique constraint, so
-- those sets do not collide, while every derived set is protected by
-- ledger_set_derivation_uniq (Requirement 2.8).
-- ----------------------------------------------------------------------------

CREATE TYPE source_record_type AS ENUM (
  'payment', 'order', 'refund', 'settlement', 'settlement_recon_report',
  'transfer', 'transfer_reversal', 'razorpay_invoice', 'credit_note',
  'linked_account', 'ledger_entry_set', 'proposal', 'forecast_component'
);

CREATE TABLE ledger_entry_sets (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id),
  entry_date              DATE NOT NULL,
  -- derivation identity: the idempotency key of Requirement 2.8
  source_record_type      source_record_type,
  source_record_id        TEXT,
  reverses_set_id         UUID REFERENCES ledger_entry_sets(id),   -- Requirement 2.4
  proposal_id             UUID,                                    -- set when posted by an executed Proposal
  entry_count             SMALLINT NOT NULL CHECK (entry_count BETWEEN 2 AND 20), -- Requirement 2.1
  total_debit_paise       paise NOT NULL,
  total_credit_paise      paise NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by              TEXT NOT NULL,                           -- user id, agent name, or 'policy_engine'
  -- balance is a table constraint, not an application convention (Requirement 2.1, 2.6, 2.7)
  CONSTRAINT ledger_set_balanced CHECK (total_debit_paise = total_credit_paise),
  CONSTRAINT ledger_set_totals_positive CHECK (total_debit_paise > 0),
  -- deriving twice from one Source_Record cannot create a second set (Requirement 2.8)
  CONSTRAINT ledger_set_derivation_uniq UNIQUE (tenant_id, source_record_type, source_record_id)
);

-- ----------------------------------------------------------------------------
-- 3. Ledger_Entries and their Source_Record links (Requirement 2.1, 2.2)
--
-- amount_paise is paise_positive: every entry amount is an integer number of
-- paise strictly greater than 0. Direction is carried by `side`, never by the
-- sign of the amount.
-- ----------------------------------------------------------------------------

CREATE TYPE entry_side AS ENUM ('debit', 'credit');

CREATE TABLE ledger_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  set_id        UUID NOT NULL REFERENCES ledger_entry_sets(id),
  account_code  TEXT NOT NULL,
  side          entry_side NOT NULL,
  amount_paise  paise_positive NOT NULL,        -- integer paise greater than 0 (Requirement 2.1)
  entry_date    DATE NOT NULL,
  line_no       SMALLINT NOT NULL CHECK (line_no >= 1),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, account_code) REFERENCES chart_of_accounts(tenant_id, account_code),
  UNIQUE (set_id, line_no)
);

-- At least 1 Source_Record link per Ledger_Entry (Requirement 2.2)
CREATE TABLE ledger_entry_sources (
  entry_id            UUID NOT NULL REFERENCES ledger_entries(id),
  tenant_id           UUID NOT NULL,
  source_record_type  source_record_type NOT NULL,
  source_record_id    TEXT NOT NULL,
  PRIMARY KEY (entry_id, source_record_type, source_record_id)
);

-- ----------------------------------------------------------------------------
-- 4. Enforcing Sum(debit) = Sum(credit) (Requirement 2.1, 2.6, 2.7)
--
-- Two layers, catching two different failures:
--
--   Barrier 1, immediate: the ledger_set_balanced CHECK above rejects a set
--   whose declared totals disagree, at statement time, before any entry row is
--   written.
--
--   Barrier 2, deferred: declared totals can agree while the persisted entry
--   rows disagree with them or with each other. That can only be proven at
--   commit, once every entry of the set is in, which is why the constraint
--   trigger is DEFERRABLE INITIALLY DEFERRED. An imbalanced set aborts the
--   whole transaction and persists 0 Ledger_Entries, the atomic rejection
--   Requirement 2.6 demands.
--
-- The rejection reason, imbalance amount, and Source_Record identifiers are
-- recorded by SemanticLedger.postSet as an Audit_Event before the transaction
-- is rolled back, on a separate connection.
-- ----------------------------------------------------------------------------

CREATE FUNCTION assert_ledger_set_balanced() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_debit  BIGINT;
  v_credit BIGINT;
  v_count  INT;
  v_set    RECORD;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN side = 'debit'  THEN amount_paise END), 0),
         COALESCE(SUM(CASE WHEN side = 'credit' THEN amount_paise END), 0),
         COUNT(*)
    INTO v_debit, v_credit, v_count
    FROM ledger_entries WHERE set_id = NEW.set_id;

  SELECT total_debit_paise, total_credit_paise, entry_count
    INTO v_set FROM ledger_entry_sets WHERE id = NEW.set_id;

  IF v_debit <> v_credit THEN
    RAISE EXCEPTION
      'ledger set % unbalanced: debit % credit %, imbalance % paise',
      NEW.set_id, v_debit, v_credit, v_debit - v_credit
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF v_debit <> v_set.total_debit_paise OR v_credit <> v_set.total_credit_paise
     OR v_count <> v_set.entry_count THEN
    RAISE EXCEPTION
      'ledger set % declared totals do not match its entries', NEW.set_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ledger_entries_balance_check
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_set_balanced();

-- ----------------------------------------------------------------------------
-- 5. Append-only enforcement on ledger_entries, privilege half (Requirement 2.7)
--
-- Barrier 1 is the privilege itself: no application role can update, delete or
-- truncate a persisted Ledger_Entry, so the common path never reaches a
-- trigger. Correction of a persisted Ledger_Entry is therefore only ever a
-- reversal set (Requirement 2.4).
--
-- Barrier 2, the rejecting BEFORE UPDATE OR DELETE trigger
-- ledger_entries_append_only, is created in
-- 20260101000004_audit_log_append_only.sql. It executes
-- reject_mutation_and_audit(), which is created by that migration because it
-- appends a 'mutation_rejected' Audit_Event, and neither the function nor the
-- audit tables exist yet at this point in the migration order.
-- ----------------------------------------------------------------------------

REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries FROM authenticated, anon, service_role;
GRANT  SELECT, INSERT ON ledger_entries TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 6. Row-level security on the tenant-scoped tables created above
--
-- design.md's "Row-level security" section lists chart_of_accounts,
-- ledger_entry_sets, ledger_entries and ledger_entry_sources among the
-- tenant-scoped tables that get RLS enabled and forced.
--
-- FORCE ROW LEVEL SECURITY applies the predicate to the table owner too, so
-- there is no privileged read path that bypasses the Tenant predicate.
--
-- The policies bound to app.current_tenant_id() land in task 26.1. Until then
-- these tables match zero rows for every non-superuser role, which is the
-- fail-closed direction. ledger_entries never gets an UPDATE or DELETE policy:
-- those privileges are revoked above.
-- ----------------------------------------------------------------------------

ALTER TABLE chart_of_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE chart_of_accounts FORCE ROW LEVEL SECURITY;

ALTER TABLE ledger_entry_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entry_sets FORCE ROW LEVEL SECURITY;

ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries FORCE ROW LEVEL SECURITY;

ALTER TABLE ledger_entry_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entry_sources FORCE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 7. Indexes (design.md, "Indexes")
-- ----------------------------------------------------------------------------

-- ledger entry source lookups: "does any entry reference this record?" (Requirement 4.10)
CREATE INDEX ledger_entry_sources_lookup_idx
  ON ledger_entry_sources (tenant_id, source_record_type, source_record_id);

CREATE INDEX ledger_entries_account_date_idx
  ON ledger_entries (tenant_id, account_code, entry_date);   -- trial balance (Requirement 2.5)

CREATE INDEX ledger_entry_sets_derivation_idx
  ON ledger_entry_sets (tenant_id, source_record_type, source_record_id);
