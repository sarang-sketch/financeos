// Feature: financeos-control-tower, Property 2: Ledger derivation idempotency — for all
// generated Source_Records, deriving Ledger_Entries twice from the same Source_Record creates
// exactly one `ledger_entry_set` per distinct Source_Record ref, creates zero additional
// Ledger_Entries on the second derivation, and leaves every account balance unchanged.
//
// **Validates: Requirements 2.8**
//
// WHAT THIS ADDS OVER `test/db/ledger-derivation-trial-balance.test.ts`
// --------------------------------------------------------------------
// That file (task 8.4) already proves the mechanism on ONE worked example, and this file does
// not restate it. The audit, before writing a line of it:
//
//   1. `{ ok: true, set_id: <retained>, created: false }` on the second derivation.
//      *There:* one Payment, `pay_db_derive`, re-derived once. *Here:* every Source_Record the
//      generators reach — 3 types, 6 fee shapes, amounts from 1 paisa to the `paise_ingested`
//      ceiling, 1..50 records per iteration — and the retained `set_id` is checked against the
//      one the FIRST pass returned **for that same ref**, per record, rather than against a
//      single re-read row.
//   2. 0 additional Ledger_Entries and 0 additional sets.
//      *There:* the counts before and after, for that one Payment. *Here:* the same counts,
//      plus `countSets(tenant) === countDistinctSourceRefs(records) + 1`, which also holds a
//      ref repeated INSIDE one pass to a single set — a case the example file has no shape for.
//   3. Every account balance unchanged.
//      *There:* a map with two known figures in it. *Here:* the same map over an arbitrary
//      committed ledger the first pass built, compared as `Map<string, bigint>`.
//   4. Arrival order.
//      *There:* not a variable — one call, then one more. *Here:* the second pass arrives
//      **shuffled**, so idempotency cannot depend on the sequence.
//   5. Everything else the example file owns stays there and is NOT re-asserted: the IST
//      `entry_date` projection, the recon-report link, `23505` on a *different* constraint, an
//      underivable Transfer, an un-ingested Source_Record, and the whole trial balance. P2
//      asserts Requirement 2.8's three clauses and nothing more.
//
// So the example file owns "the mechanism works, and here is exactly what it looks like"; P2
// owns "and it holds for every Source_Record, in any order, at any multiplicity".
//
// WHY THIS FILE IS IN THE `property` PROJECT AND NOT IN `db`
// ---------------------------------------------------------
// Same reasoning as P1 and P10. The invariant P2 exists to prove IS a database object —
// `ledger_set_derivation_uniq`, `UNIQUE (tenant_id, source_record_type, source_record_id)` on
// `ledger_entry_sets` — so a fake store would prove nothing about it. But design.md's CI stage
// 8 owns "Property tests P1–P15", and the `db` project caps `testTimeout` at 60 s, which 100
// database-backed iterations cannot fit, while `property` allows 300 s and already runs
// `fileParallelism: false`. The database is reached through `test/db/pg.ts`, the same
// `psql`-in-the-container harness the `db` suite uses, and the describe block is gated on
// `database().reachable`, so the file is a clean skip wherever the stack is down.
//
// ISOLATION: A TENANT PER ITERATION, NOT A ROLLBACK — AND WHY design.md's ROLLBACK CANNOT WORK
// -------------------------------------------------------------------------------------------
// design.md prescribes "a per-iteration transaction rollback rather than a truncate" for P2.
// That is not achievable here, and it is worth being precise about why rather than quietly
// substituting something:
//
//   1. **The harness cannot hold one.** `test/db/pg.ts` opens a `psql` session per script, so
//      a transaction cannot span two `postFromSource` calls. P1 could roll back because one
//      `postSet` is one session; P2's subject is two derivations, which is two.
//   2. **Rollback would weaken the thing under test.** The second derivation must be refused
//      by a unique index against a **committed** first set — that is the production shape, and
//      it is what makes "the existing set is retained" mean anything. Two derivations inside
//      one uncommitted transaction would conflict against an uncommitted row instead, which is
//      a different (easier) claim.
//
// So every iteration provisions its own Tenant and commits into it. `ledger_entries` is
// append-only — a committed entry cannot be deleted at all, by anyone, which is exactly what
// task 4.8 proved — so per-iteration cleanup is not available either, and truncation is
// explicitly not wanted. Every count below is therefore scoped to the iteration's own Tenant,
// never global, and one run leaves ~100 Tenants and their sets behind; `npx supabase db reset`
// clears them. **Reported as a design.md gap rather than patched.**
//
// ITERATIONS, SEED, AND COST
// --------------------------
// design.md raises `numRuns` to 1000 only for P1, P3, P11 and P12; P2 takes the stated minimum
// of 100, which is honoured rather than inflated — this suite already spends 151 s on P1.
// One `docker exec psql` session against this container measures ~106 ms (10 sessions in
// 1063 ms). An iteration spends `4 + 2N` sessions: 1 to provision the Tenant, seed its chart
// of accounts, insert its `razorpay_objects` and read them back, 1 to post the baseline set,
// N for the first pass, N for the second, and 2 to read committed state between and after.
// `fc.array(..., { minLength: 1, maxLength: 50 })` draws a mean length of ~6 under fast-check
// 4's default sizing (measured: mean 6.15, p90 11), so the mean iteration is ~16 sessions.
// Measured end to end: **206 s at `numRuns: 100`** (2.06 s per iteration), inside the
// `property` project's 300 s `testTimeout` with ~30% to spare. That headroom is the reason
// `numRuns` is not raised: design.md reserves 1000 for P1, P3, P11 and P12, and P1 alone
// already spends 151 s in this project.
//
// The seed is explicit and committed, per design.md's "seed and record" rule.
//
// THE AMOUNT CEILING IS THE INGESTED ONE, NOT THE PAISE ONE
// --------------------------------------------------------
// P1 draws gross amounts up to `PAISE_MAX` (99999999999999) because it posts drafts it derived
// in memory. P2 cannot: `postFromSource` reads the amounts back out of `razorpay_objects`,
// whose money columns are the `paise_ingested` domain, `0 <= VALUE <= 999999999999`. An amount
// above that could not be stored to derive from in the first place, so the shared generator is
// asked for `maxGrossPaise: PAISE_INGESTED_MAX` — the ceiling the ingestion path actually
// enforces (Requirement 1.7). That is a narrowing of the input space with a reason, not a
// filter that hides failures.
//
// WHERE THE STORED SOURCE_RECORD COMES FROM: ONE PREFETCH, THEN A CACHE
// --------------------------------------------------------------------
// `LedgerStore.findSourceRecord` is served from a map read out of `razorpay_objects` in the
// iteration's provisioning session, using the same query — recon-report subquery included —
// that `test/db/ledger-derivation-trial-balance.test.ts` uses. So the amounts and the
// `created_at_rzp` instant genuinely round-trip through Postgres (`paise_ingested` in, digit
// text out, `decodePaise`, never `Number(...)`), and both passes are guaranteed to derive from
// the identical stored row, which is the premise of the property. Querying per call instead
// would double the session count for a read the example file already covers row by row.
//
// `insertSet` is NOT faked in any part: it writes the set, every entry and every link in one
// real transaction, commits, and then reads back the set carrying this derivation identity in
// the same session — so the duplicate's retained `set_id` costs no extra session. A `23505` is
// accepted as idempotency only when it names `ledger_set_derivation_uniq`, and every other
// error the aborted transaction produced must be `25P02`; anything else throws. A unique
// violation on a different constraint reported as a successful no-op is precisely the fault
// `LEDGER_SET_DERIVATION_UNIQ` exists to make impossible.
//
// THE BALANCE MAP HAS TEETH, AND IS READ FROM THE DATABASE
// -------------------------------------------------------
// "Every account balance is unchanged" over an empty ledger is a statement about two empty
// maps. Every iteration Tenant therefore gets a committed baseline Payment set of its own
// before the property's first pass — 100000 gross, 2360 fee, 424 GST — posted through the same
// `postFromSource` under test. `gst_input_credit` is debited by a Payment and credited by
// nothing, so the map always carries it at 424 paise or more; that is asserted directly, so a
// silently empty or silently null map cannot pass. The map itself is a `Map<string, bigint>`
// of signed `debit − credit` per `account_code`, aggregated in SQL over `ledger_entries` and
// compared with `toEqual` as a Map — never through JSON, which has no `bigint`.
//
// AUDIT SINK: A RECORDING FAKE, DELIBERATELY
// ------------------------------------------
// Requirement 2.8's no-op appends nothing — `ledger_set_rejected` means a write was refused,
// and a successful no-op refused nothing — so this property should see an empty sink, and it
// asserts that. The sink is in-memory for the same reason P1's is: `audit_events` is
// append-only, and `app.append_audit_event_autonomous` is broken on Supabase local
// (`2F003`, task 4.4's to fix). The real `psql` sink is exercised by
// `test/db/ledger-postset.test.ts` and `test/db/ledger-derivation-trial-balance.test.ts`.
//
// NOT VACUOUS
// -----------
// Checked by falsification three times — a database-backed property that never reaches the
// database passes just as greenly as one that does, and the three mutations separate the three
// things this file claims. All three fail after 1 test and shrink 3 times to the same minimal
// counterexample, `[{"type":"refund","refund_id":"rfnd_p1_a","payment_id":"pay_p1_a",
// "entry_date":"2024-01-01","amount_paise":1n}]` in both `records` and `shuffled`: one Refund
// of 1 paisa, the smallest Source_Record that admits a posting at all.
//
//   - **The `duplicate_derivation` contract.** Making the store report the
//     `ledger_set_derivation_uniq` violation as a fresh insert — `{ ok: true, set_id: <the id
//     nothing was written under> }` instead of the duplicate outcome — reports
//     `expected { ok: true, …(2) } to deeply equal { ok: true, …(2) }`, `+ "created": true`
//     against `- "created": false`, with two different `set_id`s.
//   - **The retained `set_id`.** Keeping the duplicate outcome but naming a fresh
//     `randomUUID()` instead of the set read back from `ledger_entry_sets` reports the same
//     `toEqual` failure with `"created": false` on BOTH sides and only the `set_id` differing.
//     So the `set_id` clause is load bearing on its own: the mutation the previous check
//     catches is not the one this check catches.
//   - **The set count, read from the database.** Asserting `2 * countDistinctSourceRefs +
//     BASELINE_SET_COUNT` reports `expected 2 to be 3`. That `2` is `count(*)` over
//     `ledger_entry_sets` for the iteration's Tenant — the baseline set plus the one Refund
//     set — so the count assertion is reading committed rows rather than restating what the
//     service returned.
//
// All three mutations were reverted. No regression test is committed for any of them: the
// counterexamples came from deliberately broken code in the test's own store and assertions,
// not from a defect in the system.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { PAISE_INGESTED_MAX, type Paise } from '@/calc/paise';
import type { Actor } from '@/config/configuration-service';
import {
  ACCOUNT,
  chartOfAccountsSeedRows,
  type PostingSource,
  type SourceRef,
} from '@/ledger/posting-rules';
import {
  type AccountPeriodTotals,
  createSemanticLedger,
  LEDGER_SET_DERIVATION_UNIQ,
  type LedgerAuditEvent,
  type LedgerAuditSink,
  type LedgerSetWrite,
  type LedgerSourceRecord,
  type LedgerStore,
  type LedgerWriteOutcome,
  type SemanticLedger,
} from '@/ledger/semantic-ledger';
import { decodePaise } from '@/wire/paise-wire';
import {
  announceIfUnreachable,
  claims,
  database,
  type Fixture,
  jsonAt,
  jsonRows,
  lit,
  newFixture,
  provision,
  runOk,
  runScript,
} from '../db/pg';
import { sourceRecordArbitrary } from './ledger-generators';

announceIfUnreachable();

const reachable = database().reachable;

/** design.md's stated minimum. P2 is not one of the four properties raised to 1000. */
const NUM_RUNS = 100;

/** Explicit and committed, so any counterexample is reproducible from this file alone. */
const SEED = 20260304;

const PARAMS = { numRuns: NUM_RUNS, seed: SEED } as const;

const ACTOR: Actor = { kind: 'user', id: 'usr_p2_property' };
const NOW = '2026-03-04T00:00:00.000Z';

/** `unique_violation`: `ledger_set_derivation_uniq` rejecting the second derivation. */
const UNIQUE_VIOLATION = '23505';
/** `in_failed_sql_transaction`: the statements after the rejected one, in the aborted tx. */
const IN_FAILED_SQL_TRANSACTION = '25P02';
/** `integrity_constraint_violation`, raised by `assert_ledger_set_balanced()`. */
const INTEGRITY_CONSTRAINT_VIOLATION = '23000';
/** `check_violation`, raised by the immediate `ledger_set_balanced` CHECK. */
const CHECK_VIOLATION = '23514';

/**
 * The baseline Payment every iteration Tenant gets before the property runs, so the balance
 * map is populated by something the property did not write. Its identifier is outside every
 * generator pool, so it never collides with a generated derivation identity.
 */
const BASELINE_PAYMENT_ID = 'pay_p2_baseline';
const BASELINE_AMOUNT_PAISE = 100_000n;
const BASELINE_FEE_PAISE = 2_360n;
const BASELINE_GST_PAISE = 424n;
const BASELINE_CREATED_AT_RZP = '2026-01-31T04:00:00Z';
/** One set per iteration Tenant that is not derived from a generated record. */
const BASELINE_SET_COUNT = 1;

/* -------------------------------------------------------------------------- */
/* Generated Source_Records, as stored Razorpay objects                       */
/* -------------------------------------------------------------------------- */

/**
 * design.md's generator input for P2: `fc.array(arbitrarySourceRecord, { minLength: 1,
 * maxLength: 50 })` plus a shuffled repetition of that same array, so the second derivation
 * arrives in a different order. `shuffledSubarray` with `minLength === maxLength === length`
 * is a full permutation and preserves duplicates, which matters — a repeated `(type, id)` is
 * the case that makes `countDistinctSourceRefs` different from `records.length`.
 */
const arbitraryDerivationRun = fc
  .array(sourceRecordArbitrary({ maxGrossPaise: PAISE_INGESTED_MAX }), {
    minLength: 1,
    maxLength: 50,
  })
  .chain((records) =>
    fc
      .shuffledSubarray(records, { minLength: records.length, maxLength: records.length })
      .map((shuffled) => ({ records, shuffled })),
  );

/** The derivation identity of a Source_Record: the ref `ledger_set_derivation_uniq` keys on. */
function refOf(source: PostingSource): SourceRef {
  switch (source.type) {
    case 'payment':
      return { type: 'payment', id: source.payment_id };
    case 'refund':
      return { type: 'refund', id: source.refund_id };
    case 'settlement':
      return { type: 'settlement', id: source.settlement_id };
    case 'transfer':
      return { type: 'transfer', id: source.transfer_id };
    case 'transfer_reversal':
      return { type: 'transfer_reversal', id: source.transfer_reversal_id };
  }
}

const refKey = (ref: SourceRef): string => `${ref.type}|${ref.id}`;

function countDistinctSourceRefs(records: readonly PostingSource[]): number {
  return new Set(records.map((record) => refKey(refOf(record)))).size;
}

/** One `razorpay_objects` row to stage. Amounts stay `bigint` the whole way to the insert. */
interface RazorpayObjectRow {
  readonly razorpayId: string;
  /** A `razorpay_object_type` label. */
  readonly objectType: string;
  /** An ISO-8601 instant for `created_at_rzp`. */
  readonly createdAtRzp: string;
  readonly amountPaise: Paise | null;
  readonly feePaise: Paise | null;
  readonly gstOnFeePaise: Paise | null;
  /** Merged into `{ id: razorpayId }`, so `payload` is a plausible Razorpay object. */
  readonly payload: Readonly<Record<string, string>>;
}

/**
 * The instant a Source_Record was created at, from the drawn `entry_date`.
 *
 * 04:00 UTC is 09:30 IST on the same date, so the derived set's `entry_date` is the date the
 * generator drew. The IST date-edge case — 19:00 UTC falling on the next IST day — is
 * example-covered by `test/db/ledger-derivation-trial-balance.test.ts` and is deliberately not
 * re-asserted here: P2 is about idempotency, and a generator that moved `entry_date` between
 * passes would be testing the projection instead.
 */
const istMorningOf = (entryDate: string): string => `${entryDate}T04:00:00Z`;

/** The `razorpay_objects` rows a generated Source_Record needs in order to be derivable. */
function objectsFor(source: PostingSource): readonly RazorpayObjectRow[] {
  switch (source.type) {
    case 'payment':
      return [
        {
          razorpayId: source.payment_id,
          objectType: 'payment',
          createdAtRzp: istMorningOf(source.entry_date),
          amountPaise: source.amount_paise,
          feePaise: source.fee_paise,
          gstOnFeePaise: source.gst_on_fee_paise,
          payload: {},
        },
      ];
    case 'refund':
      return [
        {
          razorpayId: source.refund_id,
          objectType: 'refund',
          createdAtRzp: istMorningOf(source.entry_date),
          amountPaise: source.amount_paise,
          feePaise: null,
          gstOnFeePaise: null,
          // Requirement 2.9: the refunded Payment, read from the payload.
          payload: { payment_id: source.payment_id },
        },
      ];
    case 'settlement': {
      const settlement: RazorpayObjectRow = {
        razorpayId: source.settlement_id,
        objectType: 'settlement',
        createdAtRzp: istMorningOf(source.entry_date),
        amountPaise: source.received_amount_paise,
        feePaise: null,
        gstOnFeePaise: null,
        payload: {},
      };
      const reportId = source.settlement_recon_report_id;
      if (reportId === null) {
        return [settlement];
      }
      // Requirement 2.10's report, resolved by `payload->>'settlement_id'` the way the
      // reconciliation path resolves it.
      return [
        settlement,
        {
          razorpayId: reportId,
          objectType: 'settlement_recon_report',
          createdAtRzp: istMorningOf(source.entry_date),
          amountPaise: null,
          feePaise: null,
          gstOnFeePaise: null,
          payload: { settlement_id: source.settlement_id },
        },
      ];
    }
    case 'transfer':
      return [
        {
          razorpayId: source.transfer_id,
          objectType: 'transfer',
          createdAtRzp: istMorningOf(source.entry_date),
          amountPaise: source.amount_paise,
          feePaise: null,
          gstOnFeePaise: null,
          payload: {},
        },
      ];
    case 'transfer_reversal':
      return [
        {
          razorpayId: source.transfer_reversal_id,
          objectType: 'transfer_reversal',
          createdAtRzp: istMorningOf(source.entry_date),
          amountPaise: source.reversed_amount_paise,
          feePaise: null,
          gstOnFeePaise: null,
          payload: {},
        },
      ];
  }
}

/** The baseline Payment's stored row. */
const baselineObject: RazorpayObjectRow = {
  razorpayId: BASELINE_PAYMENT_ID,
  objectType: 'payment',
  createdAtRzp: BASELINE_CREATED_AT_RZP,
  amountPaise: BASELINE_AMOUNT_PAISE,
  feePaise: BASELINE_FEE_PAISE,
  gstOnFeePaise: BASELINE_GST_PAISE,
  payload: {},
};

/**
 * Every row to stage for one iteration, deduplicated by `razorpay_id`.
 *
 * `razorpay_objects_tenant_rzp_uniq` is `UNIQUE (tenant_id, razorpay_id)` (Requirement 1.3),
 * so a repeated identifier is one row and the earlier draw wins — which is also what makes
 * both passes derive from the identical stored record when the generated array repeats a ref
 * with different amounts.
 */
function stagedObjects(records: readonly PostingSource[]): readonly RazorpayObjectRow[] {
  const byId = new Map<string, RazorpayObjectRow>();
  for (const row of [baselineObject, ...records.flatMap(objectsFor)]) {
    if (!byId.has(row.razorpayId)) {
      byId.set(row.razorpayId, row);
    }
  }
  return [...byId.values()];
}

/* -------------------------------------------------------------------------- */
/* SQL                                                                        */
/* -------------------------------------------------------------------------- */

const money = (value: Paise | null): string => (value === null ? 'null' : value.toString());

function razorpayObjectInsert(f: Fixture, row: RazorpayObjectRow): string {
  const payload = JSON.stringify({ id: row.razorpayId, ...row.payload });
  return `insert into razorpay_objects
  (tenant_id, razorpay_id, object_type, ingestion_run_id, created_at_rzp,
   amount_paise, fee_paise, gst_on_fee_paise, payload)
values (${lit(f.tenantId)}, ${lit(row.razorpayId)}, ${lit(row.objectType)}::razorpay_object_type,
        ${lit(f.runId)}, ${lit(row.createdAtRzp)}::timestamptz,
        ${money(row.amountPaise)}, ${money(row.feePaise)}, ${money(row.gstOnFeePaise)},
        ${lit(payload)}::jsonb);`;
}

/**
 * Every stored Source_Record of the Tenant, projected onto {@link LedgerSourceRecord}'s
 * fields. The same query `test/db/ledger-derivation-trial-balance.test.ts` uses, less the
 * per-ref `WHERE`: one read serves the whole iteration.
 *
 * Money leaves as digit text and the recon report is resolved by subquery, so nothing here
 * recomputes an amount and nothing passes through `Number(...)`.
 */
function storedSourceRecordsSelect(f: Fixture): string {
  return jsonRows(
    `select o.object_type::text as type,
            o.razorpay_id as id,
            to_char(o.created_at_rzp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
              as created_at_rzp,
            o.amount_paise::text as amount_paise,
            o.fee_paise::text as fee_paise,
            o.gst_on_fee_paise::text as gst_on_fee_paise,
            o.payload ->> 'payment_id' as refunded_payment_id,
            (select r.razorpay_id from razorpay_objects r
              where r.tenant_id = o.tenant_id
                and r.object_type = 'settlement_recon_report'
                and r.payload ->> 'settlement_id' = o.razorpay_id
              limit 1) as settlement_recon_report_id
       from razorpay_objects o
      where o.tenant_id = ${lit(f.tenantId)}
        and o.object_type <> 'settlement_recon_report'`,
  );
}

interface EntryRow {
  readonly id: string;
  readonly write: LedgerSetWrite['entries'][number];
}

function setInsert(write: LedgerSetWrite, setId: string): string {
  const type =
    write.source_record_type === null
      ? 'null'
      : `${lit(write.source_record_type)}::source_record_type`;
  return `insert into ledger_entry_sets
  (id, tenant_id, entry_date, source_record_type, source_record_id, reverses_set_id,
   entry_count, total_debit_paise, total_credit_paise, created_by)
values (${lit(setId)}, ${lit(write.tenant_id)}, ${lit(write.entry_date)}, ${type},
        ${write.source_record_id === null ? 'null' : lit(write.source_record_id)},
        ${write.reverses_set_id === null ? 'null' : lit(write.reverses_set_id)},
        ${write.entry_count}, ${write.total_debit_paise}, ${write.total_credit_paise},
        ${lit(write.created_by)});`;
}

function entryInserts(write: LedgerSetWrite, setId: string, rows: readonly EntryRow[]): string {
  const values = rows
    .map(
      ({ id, write: entry }) =>
        `(${lit(id)}, ${lit(write.tenant_id)}, ${lit(setId)}, ${lit(entry.account_code)}, ` +
        `${lit(entry.side)}::entry_side, ${entry.amount_paise}, ${lit(entry.entry_date)}, ` +
        `${entry.line_no})`,
    )
    .join(',\n       ');
  return `insert into ledger_entries
  (id, tenant_id, set_id, account_code, side, amount_paise, entry_date, line_no)
values ${values};`;
}

/** One row per (entry, Source_Record ref) pair: at least 1 per entry (Requirement 2.2). */
function sourceInserts(write: LedgerSetWrite, rows: readonly EntryRow[]): string {
  const values = rows.flatMap(({ id, write: entry }) =>
    entry.sources.map(
      (ref) =>
        `(${lit(id)}, ${lit(write.tenant_id)}, ${lit(ref.type)}::source_record_type, ` +
        `${lit(ref.id)})`,
    ),
  );
  return `insert into ledger_entry_sources (entry_id, tenant_id, source_record_type, source_record_id)
values ${values.join(',\n       ')};`;
}

/**
 * The set carrying this derivation identity, as one JSON line: the id just committed, or the
 * **retained** one after a conflict. Issued after the transaction has ended either way, so it
 * costs no extra session and reads committed state in both cases.
 */
function derivedSetIdSelect(write: LedgerSetWrite): string {
  const type =
    write.source_record_type === null
      ? 'null'
      : `${lit(write.source_record_type)}::source_record_type`;
  return `select coalesce(to_jsonb((select id::text from ledger_entry_sets
   where tenant_id = ${lit(write.tenant_id)}
     and source_record_type = ${type}
     and source_record_id = ${write.source_record_id === null ? 'null' : lit(write.source_record_id)})),
  'null'::jsonb)::text;`;
}

/**
 * Signed `debit − credit` per account over every Ledger_Entry of the Tenant, as one JSON line
 * of `{ account_code: "<digits>" }`. Digit text, not a JSON number: `paise_positive` is a
 * `BIGINT` domain and a value near the ceiling would lose precision as a double.
 */
function balanceMapSelect(f: Fixture): string {
  return `select coalesce(jsonb_object_agg(account_code, balance), '{}'::jsonb)::text
from (
  select account_code,
         sum(case when side = 'debit' then amount_paise else -amount_paise end)::text as balance
    from ledger_entries
   where tenant_id = ${lit(f.tenantId)}
   group by account_code) b;`;
}

const entryCountSelect = (f: Fixture): string =>
  `select to_jsonb((select count(*)::int from ledger_entries
 where tenant_id = ${lit(f.tenantId)}))::text;`;

const setCountSelect = (f: Fixture): string =>
  `select to_jsonb((select count(*)::int from ledger_entry_sets
 where tenant_id = ${lit(f.tenantId)}))::text;`;

/* -------------------------------------------------------------------------- */
/* One iteration's Tenant                                                     */
/* -------------------------------------------------------------------------- */

interface StoredRow {
  readonly type: string;
  readonly id: string;
  readonly created_at_rzp: string;
  readonly amount_paise: string | null;
  readonly fee_paise: string | null;
  readonly gst_on_fee_paise: string | null;
  readonly refunded_payment_id: string | null;
  readonly settlement_recon_report_id: string | null;
}

function sourceRecordOf(row: StoredRow): LedgerSourceRecord {
  const paise = (value: string | null): Paise | null =>
    value === null ? null : decodePaise(value);
  return {
    // The three derivable labels are the only `object_type`s staged, so the cast is safe.
    type: row.type as LedgerSourceRecord['type'],
    id: row.id,
    created_at_rzp: row.created_at_rzp,
    amount_paise: paise(row.amount_paise),
    fee_paise: paise(row.fee_paise),
    gst_on_fee_paise: paise(row.gst_on_fee_paise),
    refunded_payment_id: row.refunded_payment_id,
    settlement_recon_report_id: row.settlement_recon_report_id,
  };
}

/**
 * Provision the iteration's Tenant, seed its chart of accounts, stage every
 * `razorpay_objects` row the records need, and read those rows back — one `psql` session.
 *
 * Returns the stored Source_Records, keyed by ref, which is what `findSourceRecord` serves.
 */
function provisionIteration(
  f: Fixture,
  records: readonly PostingSource[],
): ReadonlyMap<string, LedgerSourceRecord> {
  const accounts = chartOfAccountsSeedRows(f.tenantId)
    .map(
      (a) =>
        `(${lit(a.tenant_id)}, ${lit(a.account_code)}, ${lit(a.account_name)}, ` +
        `${lit(a.kind)}::account_kind, ${a.is_active})`,
    )
    .join(',\n       ');

  const r = runOk(
    [
      provision(f),
      `insert into chart_of_accounts (tenant_id, account_code, account_name, kind, is_active)
values ${accounts};`,
      ...stagedObjects(records).map((row) => razorpayObjectInsert(f, row)),
      storedSourceRecordsSelect(f),
    ].join('\n'),
  );

  const stored = new Map<string, LedgerSourceRecord>();
  for (const row of jsonAt<readonly StoredRow[]>(r, 0)) {
    stored.set(refKey({ type: row.type as SourceRef['type'], id: row.id }), sourceRecordOf(row));
  }
  return stored;
}

/* -------------------------------------------------------------------------- */
/* A psql-backed LedgerStore                                                  */
/* -------------------------------------------------------------------------- */

const IMBALANCE_IN_MESSAGE = /imbalance (-?\d+) paise/;

/**
 * The whole set in ONE transaction and ONE session — set row, entry rows, link rows, commit,
 * then the derivation-identity read-back.
 *
 * A rejected statement takes the whole transaction with it, so a duplicate derivation writes
 * nothing: `created: false` and "0 additional Ledger_Entries" are the same fact. The
 * `23505` is matched **by constraint name**; every other error in an aborted transaction must
 * be `25P02`, so a genuine second fault cannot hide behind the expected one.
 */
function psqlStore(f: Fixture, stored: ReadonlyMap<string, LedgerSourceRecord>): LedgerStore {
  return {
    insertSet(write: LedgerSetWrite): Promise<LedgerWriteOutcome> {
      const setId = randomUUID();
      const rows: readonly EntryRow[] = write.entries.map((entry) => ({
        id: randomUUID(),
        write: entry,
      }));

      const r = runScript(
        `begin;
${claims(f)}
${setInsert(write, setId)}
${entryInserts(write, setId, rows)}
${sourceInserts(write, rows)}
commit;
${derivedSetIdSelect(write)}`,
      );
      const derivedSetId = jsonAt<string | null>(r, 0);

      const unique = r.errors.find((e) => e.sqlstate === UNIQUE_VIOLATION);
      if (unique !== undefined) {
        if (unique.constraint !== LEDGER_SET_DERIVATION_UNIQ) {
          throw new Error(
            `unique violation on ${unique.constraint ?? 'an unnamed constraint'}, which is not ` +
              `the derivation identity ${LEDGER_SET_DERIVATION_UNIQ}:\n${r.rawErr}`,
          );
        }
        const unexpected = r.errors.filter(
          (e) => e !== unique && e.sqlstate !== IN_FAILED_SQL_TRANSACTION,
        );
        if (unexpected.length > 0) {
          throw new Error(
            `the rejected derivation raised more than the conflict and its aborted ` +
              `statements:\n${r.rawErr}`,
          );
        }
        if (derivedSetId === null) {
          throw new Error(
            `${LEDGER_SET_DERIVATION_UNIQ} rejected the set but no set carries that ` +
              `derivation identity, so nothing was retained:\n${r.rawErr}`,
          );
        }
        return Promise.resolve({
          ok: false,
          kind: 'duplicate_derivation',
          set_id: derivedSetId,
          constraint: LEDGER_SET_DERIVATION_UNIQ,
        });
      }

      const barrier = r.errors.find(
        (e) => e.sqlstate === INTEGRITY_CONSTRAINT_VIOLATION || e.sqlstate === CHECK_VIOLATION,
      );
      if (barrier !== undefined) {
        const stated = IMBALANCE_IN_MESSAGE.exec(barrier.message);
        return Promise.resolve({
          ok: false,
          kind: 'unbalanced',
          imbalance_paise: stated?.[1] === undefined ? 0n : decodePaise(stated[1]),
        });
      }
      if (r.errors.length > 0) {
        throw new Error(`ledger set insert failed:\n${r.rawErr}`);
      }
      if (derivedSetId !== setId) {
        throw new Error(
          `the set insert reported success but the committed set for this derivation identity ` +
            `is ${String(derivedSetId)}, not ${setId}`,
        );
      }
      return Promise.resolve({ ok: true, set_id: setId });
    },

    findSourceRecord(_tenantId, ref: SourceRef): Promise<LedgerSourceRecord | null> {
      // Read out of `razorpay_objects` in the provisioning session — see the header.
      return Promise.resolve(stored.get(refKey(ref)) ?? null);
    },

    findSet(): Promise<null> {
      return Promise.reject(
        new Error('P2 asserts on derivation identity; findSet is P14 (task 24.2)'),
      );
    },

    trialBalanceTotals(): Promise<readonly AccountPeriodTotals[]> {
      return Promise.reject(
        new Error('P2 asserts on persisted rows; trialBalanceTotals is P13 (task 8.7)'),
      );
    },
  };
}

/** In-memory, and asserted empty: Requirement 2.8's no-op appends nothing. See the header. */
function recordingAuditSink(): LedgerAuditSink & { events: LedgerAuditEvent[] } {
  const sink = {
    events: [] as LedgerAuditEvent[],
    append(event: LedgerAuditEvent): Promise<void> {
      sink.events.push(event);
      return Promise.resolve();
    },
  };
  return sink;
}

/* -------------------------------------------------------------------------- */
/* Reading committed state                                                    */
/* -------------------------------------------------------------------------- */

interface CommittedState {
  /** Signed `debit − credit` per account, as `bigint`. Never JSON, which has no `bigint`. */
  readonly balances: Map<string, bigint>;
  readonly entryCount: number;
  readonly setCount: number;
}

/** The whole committed picture of one Tenant, in one session. */
function readCommittedState(f: Fixture): CommittedState {
  const r = runOk(
    `${claims(f)}
${balanceMapSelect(f)}
${entryCountSelect(f)}
${setCountSelect(f)}`,
  );
  const raw = jsonAt<Readonly<Record<string, string>>>(r, 0);
  return {
    balances: new Map(
      Object.entries(raw).map(([account, balance]) => [account, BigInt(balance)]),
    ),
    entryCount: jsonAt<number>(r, 1),
    setCount: jsonAt<number>(r, 2),
  };
}

/* -------------------------------------------------------------------------- */
/* The property                                                               */
/* -------------------------------------------------------------------------- */

function ledgerOver(store: LedgerStore, audit: LedgerAuditSink): SemanticLedger {
  return createSemanticLedger({ store, audit, actor: ACTOR, now: () => new Date(NOW) });
}

describe.skipIf(!reachable)('Property 2: ledger derivation idempotency', () => {
  it('creates one set per distinct Source_Record, and a second derivation changes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryDerivationRun, async ({ records, shuffled }) => {
        // A Tenant per iteration: `ledger_entries` is append-only and the conflict has to be
        // against committed state, so there is nothing to roll back or delete. See the header.
        const f = newFixture();
        const stored = provisionIteration(f, records);
        const audit = recordingAuditSink();
        const ledger = ledgerOver(psqlStore(f, stored), audit);

        // The committed baseline, so the balance map is populated by something the property
        // did not write.
        expect(
          await ledger.postFromSource(f.tenantId, { type: 'payment', id: BASELINE_PAYMENT_ID }),
        ).toMatchObject({ ok: true, created: true });

        /* -- Pass one: the first derivation of each ref, in generated order -------------- */
        const setIdByRef = new Map<string, string>();
        for (const record of records) {
          const ref = refOf(record);
          const key = refKey(ref);
          const first = !setIdByRef.has(key);
          const result = await ledger.postFromSource(f.tenantId, ref);

          if (!result.ok) {
            throw new Error(
              `a derivable ${ref.type} ${ref.id} was rejected: ${JSON.stringify(result.kind)}`,
            );
          }
          // A ref repeated INSIDE pass one is already a second derivation, which is why the
          // distinct count is what the set count is held to.
          expect(result.created).toBe(first);
          if (first) {
            setIdByRef.set(key, result.set_id);
          } else {
            expect(result.set_id).toBe(setIdByRef.get(key));
          }
        }

        const afterFirst = readCommittedState(f);
        expect(setIdByRef.size).toBe(countDistinctSourceRefs(records));
        expect(afterFirst.setCount).toBe(setIdByRef.size + BASELINE_SET_COUNT);
        // The map cannot be silently empty: only a Payment touches `gst_input_credit` and
        // nothing ever credits it, so the baseline's 424 paise is a floor.
        expect(
          (afterFirst.balances.get(ACCOUNT.GST_INPUT_CREDIT) ?? 0n) >= BASELINE_GST_PAISE,
        ).toBe(true);
        expect(afterFirst.entryCount).toBeGreaterThanOrEqual(4);

        /* -- Pass two: the same records, shuffled --------------------------------------- */
        for (const record of shuffled) {
          const ref = refOf(record);
          // Requirement 2.8: a success with `created: false`, naming the RETAINED set. A
          // different `set_id` would mean a second set exists.
          expect(await ledger.postFromSource(f.tenantId, ref)).toEqual({
            ok: true,
            set_id: setIdByRef.get(refKey(ref)),
            created: false,
          });
        }

        const afterSecond = readCommittedState(f);
        // One set per distinct Source_Record ref, plus the baseline's.
        expect(afterSecond.setCount).toBe(
          countDistinctSourceRefs(records) + BASELINE_SET_COUNT,
        );
        expect(afterSecond.setCount).toBe(afterFirst.setCount);
        // 0 additional Ledger_Entries.
        expect(afterSecond.entryCount).toBe(afterFirst.entryCount);
        // Every account balance unchanged, as a Map<string, bigint>.
        expect(afterSecond.balances).toEqual(afterFirst.balances);
        // A successful no-op refused nothing, so there is nothing to audit.
        expect(audit.events).toEqual([]);
      }),
      PARAMS,
    );
  });
});
