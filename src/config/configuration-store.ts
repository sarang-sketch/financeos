/**
 * The Supabase-backed adapters behind `ConfigurationStore` and
 * `ConfigurationAuditSink`.
 *
 * This file is the only place that knows how `tenant_configuration` looks on the
 * wire. PostgREST hands back a `BIGINT` as a JSON number, a `NUMERIC` as a number or
 * a string depending on scale, and a `BYTEA` as a `\x`-prefixed hex string. Doing
 * that coercion here rather than in the service keeps two rules intact: the service
 * sees `Paise` (`bigint`) only, and nothing in a monetary path calls `Number(...)`
 * (Requirement 15.1, 15.8).
 *
 * ## Why the live path cannot be integration-tested yet
 *
 * Both adapters are written against the schema as migrated, and neither is exercised
 * against a live database in this task. Three blockers, all recorded rather than
 * worked around:
 *
 * 1. `tenant_configuration` is `ENABLE`d and `FORCE`d for row-level security with **no
 *    policies until task 26.1**, so it matches zero rows for every role without
 *    `BYPASSRLS`. Reads return nothing and writes are refused.
 * 2. `app.append_audit_event` reads `audit_sequence_counters` with
 *    `SELECT ... FOR UPDATE` and never creates the row, so a Tenant with no counter row
 *    cannot record its first Audit_Event — FINDING 4 in
 *    `20260101000004_audit_log_append_only.sql`. The seeding step is unassigned.
 * 3. Supabase local is unavailable in this environment.
 *
 * The service's behaviour is asserted against in-memory fakes instead, which is why
 * both seams are interfaces. Wire the live path up in task 26.1.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Paise } from '@/calc/paise';
import { type Env, getEnv, redactSecrets } from '@/config/env';
import { createServiceClient } from '@/db/clients';
import type {
  ConfigurationAuditEvent,
  ConfigurationAuditSink,
  ConfigurationRow,
  ConfigurationRowPatch,
  ConfigurationStore,
  TenantId,
} from '@/config/configuration-service';

const TABLE = 'tenant_configuration';

/**
 * Thrown when the database refuses a configuration read or write. The message is run
 * through `redactSecrets`, which matches on credential **value**, so a credential that
 * reached a database error string is masked before it reaches a caller
 * (Requirement 14.5).
 */
export class ConfigurationStoreError extends Error {
  override readonly name = 'ConfigurationStoreError';

  constructor(operation: string, detail: string) {
    super(redactSecrets(`configuration ${operation} failed: ${detail}`));
  }
}

/* -------------------------------------------------------------------------- */
/* Wire coercion                                                              */
/* -------------------------------------------------------------------------- */

function asInteger(value: unknown, column: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  throw new ConfigurationStoreError('read', `${column} is not an integer on the wire`);
}

function asDecimal(value: unknown, column: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // PostgREST emits NUMERIC as a string when it will not survive as a JSON number.
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new ConfigurationStoreError('read', `${column} is not a number on the wire`);
}

/**
 * A paise column, always to `bigint`. `BigInt(...)` of the digit text, never
 * `Number(...)`: a monetary value must not pass through a float even when the
 * magnitude happens to be safe today.
 */
function asPaise(value: unknown, column: string): Paise | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new ConfigurationStoreError('read', `${column} is not integer paise on the wire`);
}

function asRateMap(value: unknown, column: string): Readonly<Record<string, number>> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigurationStoreError('read', `${column} is not a JSON object on the wire`);
  }
  const out: Record<string, number> = {};
  for (const [category, rate] of Object.entries(value)) {
    const parsed = asDecimal(rate, `${column}.${category}`);
    if (parsed !== null) out[category] = parsed;
  }
  return Object.freeze(out);
}

function asRateSet(value: unknown, column: string): readonly number[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    throw new ConfigurationStoreError('read', `${column} is not a JSON array on the wire`);
  }
  return Object.freeze(
    value.map((rate, index) => asDecimal(rate, `${column}[${index}]`) ?? 0),
  );
}

/** `\x68656c…` to bytes. PostgREST's `BYTEA` representation. */
export function decodeBytea(value: unknown, column: string): Uint8Array | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') {
    const hex = value.startsWith('\\x') ? value.slice(2) : value;
    if (hex.length === 0) return new Uint8Array(0);
    if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
      throw new ConfigurationStoreError('read', `${column} is not a bytea hex string`);
    }
    return Uint8Array.from(Buffer.from(hex, 'hex'));
  }
  throw new ConfigurationStoreError('read', `${column} is not a bytea value on the wire`);
}

/** Bytes to `\x68656c…`, the literal Postgres accepts for `BYTEA`. */
export function encodeBytea(bytes: Uint8Array): string {
  return `\\x${Buffer.from(bytes).toString('hex')}`;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** One PostgREST row to a typed {@link ConfigurationRow}. */
export function coerceConfigurationRow(raw: Readonly<Record<string, unknown>>): ConfigurationRow {
  return Object.freeze({
    auto_execute_threshold: asInteger(raw.auto_execute_threshold, 'auto_execute_threshold'),
    approval_window_hours: asInteger(raw.approval_window_hours, 'approval_window_hours'),
    compliance_review_threshold_paise: asPaise(
      raw.compliance_review_threshold_paise,
      'compliance_review_threshold_paise',
    ),
    tds_rates: asRateMap(raw.tds_rates, 'tds_rates'),
    valid_gst_rates: asRateSet(raw.valid_gst_rates, 'valid_gst_rates'),
    forecast_horizon_days: asInteger(raw.forecast_horizon_days, 'forecast_horizon_days'),
    safety_buffer_paise: asPaise(raw.safety_buffer_paise, 'safety_buffer_paise'),
    lookback_window_days: asInteger(raw.lookback_window_days, 'lookback_window_days'),
    minimum_sample_size: asInteger(raw.minimum_sample_size, 'minimum_sample_size'),
    maximum_retry_age_days: asInteger(raw.maximum_retry_age_days, 'maximum_retry_age_days'),
    unusual_multiple: asDecimal(raw.unusual_multiple, 'unusual_multiple'),
    model_timeout_ms: asInteger(raw.model_timeout_ms, 'model_timeout_ms'),
    model_monthly_cap_paise: asPaise(raw.model_monthly_cap_paise, 'model_monthly_cap_paise'),
    audit_retention_days: asInteger(raw.audit_retention_days, 'audit_retention_days'),
    razorpay_key_id_masked: asText(raw.razorpay_key_id_masked),
    razorpay_key_secret_encrypted: decodeBytea(
      raw.razorpay_key_secret_encrypted,
      'razorpay_key_secret_encrypted',
    ),
    provider_keys_encrypted: decodeBytea(
      raw.provider_keys_encrypted,
      'provider_keys_encrypted',
    ),
    updated_at: asText(raw.updated_at),
    updated_by: asText(raw.updated_by),
  });
}

/** A typed patch to the JSON shape PostgREST accepts. */
export function encodeConfigurationPatch(
  patch: ConfigurationRowPatch,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (typeof value === 'bigint') {
      // Digit text, so the value never passes through a float on the way out either.
      out[column] = value.toString();
    } else if (value instanceof Uint8Array) {
      out[column] = encodeBytea(value);
    } else {
      out[column] = value;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Adapters                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `tenant_configuration` over a Tenant-scoped service connection.
 *
 * `createServiceClient` is used because `readCredentialForServerUse` is a server-only
 * path with no session behind it. Its `tenantId` argument is mandatory, so an unscoped
 * privileged query cannot be written here by accident, and every statement carries an
 * explicit `tenant_id` filter as defence in depth on top of the RLS predicate.
 */
export function createSupabaseConfigurationStore(env: Env = getEnv()): ConfigurationStore {
  return {
    async read(tenantId: TenantId): Promise<ConfigurationRow | null> {
      const { client } = createServiceClient({ tenantId }, env);
      const { data, error } = await client
        .from(TABLE)
        .select('*')
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (error !== null) {
        throw new ConfigurationStoreError('read', error.message);
      }
      return data === null ? null : coerceConfigurationRow(data as Record<string, unknown>);
    },

    async write(
      tenantId: TenantId,
      patch: ConfigurationRowPatch,
      updatedBy: string | null,
    ): Promise<ConfigurationRow> {
      const { client } = createServiceClient({ tenantId }, env);
      const { data, error } = await client
        .from(TABLE)
        .upsert(
          {
            tenant_id: tenantId,
            ...encodeConfigurationPatch(patch),
            updated_at: new Date().toISOString(),
            updated_by: updatedBy,
          },
          { onConflict: 'tenant_id' },
        )
        .select('*')
        .single();
      if (error !== null) {
        throw new ConfigurationStoreError('write', error.message);
      }
      return coerceConfigurationRow(data as Record<string, unknown>);
    },
  };
}

/**
 * Audit_Event appends through `app.append_audit_event`.
 *
 * Not reachable yet — see the module doc comment, blockers 1 and 2. Left in place so
 * the call shape is written down at the point the knowledge exists, and so task 26.1
 * has one function to enable rather than a service to re-open.
 */
export function createSupabaseAuditSink(env: Env = getEnv()): ConfigurationAuditSink {
  return {
    async append(event: ConfigurationAuditEvent): Promise<void> {
      const { client }: { client: SupabaseClient } = createServiceClient(
        { tenantId: event.tenantId },
        env,
      );
      const { error } = await client.schema('app').rpc('append_audit_event', {
        p_tenant_id: event.tenantId,
        p_event_type: event.eventType,
        p_actor_kind: event.actor.kind,
        p_actor_id: event.actor.id,
        p_stage: null,
        p_outcome: 'succeeded',
        p_proposal_id: null,
        p_source_refs: [],
        p_payload: event.payload,
        p_occurred_at: event.occurredAt,
      });
      if (error !== null) {
        throw new ConfigurationStoreError('audit append', error.message);
      }
    },
  };
}
