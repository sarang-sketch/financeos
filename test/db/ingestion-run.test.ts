/**
 * The ingestion run against Supabase local (task 6.2).
 *
 * These assertions are the reason this suite exists rather than another unit test with a
 * fake store: the two guarantees under test are *state* guarantees, and only a real
 * database can say whether a row is byte-identical afterwards.
 *
 * 1. **Requirement 1.10.** A run aborted by a credential rejection stores **zero**
 *    Razorpay objects and leaves every previously stored object byte-identical. The
 *    fingerprint compared is `md5(razorpay_objects::text)` of the whole row, so a change
 *    to `payload`, to `retrieved_at`, or to any projection would fail it.
 * 2. **Requirement 1.3.** Re-retrieving an object replaces its payload, refreshes its
 *    retrieval timestamp, moves its run identifier, and keeps exactly one row per
 *    identifier per Tenant. Property P10 generalises this and is task 6.3's; what is here
 *    is the worked example, against the real `razorpay_objects_tenant_rzp_uniq`.
 *
 * The {@link IngestionStore} below is the same interface the PostgREST adapter implements,
 * driven over `psql` instead — the PostgREST path cannot be exercised until task 26.1 adds
 * the RLS policies, and the insert statement is composed from the column lists exported by
 * `src/ingestion/ingestion-store.ts` so the two paths cannot drift apart.
 *
 * Unlike the rest of this suite these rows are **committed**, because the guarantee under
 * test spans three separate runs and therefore three sessions. `afterAll` removes them.
 *
 * Requirements: 1.2, 1.3, 1.6, 1.7, 1.10.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createIngestionService,
  type IngestionStore,
  type RazorpayObjectRow,
} from '@/ingestion/ingestion-service';
import {
  RAZORPAY_OBJECT_COLUMNS,
  RAZORPAY_OBJECT_UPDATE_COLUMNS,
} from '@/ingestion/ingestion-store';
import type {
  IngestedObjectType,
  RazorpayClient,
  RazorpayFetchResult,
  RazorpayObject,
} from '@/ingestion/razorpay-client';
import { claims, database, jsonAt, lit, newFixture, provision, runOk, runScript } from './pg';

const f = newFixture();
const reachable = database().reachable;

/* -------------------------------------------------------------------------- */
/* A psql-backed IngestionStore                                               */
/* -------------------------------------------------------------------------- */

function paise(value: bigint | null): string {
  return value === null ? 'null' : value.toString();
}

function text(value: string | null): string {
  return value === null ? 'null' : lit(value);
}

function rowValues(row: RazorpayObjectRow): string {
  return (
    `(${lit(row.tenant_id)}, ${lit(row.razorpay_id)}, ` +
    `${lit(row.object_type)}::razorpay_object_type, ${lit(row.ingestion_run_id)}, ` +
    `${lit(row.retrieved_at)}, ${lit(row.created_at_rzp)}, ${paise(row.amount_paise)}, ` +
    `${paise(row.fee_paise)}, ${paise(row.gst_on_fee_paise)}, ${lit(row.currency)}, ` +
    `${text(row.status_rzp)}, ${lit(JSON.stringify(row.payload))}::jsonb)`
  );
}

/**
 * The re-ingestion upsert, targeting `razorpay_objects_tenant_rzp_uniq` by name so a
 * rename fails here rather than silently inserting duplicates (Requirement 1.3).
 */
const UPSERT_TAIL =
  `on conflict on constraint razorpay_objects_tenant_rzp_uniq do update set ` +
  RAZORPAY_OBJECT_UPDATE_COLUMNS.map((column) => `${column} = excluded.${column}`).join(', ');

function psqlStore(): IngestionStore {
  return {
    async createRun(run) {
      const id = randomUUID();
      runOk(
        `${claims(f)}
insert into ingestion_runs
  (id, tenant_id, started_at, status, window_from, window_basis, initiated_by)
values (${lit(id)}, ${lit(run.tenantId)}, ${lit(run.startedAt)}, 'in_progress',
        ${lit(run.windowFrom)}, ${lit(run.windowBasis)}, ${lit(run.initiatedBy)});`,
      );
      return { id, startedAt: run.startedAt };
    },

    async upsertObjects(rows) {
      if (rows.length === 0) {
        return;
      }
      runOk(
        `${claims(f)}
insert into razorpay_objects (${RAZORPAY_OBJECT_COLUMNS.join(', ')})
values ${rows.map(rowValues).join(',\n       ')}
${UPSERT_TAIL};`,
      );
    },

    async recordErrors(tenantId, runId, errors) {
      if (errors.length === 0) {
        return;
      }
      const values = errors
        .map(
          (e) =>
            `(${lit(tenantId)}, ${lit(runId)}, ${lit(e.objectType)}::razorpay_object_type, ` +
            `${lit(e.errorCode)}, ${lit(e.errorCategory)}, ${e.retryCount}, ${lit(e.requestedAt)})`,
        )
        .join(',\n       ');
      runOk(
        `${claims(f)}
insert into ingestion_errors
  (tenant_id, ingestion_run_id, object_type, error_code, error_category, retry_count, requested_at)
values ${values};`,
      );
    },

    async completeRun(completion) {
      runOk(
        `${claims(f)}
update ingestion_runs set
  ended_at = ${lit(completion.endedAt)},
  status = ${lit(completion.status)}::ingestion_status,
  failure_kind = ${text(completion.failureKind)},
  per_type_stored = ${lit(JSON.stringify(completion.perTypeStored))}::jsonb,
  per_type_errors = ${completion.totalErrors}
where id = ${lit(completion.runId)} and tenant_id = ${lit(completion.tenantId)};`,
      );
    },
  };
}

/* -------------------------------------------------------------------------- */
/* A scripted transport                                                       */
/* -------------------------------------------------------------------------- */

type Plan = Partial<Record<IngestedObjectType, () => RazorpayFetchResult[]>>;

function client(plan: Plan): RazorpayClient {
  return {
    fetchPages(type) {
      const results = plan[type]?.() ?? [
        { kind: 'page', objectType: type, pageIndex: 0, objects: [], windowApplied: true },
      ];
      return {
        async *[Symbol.asyncIterator]() {
          yield* results;
        },
      };
    },
  };
}

function paymentPage(objects: readonly RazorpayObject[]): RazorpayFetchResult {
  return {
    kind: 'page',
    objectType: 'payment',
    pageIndex: 0,
    objects,
    windowApplied: true,
  };
}

function rejection(): RazorpayFetchResult {
  return {
    kind: 'credential_rejected',
    failure: {
      objectType: 'payment',
      category: 'credential_rejected',
      errorCode: 'BAD_REQUEST_ERROR',
      httpStatus: 401,
      retryCount: 0,
      requestedAt: '2026-02-02T00:00:00.000Z',
      detail: 'authentication failed',
      abortsRun: true,
    },
  };
}

function serviceAt(at: string, plan: Plan) {
  return createIngestionService({
    store: psqlStore(),
    client: client(plan),
    now: () => new Date(at),
  });
}

const CREATED_AT = Math.floor(Date.parse('2025-12-01T00:00:00.000Z') / 1000);

const FIRST_PAYLOAD: RazorpayObject = {
  id: 'pay_db_probe',
  entity: 'payment',
  created_at: CREATED_AT,
  amount: 150_000,
  fee: 3_540,
  tax: 540,
  currency: 'INR',
  status: 'captured',
  notes: { invoice: 'INV-1' },
};

/** Fingerprint of the whole stored row, so any change to any column shows up. */
function rowFingerprint(razorpayId: string): {
  readonly md5: string;
  readonly payload: string;
  readonly retrieved_at: string;
  readonly ingestion_run_id: string;
  readonly amount_paise: string;
} {
  const r = runOk(
    `${claims(f)}
select to_jsonb(x)::text from (
  select md5(o::text) as md5, o.payload::text as payload, o.retrieved_at::text as retrieved_at,
         o.ingestion_run_id::text as ingestion_run_id, o.amount_paise::text as amount_paise
  from razorpay_objects o
  where o.tenant_id = ${lit(f.tenantId)} and o.razorpay_id = ${lit(razorpayId)}
) x;`,
  );
  return jsonAt(r, 0);
}

function countForRun(runId: string): number {
  const r = runOk(
    `${claims(f)}
select to_jsonb(count(*))::text from razorpay_objects
where tenant_id = ${lit(f.tenantId)} and ingestion_run_id = ${lit(runId)};`,
  );
  return jsonAt<number>(r, 0);
}

function runRow(runId: string): {
  readonly status: string;
  readonly failure_kind: string | null;
  readonly ended_at: string | null;
  readonly per_type_stored: Record<string, number>;
  readonly per_type_errors: number;
  readonly window_basis: string;
} {
  const r = runOk(
    `${claims(f)}
select to_jsonb(x)::text from (
  select status::text, failure_kind, ended_at::text, per_type_stored, per_type_errors,
         window_basis
  from ingestion_runs where id = ${lit(runId)} and tenant_id = ${lit(f.tenantId)}
) x;`,
  );
  return jsonAt(r, 0);
}

/* -------------------------------------------------------------------------- */
/* The story                                                                  */
/* -------------------------------------------------------------------------- */

let firstRunId = '';
let abortedRunId = '';
let fingerprintBefore = '';

describe.skipIf(!reachable)('the ingestion run against the real schema', () => {
  beforeAll(async () => {
    runOk(provision(f));

    // Run 1: one payment stored.
    const first = await serviceAt('2026-02-01T00:00:00.000Z', {
      payment: () => [paymentPage([FIRST_PAYLOAD])],
    }).startRun(f.tenantId, f.userId);
    firstRunId = first.id;
    fingerprintBefore = rowFingerprint('pay_db_probe').md5;

    // Run 2: the credential is rejected on the first object type.
    const aborted = await serviceAt('2026-02-02T00:00:00.000Z', {
      payment: () => [rejection()],
    }).startRun(f.tenantId, f.userId);
    abortedRunId = aborted.id;
  });

  afterAll(() => {
    if (!reachable) {
      return;
    }
    // Committed rows, so they are removed explicitly. FK order.
    runScript(
      `${claims(f)}
delete from razorpay_objects where tenant_id = ${lit(f.tenantId)};
delete from ingestion_errors where tenant_id = ${lit(f.tenantId)};
delete from ingestion_runs where tenant_id = ${lit(f.tenantId)};
delete from chart_of_accounts where tenant_id = ${lit(f.tenantId)};
delete from audit_sequence_counters where tenant_id = ${lit(f.tenantId)};
delete from tenants where id = ${lit(f.tenantId)};
delete from users where id = ${lit(f.userId)};`,
    );
  });

  it('stores the payload verbatim with money as integer paise and currency INR', () => {
    const stored = rowFingerprint('pay_db_probe');
    expect(JSON.parse(stored.payload)).toEqual(FIRST_PAYLOAD);
    expect(stored.amount_paise).toBe('150000');
    expect(stored.retrieved_at).toContain('2026-02-01');
    expect(stored.ingestion_run_id).toBe(firstRunId);

    const run = runRow(firstRunId);
    expect(run.status).toBe('completed');
    expect(run.failure_kind).toBeNull();
    expect(run.ended_at).not.toBeNull();
    expect(run.per_type_stored.payment).toBe(1);
    expect(run.window_basis).toBe('first_run_365d');
  });

  it('stores zero objects for the aborted run', () => {
    expect(countForRun(abortedRunId)).toBe(0);
  });

  it('leaves the previously stored object byte-identical', () => {
    const after = rowFingerprint('pay_db_probe');
    expect(after.md5).toBe(fingerprintBefore);
    expect(after.ingestion_run_id).toBe(firstRunId);
    expect(after.retrieved_at).toContain('2026-02-01');
  });

  it('marks the aborted run failed with the credential cause and an end timestamp', () => {
    const run = runRow(abortedRunId);
    expect(run.status).toBe('failed');
    expect(run.failure_kind).toBe('credential_rejected');
    // The (status = 'in_progress') = (ended_at IS NULL) biconditional.
    expect(run.ended_at).not.toBeNull();
    expect(run.per_type_stored.payment).toBe(0);
    expect(run.per_type_errors).toBe(1);

    const errors = runOk(
      `${claims(f)}
select to_jsonb(x)::text from (
  select error_category, error_code, object_type::text, retry_count
  from ingestion_errors
  where tenant_id = ${lit(f.tenantId)} and ingestion_run_id = ${lit(abortedRunId)}
) x;`,
    );
    expect(jsonAt(errors, 0)).toEqual({
      error_category: 'credential_rejected',
      error_code: 'BAD_REQUEST_ERROR',
      object_type: 'payment',
      retry_count: 0,
    });
  });

  it('replaces payload, retrieved_at and run id on re-ingestion, keeping one row', async () => {
    const changed: RazorpayObject = { ...FIRST_PAYLOAD, amount: 175_000, status: 'refunded' };
    const third = await serviceAt('2026-02-03T00:00:00.000Z', {
      payment: () => [paymentPage([changed])],
    }).startRun(f.tenantId, f.userId);

    const after = rowFingerprint('pay_db_probe');
    expect(JSON.parse(after.payload)).toEqual(changed);
    expect(after.amount_paise).toBe('175000');
    expect(after.retrieved_at).toContain('2026-02-03');
    expect(after.ingestion_run_id).toBe(third.id);

    const total = runOk(
      `${claims(f)}
select to_jsonb(count(*))::text from razorpay_objects
where tenant_id = ${lit(f.tenantId)} and razorpay_id = 'pay_db_probe';`,
    );
    expect(jsonAt<number>(total, 0)).toBe(1);
  });
});
