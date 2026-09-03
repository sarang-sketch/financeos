-- ============================================================================
-- FinanceOS Control Tower - migration 4 of 7 for the schema groups (task 4.4)
--   20260101000004_audit_log_append_only.sql
--
-- Runs after 20260101000003_semantic_ledger.sql (task 4.3), which creates
-- ledger_entries. That ordering matters: the ledger_entries append-only
-- trigger lives in THIS file because reject_mutation_and_audit() appends a
-- mutation_rejected Audit_Event, so it cannot exist before audit_events does.
--
-- Contents (design.md, "Audit log" / "Append-only enforcement" / "Indexes"):
--   1. Extensions the audit chain depends on (see FINDING 1)
--   2. audit_events
--   3. audit_sequence_counters
--   4. app.append_audit_event(...) - sequence allocation + SHA-256 chain value
--   5. app.append_audit_event_autonomous(...) (see FINDING 2)
--   6. Append-only barrier 1: privileges on audit_events
--   7. Append-only barrier 2: reject_mutation_and_audit() + BOTH triggers
--   8. Indexes audit_events_sequence_idx, audit_events_source_refs_idx (GIN),
--      audit_events_proposal_idx
--   9. RLS enabled and forced (policies deferred to task 26.1)
--
-- Requirements: 2.7, 13.1, 13.3, 13.4, 13.5
--
-- SCOPE: storage layer only. AuditService.history / historyForProposal, the
-- chain verification walk (verifyChain, Requirement 13.6-13.8) and property P9
-- land in Slice 3. This migration ships in Slice 1 only because the
-- ledger_entries append-only barrier depends on audit_events existing.
--
-- Ownership split with task 4.3: 4.3 owns ledger_entries and its REVOKE/GRANT.
-- This file owns audit_events, audit_sequence_counters, the append functions,
-- the audit_events REVOKE/GRANT, reject_mutation_and_audit(), and BOTH
-- BEFORE UPDATE OR DELETE triggers (audit_events and ledger_entries).
--
-- Credential values never enter p_payload. The Configuration_Service returns
-- masked references only and the AI_Gateway strips credentials before
-- recording, so no credential value reaches an Audit_Event payload
-- (Requirement 13.2, 11.12, 14.5). Nothing in this file relaxes that.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Extensions
--
-- FINDING 1 (reported, not silently absorbed): design.md's
-- app.append_audit_event calls digest(..., 'sha256'), which is supplied by
-- pgcrypto, but design.md never declares the extension anywhere. Requirement
-- 13.4 mandates the stored Chain_Value, so the extension is load-bearing. It is
-- created here so the migration applies; the declaration belongs in design.md.
--
-- pgcrypto is installed into `extensions` because that is where Supabase keeps
-- it. On a plain Postgres the schema is created first. Both the append
-- functions pin `search_path = public, extensions, pg_temp`, which resolves
-- digest() either way and, being a fixed path on a SECURITY DEFINER function,
-- closes the search_path hijack that design.md's unpinned definition leaves
-- open. design.md's function *bodies* are transcribed unchanged.
-- ----------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS extensions;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- FINDING 2: design.md's reject_mutation_and_audit() calls
-- app.append_audit_event_autonomous(...) "on an autonomous connection so it
-- survives the rollback", but design.md never defines that function. Requirement
-- 13.5 requires BOTH that the mutation is rejected with an error AND that the
-- rejected attempt is appended - and a rejecting RAISE rolls back anything
-- written in the same transaction. Stock Postgres has no autonomous
-- transaction, so the append needs a second connection: dblink. Declared here
-- for the same reason as pgcrypto, and reported for the same reason.
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;


-- ----------------------------------------------------------------------------
-- 2. audit_events (Requirement 13.1, 13.3, 13.4)
--
-- Transcribed from design.md's "Audit log" block, with one deferral:
--
-- FINDING 3: design.md declares `proposal_id UUID REFERENCES proposals(id)`,
-- but `proposals` is created by task 21.1, which runs long after this
-- migration. The column is created here with design.md's exact name, type and
-- nullability; the foreign key is deferred. Task 21.1 must add, after creating
-- proposals:
--
--   ALTER TABLE audit_events
--     ADD CONSTRAINT audit_events_proposal_id_fkey
--     FOREIGN KEY (proposal_id) REFERENCES proposals(id);
--
-- occurred_at is UTC to millisecond precision per Requirement 13.1. The column
-- is plain TIMESTAMPTZ exactly as design.md writes it - see FINDING 6 on what
-- that means for chain recomputation.
-- ----------------------------------------------------------------------------

CREATE TABLE audit_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  sequence_number       BIGINT NOT NULL CHECK (sequence_number >= 1),  -- Tenant-scoped, gapless
  event_type            TEXT NOT NULL,
  stage                 TEXT CHECK (stage IN ('DETECT','INVESTIGATE','EXPLAIN','PROPOSE',
                                              'AUTHORIZE','EXECUTE','VERIFY')),
  outcome               TEXT CHECK (outcome IN ('succeeded', 'failed', 'blocked')),
  actor_kind            TEXT NOT NULL CHECK (actor_kind IN ('user', 'agent', 'policy_engine')),
  actor_id              TEXT NOT NULL,                 -- user id, agent name, or policy engine id
  proposal_id           UUID,                          -- FK added in task 21.1, see FINDING 3
  source_record_refs    JSONB NOT NULL DEFAULT '[]'::jsonb,  -- identifiers only (Requirement 13.2)
  payload               JSONB NOT NULL,
  payload_reduced       BOOLEAN NOT NULL DEFAULT false,      -- Requirement 13.3
  payload_bytes         INT NOT NULL CHECK (payload_bytes <= 65536),
  occurred_at           TIMESTAMPTZ NOT NULL,                -- UTC, millisecond precision
  chain_value           CHAR(64) NOT NULL,                   -- hex SHA-256 (Requirement 13.4)
  prev_chain_value      CHAR(64) NOT NULL,
  CONSTRAINT audit_events_sequence_uniq UNIQUE (tenant_id, sequence_number)
);


-- ----------------------------------------------------------------------------
-- 3. audit_sequence_counters (Requirement 13.1, 13.4)
--
-- One counter row per Tenant. Locked with SELECT ... FOR UPDATE so sequence
-- allocation and chain computation are serialized per Tenant.
--
-- A Postgres sequence would leave gaps on rollback, which would break the
-- gapless requirement of Requirement 13.1, so allocation uses this counter row
-- instead: it advances only on commit, so a rolled-back append consumes no
-- sequence number and the verification walk of Requirement 13.8 finds no gap.
--
-- last_chain_value defaults to 64 zeros, the fixed initial Chain_Value of
-- Requirement 13.4, matching design.md's INITIAL_CHAIN_VALUE = '0'.repeat(64).
-- ----------------------------------------------------------------------------

CREATE TABLE audit_sequence_counters (
  tenant_id         UUID PRIMARY KEY REFERENCES tenants(id),
  last_sequence     BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  last_chain_value  CHAR(64) NOT NULL DEFAULT repeat('0', 64)   -- fixed initial Chain_Value
);

-- FINDING 4: app.append_audit_event below reads the counter row with
-- SELECT ... FOR UPDATE and never creates it. For a Tenant with no counter row
-- the SELECT finds nothing, v_seq and v_prev stay NULL, and the INSERT fails on
-- audit_events.sequence_number NOT NULL - so that Tenant can never record its
-- first Audit_Event. design.md's entity diagram states the relationship as
-- TENANTS ||--|| AUDIT_SEQUENCE_COUNTERS (exactly one), so a counter row is
-- clearly intended to exist per Tenant, but no migration, trigger or service in
-- design.md creates it. Implemented as written; the seeding step needs to be
-- assigned (tenant provisioning, or an upsert inside append_audit_event).


-- ----------------------------------------------------------------------------
-- 4. app.append_audit_event (Requirement 13.1, 13.3, 13.4)
--
-- Body transcribed from design.md verbatim. The two additions are the pinned
-- search_path (FINDING 1) and nothing else.
--
-- The 65536-byte reduction is design.md's exact reduction: the oversized
-- payload is REPLACED by {"reduced": true, "excerpt": <first 60000 of its
-- text>}, not truncated in place, payload_reduced is set, and payload_bytes is
-- recomputed over the replacement. source_record_refs is never touched, which
-- is what keeps the affected Source_Record identifiers unreduced
-- (Requirement 13.3).
-- ----------------------------------------------------------------------------

CREATE FUNCTION app.append_audit_event(
  p_tenant_id UUID, p_event_type TEXT, p_actor_kind TEXT, p_actor_id TEXT,
  p_stage TEXT, p_outcome TEXT, p_proposal_id UUID,
  p_source_refs JSONB, p_payload JSONB, p_occurred_at TIMESTAMPTZ
) RETURNS audit_events
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_prev CHAR(64); v_seq BIGINT;
  v_payload JSONB := p_payload; v_reduced BOOLEAN := false;
  v_bytes INT; v_chain CHAR(64); v_row audit_events;
BEGIN
  -- serialize per Tenant; gapless because the counter advances only on commit
  SELECT last_sequence + 1, last_chain_value INTO v_seq, v_prev
    FROM audit_sequence_counters WHERE tenant_id = p_tenant_id FOR UPDATE;

  v_bytes := octet_length(v_payload::text);
  IF v_bytes > 65536 THEN                                   -- Requirement 13.3
    v_payload := jsonb_build_object('reduced', true,
                   'excerpt', left(v_payload::text, 60000));
    v_reduced := true;
    v_bytes := octet_length(v_payload::text);
  END IF;

  v_chain := encode(digest(
      p_tenant_id::text || '|' || v_seq::text || '|' || p_event_type || '|' ||
      p_actor_kind || '|' || p_actor_id || '|' || COALESCE(p_stage,'') || '|' ||
      COALESCE(p_outcome,'') || '|' || COALESCE(p_proposal_id::text,'') || '|' ||
      p_source_refs::text || '|' || v_payload::text || '|' ||
      to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ||
      '|' || v_prev, 'sha256'), 'hex');

  INSERT INTO audit_events (tenant_id, sequence_number, event_type, stage, outcome,
    actor_kind, actor_id, proposal_id, source_record_refs, payload, payload_reduced,
    payload_bytes, occurred_at, chain_value, prev_chain_value)
  VALUES (p_tenant_id, v_seq, p_event_type, p_stage, p_outcome, p_actor_kind, p_actor_id,
    p_proposal_id, p_source_refs, v_payload, v_reduced, v_bytes, p_occurred_at,
    v_chain, v_prev)
  RETURNING * INTO v_row;

  UPDATE audit_sequence_counters
     SET last_sequence = v_seq, last_chain_value = v_chain
   WHERE tenant_id = p_tenant_id;

  RETURN v_row;
END $fn$;

COMMENT ON FUNCTION app.append_audit_event(UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
                                          UUID, JSONB, JSONB, TIMESTAMPTZ) IS
'Appends one Audit_Event: allocates the Tenant-scoped gapless sequence number '
'from audit_sequence_counters under a row lock, reduces a payload over 65536 '
'bytes (Requirement 13.3), and stores the SHA-256 Chain_Value over the '
'canonical field join with prev_chain_value (Requirement 13.4). '
'Credential values must never be passed in p_payload (Requirement 13.2).';


-- ----------------------------------------------------------------------------
-- 5. app.append_audit_event_autonomous (FINDING 2)
--
-- Signature is exactly the one design.md's reject_mutation_and_audit() calls:
-- p_tenant_id, p_event_type, p_actor, p_payload. The body is this file's, since
-- design.md supplies none.
--
-- It opens a second connection to the same database and appends there, so the
-- event is committed by that connection and survives the rollback that the
-- rejecting RAISE causes in the calling transaction. Without this, Requirement
-- 13.5's two halves - reject with an error, and append a record of the attempt -
-- cannot both hold.
--
-- FINDING 5: design.md's call site passes a single p_actor and no actor_kind,
-- but audit_events.actor_kind is NOT NULL CHECK IN ('user','agent',
-- 'policy_engine'). 'user' is used here because the rejected attempt comes from
-- a session; when app.current_user_id() is NULL the caller substitutes
-- session_user, which is a role name rather than a User identifier, so the
-- actor_kind is then approximate. p_stage and p_outcome are passed NULL rather
-- than inventing a stage or an outcome design.md does not state.
--
-- FINDING 8: dblink_connect here uses 'dbname=<current database>', which
-- authenticates over the local socket. That works for the SECURITY DEFINER
-- owner on a local or self-managed Postgres. On Supabase-hosted a full conninfo
-- with a credential is required, and this file must not carry one. design.md
-- specifies no connection strategy. Note that barrier 1 revokes UPDATE and
-- DELETE from every application role, so this path is only ever reached by a
-- role that still holds those privileges.
-- ----------------------------------------------------------------------------

CREATE FUNCTION app.append_audit_event_autonomous(
  p_tenant_id UUID, p_event_type TEXT, p_actor TEXT, p_payload JSONB
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_conn TEXT := 'financeos_audit_autonomous_' || pg_backend_pid()::text;
  v_sql  TEXT;
BEGIN
  -- A DO block returns no rows, which is what dblink_exec accepts.
  v_sql := format(
    $q$DO $do$ BEGIN PERFORM app.append_audit_event(
         p_tenant_id   => %L::uuid,
         p_event_type  => %L::text,
         p_actor_kind  => 'user',
         p_actor_id    => %L::text,
         p_stage       => NULL::text,
         p_outcome     => NULL::text,
         p_proposal_id => NULL::uuid,
         p_source_refs => '[]'::jsonb,
         p_payload     => %L::jsonb,
         p_occurred_at => %L::timestamptz); END $do$;$q$,
    p_tenant_id, p_event_type, p_actor, p_payload, now());

  PERFORM dblink_connect(v_conn, 'dbname=' || current_database());
  BEGIN
    PERFORM dblink_exec(v_conn, v_sql);
  EXCEPTION WHEN OTHERS THEN
    PERFORM dblink_disconnect(v_conn);
    RAISE;
  END;
  PERFORM dblink_disconnect(v_conn);
END $fn$;

COMMENT ON FUNCTION app.append_audit_event_autonomous(UUID, TEXT, TEXT, JSONB) IS
'Appends an Audit_Event on a second connection so it commits independently of '
'the calling transaction. Used by reject_mutation_and_audit() so a rejected '
'append-only mutation is both refused and recorded (Requirement 13.5).';


-- ----------------------------------------------------------------------------
-- 6. Append-only barrier 1: the privilege itself (Requirement 2.7, 13.1, 13.5)
--
-- No application role can update or delete an Audit_Event, so the common path
-- never reaches a trigger. audit_events accepts SELECT and INSERT only.
--
-- The matching REVOKE/GRANT for ledger_entries belongs to task 4.3 and lives in
-- 20260101000003_semantic_ledger.sql.
-- ----------------------------------------------------------------------------

REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM authenticated, anon, service_role;
GRANT  SELECT, INSERT ON audit_events TO authenticated, service_role;


-- ----------------------------------------------------------------------------
-- 7. Append-only barrier 2: a rejecting trigger that audits the attempt
--    (Requirement 2.7, 13.5)
--
-- BEFORE UPDATE OR DELETE, so the targeted row is never written: the rejection
-- happens before any change is applied, leaving the targeted Audit_Event's
-- sequence number, timestamp, actor identifier, payload and Chain_Value
-- untouched field by field, while a mutation_rejected Audit_Event carrying the
-- requesting actor and the targeted sequence number is appended on the
-- autonomous connection (Requirement 13.5). On ledger_entries the same barrier
-- means a persisted Ledger_Entry is corrected only ever by a reversal set
-- (Requirement 2.4).
--
-- FINDING 7 - a reported deviation, the only change to a design.md function
-- body in this file. design.md declares:
--
--   v_target TEXT := COALESCE(OLD.id::text, '');
--   v_seq    BIGINT := CASE WHEN TG_TABLE_NAME = 'audit_events'
--                           THEN (OLD).sequence_number ELSE NULL END;
--
-- One trigger function is attached to two tables, and ledger_entries has no
-- sequence_number column. Postgres resolves every field reference in an
-- expression during parse analysis, before CASE chooses a branch, so on
-- ledger_entries this raises `record "old" has no field "sequence_number"`
-- instead of the append-only rejection - defeating the barrier the task
-- requires on BOTH tables. The fields are therefore read through to_jsonb(OLD),
-- which is rowtype-agnostic and yields identical values: v_target is the same
-- id text, v_seq is the same sequence number on audit_events and NULL on
-- ledger_entries. Nothing else about the function changed.
-- ----------------------------------------------------------------------------

CREATE FUNCTION reject_mutation_and_audit() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_old    JSONB   := to_jsonb(OLD);
  v_target TEXT    := COALESCE(v_old ->> 'id', '');
  v_seq    BIGINT  := CASE WHEN TG_TABLE_NAME = 'audit_events'
                           THEN (v_old ->> 'sequence_number')::BIGINT ELSE NULL END;
BEGIN
  -- appended on an autonomous connection so it survives the rollback
  PERFORM app.append_audit_event_autonomous(
    p_tenant_id  => OLD.tenant_id,
    p_event_type => 'mutation_rejected',
    p_actor      => COALESCE(app.current_user_id()::text, session_user),
    p_payload    => jsonb_build_object(
                      'table', TG_TABLE_NAME,
                      'operation', TG_OP,
                      'target_id', v_target,
                      'targeted_sequence_number', v_seq)
  );
  RAISE EXCEPTION '% is append-only: % rejected', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $fn$;

-- Both triggers live here, including the ledger_entries one, because both
-- depend on app.append_audit_event_autonomous and therefore on audit_events.
-- 20260101000003_semantic_ledger.sql (task 4.3) creates ledger_entries and
-- leaves this trigger to this migration.
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_and_audit();

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_and_audit();


-- ----------------------------------------------------------------------------
-- 8. Indexes (design.md, "Indexes" - audit and evidence)
--
-- audit_events_sequence_idx    - the ascending-sequence verification walk and
--                                the ordered reads of Requirement 13.6, 13.8
-- audit_events_source_refs_idx - GIN over the JSONB identifier array, for
--                                Source_Record history (Requirement 13.6)
-- audit_events_proposal_idx    - per-Proposal stage history (Requirement 13.7)
-- ----------------------------------------------------------------------------

CREATE INDEX audit_events_sequence_idx ON audit_events (tenant_id, sequence_number);
CREATE INDEX audit_events_source_refs_idx ON audit_events USING GIN (source_record_refs);
CREATE INDEX audit_events_proposal_idx ON audit_events (tenant_id, proposal_id, sequence_number);


-- ----------------------------------------------------------------------------
-- 9. Row-level security
--
-- design.md's "Row-level security" section lists both audit_events and
-- audit_sequence_counters among the tenant-scoped tables that get RLS enabled
-- and forced, with UPDATE and DELETE policies omitted on audit_events because
-- those privileges are revoked outright.
--
-- FORCE ROW LEVEL SECURITY applies the predicate to the table owner too, so
-- there is no privileged read path around the Tenant predicate.
--
-- The policies bound to app.current_tenant_id() land in task 26.1, matching
-- 20260101000001. Until then these two tables match zero rows for every role
-- without BYPASSRLS, which is the fail-closed direction and which also means
-- the append path above is exercisable only by a BYPASSRLS role until 26.1.
-- ----------------------------------------------------------------------------

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

ALTER TABLE audit_sequence_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_sequence_counters FORCE ROW LEVEL SECURITY;


-- ----------------------------------------------------------------------------
-- FINDING 6 - the SQL chain_value is NOT byte-identical to design.md's
-- TypeScript chainValue. Recorded here because Slice 3's verification walk
-- (Requirement 13.8, property P9) recomputes in TypeScript and compares.
--
-- Field order, the '|' separator and the trailing prev_chain_value all match
-- exactly, 12 parts in both. Three divergences remain, all in the JSONB parts:
--
--   a) Key order. Postgres jsonb::text emits object keys sorted by key LENGTH
--      first, then bytewise. design.md says canonicalJson "sorts object keys",
--      which reads as plain lexicographic. {"b":1,"aa":2} hashes as
--      {"b": 1, "aa": 2} in SQL and as {"aa":2,"b":1} lexicographically.
--   b) Whitespace. jsonb::text emits ': ' after each key and ', ' between
--      members. A JSON.stringify-style canonicalJson emits neither.
--   c) Number text. jsonb preserves the numeric scale it parsed (1.0 stays
--      1.0), while JSON.stringify collapses 1.0 to 1.
--
-- So for any payload or source_record_refs that is not a scalar, the two
-- computations diverge and the Slice 3 walk would report a mismatch on every
-- row. Resolution belongs with design.md, not here: either canonicalJson is
-- specified to reproduce jsonb::text exactly (length-then-bytewise key order,
-- ': ' and ', ' separators, Postgres numeric text), or the SQL hashes a
-- canonical form instead of jsonb::text. This migration implements design.md's
-- SQL unchanged.
--
-- Two smaller notes on the same computation:
--   d) occurred_at is hashed through
--      to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), which is exactly
--      design.md's ISO-8601 UTC millisecond form. But the column is plain
--      TIMESTAMPTZ, so a caller may store microseconds; to_char then drops
--      the sub-millisecond digits while a TypeScript recomputation reading
--      occurred_at back sees them. TIMESTAMPTZ(3) would remove the hazard and
--      would match Requirement 13.1's "millisecond precision" literally.
--   e) The reduction's left(v_payload::text, 60000) counts CHARACTERS, while
--      payload_bytes and the 65536 threshold count BYTES. A payload of
--      multi-byte characters can therefore reduce to up to 240000 bytes and
--      then violate CHECK (payload_bytes <= 65536), so the append fails
--      instead of reducing. left(...) over 60000 bytes rather than characters
--      would satisfy Requirement 13.3 in every case. Implemented as written.
-- ----------------------------------------------------------------------------
