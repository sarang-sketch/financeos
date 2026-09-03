// Feature: financeos-control-tower, Property 13: Trial balance self-balance — for all
// generated ledgers and for all date ranges whose start date is on or before the end date,
// the trial balance's summed debit total equals its summed credit total in exact integer
// paise, and every account holding at least 1 Ledger_Entry dated within the inclusive range
// appears exactly once.
//
// **Validates: Requirements 2.5**
//
// WHY THIS FILE IS IN THE `property` PROJECT AND NOT IN `db`
// ---------------------------------------------------------
// design.md: "P1, P2, P7, P13 and P14 run against Supabase local because the invariants they
// assert are database-enforced". The trial balance is a `GROUP BY` over `BIGINT` served by
// `ledger_entries_account_date_idx`, and the inclusive `entry_date` range is a SQL predicate,
// so a fake store would prove neither the aggregation nor the range edges. CI stage 8 owns
// P1–P15, so the file sits with P1, P10, P11 and P12 rather than in `db`, whose 60 s
// `testTimeout` is the wrong bound for a database-backed property. The database is reached
// through `test/db/pg.ts`, and the whole describe block is gated on `database().reachable`.
//
// WHAT THE EXISTING EXAMPLE TESTS ALREADY PROVE, AND WHAT THIS ADDS
// ----------------------------------------------------------------
// `test/db/ledger-derivation-trial-balance.test.ts` (task 8.4) already covers, on one hand-
// built February ledger: the five-account row list with its kinds and closing figures;
// Σdebit = Σcredit at 237216 paise; a single-day range on the Payment date; a range entirely
// outside the data returning `rows: []` with `0n` totals; both bounds coinciding with entry
// dates, plus the one-day-inward control; and the IST month-boundary Payment. Every one of
// those is a **fixed** ledger and a **fixed** range.
//
// P13 adds the quantifiers. It generates 0..3 balanced sets per iteration over a 7-account
// chart that includes a `liability` and an `equity` account — kinds the default chart of
// accounts has no member of, so the example test cannot reach two of the five branches of
// the closing sign rule — crosses them with a generated range, and computes the expected
// in-range account set and per-account totals **in this file from the generated drafts**,
// independently of the query. It also drives shapes no example test has: several entries to
// one account on the same side, one account debited and credited within a single set (closing
// exactly `0n` while the account still appears once), and sets sharing an `entry_date` with
// the range boundary in both directions.
//
// WHERE THE GENERATORS LIVE
// -------------------------
// `arbitraryBalancedLedgerSet` and the date-window helpers are in
// `./balanced-ledger-set-generators.ts`, not in `./ledger-generators.ts`. That module (task
// 8.6) holds design.md's `arbitrarySourceRecord`, and everything in it flows through
// `postingDraftFor`, so every set it can produce is one of the three fixed posting shapes over
// the five accounts of `DEFAULT_CHART_OF_ACCOUNTS`. P13 needs sets those rules cannot produce —
// entries on a `liability` and an `equity` account, several entries to one account on one side,
// one account on both sides — which is a different input space with a different subject rather
// than a variant of `arbitrarySourceRecord`. Keeping it in its own file also means task 8.6 and
// task 8.7 landed side by side with nothing to merge. See that file's header.
//
// PER-ITERATION ROLLBACK, AND WHY THE AGGREGATION RUNS INSIDE THE TRANSACTION
// --------------------------------------------------------------------------
// design.md: "the database-backed properties reset state with a transaction rollback per
// iteration rather than a truncate". `ledger_entries` is append-only, so a committed
// iteration could not be undone at all. But a separate `psql` session cannot see uncommitted
// rows, and `test/db/pg.ts` opens one session per script — so the inserts and the aggregation
// have to be the **same** script:
//
//   begin; <claims> <set + entry + link inserts> set constraints all immediate;
//   <the GROUP BY> rollback;
//
// `SET CONSTRAINTS ALL IMMEDIATE` is what makes the generated sets provably balanced on disk:
// `ledger_entries_balance_check` is `DEFERRABLE INITIALLY DEFERRED` and fires at `COMMIT`,
// which never comes here, so it is forced after the last entry row is in and before the
// aggregation runs. Any error at all from the script fails the iteration, so an imbalanced or
// unstoreable generated set is a failure rather than something the aggregation silently
// skips.
//
// The aggregated rows are then handed to the real `trialBalance` through `LedgerStore`, which
// is the seam design.md puts the summation behind. So the figures under assertion came out of
// Postgres, and the signing, the exactly-once check and the ordering are the production
// service's.
//
// A COMMITTED BASELINE, SO THE AGGREGATION IS NOT ONLY READING ITS OWN TRANSACTION
// -------------------------------------------------------------------------------
// `beforeAll` commits ONE Payment set (4 entries, 2026-04-05, inside the data window)
// through the same insert path with `commit;` instead of `rollback;`. Every iteration's
// aggregation therefore spans committed and uncommitted rows, and the expected map includes
// it. It also guarantees at least one account is in range for any range covering 5 April, so
// the non-empty branch cannot quietly stop being reached. The last test re-reads committed
// state and asserts the Tenant still holds exactly that one set and its 4 entries, which is
// what proves the rollbacks rolled back.
//
// THE CLOSING SIGN RULE IS RESTATED HERE, NOT IMPORTED
// ---------------------------------------------------
// `semantic-ledger.ts` keeps `DEBIT_NORMAL_KINDS` module-private precisely so this file
// cannot assert the rule against the constant the implementation applies. {@link
// DEBIT_NORMAL_KINDS_RESTATED} below is written out independently — `asset` and `expense`
// close `debit − credit`, `liability`, `equity` and `income` close `credit − debit` — and the
// account's kind comes from {@link P13_CHART}, this file's own fixture, which is also what is
// seeded into `chart_of_accounts`. A separate test asserts `P13_CHART` agrees with
// `DEFAULT_CHART_OF_ACCOUNTS` on every account they share, so a change to the production
// chart breaks loudly instead of silently making the sign assertion vacuous.
//
// ITERATIONS AND SEED
// -------------------
// `numRuns: 100`, design.md's stated minimum; P13 is not one of the four properties raised to
// 1000. One iteration is exactly one `psql` session (~150 ms), so the property runs in about
// 20 s, next to P1's 151 s in the same project. The seed is explicit and committed.
//
// A DESIGN GAP, REPORTED RATHER THAN PATCHED
// -----------------------------------------
// `trialBalanceDebitTotalPaise` sums the per-account totals through the Calculation Service's
// range-checked `sum`, so a trial balance whose grand total exceeds `PAISE_MAX`
// (₹999,999,999,999.99) raises `PaiseRangeError` rather than returning a total — while each
// individual account total is a `BIGINT` in SQL and has no such ceiling. A real ledger can
// exceed that over a period. Requirement 2.5 and design.md's P13 assertion both take "the
// summed debit total" as a value that exists, and neither says what happens when the sum
// leaves the paise domain. This file stays inside the domain by capping each generated set's
// side total at `PAISE_MAX / 4` (3 sets plus the baseline), so the property tests the stated
// invariant rather than an unspecified overflow. The gap is task 8.7's finding, not its fix.
//
// NOT VACUOUS
// -----------
// Checked by falsification, twice, because a database-backed property that never reaches the
// database passes just as greenly as one that does. Both mutations were reverted, and no
// regression test is committed for either: the counterexamples came from deliberately broken
// code in this file, not from a defect in the system.
//
//   - Making the aggregation exclusive at the lower end (`e.entry_date > from` instead of
//     `>=`):
//
//       Error: Property failed after 1 tests
//       { seed: 20260407, path: "0:0", endOnFailure: true }
//       Counterexample: [{"sets":[],"range":{"from":"2026-04-05","to":"2026-04-05"},
//                         "shape":"boundary_coincident"}]
//       Shrunk 1 time(s)
//       Caused by: AssertionError: expected 0n to be 100000n // Object.is equality
//
//     The committed baseline's 4 accounts sit in an inclusive range that starts on their
//     entry date, and shrinking drives straight at the boundary-coincident shape — the one
//     design.md singles out and the one an off-by-one hides in. The `100000n` is the oracle's
//     grand debit total, computed in this file; the `0n` came out of Postgres. The same
//     mutation also failed the committed-baseline read-back test with
//     `expected [] to deeply equal [ [ 'gst_input_credit', …(4) ], …(3) ]`, and failed the
//     shape-coverage test with `expected 0 to be greater than 0` because no non-empty result
//     was ever reached.
//   - Flipping the restated sign rule so `income` is treated as debit-normal:
//
//       Error: Property failed after 1 tests
//       Counterexample: [{"sets":[],"range":{"from":"2026-04-05","to":"2026-04-05"},
//                         "shape":"boundary_coincident"}]
//       Shrunk 1 time(s)
//       Caused by: AssertionError: expected 100000n to be -100000n // Object.is equality
//
//     `revenue` is credited 100000 paise by the baseline, so the implementation closes it at
//     `credit − debit = 100000n` and the mutated restatement demanded `debit − credit`. The
//     sign assertion is therefore reached and is sensitive per kind.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { PAISE_MAX, type Paise } from '@/calc/calculation-service';
import type { Actor } from '@/config/configuration-service';
import {
  ACCOUNT,
  type AccountKind,
  type ChartOfAccount,
  type DateOnly,
  DEFAULT_CHART_OF_ACCOUNTS,
  type LedgerEntrySetDraft,
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
  type TrialBalance,
  trialBalanceCreditTotalPaise,
  trialBalanceDebitTotalPaise,
  type TrialBalanceQuery,
} from '@/ledger/semantic-ledger';
import { decodePaise } from '@/wire/paise-wire';
import {
  announceIfUnreachable,
  claims,
  database,
  jsonAt,
  jsonRows,
  lit,
  newFixture,
  provision,
  runOk,
  runScript,
} from '../db/pg';
import {
  arbitraryBalancedLedgerSet,
  arbitraryDateIn,
  type DateWindow,
  datesIn,
  shiftDate,
} from './balanced-ledger-set-generators';

announceIfUnreachable();

const reachable = database().reachable;
const f = newFixture();

/** design.md's stated minimum. P13 is not one of the four properties raised to 1000. */
const NUM_RUNS = 100;

/** Explicit and committed, so any counterexample is reproducible from this file alone. */
const SEED = 20260407;

const PARAMS = { numRuns: NUM_RUNS, seed: SEED } as const;

const ACTOR: Actor = { kind: 'user', id: 'usr_p13_property' };

/* -------------------------------------------------------------------------- */
/* The chart of accounts this file owns                                       */
/* -------------------------------------------------------------------------- */

/** A liability account. The default chart has none, so the sign rule needs one added. */
const CUSTOMER_ADVANCES = 'p13_customer_advances';
/** An equity account, for the same reason. */
const OWNER_EQUITY = 'p13_owner_equity';

/**
 * The 8 accounts this file seeds and generates entries over, with their kinds written out
 * literally.
 *
 * All five `account_kind` labels are represented. `DEFAULT_CHART_OF_ACCOUNTS` covers `asset`,
 * `expense` and `income` only, so without the two accounts added here two branches of the
 * closing sign rule would never be exercised by any test in the repository.
 *
 * `seller_payout_clearing` arrived in the production chart with the Route posting rules
 * (task 18.1) and is mirrored here as of the Slice 2 property gate (task 20). The
 * agreement test below is what caught its absence — it failed with
 * `expected undefined to be 'asset'` for `seller_payout_clearing`, which is the tripwire
 * this fixture was written to trip. Mirroring it rather than exempting it also means P13's
 * generated entries now span the Route clearing account.
 */
const P13_CHART: readonly ChartOfAccount[] = Object.freeze([
  { account_code: ACCOUNT.BANK, account_name: 'Bank', kind: 'asset' },
  { account_code: ACCOUNT.SETTLEMENT_PENDING, account_name: 'Settlement Pending', kind: 'asset' },
  {
    account_code: ACCOUNT.SELLER_PAYOUT_CLEARING,
    account_name: 'Seller Payout Clearing',
    kind: 'asset',
  },
  { account_code: ACCOUNT.GST_INPUT_CREDIT, account_name: 'GST Input Credit', kind: 'asset' },
  {
    account_code: ACCOUNT.RAZORPAY_FEE_EXPENSE,
    account_name: 'Razorpay Fee Expense',
    kind: 'expense',
  },
  { account_code: ACCOUNT.REVENUE, account_name: 'Revenue', kind: 'income' },
  { account_code: CUSTOMER_ADVANCES, account_name: 'Customer Advances', kind: 'liability' },
  { account_code: OWNER_EQUITY, account_name: 'Owner Equity', kind: 'equity' },
]);

const ACCOUNT_CODES: readonly string[] = P13_CHART.map((account) => account.account_code);

const KIND_OF: ReadonlyMap<string, AccountKind> = new Map(
  P13_CHART.map((account) => [account.account_code, account.kind]),
);

function kindOf(accountCode: string): AccountKind {
  const kind = KIND_OF.get(accountCode);
  if (kind === undefined) {
    throw new Error(`no fixture kind for account ${accountCode}`);
  }
  return kind;
}

/**
 * The closing sign rule, restated from Requirement 2.5 rather than imported.
 *
 * `semantic-ledger.ts` keeps its own `DEBIT_NORMAL_KINDS` private so that this assertion
 * cannot be made against the same constant the implementation applies. Asserting a rule
 * against itself proves nothing, so the rule is written out here a second time and the two
 * are only ever compared through their results.
 */
const DEBIT_NORMAL_KINDS_RESTATED: readonly AccountKind[] = ['asset', 'expense'];

/** `debit − credit` for a debit-normal account, `credit − debit` for a credit-normal one. */
function expectedClosingPaise(kind: AccountKind, debit: Paise, credit: Paise): Paise {
  return DEBIT_NORMAL_KINDS_RESTATED.includes(kind) ? debit - credit : credit - debit;
}

/* -------------------------------------------------------------------------- */
/* The data window, and the one committed set inside it                       */
/* -------------------------------------------------------------------------- */

/**
 * The bounded window every generated `entry_date` is drawn from.
 *
 * 10 days is deliberately small: a range drawn near it lands on a used date often, which is
 * what gives the boundary-coincident shape and the exactly-once claim their density. With at
 * most 3 generated sets plus the baseline, at most 4 of these 10 dates are ever occupied, so
 * a gap for the empty-range shape always exists.
 */
const DATA_WINDOW: DateWindow = { from: '2026-04-01', to: '2026-04-10' };

const WINDOW_DATES = datesIn(DATA_WINDOW);

/** 5 days either side of the window, so a spanning range can start or end outside it. */
const NEAR_WINDOW: DateWindow = {
  from: shiftDate(DATA_WINDOW.from, -5),
  to: shiftDate(DATA_WINDOW.to, 5),
};

const BASELINE_DATE: DateOnly = '2026-04-05';

/**
 * The committed baseline: a real Payment posting, so the committed rows were derived by the
 * production posting rules rather than by this file's generator.
 *
 * 100000 − 2360 − 424 = 97216, so it is the 4-entry Payment shape over `settlement_pending`,
 * `razorpay_fee_expense`, `gst_input_credit` and `revenue`.
 */
const BASELINE_DRAFT: LedgerEntrySetDraft = postingDraftFor({
  type: 'payment',
  payment_id: 'pay_p13_baseline',
  entry_date: BASELINE_DATE,
  amount_paise: 100_000n,
  fee_paise: 2_360n,
  gst_on_fee_paise: 424n,
});

/** At most 3 generated sets per iteration, so the whole iteration stays one `psql` session. */
const MAX_SETS = 3;

/**
 * The largest total either side of one generated set may reach.
 *
 * `PAISE_MAX / 4` keeps `3 × MAX_SIDE_TOTAL + baseline` inside the paise domain, so
 * `trialBalanceDebitTotalPaise` — which sums through the range-checked `sum` — has a value to
 * return. See the header's design-gap note.
 */
const MAX_SIDE_TOTAL: Paise = PAISE_MAX / 4n;

/* -------------------------------------------------------------------------- */
/* Generators                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A distinct derivation identity per set within an iteration.
 *
 * `ledger_set_derivation_uniq` is `UNIQUE (tenant_id, source_record_type, source_record_id)`,
 * and all of an iteration's sets go in inside one transaction, so two sets sharing an identity
 * would abort the whole script. Indexing by position makes a collision impossible, and every
 * iteration rolls back, so identities never collide across iterations either. None of them is
 * `pay_p13_baseline`.
 */
function identityFor(index: number): readonly SourceRef[] {
  return [{ type: 'payment', id: `pay_p13_generated_${index}` }];
}

const arbitrarySets: fc.Arbitrary<readonly LedgerEntrySetDraft[]> = fc
  .array(
    arbitraryBalancedLedgerSet({
      accountCodes: ACCOUNT_CODES,
      entryDate: arbitraryDateIn(DATA_WINDOW),
      maxLegs: 10,
      maxSideTotalPaise: MAX_SIDE_TOTAL,
    }),
    { minLength: 0, maxLength: MAX_SETS },
  )
  // An empty array is kept: a ledger holding only the committed baseline is a real case, and
  // it is the cheapest route to the zero-account result of assertion 5.
  .map((drafts) => drafts.map((draft, index) => ({ ...draft, source_refs: identityFor(index) })));

/** The four shapes design.md names, plus a general one so the middle of the space is covered. */
const RANGE_SHAPES = [
  'boundary_coincident',
  'single_day',
  'empty',
  'fully_outside',
  'spanning',
] as const;

type RangeShape = (typeof RANGE_SHAPES)[number];

interface DateRange {
  readonly from: DateOnly;
  readonly to: DateOnly;
}

interface ShapedRange {
  readonly range: DateRange;
  readonly shape: RangeShape;
}

interface Scenario extends ShapedRange {
  readonly sets: readonly LedgerEntrySetDraft[];
}

/** `from <= to`, which is the precondition design.md's statement quantifies over. */
function ordered(a: DateOnly, b: DateOnly): DateRange {
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

/** Walk forward from `start` while the next day is also unoccupied, at most `extra` days. */
function extendThroughFree(start: DateOnly, extra: number, free: readonly DateOnly[]): DateOnly {
  let end = start;
  for (let step = 0; step < extra; step += 1) {
    const next = shiftDate(end, 1);
    if (!free.includes(next)) {
      return end;
    }
    end = next;
  }
  return end;
}

/**
 * design.md's `arbitraryDateRange`, conditioned on the sets it will be applied to.
 *
 * The conditioning is what makes two of the four required shapes constructible at all: a
 * boundary can only coincide *exactly* with an entry date if the entry dates are already
 * known, and a range can only be guaranteed empty if the occupied dates are known. So the
 * scenario generator chains sets into ranges rather than crossing two independent generators.
 *
 *   - `boundary_coincident` — both bounds drawn from the dates actually occupied by the
 *     baseline and the generated sets. An off-by-one in an inclusive range shows up here and
 *     almost nowhere else.
 *   - `single_day` — `from === to`, anywhere in the window, so both the occupied and the
 *     unoccupied single day are reachable.
 *   - `empty` — a run of consecutive unoccupied days inside the window. The result is
 *     guaranteed to hold zero accounts while the range still sits in the middle of the data.
 *   - `fully_outside` — entirely before or entirely after the window.
 *   - `spanning` — anywhere in the window widened by 5 days each side.
 */
function arbitraryDateRange(sets: readonly LedgerEntrySetDraft[]): fc.Arbitrary<ShapedRange> {
  const occupied = [...new Set([BASELINE_DATE, ...sets.map((draft) => draft.entry_date)])].sort();
  const free = WINDOW_DATES.filter((date) => !occupied.includes(date));
  if (free.length === 0) {
    // 4 occupied dates at most against a 10-day window, so this is unreachable. It throws
    // rather than silently dropping the shape if the window or MAX_SETS ever changes.
    throw new Error(
      `no unoccupied date left in ${DATA_WINDOW.from}..${DATA_WINDOW.to}; the empty-range ` +
        `shape would silently stop occurring`,
    );
  }

  return fc.oneof(
    {
      weight: 4,
      arbitrary: fc
        .tuple(fc.constantFrom(...occupied), fc.constantFrom(...occupied))
        .map(([a, b]) => ({ range: ordered(a, b), shape: 'boundary_coincident' as const })),
    },
    {
      weight: 2,
      arbitrary: fc
        .constantFrom(...WINDOW_DATES)
        .map((day) => ({ range: { from: day, to: day }, shape: 'single_day' as const })),
    },
    {
      weight: 2,
      arbitrary: fc
        .tuple(fc.constantFrom(...free), fc.integer({ min: 0, max: 9 }))
        .map(([start, extra]) => ({
          range: { from: start, to: extendThroughFree(start, extra, free) },
          shape: 'empty' as const,
        })),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(fc.boolean(), fc.integer({ min: 1, max: 20 }), fc.integer({ min: 0, max: 10 }))
        .map(([before, gap, span]) => ({
          range: before
            ? {
                from: shiftDate(DATA_WINDOW.from, -(gap + span)),
                to: shiftDate(DATA_WINDOW.from, -gap),
              }
            : {
                from: shiftDate(DATA_WINDOW.to, gap),
                to: shiftDate(DATA_WINDOW.to, gap + span),
              },
          shape: 'fully_outside' as const,
        })),
    },
    {
      weight: 3,
      arbitrary: fc
        .tuple(arbitraryDateIn(NEAR_WINDOW), arbitraryDateIn(NEAR_WINDOW))
        .map(([a, b]) => ({ range: ordered(a, b), shape: 'spanning' as const })),
    },
  );
}

const arbitraryScenario: fc.Arbitrary<Scenario> = arbitrarySets.chain((sets) =>
  arbitraryDateRange(sets).map(({ range, shape }) => ({ sets, range, shape })),
);

/* -------------------------------------------------------------------------- */
/* SQL: the sets, the forced barrier, and the aggregation                     */
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

/** Every statement one `LedgerSetWrite` needs: the set row, its entries, and their links. */
function writeSql(write: LedgerSetWrite): string {
  const setId = randomUUID();
  const rows: readonly EntryRow[] = write.entries.map((entry) => ({
    id: randomUUID(),
    write: entry,
  }));
  return [
    setInsert(write, setId),
    entryInserts(write, setId, rows),
    sourceInserts(write, rows),
  ].join('\n');
}

/**
 * The aggregation of Requirement 2.5, tenant-scoped and inclusive at both ends.
 *
 * Joined FROM `ledger_entries`, so an account with no entry in the range produces no row at
 * all; joined TO `chart_of_accounts` for the `account_kind` the closing sign rule needs.
 * `SUM` runs over `BIGINT` and both totals leave as digit text, so no monetary value passes
 * through a JSON number or `Number(...)` (Requirement 15.1, 15.8).
 *
 * The tenant predicate is not optional: `test/db/append-only.test.ts`,
 * `ledger-postset.test.ts` and `ledger-derivation-trial-balance.test.ts` commit rows into
 * append-only tables that cannot be cleaned up, and some of them are dated inside this
 * window. Every figure this property asserts on is scoped to this run's fresh Tenant.
 */
function trialBalanceAggregate(range: DateRange): string {
  return jsonRows(
    `select e.account_code,
            coa.kind::text as kind,
            coalesce(sum(case when e.side = 'debit'
                              then e.amount_paise::bigint else 0::bigint end), 0)::bigint::text
              as total_debit_paise,
            coalesce(sum(case when e.side = 'credit'
                              then e.amount_paise::bigint else 0::bigint end), 0)::bigint::text
              as total_credit_paise
       from ledger_entries e
       join chart_of_accounts coa
         on coa.tenant_id = e.tenant_id and coa.account_code = e.account_code
      where e.tenant_id = ${lit(f.tenantId)}
        and e.entry_date >= ${lit(range.from)}::date
        and e.entry_date <= ${lit(range.to)}::date
      group by e.account_code, coa.kind
      order by e.account_code`,
  );
}

interface AggregateRow {
  readonly account_code: string;
  readonly kind: AccountKind;
  readonly total_debit_paise: string;
  readonly total_credit_paise: string;
}

function toAccountPeriodTotals(rows: readonly AggregateRow[]): readonly AccountPeriodTotals[] {
  return rows.map((row) => ({
    account_code: row.account_code,
    kind: row.kind,
    // Digit text in, `bigint` out.
    total_debit_paise: decodePaise(row.total_debit_paise),
    total_credit_paise: decodePaise(row.total_credit_paise),
  }));
}

/**
 * Insert every write, force the deferred balance trigger, aggregate, then throw the
 * transaction away.
 *
 * One session, so the aggregation sees this transaction's uncommitted rows on top of the
 * committed baseline. `SET CONSTRAINTS ALL IMMEDIATE` fires `ledger_entries_balance_check`
 * here rather than at a `COMMIT` that never comes, so a generated set that did not balance
 * on disk fails the iteration instead of being aggregated.
 */
function aggregateInRolledBackTransaction(
  writes: readonly LedgerSetWrite[],
  range: DateRange,
): readonly AccountPeriodTotals[] {
  const r = runScript(
    `begin;
${claims(f)}
${writes.map(writeSql).join('\n')}
set constraints all immediate;
${trialBalanceAggregate(range)}
rollback;`,
  );
  if (r.errors.length > 0) {
    throw new Error(`the generated ledger did not persist:\n${r.rawErr}`);
  }
  return toAccountPeriodTotals(jsonAt<readonly AggregateRow[]>(r, 0));
}

/** The same statements, committed. Used once, for the baseline. */
function commitWrite(write: LedgerSetWrite): void {
  runOk(
    `begin;
${claims(f)}
${writeSql(write)}
commit;`,
  );
}

/* -------------------------------------------------------------------------- */
/* The store seam                                                             */
/* -------------------------------------------------------------------------- */

interface CapturedAggregation {
  readonly from: DateOnly;
  readonly to: DateOnly;
  readonly rows: readonly AccountPeriodTotals[];
}

interface P13Store extends LedgerStore {
  /** Every `LedgerSetWrite` production `postSet` produced, in order. */
  readonly writes: LedgerSetWrite[];
  captured: CapturedAggregation | null;
}

/**
 * A store that buffers the writes and replays one already-aggregated result.
 *
 * `insertSet` cannot issue SQL here: an iteration's sets and its aggregation have to share one
 * transaction, and `test/db/pg.ts` gives each script its own session, so the SQL is emitted
 * once for the whole buffer by {@link aggregateInRolledBackTransaction}. What `postSet` still
 * contributes is real: `assertDraftWellFormed`, the balance check, and the draft-to-write
 * mapping that assigns `line_no` and attaches every Source_Record link to every entry. Posting
 * itself is P1's property, not this one.
 *
 * `trialBalanceTotals` refuses a range other than the one the aggregation ran over, so the
 * replay cannot silently answer a different question than the one asked.
 */
function p13Store(): P13Store {
  const store: P13Store = {
    writes: [],
    captured: null,

    insertSet(write: LedgerSetWrite): Promise<LedgerWriteOutcome> {
      store.writes.push(write);
      return Promise.resolve({ ok: true, set_id: randomUUID() });
    },

    findSourceRecord(): Promise<LedgerSourceRecord | null> {
      return Promise.reject(
        new Error('P13 posts drafts directly; findSourceRecord is P2 (task 8.6)'),
      );
    },

    findSet(): Promise<null> {
      return Promise.reject(new Error('P13 posts drafts directly; findSet is P14 (task 24.2)'));
    },

    trialBalanceTotals(query: TrialBalanceQuery): Promise<readonly AccountPeriodTotals[]> {
      const captured = store.captured;
      if (captured === null) {
        return Promise.reject(new Error('no aggregation was captured for this iteration'));
      }
      if (
        query.tenant_id !== f.tenantId ||
        query.from !== captured.from ||
        query.to !== captured.to
      ) {
        return Promise.reject(
          new Error(
            `trialBalance asked for ${query.from}..${query.to} but the aggregation ran over ` +
              `${captured.from}..${captured.to}`,
          ),
        );
      }
      return Promise.resolve(captured.rows);
    },
  };
  return store;
}

/**
 * An in-memory audit sink. `postSet` only appends on a rejection, and every draft this file
 * generates balances, so an appended event means a generated set was not balanced — asserted
 * in the property rather than assumed.
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
  return createSemanticLedger({ store, audit, actor: ACTOR });
}

/* -------------------------------------------------------------------------- */
/* The oracle, computed from the generated drafts and nothing else            */
/* -------------------------------------------------------------------------- */

interface SideTotals {
  readonly debit: Paise;
  readonly credit: Paise;
}

/**
 * design.md's `countDistinctAccountsInRange(sets, range)`, widened to carry each account's
 * expected two totals as well.
 *
 * Computed here from the generated drafts, with plain `bigint` addition and a lexicographic
 * date comparison — `YYYY-MM-DD` orders lexicographically exactly as it orders
 * chronologically. Nothing in here consults the query, the store or the service, so the
 * account count and the totals are an independent expectation rather than a restatement of
 * what came back.
 *
 * A set's `entry_date` is the date of every entry under it (`LedgerEntrySetDraft` carries one
 * date, and the write mapping stamps it on each entry), so a set is either wholly in range or
 * wholly out.
 */
function expectedAccountsInRange(
  drafts: readonly LedgerEntrySetDraft[],
  range: DateRange,
): Map<string, SideTotals> {
  const totals = new Map<string, SideTotals>();
  for (const draft of drafts) {
    if (draft.entry_date < range.from || draft.entry_date > range.to) {
      continue;
    }
    for (const entry of draft.entries) {
      const current = totals.get(entry.account_code) ?? { debit: 0n, credit: 0n };
      totals.set(
        entry.account_code,
        entry.side === 'debit'
          ? { debit: current.debit + entry.amount_paise, credit: current.credit }
          : { debit: current.debit, credit: current.credit + entry.amount_paise },
      );
    }
  }
  return totals;
}

function grandTotals(expected: ReadonlyMap<string, SideTotals>): SideTotals {
  let debit = 0n;
  let credit = 0n;
  for (const totals of expected.values()) {
    debit += totals.debit;
    credit += totals.credit;
  }
  return { debit, credit };
}

/** P13's assertion list, over one trial balance and its independent expectation. */
function assertTrialBalanceHoldsP13(
  balance: TrialBalance,
  expected: ReadonlyMap<string, SideTotals>,
): void {
  // 1. Σdebit === Σcredit, exact bigint equality, no tolerance.
  const debitTotal = trialBalanceDebitTotalPaise(balance);
  const creditTotal = trialBalanceCreditTotalPaise(balance);
  expect(debitTotal).toBe(creditTotal);

  // The same two totals against the oracle, so a fault that moved both sides equally is
  // still visible.
  const oracle = grandTotals(expected);
  expect(debitTotal).toBe(oracle.debit);
  expect(creditTotal).toBe(oracle.credit);

  // 2. Exactly the in-range accounts, counted from the generated sets.
  expect(balance.rows.length).toBe(expected.size);

  // 3. Each account exactly once — asserted on distinctness, not only on the length.
  const codes = balance.rows.map((row) => row.account_code);
  expect(new Set(codes).size).toBe(codes.length);

  for (const row of balance.rows) {
    const want = expected.get(row.account_code);
    expect(want).toBeDefined();
    if (want === undefined) {
      continue;
    }
    expect(row.total_debit_paise).toBe(want.debit);
    expect(row.total_credit_paise).toBe(want.credit);
    // An in-range account held at least 1 entry, and every amount is `paise_positive`.
    expect(row.total_debit_paise + row.total_credit_paise > 0n).toBe(true);

    // 4. The closing sign rule, per kind, restated in this file.
    const kind = kindOf(row.account_code);
    expect(row.kind).toBe(kind);
    expect(row.closing_balance_paise).toBe(
      expectedClosingPaise(kind, row.total_debit_paise, row.total_credit_paise),
    );
  }

  // 5. An empty range: zero accounts, both totals `0n`. Not null, not absent.
  if (expected.size === 0) {
    expect(Array.isArray(balance.rows)).toBe(true);
    expect(balance.rows).toEqual([]);
    expect(balance.rows.length).toBe(0);
    expect(debitTotal).toBe(0n);
    expect(creditTotal).toBe(0n);
  }
}

/* -------------------------------------------------------------------------- */
/* Shape coverage, so no required shape can silently stop occurring           */
/* -------------------------------------------------------------------------- */

const shapeTally = new Map<RangeShape, number>();
/** Iterations whose range held zero in-range accounts, and iterations that held some. */
const resultTally = { empty: 0, nonEmpty: 0 };
/** Iterations where at least one account was both debited and credited in range. */
let bothSidesSeen = 0;
/** Kinds actually reached by a reported row, so all five branches are provably exercised. */
const kindsSeen = new Set<AccountKind>();

function tally(shape: RangeShape): void {
  shapeTally.set(shape, (shapeTally.get(shape) ?? 0) + 1);
}

/* -------------------------------------------------------------------------- */

describe.skipIf(!reachable)('Property 13: trial balance self-balance', () => {
  beforeAll(async () => {
    const accounts = P13_CHART.map(
      (a) =>
        `(${lit(f.tenantId)}, ${lit(a.account_code)}, ${lit(a.account_name)}, ` +
        `${lit(a.kind)}::account_kind, true)`,
    ).join(',\n       ');

    runOk(
      `${provision(f)}
insert into chart_of_accounts (tenant_id, account_code, account_name, kind, is_active)
values ${accounts};`,
    );

    // The baseline goes through production `postSet`, then its write is committed, so every
    // iteration's aggregation spans committed and uncommitted rows.
    const store = p13Store();
    const audit = recordingAuditSink();
    const posted = await ledgerOver(store, audit).postSet(f.tenantId, BASELINE_DRAFT);
    expect(posted).toMatchObject({ ok: true, created: true });
    expect(audit.events).toEqual([]);
    const write = store.writes[0];
    if (write === undefined) {
      throw new Error('postSet reported success without producing a write');
    }
    commitWrite(write);
  });

  it('agrees with the production chart of accounts on every account they share', () => {
    for (const account of DEFAULT_CHART_OF_ACCOUNTS) {
      expect(KIND_OF.get(account.account_code)).toBe(account.kind);
    }
    // The two accounts this file adds are the kinds the production chart has no member of.
    expect(KIND_OF.get(CUSTOMER_ADVANCES)).toBe('liability');
    expect(KIND_OF.get(OWNER_EQUITY)).toBe('equity');
    expect(new Set(P13_CHART.map((a) => a.kind)).size).toBe(5);
  });

  it('reads the committed baseline back through the aggregation and the service', async () => {
    const store = p13Store();
    const range: DateRange = { from: BASELINE_DATE, to: BASELINE_DATE };
    store.captured = { ...range, rows: aggregateInRolledBackTransaction([], range) };
    const balance = await ledgerOver(store, recordingAuditSink()).trialBalance(
      f.tenantId,
      range.from,
      range.to,
    );

    expect(
      balance.rows.map((row) => [
        row.account_code,
        row.kind,
        row.total_debit_paise,
        row.total_credit_paise,
        row.closing_balance_paise,
      ]),
    ).toEqual([
      [ACCOUNT.GST_INPUT_CREDIT, 'asset', 424n, 0n, 424n],
      [ACCOUNT.RAZORPAY_FEE_EXPENSE, 'expense', 2_360n, 0n, 2_360n],
      [ACCOUNT.REVENUE, 'income', 0n, 100_000n, 100_000n],
      [ACCOUNT.SETTLEMENT_PENDING, 'asset', 97_216n, 0n, 97_216n],
    ]);
    assertTrialBalanceHoldsP13(balance, expectedAccountsInRange([BASELINE_DRAFT], range));
  });

  it('self-balances over every generated ledger and every date range', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryScenario, async ({ sets, range, shape }) => {
        tally(shape);

        const store = p13Store();
        const audit = recordingAuditSink();
        const ledger = ledgerOver(store, audit);

        // Production `postSet` turns each draft into the write the schema takes.
        for (const draft of sets) {
          const posted = await ledger.postSet(f.tenantId, draft);
          expect(posted).toMatchObject({ ok: true, created: true });
        }
        // Every generated set balances, so nothing is ever rejected and nothing is audited.
        expect(audit.events).toEqual([]);
        expect(store.writes.length).toBe(sets.length);

        store.captured = {
          ...range,
          rows: aggregateInRolledBackTransaction(store.writes, range),
        };

        const balance = await ledger.trialBalance(f.tenantId, range.from, range.to);
        expect(balance.from).toBe(range.from);
        expect(balance.to).toBe(range.to);

        const expected = expectedAccountsInRange([BASELINE_DRAFT, ...sets], range);
        assertTrialBalanceHoldsP13(balance, expected);

        if (expected.size === 0) {
          resultTally.empty += 1;
        } else {
          resultTally.nonEmpty += 1;
        }
        for (const row of balance.rows) {
          kindsSeen.add(row.kind);
          if (row.total_debit_paise > 0n && row.total_credit_paise > 0n) {
            bothSidesSeen += 1;
          }
        }
      }),
      PARAMS,
    );
  });

  it('exercised all four date-range shapes design.md names, and all five account kinds', () => {
    console.warn(
      `[P13] range shapes ${JSON.stringify(Object.fromEntries(shapeTally))}; ` +
        `results ${JSON.stringify(resultTally)}; ` +
        `kinds ${JSON.stringify([...kindsSeen].sort())}; ` +
        `accounts moved on both sides in range: ${bothSidesSeen}`,
    );
    for (const shape of RANGE_SHAPES) {
      expect(shapeTally.get(shape) ?? 0).toBeGreaterThan(0);
    }
    // Both outcomes of assertion 5 were reached: some ranges held nothing, some held rows.
    expect(resultTally.empty).toBeGreaterThan(0);
    expect(resultTally.nonEmpty).toBeGreaterThan(0);
    // All five branches of the closing sign rule were reported on.
    expect([...kindsSeen].sort()).toEqual(['asset', 'equity', 'expense', 'income', 'liability']);
    // At least one account was debited and credited within the range, so `closing` was
    // asserted on a genuine difference rather than only on a one-sided total.
    expect(bothSidesSeen).toBeGreaterThan(0);
  });

  it('rolled every generated iteration back, leaving only the committed baseline set', () => {
    const r = runOk(
      `${claims(f)}
select to_jsonb((select count(*)::int from ledger_entry_sets
 where tenant_id = ${lit(f.tenantId)}))::text;
select to_jsonb((select count(*)::int from ledger_entries
 where tenant_id = ${lit(f.tenantId)}))::text;`,
    );
    expect(jsonAt<number>(r, 0)).toBe(1);
    expect(jsonAt<number>(r, 1)).toBe(4);
  });
});
