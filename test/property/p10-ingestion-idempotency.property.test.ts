// Feature: financeos-control-tower, Property 10: Ingestion idempotency — for all generated
// Razorpay object sets, re-ingesting the same set yields exactly one `razorpay_objects` row
// per `(tenant_id, razorpay_id)` pair, that row's payload equals the most recently retrieved
// payload, and `retrieved_at` is non-decreasing across passes for every row.
//
// **Validates: Requirements 1.2, 1.3**
//
// WHY THIS FILE IS IN THE `property` PROJECT AND NOT IN `db`
// ---------------------------------------------------------
// It needs Postgres — `razorpay_objects_tenant_rzp_uniq` is the constraint P10 exists to
// prove, and a fake store would prove nothing — but it is collected by the `property`
// project (`test/property/**/*.test.ts`) for two reasons. design.md's CI stage 8 owns
// "Property tests P1–P15", so P10 belongs with P11 and P12; and the `db` project caps
// `testTimeout` at 60 s, which 100 database-backed iterations cannot fit, while `property`
// allows 300 s and already runs with `fileParallelism: false`, which is exactly what a
// suite that commits rows against one local Postgres needs. The database is reached through
// `test/db/pg.ts` — the same `psql`-in-the-container harness the `db` suite uses — and the
// whole describe block is gated on `database().reachable`, so the file is a clean skip
// wherever the local stack is down.
//
// ITERATIONS AND SEED
// -------------------
// design.md raises `numRuns` to 1000 only for P1, P3, P11 and P12; P10 takes the stated
// minimum of 100. That is honoured here rather than reduced: one iteration is ~10 `psql`
// sessions at ~110 ms each, so 100 iterations land inside the 300 s bound. The seed is
// explicit, per design.md's "seed and record" rule.
//
// STATE RESET: COMMITTED AND DELETED, NOT ROLLED BACK
// --------------------------------------------------
// design.md suggests a per-iteration transaction rollback. That is not available here: the
// property spans two ingestion passes, each of which is several separate `psql` sessions
// (the harness opens a connection per script), so a transaction cannot span the thing under
// test. The rows are therefore committed — which is what makes the cross-pass assertions
// mean anything — and deleted at the end of every iteration, with the read and the delete
// folded into one session. `afterAll` removes the fixture.
//
// THE JSONB NORMALISATION HAZARD, HANDLED RATHER THAN ASSUMED AWAY
// ---------------------------------------------------------------
// P10's statement says the stored payload is "byte-identical" to the retrieved one. Against
// `JSONB` that is not achievable, and the gap is the storage engine's, not this code's.
// Probed against this Postgres:
//
//   - **Key order is discarded.** `{"plain":"ascii","n":1}` comes back as
//     `{"n": 1, "plain": "ascii"}`. So the comparison is `toEqual` over the **parsed**
//     structure, never over text. This is the honest reading of Requirement 1.2's
//     "unmodified": the value is unmodified, its serialisation is not preserved.
//   - **Duplicate keys are silently reduced to the last.** `{"k":1,"k":2}` stores as
//     `{"k": 2}`. Not reachable from a generator that builds JS objects (a JS object cannot
//     hold a repeated key), so it is excluded structurally rather than by a filter.
//   - **`\u0000` is rejected outright** — `unsupported Unicode escape sequence, \u0000
//     cannot be converted to text`. A payload carrying a NUL in a string cannot be stored
//     at all, so it is excluded from the generator. **This is a finding against
//     Requirement 1.2**: "stores the payload unmodified" is unachievable for that one
//     shape, and today the failure would surface as a raw storage error rather than a
//     recorded `ingestion_errors` row. Razorpay is not expected to emit a NUL, so nothing
//     is worked around here; it is reported.
//   - **Lone surrogates are rejected** (`Unicode low surrogate must follow a high
//     surrogate`), so the text generator draws from a curated unicode unit set rather than
//     from raw code points, which cannot emit an unpaired surrogate.
//   - **Numbers are preserved exactly**, including scale and exponent form: `1.50` stays
//     `1.50`, `1e+21` and `1e-7` round-trip. `numeric` is arbitrary precision, so no
//     tolerance is needed and none is used. `-0` is excluded, and the reason is JSON rather
//     than Postgres: `JSON.stringify(-0)` emits `0`, so the sign is lost before the
//     database is involved.
//
// THE RECON-LINE IDENTIFIER COLLISION, AND HOW THIS PROPERTY READS IT
// ------------------------------------------------------------------
// A combined settlement recon report line keys on `entity_id`, which is the identifier of
// the settled entity — a payment or a refund — so a recon line and its payment contend for
// one `(tenant_id, razorpay_id)` row. Task 6.2 reported this. The generator draws every
// identifier from a six-value pool precisely so the collision is common rather than rare.
//
// This property's reading: **the row is last-write-wins, and the count is by distinct
// identifier regardless of object type.** That is what the constraint guarantees and all it
// guarantees. So the expected state is computed from the rules 6.2 documents rather than
// asserted to be collision-free:
//
//   - within one run the earlier staged row wins and the later object of a different type
//     is recorded under `IDENTIFIER_COLLIDES_WITH_OTHER_TYPE`, so it contributes no row;
//   - a later object of the *same* type replaces the earlier one, matching the upsert;
//   - across statements the upsert replaces, so the last write wins.
//
// A collision therefore never adds a row, which is the guarantee under test. It does lose a
// source record, which is 6.2's reported schema finding — unique on
// `(tenant_id, object_type, razorpay_id)` would fix it — and not something this property can
// or should assert away.
//
// NOT VACUOUS
// -----------
// Checked by falsification: comparing the stored payload against the **first** pass instead
// of the second fails on the first iteration and shrinks to a two-object set — one
// `credit_note` and one `payment` sharing `rzp_p10_a` — which is both the mutation being
// caught and evidence that the collision path and the `credit_note` path are reached. No
// regression test is committed for it: the counterexample was produced by deliberately
// breaking the assertion, not by a defect in the system.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  createIngestionService,
  RAZORPAY_ID_FIELD,
  type IngestionStore,
  type RazorpayObjectRow,
} from '@/ingestion/ingestion-service';
import {
  RAZORPAY_OBJECT_COLUMNS,
  RAZORPAY_OBJECT_UPDATE_COLUMNS,
} from '@/ingestion/ingestion-store';
import {
  INGESTED_OBJECT_TYPES,
  RAZORPAY_OBJECT_TYPES,
  type IngestedObjectType,
  type RazorpayClient,
  type RazorpayFetchResult,
  type RazorpayObject,
  type RazorpayObjectType,
} from '@/ingestion/razorpay-client';
import {
  announceIfUnreachable,
  claims,
  database,
  jsonAt,
  lit,
  newFixture,
  provision,
  runOk,
  runScript,
} from '../db/pg';

announceIfUnreachable();

const f = newFixture();
const reachable = database().reachable;

/** design.md's stated minimum. P10 is not one of the four properties raised to 1000. */
const NUM_RUNS = 100;

/** Explicit and committed, so any counterexample is reproducible from this file alone. */
const SEED = 20260216;

const PARAMS = { numRuns: NUM_RUNS, seed: SEED } as const;

/** The two retrieval instants. Pass two is strictly later, so non-decreasing has teeth. */
const PASS_ONE_AT = '2026-03-01T00:00:00.000Z';
const PASS_TWO_AT = '2026-03-02T00:00:00.000Z';

/** Inside the 365-day window `resolveWindow(PASS_ONE_AT)` derives, in Unix seconds. */
const CREATED_AT_MIN_S = Math.floor(Date.parse('2025-06-01T00:00:00.000Z') / 1000);
const CREATED_AT_MAX_S = Math.floor(Date.parse('2026-02-01T00:00:00.000Z') / 1000);

/** Objects per page, so staging is exercised across page boundaries as well as within one. */
const PAGE_SIZE = 4;

/* -------------------------------------------------------------------------- */
/* Generators                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A deliberately tiny identifier pool. Ten object types drawing from six identifiers is
 * what makes duplicates — and same-identifier-different-type collisions — the common case
 * rather than a rare one.
 */
const ID_POOL = ['rzp_p10_a', 'rzp_p10_b', 'rzp_p10_c', 'rzp_p10_d', 'rzp_p10_e', 'rzp_p10_f'];

/**
 * Which payload field carries the identifier, for all ten enum labels.
 *
 * The nine ingested types come from {@link RAZORPAY_ID_FIELD}, so a change there is picked
 * up here rather than duplicated — including `settlement_recon_report`'s `entity_id`, which
 * is the whole point of reading the field from the map instead of hardcoding `id`.
 * `credit_note` is not an ingestion type (it arrives on the compliance path) and keys on
 * `id`.
 */
const ID_FIELD: Readonly<Record<RazorpayObjectType, string>> = Object.freeze({
  ...RAZORPAY_ID_FIELD,
  credit_note: 'id',
});

/**
 * Unicode units for generated strings. Curated rather than drawn from raw code points:
 * a code-point generator can emit an unpaired surrogate, which `JSONB` rejects. Covers
 * Devanagari, CJK, Arabic (RTL), a combining mark, emoji, the rupee sign, and the three
 * characters that have to survive escaping — quote, backslash, and control characters.
 * `\u0000` is absent on purpose: see the header.
 */
const TEXT_UNITS = [
  'a',
  'Z',
  '7',
  ' ',
  '_',
  '"',
  '\\',
  '\t',
  '\n',
  'é',
  'e\u0301',
  'ने',
  'नमस्ते',
  '日',
  '語',
  'م',
  'ر',
  '🧾',
  '💸',
  '₹',
];

const arbitraryText = fc.string({
  unit: fc.constantFrom(...TEXT_UNITS),
  minLength: 0,
  maxLength: 6,
});

/**
 * JSON numbers, integers plus a curated set of decimals and extreme exponents. `numeric`
 * preserves all of them exactly, so the assertion needs no tolerance. `-0` is excluded —
 * `JSON.stringify(-0)` is `0`, so the sign is lost in JavaScript, not in Postgres.
 */
const arbitraryNumber = fc.oneof(
  fc.integer({ min: -10_000, max: 10_000 }),
  fc.constantFrom(0.5, -1.5, 1e21, 1e-7, 12_345.678_9, 1.000_000_000_1),
);

const arbitraryLeaf: fc.Arbitrary<unknown> = fc.oneof(
  arbitraryText,
  arbitraryNumber,
  fc.boolean(),
  fc.constant(null),
);

/** Keys disjoint from every field the projection reads, so extras can never shadow one. */
const EXTRA_KEYS = ['notes', 'meta', 'labels', 'tags', 'description', 'ünïcode', '日本語'];

/**
 * An object built from key/value pairs rather than `fc.dictionary`, so the key set is
 * exactly {@link EXTRA_KEYS} and repeated draws collapse the way a JS object does.
 */
function objectOf(value: fc.Arbitrary<unknown>): fc.Arbitrary<Readonly<Record<string, unknown>>> {
  return fc
    .array(fc.tuple(fc.constantFrom(...EXTRA_KEYS), value), { minLength: 0, maxLength: 4 })
    .map((entries) => Object.freeze(Object.fromEntries(entries)));
}

/** design.md's `arbitraryJsonPayload`: nested objects, unicode strings, and empty arrays. */
const arbitraryPayloadValue: fc.Arbitrary<unknown> = fc.oneof(
  { arbitrary: arbitraryLeaf, weight: 4 },
  { arbitrary: fc.constant([]), weight: 2 },
  { arbitrary: fc.array(arbitraryLeaf, { minLength: 1, maxLength: 3 }), weight: 2 },
  { arbitrary: objectOf(arbitraryLeaf), weight: 3 },
);

const arbitraryExtras = objectOf(arbitraryPayloadValue);

interface ObjectSpec {
  readonly type: RazorpayObjectType;
  readonly id: string;
  readonly createdAtSeconds: number;
  readonly amountValue: number;
  readonly feeValue: number;
  readonly gstValue: number;
  readonly statusText: string | undefined;
  readonly extras: Readonly<Record<string, unknown>>;
  /** Present when the second pass re-retrieves this object with a changed payload. */
  readonly mutation: Readonly<Record<string, unknown>> | undefined;
}

const arbitraryObjectSpec: fc.Arbitrary<ObjectSpec> = fc.record({
  type: fc.constantFrom(...RAZORPAY_OBJECT_TYPES),
  id: fc.constantFrom(...ID_POOL),
  createdAtSeconds: fc.integer({ min: CREATED_AT_MIN_S, max: CREATED_AT_MAX_S }),
  amountValue: fc.integer({ min: 0, max: 5_000_000 }),
  feeValue: fc.integer({ min: 0, max: 50_000 }),
  gstValue: fc.integer({ min: 0, max: 9_000 }),
  statusText: fc.option(fc.constantFrom('captured', 'processed', 'failed', 'refunded'), {
    nil: undefined,
  }),
  extras: arbitraryExtras,
  // Shape discriminator last, per design.md's shrinking note.
  mutation: fc.option(arbitraryExtras, { nil: undefined }),
});

/** design.md's `arbitraryRazorpayObjectSet`. */
const arbitraryRazorpayObjectSet = fc.array(arbitraryObjectSpec, {
  minLength: 1,
  maxLength: 12,
});

/**
 * One retrieved object. The identifier goes in under the field its own type is read from,
 * so a `settlement_recon_report` carries `entity_id` and everything else carries `id`.
 * Extras are spread first, so a reserved field can never be shadowed by a generated key.
 */
function payloadOf(spec: ObjectSpec, pass: 1 | 2): RazorpayObject {
  const mutating = pass === 2 && spec.mutation !== undefined;
  const object: Record<string, unknown> = {
    ...spec.extras,
    ...(mutating ? spec.mutation : {}),
    entity: spec.type,
    created_at: spec.createdAtSeconds,
    currency: 'INR',
    // A visible change on the second pass, so "the most recently retrieved payload" is
    // distinguishable from the first one.
    amount: mutating ? spec.amountValue + 1 : spec.amountValue,
    fee: spec.feeValue,
    tax: spec.gstValue,
  };
  if (spec.statusText !== undefined) {
    object.status = spec.statusText;
  }
  object[ID_FIELD[spec.type]] = spec.id;
  return Object.freeze(object);
}

/* -------------------------------------------------------------------------- */
/* A psql-backed IngestionStore                                               */
/* -------------------------------------------------------------------------- */

/**
 * The same {@link IngestionStore} shape `test/db/ingestion-run.test.ts` drives, composed
 * from the column lists `src/ingestion/ingestion-store.ts` exports so this path and the
 * PostgREST one cannot drift. Duplicated here rather than imported from that test file:
 * a spec file is not a module other suites should depend on.
 */
const UPSERT_TAIL =
  `on conflict on constraint razorpay_objects_tenant_rzp_uniq do update set ` +
  RAZORPAY_OBJECT_UPDATE_COLUMNS.map((column) => `${column} = excluded.${column}`).join(', ');

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

function upsert(values: readonly string[]): void {
  runOk(
    `${claims(f)}
insert into razorpay_objects (${RAZORPAY_OBJECT_COLUMNS.join(', ')})
values ${values.join(',\n       ')}
${UPSERT_TAIL};`,
  );
}

function psqlStore(): IngestionStore {
  return {
    async createRun(run) {
      const r = runOk(
        `${claims(f)}
insert into ingestion_runs
  (tenant_id, started_at, status, window_from, window_basis, initiated_by)
values (${lit(run.tenantId)}, ${lit(run.startedAt)}, 'in_progress',
        ${lit(run.windowFrom)}, ${lit(run.windowBasis)}, ${lit(run.initiatedBy)})
returning to_jsonb(id)::text;`,
      );
      return { id: jsonAt<string>(r, 0), startedAt: run.startedAt };
    },

    async upsertObjects(rows) {
      if (rows.length === 0) {
        return;
      }
      upsert(rows.map(rowValues));
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

/**
 * `credit_note` rows, written straight through the same upsert statement.
 *
 * The tenth enum label is **not** an ingestion type — it arrives from the compliance path
 * (see `INGESTED_OBJECT_TYPES`) — so `createIngestionService` cannot retrieve one and
 * `projectRazorpayObject` will not accept one. P10 is a statement about the storage
 * guarantee, which is the same constraint and the same `ON CONFLICT` clause whichever path
 * writes the row, so these rows go in directly rather than being left out of the property.
 * The three monetary projections are `NULL`: no projection for `credit_note` exists yet, and
 * inventing one here would test this file rather than the system.
 *
 * Deduplicated on the identifier, keeping the last: one `ON CONFLICT DO UPDATE` statement
 * cannot affect the same row twice, so a repeated identifier inside one batch is a runtime
 * error rather than an overwrite — the same rule `IngestionStore.upsertObjects` documents.
 */
function upsertCreditNotes(
  runId: string,
  retrievedAt: string,
  notes: ReadonlyMap<string, RazorpayObject>,
): void {
  if (notes.size === 0) {
    return;
  }
  const values = [...notes].map(([id, payload]) => {
    const status = typeof payload.status === 'string' ? lit(payload.status) : 'null';
    const createdAt = new Date(Number(payload.created_at) * 1000).toISOString();
    return (
      `(${lit(f.tenantId)}, ${lit(id)}, 'credit_note'::razorpay_object_type, ${lit(runId)}, ` +
      `${lit(retrievedAt)}, ${lit(createdAt)}, null, null, null, 'INR', ${status}, ` +
      `${lit(JSON.stringify(payload))}::jsonb)`
    );
  });
  upsert(values);
}

/* -------------------------------------------------------------------------- */
/* A scripted transport                                                       */
/* -------------------------------------------------------------------------- */

function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const pages: T[][] = [];
  for (let at = 0; at < items.length; at += size) {
    pages.push(items.slice(at, at + size));
  }
  return pages;
}

function specsOf(specs: readonly ObjectSpec[], type: RazorpayObjectType): readonly ObjectSpec[] {
  return specs.filter((spec) => spec.type === type);
}

/**
 * The generated set, served per object type in generation order.
 *
 * Every page declares `windowApplied: true`. Generated `created_at` values are all inside
 * the window anyway, so the run's own window filter would be a no-op either way; the
 * declaration keeps the property about storage identity rather than about window
 * arithmetic, which is task 6.2's and is asserted in its own tests.
 *
 * Objects are served on the **first** request for a type only. Two types are requested more
 * than once — `settlement_recon_report` once per calendar month in the window, and
 * `transfer_reversal` once per parent transfer — and re-serving the same objects on every
 * one of those requests would be the stub inventing duplicates rather than the property
 * finding them.
 */
function scriptedClient(specs: readonly ObjectSpec[], pass: 1 | 2): RazorpayClient {
  const served = new Set<IngestedObjectType>();
  return {
    fetchPages(type) {
      const first = !served.has(type);
      served.add(type);
      const objects: readonly RazorpayObject[] = first
        ? specsOf(specs, type).map((spec) => payloadOf(spec, pass))
        : [];
      const chunked = chunk(objects, PAGE_SIZE);
      // One empty page rather than no page at all, which is what the real transport does
      // for a type with no records.
      const pages: readonly (readonly RazorpayObject[])[] = chunked.length === 0 ? [[]] : chunked;
      const results: readonly RazorpayFetchResult[] = pages.map((page, pageIndex) => ({
        kind: 'page',
        objectType: type,
        pageIndex,
        objects: page,
        windowApplied: true,
      }));
      return {
        async *[Symbol.asyncIterator]() {
          yield* results;
        },
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The expected state, from the rules task 6.2 documents                      */
/* -------------------------------------------------------------------------- */

/**
 * A `transfer_reversal` is addressable only as `/v1/transfers/{id}/reversals`, so with no
 * transfer in the set the run issues no request for reversals and they are never retrieved.
 * That is a transport reachability fact, not a storage one, so the expected identifier set
 * excludes them.
 */
function retrievableSpecs(specs: readonly ObjectSpec[]): readonly ObjectSpec[] {
  const hasTransfer = specsOf(specs, 'transfer').length > 0;
  return specs.filter((spec) => spec.type !== 'transfer_reversal' || hasTransfer);
}

/** Distinct `razorpay_id` values over the objects the run can actually retrieve. */
function distinctRazorpayIds(specs: readonly ObjectSpec[]): ReadonlySet<string> {
  return new Set(retrievableSpecs(specs).map((spec) => spec.id));
}

/** The `credit_note` payloads for a pass, deduplicated on the identifier, last wins. */
function creditNotesOf(
  specs: readonly ObjectSpec[],
  pass: 1 | 2,
): ReadonlyMap<string, RazorpayObject> {
  const notes = new Map<string, RazorpayObject>();
  for (const spec of specsOf(specs, 'credit_note')) {
    notes.set(spec.id, payloadOf(spec, pass));
  }
  return notes;
}

/**
 * The payload expected under each identifier after one pass.
 *
 * Replays the staging rules rather than assuming a collision-free set: types in traversal
 * order, an earlier row of a different type wins and the later object is recorded as an
 * error, a later object of the same type replaces, and the `credit_note` statement runs
 * afterwards so it replaces whatever the run stored under that identifier.
 */
function expectedPayloads(
  specs: readonly ObjectSpec[],
  pass: 1 | 2,
): ReadonlyMap<string, RazorpayObject> {
  const hasTransfer = specsOf(specs, 'transfer').length > 0;
  const staged = new Map<string, { readonly type: RazorpayObjectType; payload: RazorpayObject }>();

  for (const type of INGESTED_OBJECT_TYPES) {
    if (type === 'transfer_reversal' && !hasTransfer) {
      continue;
    }
    for (const spec of specsOf(specs, type)) {
      const existing = staged.get(spec.id);
      if (existing !== undefined && existing.type !== type) {
        continue; // IDENTIFIER_COLLIDES_WITH_OTHER_TYPE: the earlier row keeps the row.
      }
      staged.set(spec.id, { type, payload: payloadOf(spec, pass) });
    }
  }

  const expected = new Map<string, RazorpayObject>();
  for (const [id, row] of staged) {
    expected.set(id, row.payload);
  }
  for (const [id, payload] of creditNotesOf(specs, pass)) {
    expected.set(id, payload);
  }
  return expected;
}

/* -------------------------------------------------------------------------- */
/* Reading and resetting                                                      */
/* -------------------------------------------------------------------------- */

interface StoredRow {
  readonly razorpay_id: string;
  readonly object_type: string;
  /** ISO-8601 with offset: `to_jsonb(timestamptz)` emits that form. */
  readonly retrieved_at: string;
  readonly payload: unknown;
}

/** FK order: objects and errors reference the run. */
const DELETE_ITERATION = `delete from razorpay_objects where tenant_id = ${lit(f.tenantId)};
delete from ingestion_errors where tenant_id = ${lit(f.tenantId)};
delete from ingestion_runs where tenant_id = ${lit(f.tenantId)};`;

/**
 * Every stored row for the Tenant, optionally deleting them in the same session so a
 * finished iteration costs one round trip rather than two.
 *
 * `payload` comes back as `jsonb`, so what is compared is the parsed structure. `retrieved_at`
 * is handed to `to_jsonb` rather than `::text` because the JSON form is ISO-8601 and parses
 * unambiguously.
 */
function readStored(reset: boolean): readonly StoredRow[] {
  const r = runOk(
    `${claims(f)}
select coalesce(jsonb_agg(jsonb_build_object(
         'razorpay_id', razorpay_id,
         'object_type', object_type::text,
         'retrieved_at', retrieved_at,
         'payload', payload)), '[]'::jsonb)::text
from razorpay_objects where tenant_id = ${lit(f.tenantId)};
${reset ? DELETE_ITERATION : ''}`,
  );
  return jsonAt<readonly StoredRow[]>(r, 0);
}

function byId(rows: readonly StoredRow[]): ReadonlyMap<string, StoredRow> {
  return new Map(rows.map((row) => [row.razorpay_id, row]));
}

/* -------------------------------------------------------------------------- */
/* One iteration                                                              */
/* -------------------------------------------------------------------------- */

type Attempt<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/** Nothing inside an `attempt` asserts, so a failed assertion is never mistaken for a fault. */
async function attempt<T>(fn: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** One ingestion pass over the generated set, plus the compliance-path `credit_note` rows. */
async function ingestPass(specs: readonly ObjectSpec[], pass: 1 | 2, at: string): Promise<void> {
  const run = await createIngestionService({
    store: psqlStore(),
    client: scriptedClient(specs, pass),
    now: () => new Date(at),
  }).startRun(f.tenantId, f.userId);
  upsertCreditNotes(run.id, at, creditNotesOf(specs, pass));
}

interface Observation {
  readonly afterFirst: readonly StoredRow[];
  readonly afterSecond: readonly StoredRow[];
}

async function bothPasses(specs: readonly ObjectSpec[]): Promise<Observation> {
  await ingestPass(specs, 1, PASS_ONE_AT);
  const afterFirst = readStored(false);
  await ingestPass(specs, 2, PASS_TWO_AT);
  return { afterFirst, afterSecond: readStored(true) };
}

/* -------------------------------------------------------------------------- */
/* The property                                                               */
/* -------------------------------------------------------------------------- */

describe.skipIf(!reachable)('Property 10: ingestion idempotency', () => {
  beforeAll(() => {
    runOk(provision(f));
  });

  afterAll(() => {
    if (!reachable) {
      return;
    }
    runScript(
      `${claims(f)}
${DELETE_ITERATION}
delete from chart_of_accounts where tenant_id = ${lit(f.tenantId)};
delete from audit_sequence_counters where tenant_id = ${lit(f.tenantId)};
delete from tenants where id = ${lit(f.tenantId)};
delete from users where id = ${lit(f.userId)};`,
    );
  });

  it('keeps one row per (tenant_id, razorpay_id), holding the last retrieved payload, with a non-decreasing retrieved_at', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryRazorpayObjectSet, async (specs) => {
        const outcome = await attempt(() => bothPasses(specs));
        if (!outcome.ok) {
          // The rows are committed, so the iteration has to clean up after itself even
          // when the run itself failed, or every later iteration inherits the wreckage.
          runScript(`${claims(f)}\n${DELETE_ITERATION}`);
          throw outcome.error;
        }

        const { afterFirst, afterSecond } = outcome.value;
        const expectedIds = distinctRazorpayIds(specs);
        const lastRetrieved = expectedPayloads(specs, 2);
        const first = byId(afterFirst);
        const second = byId(afterSecond);

        // 1. countRows(tenantId) === countDistinctRazorpayIds(objects). Counted from the
        //    row array, not from the map, so two rows sharing an identifier would fail here
        //    rather than collapsing silently.
        expect(afterSecond.length).toBe(expectedIds.size);
        expect([...second.keys()].sort()).toEqual([...expectedIds].sort());
        // Re-ingesting the same set adds no rows.
        expect(afterFirst.length).toBe(afterSecond.length);

        for (const id of expectedIds) {
          const row = second.get(id);
          // 2. deepEqual(storedPayload, lastRetrievedPayload), over the parsed structure:
          //    JSONB discards key order, so text comparison would fail on a payload it
          //    stored perfectly well. See the header.
          expect(row?.payload).toEqual(lastRetrieved.get(id));

          // 3. retrieved_at is non-decreasing across passes for every row.
          const before = first.get(id);
          expect(before).toBeDefined();
          expect(Date.parse(row?.retrieved_at ?? '')).toBeGreaterThanOrEqual(
            Date.parse(before?.retrieved_at ?? ''),
          );
        }
      }),
      PARAMS,
    );
  });
});
