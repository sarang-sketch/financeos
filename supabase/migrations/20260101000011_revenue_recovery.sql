-- ============================================================================
-- FinanceOS — Revenue Recovery Schema (Migration 11)
--
-- Tables:
--   1. customers (customer profiles and identities)
--   2. customer_ltv (customer historical LTV, payment metrics, channel affinity)
--   3. payment_failures (failed payment records with computed probabilities)
--   4. recovery_proposals (actionable AI recovery proposals with policy gates)
--   5. recovery_attempts (executed recovery actions and gateway outcomes)
--   6. channel_statistics (tenant-level channel success rates & volume)
--   7. recovery_policies (tenant auto-execution and strategy settings)
-- ============================================================================

-- 1. Customers Table
CREATE TABLE IF NOT EXISTS customers (
  id TEXT NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers (tenant_id);

-- 2. Customer LTV & Recovery Metrics Table
CREATE TABLE IF NOT EXISTS customer_ltv (
  customer_id TEXT NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  ltv_paise paise_ingested NOT NULL DEFAULT 0,
  total_payments_count INT NOT NULL DEFAULT 0 CHECK (total_payments_count >= 0),
  successful_payments_count INT NOT NULL DEFAULT 0 CHECK (successful_payments_count >= 0),
  failed_payments_count INT NOT NULL DEFAULT 0 CHECK (failed_payments_count >= 0),
  preferred_channel TEXT DEFAULT 'upi',
  channel_success_rates JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_payment_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, customer_id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE CASCADE
);

-- 3. Payment Failures Table
CREATE TABLE IF NOT EXISTS payment_failures (
  id TEXT NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  payment_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  amount_paise paise_ingested NOT NULL,
  channel TEXT NOT NULL, -- upi, card, payment_link, netbanking, nach
  failure_reason TEXT NOT NULL, -- bank_server_timeout, insufficient_funds, payment_authentication_failed, card_expired, upi_pin_incorrect
  error_code TEXT,
  attempts_count INT NOT NULL DEFAULT 1 CHECK (attempts_count >= 1),
  recovery_probability INT NOT NULL DEFAULT 0 CHECK (recovery_probability BETWEEN 0 AND 100),
  recommended_channel TEXT NOT NULL,
  evidence_source TEXT NOT NULL CHECK (evidence_source IN ('CUSTOMER_LEVEL', 'TENANT_LEVEL')),
  status TEXT NOT NULL DEFAULT 'FAILED' CHECK (status IN ('FAILED', 'ANALYZING', 'PROPOSAL_READY', 'RETRYING', 'RECOVERED', 'UNRECOVERABLE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_payment_failures_status ON payment_failures (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_failures_created ON payment_failures (tenant_id, created_at DESC);

-- 4. Recovery Proposals Table
CREATE TABLE IF NOT EXISTS recovery_proposals (
  id TEXT NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  failure_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  amount_paise paise_ingested NOT NULL,
  recommended_channel TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  recovery_probability INT NOT NULL CHECK (recovery_probability BETWEEN 0 AND 100),
  expected_recovery_paise paise_ingested NOT NULL,
  risk_score TEXT NOT NULL DEFAULT 'Low (5/100)',
  evidence_source TEXT NOT NULL CHECK (evidence_source IN ('CUSTOMER_LEVEL', 'TENANT_LEVEL')),
  reasoning TEXT NOT NULL,
  evidence_chain_id UUID,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'EXECUTING', 'RECOVERED', 'FAILED', 'REJECTED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  executed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, failure_id) REFERENCES payment_failures(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_recovery_proposals_status ON recovery_proposals (tenant_id, status);

-- 5. Recovery Attempts Table
CREATE TABLE IF NOT EXISTS recovery_attempts (
  id TEXT NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  failure_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('INITIATED', 'SUCCESS', 'FAILED', 'PENDING')),
  amount_paise paise_ingested NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, failure_id) REFERENCES payment_failures(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT
);

-- 6. Channel Statistics Table
CREATE TABLE IF NOT EXISTS channel_statistics (
  id TEXT NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  channel TEXT NOT NULL,
  total_attempts INT NOT NULL DEFAULT 0,
  successful_attempts INT NOT NULL DEFAULT 0,
  success_rate NUMERIC(5,2) NOT NULL DEFAULT 0.00,
  recovered_paise paise_ingested NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, id)
);

-- 7. Recovery Policies Table
CREATE TABLE IF NOT EXISTS recovery_policies (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  auto_execution_ceiling_paise paise_ingested NOT NULL DEFAULT 5000000,
  require_dual_auth BOOLEAN NOT NULL DEFAULT FALSE,
  strategy TEXT NOT NULL DEFAULT 'BALANCED_AGGRESSIVE',
  channel_priorities JSONB NOT NULL DEFAULT '["upi", "card", "payment_link", "netbanking"]'::jsonb,
  min_confidence_threshold INT NOT NULL DEFAULT 65,
  notification_channels JSONB NOT NULL DEFAULT '["webhook", "email", "slack"]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable Row Level Security (RLS) on all recovery tables
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_ltv ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_statistics ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_policies ENABLE ROW LEVEL SECURITY;

-- Add RLS Policies for Tenant Isolation (Allow authenticated + service-role)
DO $$
BEGIN
  -- customers policies
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'customers' AND policyname = 'tenant_customers_isolation') THEN
    CREATE POLICY tenant_customers_isolation ON customers
      FOR ALL USING (tenant_id = app.current_tenant_id() OR current_user = 'postgres' OR current_setting('request.jwt.claims', true)::jsonb ->> 'role' = 'service_role');
  END IF;

  -- customer_ltv policies
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'customer_ltv' AND policyname = 'tenant_customer_ltv_isolation') THEN
    CREATE POLICY tenant_customer_ltv_isolation ON customer_ltv
      FOR ALL USING (tenant_id = app.current_tenant_id() OR current_user = 'postgres' OR current_setting('request.jwt.claims', true)::jsonb ->> 'role' = 'service_role');
  END IF;

  -- payment_failures policies
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'payment_failures' AND policyname = 'tenant_payment_failures_isolation') THEN
    CREATE POLICY tenant_payment_failures_isolation ON payment_failures
      FOR ALL USING (tenant_id = app.current_tenant_id() OR current_user = 'postgres' OR current_setting('request.jwt.claims', true)::jsonb ->> 'role' = 'service_role');
  END IF;

  -- recovery_proposals policies
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'recovery_proposals' AND policyname = 'tenant_recovery_proposals_isolation') THEN
    CREATE POLICY tenant_recovery_proposals_isolation ON recovery_proposals
      FOR ALL USING (tenant_id = app.current_tenant_id() OR current_user = 'postgres' OR current_setting('request.jwt.claims', true)::jsonb ->> 'role' = 'service_role');
  END IF;

  -- recovery_attempts policies
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'recovery_attempts' AND policyname = 'tenant_recovery_attempts_isolation') THEN
    CREATE POLICY tenant_recovery_attempts_isolation ON recovery_attempts
      FOR ALL USING (tenant_id = app.current_tenant_id() OR current_user = 'postgres' OR current_setting('request.jwt.claims', true)::jsonb ->> 'role' = 'service_role');
  END IF;

  -- channel_statistics policies
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'channel_statistics' AND policyname = 'tenant_channel_statistics_isolation') THEN
    CREATE POLICY tenant_channel_statistics_isolation ON channel_statistics
      FOR ALL USING (tenant_id = app.current_tenant_id() OR current_user = 'postgres' OR current_setting('request.jwt.claims', true)::jsonb ->> 'role' = 'service_role');
  END IF;

  -- recovery_policies policies
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'recovery_policies' AND policyname = 'tenant_recovery_policies_isolation') THEN
    CREATE POLICY tenant_recovery_policies_isolation ON recovery_policies
      FOR ALL USING (tenant_id = app.current_tenant_id() OR current_user = 'postgres' OR current_setting('request.jwt.claims', true)::jsonb ->> 'role' = 'service_role');
  END IF;
END $$;
