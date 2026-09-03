/**
 * The incremental watermark against Supabase local (task 6.6, Requirement 1.9).
 *
 * Two things only a real database can settle, which is why this is here and not another
 * unit test:
 *
 * 1. **The watermark query picks the right row** out of real `ingestion_runs` rows of
 *    mixed status. `pickWatermark` states the rule in memory and
 *    `src/ingestion/ingestion-store.ts` states the same rule as a query; this suite runs
 *    the query, so the two cannot silently disagree. The `completed` run chosen is
 *    deliberately **not** the most recent run overall — a later `partially_completed` and
 *    a later `failed` run sit above it and must not advance the window.
 * 2. **`window_basis = 'incremental'` and `window_from` survive the schema.**
 *    `window_basis`'s CHECK admits exactly two values, so a run labelled `'incremental'`
 *    is only storable if the migration and the service agree on the spelling.
 *
 * The rows here are **committed**, because the story spans several sessions; `afterAll`
 * removes them. See `pg.ts` for the role note: the suite connects as `postgres`, which
 * holds `BYPASSRLS`, because the RLS policies land in task 26.1.
 *
 * Requirements: 1.8, 1.9.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createIngestionService,
  WATERMARK_STATUS,
  type IngestionStatus,
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
import {
  claims,
  database,
  jsonAt,
  lit,
  newFixture,
  provision,
  runOk,
  runScript,
  type Fixture,
} from './pg';

/** Mixed-status history. `provision` adds an `in_progress` run on top of these. */
const withHistory = newFixture();
/** A Tenant whose only prior runs are partially completed and failed. */
const noWatermark = newFixture();

const reachable = database().reachable;

const WATERMARK_ISO = '2026-01-10T09:30:00.000Z';
const NOW_ISO = '2026-02-01T00:00:00.000Z';
const WATERMARK_UNIX = Math.floor(Date.parse(WATERMARK_ISO) / 1000);

/* -------------------------------------------------------------------------- */
/* The watermark query, as SQL                                                */
/* -------------------------------------------------------------------------- */

/**
 * `IngestionStore.readWatermark` as a statement: the `started_at` of the most recent
 * {@link WATERMARK_STATUS} run for a Tenant, or nothing. The status is interpolated from
 * the exported constant so a change to the rule fails here.
 */
function readWatermarkSql(tenantId: string): string {
  return `select to_jsonb(started_at)::text from ingestion_runs
where tenant_id = ${lit(tenantId)} and status = ${lit(WATERMARK_STATUS)}::ingestion_status
order by started_at desc limit 1;`;
}

function readWatermark(f: Fixture): string | null {
  const r = runOk(`${claims(f)}\n${readWatermarkSql(f.tenantId)}`);
  return r.out.length === 0 ? null : jsonAt<string>(r, 0);
}

/** One historic run. `ended_at` is required for any terminal status by CHECK. */
function historicRun(
  tenantId: string,
  userId: string,
  status: IngestionStatus,
  startedAt: string,
): string {
  const ended = status === 'in_progress' ? 'null' : `${lit(startedAt)}::timestamptz + interval '1 minute'`;
  return `insert into ingestion_runs
  (tenant_id, started_at, ended_at, status, window_from, window_basis, initiated_by)
values (${lit(tenantId)}, ${lit(startedAt)}, ${ended}, ${lit(status)}::ingestion_status,
        ${lit(startedAt)}::timestamptz - interval '365 days', 'first_run_365d', ${lit(userId)});`;
}

/* -------------------------------------------------------------------------- */
/* A psql-backed IngestionStore, watermark read included                      */
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

const UPSERT_TAIL =
  `on conflict on constraint razorpay_objects_tenant_rzp_uniq do update set ` +
  RAZORPAY_OBJECT_UPDATE_COLUMNS.map((column) => `${column} = excluded.${column}`).join(', ');

function psqlStore(f: Fixture): IngestionStore {
  return {
    async createRun(run) {
      const id = randomUUID();
      runOk(
        `${claims(withHistory)}
insert into ingestion_runs
  (id, tenant_id, started_at, status, window_from, window_basis, initiated_by)
values (${lit(id)}, ${lit(run.tenantId)}, ${lit(run.startedAt)}, 'in_progress',
        ${lit(run.windowFrom)}, ${lit(run.windowBasis)}, ${lit(run.initiatedBy)});`,
      );
      return { id, startedAt: run.startedAt };
    },

    async readWatermark() {
      return readWatermark(f);
    },

    async upsertObjects(rows) {
      if (rows.length === 0) {
        return;
      }
      runOk(
        `${claims(withHistory)}
insert into razorpay_objects (${RAZORPAY_OBJECT_COLUMNS.join(', ')})
values ${rows.map(rowValues).join(',\n       ')}
${UPSERT_TAIL};`,
      );
    },

    async recordErrors(tid, runId, errors) {
      if (errors.length === 0) {
        return;
      }
      const values = errors
        .map(
          (e) =>
            `(${lit(tid)}, ${lit(runId)}, ${lit(e.objectType)}::razorpay_object_type, ` +
            `${lit(e.errorCode)}, ${lit(e.errorCategory)}, ${e.retryCount}, ${lit(e.requestedAt)})`,
        )
        .join(',\n       ');
      runOk(
        `${claims(withHistory)}
insert into ingestion_errors
  (tenant_id, ingestion_run_id, object_type, error_code, error_category, retry_count, requested_at)
values ${values};`,
      );
    },

    async completeRun(completion) {
      runOk(
        `${claims(withHistory)}
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
/* A transport whose linked_account page is not window-filtered               */
/* -------------------------------------------------------------------------- */

function account(id: string, createdAtUnix: number): RazorpayObject {
  return { id, entity: 'account', created_at: createdAtUnix, status: 'activated' };
}

/** `linked_account` is one of the four types the API will not filter for us. */
function client(objects: readonly RazorpayObject[]): RazorpayClient {
  return {
    fetchPages(type: IngestedObjectType) {
      const page: RazorpayFetchResult =
        type === 'linked_account'
          ? { kind: 'page', objectType: type, pageIndex: 0, objects, windowApplied: false }
          : { kind: 'page', objectType: type, pageIndex: 0, objects: [], windowApplied: true };
      return {
        async *[Symbol.asyncIterator]() {
          yield page;
        },
      };
    },
  };
}

function runRow(runId: string): {
  readonly status: string;
  readonly window_basis: string;
  readonly window_from: string;
  readonly per_type_stored: Record<string, number>;
} {
  const r = runOk(
    `${claims(withHistory)}
select to_jsonb(x)::text from (
  select status::text, window_basis, to_jsonb(window_from)#>>'{}' as window_from, per_type_stored
  from ingestion_runs where id = ${lit(runId)} and tenant_id = ${lit(withHistory.tenantId)}
) x;`,
  );
  return jsonAt(r, 0);
}

function storedIds(runId: string): readonly string[] {
  const r = runOk(
    `${claims(withHistory)}
select coalesce(to_jsonb(array_agg(razorpay_id order by razorpay_id)), '[]'::jsonb)::text
from razorpay_objects
where tenant_id = ${lit(withHistory.tenantId)} and ingestion_run_id = ${lit(runId)};`,
  );
  return jsonAt<string[]>(r, 0);
}

/* -------------------------------------------------------------------------- */
/* The story                                                                  */
/* -------------------------------------------------------------------------- */

let incrementalRunId = '';
/** Read before the incremental run completes, since a completed run moves the watermark. */
let watermarkBefore: string | null = null;

describe.skipIf(!reachable)('the incremental watermark against the real schema', () => {
  beforeAll(async () => {
    runOk(provision(withHistory));
    runOk(provision(noWatermark));

    // Mixed history. The chosen watermark is the middle row: two later runs sit above it,
    // neither of them `completed`.
    runOk(
      [
        claims(withHistory),
        historicRun(withHistory.tenantId, withHistory.userId, 'completed', '2026-01-05T00:00:00.000Z'),
        historicRun(withHistory.tenantId, withHistory.userId, 'completed', WATERMARK_ISO),
        historicRun(
          withHistory.tenantId,
          withHistory.userId,
          'partially_completed',
          '2026-01-28T00:00:00.000Z',
        ),
        historicRun(withHistory.tenantId, withHistory.userId, 'failed', '2026-01-30T00:00:00.000Z'),
      ].join('\n'),
    );

    runOk(
      [
        claims(noWatermark),
        historicRun(
          noWatermark.tenantId,
          noWatermark.userId,
          'partially_completed',
          '2026-01-20T00:00:00.000Z',
        ),
        historicRun(noWatermark.tenantId, noWatermark.userId, 'failed', '2026-01-29T00:00:00.000Z'),
      ].join('\n'),
    );

    watermarkBefore = readWatermark(withHistory);

    const run = await createIngestionService({
      store: psqlStore(withHistory),
      client: client([
        // One second before the watermark: outside an "at or after" window.
        account('acc_before_watermark', WATERMARK_UNIX - 1),
        // Exactly at the watermark: inside it.
        account('acc_at_watermark', WATERMARK_UNIX),
        account('acc_after_watermark', WATERMARK_UNIX + 3600),
      ]),
      now: () => new Date(NOW_ISO),
    }).startRun(withHistory.tenantId, withHistory.userId);
    incrementalRunId = run.id;
  });

  afterAll(() => {
    if (!reachable) {
      return;
    }
    for (const f of [withHistory, noWatermark]) {
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
    }
  });

  it('picks the most recent completed run, not the most recent run overall', () => {
    expect(watermarkBefore).not.toBeNull();
    expect(Date.parse(watermarkBefore as string)).toBe(Date.parse(WATERMARK_ISO));
  });

  it('finds no watermark when every prior run is partially completed or failed', () => {
    // Neither status advances the window: the partial run missed object types, and the
    // failed one stored nothing.
    expect(readWatermark(noWatermark)).toBeNull();
  });

  it('stores the run as incremental with window_from at the watermark', () => {
    const row = runRow(incrementalRunId);
    expect(row.window_basis).toBe('incremental');
    expect(Date.parse(row.window_from)).toBe(Date.parse(WATERMARK_ISO));
  });

  it('retrieves an object created at exactly the watermark and drops the earlier one', () => {
    expect(storedIds(incrementalRunId)).toEqual(['acc_after_watermark', 'acc_at_watermark']);
  });

  it('advances the watermark only once the run reaches completed', () => {
    // The run resumed from the earlier watermark (asserted above) because the read happens
    // before its own row exists. Now that it is `completed`, it becomes the watermark.
    const row = runRow(incrementalRunId);
    expect(row.status).toBe('completed');
    const at = readWatermark(withHistory);
    expect(Date.parse(at as string)).toBe(Date.parse(NOW_ISO));
  });
});
