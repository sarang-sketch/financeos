/**
 * The double-entry posting rules: Source_Record in, balanced draft out.
 *
 * Pure and synchronous, with one exception that is marked as such
 * ({@link seedChartOfAccounts}, the only function here that touches the
 * database). Everything else is a total function of its argument, so task 8.2's
 * unit tests and task 8.5's property test P1 can drive the derivation with no
 * Supabase local running.
 *
 * The five tables below implement design.md's "Double-entry posting rules"
 * (Requirements 2.1-2.3, 2.9, 2.10, 7.1, 7.2). `N`, `F`, `G`, `A`, `R`,
 * `S`, `T`, and `V` are the names design.md uses.
 *
 * **Payment** — gross `A`, Razorpay_Fee `F`, GST_On_Fee `G`, net `N = A − F − G`:
 *
 * | Side | Account | Amount |
 * |---|---|---|
 * | Debit | `settlement_pending` | `N` |
 * | Debit | `razorpay_fee_expense` | `F` |
 * | Debit | `gst_input_credit` | `G` |
 * | Credit | `revenue` | `A` |
 *
 * **Refund** — amount `R`, designations opposite to the Payment set:
 *
 * | Side | Account | Amount |
 * |---|---|---|
 * | Debit | `revenue` | `R` |
 * | Credit | `settlement_pending` | `R` |
 *
 * **Settlement** — received amount `S`:
 *
 * | Side | Account | Amount |
 * |---|---|---|
 * | Debit | `bank` | `S` |
 * | Credit | `settlement_pending` | `S` |
 *
 * **Transfer** — Route split amount `T`:
 *
 * | Side | Account | Amount |
 * |---|---|---|
 * | Debit | `seller_payout_clearing` | `T` |
 * | Credit | `settlement_pending` | `T` |
 *
 * **Transfer_Reversal** — this reversal's own amount `V`:
 *
 * | Side | Account | Amount |
 * |---|---|---|
 * | Debit | `settlement_pending` | `V` |
 * | Credit | `seller_payout_clearing` | `V` |
 *
 * ## Why Σdebit = Σcredit holds by construction, not by check
 *
 * For a Payment, `N` is *defined* as `A − F − G`, so `N + F + G = A` is an
 * identity of the definition rather than a coincidence of the inputs. There is
 * no rounding step anywhere in the path — `subtract` is exact integer `bigint`
 * arithmetic — so the difference is 0 paise for every input the rules accept,
 * which is exactly what property P1 asserts. Refund, Settlement, Transfer, and
 * Transfer_Reversal post one amount twice with opposite designations, so those
 * balance for the same reason a mirror is symmetric.
 *
 * `subtract` and `sum` from `src/calc/calculation-service.ts` are used for every
 * step. Nothing here writes a bare `-` or `+` on a monetary value: the
 * calculation service range-checks each operand, each intermediate, and each
 * result, so an out-of-range net raises {@link PaiseRangeError} instead of
 * flowing into a draft (Requirement 15.1, 15.8).
 *
 * ## Zero-amount entries are omitted, never posted
 *
 * `ledger_entries.amount_paise` is the `paise_positive` domain (`VALUE > 0`), so
 * a 0-paise entry is not a small wart — the database rejects the row outright.
 * The rules therefore drop any component that came out at 0 rather than emitting
 * it. A Payment with no fee (`F = 0`, `G = 0`) produces a 2-entry set — debit
 * `settlement_pending` `A`, credit `revenue` `A` — which still satisfies
 * `entry_count BETWEEN 2 AND 20`, and one with a fee but no GST produces 3.
 *
 * The floor matters as much as the ceiling: 2 is the minimum, so a source whose
 * gross amount is 0 has no valid posting at all and raises
 * {@link PostingRuleError} rather than silently drafting a 0- or 1-entry set for
 * `postSet` to reject later.
 *
 * ## Direction is carried by `side`
 *
 * Every `amount_paise` in a draft is strictly positive. A reduction of an
 * account is a `credit` entry, never a negative debit. That is what makes the
 * Refund set "opposite designations to the Payment set" meaningful, and it is
 * what the `paise_positive` domain enforces at the storage layer.
 *
 * ## Source_Record links
 *
 * Requirement 2.2 wants at least 1 Source_Record link per Ledger_Entry.
 * `LedgerEntrySetDraft` carries `source_refs` at the set level, matching
 * design.md's interface, and `postSet` (task 8.3) links every entry of the set
 * to every ref on it — so "at least 1 per entry" holds by construction as long
 * as `source_refs` is non-empty, which {@link assertDraftWellFormed} checks.
 * Each rule emits the refs design.md names for it, and **the first ref is the
 * derivation identity**: it is the `(source_record_type, source_record_id)` pair
 * that `ledger_set_derivation_uniq` is declared on, which is why the Refund set
 * leads with the Refund rather than the refunded Payment.
 *
 * ## Scope
 *
 * `postSet`, `postFromSource`, `trialBalance` and `reverseSet` are tasks 8.3,
 * 8.4 and 24.1. The shared types ({@link SourceRef},
 * {@link LedgerEntrySetDraft}) are declared here because this is the first module
 * that needs them; 8.3 imports them from here rather than redeclaring them.
 */

import { assertInRange, type Paise, subtract, sum } from '@/calc/calculation-service';
import type { ScopedServiceClient } from '@/db/clients';

// ---------------------------------------------------------------------------
// Shared types (design.md, "Shared types used throughout")
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD`, the `DATE` columns of `ledger_entry_sets` and `ledger_entries`. */
export type DateOnly = string;

/** The 13 labels of the `source_record_type` enum, in migration order. */
export const SOURCE_RECORD_TYPES = [
  'payment',
  'order',
  'refund',
  'settlement',
  'settlement_recon_report',
  'transfer',
  'transfer_reversal',
  'razorpay_invoice',
  'credit_note',
  'linked_account',
  'ledger_entry_set',
  'proposal',
  'forecast_component',
] as const;

export type SourceRecordType = (typeof SOURCE_RECORD_TYPES)[number];

/** One Source_Record link: the type and the identifier the amount was read from. */
export interface SourceRef {
  readonly type: SourceRecordType;
  readonly id: string;
}

/** One drafted Ledger_Entry. `amount_paise` is always `> 0`; direction is `side`. */
export interface LedgerEntryDraft {
  readonly account_code: string;
  readonly side: 'debit' | 'credit';
  readonly amount_paise: Paise;
}

/**
 * design.md's `LedgerEntrySetDraft`. `source_refs` holds at least 1 ref and its
 * first element is the derivation identity; `entries` holds 2..20 entries, each
 * with a strictly positive amount.
 */
export interface LedgerEntrySetDraft {
  readonly source_refs: readonly SourceRef[];
  readonly entry_date: DateOnly;
  readonly entries: readonly LedgerEntryDraft[];
  readonly reverses_set_id?: string;
}

// ---------------------------------------------------------------------------
// The default chart of accounts (Requirement 2.1)
// ---------------------------------------------------------------------------

/** The `account_kind` enum of `20260101000003_semantic_ledger.sql`. */
export type AccountKind = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

/** One row of `chart_of_accounts`, less the Tenant. */
export interface ChartOfAccount {
  readonly account_code: string;
  readonly account_name: string;
  readonly kind: AccountKind;
}

/**
 * The account codes the posting rules use. Referenced through this object rather
 * than as loose strings so a typo is a compile error and so the seed below and
 * the rules cannot drift apart.
 */
export const ACCOUNT = {
  BANK: 'bank',
  SETTLEMENT_PENDING: 'settlement_pending',
  SELLER_PAYOUT_CLEARING: 'seller_payout_clearing',
  GST_INPUT_CREDIT: 'gst_input_credit',
  RAZORPAY_FEE_EXPENSE: 'razorpay_fee_expense',
  REVENUE: 'revenue',
} as const;

/**
 * The default chart of accounts seeded for every Tenant.
 *
 * The `kind` of each account is load-bearing rather than descriptive: property
 * P13 asserts that a trial balance closes `debits − credits` for `asset` and
 * `expense` accounts and `credits − debits` for `liability`, `equity` and
 * `income`. A miscategorised account makes P13 fail in a way that reads like an
 * arithmetic fault in `trialBalance`, so the reasoning is recorded per account:
 *
 * - `bank` — **asset.** Settled cash held at the bank. Debited by a Settlement,
 *   so it accumulates on the debit side.
 * - `settlement_pending` — **asset.** A receivable from Razorpay: money captured
 *   from a customer and owed to the Tenant but not yet settled. Debited by a
 *   Payment (the receivable arises) and credited by the Settlement that clears
 *   it, so a fully settled Payment leaves it at 0. It is deliberately not a
 *   liability: the Tenant is the party owed.
 * - `seller_payout_clearing` — **asset.** Route amounts allocated to Linked_Accounts
 *   are moved here from `settlement_pending`. A Transfer debits the clearing
 *   account, and a Transfer_Reversal credits it by the reversal's own amount,
 *   so the account tracks the net seller allocation on the debit side.
 * - `gst_input_credit` — **asset.** Input tax credit on the Razorpay_Fee is
 *   recoverable against output GST, which makes it a claim on the tax
 *   authority rather than a cost. Debited as the credit accrues.
 * - `razorpay_fee_expense` — **expense.** The fee itself is consumed, not
 *   recoverable. Debited.
 * - `revenue` — **income.** Credited by a Payment at gross and debited by a
 *   Refund, so it closes `credits − debits`, which is positive for a Tenant
 *   taking more payments than refunds.
 *
 * The Route posting rules use both `seller_payout_clearing` and
 * `settlement_pending`; both are included in this seed so every drafted account
 * exists before persistence.
 */
export const DEFAULT_CHART_OF_ACCOUNTS: readonly ChartOfAccount[] = Object.freeze([
  { account_code: ACCOUNT.BANK, account_name: 'Bank', kind: 'asset' },
  {
    account_code: ACCOUNT.SETTLEMENT_PENDING,
    account_name: 'Settlement Pending',
    kind: 'asset',
  },
  {
    account_code: ACCOUNT.SELLER_PAYOUT_CLEARING,
    account_name: 'Seller Payout Clearing',
    kind: 'asset',
  },
  {
    account_code: ACCOUNT.GST_INPUT_CREDIT,
    account_name: 'GST Input Credit',
    kind: 'asset',
  },
  {
    account_code: ACCOUNT.RAZORPAY_FEE_EXPENSE,
    account_name: 'Razorpay Fee Expense',
    kind: 'expense',
  },
  { account_code: ACCOUNT.REVENUE, account_name: 'Revenue', kind: 'income' },
]);

/** One `chart_of_accounts` row, Tenant included, ready to insert. */
export interface ChartOfAccountRow extends ChartOfAccount {
  readonly tenant_id: string;
  readonly is_active: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown when the chart of accounts cannot be seeded for a Tenant. */
export class ChartOfAccountsSeedError extends Error {
  override readonly name = 'ChartOfAccountsSeedError';
}

/**
 * The `chart_of_accounts` rows for one Tenant. Pure, so a caller can insert them
 * through any path and a test can assert on them without a database.
 *
 * @throws {ChartOfAccountsSeedError} when `tenantId` is not a UUID. The Tenant is
 * half of the primary key and the whole of the RLS predicate; a malformed one
 * must not reach a write.
 */
export function chartOfAccountsSeedRows(tenantId: string): readonly ChartOfAccountRow[] {
  if (!UUID_RE.test(tenantId)) {
    throw new ChartOfAccountsSeedError(
      `chart of accounts seed requires a Tenant identifier as a UUID, got ${JSON.stringify(tenantId)}`,
    );
  }
  return DEFAULT_CHART_OF_ACCOUNTS.map((account) => ({
    tenant_id: tenantId,
    account_code: account.account_code,
    account_name: account.account_name,
    kind: account.kind,
    is_active: true,
  }));
}

/**
 * Seed the default chart of accounts for a Tenant. The one function in this
 * module that performs I/O.
 *
 * **Idempotent by the primary key, not by a pre-read.** `chart_of_accounts` is
 * `PRIMARY KEY (tenant_id, account_code)`, and the upsert is issued with
 * `ignoreDuplicates`, which PostgREST renders as `ON CONFLICT DO NOTHING`. So
 * re-seeding a Tenant inserts 0 rows and raises nothing — no duplicate-key
 * error, and no "check then insert" race between two provisioning attempts.
 *
 * `DO NOTHING` rather than `DO UPDATE` is the deliberate half of that choice: an
 * operator who renames an account or deactivates one keeps the change across a
 * re-seed. The seed establishes the default chart; it does not own it
 * afterwards.
 *
 * **RLS note.** `chart_of_accounts` is `FORCE ROW LEVEL SECURITY` and its
 * policies do not land until task 26.1, so today this insert matches no policy
 * for `authenticated` or `service_role` and only a `BYPASSRLS` connection can
 * execute it. Nothing here weakens that — fail-closed is the correct direction —
 * and once 26.1 lands, the service client this takes is the right caller.
 *
 * @throws {ChartOfAccountsSeedError} when the Tenant is malformed or the insert
 * is rejected.
 */
export async function seedChartOfAccounts(scoped: ScopedServiceClient): Promise<void> {
  const rows = chartOfAccountsSeedRows(scoped.tenantId);
  const { error } = await scoped.client
    .from('chart_of_accounts')
    .upsert(rows, { onConflict: 'tenant_id,account_code', ignoreDuplicates: true });
  if (error !== null) {
    throw new ChartOfAccountsSeedError(
      `chart of accounts seed rejected for Tenant ${scoped.tenantId}: ${error.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Posting rule inputs and errors
// ---------------------------------------------------------------------------

/**
 * Why a Source_Record has no valid posting. Distinct from
 * {@link PaiseRangeError}, which means "arithmetically out of range"; these all
 * mean "in range, but no balanced 2..20-entry set exists for it".
 */
export type PostingRuleViolation =
  /** A gross amount of 0 paise: every entry would be omitted, leaving fewer than 2. */
  | 'zero_amount'
  /** A negative component. Razorpay amounts are unsigned and `paise_positive` is `> 0`. */
  | 'negative_amount'
  /** `F + G > A`, so the net would be a negative `settlement_pending` debit. */
  | 'fee_exceeds_amount'
  /** A blank Source_Record identifier: the link would identify nothing. */
  | 'empty_identifier'
  /** An `entry_date` that is not a real `YYYY-MM-DD` calendar date. */
  | 'invalid_entry_date'
  /** Fewer than 2 or more than 20 entries, or a non-positive amount, in a draft. */
  | 'entry_count_out_of_range'
  /** A draft with no Source_Record refs, so an entry could not be linked. */
  | 'missing_source_ref';

/** Thrown when a Source_Record admits no balanced Ledger_Entry set. */
export class PostingRuleError extends RangeError {
  override readonly name = 'PostingRuleError';
  readonly violation: PostingRuleViolation;

  constructor(violation: PostingRuleViolation, message: string) {
    super(message);
    this.violation = violation;
  }
}

/** A stored Payment Source_Record, as the posting rules need it (Requirement 2.3). */
export interface PaymentPosting {
  /** The Razorpay Payment identifier. Becomes the derivation identity of the set. */
  readonly payment_id: string;
  readonly entry_date: DateOnly;
  /** Gross `A`, integer paise, read from the stored Payment with no scaling. */
  readonly amount_paise: Paise;
  /** Razorpay_Fee `F`. `0n` when the Payment carries no fee. */
  readonly fee_paise: Paise;
  /** GST_On_Fee `G`. `0n` when there is no GST on the fee. */
  readonly gst_on_fee_paise: Paise;
}

/** A stored Refund Source_Record (Requirement 2.9). */
export interface RefundPosting {
  readonly refund_id: string;
  /** The refunded Payment. Requirement 2.9 wants both identifiers linked. */
  readonly payment_id: string;
  readonly entry_date: DateOnly;
  /** Refund amount `R`, integer paise. */
  readonly amount_paise: Paise;
}

/** A stored Settlement Source_Record (Requirement 2.10). */
export interface SettlementPosting {
  readonly settlement_id: string;
  /**
   * The Settlement_Recon_Report for this Settlement. Requirement 2.10 wants it
   * linked alongside the Settlement, so pass it whenever the report has been
   * ingested; `null` is accepted only for the case where it has not, and then
   * the set carries the Settlement link alone.
   */
  readonly settlement_recon_report_id: string | null;
  readonly entry_date: DateOnly;
  /** The received amount `S`, integer paise — not the expected amount. */
  readonly received_amount_paise: Paise;
}

/** A stored Transfer Source_Record (Requirements 2.1, 7.1). */
export interface TransferPosting {
  readonly transfer_id: string;
  readonly entry_date: DateOnly;
  /** Route split amount `T`, integer paise. */
  readonly amount_paise: Paise;
}

/** A stored Transfer_Reversal Source_Record (Requirements 2.1, 7.2). */
export interface TransferReversalPosting {
  readonly transfer_reversal_id: string;
  readonly entry_date: DateOnly;
  /** This reversal's own amount `V`, including when it is a partial reversal. */
  readonly reversed_amount_paise: Paise;
}

/** The Source_Records covered by the five posting tables. */
export type PostingSource =
  | ({ readonly type: 'payment' } & PaymentPosting)
  | ({ readonly type: 'refund' } & RefundPosting)
  | ({ readonly type: 'settlement' } & SettlementPosting)
  | ({ readonly type: 'transfer' } & TransferPosting)
  | ({ readonly type: 'transfer_reversal' } & TransferReversalPosting);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A real `YYYY-MM-DD` calendar date, or {@link PostingRuleError}
 * `invalid_entry_date`.
 *
 * Exported because `trialBalance` (task 8.4) has to hold the two ends of its date
 * range to exactly the rule a draft's `entry_date` is held to. A second date
 * checker there could drift from this one; one cannot. `field` names which date is
 * being checked, so the message says `from` or `to` rather than always
 * `entry_date`.
 */
export function assertDateOnly(value: DateOnly, field = 'entry_date'): void {
  if (!DATE_ONLY_RE.test(value)) {
    throw new PostingRuleError(
      'invalid_entry_date',
      `${field} must be YYYY-MM-DD, got ${JSON.stringify(value)}`,
    );
  }
  // Fixed offsets, safe because the shape is already `YYYY-MM-DD`. These are
  // date components, never monetary values, so `number` is correct here.
  const year = Number.parseInt(value.slice(0, 4), 10);
  const month = Number.parseInt(value.slice(5, 7), 10);
  const day = Number.parseInt(value.slice(8, 10), 10);
  // Round-trip through a UTC date so 2025-02-30 and 2025-13-01 are rejected
  // rather than silently normalised the way `new Date(...)` would.
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    throw new PostingRuleError(
      'invalid_entry_date',
      `${field} is not a real calendar date: ${value}`,
    );
  }
}

function assertEntryDate(entryDate: DateOnly): void {
  assertDateOnly(entryDate, 'entry_date');
}

function assertIdentifier(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new PostingRuleError(
      'empty_identifier',
      `${field} must be a non-empty Source_Record identifier`,
    );
  }
  return value;
}

/**
 * A component amount: in the paise range, and not negative. `0n` is allowed
 * here and omitted from the draft later; the gross amount is checked separately
 * because 0 gross admits no set at all.
 */
function assertComponent(value: Paise, field: string): Paise {
  assertInRange(value); // raises PaiseRangeError, not PostingRuleError
  if (value < 0n) {
    throw new PostingRuleError(
      'negative_amount',
      `${field} must be 0 or more paise; direction is carried by side, never by sign, got ${value}`,
    );
  }
  return value;
}

function assertGross(value: Paise, field: string): Paise {
  assertComponent(value, field);
  if (value === 0n) {
    throw new PostingRuleError(
      'zero_amount',
      `${field} is 0 paise, so every entry would be omitted and no set of 2..20 entries exists`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Balance helpers, shared with postSet (task 8.3) and property P1 (task 8.5)
// ---------------------------------------------------------------------------

/** Σ of the debit amounts of a draft. `0n` for a draft with no debit entry. */
export function totalDebitPaise(draft: LedgerEntrySetDraft): Paise {
  return sum(draft.entries.filter((e) => e.side === 'debit').map((e) => e.amount_paise));
}

/** Σ of the credit amounts of a draft. */
export function totalCreditPaise(draft: LedgerEntrySetDraft): Paise {
  return sum(draft.entries.filter((e) => e.side === 'credit').map((e) => e.amount_paise));
}

/** `Σdebit − Σcredit`. `0n` for every draft these rules produce (property P1). */
export function imbalancePaise(draft: LedgerEntrySetDraft): Paise {
  return subtract(totalDebitPaise(draft), totalCreditPaise(draft));
}

/**
 * The structural invariants of a draft, checked before `postSet` reaches the
 * database: 2..20 entries, every amount strictly positive, at least 1
 * Source_Record ref, a real `entry_date`. Balance is not checked here — that is
 * `postSet`'s rejection path (Requirement 2.6), which has to report the
 * imbalance rather than throw.
 *
 * @throws {PostingRuleError}
 */
export function assertDraftWellFormed(draft: LedgerEntrySetDraft): void {
  assertEntryDate(draft.entry_date);
  if (draft.source_refs.length === 0) {
    throw new PostingRuleError(
      'missing_source_ref',
      'a draft needs at least 1 Source_Record ref: every Ledger_Entry is linked to every ref of its set (Requirement 2.2)',
    );
  }
  for (const ref of draft.source_refs) {
    assertIdentifier(ref.id, `source_refs[${ref.type}].id`);
  }
  if (draft.entries.length < 2 || draft.entries.length > 20) {
    throw new PostingRuleError(
      'entry_count_out_of_range',
      `a Ledger_Entry set holds 2..20 entries, got ${draft.entries.length}`,
    );
  }
  for (const entry of draft.entries) {
    assertInRange(entry.amount_paise);
    if (entry.amount_paise <= 0n) {
      throw new PostingRuleError(
        'entry_count_out_of_range',
        `entry on ${entry.account_code} has amount ${entry.amount_paise}; amount_paise is paise_positive (> 0) and zero-amount entries are omitted, not posted`,
      );
    }
  }
}

/** Drop the components that came out at 0 paise, keeping table order. */
function omitZeroAmounts(
  entries: readonly LedgerEntryDraft[],
): readonly LedgerEntryDraft[] {
  return entries.filter((entry) => entry.amount_paise !== 0n);
}

// ---------------------------------------------------------------------------
// The five posting tables
// ---------------------------------------------------------------------------

/**
 * The Payment table (Requirement 2.3). `N = A − F − G` computed with `subtract`,
 * so every intermediate is range-checked and the difference against
 * `A − F − G` is exactly 0 paise.
 *
 * `N` is omitted when the fee and GST consume the whole gross amount, `F` and
 * `G` are omitted when absent, so the set is 4 entries with a fee and GST, 3
 * with a fee alone, and 2 with neither.
 *
 * @throws {PostingRuleError} `zero_amount` for a 0-paise gross,
 * `negative_amount` for a negative component, `fee_exceeds_amount` when
 * `F + G > A`.
 * @throws {PaiseRangeError} when a component or the net leaves the paise range.
 */
export function paymentPostingDraft(payment: PaymentPosting): LedgerEntrySetDraft {
  assertEntryDate(payment.entry_date);
  const paymentId = assertIdentifier(payment.payment_id, 'payment_id');
  const gross = assertGross(payment.amount_paise, 'amount_paise');
  const fee = assertComponent(payment.fee_paise, 'fee_paise');
  const gstOnFee = assertComponent(payment.gst_on_fee_paise, 'gst_on_fee_paise');

  // N = A - F - G. Two `subtract` calls, no inline arithmetic: each operand and
  // each intermediate is range-checked by the calculation service.
  const net = subtract(subtract(gross, fee), gstOnFee);
  if (net < 0n) {
    throw new PostingRuleError(
      'fee_exceeds_amount',
      `Razorpay_Fee ${fee} plus GST_On_Fee ${gstOnFee} exceeds the gross Payment amount ${gross}; ` +
        `the settlement-pending amount would be ${net}, and an entry amount is always positive`,
    );
  }

  const draft: LedgerEntrySetDraft = {
    // The Payment is the derivation identity and the only Source_Record every
    // one of these amounts was read from (Requirement 2.2, 2.8).
    source_refs: [{ type: 'payment', id: paymentId }],
    entry_date: payment.entry_date,
    entries: omitZeroAmounts([
      { account_code: ACCOUNT.SETTLEMENT_PENDING, side: 'debit', amount_paise: net },
      { account_code: ACCOUNT.RAZORPAY_FEE_EXPENSE, side: 'debit', amount_paise: fee },
      { account_code: ACCOUNT.GST_INPUT_CREDIT, side: 'debit', amount_paise: gstOnFee },
      { account_code: ACCOUNT.REVENUE, side: 'credit', amount_paise: gross },
    ]),
  };
  assertDraftWellFormed(draft);
  return draft;
}

/**
 * The Refund table (Requirement 2.9). Designations opposite to the Payment set:
 * `revenue` is credited by a Payment and debited here, `settlement_pending` is
 * debited by a Payment and credited here. The whole set is the stored Refund
 * amount `R` — a Refund carries no fee or GST decomposition of its own, which is
 * why the set is 2 entries rather than a mirror of all four Payment lines.
 *
 * Both identifiers are linked, Refund first because the Refund is the derivation
 * identity of the set.
 *
 * @throws {PostingRuleError} `zero_amount` for a 0-paise Refund,
 * `negative_amount` for a negative one.
 */
export function refundPostingDraft(refund: RefundPosting): LedgerEntrySetDraft {
  assertEntryDate(refund.entry_date);
  const refundId = assertIdentifier(refund.refund_id, 'refund_id');
  const paymentId = assertIdentifier(refund.payment_id, 'payment_id');
  const refunded = assertGross(refund.amount_paise, 'amount_paise');

  const draft: LedgerEntrySetDraft = {
    source_refs: [
      { type: 'refund', id: refundId },
      { type: 'payment', id: paymentId },
    ],
    entry_date: refund.entry_date,
    entries: [
      { account_code: ACCOUNT.REVENUE, side: 'debit', amount_paise: refunded },
      { account_code: ACCOUNT.SETTLEMENT_PENDING, side: 'credit', amount_paise: refunded },
    ],
  };
  assertDraftWellFormed(draft);
  return draft;
}

/**
 * The Settlement table (Requirement 2.10): the received amount `S` moves out of
 * `settlement_pending` and into `bank`. Debiting `bank` increases the asset and
 * crediting `settlement_pending` reduces the receivable, which is the direction
 * Requirement 2.10 states.
 *
 * @throws {PostingRuleError} `zero_amount` for a 0-paise received amount,
 * `negative_amount` for a negative one.
 */
export function settlementPostingDraft(settlement: SettlementPosting): LedgerEntrySetDraft {
  assertEntryDate(settlement.entry_date);
  const settlementId = assertIdentifier(settlement.settlement_id, 'settlement_id');
  const received = assertGross(settlement.received_amount_paise, 'received_amount_paise');

  const reconReportId = settlement.settlement_recon_report_id;
  const reconRefs: readonly SourceRef[] =
    reconReportId === null
      ? []
      : [
          {
            type: 'settlement_recon_report',
            id: assertIdentifier(reconReportId, 'settlement_recon_report_id'),
          },
        ];

  const draft: LedgerEntrySetDraft = {
    source_refs: [{ type: 'settlement', id: settlementId }, ...reconRefs],
    entry_date: settlement.entry_date,
    entries: [
      { account_code: ACCOUNT.BANK, side: 'debit', amount_paise: received },
      { account_code: ACCOUNT.SETTLEMENT_PENDING, side: 'credit', amount_paise: received },
    ],
  };
  assertDraftWellFormed(draft);
  return draft;
}

/**
 * The Transfer table (Requirements 2.1, 7.1): move Route split amount `T` from
 * `settlement_pending` to `seller_payout_clearing` for the Linked_Account flow.
 * The Transfer is the sole derivation identity and amount source.
 *
 * @throws {PostingRuleError} `zero_amount` for a 0-paise Transfer,
 * `negative_amount` for a negative one.
 */
export function transferPostingDraft(transfer: TransferPosting): LedgerEntrySetDraft {
  assertEntryDate(transfer.entry_date);
  const transferId = assertIdentifier(transfer.transfer_id, 'transfer_id');
  const amount = assertGross(transfer.amount_paise, 'amount_paise');

  const draft: LedgerEntrySetDraft = {
    source_refs: [{ type: 'transfer', id: transferId }],
    entry_date: transfer.entry_date,
    entries: [
      { account_code: ACCOUNT.SELLER_PAYOUT_CLEARING, side: 'debit', amount_paise: amount },
      { account_code: ACCOUNT.SETTLEMENT_PENDING, side: 'credit', amount_paise: amount },
    ],
  };
  assertDraftWellFormed(draft);
  return draft;
}

/**
 * The Transfer_Reversal table (Requirements 2.1, 7.2): reverse only this
 * record's amount `V`, not the original Transfer amount. This makes partial
 * reversals post at their actual amount and exactly exchange the Transfer sides.
 *
 * @throws {PostingRuleError} `zero_amount` for a 0-paise reversal,
 * `negative_amount` for a negative one.
 */
export function transferReversalPostingDraft(
  reversal: TransferReversalPosting,
): LedgerEntrySetDraft {
  assertEntryDate(reversal.entry_date);
  const reversalId = assertIdentifier(
    reversal.transfer_reversal_id,
    'transfer_reversal_id',
  );
  const reversed = assertGross(reversal.reversed_amount_paise, 'reversed_amount_paise');

  const draft: LedgerEntrySetDraft = {
    source_refs: [{ type: 'transfer_reversal', id: reversalId }],
    entry_date: reversal.entry_date,
    entries: [
      { account_code: ACCOUNT.SETTLEMENT_PENDING, side: 'debit', amount_paise: reversed },
      { account_code: ACCOUNT.SELLER_PAYOUT_CLEARING, side: 'credit', amount_paise: reversed },
    ],
  };
  assertDraftWellFormed(draft);
  return draft;
}

/**
 * The rule for a Source_Record, dispatched on its type. `postFromSource` (task
 * 8.4) calls this and hands the draft to `postSet`.
 *
 * @throws {PostingRuleError} for any source with no valid posting.
 */
export function postingDraftFor(source: PostingSource): LedgerEntrySetDraft {
  switch (source.type) {
    case 'payment':
      return paymentPostingDraft(source);
    case 'refund':
      return refundPostingDraft(source);
    case 'settlement':
      return settlementPostingDraft(source);
    case 'transfer':
      return transferPostingDraft(source);
    case 'transfer_reversal':
      return transferReversalPostingDraft(source);
  }
}
