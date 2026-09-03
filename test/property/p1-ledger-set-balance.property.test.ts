// Feature: financeos-control-tower, Property 1: Ledger set balance — for all generated
// Source_Records and for all ledger drafts derived from them, every persisted
// `ledger_entry_set` satisfies Σdebit − Σcredit = 0 paise, has between 2 and 20 entries,
// has every entry amount an integer greater than 0 paise, and has at least 1 Source_Record
// link per entry; and for all deliberately imbalanced drafts, zero Ledger_Entries persist
// and every account balance is unchanged.
//
// **Validates: Requirements 2.1, 2.2, 2.3, 2.6, 2.7, 2.9, 2.10, 4.12, 7.1, 7.2**
//
// Requirement 4.12's contribution here is the "at least 1 Source_Record identifier" shape
// on the ledger side — every persisted Ledger_Entry carries at least 1
// `ledger_entry_sources` row. The Exception-side half of 4.12 is task 9.x's and is not
// asserted by this file.
//
// WHY THIS FILE IS IN THE `property` PROJECT AND NOT IN `db`
// ---------------------------------------------------------
// Same reasoning as `./p10-ingestion-idempotency.property.test.ts`, which is the precedent
// this file follows. P1 is a statement about what is on disk — the `paise_positive` domain,
// the `entry_count BETWEEN 2 AND 20` CHECK, the immediate `ledger_set_balanced` CHECK and
// the `DEFERRABLE INITIALLY DEFERRED` constraint trigger are the things it exists to prove,
// and a fake store would prove none of them. But design.md's CI stage 8 owns "Property
// tests P1–P15", so it belongs with P10, P11 and P12; and the `db` project caps
// `testTimeout` at 60 s, which 1000 database-backed iterations cannot fit, while `property`
// allows 300 s and already runs `fileParallelism: false` — exactly what a suite driving one
// local Postgres needs. The database is reached through `test/db/pg.ts`, the same
// `psql`-in-the-container harness the `db` suite uses, and the whole describe block is
// gated on `database().reachable`, so the file is a clean skip wherever the stack is down.
//
// ITERATIONS, SEED, AND WHAT 1000 DATABASE-BACKED ITERATIONS COST
// --------------------------------------------------------------
// design.md raises `numRuns` to 1000 for P1, and that is honoured rather than reduced. The
// cost was measured before the design was settled: one `docker exec psql` session against
// this container is ~100 ms (10 sessions in 1019 ms, measured directly). The iteration
// design below spends **1 session on a balanced case and 2 on an imbalanced one**, and the
// case generator draws balanced 3:1, so 1000 iterations is ~1250 sessions. Measured: the
// property runs in **151 s at `numRuns: 1000`** (151 ms per iteration), and the file
// including the committed baseline in 151.9 s — half the `property` project's 300 s bound.
// The seed is explicit and committed, per design.md's "seed and record" rule.
//
// One iteration posts ONE set, not an array of them. design.md's generator input for P1 is
// `fc.array(arbitrarySourceRecord)`; that is deliberately narrowed here to a single
// Source_Record per iteration, because per-iteration rollback requires the whole iteration
// to be one `psql` session and the harness opens a session per script — so an array of *n*
// sources would be *n* transactions and *n* sessions. 1000 iterations × 1 set is more sets
// than 100 × 10 and each one is independently shrinkable. Nothing in P1 is a statement
// about two sets interacting; that is P2 (derivation idempotency, task 8.4).
//
// PER-ITERATION ROLLBACK, AND WHICH BARRIERS IT ACTUALLY EXERCISES
// ---------------------------------------------------------------
// The task asks for a per-iteration transaction rollback. Unlike P10 — whose property spans
// two ingestion passes across separate sessions, so no transaction could contain it — one
// `postSet` is one transaction, so `BEGIN … ROLLBACK` around an iteration is achievable and
// is far cheaper than commit-then-delete (`ledger_entries` is append-only: a committed row
// cannot be deleted at all).
//
// The hazard is real and was checked rather than assumed: `ledger_entries_balance_check` is
// `DEFERRABLE INITIALLY DEFERRED`, so it fires at `COMMIT`, and a transaction that never
// commits would never reach it. **`SET CONSTRAINTS ALL IMMEDIATE` fires the pending
// deferred trigger at that point instead**, which was verified against this database before
// this file was written: an imbalanced set inserted inside a transaction raises
// `23000 ledger set … unbalanced: debit 100 credit 90, imbalance 10 paise` at the
// `SET CONSTRAINTS` statement, not at a commit that never comes, and the rollback afterwards
// leaves nothing behind. So the balanced iterations exercise:
//
//   - every immediate constraint: the `paise_positive` domain on `amount_paise`, the `paise`
//     domain on the declared totals, `entry_count BETWEEN 2 AND 20`, the immediate
//     `ledger_set_balanced` CHECK, `ledger_set_totals_positive`, the `(tenant_id,
//     account_code)` foreign key into `chart_of_accounts`, `ledger_set_derivation_uniq`,
//     and the `(set_id, line_no)` uniqueness;
//   - the deferred `ledger_entries_balance_check` trigger, forced to run by
//     `SET CONSTRAINTS ALL IMMEDIATE` after every entry and link row is in;
//   - and the read-back of the persisted rows, issued after the barrier has passed.
//
// What a rolled-back iteration does NOT exercise is the `COMMIT` itself. That is closed two
// ways rather than waved at. `test/db/ledger-postset.test.ts` (task 8.3) commits its sets
// and asserts the same guarantees against committed rows; and this file's own `beforeAll`
// posts ONE balanced Payment set through the same store in **commit mode**, so the deferred
// trigger fires at a real `COMMIT`, and the first test below runs P1's whole assertion list
// against that committed set through the identical read path. Every generated iteration
// then rolls back. The last test re-reads the committed state and asserts it still holds
// exactly that one baseline set, which is what proves the rollbacks rolled back.
//
// THE BASELINE SET IS ALSO WHAT GIVES THE BALANCE MAP TEETH
// --------------------------------------------------------
// "Every account balance is unchanged" over an empty ledger is a statement about two empty
// maps. The committed baseline Payment set puts four accounts at non-zero balances
// (`settlement_pending` +97216, `razorpay_fee_expense` +2360, `gst_input_credit` +424,
// `revenue` −100000), so the pre/post comparison in the imbalanced branch is a deep-equal
// over a populated `Map<string, bigint>`. The map is read **from the database** — signed
// `debit − credit` per `account_code`, aggregated over `ledger_entries` — before the post is
// attempted and again afterwards, never derived from the draft.
//
// GENERATORS, AND KEEPING EACH SIDE'S RUNNING TOTAL IN RANGE
// ---------------------------------------------------------
// `arbitraryPayment`, `arbitraryRefund`, `arbitrarySettlement`, `arbitraryTransfer`, and
// `arbitraryTransferReversal` produce `PostingSource` values; `postingDraftFor` derives the draft, so the rules under test are
// the ones in `src/ledger/posting-rules.ts` rather than a re-derivation here. They live in
// `./ledger-generators.ts` as of task 8.6, extracted verbatim and shared with P2 — the draws
// are unchanged, so every counterexample quoted below is still reproducible from the seed.
//
// Amounts span the whole paise range with the biases task 8.2's closing notes suggested:
// `A = 1n`, `A = PAISE_MAX`, `F + G = A` (net omitted), `F + G = A − 1` (a 1-paisa net), and
// `F = G = 0`. The range constraint 8.2 flagged is handled structurally, not by a filter:
// `totalDebitPaise`/`totalCreditPaise` go through `sum`, which range-checks **each running
// total**, so a draft can balance while one side's partial sum exceeds `PAISE_MAX` and
// `postSet` then raises `PaiseRangeError` instead of reporting an imbalance. Every fee shape
// below derives `F` and `G` with `F + G <= A`, so a Payment's debit side sums to exactly `A`
// and its credit side to exactly `A`; a Refund and a Settlement post one amount twice. Both
// sides are therefore bounded by the drawn gross amount, which is itself `<= PAISE_MAX`, so
// no partial sum can leave the range and `PaiseRangeError` is unreachable from these
// generators by construction.
//
// `arbitraryImbalancedDraft` perturbs one entry of an otherwise valid draft by a non-zero
// delta, which moves exactly one side's total, so the imbalance is the delta and is never
// accidentally 0. The perturbation is chosen so the draft stays **structurally valid and
// only imbalanced** — 2..20 entries, every amount `> 0`, non-empty `source_refs`, a real
// `entry_date`, and the perturbed side's total still `<= PAISE_MAX` — because otherwise
// `assertDraftWellFormed` throws `PostingRuleError` (or `sum` throws `PaiseRangeError`) and
// the test would be exercising the wrong rejection path. Candidate perturbations are tried
// in order and the first valid one is applied; a valid one always exists, and the reason it
// does is recorded at {@link perturbOneEntry}.
//
// THE `A − F − G` ORACLE IS DERIVED INDEPENDENTLY
// ----------------------------------------------
// `paymentPostingDraft` computes `subtract(subtract(A, F), G)` — `(A − F) − G`, left
// associated, two calls. The oracle here computes `subtract(A, sum([F, G]))` — `A − (F + G)`,
// a different association over a different pair of calculation-service entry points, which
// is the same independence task 8.2 established for its example table. The posted value is
// read back **from the database** and compared as a difference: `subtract(posted, expected)`
// is `0n`. An omitted `settlement_pending` line reads as `0n`, because omission and a
// 0-paise posting are the same accounting fact — the account did not move — which is what
// lets the identity be stated once for every fee shape including `F + G = A`.
//
// AUDIT SINK: A RECORDING FAKE, DELIBERATELY
// ------------------------------------------
// `postSet` appends a `ledger_set_rejected` Audit_Event through `LedgerAuditSink` on a
// connection independent of the store, and Requirement 2.6 makes that append mandatory
// rather than best-effort. `audit_events` is append-only and its rows cannot be deleted, so
// a real sink at ~250 rejections per run would commit ~250 permanent rows per run into a
// table `npx supabase db reset` is the only way to clear. The sink here is therefore an
// in-memory recorder: it satisfies `postSet`'s contract without writing, and the real
// `psql` sink — including the control proving the separate connection is what makes the
// event survive a rolled-back posting transaction — is already asserted against live
// Postgres by `test/db/ledger-postset.test.ts` (task 8.3). P1 says nothing about the
// Audit_Event, so nothing is lost.
//
// NOT VACUOUS
// -----------
// Checked by falsification, twice, because a database-backed property that never reaches the
// database passes just as greenly as one that does.
//
//   - `entryCount >= 3` in place of `>= 2` fails after 1 test, shrinks 4 times, and reports
//     `expected 2 to be greater than or equal to 3` on
//     `{"kind":"source","source":{"type":"payment","payment_id":"pay_p1_a",
//     "entry_date":"2024-01-01","amount_paise":1n,"fee_paise":0n,"gst_on_fee_paise":0n}}` —
//     the smallest Payment that admits a posting at all, posting the 2-entry shape. The `2`
//     in that message came out of a `SELECT` over `ledger_entries`, not out of the draft,
//     which is the evidence that the read path is live.
//   - Asserting the pre/post balance maps are *different* fails after 3 tests, shrinks 8
//     times, and reports `expected Map{ 'revenue' => -100000n, …(3) } to not deeply equal
//     Map{ 'revenue' => -100000n, …(3) }` on a payment-derived draft perturbed to
//     `debit settlement_pending 2` against `credit revenue 1`. That shows the imbalanced
//     branch is reached, that the map is populated by the committed baseline rather than
//     empty, and that a 1-paisa imbalance is what shrinking converges on.
//
// Both mutations were reverted. No regression test is committed for either: the
// counterexamples came from deliberately broken assertions, not from a defect in the system.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { PAISE_MAX, type Paise, subtract, sum } from '@/calc/calculation-service';
import type { Actor } from '@/config/configuration-service';
import {
  ACCOUNT,
  chartOfAccountsSeedRows,
  type LedgerEntryDraft,
  type LedgerEntrySetDraft,
  type PaymentPosting,
  type PostingSource,
  postingDraftFor,
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
} from '@/ledger/semantic-ledger';
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
  type ScriptResult,
} from '../db/pg';
import { arbitrarySourceRecord } from './ledger-generators';

announceIfUnreachable();

const reachable = database().reachable;
const f = newFixture();

/** design.md raises P1 to 1000. See the header for the measured cost. */
const NUM_RUNS = 1000;

/** Explicit and committed, so any counterexample is reproducible from this file alone. */
const SEED = 20260301;

const PARAMS = { numRuns: NUM_RUNS, seed: SEED } as const;

const ACTOR: Actor = { kind: 'user', id: 'usr_p1_property' };
const NOW = '2026-03-01T00:00:00.000Z';

/** `integrity_constraint_violation`, raised by `assert_ledger_set_balanced()`. */
const INTEGRITY_CONSTRAINT_VIOLATION = '23000';
/** `check_violation`, raised by the immediate `ledger_set_balanced` CHECK. */
const CHECK_VIOLATION = '23514';

/** The committed baseline set, so the balance map is populated. See the header. */
const BASELINE: PaymentPosting = {
  payment_id: 'pay_p1_baseline',
  entry_date: '2026-01-31',
  amount_paise: 100_000n,
  fee_paise: 2_360n,
  gst_on_fee_paise: 424n,
};

/* -------------------------------------------------------------------------- */
/* Generators                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `arbitraryPayment`, `arbitraryRefund`, `arbitrarySettlement` and design.md's
 * `arbitrarySourceRecord` now live in `./ledger-generators`, extracted verbatim when task
 * 8.6 (property P2) needed the same Source_Records. Nothing about the draws changed —
 * including the `pay_p1_*` identifier pools, deliberately kept so the shrunk counterexamples
 * quoted in this file's header stay reproducible from the committed seed. The imbalanced
 * half below stays here: "a draft no posting rule produces" is P1's subject alone.
 */

function sideTotalOf(entries: readonly LedgerEntryDraft[], side: 'debit' | 'credit'): Paise {
  return sum(entries.filter((entry) => entry.side === side).map((entry) => entry.amount_paise));
}

/**
 * Move one entry by a non-zero delta, leaving the draft valid in every other respect.
 *
 * Only one side's total moves, so the imbalance is exactly the delta and is never
 * accidentally 0. Candidates are tried in order and the first admissible one is applied;
 * one always is, and the argument is short enough to state:
 *
 *   - if the drawn side's total is below `PAISE_MAX`, `+1` on any entry is admissible;
 *   - otherwise that side totals exactly `PAISE_MAX` over at most 4 entries, so its largest
 *     entry is at least `PAISE_MAX / 4`, and `-1` on the draft's largest entry is
 *     admissible — the amount stays `>= 1` and the total only shrinks.
 *
 * The throw at the end is therefore unreachable; it is there so that a future posting rule
 * with a different entry shape fails loudly instead of silently generating a draft that is
 * rejected for the wrong reason.
 */
function perturbOneEntry(
  draft: LedgerEntrySetDraft,
  indexSeed: number,
  deltaSeed: bigint,
): LedgerEntrySetDraft {
  const totals = {
    debit: sideTotalOf(draft.entries, 'debit'),
    credit: sideTotalOf(draft.entries, 'credit'),
  };
  const largest = draft.entries.reduce(
    (best, entry, index) =>
      entry.amount_paise > (draft.entries[best]?.amount_paise ?? 0n) ? index : best,
    0,
  );
  const drawn = indexSeed % draft.entries.length;
  const candidates: readonly (readonly [number, bigint])[] = [
    [drawn, deltaSeed],
    [drawn, 1n],
    [largest, -1n],
    [largest, 1n],
  ];

  for (const [index, delta] of candidates) {
    const entry = draft.entries[index];
    if (entry === undefined || delta === 0n) {
      continue;
    }
    const amount = entry.amount_paise + delta;
    if (amount < 1n || totals[entry.side] + delta > PAISE_MAX) {
      continue;
    }
    return {
      ...draft,
      entries: draft.entries.map((current, at) =>
        at === index ? { ...current, amount_paise: amount } : current,
      ),
    };
  }
  throw new Error(
    `no admissible perturbation for draft ${JSON.stringify(draft, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
  );
}

/**
 * design.md's `arbitraryImbalancedDraft`: a draft no posting rule produces, imbalanced and
 * nothing else. Deltas are biased to `±1` — a 1-paisa imbalance is the hardest case for the
 * barrier to catch and the one Requirement 2.6 is really about.
 */
const arbitraryImbalancedDraft: fc.Arbitrary<LedgerEntrySetDraft> = fc
  .record({
    source: arbitrarySourceRecord,
    entryIndex: fc.nat({ max: 19 }),
    delta: fc.oneof(
      { arbitrary: fc.constantFrom(1n, -1n, 100n, -100n), weight: 3 },
      {
        arbitrary: fc
          .bigInt({ min: -PAISE_MAX, max: PAISE_MAX })
          .map((delta) => (delta === 0n ? 1n : delta)),
        weight: 2,
      },
    ),
  })
  .map(({ source, entryIndex, delta }) =>
    perturbOneEntry(postingDraftFor(source), entryIndex, delta),
  );

/** One iteration's input: a Source_Record to post, or a draft that must be rejected. */
type Case =
  | { readonly kind: 'source'; readonly source: PostingSource }
  | { readonly kind: 'imbalanced'; readonly draft: LedgerEntrySetDraft };

/**
 * 3:1 in favour of the balanced path, which is also the cheaper one (1 `psql` session
 * against 2), so the iteration budget in the header holds.
 */
const arbitraryCase: fc.Arbitrary<Case> = fc.oneof(
  {
    arbitrary: arbitrarySourceRecord.map((source) => ({ kind: 'source' as const, source })),
    weight: 3,
  },
  {
    arbitrary: arbitraryImbalancedDraft.map((draft) => ({ kind: 'imbalanced' as const, draft })),
    weight: 1,
  },
);

/* -------------------------------------------------------------------------- */
/* SQL: the set, its entries, its links, and the read-back                    */
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

/** The persisted set row, as one JSON line. `null` when no row exists. */
function setRowSelect(setId: string): string {
  return `select coalesce((select to_jsonb(x) from (
  select entry_count, total_debit_paise::text as total_debit_paise,
         total_credit_paise::text as total_credit_paise,
         source_record_type::text as source_record_type, source_record_id
    from ledger_entry_sets
   where id = ${lit(setId)} and tenant_id = ${lit(f.tenantId)}) x), 'null'::jsonb)::text;`;
}

/**
 * The persisted entries of a set with their Source_Record link counts, as one JSON line.
 *
 * `amount_paise` comes back as text and is parsed to `bigint`: `paise_positive` is a
 * `BIGINT` domain and JSON numbers are doubles, so a value near `PAISE_MAX` would lose
 * precision on the way through `jsonb` as a number. The link count is a row count and is a
 * `number`.
 */
function entryRowsSelect(setId: string): string {
  return `select coalesce(jsonb_agg(jsonb_build_object(
  'account_code', account_code,
  'side', side,
  'amount_paise', amount_paise,
  'link_count', link_count) order by line_no), '[]'::jsonb)::text
from (
  select e.line_no, e.account_code, e.side::text as side, e.amount_paise::text as amount_paise,
         (select count(*)::int from ledger_entry_sources s where s.entry_id = e.id) as link_count
    from ledger_entries e
   where e.set_id = ${lit(setId)} and e.tenant_id = ${lit(f.tenantId)}) e;`;
}

/**
 * Signed `debit − credit` per account, over every Ledger_Entry of the Tenant, as one JSON
 * line of `{ account_code: "<digits>" }`. Read from the database, never from a draft.
 */
const balanceMapSelect = `select coalesce(jsonb_object_agg(account_code, balance), '{}'::jsonb)::text
from (
  select account_code,
         sum(case when side = 'debit' then amount_paise else -amount_paise end)::text as balance
    from ledger_entries
   where tenant_id = ${lit(f.tenantId)}
   group by account_code) b;`;

const tenantEntryCountSelect = `select to_jsonb((select count(*)::int from ledger_entries
 where tenant_id = ${lit(f.tenantId)}))::text;`;

const tenantSetCountSelect = `select to_jsonb((select count(*)::int from ledger_entry_sets
 where tenant_id = ${lit(f.tenantId)}))::text;`;

/**
 * How many Ledger_Entries exist under a set carrying this derivation identity.
 *
 * P1's `countEntriesForSet(setId) === 0` has no `setId` to name for an application-level
 * rejection: `postSet` returns before it opens a transaction, so no set was ever created and
 * no identifier was ever allocated. The faithful reading is therefore "0 entries exist under
 * the identity this draft would have been stored under", which is what this counts.
 */
function derivationEntryCountSelect(ref: SourceRef): string {
  return `select to_jsonb((select count(*)::int from ledger_entries e
  join ledger_entry_sets s on s.id = e.set_id
 where s.tenant_id = ${lit(f.tenantId)}
   and s.source_record_type = ${lit(ref.type)}::source_record_type
   and s.source_record_id = ${lit(ref.id)}))::text;`;
}

/* -------------------------------------------------------------------------- */
/* A psql-backed LedgerStore, rolled back per iteration                       */
/* -------------------------------------------------------------------------- */

interface PersistedEntry {
  readonly account_code: string;
  readonly side: string;
  /** Digit text, parsed to `bigint`. See {@link entryRowsSelect}. */
  readonly amount_paise: string;
  readonly link_count: number;
}

interface PersistedSet {
  readonly entry_count: number;
  readonly total_debit_paise: string;
  readonly total_credit_paise: string;
  readonly source_record_type: string | null;
  readonly source_record_id: string | null;
}

interface Observation {
  readonly setId: string;
  readonly set: PersistedSet | null;
  readonly entries: readonly PersistedEntry[];
}

const IMBALANCE_IN_MESSAGE = /imbalance (-?\d+) paise/;

/** The imbalance the barrier saw, or the one the attempted entries imply. */
function imbalanceOf(write: LedgerSetWrite, message: string): Paise {
  const stated = IMBALANCE_IN_MESSAGE.exec(message);
  if (stated?.[1] !== undefined) {
    return BigInt(stated[1]);
  }
  const side = (which: 'debit' | 'credit'): Paise =>
    sum(write.entries.filter((entry) => entry.side === which).map((entry) => entry.amount_paise));
  return subtract(side('debit'), side('credit'));
}

type StoreMode = 'rollback' | 'commit';

/**
 * The whole set in ONE `psql` session: the set row, every entry row, every link row, then
 * the barrier, then the read-back.
 *
 * `rollback` mode forces the deferred `ledger_entries_balance_check` with
 * `SET CONSTRAINTS ALL IMMEDIATE` and throws the transaction away afterwards; `commit` mode
 * lets the trigger fire at a real `COMMIT` and reads the rows back from committed state in
 * the same session. Both read through the identical two selects, so the read path the
 * property asserts on is the one the committed baseline is checked with.
 */
function psqlStore(mode: StoreMode): LedgerStore & { observed: Observation | null } {
  const store = {
    observed: null as Observation | null,
    insertSet(write: LedgerSetWrite): Promise<LedgerWriteOutcome> {
      const setId = randomUUID();
      const rows: readonly EntryRow[] = write.entries.map((entry) => ({
        id: randomUUID(),
        write: entry,
      }));
      const barrierAndReads =
        mode === 'rollback'
          ? `set constraints all immediate;
${setRowSelect(setId)}
${entryRowsSelect(setId)}
rollback;`
          : `commit;
${setRowSelect(setId)}
${entryRowsSelect(setId)}`;

      const r: ScriptResult = runScript(
        `begin;
${claims(f)}
${setInsert(write, setId)}
${entryInserts(write, setId, rows)}
${sourceInserts(write, rows)}
${barrierAndReads}`,
      );

      const barrier = r.errors.find(
        (e) => e.sqlstate === INTEGRITY_CONSTRAINT_VIOLATION || e.sqlstate === CHECK_VIOLATION,
      );
      if (barrier !== undefined) {
        return Promise.resolve({
          ok: false,
          kind: 'unbalanced',
          imbalance_paise: imbalanceOf(write, barrier.message),
        });
      }
      if (r.errors.length > 0) {
        throw new Error(`ledger set insert failed:\n${r.rawErr}`);
      }
      store.observed = {
        setId,
        set: jsonAt<PersistedSet | null>(r, 0),
        entries: jsonAt<readonly PersistedEntry[]>(r, 1),
      };
      return Promise.resolve({ ok: true, set_id: setId });
    },

    /**
     * The read seams, present because {@link LedgerStore} declares them and absent of
     * behaviour because P1 drives `postSet` with a draft it derived itself. A call here
     * would mean the property had started exercising `postFromSource` (P2),
     * `trialBalance` (P13) or `reverseSet` (P14), so each raises rather than returning a
     * plausible empty answer.
     */
    findSourceRecord(): Promise<LedgerSourceRecord | null> {
      return Promise.reject(
        new Error('P1 posts drafts directly; findSourceRecord is P2 (task 8.4)'),
      );
    },

    findSet(): Promise<null> {
      return Promise.reject(new Error('P1 posts drafts directly; findSet is P14 (task 24.2)'));
    },

    trialBalanceTotals(): Promise<readonly AccountPeriodTotals[]> {
      return Promise.reject(
        new Error('P1 asserts on persisted rows; trialBalanceTotals is P13 (task 8.4)'),
      );
    },
  };
  return store;
}

/**
 * An in-memory audit sink. `audit_events` is append-only and a real sink would commit one
 * permanent row per rejected iteration — see the header for why that is not wanted here and
 * where the real sink is proven instead.
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
  return createSemanticLedger({ store, audit, actor: ACTOR, now: () => new Date(NOW) });
}

/* -------------------------------------------------------------------------- */
/* Reading committed state                                                    */
/* -------------------------------------------------------------------------- */

/** The per-account balance map plus the Tenant's Ledger_Entry count, in one session. */
interface CommittedState {
  readonly balances: Map<string, bigint>;
  readonly entryCount: number;
}

function toBalanceMap(raw: Readonly<Record<string, string>>): Map<string, bigint> {
  return new Map(Object.entries(raw).map(([account, balance]) => [account, BigInt(balance)]));
}

function stateOf(r: ScriptResult): CommittedState {
  return {
    balances: toBalanceMap(jsonAt<Readonly<Record<string, string>>>(r, 0)),
    entryCount: jsonAt<number>(r, 1),
  };
}

function readCommittedState(): CommittedState {
  return stateOf(runOk(`${claims(f)}\n${balanceMapSelect}\n${tenantEntryCountSelect}`));
}

/** The same read, plus the entry count under one derivation identity. Still one session. */
function readCommittedStateAt(
  ref: SourceRef,
): CommittedState & { readonly derivationEntryCount: number } {
  const r = runOk(
    `${claims(f)}
${balanceMapSelect}
${tenantEntryCountSelect}
${derivationEntryCountSelect(ref)}`,
  );
  return { ...stateOf(r), derivationEntryCount: jsonAt<number>(r, 2) };
}

/* -------------------------------------------------------------------------- */
/* P1's assertion list                                                        */
/* -------------------------------------------------------------------------- */

function requireObservation(observed: Observation | null): Observation {
  if (observed === null) {
    throw new Error('the store reported a persisted set but read back nothing');
  }
  return observed;
}

function amountsOn(entries: readonly PersistedEntry[], side: 'debit' | 'credit'): Paise[] {
  return entries.filter((entry) => entry.side === side).map((entry) => BigInt(entry.amount_paise));
}

/**
 * P1's list, over the rows read back out of Postgres:
 * `sumDebit === sumCredit`, `entryCount >= 2 && entryCount <= 20`,
 * `entries.every(e => e.amount_paise > 0n)`, `entries.every(e => sourceLinkCount(e) >= 1)`.
 */
function assertPersistedSetHoldsP1(observed: Observation): void {
  const { set, entries } = observed;
  expect(set).not.toBeNull();

  const debit = sum(amountsOn(entries, 'debit'));
  const credit = sum(amountsOn(entries, 'credit'));
  // Stated as a difference and as an equality, so a fault that moved both sides by the
  // same amount is still visible.
  expect(subtract(debit, credit)).toBe(0n);
  expect(debit).toBe(credit);

  expect(entries.length).toBeGreaterThanOrEqual(2);
  expect(entries.length).toBeLessThanOrEqual(20);
  expect(set?.entry_count).toBe(entries.length);

  for (const entry of entries) {
    expect(BigInt(entry.amount_paise) > 0n).toBe(true);
    expect(entry.link_count).toBeGreaterThanOrEqual(1);
  }
}

/**
 * The Payment identity of Requirement 2.3: the posted `settlement_pending` amount equals
 * `A − F − G` exactly. The oracle is `A − (F + G)`, associated differently from the
 * implementation's `(A − F) − G` — see the header. An omitted line reads as `0n`.
 */
function assertSettlementPendingIdentity(observed: Observation, payment: PaymentPosting): void {
  const expected = subtract(
    payment.amount_paise,
    sum([payment.fee_paise, payment.gst_on_fee_paise]),
  );
  const posted = sum(
    observed.entries
      .filter((entry) => entry.account_code === ACCOUNT.SETTLEMENT_PENDING)
      .map((entry) => BigInt(entry.amount_paise)),
  );
  expect(subtract(posted, expected)).toBe(0n);
}

/* -------------------------------------------------------------------------- */
/* The property                                                               */
/* -------------------------------------------------------------------------- */

describe.skipIf(!reachable)('Property 1: ledger set balance', () => {
  const baseline = psqlStore('commit');

  beforeAll(async () => {
    const accounts = chartOfAccountsSeedRows(f.tenantId)
      .map(
        (a) =>
          `(${lit(a.tenant_id)}, ${lit(a.account_code)}, ${lit(a.account_name)}, ` +
          `${lit(a.kind)}::account_kind, ${a.is_active})`,
      )
      .join(',\n       ');
    runOk(
      `${provision(f)}
insert into chart_of_accounts (tenant_id, account_code, account_name, kind, is_active)
values ${accounts};`,
    );

    // One committed set, through the same store in commit mode, so the deferred trigger
    // fires at a real COMMIT and the balance map the imbalanced branch compares is not empty.
    const posted = await ledgerOver(baseline, recordingAuditSink()).postSet(
      f.tenantId,
      postingDraftFor({ type: 'payment', ...BASELINE }),
    );
    expect(posted).toMatchObject({ ok: true, created: true });
  });

  it('holds P1 for a committed set, read back after a real COMMIT', () => {
    const observed = requireObservation(baseline.observed);
    assertPersistedSetHoldsP1(observed);
    assertSettlementPendingIdentity(observed, BASELINE);
    // 100000 - 2360 - 424 = 97216, so the baseline is the 4-entry Payment shape.
    expect(observed.entries).toHaveLength(4);
    expect(readCommittedState().balances).toEqual(
      new Map([
        [ACCOUNT.SETTLEMENT_PENDING, 97_216n],
        [ACCOUNT.RAZORPAY_FEE_EXPENSE, 2_360n],
        [ACCOUNT.GST_INPUT_CREDIT, 424n],
        [ACCOUNT.REVENUE, -100_000n],
      ]),
    );
  });

  it('balances every persisted set at 0 paise, and persists nothing for an imbalanced draft', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryCase, async (testCase) => {
        const store = psqlStore('rollback');
        const ledger = ledgerOver(store, recordingAuditSink());

        if (testCase.kind === 'source') {
          const result = await ledger.postSet(f.tenantId, postingDraftFor(testCase.source));
          expect(result).toMatchObject({ ok: true, created: true });
          const observed = requireObservation(store.observed);
          assertPersistedSetHoldsP1(observed);
          if (testCase.source.type === 'payment') {
            assertSettlementPendingIdentity(observed, testCase.source);
          }
          return;
        }

        const identity = testCase.draft.source_refs[0];
        if (identity === undefined) {
          throw new Error('an imbalanced draft must still carry its derivation identity');
        }
        // Read before, from the database. The iteration writes nothing that commits, so an
        // unchanged map afterwards is the claim Requirement 2.6 makes.
        const before = readCommittedState();

        const result = await ledger.postSet(f.tenantId, testCase.draft);
        expect(result).toMatchObject({ ok: false, kind: 'unbalanced' });

        const after = readCommittedStateAt(identity);
        expect(after.derivationEntryCount).toBe(0);
        expect(after.entryCount).toBe(before.entryCount);
        expect(after.balances).toEqual(before.balances);
      }),
      PARAMS,
    );
  });

  it('rolled every generated iteration back, leaving only the committed baseline set', () => {
    const r = runOk(`${claims(f)}\n${tenantSetCountSelect}\n${tenantEntryCountSelect}`);
    expect(jsonAt<number>(r, 0)).toBe(1);
    expect(jsonAt<number>(r, 1)).toBe(4);
  });
});
