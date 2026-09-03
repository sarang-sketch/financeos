/**
 * FinanceOS_Ingestion_Service — the ingestion run (task 6.2).
 *
 * The transport is `./razorpay-client` (task 6.1): paging, the 30 s per-request timeout,
 * the 1/2/4/8/16 s retry schedule and the four-way classification all live there and are
 * not reimplemented here. This module owns the **run**: creating it, driving the transport
 * over the nine ingestion object types, projecting each retrieved object into a
 * `razorpay_objects` row, deciding what is recorded and what aborts, and closing the run
 * with its counts and status.
 *
 * ## The state guarantee that shapes the whole design
 *
 * Requirement 1.10: on a credential rejection the run requests no further object types,
 * stores **zero** Razorpay objects **for that run**, and leaves every previously stored
 * object byte-identical.
 *
 * Those two clauses together rule out upserting as objects arrive. An upsert on
 * `(tenant_id, razorpay_id)` **replaces** a prior payload and refreshes its
 * `retrieved_at`; once that statement has run, "leave the previous object unchanged" is
 * no longer achievable — a compensating write restores a value but not the fact that it
 * was never touched, and `retrieved_at` would have moved.
 *
 * Nor is per-object-type commit sufficient. A credential can be revoked or rotated
 * mid-run, so a 401 can arrive on the sixth object type after five have committed; that
 * run would then have stored objects, which Requirement 1.10 forbids outright.
 *
 * **So the whole run is staged in memory and committed once, after the traversal has
 * finished without a credential rejection.** The abort path issues no write against
 * `razorpay_objects` at all: the guarantee is structural (no statement is ever sent)
 * rather than transactional (a statement sent and rolled back). That is the strongest
 * form available and it is what {@link IngestionStore.upsertObjects} being called exactly
 * zero times on the abort path asserts.
 *
 * The cost is memory: a first run over 365 days holds every retrieved payload until the
 * commit phase. That is accepted for the MVP and recorded here rather than hidden — the
 * alternative that keeps the guarantee while bounding memory is a per-run staging table
 * committed with a single server-side `INSERT ... SELECT`, which needs a migration and is
 * not this task's.
 *
 * ## Money
 *
 * Every monetary projection is `Paise` (`bigint`) end to end. {@link toIngestedPaise} is
 * the only conversion, it uses `BigInt(...)` on the digits and never `Number(...)`,
 * `parseInt` or `toFixed`, it rejects a non-integer and a JSON number that has already
 * lost precision, and a value outside 0..999,999,999,999 **raises** rather than clamping
 * (Requirement 1.7). `currency` is `'INR'`; a payload that says otherwise is recorded as
 * an error rather than relabelled.
 *
 * ## What is deliberately not here
 *
 * - The ingestion API route, the seeding script (7.1), P10's property test (6.3), the
 *   status-mapping unit table (6.4) and the Razorpay integration tests (6.5).
 *
 * ## The window (task 6.6)
 *
 * {@link pickWatermark} chooses the watermark — the `started_at` of the most recent
 * `completed` run — and {@link resolveWindow} maps `(startedAt, watermark | null)` to the
 * window and its basis. Both are pure and synchronous; the one read is
 * {@link IngestionStore.readWatermark}, called once at the top of `startRun`.
 */

import { PAISE_INGESTED_MAX, PAISE_INGESTED_MIN, type Paise } from '@/calc/paise';
import type { TenantId } from '@/config/configuration-service';
import {
  INGESTED_OBJECT_TYPES,
  type CredentialRejectedFailure,
  type FetchOptions,
  type IngestedObjectType,
  type RazorpayClient,
  type RazorpayErrorCategory,
  type RazorpayFetchResult,
  type RazorpayObject,
  type RecordableRazorpayFailure,
  type TimeWindow,
} from '@/ingestion/razorpay-client';

/* -------------------------------------------------------------------------- */
/* Run vocabulary                                                             */
/* -------------------------------------------------------------------------- */

/** The `ingestion_status` enum, in migration order. */
export const INGESTION_STATUSES = [
  'in_progress',
  'completed',
  'partially_completed',
  'failed',
] as const;

export type IngestionStatus = (typeof INGESTION_STATUSES)[number];

/** `ingestion_runs.failure_kind`'s CHECK, plus `null` for a run that did not fail. */
export type IngestionFailureKind = null | 'credential_rejected' | 'no_records_stored';

/**
 * `ingestion_runs.window_basis`'s CHECK — exactly these two values.
 *
 * `'first_run_365d'` when the Tenant has no watermark (Requirement 1.8), `'incremental'`
 * when it has one (Requirement 1.9). See {@link resolveWindow}.
 */
export type WindowBasis = 'first_run_365d' | 'incremental';

/**
 * One recorded error, in the shape `ingestion_errors` stores it.
 *
 * `retryCount` and `requestedAt` come from the transport's failure, not from a clock
 * read here: the recorded request timestamp has to be the timestamp of the request that
 * failed (Requirement 1.4).
 */
export interface IngestionError {
  readonly objectType: IngestedObjectType;
  readonly errorCode: string;
  readonly errorCategory: RazorpayErrorCategory;
  readonly retryCount: number;
  /** ISO-8601 UTC. */
  readonly requestedAt: string;
}

/** A per-object-type map with all nine keys always present. */
export type PerObjectType<T> = Readonly<Record<IngestedObjectType, T>>;

/**
 * design.md's `IngestionRun`, with three deliberate differences.
 *
 * 1. The maps are keyed by {@link IngestedObjectType} — the nine types ingestion
 *    retrieves — rather than by all ten `razorpay_object_type` labels. `credit_note`
 *    arrives from the compliance path and an ingestion run can never store or fail one,
 *    so a `credit_note: 0` entry would be noise in every run summary.
 * 2. `window_from` and `window_basis` are surfaced, because a run is only auditable
 *    with the window that produced it (Requirement 1.8, 1.9).
 * 3. `per_type_window_filtered` is added. Four object types have no server-side window
 *    filter, so the restriction is applied here; a filtered-out record is neither stored
 *    nor an error, and without this count it would be invisible. The schema has nowhere
 *    to persist it, so it is in-memory and on the Realtime event only.
 */
export interface IngestionRun {
  readonly id: string;
  readonly tenant_id: TenantId;
  /**
   * ISO-8601 UTC. Doubles as the incremental watermark once this run reaches `completed`
   * — see {@link pickWatermark}.
   */
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly status: IngestionStatus;
  readonly failure_kind: IngestionFailureKind;
  readonly window_from: string;
  readonly window_basis: WindowBasis;
  readonly per_type_stored: PerObjectType<number>;
  readonly per_type_errors: PerObjectType<readonly IngestionError[]>;
  readonly per_type_window_filtered: PerObjectType<number>;
}

/* -------------------------------------------------------------------------- */
/* Storage seam                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One `razorpay_objects` row, already projected out of the payload.
 *
 * `payload` is the object **exactly** as Razorpay returned it: the same reference, no
 * key reordering, no field stripping, no normalisation (Requirement 1.2). Everything
 * else on this row is a projection of it, present so the reconciliation joins are
 * indexable, and the payload stays authoritative.
 */
export interface RazorpayObjectRow {
  readonly tenant_id: TenantId;
  readonly razorpay_id: string;
  readonly object_type: IngestedObjectType;
  readonly ingestion_run_id: string;
  /** The retrieval timestamp: when the page carrying this object was received. */
  readonly retrieved_at: string;
  readonly created_at_rzp: string;
  readonly amount_paise: Paise | null;
  readonly fee_paise: Paise | null;
  readonly gst_on_fee_paise: Paise | null;
  /** Pinned by CHECK, and by Requirement 1.7. */
  readonly currency: 'INR';
  readonly status_rzp: string | null;
  readonly payload: RazorpayObject;
}

/** What {@link IngestionStore.createRun} writes. */
export interface NewRun {
  readonly tenantId: TenantId;
  readonly startedAt: string;
  readonly windowFrom: string;
  readonly windowBasis: WindowBasis;
  readonly initiatedBy: string;
}

/** What {@link IngestionStore.completeRun} writes. */
export interface RunCompletion {
  readonly tenantId: TenantId;
  readonly runId: string;
  readonly endedAt: string;
  readonly status: Exclude<IngestionStatus, 'in_progress'>;
  readonly failureKind: IngestionFailureKind;
  readonly perTypeStored: PerObjectType<number>;
  /**
   * `ingestion_runs.per_type_errors` is a scalar `INT`, so this is the run total.
   *
   * **Schema mismatch, reported not worked around.** Requirement 1.6 asks for a
   * *per-object-type* count of errors and `per_type_stored` is correctly `JSONB` keyed by
   * object type, but `per_type_errors INT NOT NULL DEFAULT 0` cannot hold a breakdown.
   * The breakdown is recoverable by aggregating `ingestion_errors` by `object_type` for
   * the run, and it is exact in {@link IngestionRun.per_type_errors} in memory. The
   * migration is left as it is (task 4.2 flagged the same defect); fixing the column type
   * needs a migration this task does not own.
   */
  readonly totalErrors: number;
}

/**
 * Persistence for the three ingestion tables. Injected rather than imported so the run
 * logic is testable without a database, and so the Tenant scope is the adapter's concern.
 *
 * `upsertObjects` takes the whole run's rows in one call. That is what lets the commit
 * phase be a single step, and it is why the abort path can be "call this zero times".
 */
export interface IngestionStore {
  createRun(run: NewRun): Promise<{ readonly id: string; readonly startedAt: string }>;
  /**
   * The incremental watermark for a Tenant: `started_at` of the most recent
   * `completed` run, as an ISO-8601 timestamp, or `null` when the Tenant has none
   * (Requirement 1.9). `SELECT started_at FROM ingestion_runs WHERE tenant_id = $1 AND
   * status = 'completed' ORDER BY started_at DESC LIMIT 1` — the same rule
   * {@link pickWatermark} applies in memory.
   *
   * **Optional, and its absence is the safe direction.** An adapter that does not
   * implement it yields no watermark, so every run takes the 365-day window
   * ({@link resolveWindow}): wasteful, but it cannot skip an object. Making it required
   * would break every existing fake store for no correctness gain. The Supabase adapter
   * implements it.
   */
  readWatermark?(tenantId: TenantId): Promise<string | null>;
  /**
   * `INSERT ... ON CONFLICT (tenant_id, razorpay_id) DO UPDATE SET payload = EXCLUDED.payload,
   * retrieved_at = EXCLUDED.retrieved_at, ingestion_run_id = EXCLUDED.ingestion_run_id`
   * against `razorpay_objects_tenant_rzp_uniq` (Requirement 1.3, property P10).
   *
   * `rows` is already deduplicated on `razorpay_id` by the caller: one
   * `ON CONFLICT DO UPDATE` statement cannot affect the same row twice, so a duplicate
   * within a batch would be a runtime error rather than an overwrite.
   */
  upsertObjects(rows: readonly RazorpayObjectRow[]): Promise<void>;
  recordErrors(
    tenantId: TenantId,
    runId: string,
    errors: readonly IngestionError[],
  ): Promise<void>;
  completeRun(completion: RunCompletion): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Realtime seam                                                              */
/* -------------------------------------------------------------------------- */

/** Which transition an event describes. */
export type IngestionRunChange = 'run_started' | 'object_type_completed' | 'run_completed';

/**
 * A run state change for the Control_Tower (design.md: "Supabase Realtime pushes
 * Exception and Ingestion_Run state changes to the Control_Tower").
 *
 * On an `object_type_completed` event the counts are **staged, not yet committed** — see
 * the module doc comment. Only `run_completed` reports counts that are in the database.
 */
export interface IngestionRunEvent {
  readonly change: IngestionRunChange;
  readonly run: IngestionRun;
  /** The object type just finished, for `object_type_completed`. */
  readonly objectType: IngestedObjectType | null;
  readonly at: string;
}

/** Where run state changes are published. */
export interface IngestionRunPublisher {
  publish(event: IngestionRunEvent): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Projection errors                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The reasons a retrieved object cannot be stored. Each becomes an `ingestion_errors`
 * row for its object type, so the record is **never** silently skipped and never given a
 * fabricated identifier.
 *
 * They are recorded with `error_category = 'provider_error'`: the four categories are
 * exactly what the column's CHECK accepts, this is not a rate limit, not a timeout and
 * not a credential rejection, and Requirement 1.4's disposition — record it and carry on
 * with the remaining object types — is the right one for a response we cannot store.
 */
export const PROJECTION_ERROR_CODES = [
  'MISSING_IDENTIFIER',
  'MISSING_CREATED_AT',
  'CURRENCY_NOT_INR',
  'NON_INTEGER_MONETARY_VALUE',
  'MONETARY_VALUE_OUT_OF_RANGE',
] as const;

export type ProjectionErrorCode = (typeof PROJECTION_ERROR_CODES)[number];

/** Thrown by {@link projectRazorpayObject}. Carries the code recorded for the run. */
export class ObjectProjectionError extends Error {
  override readonly name = 'ObjectProjectionError';

  readonly code: ProjectionErrorCode;

  constructor(code: ProjectionErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Per-type identifier extraction                                             */
/* -------------------------------------------------------------------------- */

/**
 * Which payload field carries the Razorpay identifier, per object type.
 *
 * Eight of the nine collections key on `id`. A **combined settlement recon report** row
 * is not an entity of its own — it is a line describing some other entity (a payment, a
 * refund, an adjustment) inside a settlement — and Razorpay keys it on `entity_id`. So
 * the extraction is per type and explicit. There is no `?? obj.id` fallback and no
 * generated identifier: a row whose identifier field is absent is an error
 * ({@link ObjectProjectionError} with `MISSING_IDENTIFIER`), because a fabricated
 * identifier would defeat the one-row-per-identifier-per-Tenant guarantee of
 * Requirement 1.3 and a silent skip would lose a source record with no trace.
 */
export const RAZORPAY_ID_FIELD: PerObjectType<string> = Object.freeze({
  payment: 'id',
  order: 'id',
  refund: 'id',
  settlement: 'id',
  settlement_recon_report: 'entity_id',
  transfer: 'id',
  transfer_reversal: 'id',
  razorpay_invoice: 'id',
  linked_account: 'id',
} satisfies PerObjectType<string>);

/** The identifier, or {@link ObjectProjectionError}. Never a fabricated value. */
export function extractRazorpayId(
  type: IngestedObjectType,
  object: RazorpayObject,
): string {
  const field = RAZORPAY_ID_FIELD[type];
  const value = object[field];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  throw new ObjectProjectionError(
    'MISSING_IDENTIFIER',
    `a ${type} carried no '${field}'; the Razorpay identifier is the upsert key and is ` +
      `never generated or defaulted`,
  );
}

/* -------------------------------------------------------------------------- */
/* Monetary projection                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Which payload fields the three monetary projections read, per object type, in
 * precedence order.
 *
 * Razorpay is not uniform: a payment carries `fee` and `tax` (the GST on that fee), a
 * Route transfer carries `fees` and `tax`, and an order, refund or invoice carries an
 * amount only. Where a type has no field for a projection the column stays `NULL`, which
 * is why those columns are nullable. A `linked_account` carries no monetary figure at all.
 *
 * `tax` is the GST charged on the Razorpay fee, which is what `gst_on_fee_paise` means.
 */
export const RAZORPAY_MONEY_FIELDS: PerObjectType<{
  readonly amount: readonly string[];
  readonly fee: readonly string[];
  readonly gstOnFee: readonly string[];
}> = Object.freeze({
  payment: { amount: ['amount'], fee: ['fee'], gstOnFee: ['tax'] },
  order: { amount: ['amount'], fee: [], gstOnFee: [] },
  refund: { amount: ['amount'], fee: [], gstOnFee: [] },
  settlement: { amount: ['amount'], fee: ['fee', 'fees'], gstOnFee: ['tax'] },
  settlement_recon_report: { amount: ['amount'], fee: ['fee', 'fees'], gstOnFee: ['tax'] },
  transfer: { amount: ['amount'], fee: ['fees', 'fee'], gstOnFee: ['tax'] },
  transfer_reversal: { amount: ['amount'], fee: ['fees', 'fee'], gstOnFee: ['tax'] },
  razorpay_invoice: { amount: ['amount'], fee: [], gstOnFee: [] },
  linked_account: { amount: [], fee: [], gstOnFee: [] },
});

/**
 * A retrieved monetary value to integer paise, with no rounding, truncation or unit
 * scaling and no float anywhere on the path (Requirement 1.7, 15.1, 15.8).
 *
 * Razorpay states its money in paise already, so there is nothing to scale, and this
 * function must not invent a scaling: `BigInt` of the digits is the whole conversion.
 *
 * Rejections, all raising rather than repairing:
 *
 * - a JSON number that is not an integer — `100.5` paise is not a value we may round;
 * - a JSON number beyond `Number.MAX_SAFE_INTEGER`, which has **already** lost precision
 *   before this function saw it, so storing it would store a silently rounded figure;
 * - anything outside 0..999,999,999,999, the `paise_ingested` domain. Raise, never clamp:
 *   a clamped amount is a wrong amount that reconciles against nothing.
 */
export function toIngestedPaise(value: unknown, field: string): Paise {
  let paise: Paise;

  if (typeof value === 'bigint') {
    paise = value;
  } else if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new ObjectProjectionError(
        'NON_INTEGER_MONETARY_VALUE',
        `'${field}' is not an integer number of paise; rounding it is forbidden`,
      );
    }
    if (!Number.isSafeInteger(value)) {
      throw new ObjectProjectionError(
        'NON_INTEGER_MONETARY_VALUE',
        `'${field}' exceeds the exact-integer range of a JSON number, so its digits are ` +
          `already unreliable`,
      );
    }
    paise = BigInt(value);
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    // Digit text straight to bigint. Never Number(), never parseInt.
    paise = BigInt(value.trim());
  } else {
    throw new ObjectProjectionError(
      'NON_INTEGER_MONETARY_VALUE',
      `'${field}' is not integer paise: ${typeof value}`,
    );
  }

  if (paise < PAISE_INGESTED_MIN || paise > PAISE_INGESTED_MAX) {
    throw new ObjectProjectionError(
      'MONETARY_VALUE_OUT_OF_RANGE',
      `'${field}' is ${paise}, outside ${PAISE_INGESTED_MIN}..${PAISE_INGESTED_MAX}`,
    );
  }
  return paise;
}

/** The first present field of `fields`, converted, or `null` when the type has none. */
function projectMoney(
  object: RazorpayObject,
  fields: readonly string[],
): Paise | null {
  for (const field of fields) {
    const value = object[field];
    if (value !== undefined && value !== null) {
      return toIngestedPaise(value, field);
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Creation timestamp                                                         */
/* -------------------------------------------------------------------------- */

/**
 * `created_at` as an instant. Razorpay states it as Unix **seconds**.
 *
 * `razorpay_objects.created_at_rzp` is `NOT NULL`, and the four object types with no
 * server-side window filter are restricted against this value, so an object with no
 * usable creation timestamp cannot be stored and cannot be window-checked. That is an
 * error, not a default of `now()`: defaulting would both corrupt the created-at index and
 * silently pull an out-of-window record into the run.
 */
export function extractCreatedAt(object: RazorpayObject): Date {
  const value = object.created_at;

  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return new Date(value * 1000);
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return new Date(Number.parseInt(value.trim(), 10) * 1000);
  }
  throw new ObjectProjectionError(
    'MISSING_CREATED_AT',
    `created_at is absent or not Unix seconds (${typeof value}); created_at_rzp is NOT ` +
      `NULL and the window restriction is applied against it`,
  );
}

/** Inclusive on both ends, matching {@link TimeWindow}. */
export function withinWindow(at: Date, window: TimeWindow): boolean {
  return at.getTime() >= window.from.getTime() && at.getTime() <= window.to.getTime();
}

/* -------------------------------------------------------------------------- */
/* Row projection                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One retrieved object to one `razorpay_objects` row (Requirement 1.2, 1.7).
 *
 * `payload` is carried by reference, so what is stored is what was returned. A
 * `currency` other than `INR` is an error rather than a relabelling: Requirement 1.7 says
 * record the currency as INR and the column's CHECK pins it, so writing `'INR'` over a
 * payload that said otherwise would store a figure under a currency it is not in.
 *
 * @throws {ObjectProjectionError} which the run records against the object type.
 */
export function projectRazorpayObject(input: {
  readonly tenantId: TenantId;
  readonly runId: string;
  readonly objectType: IngestedObjectType;
  readonly object: RazorpayObject;
  readonly retrievedAt: Date;
}): RazorpayObjectRow {
  const { object, objectType } = input;
  const currency = object.currency;
  if (currency !== undefined && currency !== null && currency !== 'INR') {
    throw new ObjectProjectionError(
      'CURRENCY_NOT_INR',
      `a ${objectType} reported currency '${String(currency)}'; the store holds INR only`,
    );
  }

  const money = RAZORPAY_MONEY_FIELDS[objectType];
  const status = object.status;

  return Object.freeze({
    tenant_id: input.tenantId,
    razorpay_id: extractRazorpayId(objectType, object),
    object_type: objectType,
    ingestion_run_id: input.runId,
    retrieved_at: input.retrievedAt.toISOString(),
    created_at_rzp: extractCreatedAt(object).toISOString(),
    amount_paise: projectMoney(object, money.amount),
    fee_paise: projectMoney(object, money.fee),
    gst_on_fee_paise: projectMoney(object, money.gstOnFee),
    currency: 'INR',
    status_rzp: typeof status === 'string' ? status : null,
    payload: object,
  });
}

/* -------------------------------------------------------------------------- */
/* Window                                                                     */
/* -------------------------------------------------------------------------- */

/** Requirement 1.8: the 365 days immediately preceding the run start. */
export const FIRST_RUN_WINDOW_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The only run status that advances the incremental watermark (Requirement 1.9).
 *
 * **`partially_completed` deliberately does not.** A partially completed run stored at
 * least one record but hit at least one error, so at least one object type was not fully
 * retrieved. Advancing the window past its start would put whatever that run missed
 * permanently outside every future window — a silent, unrecoverable gap. `failed` does not
 * advance for the same reason, and `in_progress` has no outcome yet.
 */
export const WATERMARK_STATUS = 'completed' satisfies IngestionStatus;

/** A run as the watermark rule sees it: its status and its start timestamp. */
export interface WatermarkCandidate {
  readonly status: IngestionStatus;
  /** `ingestion_runs.started_at`. */
  readonly startedAt: string | Date;
}

/** An ISO timestamp to an instant, refusing an unparseable one rather than guessing. */
function toInstant(value: string | Date, what: string): Date {
  const at = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(at.getTime())) {
    throw new Error(
      `${what} is not a timestamp: ${JSON.stringify(value)}. The incremental window is ` +
        `derived from it, so a guess here would silently move the window.`,
    );
  }
  return at;
}

/**
 * The incremental watermark: the `started_at` of the most recent {@link WATERMARK_STATUS}
 * run, or `null` when the Tenant has none (Requirement 1.9).
 *
 * `started_at`, **not** `ended_at`. Using the end timestamp would leave a gap exactly the
 * width of the run: an object created while a run was in flight is not guaranteed to have
 * been visible to that run's requests, and with `from = ended_at` it would fall outside
 * the next window too, so it would never be retrieved.
 * `20260101000002_ingestion.sql` documents `started_at` as the watermark for this reason.
 *
 * "Most recent" is by `started_at`, so a `completed` run that is not the newest run
 * overall still wins over a later `failed` or `partially_completed` one. This is the same
 * rule {@link IngestionStore.readWatermark} runs as SQL, kept here so it is testable
 * without a database.
 */
export function pickWatermark(runs: readonly WatermarkCandidate[]): Date | null {
  let latest: Date | null = null;
  for (const run of runs) {
    if (run.status !== WATERMARK_STATUS) {
      continue;
    }
    const at = toInstant(run.startedAt, `a ${run.status} run's started_at`);
    if (latest === null || at.getTime() > latest.getTime()) {
      latest = at;
    }
  }
  return latest;
}

/** {@link IngestionStore.readWatermark}'s result to what {@link resolveWindow} takes. */
export function parseWatermark(watermark: string | Date | null): Date | null {
  return watermark === null ? null : toInstant(watermark, 'the incremental watermark');
}

/**
 * The retrieval window for a run, and the basis recorded on `ingestion_runs`.
 *
 * - **No watermark** — the 365 days preceding `startedAt`, basis `'first_run_365d'`
 *   (Requirement 1.8). This is the case for a Tenant's first run *and* for a Tenant whose
 *   every prior run failed: neither has a `completed` run to resume from.
 * - **A watermark** — `{ from: watermark, to: startedAt }`, basis `'incremental'`
 *   (Requirement 1.9). `from` is **inclusive**: {@link withinWindow} compares with `>=`
 *   and the transport's window filter is inclusive too, so an object created at exactly
 *   the watermark instant is retrieved, which is what "at or after" says. The overlap of
 *   one instant is harmless — re-retrieving an object is an upsert on
 *   `(tenant_id, razorpay_id)` (Requirement 1.3), so it cannot duplicate a row.
 *
 * **The gap between 1.8 and 1.9, and how it is closed.** 1.8's condition is "no run with
 * status `completed` *or partially completed*" while 1.9's is "at least one `completed`
 * run", so a Tenant whose only prior run is `partially_completed` satisfies neither.
 * `window_basis` admits two values and there is no third rule to reach for, so that
 * Tenant takes the 365-day window: it re-scans, and re-scanning is the direction that
 * cannot lose the records the partial run missed. See {@link WATERMARK_STATUS}.
 */
export function resolveWindow(
  startedAt: Date,
  watermark: Date | null = null,
): {
  readonly window: TimeWindow;
  readonly basis: WindowBasis;
} {
  if (watermark !== null) {
    return {
      window: {
        from: new Date(watermark.getTime()),
        // Requirement 1.9 bounds the window below only. `to` is the run start, except in
        // the pathological case of a watermark after it (a clock that went backwards
        // between two runs), where `to = from` keeps the window from being empty — an
        // empty window would silently retrieve nothing, which is the one outcome the
        // watermark exists to prevent.
        to: new Date(Math.max(startedAt.getTime(), watermark.getTime())),
      },
      basis: 'incremental',
    };
  }
  return {
    window: {
      from: new Date(startedAt.getTime() - FIRST_RUN_WINDOW_DAYS * DAY_MS),
      to: startedAt,
    },
    basis: 'first_run_365d',
  };
}

/**
 * Every calendar month the window touches, as the `year` and `month` query parameters the
 * combined settlement recon report requires. UTC, inclusive of both endpoints' months, so
 * a 365-day window yields 13 months.
 */
export function monthsInWindow(
  window: TimeWindow,
): readonly { readonly year: string; readonly month: string }[] {
  const months: { year: string; month: string }[] = [];
  let year = window.from.getUTCFullYear();
  let month = window.from.getUTCMonth() + 1;
  const lastYear = window.to.getUTCFullYear();
  const lastMonth = window.to.getUTCMonth() + 1;

  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    months.push({ year: String(year), month: String(month) });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

/* -------------------------------------------------------------------------- */
/* Status mapping                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The terminal status and failure kind for a finished run (Requirement 1.6).
 *
 * | Condition | Status | `failure_kind` |
 * |---|---|---|
 * | credential rejected | `failed` | `credential_rejected` |
 * | zero records stored | `failed` | `no_records_stored` |
 * | ≥1 stored, zero errors | `completed` | `null` |
 * | ≥1 stored, ≥1 error | `partially_completed` | `null` |
 *
 * **The boundary Requirement 1.6 leaves overlapping: zero stored and zero errors.** The
 * criterion says `completed` "when zero errors were encountered" and `failed` "when zero
 * records were stored", and a clean run over an empty account satisfies both. This
 * implementation resolves it as **`failed` with `failure_kind = 'no_records_stored'`**,
 * for three reasons:
 *
 * 1. The zero-stored clause is stated unconditionally, while the `completed` clause is
 *    qualified only on errors — so zero-stored is the more specific rule.
 * 2. The schema agrees: `failure_kind` exists and one of its two permitted values is
 *    exactly `no_records_stored`, which is only reachable if a run with no errors and no
 *    records is `failed`. There is no other condition that value could describe.
 * 3. It is the conservative direction for Requirement 1.9. `completed` is the incremental
 *    watermark (task 6.6), so marking an empty run `completed` would advance the window on
 *    the strength of a run that stored nothing. `failed` leaves the next run's window at
 *    365 days, which re-scans but cannot skip.
 *
 * Task 6.4 tests the full table.
 */
export function deriveRunOutcome(outcome: {
  readonly storedCount: number;
  readonly errorCount: number;
  readonly credentialRejected: boolean;
}): {
  readonly status: Exclude<IngestionStatus, 'in_progress'>;
  readonly failureKind: IngestionFailureKind;
} {
  if (outcome.credentialRejected) {
    return { status: 'failed', failureKind: 'credential_rejected' };
  }
  if (outcome.storedCount === 0) {
    return { status: 'failed', failureKind: 'no_records_stored' };
  }
  if (outcome.errorCount === 0) {
    return { status: 'completed', failureKind: null };
  }
  return { status: 'partially_completed', failureKind: null };
}

/* -------------------------------------------------------------------------- */
/* Identifier collision                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Recorded when two retrieved objects **of different types** claim one Razorpay
 * identifier, so the run cannot store both under `razorpay_objects_tenant_rzp_uniq`.
 *
 * **This is reachable, and it is a schema finding rather than a defensive branch.** A
 * combined settlement recon report line keys on `entity_id`, and `entity_id` is the
 * identifier of the settled entity itself — the payment or refund the line describes. So
 * a recon line and its payment contend for the same `(tenant_id, razorpay_id)` row.
 *
 * Within a run the earlier row wins and the later one is recorded under this code, so the
 * outcome is deterministic and visible rather than a silent overwrite. **Across runs it
 * cannot be prevented here**: if the payment was stored by an earlier run, the upsert
 * replaces its payload with the recon line's. Fixing that needs the key to change —
 * unique on `(tenant_id, object_type, razorpay_id)`, or a composite identifier for recon
 * lines — which is a migration, and migrations are not this task's to write. Confirm the
 * real `entity_id` shape against Razorpay test mode in task 6.5 before choosing.
 */
export const IDENTIFIER_COLLISION_ERROR_CODE = 'IDENTIFIER_COLLIDES_WITH_OTHER_TYPE';

/* -------------------------------------------------------------------------- */
/* The service                                                                */
/* -------------------------------------------------------------------------- */

/**
 * design.md's `IngestionService`, with two signature differences, both forced by
 * facts that design.md's sketch predates.
 *
 * - `fetchPages` takes the Tenant identifier. The transport authenticates with the
 *   Tenant's own Razorpay credential, so there is no Tenant-free way to obtain a client.
 * - `fetchPages` yields the transport's three-variant union rather than bare
 *   `RazorpayObject[]`, and `upsertObject` takes the object type. A `RazorpayObject` is an
 *   unmodelled JSON object (Requirement 1.2 stores it verbatim), so its type is not
 *   recoverable from the object itself, and `razorpay_objects.object_type` is `NOT NULL`.
 */
export interface IngestionService {
  /** Create, drive and close one ingestion run. Requirement 1.1 through 1.10. */
  startRun(tenantId: TenantId, actorUserId: string): Promise<IngestionRun>;
  /** The transport's pages for one object type. Internal; exposed for 6.5 and 6.6. */
  fetchPages(
    tenantId: TenantId,
    type: IngestedObjectType,
    window: TimeWindow,
    options?: FetchOptions,
  ): AsyncIterable<RazorpayFetchResult>;
  /**
   * Project and upsert one object (Requirement 1.2, 1.3). Not used by {@link startRun},
   * which stages the whole run and commits once — see the module doc comment.
   */
  upsertObject(
    tenantId: TenantId,
    runId: string,
    objectType: IngestedObjectType,
    object: RazorpayObject,
  ): Promise<void>;
}

export interface IngestionServiceDeps {
  readonly store: IngestionStore;
  /**
   * The transport. A function is resolved per run, which is how the Tenant's credential
   * is fetched without holding plaintext for the life of the service; see
   * `./razorpay-credential`.
   */
  readonly client: RazorpayClient | ((tenantId: TenantId) => Promise<RazorpayClient>);
  /** Realtime. Optional: a run must not fail because the UI transport is down. */
  readonly publisher?: IngestionRunPublisher;
  readonly now?: () => Date;
}

function emptyPerType<T>(make: () => T): Record<IngestedObjectType, T> {
  const out = {} as Record<IngestedObjectType, T>;
  for (const type of INGESTED_OBJECT_TYPES) {
    out[type] = make();
  }
  return out;
}

/** `transfer_reversal` is only reachable per transfer, so transfers must come first. */
function assertTraversalOrder(): void {
  const transferAt = INGESTED_OBJECT_TYPES.indexOf('transfer');
  const reversalAt = INGESTED_OBJECT_TYPES.indexOf('transfer_reversal');
  if (transferAt === -1 || reversalAt === -1 || transferAt > reversalAt) {
    throw new Error(
      `INGESTED_OBJECT_TYPES must list 'transfer' before 'transfer_reversal': reversals ` +
        `are only addressable under their parent transfer.`,
    );
  }
}

export function createIngestionService(deps: IngestionServiceDeps): IngestionService {
  const { store } = deps;
  const clock = deps.now ?? (() => new Date());

  const clientFor = async (tenantId: TenantId): Promise<RazorpayClient> =>
    typeof deps.client === 'function' ? await deps.client(tenantId) : deps.client;

  /**
   * The requests one object type needs.
   *
   * Three shapes, and the two awkward ones are the reason this is a plan rather than a
   * single call:
   *
   * - `transfer_reversal` has no account-wide collection; it is addressable only as
   *   `/v1/transfers/{id}/reversals`, so it is one traversal per transfer identifier seen
   *   while ingesting transfers. No transfers, no requests.
   * - `settlement_recon_report` is addressed by `year` and `month`, not by a window, so it
   *   is one traversal per calendar month the window touches.
   */
  function requestPlan(
    type: IngestedObjectType,
    window: TimeWindow,
    transferIds: readonly string[],
  ): readonly FetchOptions[] {
    if (type === 'transfer_reversal') {
      return transferIds.map((parentId) => ({ parentId }));
    }
    if (type === 'settlement_recon_report') {
      return monthsInWindow(window).map(({ year, month }) => ({ query: { year, month } }));
    }
    return [{}];
  }

  const upsertOne = async (
    tenantId: TenantId,
    runId: string,
    objectType: IngestedObjectType,
    object: RazorpayObject,
  ): Promise<void> => {
    const row = projectRazorpayObject({
      tenantId,
      runId,
      objectType,
      object,
      retrievedAt: clock(),
    });
    await store.upsertObjects([row]);
  };

  return {
    fetchPages(tenantId, type, window, options) {
      return {
        async *[Symbol.asyncIterator]() {
          const client = await clientFor(tenantId);
          yield* client.fetchPages(type, window, options);
        },
      };
    },

    upsertObject: upsertOne,

    async startRun(tenantId, actorUserId) {
      assertTraversalOrder();

      const startedAt = clock();
      // The one read the window needs (Requirement 1.9). Taken before the run row is
      // created, so this run's own `started_at` can never be its own watermark.
      const watermark = parseWatermark(
        store.readWatermark === undefined ? null : await store.readWatermark(tenantId),
      );
      const { window, basis } = resolveWindow(startedAt, watermark);
      const created = await store.createRun({
        tenantId,
        startedAt: startedAt.toISOString(),
        windowFrom: window.from.toISOString(),
        windowBasis: basis,
        initiatedBy: actorUserId,
      });
      const runId = created.id;

      // Staged for the whole run and committed once. See the module doc comment: this is
      // what makes "zero objects stored for an aborted run" structural.
      const staged = new Map<string, RazorpayObjectRow>();
      const errors = emptyPerType<IngestionError[]>(() => []);
      const filtered = emptyPerType<number>(() => 0);
      const transferIds = new Set<string>();
      let aborted: CredentialRejectedFailure | null = null;

      const perTypeStored = (): PerObjectType<number> => {
        const counts = emptyPerType<number>(() => 0);
        for (const row of staged.values()) {
          counts[row.object_type] += 1;
        }
        return Object.freeze(counts);
      };

      const snapshot = (
        status: IngestionStatus,
        failureKind: IngestionFailureKind,
        endedAt: string | null,
      ): IngestionRun =>
        Object.freeze({
          id: runId,
          tenant_id: tenantId,
          started_at: created.startedAt,
          ended_at: endedAt,
          status,
          failure_kind: failureKind,
          window_from: window.from.toISOString(),
          window_basis: basis,
          per_type_stored: perTypeStored(),
          // The per-object-type breakdown Requirement 1.6 asks for and the schema's
          // scalar `per_type_errors INT` cannot hold. See RunCompletion.totalErrors.
          per_type_errors: Object.freeze({ ...errors }),
          per_type_window_filtered: Object.freeze({ ...filtered }),
        });

      /** Best effort: a Realtime failure must not change what a run stores. */
      const publish = async (
        change: IngestionRunChange,
        run: IngestionRun,
        objectType: IngestedObjectType | null,
      ): Promise<void> => {
        if (deps.publisher === undefined) {
          return;
        }
        try {
          await deps.publisher.publish({
            change,
            run,
            objectType,
            at: clock().toISOString(),
          });
        } catch {
          // Deliberately swallowed. The Control_Tower re-reads `ingestion_runs` on
          // reconnect, so a dropped notification costs a refresh, not correctness.
        }
      };

      /**
       * Record and continue (Requirement 1.4). The parameter type is
       * {@link RecordableRazorpayFailure} deliberately: `abortsRun: true` is not
       * assignable to `abortsRun?: undefined`, so handing a credential rejection to the
       * record-and-continue path is a compile error rather than a review comment.
       */
      const recordFailure = (failure: RecordableRazorpayFailure): void => {
        errors[failure.objectType].push({
          objectType: failure.objectType,
          errorCode: failure.errorCode,
          errorCategory: failure.category,
          retryCount: failure.retryCount,
          requestedAt: failure.requestedAt,
        });
      };

      const recordCredentialRejection = (failure: CredentialRejectedFailure): void => {
        errors[failure.objectType].push({
          objectType: failure.objectType,
          errorCode: failure.errorCode,
          errorCategory: failure.category,
          retryCount: failure.retryCount,
          requestedAt: failure.requestedAt,
        });
      };

      const recordObjectError = (
        objectType: IngestedObjectType,
        errorCode: string,
        requestedAt: Date,
      ): void => {
        errors[objectType].push({
          objectType,
          errorCode,
          errorCategory: 'provider_error',
          retryCount: 0,
          requestedAt: requestedAt.toISOString(),
        });
      };

      const stage = (row: RazorpayObjectRow, retrievedAt: Date): void => {
        const existing = staged.get(row.razorpay_id);
        if (existing !== undefined && existing.object_type !== row.object_type) {
          // See IDENTIFIER_COLLISION_ERROR_CODE. Earlier row wins, later one is recorded.
          recordObjectError(row.object_type, IDENTIFIER_COLLISION_ERROR_CODE, retrievedAt);
          return;
        }
        // Same type: the latest retrieval wins, matching the upsert's own rule.
        staged.set(row.razorpay_id, row);
      };

      await publish('run_started', snapshot('in_progress', null, null), null);

      const client = await clientFor(tenantId);

      for (const type of INGESTED_OBJECT_TYPES) {
        if (aborted !== null) {
          // Requirement 1.10: no further object types are requested.
          break;
        }

        for (const options of requestPlan(type, window, [...transferIds])) {
          if (aborted !== null) {
            break;
          }

          for await (const result of client.fetchPages(type, window, options)) {
            if (result.kind === 'credential_rejected') {
              recordCredentialRejection(result.failure);
              aborted = result.failure;
              break;
            }
            if (result.kind === 'object_type_failed') {
              // Requirement 1.4: recorded, and the run carries on with the next type.
              recordFailure(result.failure);
              break;
            }

            const retrievedAt = clock();
            for (const object of result.objects) {
              if (type === 'transfer') {
                // Collected before the window filter, so a reversal created inside the
                // window on an older transfer is still reachable.
                try {
                  transferIds.add(extractRazorpayId('transfer', object));
                } catch {
                  // The projection below records the missing identifier exactly once.
                }
              }

              if (!result.windowApplied) {
                // Requirement 1.8 for the four types the API will not filter for us.
                let createdAt: Date;
                try {
                  createdAt = extractCreatedAt(object);
                } catch (cause) {
                  if (cause instanceof ObjectProjectionError) {
                    recordObjectError(type, cause.code, retrievedAt);
                    continue;
                  }
                  throw cause;
                }
                if (!withinWindow(createdAt, window)) {
                  filtered[type] += 1;
                  continue;
                }
              }

              try {
                stage(
                  projectRazorpayObject({
                    tenantId,
                    runId,
                    objectType: type,
                    object,
                    retrievedAt,
                  }),
                  retrievedAt,
                );
              } catch (cause) {
                if (cause instanceof ObjectProjectionError) {
                  recordObjectError(type, cause.code, retrievedAt);
                  continue;
                }
                throw cause;
              }
            }
          }
        }

        if (aborted === null) {
          await publish(
            'object_type_completed',
            snapshot('in_progress', null, null),
            type,
          );
        }
      }

      // ---- commit phase -----------------------------------------------------
      // The only place `razorpay_objects` is written. On the abort path it is skipped
      // entirely, so no statement touches a previously stored object (Requirement 1.10).
      const errorList = INGESTED_OBJECT_TYPES.flatMap((type) => errors[type]);
      try {
        if (aborted === null && staged.size > 0) {
          await store.upsertObjects([...staged.values()]);
        }
        if (errorList.length > 0) {
          await store.recordErrors(tenantId, runId, errorList);
        }
      } catch (cause) {
        // A storage fault, not a Razorpay outcome. Close the run rather than leaving it
        // `in_progress` forever, then let the caller see the real failure.
        await store
          .completeRun({
            tenantId,
            runId,
            endedAt: clock().toISOString(),
            status: 'failed',
            failureKind: null,
            perTypeStored: perTypeStored(),
            totalErrors: errorList.length,
          })
          .catch(() => undefined);
        throw cause;
      }

      const stored = perTypeStored();
      const storedCount = staged.size;
      const outcome = deriveRunOutcome({
        storedCount: aborted === null ? storedCount : 0,
        errorCount: errorList.length,
        credentialRejected: aborted !== null,
      });
      const endedAt = clock().toISOString();

      await store.completeRun({
        tenantId,
        runId,
        endedAt,
        status: outcome.status,
        failureKind: outcome.failureKind,
        // An aborted run stored nothing, so every count is zero.
        perTypeStored: aborted === null ? stored : emptyPerType<number>(() => 0),
        totalErrors: errorList.length,
      });

      if (aborted !== null) {
        staged.clear();
      }
      const run = snapshot(outcome.status, outcome.failureKind, endedAt);
      await publish('run_completed', run, null);
      return run;
    },
  };
}
