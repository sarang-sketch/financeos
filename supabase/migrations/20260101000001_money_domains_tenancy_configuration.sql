-- ============================================================================
-- FinanceOS Control Tower - migration 1 of 7 for the schema groups (task 4.1)
--
-- Naming convention for this spec's schema-group migrations (tasks 4.1..4.7):
--   20260101000001_money_domains_tenancy_configuration.sql   (task 4.1, this file)
--   20260101000002_ingestion.sql                             (task 4.2)
--   20260101000003_semantic_ledger.sql                       (task 4.3)
--   20260101000004_audit_log_append_only.sql                 (task 4.4)
--   20260101000005_exceptions.sql                            (task 4.5)
--   20260101000006_evidence_chains.sql                        (task 4.6)
--   20260101000007_settlement_reconciliations.sql             (task 4.7)
-- Supabase applies migrations in lexicographic filename order, so the fixed
-- 20260101 date with a monotonic 6-digit sequence keeps the seven schema
-- groups strictly ordered. Later, unrelated migrations use a real timestamp,
-- which sorts after this block.
--
-- Contents (design.md, "Data Models"):
--   1. Money domains: paise, paise_ingested, paise_positive
--   2. Session tenant resolution: schema app, app.current_tenant_id(),
--      app.current_user_id()
--   3. Tenancy: tenants, users, tenant_memberships, permission enum,
--      user_permissions
--   4. Configuration: tenant_configuration (every configuration column
--      nullable, plus the encrypted credential columns)
--
-- Requirements: 14.1, 14.5, 14.6, 15.1, 15.8
--
-- RLS policies are NOT in this file. RLS is enabled and forced here on the
-- tenant-scoped tables this migration creates; the four policies per table
-- bound to app.current_tenant_id() land in task 26.1.
--
-- No credential plaintext appears in this migration. The *_encrypted columns
-- store ciphertext written by the Configuration_Service (task 5.1) only.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Money representation (Requirement 15.1, 15.8)
--
-- Every monetary column in the FinanceOS schema uses one of these three
-- domains. All are BIGINT underneath with a range CHECK, so the range rule is
-- enforced by the database on every insert and every update, in every table,
-- without relying on application code. No NUMERIC, DECIMAL, REAL, DOUBLE
-- PRECISION, FLOAT or MONEY column holds a monetary value anywhere.
-- ----------------------------------------------------------------------------

-- Signed paise: the full FinanceOS_Calculation_Service range (Requirement 15.1, 15.8)
CREATE DOMAIN paise AS BIGINT
  CHECK (VALUE BETWEEN -99999999999999 AND 99999999999999);

-- Unsigned paise as retrieved from Razorpay, no rounding or scaling applied (Requirement 1.7)
CREATE DOMAIN paise_ingested AS BIGINT
  CHECK (VALUE BETWEEN 0 AND 999999999999);

-- Positive paise for a single Ledger_Entry amount (Requirement 2.1)
CREATE DOMAIN paise_positive AS BIGINT
  CHECK (VALUE > 0 AND VALUE <= 99999999999999);

-- ----------------------------------------------------------------------------
-- 2. Session tenant resolution (Requirement 14.1, 14.4, 14.8, 14.10)
--
-- The Tenant claim is written into the session at authentication and is never
-- re-derived from a request argument, which is what makes the session Tenant
-- binding immutable for the session lifetime (Requirement 14.8).
--
-- Both functions return NULL when the claim is absent - not an error, not a
-- sentinel. `tenant_id = NULL` is never true, so an unauthenticated or
-- unscoped request matches zero rows instead of raising a permission error
-- that would confirm the row exists.
-- ----------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS app;

-- The single source of the session Tenant. Reads the Supabase Auth JWT claim.
-- Returns NULL when no session claim is present, which makes every RLS policy
-- evaluate false and return zero rows (Requirement 14.4, 14.10).
CREATE FUNCTION app.current_tenant_id() RETURNS UUID
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT NULLIF(
    current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id', ''
  )::uuid
$$;

CREATE FUNCTION app.current_user_id() RETURNS UUID
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT NULLIF(
    current_setting('request.jwt.claims', true)::jsonb ->> 'sub', ''
  )::uuid
$$;

-- ----------------------------------------------------------------------------
-- 3. Tenancy, users, permissions (Requirement 14.1, 14.6, 14.8)
--
-- A User may hold membership in several Tenants, but a session binds exactly
-- one (Requirement 14.8).
-- ----------------------------------------------------------------------------

CREATE TABLE tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            UUID PRIMARY KEY,             -- matches auth.users.id
  email         TEXT NOT NULL UNIQUE,
  full_name     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tenant_memberships (
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id       UUID NOT NULL REFERENCES users(id)   ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TYPE permission AS ENUM (
  'view_financial_data', 'run_agents', 'approve_sensitive_actions',
  'configure_policy', 'manage_credentials', 'manage_users'
);

-- Exactly the 6 Permissions of Requirement 14.6, granted per Tenant per User.
CREATE TABLE user_permissions (
  tenant_id     UUID NOT NULL,
  user_id       UUID NOT NULL,
  permission    permission NOT NULL,
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by    UUID NOT NULL REFERENCES users(id),
  PRIMARY KEY (tenant_id, user_id, permission),
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_memberships(tenant_id, user_id)
);

-- ----------------------------------------------------------------------------
-- 4. Configuration (Requirement 14.5)
--
-- Every configuration column is nullable; ConfigurationService.get applies the
-- documented default when a value is unset, so an unconfigured Tenant behaves
-- exactly as the requirements specify without a migration writing defaults
-- into rows.
--
-- Credential columns hold encrypted values only (BYTEA), never plaintext.
-- razorpay_key_secret_encrypted covers the 'razorpay_test' CredentialKind;
-- provider_keys_encrypted covers 'openrouter', 'gemini' and 'groq'.
-- razorpay_key_id_masked is the masked reference returned to clients.
-- ----------------------------------------------------------------------------

CREATE TABLE tenant_configuration (
  tenant_id                     UUID PRIMARY KEY REFERENCES tenants(id),
  auto_execute_threshold        SMALLINT CHECK (auto_execute_threshold BETWEEN 0 AND 100),
  approval_window_hours         SMALLINT CHECK (approval_window_hours BETWEEN 1 AND 168),
  compliance_review_threshold_paise paise CHECK (compliance_review_threshold_paise
                                     BETWEEN 0 AND 10000000000),
  tds_rates                     JSONB,                     -- category -> NUMERIC(5,2)
  valid_gst_rates               JSONB,                     -- default {0,0.25,3,5,12,18,28}
  forecast_horizon_days         SMALLINT CHECK (forecast_horizon_days BETWEEN 30 AND 180),
  safety_buffer_paise           paise CHECK (safety_buffer_paise BETWEEN 0 AND 100000000000),
  lookback_window_days          SMALLINT CHECK (lookback_window_days BETWEEN 30 AND 730),
  minimum_sample_size           SMALLINT CHECK (minimum_sample_size BETWEEN 10 AND 1000),
  maximum_retry_age_days        SMALLINT CHECK (maximum_retry_age_days BETWEEN 1 AND 30),
  unusual_multiple              NUMERIC(4,1) CHECK (unusual_multiple BETWEEN 1.5 AND 20.0),
  model_timeout_ms              INT CHECK (model_timeout_ms BETWEEN 1000 AND 60000),
  model_monthly_cap_paise       paise CHECK (model_monthly_cap_paise
                                  BETWEEN 100 AND 100000000),
  audit_retention_days          INT CHECK (audit_retention_days >= 2555),
  razorpay_key_id_masked        TEXT,
  razorpay_key_secret_encrypted BYTEA,                      -- never returned to a client
  provider_keys_encrypted       BYTEA,
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                    UUID REFERENCES users(id)
);

-- ----------------------------------------------------------------------------
-- 5. Row-level security on the tenant-scoped tables created above
--
-- design.md's "Row-level security" section lists tenant_memberships,
-- user_permissions and tenant_configuration among the tenant-scoped tables
-- that get RLS enabled and forced. `tenants` and `users` are not tenant-scoped
-- rows and are not in that list.
--
-- FORCE ROW LEVEL SECURITY applies the predicate to the table owner too, so
-- there is no privileged read path that bypasses the Tenant predicate.
--
-- The four policies per table bound to app.current_tenant_id() land in
-- task 26.1. Until then these three tables match zero rows for every
-- non-superuser role, which is the fail-closed direction.
-- ----------------------------------------------------------------------------

ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_memberships FORCE ROW LEVEL SECURITY;

ALTER TABLE user_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_permissions FORCE ROW LEVEL SECURITY;

ALTER TABLE tenant_configuration ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_configuration FORCE ROW LEVEL SECURITY;
