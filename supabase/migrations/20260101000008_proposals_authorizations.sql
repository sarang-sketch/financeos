-- FinanceOS Control Tower - proposal and authorization storage (task 21.1)
-- Authoritative DDL: design.md, "Proposals, authorizations, settlement reconciliation results".
-- Requirements: 5.4, 5.15, 5.16.

CREATE TYPE proposal_state AS ENUM (
  'proposed', 'blocked', 'awaiting_approval', 'authorized',
  'executed', 'verified', 'verification_failed',
  'execution_failed', 'rejected', 'expired'
);

CREATE TABLE proposals (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id),
  agent_name              TEXT NOT NULL,
  action_type             TEXT NOT NULL,
  target_source_records   JSONB NOT NULL,
  target_fingerprint      TEXT NOT NULL,
  impact_paise            paise NOT NULL,
  evidence_chain_id       UUID NOT NULL REFERENCES evidence_chains(id),
  expected_outcome        JSONB NOT NULL,
  risk_score              SMALLINT CHECK (risk_score BETWEEN 0 AND 100),
  threshold_used          SMALLINT CHECK (threshold_used BETWEEN 0 AND 100),
  policy_checks           JSONB,
  state                   proposal_state NOT NULL DEFAULT 'proposed',
  approval_deadline       TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_at             TIMESTAMPTZ,
  verified_at             TIMESTAMPTZ,
  observed_paise          paise,
  difference_paise        paise
);

CREATE TABLE authorizations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  proposal_id       UUID NOT NULL REFERENCES proposals(id),
  actor_kind        TEXT NOT NULL CHECK (actor_kind IN ('user', 'policy_engine')),
  actor_user_id     UUID REFERENCES users(id),
  decision          TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  decided_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((actor_kind = 'user') = (actor_user_id IS NOT NULL))
);

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_proposal_id_fkey
  FOREIGN KEY (proposal_id) REFERENCES proposals(id);

ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposals FORCE ROW LEVEL SECURITY;
ALTER TABLE authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE authorizations FORCE ROW LEVEL SECURITY;
