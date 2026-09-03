import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createIngestionService,
  deriveRunOutcome,
  extractRazorpayId,
  IDENTIFIER_COLLISION_ERROR_CODE,
  INGESTION_STATUSES,
  monthsInWindow,
  ObjectProjectionError,
  resolveWindow,
  toIngestedPaise,
  type IngestionError,
  type IngestionFailureKind,
  type IngestionRunEvent,
  type IngestionStatus,
  type IngestionStore,
  type NewRun,
  type RazorpayObjectRow,
  type RunCompletion,
} from '@/ingestion/ingestion-service';
import {
  INGESTED_OBJECT_TYPES,
  RAZORPAY_ENDPOINTS,
  type FetchOptions,
  type IngestedObjectType,
  type RazorpayClient,
  type RazorpayFetchResult,
  type RazorpayObject,
  type TimeWindow,
} from '@/ingestion/razorpay-client';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-02-01T00:00:00.000Z');

/** Unix seconds, the form Razorpay states `created_at` in. */
function epoch(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

const IN_WINDOW = epoch('2025-06-01T00:00:00.000Z');
const BEFORE_WINDOW = epoch('2020-01-01T00:00:00.000Z');

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

interface FakeStore extends IngestionStore {
  /** Keyed `tenant|razorpay_id`, so it behaves like the unique constraint. */
  readonly rows: Map<string, RazorpayObjectRow>;
  readonly created: NewRun[];
  readonly completions: RunCompletion[];
  readonly recorded: IngestionError[];
  /** How many times a write against `razorpay_objects` was issued. */
  readonly upsertCalls: { count: number };
}

function fakeStore(): FakeStore {
  const rows = new Map<string, RazorpayObjectRow>();
  const created: NewRun[] = [];
  const completions: RunCompletion[] = [];
  const recorded: IngestionError[] = [];
  const upsertCalls = { count: 0 };

  return {
    rows,
    created,
    completions,
    recorded,
    upsertCalls,
    async createRun(run) {
      created.push(run);
      return { id: RUN_ID, startedAt: run.startedAt };
    },
    async upsertObjects(batch) {
      upsertCalls.count += 1;
      for (const row of batch) {
        rows.set(`${row.tenant_id}|${row.razorpay_id}`, row);
      }
    },
    async recordErrors(_tenantId, _runId, errors) {
      recorded.push(...errors);
    },
    async completeRun(completion) {
      completions.push(completion);
    },
  };
}

type Plan = Partial<Record<IngestedObjectType, (options: FetchOptions) => RazorpayFetchResult[]>>;

interface FakeClient {
  readonly client: RazorpayClient;
  readonly requests: Array<{ type: IngestedObjectType; options: FetchOptions }>;
}

function fakeClient(plan: Plan): FakeClient {
  const requests: Array<{ type: IngestedObjectType; options: FetchOptions }> = [];
  const client: RazorpayClient = {
    fetchPages(type, _window, options = {}) {
      requests.push({ type, options });
      const results = plan[type]?.(options) ?? [page(type, [])];
      return {
        async *[Symbol.asyncIterator]() {
          yield* results;
        },
      };
    },
  };
  return { client, requests };
}

/** A page in the shape the transport yields, with the endpoint's real window flag. */
function page(
  type: IngestedObjectType,
  objects: readonly RazorpayObject[],
  pageIndex = 0,
): RazorpayFetchResult {
  return {
    kind: 'page',
    objectType: type,
    pageIndex,
    objects,
    windowApplied: RAZORPAY_ENDPOINTS[type].supportsTimeWindow,
  };
}

function providerFailure(type: IngestedObjectType): RazorpayFetchResult {
  return {
    kind: 'object_type_failed',
    failure: {
      objectType: type,
      category: 'provider_error',
      errorCode: 'SERVER_ERROR',
      httpStatus: 500,
      retryCount: 0,
      requestedAt: NOW.toISOString(),
      detail: 'nope',
    },
  };
}

function credentialRejection(type: IngestedObjectType): RazorpayFetchResult {
  return {
    kind: 'credential_rejected',
    failure: {
      objectType: type,
      category: 'credential_rejected',
      errorCode: 'BAD_REQUEST_ERROR',
      httpStatus: 401,
      retryCount: 0,
      requestedAt: NOW.toISOString(),
      detail: 'authentication failed',
      abortsRun: true,
    },
  };
}

interface Harness {
  readonly store: FakeStore;
  readonly requests: Array<{ type: IngestedObjectType; options: FetchOptions }>;
  readonly events: IngestionRunEvent[];
  readonly service: ReturnType<typeof createIngestionService>;
}

function harness(plan: Plan): Harness {
  const store = fakeStore();
  const { client, requests } = fakeClient(plan);
  const events: IngestionRunEvent[] = [];
  const service = createIngestionService({
    store,
    client,
    publisher: {
      async publish(event) {
        events.push(event);
      },
    },
    now: () => NOW,
  });
  return { store, requests, events, service };
}

/** One object of every type, so a run stores exactly nine rows. */
function oneOfEveryType(): Plan {
  const plan: Plan = {};
  for (const type of INGESTED_OBJECT_TYPES) {
    const idField = type === 'settlement_recon_report' ? 'entity_id' : 'id';
    plan[type] = (options) => {
      // The recon report is walked per month and reversals per transfer, so each request
      // must return a distinct object or the batch would collide on one identifier.
      const suffix =
        options.query === undefined
          ? (options.parentId ?? 'only')
          : `${options.query.year}-${options.query.month}`;
      return [
        page(type, [
          { [idField]: `${type}_${suffix}`, created_at: IN_WINDOW, amount: 12_345 },
        ]),
      ];
    };
  }
  return plan;
}

/* -------------------------------------------------------------------------- */
/* Window and month walk                                                      */
/* -------------------------------------------------------------------------- */

describe('resolveWindow', () => {
  it('is the 365 days preceding the run start, basis first_run_365d', () => {
    const { window, basis } = resolveWindow(NOW);
    expect(basis).toBe('first_run_365d');
    expect(window.to.toISOString()).toBe(NOW.toISOString());
    expect(window.from.toISOString()).toBe('2025-02-01T00:00:00.000Z');
  });
});

describe('monthsInWindow', () => {
  it('covers both endpoint months, so a 365-day window is 13 months', () => {
    const months = monthsInWindow(resolveWindow(NOW).window);
    expect(months).toHaveLength(13);
    expect(months[0]).toEqual({ year: '2025', month: '2' });
    expect(months.at(-1)).toEqual({ year: '2026', month: '2' });
  });

  it('is empty for an inverted window rather than looping', () => {
    const inverted: TimeWindow = { from: NOW, to: new Date('2025-01-01T00:00:00.000Z') };
    expect(monthsInWindow(inverted)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Money                                                                      */
/* -------------------------------------------------------------------------- */

describe('toIngestedPaise', () => {
  it('accepts the range boundaries as bigint', () => {
    expect(toIngestedPaise(0, 'amount')).toBe(0n);
    expect(toIngestedPaise(999_999_999_999, 'amount')).toBe(999_999_999_999n);
    expect(toIngestedPaise('250', 'amount')).toBe(250n);
  });

  it('raises rather than clamping a value above the ingested ceiling', () => {
    const thrown = (): unknown => toIngestedPaise(1_000_000_000_000, 'amount');
    expect(thrown).toThrowError(ObjectProjectionError);
    expect(thrown).toThrowError(/MONETARY_VALUE_OUT_OF_RANGE/);
  });

  it('raises rather than rounding a non-integer', () => {
    expect(() => toIngestedPaise(100.5, 'amount')).toThrowError(
      /NON_INTEGER_MONETARY_VALUE/,
    );
  });

  it('rejects a JSON number that has already lost precision', () => {
    expect(() => toIngestedPaise(Number.MAX_SAFE_INTEGER + 2, 'amount')).toThrowError(
      /NON_INTEGER_MONETARY_VALUE/,
    );
  });

  it('rejects a negative value and a non-numeric one', () => {
    expect(() => toIngestedPaise(-1, 'amount')).toThrowError(/OUT_OF_RANGE/);
    expect(() => toIngestedPaise('₹12.34', 'amount')).toThrowError(
      /NON_INTEGER_MONETARY_VALUE/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Identifier extraction                                                      */
/* -------------------------------------------------------------------------- */

describe('extractRazorpayId', () => {
  it('reads id for a payment and entity_id for a combined recon report row', () => {
    expect(extractRazorpayId('payment', { id: 'pay_1', entity_id: 'nope' })).toBe('pay_1');
    expect(
      extractRazorpayId('settlement_recon_report', { entity_id: 'pay_1', settlement_id: 's_1' }),
    ).toBe('pay_1');
  });

  it('raises rather than generating one when the field is absent', () => {
    expect(() => extractRazorpayId('payment', { amount: 1 })).toThrowError(
      /MISSING_IDENTIFIER/,
    );
    expect(() => extractRazorpayId('settlement_recon_report', { id: 'pay_1' })).toThrowError(
      /MISSING_IDENTIFIER/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

describe('startRun', () => {
  it('stores the identifier, type, tenant, run, retrieval timestamp and unmodified payload', async () => {
    const payload: RazorpayObject = {
      id: 'pay_1',
      created_at: IN_WINDOW,
      amount: 150_000,
      fee: 3_540,
      tax: 540,
      currency: 'INR',
      status: 'captured',
      notes: { invoice: 'INV-1' },
    };
    const h = harness({ payment: () => [page('payment', [payload])] });
    await h.service.startRun(TENANT, ACTOR);

    const row = h.store.rows.get(`${TENANT}|pay_1`);
    expect(row).toBeDefined();
    expect(row?.object_type).toBe('payment');
    expect(row?.tenant_id).toBe(TENANT);
    expect(row?.ingestion_run_id).toBe(RUN_ID);
    expect(row?.retrieved_at).toBe(NOW.toISOString());
    expect(row?.created_at_rzp).toBe('2025-06-01T00:00:00.000Z');
    expect(row?.amount_paise).toBe(150_000n);
    expect(row?.fee_paise).toBe(3_540n);
    expect(row?.gst_on_fee_paise).toBe(540n);
    expect(row?.currency).toBe('INR');
    expect(row?.status_rzp).toBe('captured');
    // The same object, not a copy and not a mapping (Requirement 1.2).
    expect(row?.payload).toBe(payload);
  });

  it('retrieves all nine object types and reports per-type counts and the window', async () => {
    const h = harness(oneOfEveryType());
    const run = await h.service.startRun(TENANT, ACTOR);

    expect(new Set(h.requests.map((r) => r.type))).toEqual(new Set(INGESTED_OBJECT_TYPES));
    for (const type of INGESTED_OBJECT_TYPES) {
      expect(run.per_type_stored[type], type).toBeGreaterThanOrEqual(1);
    }
    expect(run.status).toBe('completed');
    expect(run.failure_kind).toBeNull();
    expect(run.ended_at).toBe(NOW.toISOString());
    expect(h.store.created[0]?.windowBasis).toBe('first_run_365d');
    expect(h.store.created[0]?.windowFrom).toBe('2025-02-01T00:00:00.000Z');
    expect(h.store.completions[0]?.status).toBe('completed');
    expect(h.store.completions[0]?.totalErrors).toBe(0);
  });

  it('walks the recon report per month and reversals per transfer', async () => {
    const plan = oneOfEveryType();
    plan.transfer = () => [
      page('transfer', [
        { id: 'trf_1', created_at: IN_WINDOW, amount: 1 },
        { id: 'trf_2', created_at: IN_WINDOW, amount: 1 },
      ]),
    ];
    const h = harness(plan);
    const run = await h.service.startRun(TENANT, ACTOR);

    const recon = h.requests.filter((r) => r.type === 'settlement_recon_report');
    expect(recon).toHaveLength(13);
    expect(recon[0]?.options.query).toEqual({ year: '2025', month: '2' });

    const reversals = h.requests.filter((r) => r.type === 'transfer_reversal');
    expect(reversals.map((r) => r.options.parentId)).toEqual(['trf_1', 'trf_2']);
    expect(run.per_type_stored.settlement_recon_report).toBe(13);
    expect(run.per_type_stored.transfer_reversal).toBe(2);
  });

  it('applies the window itself for the four types the API will not filter', async () => {
    const h = harness({
      transfer: () => [
        page('transfer', [
          { id: 'trf_in', created_at: IN_WINDOW, amount: 1 },
          { id: 'trf_old', created_at: BEFORE_WINDOW, amount: 1 },
        ]),
      ],
    });
    const run = await h.service.startRun(TENANT, ACTOR);

    expect(h.store.rows.has(`${TENANT}|trf_in`)).toBe(true);
    expect(h.store.rows.has(`${TENANT}|trf_old`)).toBe(false);
    expect(run.per_type_stored.transfer).toBe(1);
    expect(run.per_type_window_filtered.transfer).toBe(1);
    // A filtered record is not an error: nothing failed, it is outside the window.
    expect(run.per_type_errors.transfer).toEqual([]);
    // The out-of-window transfer's reversals are still reachable.
    expect(
      h.requests.filter((r) => r.type === 'transfer_reversal').map((r) => r.options.parentId),
    ).toEqual(['trf_in', 'trf_old']);
  });

  it('records a non-credential error and continues with the remaining object types', async () => {
    const plan = oneOfEveryType();
    plan.refund = () => [providerFailure('refund')];
    const h = harness(plan);
    const run = await h.service.startRun(TENANT, ACTOR);

    expect(new Set(h.requests.map((r) => r.type))).toEqual(new Set(INGESTED_OBJECT_TYPES));
    expect(run.per_type_errors.refund).toEqual([
      {
        objectType: 'refund',
        errorCode: 'SERVER_ERROR',
        errorCategory: 'provider_error',
        retryCount: 0,
        requestedAt: NOW.toISOString(),
      },
    ]);
    expect(run.per_type_stored.refund).toBe(0);
    expect(run.status).toBe('partially_completed');
    expect(h.store.recorded).toHaveLength(1);
    expect(h.store.completions[0]?.totalErrors).toBe(1);
  });

  it('records an object whose identifier is absent instead of skipping it silently', async () => {
    const h = harness({
      payment: () => [page('payment', [{ created_at: IN_WINDOW, amount: 100 }])],
    });
    const run = await h.service.startRun(TENANT, ACTOR);

    expect(h.store.rows.size).toBe(0);
    expect(run.per_type_errors.payment[0]?.errorCode).toBe('MISSING_IDENTIFIER');
    expect(run.per_type_errors.payment[0]?.errorCategory).toBe('provider_error');
  });

  it('records an out-of-range amount rather than clamping it, and stores nothing for it', async () => {
    const h = harness({
      payment: () => [
        page('payment', [
          { id: 'pay_big', created_at: IN_WINDOW, amount: 1_000_000_000_000 },
          { id: 'pay_ok', created_at: IN_WINDOW, amount: 999_999_999_999 },
        ]),
      ],
    });
    const run = await h.service.startRun(TENANT, ACTOR);

    expect(h.store.rows.has(`${TENANT}|pay_big`)).toBe(false);
    expect(h.store.rows.get(`${TENANT}|pay_ok`)?.amount_paise).toBe(999_999_999_999n);
    expect(run.per_type_errors.payment[0]?.errorCode).toBe('MONETARY_VALUE_OUT_OF_RANGE');
  });

  it('records a non-INR object rather than relabelling it', async () => {
    const h = harness({
      payment: () => [
        page('payment', [
          { id: 'pay_usd', created_at: IN_WINDOW, amount: 100, currency: 'USD' },
        ]),
      ],
    });
    const run = await h.service.startRun(TENANT, ACTOR);

    expect(h.store.rows.size).toBe(0);
    expect(run.per_type_errors.payment[0]?.errorCode).toBe('CURRENCY_NOT_INR');
  });

  it('records the collision when a recon line claims a payment identifier', async () => {
    const h = harness({
      payment: () => [page('payment', [{ id: 'pay_1', created_at: IN_WINDOW, amount: 100 }])],
      settlement_recon_report: (options) =>
        options.query?.month === '2' && options.query.year === '2025'
          ? [
              page('settlement_recon_report', [
                { entity_id: 'pay_1', settlement_id: 'setl_1', created_at: IN_WINDOW, amount: 100 },
              ]),
            ]
          : [page('settlement_recon_report', [])],
    });
    const run = await h.service.startRun(TENANT, ACTOR);

    // The payment retrieved first keeps the row; the recon line is recorded, not silent.
    expect(h.store.rows.get(`${TENANT}|pay_1`)?.object_type).toBe('payment');
    expect(run.per_type_errors.settlement_recon_report[0]?.errorCode).toBe(
      IDENTIFIER_COLLISION_ERROR_CODE,
    );
  });

  it('is failed with no_records_stored when nothing was stored and nothing failed', async () => {
    const h = harness({});
    const run = await h.service.startRun(TENANT, ACTOR);

    expect(run.status).toBe('failed');
    expect(run.failure_kind).toBe('no_records_stored');
    expect(h.store.upsertCalls.count).toBe(0);
    expect(h.store.completions[0]?.totalErrors).toBe(0);
  });

  it('publishes run_started, one event per object type, and run_completed', async () => {
    const h = harness(oneOfEveryType());
    await h.service.startRun(TENANT, ACTOR);

    expect(h.events[0]?.change).toBe('run_started');
    expect(h.events[0]?.run.status).toBe('in_progress');
    expect(h.events.filter((e) => e.change === 'object_type_completed')).toHaveLength(9);
    expect(h.events.at(-1)?.change).toBe('run_completed');
    expect(h.events.at(-1)?.run.status).toBe('completed');
  });

  it('completes the run even when the publisher throws', async () => {
    const store = fakeStore();
    const { client } = fakeClient(oneOfEveryType());
    const service = createIngestionService({
      store,
      client,
      publisher: {
        publish: async () => {
          throw new Error('realtime is down');
        },
      },
      now: () => NOW,
    });

    const run = await service.startRun(TENANT, ACTOR);
    expect(run.status).toBe('completed');
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 1.10                                                           */
/* -------------------------------------------------------------------------- */

describe('startRun on a credential rejection', () => {
  const prior: RazorpayObjectRow = Object.freeze({
    tenant_id: TENANT,
    razorpay_id: 'pay_prior',
    object_type: 'payment',
    ingestion_run_id: '44444444-4444-4444-8444-444444444444',
    retrieved_at: '2026-01-01T00:00:00.000Z',
    created_at_rzp: '2025-12-31T00:00:00.000Z',
    amount_paise: 111n,
    fee_paise: null,
    gst_on_fee_paise: null,
    currency: 'INR',
    status_rzp: 'captured',
    payload: { id: 'pay_prior', created_at: epoch('2025-12-31T00:00:00.000Z'), amount: 111 },
  });

  /** Payments succeed, then the second object type is rejected mid-run. */
  function rejectedMidRun(): Harness {
    const plan = oneOfEveryType();
    plan.order = () => [credentialRejection('order')];
    const h = harness(plan);
    h.store.rows.set(`${TENANT}|pay_prior`, prior);
    return h;
  }

  it('stores zero objects for the run and issues no write at all', async () => {
    const h = rejectedMidRun();
    const run = await h.service.startRun(TENANT, ACTOR);

    // Not "wrote and rolled back" — never wrote.
    expect(h.store.upsertCalls.count).toBe(0);
    expect(h.store.rows.size).toBe(1);
    expect([...h.store.rows.values()].every((r) => r.ingestion_run_id !== RUN_ID)).toBe(true);
    for (const type of INGESTED_OBJECT_TYPES) {
      expect(run.per_type_stored[type], type).toBe(0);
    }
    expect(h.store.completions[0]?.perTypeStored.payment).toBe(0);
  });

  it('leaves a previously stored object byte-identical', async () => {
    const h = rejectedMidRun();
    // A bigint cannot go through JSON.stringify, so serialise it explicitly.
    const serialise = (row: RazorpayObjectRow | undefined): string =>
      JSON.stringify(row, (_key, value: unknown) =>
        typeof value === 'bigint' ? `${value}n` : value,
      );
    const before = serialise(h.store.rows.get(`${TENANT}|pay_prior`));
    await h.service.startRun(TENANT, ACTOR);

    expect(serialise(h.store.rows.get(`${TENANT}|pay_prior`))).toBe(before);
    expect(h.store.rows.get(`${TENANT}|pay_prior`)?.retrieved_at).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('requests no further object types', async () => {
    const h = rejectedMidRun();
    await h.service.startRun(TENANT, ACTOR);

    expect(h.requests.map((r) => r.type)).toEqual(['payment', 'order']);
  });

  it('fails the run with the credential cause and records the error', async () => {
    const h = rejectedMidRun();
    const run = await h.service.startRun(TENANT, ACTOR);

    expect(run.status).toBe('failed');
    expect(run.failure_kind).toBe('credential_rejected');
    expect(run.ended_at).toBe(NOW.toISOString());
    expect(h.store.recorded.map((e) => e.errorCategory)).toEqual(['credential_rejected']);
    expect(h.store.recorded[0]?.objectType).toBe('order');
  });
});

/* -------------------------------------------------------------------------- */
/* upsertObject                                                               */
/* -------------------------------------------------------------------------- */

describe('upsertObject', () => {
  it('projects and writes one object', async () => {
    const h = harness({});
    await h.service.upsertObject(TENANT, RUN_ID, 'refund', {
      id: 'rfnd_1',
      created_at: IN_WINDOW,
      amount: 2_500,
    });

    expect(h.store.rows.get(`${TENANT}|rfnd_1`)?.amount_paise).toBe(2_500n);
    expect(h.store.rows.get(`${TENANT}|rfnd_1`)?.object_type).toBe('refund');
  });

  it('raises rather than storing an object with no identifier', async () => {
    const h = harness({});
    await expect(
      h.service.upsertObject(TENANT, RUN_ID, 'refund', { created_at: IN_WINDOW }),
    ).rejects.toThrowError(ObjectProjectionError);
    expect(h.store.rows.size).toBe(0);
  });
});
/* -------------------------------------------------------------------------- */
/* Requirement 1.6: the status mapping (task 6.4)                             */
/* -------------------------------------------------------------------------- */

/**
 * The full `(records stored, errors, credential rejected)` table for
 * {@link deriveRunOutcome}, written out rather than generated: an expectation computed
 * from a second copy of the precedence chain would agree with the implementation by
 * construction and could not detect a reordered branch.
 *
 * `storedCount` and `errorCount` are crossed over none / one / several, because the
 * criterion's clauses are stated as "zero" versus "1 or more" and the only boundary in
 * the logic is at zero — several is there to show nothing keys on the value 1.
 *
 * **The overlapping row is `(0, 0, false)`.** Requirement 1.6 makes it `completed`
 * ("when zero errors were encountered") and `failed` ("when zero records were stored")
 * at the same time; a clean run over an empty Razorpay account satisfies both clauses.
 * `deriveRunOutcome`'s doc comment resolves it as `failed` / `no_records_stored`, and
 * that resolution is asserted here as a decision rather than as a derivation — if the
 * spec is later settled the other way, this row is the single place that changes.
 */
const MANY_STORED = 7;
const MANY_ERRORS = 4;

interface OutcomeRow {
  readonly storedCount: number;
  readonly errorCount: number;
  readonly credentialRejected: boolean;
  readonly status: Exclude<IngestionStatus, 'in_progress'>;
  readonly failureKind: IngestionFailureKind;
}

const OUTCOME_TABLE: readonly OutcomeRow[] = [
  // No credential rejection: stored count decides first, then the error count.
  { storedCount: 0, errorCount: 0, credentialRejected: false, status: 'failed', failureKind: 'no_records_stored' },
  { storedCount: 0, errorCount: 1, credentialRejected: false, status: 'failed', failureKind: 'no_records_stored' },
  { storedCount: 0, errorCount: MANY_ERRORS, credentialRejected: false, status: 'failed', failureKind: 'no_records_stored' },
  { storedCount: 1, errorCount: 0, credentialRejected: false, status: 'completed', failureKind: null },
  { storedCount: 1, errorCount: 1, credentialRejected: false, status: 'partially_completed', failureKind: null },
  { storedCount: 1, errorCount: MANY_ERRORS, credentialRejected: false, status: 'partially_completed', failureKind: null },
  { storedCount: MANY_STORED, errorCount: 0, credentialRejected: false, status: 'completed', failureKind: null },
  { storedCount: MANY_STORED, errorCount: 1, credentialRejected: false, status: 'partially_completed', failureKind: null },
  { storedCount: MANY_STORED, errorCount: MANY_ERRORS, credentialRejected: false, status: 'partially_completed', failureKind: null },
  // A credential rejection outranks every count, including counts that would otherwise
  // read as a clean, fully successful run (Requirement 1.10).
  { storedCount: 0, errorCount: 0, credentialRejected: true, status: 'failed', failureKind: 'credential_rejected' },
  { storedCount: 0, errorCount: 1, credentialRejected: true, status: 'failed', failureKind: 'credential_rejected' },
  { storedCount: 0, errorCount: MANY_ERRORS, credentialRejected: true, status: 'failed', failureKind: 'credential_rejected' },
  { storedCount: 1, errorCount: 0, credentialRejected: true, status: 'failed', failureKind: 'credential_rejected' },
  { storedCount: 1, errorCount: 1, credentialRejected: true, status: 'failed', failureKind: 'credential_rejected' },
  { storedCount: 1, errorCount: MANY_ERRORS, credentialRejected: true, status: 'failed', failureKind: 'credential_rejected' },
  { storedCount: MANY_STORED, errorCount: 0, credentialRejected: true, status: 'failed', failureKind: 'credential_rejected' },
  { storedCount: MANY_STORED, errorCount: 1, credentialRejected: true, status: 'failed', failureKind: 'credential_rejected' },
  { storedCount: MANY_STORED, errorCount: MANY_ERRORS, credentialRejected: true, status: 'failed', failureKind: 'credential_rejected' },
];

/**
 * `ingestion_runs.failure_kind`'s CHECK, copied from
 * `supabase/migrations/20260101000002_ingestion.sql`:
 * `failure_kind TEXT CHECK (failure_kind IN ('credential_rejected', 'no_records_stored'))`.
 * The column is nullable and has no default, so `null` is the third permitted value and
 * is what a run that did not fail must carry.
 */
const PERMITTED_FAILURE_KINDS: readonly IngestionFailureKind[] = [
  null,
  'credential_rejected',
  'no_records_stored',
];

/**
 * The migration's `CHECK ((status = 'in_progress') = (ended_at IS NULL))` is a
 * biconditional, so a run that has an `ended_at` — which every finished run does — cannot
 * be `in_progress`. `deriveRunOutcome` is only called at that point, and its return type
 * is `Exclude<IngestionStatus, 'in_progress'>`; these are the three values left.
 */
const TERMINAL_STATUSES = INGESTION_STATUSES.filter((s) => s !== 'in_progress');

describe('deriveRunOutcome', () => {
  for (const row of OUTCOME_TABLE) {
    const label =
      `${row.storedCount} stored, ${row.errorCount} errors` +
      `${row.credentialRejected ? ', credential rejected' : ''}` +
      ` -> ${row.status} / ${String(row.failureKind)}`;

    it(label, () => {
      const outcome = deriveRunOutcome({
        storedCount: row.storedCount,
        errorCount: row.errorCount,
        credentialRejected: row.credentialRejected,
      });
      expect(outcome).toEqual({ status: row.status, failureKind: row.failureKind });
    });
  }

  it('is failed with no_records_stored when a clean run stored nothing', () => {
    // The row Requirement 1.6 leaves overlapping, called out on its own because it is a
    // resolution of an ambiguity rather than a reading of the criterion.
    expect(
      deriveRunOutcome({ storedCount: 0, errorCount: 0, credentialRejected: false }),
    ).toEqual({ status: 'failed', failureKind: 'no_records_stored' });
  });

  it('lets a credential rejection outrank a run that had already stored records', () => {
    // The run driver passes `storedCount: 0` on the abort path because an aborted run
    // stores nothing (Requirement 1.10), but the precedence is in this function, not in
    // the caller: a non-zero count with a rejection is still a credential failure.
    expect(
      deriveRunOutcome({ storedCount: MANY_STORED, errorCount: 0, credentialRejected: true }),
    ).toEqual({ status: 'failed', failureKind: 'credential_rejected' });
    expect(
      deriveRunOutcome({ storedCount: 0, errorCount: 0, credentialRejected: true }).failureKind,
    ).toBe('credential_rejected');
  });

  it('prefers no_records_stored over the error count, so 0 stored is never partially_completed', () => {
    for (const errorCount of [0, 1, MANY_ERRORS]) {
      const outcome = deriveRunOutcome({ storedCount: 0, errorCount, credentialRejected: false });
      expect(outcome.status, `0 stored, ${errorCount} errors`).toBe('failed');
      expect(outcome.status).not.toBe('partially_completed');
    }
  });

  it('never returns in_progress, so the ended_at biconditional always holds', () => {
    for (const row of OUTCOME_TABLE) {
      const { status } = deriveRunOutcome(row);
      expect(status, JSON.stringify(row)).not.toBe('in_progress');
      expect(TERMINAL_STATUSES).toContain(status);
    }
  });

  it('returns only failure kinds the failure_kind CHECK permits', () => {
    for (const row of OUTCOME_TABLE) {
      expect(PERMITTED_FAILURE_KINDS, JSON.stringify(row)).toContain(
        deriveRunOutcome(row).failureKind,
      );
    }
  });

  /**
   * The same invariants over arbitrary counts. This is cheap branch logic rather than a
   * numbered specification property, so it lives here with a low iteration count and is
   * not one of design.md's P1..P15 in `test/property/`.
   */
  it('holds its invariants for arbitrary counts', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 10_000 }),
        fc.nat({ max: 10_000 }),
        fc.boolean(),
        (storedCount, errorCount, credentialRejected) => {
          const { status, failureKind } = deriveRunOutcome({
            storedCount,
            errorCount,
            credentialRejected,
          });

          // Always terminal, and always a persistable failure kind.
          expect(TERMINAL_STATUSES).toContain(status);
          expect(PERMITTED_FAILURE_KINDS).toContain(failureKind);

          // A failure kind is only ever attached to a failed run.
          if (failureKind !== null) {
            expect(status).toBe('failed');
          }

          // `completed` means the run did work and nothing went wrong.
          if (status === 'completed') {
            expect(errorCount).toBe(0);
            expect(storedCount).toBeGreaterThan(0);
            expect(credentialRejected).toBe(false);
          }
        },
      ),
      { numRuns: 50, seed: 20260214 },
    );
  });
});
