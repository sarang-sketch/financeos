/**
 * The Supabase-backed adapter behind {@link IngestionStore}, plus the Realtime publisher.
 *
 * This file is the only place that knows how `ingestion_runs`, `ingestion_errors` and
 * `razorpay_objects` look on the wire. Two rules it exists to keep:
 *
 * 1. **Money never passes through a float.** A `Paise` goes out as digit text, so
 *    `amount_paise`, `fee_paise` and `gst_on_fee_paise` reach `paise_ingested` exactly as
 *    they were read, with no rounding, truncation or unit scaling (Requirement 1.7).
 * 2. **The payload goes out untouched.** `payload` is handed to the client as the object
 *    the transport parsed. Nothing here reorders keys, strips fields or normalises
 *    (Requirement 1.2). Postgres stores `JSONB` in its own canonical form — that is the
 *    storage engine's representation, not a modification this code makes.
 *
 * ## Two things this adapter cannot verify, recorded rather than worked around
 *
 * - `ingestion_runs`, `ingestion_errors` and `razorpay_objects` are all
 *   `ENABLE`d and `FORCE`d for row-level security with **no policies until task 26.1**, so
 *   they match zero rows for every role without `BYPASSRLS`. The PostgREST path below is
 *   therefore written against the schema but not exercised against a live database here;
 *   `test/db/ingestion-run.test.ts` drives the same {@link IngestionStore} interface over
 *   raw SQL, which is what makes the state guarantees of Requirement 1.3 and 1.10
 *   genuinely tested today, and `test/db/ingestion-watermark.test.ts` does the same for
 *   the watermark query of Requirement 1.9. Wire the PostgREST path up in 26.1.
 * - **No table in any migration joins the `supabase_realtime` publication.** So a
 *   `postgres_changes` subscription on `ingestion_runs` would deliver nothing, and
 *   {@link createSupabaseRunPublisher} sends an explicit broadcast instead. Adding
 *   `ingestion_runs` to the publication is a migration; note it for 26.1, where the RLS
 *   policies that make a Realtime subscription safe also land.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { TenantId } from '@/config/configuration-service';
import { type Env, getEnv, redactSecrets } from '@/config/env';
import { createServiceClient } from '@/db/clients';
import { WATERMARK_STATUS } from '@/ingestion/ingestion-service';
import type {
  IngestionError,
  IngestionRunEvent,
  IngestionRunPublisher,
  IngestionStore,
  NewRun,
  RazorpayObjectRow,
  RunCompletion,
} from '@/ingestion/ingestion-service';

const RUNS_TABLE = 'ingestion_runs';
const ERRORS_TABLE = 'ingestion_errors';
const OBJECTS_TABLE = 'razorpay_objects';

/**
 * The columns an upsert of `razorpay_objects` writes, in one place so the PostgREST path
 * and the raw-SQL path used by the db suite cannot drift.
 */
export const RAZORPAY_OBJECT_COLUMNS = [
  'tenant_id',
  'razorpay_id',
  'object_type',
  'ingestion_run_id',
  'retrieved_at',
  'created_at_rzp',
  'amount_paise',
  'fee_paise',
  'gst_on_fee_paise',
  'currency',
  'status_rzp',
  'payload',
] as const;

/**
 * The conflict target of the re-ingestion upsert: `razorpay_objects_tenant_rzp_uniq` on
 * `(tenant_id, razorpay_id)`, one row per Razorpay object identifier per Tenant
 * (Requirement 1.3, property P10 — task 6.3).
 */
export const RAZORPAY_OBJECT_CONFLICT_TARGET = 'tenant_id,razorpay_id';

/**
 * The `DO UPDATE SET` list.
 *
 * Requirement 1.3 names three: the payload is replaced, the retrieval timestamp is
 * refreshed, and the run identifier moves to the run that re-retrieved the object. The
 * projections are refreshed with them because they are derived from the payload — leaving
 * `amount_paise` behind while replacing the payload it came from would put the row into a
 * state where its own two halves disagree.
 */
export const RAZORPAY_OBJECT_UPDATE_COLUMNS = [
  'payload',
  'retrieved_at',
  'ingestion_run_id',
  'created_at_rzp',
  'amount_paise',
  'fee_paise',
  'gst_on_fee_paise',
  'currency',
  'status_rzp',
] as const;

/**
 * How many rows one upsert statement carries.
 *
 * The run commits in one call, but a first run over 365 days can be tens of thousands of
 * rows and one request has to stay within PostgREST's limits, so the adapter chunks.
 * Chunking is safe for Requirement 1.10 because the abort path issues **no** statement at
 * all — the guarantee comes from never writing, not from a rollback (see
 * `./ingestion-service`). A storage failure part-way through a commit is an
 * infrastructure fault and is surfaced, not swallowed.
 */
export const UPSERT_CHUNK_ROWS = 500;

/** Thrown when the database refuses an ingestion read or write. Scrubbed of credentials. */
export class IngestionStoreError extends Error {
  override readonly name = 'IngestionStoreError';

  constructor(operation: string, detail: string) {
    super(redactSecrets(`ingestion ${operation} failed: ${detail}`));
  }
}

/** A `Paise` to digit text, so it never passes through a float on the way out. */
function encodePaise(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

/** One row to the JSON shape PostgREST accepts. */
export function encodeRazorpayObjectRow(row: RazorpayObjectRow): Record<string, unknown> {
  return {
    tenant_id: row.tenant_id,
    razorpay_id: row.razorpay_id,
    object_type: row.object_type,
    ingestion_run_id: row.ingestion_run_id,
    retrieved_at: row.retrieved_at,
    created_at_rzp: row.created_at_rzp,
    amount_paise: encodePaise(row.amount_paise),
    fee_paise: encodePaise(row.fee_paise),
    gst_on_fee_paise: encodePaise(row.gst_on_fee_paise),
    currency: row.currency,
    status_rzp: row.status_rzp,
    // By reference: exactly what Razorpay returned (Requirement 1.2).
    payload: row.payload,
  };
}

function encodeError(
  tenantId: TenantId,
  runId: string,
  error: IngestionError,
): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    ingestion_run_id: runId,
    object_type: error.objectType,
    error_code: error.errorCode,
    error_category: error.errorCategory,
    retry_count: error.retryCount,
    requested_at: error.requestedAt,
  };
}

/** `ingestion_runs`, `ingestion_errors` and `razorpay_objects` over PostgREST. */
export function createSupabaseIngestionStore(env: Env = getEnv()): IngestionStore {
  const clientFor = (tenantId: TenantId): SupabaseClient =>
    createServiceClient({ tenantId }, env).client;

  return {
    async createRun(run: NewRun) {
      const { data, error } = await clientFor(run.tenantId)
        .from(RUNS_TABLE)
        .insert({
          tenant_id: run.tenantId,
          started_at: run.startedAt,
          status: 'in_progress',
          window_from: run.windowFrom,
          window_basis: run.windowBasis,
          initiated_by: run.initiatedBy,
        })
        .select('id, started_at')
        .single();
      if (error !== null) {
        throw new IngestionStoreError('run creation', error.message);
      }
      const row = data as { id: string; started_at: string };
      return { id: row.id, startedAt: row.started_at };
    },

    async readWatermark(tenantId: TenantId) {
      const { data, error } = await clientFor(tenantId)
        .from(RUNS_TABLE)
        .select('started_at')
        .eq('tenant_id', tenantId)
        .eq('status', WATERMARK_STATUS)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error !== null) {
        throw new IngestionStoreError('watermark read', error.message);
      }
      return data === null ? null : (data as { started_at: string }).started_at;
    },

    async upsertObjects(rows: readonly RazorpayObjectRow[]) {
      if (rows.length === 0) {
        return;
      }
      const tenantId = rows[0]?.tenant_id ?? '';
      const client = clientFor(tenantId);
      for (let at = 0; at < rows.length; at += UPSERT_CHUNK_ROWS) {
        const chunk = rows.slice(at, at + UPSERT_CHUNK_ROWS).map(encodeRazorpayObjectRow);
        const { error } = await client
          .from(OBJECTS_TABLE)
          .upsert(chunk, { onConflict: RAZORPAY_OBJECT_CONFLICT_TARGET });
        if (error !== null) {
          throw new IngestionStoreError('object upsert', error.message);
        }
      }
    },

    async recordErrors(tenantId: TenantId, runId: string, errors: readonly IngestionError[]) {
      if (errors.length === 0) {
        return;
      }
      const { error } = await clientFor(tenantId)
        .from(ERRORS_TABLE)
        .insert(errors.map((e) => encodeError(tenantId, runId, e)));
      if (error !== null) {
        throw new IngestionStoreError('error recording', error.message);
      }
    },

    async completeRun(completion: RunCompletion) {
      const { error } = await clientFor(completion.tenantId)
        .from(RUNS_TABLE)
        .update({
          ended_at: completion.endedAt,
          status: completion.status,
          failure_kind: completion.failureKind,
          per_type_stored: completion.perTypeStored,
          // Scalar column; the per-object-type breakdown is recoverable from
          // `ingestion_errors`. See RunCompletion.totalErrors.
          per_type_errors: completion.totalErrors,
        })
        .eq('id', completion.runId)
        .eq('tenant_id', completion.tenantId);
      if (error !== null) {
        throw new IngestionStoreError('run completion', error.message);
      }
    },
  };
}

/** The Realtime channel the Control_Tower subscribes to for a Tenant's runs. */
export function ingestionRunChannel(tenantId: TenantId): string {
  return `ingestion_runs:${tenantId}`;
}

/**
 * Publish run state changes as a Realtime broadcast.
 *
 * A broadcast rather than `postgres_changes` because no migration adds `ingestion_runs`
 * to the `supabase_realtime` publication, so replication would deliver nothing — see the
 * module doc comment. The payload carries the run summary only: no payload, no credential,
 * nothing a subscriber is not already entitled to read from `ingestion_runs`.
 */
export function createSupabaseRunPublisher(env: Env = getEnv()): IngestionRunPublisher {
  return {
    async publish(event: IngestionRunEvent): Promise<void> {
      const { client } = createServiceClient({ tenantId: event.run.tenant_id }, env);
      const channel = client.channel(ingestionRunChannel(event.run.tenant_id));
      await channel.send({
        type: 'broadcast',
        event: event.change,
        payload: {
          run_id: event.run.id,
          tenant_id: event.run.tenant_id,
          status: event.run.status,
          failure_kind: event.run.failure_kind,
          object_type: event.objectType,
          per_type_stored: event.run.per_type_stored,
          at: event.at,
        },
      });
    },
  };
}
