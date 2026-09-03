/**
 * The ledger read scope: the in-range Ledger_Entries a trial-balance Financial_Tool
 * grounds its figures in, and the chart-of-accounts lookup behind `account_name`
 * (task 12.3).
 *
 * `SemanticLedger.trialBalance` (task 8.4) is the algorithm: it aggregates the two
 * per-account totals **in SQL** and signs the closing balance per account kind.
 * Nothing in this module or in `./get-trial-balance.ts` recomputes any of that.
 *
 * What `trialBalance` cannot supply is *evidence*. Its own doc comment explains why
 * the summation lives in SQL — `ledger_entries_account_date_idx` exists for that
 * `GROUP BY`, and pulling every entry into TypeScript to add it up "would be both
 * slower and no more exact". True for the figure; not sufficient for the chain.
 * Requirement 12.2 wants every contributing Source_Record identifier and an ordered
 * step list whose operands name them, and a `GROUP BY` result names nothing. So a
 * trial-balance tool needs **two** reads over the same range: the aggregate that
 * produces the figures, and the entry list that grounds them.
 *
 * That is this module: {@link LedgerEntryScopeStore} is the entry-level seam, and
 * `./ledger-evidence.ts` turns its rows into steps. The tool then **cross-checks the
 * two reads against each other** — per account, per side — so an entry list that
 * disagrees with the aggregate is refused rather than presented as a trial balance
 * with plausible-looking evidence behind it. Two independent reads that must agree is
 * a stronger guarantee than one read trusted twice.
 *
 * ## The date range is `./settlement-scope.ts`'s `DateRange`, deliberately
 *
 * {@link DateRange}, `assertDateRange`, `assertDateOnlyValue`, `dateOnlyOf`,
 * `shiftDateOnly` and `rangeLengthInDays` are declared there (task 12.1) and are
 * imported here rather than redeclared. design.md names `DateRange` without declaring
 * it and 12.1 was the first tool to need it; a second declaration would let two tools
 * disagree about what an inclusive range is.
 *
 * **Reported**: the module that owns `DateRange` is named for settlements, so a ledger
 * tool importing `./settlement-scope` reads oddly. The right home is a
 * settlement-agnostic `src/tools/date-range.ts` that `settlement-scope.ts` re-exports.
 * That is a move across a file another task owns, so it is reported and not made here.
 *
 * ## What a trial-balance figure cites, and the enum label that does not exist
 *
 * Requirement 2.5's figures are sums over **Ledger_Entries**. `source_record_type`
 * (`20260101000003_semantic_ledger.sql`, transcribed as `SOURCE_RECORD_TYPES` in
 * `@/ledger/posting-rules`) declares 13 labels including `ledger_entry_set` and
 * **no `ledger_entry`**. So a Ledger_Entry is not directly citable, and inventing the
 * label would need a migration this task does not own.
 *
 * Resolved through the identity the schema already gives an entry:
 * `ledger_entries UNIQUE (set_id, line_no)`. A citation is therefore
 * `{ type: 'ledger_entry_set', id: set_id }` with the field
 * `line_<line_no>.amount_paise` — see `entrySetFieldFor` in `./ledger-evidence.ts`.
 * That pair is exact (one citation per entry, never two entries collapsing onto one
 * `evidence_chain_sources` row), it names a column that exists, and a replay reads a
 * single amount from a single row.
 *
 * **The Razorpay records behind a set are deliberately not cited.** A Ledger_Entry's
 * amount is *derived* from its Source_Records by the posting rules — the
 * settlement-pending amount is gross − fee − GST, for instance — so citing the Payment
 * and replaying from `payload->amount` would mean re-deriving the posting rules inside
 * the Evidence_Chain: more arithmetic, in a second place, that Requirement 12.8 would
 * then have to hold for. `ledger_entry_sources` links every entry to its Source_Records
 * (Requirement 2.2), so a drill-down reaches them in one hop from the cited set. Stated
 * as a decision because it is a reading of "contributing Source_Record", not a
 * derivation from it.
 *
 * ## `account_name` comes from the chart of accounts, and an unknown code is refused
 *
 * design.md's output states `account_name` and there is no chart-of-accounts read seam
 * anywhere in the tool layer. {@link accountNameOf} resolves it from
 * `DEFAULT_CHART_OF_ACCOUNTS`, which `chartOfAccountsSeedRows` seeds for every Tenant,
 * and **throws** for a code that chart does not hold rather than echoing the code as a
 * name or answering `null`.
 *
 * One live consequence is reported rather than smoothed over: a Tenant-defined
 * account refuses here. `chart_of_accounts` is a per-Tenant table, so the honest
 * fix is a chart read seam; that is a change to the tool's dependency shape and
 * belongs with whoever adds Tenant-editable accounts.
 *
 * Route accounts do not hit this path: `seller_payout_clearing` is part of the
 * seeded default chart alongside `settlement_pending`.
 *
 * Refusing beats inventing: `account_name` is what a User reads next to a figure, and a
 * display name guessed from a code is a statement about the Tenant's chart that
 * FinanceOS is not entitled to make.
 *
 * ## No live adapter, deliberately
 *
 * Same reason `LedgerStore`, `EvidenceChainStore` and `SettlementScopeStore` have none:
 * `ledger_entries` and `ledger_entry_sets` are `ENABLE`d **and** `FORCE`d for row-level
 * security with no policies until task 26.1, so PostgREST matches zero rows for every
 * role without `BYPASSRLS`. An adapter written today would silently answer "no entries"
 * for every Tenant, and the tool would then refuse every range as ungrounded.
 * {@link LedgerEntryScopeStore} is the seam; `test/db/ledger-postset.test.ts` and
 * `src/ledger/semantic-ledger.trialbalance.test.ts` are where the statements and the
 * aggregate are exercised today.
 */

import type { Paise } from '@/calc/paise';
import type { TenantId } from '@/config/configuration-service';
import {
  DEFAULT_CHART_OF_ACCOUNTS,
  type DateOnly,
  type SourceRef,
} from '@/ledger/posting-rules';

import type { DateRange } from './settlement-scope';

export type { DateRange, DateOnly };

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** Thrown when a scoped Ledger_Entry or an account code is malformed as stated. */
export class LedgerScopeError extends Error {
  override readonly name = 'LedgerScopeError';
}

/* -------------------------------------------------------------------------- */
/* One in-range Ledger_Entry, as the store hands it over                      */
/* -------------------------------------------------------------------------- */

/** The `entry_side` enum of `20260101000003_semantic_ledger.sql`. */
export const ENTRY_SIDES = ['debit', 'credit'] as const;

export type EntrySide = (typeof ENTRY_SIDES)[number];

/**
 * One Ledger_Entry dated inside the requested range, reduced to what an
 * Evidence_Chain step needs.
 *
 * `set_id` and `line_no` together are the entry's citable identity — see the module
 * doc comment. `amount_paise` is `paise_positive` in the schema, so it is always
 * `> 0n` and the direction is carried by {@link side}, never by a sign.
 *
 * `record_updated_at` is the entry's update timestamp as it stood when read. A
 * Ledger_Entry is append-only (Requirement 2.7) so an adapter maps it from
 * `ledger_entries.created_at`; it feeds the chain's `as_of` and the stale indicator,
 * both of which compare as strings, so it must be ISO-8601 UTC to millisecond
 * precision.
 */
export interface ScopedLedgerEntry {
  readonly account_code: string;
  /** `ledger_entries.set_id`. Cited as `{ type: 'ledger_entry_set', id: set_id }`. */
  readonly set_id: string;
  /** `ledger_entries.line_no`: `>= 1`, unique within the set. */
  readonly line_no: number;
  readonly side: EntrySide;
  readonly amount_paise: Paise;
  /** ISO-8601 UTC to millisecond precision. */
  readonly record_updated_at: string;
}

/* -------------------------------------------------------------------------- */
/* The read seam                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One scoped read. `tenant_id` comes from the session and is passed explicitly, never
 * accepted as a tool argument (Requirement 12.7).
 *
 * `range` is inclusive at both ends, exactly as `trialBalance`'s `from..to` is, so the
 * entry list and the aggregate cover the same dates by construction.
 */
export interface LedgerEntryScopeQuery {
  readonly tenant_id: TenantId;
  readonly range: DateRange;
}

/**
 * What the store answers.
 *
 * No counts: Requirement 2.5 asks for per-account totals and the two grand totals and
 * nothing about how many records were examined. `get_settlement_reconciliation` reports
 * examined counts because **Requirement 4.7** asks for them beside its figure; adding
 * them here would answer a question this tool was not asked.
 */
export interface LedgerEntryScopeResult {
  /** Every Ledger_Entry dated in the range, in any order. */
  readonly entries: readonly ScopedLedgerEntry[];
  /**
   * Source_Records the store knows contribute and could not read. Non-empty means
   * every figure is **omitted** and `incomplete_evidence` is returned instead
   * (Requirement 12.3).
   */
  readonly unreadable?: readonly SourceRef[];
}

/**
 * Where in-range Ledger_Entries come from. Injected rather than imported, for the
 * reason in the module doc comment: there is no live adapter until task 26.1.
 *
 * Three contracts every adapter owes:
 *
 * 1. **Tenant scoping is the query's, and rows outside it do not exist.** A
 *    cross-Tenant request answers zero rows, never a permission error
 *    (Requirement 14.4).
 * 2. **Every entry dated in the range, with no aggregation.** The aggregate is
 *    `LedgerStore.trialBalanceTotals`'s job; this seam exists to name the rows behind
 *    it, and a pre-summed answer could not be cross-checked against it.
 * 3. **`record_updated_at` is ISO-8601 UTC to millisecond precision.** `TIMESTAMPTZ`
 *    renders in the session time zone by default. Select it as
 *    `to_char(created_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`, and
 *    `amount_paise` as digit text decoded with `BigInt(...)`, never `Number(...)`.
 */
export interface LedgerEntryScopeStore {
  listEntriesInRange(query: LedgerEntryScopeQuery): Promise<LedgerEntryScopeResult>;
}

/**
 * Every unreadable Source_Record the store reported, in the order it reported them.
 *
 * Requirement 12.3 is range-wide rather than per-account: the two grand totals are
 * composed from every in-range entry, so one unreadable record withholds the whole
 * answer rather than one row of it.
 */
export function unreadableIn(result: LedgerEntryScopeResult): readonly SourceRef[] {
  return result.unreadable ?? [];
}

/* -------------------------------------------------------------------------- */
/* Grouping                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One account's in-range entries, split by side.
 *
 * Either list may be empty — an account can be debited in a range and never credited
 * in it — but never both: an account with no entry in the range has no row at all
 * (Requirement 2.5), so it is absent from {@link accountEntriesInOrder}'s answer.
 */
export interface AccountEntries {
  readonly account_code: string;
  readonly debits: readonly ScopedLedgerEntry[];
  readonly credits: readonly ScopedLedgerEntry[];
}

const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** `ledger_entry_sets.id` is a UUID; the citation is worthless if it is not one. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One entry, as stated, or a rejection naming what is wrong with it.
 *
 * Pure and total. Every check here is one a malformed adapter could otherwise turn
 * into a plausible-looking figure: a zero amount would sum to a total that no entry
 * supports, a `line_no` of 0 would cite a row the schema cannot hold, and a
 * locally-rendered timestamp would move `as_of` by five and a half hours.
 *
 * @throws {LedgerScopeError} for a malformed entry.
 */
export function assertScopedLedgerEntry(
  entry: ScopedLedgerEntry,
  what: string,
): ScopedLedgerEntry {
  if (typeof entry.account_code !== 'string' || entry.account_code.trim().length === 0) {
    throw new LedgerScopeError(
      `${what}.account_code must be a non-empty account code, got ${JSON.stringify(entry.account_code)}`,
    );
  }
  if (!UUID_RE.test(entry.set_id)) {
    throw new LedgerScopeError(
      `${what}.set_id must be the Ledger_Entry set identifier as a UUID, got ` +
        `${JSON.stringify(entry.set_id)}; it is what the Evidence_Chain cites`,
    );
  }
  if (!Number.isSafeInteger(entry.line_no) || entry.line_no < 1) {
    throw new LedgerScopeError(
      `${what}.line_no must be a whole ordinal >= 1, got ${String(entry.line_no)}: ` +
        `ledger_entries.line_no is CHECK (line_no >= 1) and (set_id, line_no) is what ` +
        `identifies the cited entry`,
    );
  }
  if (!(ENTRY_SIDES as readonly string[]).includes(entry.side)) {
    throw new LedgerScopeError(
      `${what}.side must be an entry_side label, got ${JSON.stringify(entry.side)}`,
    );
  }
  if (typeof entry.amount_paise !== 'bigint' || entry.amount_paise <= 0n) {
    throw new LedgerScopeError(
      `${what}.amount_paise must be integer paise greater than 0, got ` +
        `${String(entry.amount_paise)}: ledger_entries.amount_paise is the paise_positive ` +
        `domain and direction is carried by side`,
    );
  }
  if (typeof entry.record_updated_at !== 'string' || !ISO_UTC_MS.test(entry.record_updated_at)) {
    throw new LedgerScopeError(
      `${what}.record_updated_at must be ISO-8601 UTC to millisecond precision ` +
        `(YYYY-MM-DDTHH:MM:SS.sssZ), got ${JSON.stringify(entry.record_updated_at)}`,
    );
  }
  return entry;
}

/**
 * The in-range entries grouped by account, in a deterministic order: accounts
 * ascending by code, and each account's entries ascending by `(set_id, line_no)`.
 *
 * The order is load-bearing twice over. It fixes the operand sequence of every
 * Evidence_Chain step, so the chain — and therefore the whole answer — is a function
 * of the entry *set* rather than of the order the store happened to return rows in.
 * And ascending `account_code` is the order `trialBalance` sorts its rows into, so the
 * two reads line up positionally as well as by key.
 *
 * @throws {LedgerScopeError} for a malformed entry, or for two entries sharing one
 * `(set_id, line_no)` — that pair is `UNIQUE` in the schema and is the citation key,
 * so a repeat would collapse two amounts onto one `evidence_chain_sources` row and
 * silently under-cite the figure.
 */
export function accountEntriesInOrder(
  entries: readonly ScopedLedgerEntry[],
): readonly AccountEntries[] {
  const seen = new Set<string>();
  const byAccount = new Map<string, { debits: ScopedLedgerEntry[]; credits: ScopedLedgerEntry[] }>();

  for (const [position, entry] of entries.entries()) {
    assertScopedLedgerEntry(entry, `entries[${position}]`);
    // `\u0000` cannot appear in a Postgres text value, so it is a safe key joiner.
    const key = `${entry.set_id}\u0000${String(entry.line_no)}`;
    if (seen.has(key)) {
      throw new LedgerScopeError(
        `entries[${position}] repeats Ledger_Entry set ${entry.set_id} line ${entry.line_no}; ` +
          `ledger_entries is UNIQUE (set_id, line_no) and that pair is the Evidence_Chain ` +
          `citation key, so a repeat would cite one row for two amounts`,
      );
    }
    seen.add(key);

    const bucket = byAccount.get(entry.account_code) ?? { debits: [], credits: [] };
    if (entry.side === 'debit') {
      bucket.debits.push(entry);
    } else {
      bucket.credits.push(entry);
    }
    byAccount.set(entry.account_code, bucket);
  }

  const inCitationOrder = (
    left: ScopedLedgerEntry,
    right: ScopedLedgerEntry,
  ): number => {
    if (left.set_id !== right.set_id) {
      return left.set_id < right.set_id ? -1 : 1;
    }
    return left.line_no - right.line_no;
  };

  return [...byAccount.entries()]
    // The same comparison `trialBalance` sorts its rows with.
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([account_code, bucket]) => ({
      account_code,
      debits: [...bucket.debits].sort(inCitationOrder),
      credits: [...bucket.credits].sort(inCitationOrder),
    }));
}

/* -------------------------------------------------------------------------- */
/* The chart of accounts                                                      */
/* -------------------------------------------------------------------------- */

const ACCOUNT_NAMES: ReadonlyMap<string, string> = new Map(
  DEFAULT_CHART_OF_ACCOUNTS.map((account) => [account.account_code, account.account_name]),
);

/**
 * design.md's `account_name` for an account code, from the seeded chart of accounts.
 *
 * @throws {LedgerScopeError} for a code the seeded chart does not hold. See the module
 * doc comment for why this refuses rather than falling back to the code.
 */
export function accountNameOf(accountCode: string): string {
  const name = ACCOUNT_NAMES.get(accountCode);
  if (name === undefined) {
    throw new LedgerScopeError(
      `account ${JSON.stringify(accountCode)} holds Ledger_Entries in the requested range and ` +
        `the seeded chart of accounts states no account_name for it; the known codes are ` +
        `[${[...ACCOUNT_NAMES.keys()].join(', ')}]. A Tenant-defined account needs a chart ` +
        `read seam. A display name must not be guessed from a code`,
    );
  }
  return name;
}
