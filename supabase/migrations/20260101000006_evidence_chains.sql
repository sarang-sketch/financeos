-- ============================================================================
-- FinanceOS Control Tower - migration 6 of 7 for the schema groups (task 4.6)
--   20260101000006_evidence_chains.sql
--
-- Naming convention: see the header of
--   20260101000001_money_domains_tenancy_configuration.sql (task 4.1).
-- Applies after 20260101000005_exceptions.sql (task 4.5) and before
--   20260101000007_settlement_reconciliations.sql (task 4.7),
-- which foreign-keys settlement_reconciliations.evidence_chain_id onto
-- evidence_chains(id) created here.
--
-- Contents (design.md, "Data Models" -> "Evidence chains", plus one entry of
-- "Data Models" -> "Indexes" -> "Audit and evidence"):
--   1. evidence_chains (figure_paise, source_count >= 1, as_of, produced_by)
--   2. evidence_operation enum, the 9 operations the replay interpreter
--      switches on
--   3. evidence_chain_steps (1-based step_index, operands JSONB,
--      nullable result_paise)
--   4. evidence_chain_sources with record_updated_at
--   5. RLS enable + force
--   6. Index evidence_chain_sources_idx
--
-- Requirements: 12.2, 12.5, 12.8
--
-- Depends on 20260101000001: the paise domain, tenants, and the app schema.
-- Depends on 20260101000003: the source_record_type enum, which
-- evidence_chain_sources reuses. It is NOT recreated here.
--
-- WHY THIS SCHEMA GROUP IS THE REPLAY INPUT - READ BEFORE EDITING
--   evidence_chain_steps ordered by step_index is the replay input for
--   property P6: an independent interpreter (task 9.2), sharing no code with
--   the Financial_Tool that produced the chain, walks the steps in step_index
--   order and must reproduce evidence_chains.figure_paise in exact integer
--   paise with zero difference (Requirement 12.8). Two consequences:
--     - Every evidence_operation label is a case that interpreter must handle.
--       Adding a label here without adding the case there turns the
--       interpreter into a partial function and P6 into a false pass.
--     - No monetary value anywhere in this file is NUMERIC, DECIMAL, REAL,
--       DOUBLE PRECISION, FLOAT or MONEY. figure_paise and result_paise are
--       the paise domain (BIGINT with the range CHECK); monetary literals
--       inside operands JSONB are decimal strings, never JSON numbers - see
--       the note on section 3.
--
--   record_updated_at compared against evidence_chains.as_of is what produces
--   the stale indicator in the UI (Requirement 12.5). Both columns are
--   TIMESTAMPTZ and both are NOT NULL, so the comparison is always defined:
--   there is no row for which staleness is unknown.
--
-- DELIBERATELY DEFERRED, NOT MISSING
--   - RLS policies. RLS is enabled and forced here on all three tables; the
--     four policies per table bound to app.current_tenant_id() land in task
--     26.1. See FINDING 1 about evidence_chain_steps.
--   - The Evidence_Chain composer inside each Financial_Tool, the independent
--     replay interpreter (task 9.2), the 500-per-page source retrieval and the
--     drill-down UI with its stale indicator are their own tasks. This file is
--     storage and invariants only.
--   - Runtime verification - that every constraint, the index and the
--     information_schema.columns type audit behave as written - is task 4.8.
--     Nothing here has been executed against a database: Supabase local is
--     unavailable in this environment (no Docker daemon, no config.toml, no
--     psql), so this migration was verified statically, object by object,
--     against design.md's "Evidence chains" block.
--
-- FINDINGS - transcribed as design.md writes them, reported, not corrected
--   FINDING 1: evidence_chain_steps carries NO tenant_id column, unlike every
--     other child table in the schema (ledger_entry_sources,
--     exception_source_records, evidence_chain_sources all carry the
--     denormalised tenant_id design.md says exists so an RLS policy can be a
--     direct column comparison). design.md's "Row-level security" section
--     nonetheless lists evidence_chain_steps as tenant-scoped. Its policies
--     therefore cannot be `tenant_id = app.current_tenant_id()`; they must
--     qualify through evidence_chains.tenant_id, or the column must be added
--     first. Resolved in task 26.1. RLS is enabled and forced here regardless,
--     so the table is never left open while that is decided.
--   FINDING 2: nothing constrains step_index to be GAPLESS, and nothing
--     constrains a { kind: 'step', index } operand to reference a LOWER
--     step_index in the same chain. The primary key gives uniqueness and hence
--     a total order, which is what replay needs to be deterministic, but a
--     chain stored with indexes (1, 2, 5), or a step 3 whose operand cites
--     step 7, is accepted by this schema. Either shape makes P6's replay
--     undefined rather than wrong - the interpreter of task 9.2 has no value to
--     read. design.md specifies no such constraint, so none is invented here;
--     the chain composer must guarantee gapless 1..n with backward-only step
--     references, and task 4.8 / P6 are where that is asserted.
--   FINDING 3: source_count is denormalised on the header and nothing ties it
--     to the number of evidence_chain_sources rows. P6 asserts
--     source_count === concatenatedPages(chain).length at the tool boundary; in
--     the database the two can drift.
--   FINDING 4: evidence_chain_sources.field is declared without NOT NULL but
--     is part of the primary key, so Postgres marks it NOT NULL implicitly. A
--     citation of a whole record with no particular field read is therefore not
--     representable. Reproduced exactly as design.md writes it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Evidence_Chain header (Requirement 12.2)
--
-- source_count >= 1 is the grounding floor: every Evidence_Chain references at
-- least 1 Source_Record. A chain with 0 sources is an ungrounded figure, which
-- is the exact failure this system exists to prevent, so the floor is a table
-- constraint rather than an application convention.
--
-- source_count is the total count of Source_Record identifiers in the chain
-- and is what the 500-per-page source pagination of Requirement 12.2 and the
-- 100-per-page UI pagination of Requirement 12.5 are checked against, so it
-- is stored rather than counted per request.
--
-- as_of is the as-of timestamp of the most recently updated Source_Record in
-- the chain. produced_by is the Financial_Tool name.
-- ----------------------------------------------------------------------------

CREATE TABLE evidence_chains (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id),
  figure_paise  paise NOT NULL,
  source_count  INT NOT NULL CHECK (source_count >= 1),     -- Requirement 12.2
  as_of         TIMESTAMPTZ NOT NULL,                       -- newest contributing record
  produced_by   TEXT NOT NULL,                              -- Financial_Tool name
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 2. The operation vocabulary of a computation step (Requirement 12.2, 12.8)
--
-- Each step states exactly 1 arithmetic operation. This enum is the closed set
-- of operations the replay interpreter of task 9.2 must be total over.
-- ----------------------------------------------------------------------------

CREATE TYPE evidence_operation AS ENUM (
  'sum', 'subtract', 'add', 'multiply', 'divide',
  'round_half_up', 'negate', 'select', 'compare'
);

-- ----------------------------------------------------------------------------
-- 3. Ordered computation steps (Requirement 12.2, 12.5, 12.8)
--
-- step_index is 1-based and the primary key is (chain_id, step_index), so
-- within one chain the indexes are unique and ORDER BY step_index is a total
-- order over the steps. That plus CHECK (step_index >= 1) is exactly what
-- design.md specifies; design.md states no gapless constraint, so none is
-- invented here - see FINDING 2 in the header. The interpreter of task 9.2 and
-- the UI of Requirement 12.5 both read the steps in step_index order.
--
-- operands is the step's inputs, matching design.md's EvidenceStep.operands:
-- an ordered JSON array whose elements are one of three shapes -
--   { kind: 'source',  ref: { type, id }, field }   a field of a Source_Record
--   { kind: 'step',    index }                      a preceding step's output
--   { kind: 'literal', value }                      a literal
-- A 'literal' carries `value` as a STRING, not a JSON number. That is the
-- money rule holding inside JSONB: a monetary literal written as a JSON number
-- would be read back through a double by most JSON parsers and could replay to
-- a different value than the one stored, breaking Requirement 12.8 in a way
-- that looks like a logic bug. A 'step' operand's `index` is an ordinal, not
-- money, so it is a plain JSON number.
--
-- result_paise is NULL for steps with no single monetary result - 'compare'
-- yields a boolean outcome, 'select' can pick a non-monetary field - which is
-- why it is the only nullable monetary column in this schema group.
-- ----------------------------------------------------------------------------

CREATE TABLE evidence_chain_steps (
  chain_id      UUID NOT NULL REFERENCES evidence_chains(id) ON DELETE CASCADE,
  step_index    SMALLINT NOT NULL CHECK (step_index >= 1),   -- 1-based, ordered
  operation     evidence_operation NOT NULL,
  operands      JSONB NOT NULL,                             -- source refs, prior step indexes, literals
  result_paise  paise,                                      -- NULL for non-monetary steps
  note          TEXT,
  PRIMARY KEY (chain_id, step_index)
);

-- ----------------------------------------------------------------------------
-- 4. Source_Record citations (Requirement 12.2, 12.5)
--
-- One row per (record, field) the chain read. source_count on the header is
-- the count of Source_Record identifiers these rows carry.
--
-- record_updated_at is the update timestamp of the cited record as it stood
-- when the chain was composed. The UI marks the chain stale where any
-- referenced record has been updated after evidence_chains.as_of
-- (Requirement 12.5), so this column is the left-hand side of that comparison
-- and is NOT NULL.
--
-- source_record_type reuses the enum created in 20260101000003, so the type
-- vocabulary of an Evidence_Chain citation is identical to that of a
-- Ledger_Entry citation.
--
-- NOTE: `field` is written without NOT NULL in design.md but is part of the
-- primary key, so Postgres marks it NOT NULL implicitly. The column is
-- reproduced exactly as design.md writes it - see FINDING 4 in the header.
-- ----------------------------------------------------------------------------

CREATE TABLE evidence_chain_sources (
  chain_id            UUID NOT NULL REFERENCES evidence_chains(id) ON DELETE CASCADE,
  tenant_id           UUID NOT NULL,
  source_record_type  source_record_type NOT NULL,
  source_record_id    TEXT NOT NULL,
  field               TEXT,                                 -- the field read from that record
  record_updated_at   TIMESTAMPTZ NOT NULL,                 -- drives the stale indicator
  PRIMARY KEY (chain_id, source_record_type, source_record_id, field)
);

-- ----------------------------------------------------------------------------
-- 5. Row-level security on the tables created above
--
-- design.md's "Row-level security" section lists evidence_chains,
-- evidence_chain_steps and evidence_chain_sources among the tenant-scoped
-- tables that get RLS enabled and forced.
--
-- FORCE ROW LEVEL SECURITY applies the predicate to the table owner too, so
-- there is no privileged read path that bypasses the Tenant predicate. This
-- matters more here than almost anywhere: an Evidence_Chain quotes the field
-- values of another Tenant's Source_Records if it can be read across the
-- Tenant boundary.
--
-- The policies bound to app.current_tenant_id() land in task 26.1. Until then
-- these tables match zero rows for every non-superuser role, which is the
-- fail-closed direction.
--
-- NOTE FOR TASK 26.1: evidence_chain_steps carries no tenant_id column in
-- design.md's DDL, so its policies must qualify through
-- evidence_chains.tenant_id rather than compare a local column. See FINDING 1
-- in the header. RLS is still enabled and forced here so the table is never
-- left open while that is resolved.
-- ----------------------------------------------------------------------------

ALTER TABLE evidence_chains ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_chains FORCE ROW LEVEL SECURITY;

ALTER TABLE evidence_chain_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_chain_steps FORCE ROW LEVEL SECURITY;

ALTER TABLE evidence_chain_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_chain_sources FORCE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 6. Indexes (design.md, "Indexes" - "Audit and evidence")
--
-- The reverse lookup: "which Evidence_Chains cite this Source_Record?" This is
-- the query behind the stale check of Requirement 12.5 and behind tracing a
-- record forward into every figure that depends on it.
-- ----------------------------------------------------------------------------

CREATE INDEX evidence_chain_sources_idx
  ON evidence_chain_sources (tenant_id, source_record_type, source_record_id);
