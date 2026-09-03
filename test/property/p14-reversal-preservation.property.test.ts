// Feature: financeos-control-tower, Property 14: Reversal preservation — for all persisted
// Ledger_Entry sets, creating the reversing set leaves every original Ledger_Entry
// byte-identical in account, amount, side, and Source_Record links, and the original and
// reversal together net to exactly 0 paise per account.
//
// **Validates: Requirements 2.4, 5.17**
//
// Requirement 5.17's contribution is the reversing set itself: when an authorized Proposal
// fails at EXECUTE, the Action_Service undoes what it applied "by creating a reversing
// Ledger_Entry set through THE Semantic_Ledger". That reversal is `reverseSet`, so its
// preservation guarantee is the half of 5.17 this property owns. The Proposal-side half —
// marking execution-failed, the Exception, the Audit_Event — is task 23.x's and is not
// asserted here.
//
// WHY THIS FILE IS IN THE `property` PROJECT AND NOT IN `db`
// ---------------------------------------------------------
// design.md: "P1, P2, P7, P13 and P14 run against Supabase local because the invariants they
// assert are database-enforced", and P14's runtime table says "Database-backed, append-only
// enforced". Every claim below is a claim about rows on disk: that the original's rows are
// unchanged after the correction, that `reverses_set_id` names the original, that
// `ledger_set_derivation_uniq` accepts a second reversal of one set because `NULL` is distinct
// in a unique constraint, and that the mirror survived a real `COMMIT` with the
// `DEFERRABLE INITIALLY DEFERRED` balance trigger firing. A fake store proves none of those.
// Task 24.1's `src/ledger/semantic-ledger.reverse.test.ts` already covers the in-memory half —
// which statements were issued, what the drafted write looks like, and every refusal path — so
// this file deliberately does not repeat it. CI stage 8 owns P1–P15, and the `db` project caps
// `testTimeout` at 60 s, which a database-backed property cannot fit; the `property` project
// allows 300 s and runs `fileParallelism: false`, which is what a suite driving one local
// Postgres needs. The database is reached through `test/db/pg.ts` and the whole describe block
// is gated on `database().reachable`, so the file is a clean skip wherever the stack is down.
//
// WHY THIS ONE COMMITS INSTEAD OF ROLLING BACK PER ITERATION
// ---------------------------------------------------------
// design.md's runtime discipline is "a transaction rollback per iteration rather than a
// truncate", and P1, P10 and P13 all follow it. P14 cannot, and the reason is structural
// rather than a preference:
//
//   - `reverseSet` reads the original through `LedgerStore.findSet` and writes the mirror
//     through `LedgerStore.insertSet` — two store calls, and `test/db/pg.ts` opens one `psql`
//     session per script. A separate session cannot see an uncommitted row, so an original
//     that was never committed is invisible to the very read the property exists to exercise.
//     Supplying the original from memory instead would delete the read path from the test.
//   - "Reversing twice yields two independent reversal sets" is a statement about two rows
//     coexisting under `ledger_set_derivation_uniq (tenant_id, source_record_type,
//     source_record_id)`. Both reversals carry `NULL` in both identity columns, and `NULL`
//     being distinct in a unique constraint is exactly what lets the second one land. Two
//     rolled-back transactions never coexist, so that constraint would never be asked the
//     question.
//
// So each iteration commits: the original through production `postSet`, then both reversals
// through production `reverseSet`. The cost is permanent rows — `ledger_entries` is
// append-only, `UPDATE`/`DELETE` are revoked and the `ledger_entries_append_only` trigger
// rejects them for every role, so `npx supabase db reset` is the only way to clear them. That
// cost is accepted here because committing is what makes the property true of disk rather than
// of a transaction: the deferred `ledger_entries_balance_check` fires at a real `COMMIT`, and
// the final read-back runs in a session that shares no transaction with any writer. Every row
// is scoped to this run's fresh Tenant (`newFixture()` draws a new UUID), and every query in
// this file carries that Tenant predicate, so nothing here can perturb another suite's figures.
//
// SESSION BUDGET
// --------------
// `numRuns: 100`, design.md's stated minimum; P14 is not one of the four properties raised to
// 1000. One iteration is 6 `psql` sessions: 1 to insert the original and read it back after
// its `COMMIT`, 2 for the two `findSet` reads, 2 to insert the two reversals, and 1 for the
// verification read that re-reads the original, both reversals and the list of sets pointing
// at the original. A session against this container measures ~142 ms (6 sessions in 853 ms,
// measured directly), so an iteration is ~0.9 s and the property runs in about 90 s — inside
// the `property` project's 300 s bound, next to P1's 151 s. The seed is explicit and
// committed, per design.md's "seed and record" rule.
//
// GENERATORS
// ----------
// design.md's P14 generator note asks for `arbitraryBalancedLedgerSet` "with 2 to 20 entries
// across a generated account set, including sets that post several entries to the same account
// on the same side and sets that post to the same account on both sides". That generator is
// `./balanced-ledger-set-generators.ts` (task 8.7), used unchanged: 1..10 legs of a debit and a
// credit of one amount over a supplied account pool, so `entry_count` spans 2..20 and balance
// holds by construction rather than by filtering. The pool is the production chart of accounts
// (`chartOfAccountsSeedRows`), which is what is seeded into `chart_of_accounts` for the
// `(tenant_id, account_code)` foreign key, and with 6 codes against up to 10 legs both required
// repetition shapes occur densely. Neither is assumed: the coverage test at the bottom counts
// them and fails if either stopped occurring.
//
// Two things are drawn on top of the set. The **derivation identity** is assigned per iteration
// from a counter rather than from a draw — every original is committed and
// `ledger_set_derivation_uniq` is `UNIQUE (tenant_id, source_record_type, source_record_id)`, so
// two iterations sharing an identity would be a spurious failure of the *fixture*. And 0..2
// **extra Source_Record refs** are drawn from a fixed pool, so the reversal's link preservation
// is exercised on sets carrying more than the single identity ref: `reverseSet` leads the
// reversal's refs with `{ ledger_entry_set, <original> }` and follows with the original's own
// refs de-duplicated, and with only one ref there would be nothing to de-duplicate.
//
// WHAT IS ASSERTED, AND AGAINST WHAT
// ----------------------------------
// The snapshot is the original's rows read out of Postgres after its `COMMIT` — the set header
// including `created_at` and `created_by`, every entry with its `line_no`, `account_code`,
// `side`, `amount_paise`, `entry_date` and `created_at`, and every `ledger_entry_sources` row
// under each entry. After both reversals it is re-read by the identical select in a fresh
// session and compared with `toEqual`, so "field by field including source links" is a deep
// equality over rows, not over a draft. Monetary values travel as digit text and become
// `bigint` through `decodePaise`: `paise_positive` is a `BIGINT` domain and a JSON number is a
// double, so a value near `PAISE_MAX` would lose precision as a number (Requirement 15.1, 15.8).
//
// The per-account netting is computed with `netOf` over those read-back rows for both the
// original and each reversal, and asserted `=== 0n` for every account the original touched.
// That is what makes the repetition shapes matter: for an account posted on both sides, or
// posted several times on one side, the netting can only cancel if every entry was mirrored,
// not merely if the totals happened to agree.
//
// NOT VACUOUS
// -----------
// Checked by falsification, twice, because a database-backed property that never reaches the
// database passes just as greenly as one that does. Both mutations were made to production code
// in `src/ledger/semantic-ledger.ts` and both were reverted; no regression test is committed for
// either, because the counterexamples came from deliberately broken code rather than from a
// defect in the system.
//
//   - `reverseSet` keeping the original's designations instead of exchanging them
//     (`side: entry.side`). A set that balanced still balances that way, so no barrier catches
//     it and `postSet` accepts it:
//
//       Error: Property failed after 1 tests
//       { seed: 20260514, path: "0:0:0:0:0:0:0:0", endOnFailure: true }
//       Counterexample: [{"source_refs":[],"entry_date":"2026-05-01","entries":[
//         {"account_code":"bank","side":"debit","amount_paise":1n},
//         {"account_code":"bank","side":"credit","amount_paise":1n}]}]
//       Shrunk 7 time(s)
//       Caused by: AssertionError: expected [ [ 1, 'bank', 'debit', '1' ], …(1) ]
//                  to deeply equal [ [ 1, 'bank', 'credit', '1' ], …(1) ]
//
//     Shrinking converges on the smallest set that exists — one account, 1 paisa, debited and
//     credited — which is exactly design.md's "posts to the same account on both sides" shape,
//     and the one where a naive per-account total check would still have passed. The `'debit'`
//     and the `'1'` in that message are `side::text` and `amount_paise::text` out of a
//     `SELECT`, which is the evidence that the read path is live.
//   - `writeFor` giving a reversal set the original's derivation identity
//     (`const identity = draft.source_refs[0]`, dropping the `reverses_set_id` guard). The
//     first reversal lands; the second one is rejected by the database:
//
//       Caused by: Error: ledger set insert failed:
//       ERROR:  23505: duplicate key value violates unique constraint
//               "ledger_set_derivation_uniq"
//       DETAIL:  Key (tenant_id, source_record_type, source_record_id)=(42d74e0b-…,
//                ledger_entry_set, 8b23287e-…) already exists.
//
//     That is the constraint this file exists to interrogate, rejecting on committed rows, and
//     it is what "a reversal set carries NULL in both identity columns" buys. Note the shape of
//     the failure: with the guard removed the *reversal* is what collides, so `postSet` never
//     even reaches the "report the original back as an idempotent no-op" outcome the module doc
//     comment warns about.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { PAISE_MAX, type Paise } from '@/calc/calculation-service';
import type { Actor } from '@/config/configuration-service';
import {
  chartOfAccountsSeedRows,
  type DateOnly,
  type LedgerEntrySetDraft,
  type SourceRecordType,
  type SourceRef,
} from '@/ledger/posting-rules';
import {
  type AccountPeriodTotals,
  createSemanticLedger,
  type LedgerAuditEvent,
  type LedgerAuditSink,
  type LedgerSetWrite,
  type LedgerSourceRecord,
  type LedgerStore,
  type LedgerWriteOutcome,
  type PersistedLedgerSet,
} from '@/ledger/semantic-ledger';
import { decodePaise } from '@/wire/paise-wire';
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
import { arbitraryBalancedLedgerSet, arbitraryDateIn } from './balanced-ledger-set-generators';

announceIfUnreachable();

const reachable = database().reachable;
const f = newFixture();

/** design.md's stated minimum. P14 is not one of the four properties raised to 1000. */
const NUM_RUNS = 100;

/** Explicit and committed, so any counterexample is reproducible from this file alone. */
const SEED = 20260514;

const PARAMS = { numRuns: NUM_RUNS, seed: SEED } as const;

/** Bound at construction: whoever posted the original. */
const POSTING_ACTOR: Actor = { kind: 'agent', id: 'reconciliation_agent' };
/** Who requested the correction (Requirement 2.4). Becomes the reversal's `created_by`. */
const CORRECTING_ACTOR: Actor = { kind: 'user', id: 'usr_p14_property' };

/** The chart the generated legs draw from, and the rows `chart_of_accounts` is seeded with. */
const CHART = chartOfAccountsSeedRows(f.tenantId);
const ACCOUNT_CODES: readonly string[] = CHART.map((account) => account.account_code);

/** Every generated set is dated inside this window. Any real calendar date would do. */
const ENTRY_DATE_WINDOW = { from: '2026-05-01' as DateOnly, to: '2026-05-10' as DateOnly };

/**
 * Refs an original may carry beyond its derivation identity.
 *
 * None of these is ingested into `razorpay_objects`, and none needs to be:
 * `ledger_entry_sources` holds a type and an identifier with no foreign key onto the stored
 * object (`20260101000003_semantic_ledger.sql`), which is what lets a link outlive a payload.
 */
const EXTRA_REF_POOL: readonly SourceRef[] = Object.freeze([
  { type: 'refund', id: 'rfnd_p14_extra' },
  { type: 'settlement', id: 'setl_p14_extra' },
  { type: 'order', id: 'order_p14_extra' },
]);

/* -------------------------------------------------------------------------- */
/* Generators                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * design.md's P14 input: a balanced set of 2..20 entries over the seeded chart, carrying
 * 0..2 extra Source_Record refs.
 *
 * The refs are drawn with `fc.subarray`, which preserves the pool order and never repeats a
 * member — a repeated ref on one entry would violate
 * `ledger_entry_sources PRIMARY KEY (entry_id, source_record_type, source_record_id)` while
 * inserting the *original*, which is a fixture fault rather than anything P14 is about. The
 * derivation identity is prepended in the property body; see the header.
 */
const arbitraryOriginal: fc.Arbitrary<LedgerEntrySetDraft> = fc
  .subarray([...EXTRA_REF_POOL], { minLength: 0, maxLength: 2 })
  .chain((extraRefs) =>
    arbitraryBalancedLedgerSet({
      accountCodes: ACCOUNT_CODES,
      entryDate: arbitraryDateIn(ENTRY_DATE_WINDOW),
      maxLegs: 10,
      sourceRefs: extraRefs,
    }),
  );

/**
 * A derivation identity per iteration, from a counter rather than from a draw.
 *
 * Every original commits, so two iterations sharing `(tenant, type, id)` would be rejected by
 * `ledger_set_derivation_uniq` and `postSet` would report the *first* iteration's set back as
 * an idempotent no-op. That is a fixture collision, not a property failure, so it is made
 * impossible rather than made unlikely.
 */
let iterations = 0;

function nextIdentity(): SourceRef {
  iterations += 1;
  return { type: 'payment', id: `pay_p14_original_${iterations}` };
}

/* -------------------------------------------------------------------------- */
/* SQL: the write, and the read-back                                          */
/* -------------------------------------------------------------------------- */

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
 * One persisted set, its entries and every link under them, as one JSON line. `null` when the
 * Tenant has no such set.
 *
 * This is the one select the whole file reads through: the snapshot, the re-read, the
 * reversals, and `findSet`. Using it for all four means the before/after comparison cannot
 * differ because two queries differed.
 *
 * `created_at` is included on the set and on every entry. Nothing can update those columns —
 * `UPDATE` is revoked on `ledger_entries` and the append-only trigger rejects it — so
 * including them makes the deep equality strictly stronger at no cost. Amounts leave as digit
 * text; `entry_date` and `created_at` as text, never as JSON numbers or dates.
 *
 * Links are ordered by `(type, id)` because `ledger_entry_sources` has no inherent row order
 * (`PRIMARY KEY (entry_id, source_record_type, source_record_id)`), so a deterministic order
 * has to be imposed by the query rather than hoped for.
 */
function persistedSetSelect(tenantId: string, setId: string): string {
  return `select coalesce((select to_jsonb(x) from (
  select s.id, s.tenant_id, s.entry_date::text as entry_date,
         s.source_record_type::text as source_record_type, s.source_record_id,
         s.reverses_set_id, s.entry_count,
         s.total_debit_paise::text as total_debit_paise,
         s.total_credit_paise::text as total_credit_paise,
         s.created_by, s.created_at::text as created_at,
         (select coalesce(jsonb_agg(jsonb_build_object(
                   'line_no', e.line_no,
                   'account_code', e.account_code,
                   'side', e.side::text,
                   'amount_paise', e.amount_paise::text,
                   'entry_date', e.entry_date::text,
                   'created_at', e.created_at::text,
                   'sources', (select coalesce(jsonb_agg(jsonb_build_object(
                                 'type', src.source_record_type::text,
                                 'id', src.source_record_id)
                               order by src.source_record_type::text, src.source_record_id),
                               '[]'::jsonb)
                                 from ledger_entry_sources src
                                where src.entry_id = e.id and src.tenant_id = e.tenant_id))
                 order by e.line_no), '[]'::jsonb)
            from ledger_entries e
           where e.set_id = s.id and e.tenant_id = s.tenant_id) as entries
    from ledger_entry_sets s
   where s.id = ${lit(setId)} and s.tenant_id = ${lit(tenantId)}) x), 'null'::jsonb)::text;`;
}

/** The identifiers of every set recorded as reversing `setId`, ascending. */
function reversalIdsSelect(setId: string): string {
  return `select coalesce(jsonb_agg(id order by id), '[]'::jsonb)::text
from ledger_entry_sets
 where tenant_id = ${lit(f.tenantId)} and reverses_set_id = ${lit(setId)};`;
}

const tenantSetCountSelect = `select to_jsonb((select count(*)::int from ledger_entry_sets
 where tenant_id = ${lit(f.tenantId)}))::text;`;

const tenantEntryCountSelect = `select to_jsonb((select count(*)::int from ledger_entries
 where tenant_id = ${lit(f.tenantId)}))::text;`;

/** Sets of this Tenant that reverse something and still declare a derivation identity. */
const reversalsWithIdentitySelect = `select to_jsonb((select count(*)::int
  from ledger_entry_sets
 where tenant_id = ${lit(f.tenantId)}
   and reverses_set_id is not null
   and (source_record_type is not null or source_record_id is not null)))::text;`;

/* -------------------------------------------------------------------------- */
/* The rows, as they come back                                                */
/* -------------------------------------------------------------------------- */

interface RawEntry {
  readonly line_no: number;
  readonly account_code: string;
  readonly side: 'debit' | 'credit';
  /** Digit text. See {@link persistedSetSelect}. */
  readonly amount_paise: string;
  readonly entry_date: string;
  readonly created_at: string;
  readonly sources: readonly { readonly type: SourceRecordType; readonly id: string }[];
}

interface RawSet {
  readonly id: string;
  readonly tenant_id: string;
  readonly entry_date: string;
  readonly source_record_type: SourceRecordType | null;
  readonly source_record_id: string | null;
  readonly reverses_set_id: string | null;
  readonly entry_count: number;
  readonly total_debit_paise: string;
  readonly total_credit_paise: string;
  readonly created_by: string;
  readonly created_at: string;
  readonly entries: readonly RawEntry[];
}

/** The read-back projected onto what `findSet` must return. Nothing is computed here. */
function toPersistedSet(raw: RawSet): PersistedLedgerSet {
  return {
    id: raw.id,
    tenant_id: raw.tenant_id,
    entry_date: raw.entry_date,
    source_record_type: raw.source_record_type,
    source_record_id: raw.source_record_id,
    reverses_set_id: raw.reverses_set_id,
    entry_count: raw.entry_count,
    total_debit_paise: decodePaise(raw.total_debit_paise, 'total_debit_paise'),
    total_credit_paise: decodePaise(raw.total_credit_paise, 'total_credit_paise'),
    entries: raw.entries.map((entry) => ({
      account_code: entry.account_code,
      side: entry.side,
      amount_paise: decodePaise(entry.amount_paise, 'amount_paise'),
      entry_date: entry.entry_date,
      line_no: entry.line_no,
      sources: entry.sources.map((ref) => ({ type: ref.type, id: ref.id })),
    })),
  };
}

/** Σdebit − Σcredit for one account, over rows read back from Postgres. */
function netOf(entries: readonly RawEntry[], account: string): Paise {
  return entries
    .filter((entry) => entry.account_code === account)
    .reduce((acc, entry) => {
      const amount = decodePaise(entry.amount_paise, 'amount_paise');
      return entry.side === 'debit' ? acc + amount : acc - amount;
    }, 0n as Paise);
}

function accountsOf(entries: readonly RawEntry[]): readonly string[] {
  return [...new Set(entries.map((entry) => entry.account_code))];
}

/** `(type, id)` pairs, sorted, so two ref lists compare as sets. */
function refKeys(refs: readonly { type: string; id: string }[]): readonly string[] {
  return refs.map((ref) => `${ref.type}\u0000${ref.id}`).sort();
}

/* -------------------------------------------------------------------------- */
/* A psql-backed LedgerStore: committed writes, real reads                    */
/* -------------------------------------------------------------------------- */

interface P14Store extends LedgerStore {
  /** The read-back of each set this store wrote, by identifier. */
  readonly persisted: Map<string, RawSet>;
  /** Every `(tenant, set)` pair `findSet` was asked for, in order. */
  readonly lookups: readonly (readonly [string, string])[];
}

/**
 * The whole set in ONE `psql` session — the set row, every entry row, every link row, a real
 * `COMMIT`, then the read-back — and `findSet` as a second session against committed state.
 *
 * The `COMMIT` is the point. `ledger_entries_balance_check` is `DEFERRABLE INITIALLY DEFERRED`
 * and fires there, so a set that did not balance on disk fails the iteration rather than being
 * read back; and the reversal rows outlive the session that wrote them, which is what makes
 * `findSet`, the verification read and the second reversal's uniqueness check meaningful. Any
 * error at all from the script throws: neither an imbalance nor a duplicate derivation is
 * reachable from these generators, so either would be a defect and must surface as one rather
 * than as a `LedgerWriteOutcome` the property might tolerate.
 *
 * There is no update or delete method, and none is possible: `UPDATE` and `DELETE` on
 * `ledger_entries` are revoked and the `ledger_entries_append_only` trigger rejects them
 * (Requirement 2.7). "The original is untouched" is therefore a property of the only statement
 * available being an insert.
 */
function psqlStore(): P14Store {
  const persisted = new Map<string, RawSet>();
  const lookups: [string, string][] = [];

  return {
    persisted,
    lookups,

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
${persistedSetSelect(write.tenant_id, setId)}`,
      );
      if (r.errors.length > 0) {
        throw new Error(`ledger set insert failed:\n${r.rawErr}`);
      }
      const raw = jsonAt<RawSet | null>(r, 0);
      if (raw === null) {
        throw new Error(`set ${setId} committed but read back as absent`);
      }
      persisted.set(setId, raw);
      return Promise.resolve({ ok: true, set_id: setId });
    },

    findSet(tenantId: string, setId: string): Promise<PersistedLedgerSet | null> {
      lookups.push([tenantId, setId]);
      // The Tenant is part of the lookup, not a check applied afterwards, so another Tenant's
      // set is indistinguishable from one that does not exist.
      const r = runOk(`${claims(f)}\n${persistedSetSelect(tenantId, setId)}`);
      const raw = jsonAt<RawSet | null>(r, 0);
      return Promise.resolve(raw === null ? null : toPersistedSet(raw));
    },

    findSourceRecord(): Promise<LedgerSourceRecord | null> {
      return Promise.reject(
        new Error('P14 posts a generated set directly; findSourceRecord is P2 (task 8.6)'),
      );
    },

    trialBalanceTotals(): Promise<readonly AccountPeriodTotals[]> {
      return Promise.reject(
        new Error('P14 asserts on persisted rows; trialBalanceTotals is P13 (task 8.7)'),
      );
    },
  };
}

/**
 * An in-memory audit sink. `postSet` appends only on a rejection, and every set here balances
 * by construction, so an appended event means something was refused — asserted in the property
 * rather than assumed. `audit_events` is append-only, so a real sink would also commit a
 * permanent row per event; the real `psql` sink is proven by
 * `test/db/ledger-postset.test.ts` (task 8.3).
 */
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

function ledgerOver(store: LedgerStore, audit: LedgerAuditSink) {
  return createSemanticLedger({ store, audit, actor: POSTING_ACTOR });
}

/* -------------------------------------------------------------------------- */
/* The verification read: one session, four selects                           */
/* -------------------------------------------------------------------------- */

interface AfterView {
  /** The original, re-read by the same select that produced the snapshot. */
  readonly original: RawSet;
  /** The two reversals, in the order they were created. */
  readonly reversals: readonly RawSet[];
  /** Every set recorded as reversing the original, ascending by identifier. */
  readonly reversalIds: readonly string[];
}

function readAfter(originalId: string, reversalIds: readonly string[]): AfterView {
  const r = runOk(
    `${claims(f)}
${persistedSetSelect(f.tenantId, originalId)}
${reversalIds.map((id) => persistedSetSelect(f.tenantId, id)).join('\n')}
${reversalIdsSelect(originalId)}`,
  );
  const original = jsonAt<RawSet | null>(r, 0);
  if (original === null) {
    throw new Error(`the original set ${originalId} disappeared after being reversed`);
  }
  const reversals = reversalIds.map((id, index) => {
    const raw = jsonAt<RawSet | null>(r, index + 1);
    if (raw === null) {
      throw new Error(`reversal set ${id} was reported as posted but read back as absent`);
    }
    return raw;
  });
  return {
    original,
    reversals,
    reversalIds: jsonAt<readonly string[]>(r, reversalIds.length + 1),
  };
}

/* -------------------------------------------------------------------------- */
/* P14's assertion list                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The mirror of Requirement 2.4, over the rows both sets actually have on disk.
 *
 * Per-account amounts equal with the designations exchanged, the original's identifier stored
 * on the new set, and — because a reversal is not derived from a single Razorpay
 * Source_Record — no derivation identity at all, which is what lets a second reversal of the
 * same set land under `ledger_set_derivation_uniq`.
 */
function assertMirrors(original: RawSet, reversal: RawSet, expectedRefs: readonly string[]): void {
  // Requirement 2.4's structural link.
  expect(reversal.reverses_set_id).toBe(original.id);
  expect(reversal.id).not.toBe(original.id);

  // No derivation identity, on disk. NULL is distinct in a unique constraint.
  expect(reversal.source_record_type).toBeNull();
  expect(reversal.source_record_id).toBeNull();

  // Dated as the original, so no trial balance range holds one without the other.
  expect(reversal.entry_date).toBe(original.entry_date);
  expect(reversal.entries.every((entry) => entry.entry_date === original.entry_date)).toBe(true);

  // A set that balanced still balances with its sides exchanged: the two totals swap.
  expect(reversal.entry_count).toBe(original.entry_count);
  expect(reversal.entries).toHaveLength(original.entries.length);
  expect(reversal.total_debit_paise).toBe(original.total_credit_paise);
  expect(reversal.total_credit_paise).toBe(original.total_debit_paise);

  // Attributable to whoever asked for the correction, not to whoever posted the original.
  expect(reversal.created_by).toBe(CORRECTING_ACTOR.id);
  expect(original.created_by).toBe(POSTING_ACTOR.id);

  // Entry for entry, in `line_no` order: same account, same amount, exchanged side.
  expect(
    reversal.entries.map((entry) => [entry.line_no, entry.account_code, entry.side, entry.amount_paise]),
  ).toEqual(
    original.entries.map((entry) => [
      entry.line_no,
      entry.account_code,
      entry.side === 'debit' ? 'credit' : 'debit',
      entry.amount_paise,
    ]),
  );

  // Every entry carries every ref, and the refs are the original set plus the original's own
  // refs de-duplicated (Requirement 2.2, 2.4).
  for (const entry of reversal.entries) {
    expect(entry.sources.length).toBeGreaterThanOrEqual(1);
    expect(refKeys(entry.sources)).toEqual(expectedRefs);
  }
}

/* -------------------------------------------------------------------------- */
/* Shape coverage, so no required shape can silently stop occurring           */
/* -------------------------------------------------------------------------- */

const coverage = {
  /** Originals posting 2 or more entries to one account on the same side. */
  repeatedSameSide: 0,
  /** Originals posting to one account on both sides. */
  bothSides: 0,
  /** Originals carrying more than the single derivation-identity ref. */
  multipleRefs: 0,
  minEntries: Number.POSITIVE_INFINITY,
  maxEntries: 0,
  /** The largest single entry amount seen, so the top of the paise range is provably reached. */
  maxAmountPaise: 0n,
  /** Total entries committed across originals, for the closing count check. */
  originalEntries: 0,
};

function tallyShapes(entries: readonly RawEntry[], refCount: number): void {
  const sides = new Map<string, Set<string>>();
  const perSide = new Map<string, number>();
  for (const entry of entries) {
    const seen = sides.get(entry.account_code) ?? new Set<string>();
    seen.add(entry.side);
    sides.set(entry.account_code, seen);
    const key = `${entry.account_code}\u0000${entry.side}`;
    perSide.set(key, (perSide.get(key) ?? 0) + 1);
    const amount = decodePaise(entry.amount_paise, 'amount_paise');
    if (amount > coverage.maxAmountPaise) {
      coverage.maxAmountPaise = amount;
    }
  }
  if ([...perSide.values()].some((count) => count >= 2)) {
    coverage.repeatedSameSide += 1;
  }
  if ([...sides.values()].some((seen) => seen.size === 2)) {
    coverage.bothSides += 1;
  }
  if (refCount > 1) {
    coverage.multipleRefs += 1;
  }
  coverage.minEntries = Math.min(coverage.minEntries, entries.length);
  coverage.maxEntries = Math.max(coverage.maxEntries, entries.length);
  coverage.originalEntries += entries.length;
}

/* -------------------------------------------------------------------------- */

describe.skipIf(!reachable)('Property 14: reversal preservation', () => {
  beforeAll(() => {
    const accounts = CHART.map(
      (a) =>
        `(${lit(a.tenant_id)}, ${lit(a.account_code)}, ${lit(a.account_name)}, ` +
        `${lit(a.kind)}::account_kind, ${a.is_active})`,
    ).join(',\n       ');
    runOk(
      `${provision(f)}
insert into chart_of_accounts (tenant_id, account_code, account_name, kind, is_active)
values ${accounts};`,
    );
  });

  it('leaves every original entry unchanged and nets the pair to 0 paise per account', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryOriginal, async (generated) => {
        const draft: LedgerEntrySetDraft = {
          ...generated,
          source_refs: [nextIdentity(), ...generated.source_refs],
        };
        const store = psqlStore();
        const audit = recordingAuditSink();
        const ledger = ledgerOver(store, audit);

        // The original goes in through production `postSet` and commits.
        const posted = await ledger.postSet(f.tenantId, draft);
        expect(posted).toMatchObject({ ok: true, created: true });
        if (!posted.ok) {
          return;
        }
        const originalId = posted.set_id;
        const before = store.persisted.get(originalId);
        if (before === undefined) {
          throw new Error(`postSet reported ${originalId} without a read-back`);
        }
        // The rows on disk are the generated set, not a re-derivation of it.
        expect(before.entries).toHaveLength(draft.entries.length);
        expect(before.source_record_type).toBe(draft.source_refs[0]?.type);
        expect(before.source_record_id).toBe(draft.source_refs[0]?.id);
        expect(before.reverses_set_id).toBeNull();
        tallyShapes(before.entries, draft.source_refs.length);

        // Reverse twice. Each call reads the original through `findSet` and posts the mirror
        // through the same `postSet` path.
        const first = await ledger.reverseSet(f.tenantId, originalId, CORRECTING_ACTOR);
        const second = await ledger.reverseSet(f.tenantId, originalId, CORRECTING_ACTOR);
        expect(first).toMatchObject({ ok: true, created: true });
        expect(second).toMatchObject({ ok: true, created: true });
        if (!first.ok || !second.ok) {
          return;
        }
        // Two independent sets, not an idempotent no-op: a second correction is a second set.
        expect(first.set_id).not.toBe(second.set_id);
        expect(store.lookups).toEqual([
          [f.tenantId, originalId],
          [f.tenantId, originalId],
        ]);
        // Nothing was refused, so nothing was audited.
        expect(audit.events).toEqual([]);

        const after = readAfter(originalId, [first.set_id, second.set_id]);

        // 1. The original, field by field including its Source_Record links and its
        //    `created_at`, re-read in a session that shares no transaction with any writer.
        expect(after.original).toEqual(before);

        // 2. Exactly two sets reverse the original, and they are the two that were reported.
        expect(after.reversalIds).toEqual([first.set_id, second.set_id].sort());

        const expectedRefs = refKeys([
          { type: 'ledger_entry_set', id: originalId },
          ...draft.source_refs,
        ]);
        for (const reversal of after.reversals) {
          // 3. The mirror: amounts equal, designations exchanged, linked, no identity.
          assertMirrors(before, reversal, expectedRefs);

          // 4. `netOf(original, account) + netOf(reversal, account) === 0n`, per account, over
          //    rows read back from Postgres. An account posted several times on one side, or
          //    posted on both sides, only cancels if every entry was mirrored.
          for (const account of accountsOf(before.entries)) {
            expect(netOf(before.entries, account) + netOf(reversal.entries, account)).toBe(0n);
          }
        }
      }),
      PARAMS,
    );
  });

  it('exercised both repetition shapes design.md names, over 2..20 entries', () => {
    console.warn(`[P14] ${JSON.stringify(coverage, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    // The two shapes design.md's generator note requires. Neither is assumed.
    expect(coverage.repeatedSameSide).toBeGreaterThan(0);
    expect(coverage.bothSides).toBeGreaterThan(0);
    // Sets carrying more than the identity ref, so the reversal's ref de-duplication is live.
    expect(coverage.multipleRefs).toBeGreaterThan(0);
    // Requirement 2.1's whole permitted range of set sizes.
    expect(coverage.minEntries).toBe(2);
    expect(coverage.maxEntries).toBe(20);
    // The mirror was asserted on amounts in the upper half of the paise range, not only on
    // small ones — a read path that lost precision by passing an amount through a JSON number
    // would fail there and nowhere else.
    expect(coverage.maxAmountPaise).toBeGreaterThan(PAISE_MAX / 2n);
  });

  it('committed one original and two reversals per iteration, each reversal with no identity', () => {
    const r = runOk(
      `${claims(f)}
${tenantSetCountSelect}
${tenantEntryCountSelect}
${reversalsWithIdentitySelect}`,
    );
    expect(iterations).toBe(NUM_RUNS);
    // 1 original + 2 reversals per iteration, and each reversal mirrors the original entry
    // for entry, so the entry count is 3× the originals'.
    expect(jsonAt<number>(r, 0)).toBe(iterations * 3);
    expect(jsonAt<number>(r, 1)).toBe(coverage.originalEntries * 3);
    // `ledger_set_derivation_uniq` never had to be dodged: every reversal on disk carries NULL
    // in both identity columns.
    expect(jsonAt<number>(r, 2)).toBe(0);
  });
});
