-- ============================================================================
-- FinanceOS Control Tower - migration 2 of 7 for the schema groups (task 4.2)
--
-- Naming convention: see the header of
--   20260101000001_money_domains_tenancy_configuration.sql (task 4.1).
-- This file is 20260101000002_ingestion.sql and applies immediately after it.
--
-- Contents (design.md, "Data Models" -> "Ingestion", plus the four
-- razorpay_objects entries of "Data Models" -> "Indexes"):
--   1. Enums: ingestion_status, razorpay_object_type
--   2. ingestion_runs   - the run record and its incremental window
--   3. ingestion_errors - per-object-type error rows for a run
--   4. razorpay_objects - the raw store, payload verbatim
--   5. Indexes: razorpay_objects_tenant_type_created_idx,
--      razorpay_payment_settlement_link_idx,
--      razorpay_recon_report_settlement_idx, razorpay_refund_payment_idx
--   6. RLS enabled and forced on all three tenant-scoped tables
--
-- Requirements: 1.2, 1.3, 1.6, 1.7
--
-- The money domains paise, paise_ingested and paise_positive are created in
-- 4.1 and are NOT recreated here. The projected monetary columns on
-- razorpay_objects use paise_ingested, so the 0..999,999,999,999 range of
-- Requirement 1.7 is enforced by the database on every insert and update.
--
-- Deliberately deferred, not missing:
--   - RLS policies. RLS is enabled and forced here; the four policies per
--     table bound to app.current_tenant_id() land in task 26.1.
--   - The ingestion service itself: paging, the 30s timeout, the retry
--     schedule, window selection and the re-ingestion upsert are task 6.x.
--     This migration only provides the storage those behaviours write to.
--   - Runtime verification against Supabase local, including the
--     information_schema.columns type audit and the uniqueness rejection
--     tests, is task 4.8.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Enums
--
-- ingestion_status carries exactly the four run outcomes of Requirement 1.6:
-- in_progress while running, then completed (zero errors), partially_completed
-- (>=1 error and >=1 record stored), or failed (zero records stored).
--
-- razorpay_object_type names every object type the ingestion service retrieves
-- (Requirement 1.1) plus credit_note, which the compliance detectors read.
-- ----------------------------------------------------------------------------

CREATE TYPE ingestion_status AS ENUM
  ('in_progress', 'completed', 'partially_completed', 'failed');

CREATE TYPE razorpay_object_type AS ENUM (
  'payment', 'order', 'refund', 'settlement', 'settlement_recon_report',
  'transfer', 'transfer_reversal', 'razorpay_invoice', 'linked_account', 'credit_note'
);

-- ----------------------------------------------------------------------------
-- 2. ingestion_runs (Requirement 1.6, 1.8, 1.9, 1.10)
--
-- started_at doubles as the incremental watermark: the next run's window_from
-- is the started_at of the most recent completed run (Requirement 1.9).
-- window_basis records which of the two window rules produced window_from, so
-- a run is auditable without re-deriving the decision.
--
-- per_type_stored is the per-object-type count of records stored, keyed by
-- object type (Requirement 1.6).
--
-- The two CHECKs:
--   - ended_at IS NULL OR ended_at >= started_at   - a run cannot end before
--     it started.
--   - (status = 'in_progress') = (ended_at IS NULL) - a biconditional, so
--     in_progress implies no end timestamp AND any terminal status implies
--     one. Both directions are needed; neither CHECK subsumes the other.
-- ----------------------------------------------------------------------------

CREATE TABLE ingestion_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),   -- the incremental watermark (Requirement 1.9)
  ended_at          TIMESTAMPTZ,
  status            ingestion_status NOT NULL DEFAULT 'in_progress',
  failure_kind      TEXT CHECK (failure_kind IN ('credential_rejected', 'no_records_stored')),
  window_from       TIMESTAMPTZ NOT NULL,                 -- 365d back, or last completed run start
  window_basis      TEXT NOT NULL CHECK (window_basis IN ('first_run_365d', 'incremental')),
  per_type_stored   JSONB NOT NULL DEFAULT '{}'::jsonb,   -- Requirement 1.6
  per_type_errors   INT   NOT NULL DEFAULT 0,
  initiated_by      UUID NOT NULL REFERENCES users(id),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK ((status = 'in_progress') = (ended_at IS NULL))
);

-- ----------------------------------------------------------------------------
-- 3. ingestion_errors (Requirement 1.4, 1.5)
--
-- One row per failed request, recording the error code, the requested object
-- type and the request timestamp against its run. error_category separates the
-- retryable classes (rate_limit, timeout) from provider_error and from
-- credential_rejected, which stops the run outright (Requirement 1.10).
--
-- retry_count is bounded 0..5 by CHECK, matching the at-most-5-retries rule of
-- Requirement 1.5.
--
-- tenant_id is the redundant child-table column described in design.md's
-- row-level security section: it exists so the RLS policy is a direct column
-- comparison rather than a join through ingestion_runs.
-- ----------------------------------------------------------------------------

CREATE TABLE ingestion_errors (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL,
  ingestion_run_id  UUID NOT NULL REFERENCES ingestion_runs(id),
  object_type       razorpay_object_type NOT NULL,
  error_code        TEXT NOT NULL,
  error_category    TEXT NOT NULL CHECK (error_category IN
                      ('rate_limit', 'timeout', 'provider_error', 'credential_rejected')),
  retry_count       SMALLINT NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 5),
  requested_at      TIMESTAMPTZ NOT NULL
);

-- ----------------------------------------------------------------------------
-- 4. razorpay_objects (Requirement 1.2, 1.3, 1.7)
--
-- Raw store. payload JSONB NOT NULL holds the Razorpay object exactly as
-- returned, unmodified (Requirement 1.2), and stays authoritative. The
-- amount_paise, fee_paise and gst_on_fee_paise columns are projections of that
-- payload, present so the reconciliation joins and aggregations are indexable;
-- they are typed paise_ingested, never NUMERIC, REAL, DOUBLE PRECISION or
-- MONEY, and no rounding, truncation or unit scaling is applied on the way in
-- (Requirement 1.7). They are nullable because not every object type carries
-- all three figures.
--
-- currency records what Razorpay returned and is pinned to INR by CHECK
-- (Requirement 1.7). It is the only currency column in the schema.
--
-- razorpay_objects_tenant_rzp_uniq is the load-bearing constraint behind
-- property P10 (Requirement 1.3): exactly one row per Razorpay object
-- identifier per Tenant. It is what makes the re-ingestion write
--   INSERT ... ON CONFLICT (tenant_id, razorpay_id) DO UPDATE
--     SET payload = EXCLUDED.payload,
--         retrieved_at = EXCLUDED.retrieved_at,
--         ingestion_run_id = EXCLUDED.ingestion_run_id
-- an update rather than a duplicate insert. The constraint is named
-- explicitly so ON CONFLICT and the 4.8 rejection test can both target it.
-- ----------------------------------------------------------------------------

-- Raw store. Payload is stored exactly as Razorpay returned it (Requirement 1.2).
CREATE TABLE razorpay_objects (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  razorpay_id       TEXT NOT NULL,
  object_type       razorpay_object_type NOT NULL,
  ingestion_run_id  UUID NOT NULL REFERENCES ingestion_runs(id),
  retrieved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at_rzp    TIMESTAMPTZ NOT NULL,                 -- Razorpay object creation time
  amount_paise      paise_ingested,                       -- projected for indexing; payload remains authoritative
  fee_paise         paise_ingested,
  gst_on_fee_paise  paise_ingested,
  currency          CHAR(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  status_rzp        TEXT,
  payload           JSONB NOT NULL,
  -- one row per Razorpay object identifier per Tenant (Requirement 1.3)
  CONSTRAINT razorpay_objects_tenant_rzp_uniq UNIQUE (tenant_id, razorpay_id)
);

-- ----------------------------------------------------------------------------
-- 5. Indexes on razorpay_objects (design.md, "Indexes")
--
-- The three partial expression indexes below are what make settlement
-- lifecycle matching run off stored Razorpay identifier links only, with no
-- amount or date inference. That is the source of property P5's run
-- determinism: the same stored links produce the same matches every run.
--
-- The remaining indexes in design.md's "Indexes" section target tables this
-- migration does not create and land with those schema groups (4.3, 4.5, 4.7).
-- ----------------------------------------------------------------------------

-- settlement lookups by tenant and date, the Reconciliation_Agent scope query
CREATE INDEX razorpay_objects_tenant_type_created_idx
  ON razorpay_objects (tenant_id, object_type, created_at_rzp DESC);

-- payment -> settlement link, resolved from the stored identifier link only
CREATE INDEX razorpay_payment_settlement_link_idx
  ON razorpay_objects (tenant_id, (payload ->> 'settlement_id'))
  WHERE object_type = 'payment';

-- recon report line lookup by settlement
CREATE INDEX razorpay_recon_report_settlement_idx
  ON razorpay_objects (tenant_id, (payload ->> 'settlement_id'))
  WHERE object_type = 'settlement_recon_report';

-- refunds by refunded payment, for the duplicate-refund detector
CREATE INDEX razorpay_refund_payment_idx
  ON razorpay_objects (tenant_id, (payload ->> 'payment_id'))
  WHERE object_type = 'refund';

-- ----------------------------------------------------------------------------
-- 6. Row-level security (Requirement 14.1, 14.2, 14.7, 14.10)
--
-- All three tables created above are tenant-scoped and appear in design.md's
-- list of tables that get RLS enabled and forced. FORCE ROW LEVEL SECURITY
-- applies the predicate to the table owner too, so there is no privileged read
-- path around the Tenant predicate.
--
-- The four policies per table bound to app.current_tenant_id() land in
-- task 26.1. Until then these tables match zero rows for every non-superuser
-- role, which is the fail-closed direction.
-- ----------------------------------------------------------------------------

ALTER TABLE ingestion_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_runs FORCE ROW LEVEL SECURITY;

ALTER TABLE ingestion_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_errors FORCE ROW LEVEL SECURITY;

ALTER TABLE razorpay_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE razorpay_objects FORCE ROW LEVEL SECURITY;
