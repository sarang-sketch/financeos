-- FinanceOS Control Tower — make stored Audit Chain_Value values independently reproducible.
--
-- Migration 4 hashed jsonb::text while the TypeScript verifier uses canonical JSON
-- (object keys sorted lexicographically, arrays preserved, compact separators). That made
-- every non-empty Audit_Event look tampered even when it was untouched. This migration:
--   1. defines the same canonical JSON rendering in Postgres;
--   2. updates app.append_audit_event to hash that rendering; and
--   3. re-chains existing per-Tenant logs in sequence order.
--
-- Requirements: 13.4, 13.8. Property: P9.

CREATE OR REPLACE FUNCTION app.canonical_jsonb(p_value JSONB)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, app, pg_temp
AS $fn$
DECLARE
  v_kind TEXT := jsonb_typeof(p_value);
  v_result TEXT;
  v_item RECORD;
  v_first BOOLEAN := true;
  v_number TEXT;
BEGIN
  CASE v_kind
    WHEN 'object' THEN
      v_result := '{';
      FOR v_item IN
        SELECT key, value
          FROM jsonb_each(p_value)
         ORDER BY key COLLATE "C"
      LOOP
        IF NOT v_first THEN
          v_result := v_result || ',';
        END IF;
        v_result := v_result || to_jsonb(v_item.key)::TEXT || ':' || app.canonical_jsonb(v_item.value);
        v_first := false;
      END LOOP;
      RETURN v_result || '}';

    WHEN 'array' THEN
      v_result := '[';
      FOR v_item IN
        SELECT value
          FROM jsonb_array_elements(p_value) WITH ORDINALITY AS element(value, position)
         ORDER BY position
      LOOP
        IF NOT v_first THEN
          v_result := v_result || ',';
        END IF;
        v_result := v_result || app.canonical_jsonb(v_item.value);
        v_first := false;
      END LOOP;
      RETURN v_result || ']';

    WHEN 'number' THEN
      -- JSON.stringify emits the shortest ordinary decimal form for this system's
      -- generated/stored numeric input. jsonb preserves an input scale (1.0), so remove
      -- insignificant fractional zeroes before hashing.
      v_number := p_value::TEXT;
      IF position('.' IN v_number) > 0 THEN
        v_number := regexp_replace(v_number, '0+$', '');
        v_number := regexp_replace(v_number, '\.$', '');
      END IF;
      RETURN v_number;

    WHEN 'string' THEN
      RETURN p_value::TEXT;
    WHEN 'boolean' THEN
      RETURN p_value::TEXT;
    WHEN 'null' THEN
      RETURN 'null';
    ELSE
      RAISE EXCEPTION 'unsupported jsonb kind for audit canonicalization: %', v_kind;
  END CASE;
END
$fn$;

COMMENT ON FUNCTION app.canonical_jsonb(JSONB) IS
'Canonical JSON for Audit Chain_Value computation: object keys sorted with C collation, '
'arrays preserved, compact separators, and insignificant numeric scale removed.';

CREATE OR REPLACE FUNCTION app.append_audit_event(
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
  SELECT last_sequence + 1, last_chain_value INTO v_seq, v_prev
    FROM audit_sequence_counters WHERE tenant_id = p_tenant_id FOR UPDATE;

  v_bytes := octet_length(v_payload::text);
  IF v_bytes > 65536 THEN
    v_payload := jsonb_build_object('reduced', true,
                   'excerpt', left(v_payload::text, 60000));
    v_reduced := true;
    v_bytes := octet_length(v_payload::text);
  END IF;

  v_chain := encode(digest(
      p_tenant_id::text || '|' || v_seq::text || '|' || p_event_type || '|' ||
      p_actor_kind || '|' || p_actor_id || '|' || COALESCE(p_stage,'') || '|' ||
      COALESCE(p_outcome,'') || '|' || COALESCE(p_proposal_id::text,'') || '|' ||
      app.canonical_jsonb(p_source_refs) || '|' || app.canonical_jsonb(v_payload) || '|' ||
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
END
$fn$;

COMMENT ON FUNCTION app.append_audit_event(UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
                                          UUID, JSONB, JSONB, TIMESTAMPTZ) IS
'Appends one Audit_Event with a Tenant-scoped gapless sequence and a SHA-256 Chain_Value '
'over canonical stored fields plus the preceding Chain_Value (Requirements 13.1, 13.4).';

-- Recompute existing logs so verification remains valid across the migration boundary.
-- The append-only trigger is disabled only inside this transactional migration and restored
-- before commit; application roles retain no UPDATE or DELETE privilege throughout.
ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only;

DO $migration$
DECLARE
  v_tenant RECORD;
  v_event RECORD;
  v_prev CHAR(64);
  v_chain CHAR(64);
  v_last_sequence BIGINT;
BEGIN
  FOR v_tenant IN
    SELECT tenant_id FROM audit_sequence_counters ORDER BY tenant_id
  LOOP
    v_prev := repeat('0', 64);
    v_last_sequence := 0;

    FOR v_event IN
      SELECT *
        FROM audit_events
       WHERE tenant_id = v_tenant.tenant_id
       ORDER BY sequence_number
    LOOP
      v_chain := encode(digest(
          v_event.tenant_id::text || '|' || v_event.sequence_number::text || '|' ||
          v_event.event_type || '|' || v_event.actor_kind || '|' || v_event.actor_id || '|' ||
          COALESCE(v_event.stage,'') || '|' || COALESCE(v_event.outcome,'') || '|' ||
          COALESCE(v_event.proposal_id::text,'') || '|' ||
          app.canonical_jsonb(v_event.source_record_refs) || '|' ||
          app.canonical_jsonb(v_event.payload) || '|' ||
          to_char(v_event.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ||
          '|' || v_prev, 'sha256'), 'hex');

      UPDATE audit_events
         SET prev_chain_value = v_prev,
             chain_value = v_chain
       WHERE id = v_event.id;

      v_prev := v_chain;
      v_last_sequence := v_event.sequence_number;
    END LOOP;

    UPDATE audit_sequence_counters
       SET last_sequence = v_last_sequence,
           last_chain_value = v_prev
     WHERE tenant_id = v_tenant.tenant_id;
  END LOOP;
END
$migration$;

ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only;
