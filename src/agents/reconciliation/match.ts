/**
 * Identifier-only lifecycle matching: each in-scope Payment to its Order, its
 * Razorpay_Invoice, its Settlement and its Ledger_Entries (task 13.1).
 * Requirement 4.1.
 *
 * **Every mapping in this module is a stored Razorpay identifier link or an explicit
 * not-matched marker. There is no third outcome, and no inference of any kind.** No
 * amount is compared, no date is compared, no proximity is scored, no "these two are
 * both ₹5,000 on the same day" is ever concluded. Requirement 4.1 states it twice —
 * "using only the stored Razorpay object identifier links on those records" and
 * "SHALL perform no amount-based or date-based inferred matching" — and design.md's
 * fifth principle repeats it as a project rule.
 *
 * The rule is enforced structurally rather than by discipline: **no type in this file
 * carries an amount, a currency, a timestamp or a date, and the module imports
 * neither `Paise` nor anything from `@/calc`.** A function cannot infer from a figure
 * it was never handed. `match.test.ts` reads this file's own source, strips its
 * comments and string literals, and fails if a monetary or temporal token appears in
 * the remaining code — so the guarantee is a test rather than a promise.
 *
 * Why it matters enough to spend a doc comment on: an amount-or-date heuristic
 * produces a *plausible* reconciliation that is silently wrong, and every figure
 * downstream inherits that wrongness while carrying an Evidence_Chain that looks
 * perfectly well-formed. A `not_matched` marker is a fact the system can report and a
 * User can act on. A guessed match is not.
 *
 * ## Decision 1 — what counts as a link, per record type
 *
 * One row of this table per record type Requirement 4.1 names. "Field" is the stored
 * field or the join an adapter reads; nothing else is a link, and where the schema
 * offers no path the type is `not_matched` rather than inferred.
 *
 * | Record type | Stored link an adapter reads | Index |
 * |---|---|---|
 * | **Order** | `razorpay_objects.payload ->> 'order_id'` on the Payment's own row (`object_type = 'payment'`). A single scalar field, present and non-null in the seeded payloads. | none — finding 2 |
 * | **Razorpay_Invoice** | `razorpay_objects.payload ->> 'invoice_id'` on the Payment's own row, **and** the reverse direction: any `object_type = 'razorpay_invoice'` row whose `payload ->> 'payment_id'` is this Payment. Both are stored identifier links; the reverse one is why Requirement 4.14 can see two candidate Invoices for one Payment at all, since the forward field is single-valued. | none — finding 2 |
 * | **Settlement** | the Settlement_Recon_Report line whose `payload ->> 'entity_id'` **is** this Payment identifier, read for its `payload ->> 'settlement_id'`. | `razorpay_recon_report_settlement_idx` serves the settlement side of that join; the `entity_id` side is unindexed — finding 2 |
 * | **Ledger_Entries** | `ledger_entry_sources` where `(tenant_id, source_record_type = 'payment', source_record_id = <payment id>)`, yielding `entry_id`. This is the same join Requirement 4.10's missing-accrual detector runs. | `ledger_entry_sources_lookup_idx` |
 *
 * The Payment → Settlement path deserves the note it gets in finding 1: the Payment
 * payload has **no** `settlement_id` field, so the recon-report line is the only
 * stored link there is. `razorpay_objects.payload` is the verbatim provider payload
 * (Requirement 1.6), and `entity_id` on a combined recon line is the settled entity's
 * own identifier — which is exactly the collision
 * `IDENTIFIER_COLLISION_ERROR_CODE` in `src/ingestion/ingestion-service.ts` records
 * and `src/tools/settlement-scope.ts` reads around. That collision is why the
 * *identifier* of the linking line is the store's to resolve and is not re-derived
 * here: this module consumes the identifiers an adapter resolved and classifies them.
 *
 * ## Decision 2 — multiplicity, and how ambiguity stays distinguishable
 *
 * Every type is classified by **how many identifiers the stored links name**, never
 * by anything else:
 *
 * | Candidates | Order / Razorpay_Invoice / Settlement | Ledger_Entries |
 * |---|---|---|
 * | 0 | `not_matched` (Requirement 4.1's marker) | `not_matched` |
 * | 1 | `matched`, carrying the identifier | `matched`, carrying one entry |
 * | 2 or more | `ambiguous`, carrying **every** candidate | `matched`, carrying all of them |
 *
 * Ledger_Entries are naturally many — one Payment posts a set of 2..20 entries
 * (`ledger_entry_sets.entry_count`), so more than one entry is the *normal* case and
 * calling it ambiguous would be nonsense. {@link LedgerEntriesMatch} therefore has no
 * `ambiguous` arm at all: it is unrepresentable rather than merely unused.
 *
 * `ambiguous` is a **distinct third state**, not a flavour of `not_matched`, because
 * Requirement 4.14 treats them oppositely: 2 or more candidate Settlements or
 * Razorpay_Invoices is an *ambiguous match* which "SHALL exclude the Payment from the
 * unsettled classification", while 0 candidates is Requirement 4.11's *unsettled*.
 * Collapsing the two would report a Payment claimed by two Settlements as claimed by
 * none.
 *
 * **Agreement with `get_unsettled_payments`.** `ScopedPayment.settlement_candidate_count`
 * (task 12.4) is "the number of Settlements the stored Razorpay identifier links
 * name", and its `isUnsettled` reads `count === 0` as unsettled, `1` as settled and
 * `>= 2` as Requirement 4.14's ambiguity. {@link settlementCandidateCount} returns
 * that same number from this module's classification —
 * `not_matched → 0`, `matched → 1`, `ambiguous → n` — so the tool and the matcher
 * cannot drift about what a link is. One difference, and it is the tool's rule rather
 * than a disagreement: 12.4 additionally requires `status_rzp === 'captured'` before a
 * Payment is *reported* as unsettled. That is an eligibility gate on the report, not a
 * statement about the link, and this module deliberately holds no provider status —
 * see {@link settlementCandidateCount} for why the gate stays there.
 *
 * ## Decision 3 — determinism (Requirement 4.15, property P5)
 *
 * A re-run over an unchanged dataset must reproduce the identical result in the
 * identical order. Four things make that true here, and none of them depends on the
 * store:
 *
 * 1. **Candidate identifiers are deduplicated and sorted ascending** by
 *    {@link canonicalLinkIds}, so a result is a function of the *set* of stored links
 *    and not of the row order an adapter happened to return. Ascending identifier is
 *    the house tie-break — `canonicalSourceRefs` in
 *    `src/agents/exception-fingerprint.ts`, `inScopeOrder` in
 *    `src/tools/settlement-scope.ts`, `unsettledPaymentsInOrder` in
 *    `src/tools/get-unsettled-payments.ts`.
 * 2. **Results are ordered by ascending Payment identifier**, which is a **total**
 *    order because a Payment identifier is unique per Tenant. There is no secondary
 *    key to fall back on and none is needed.
 * 3. **A duplicate Payment is rejected, not merged.** Two rows for one Payment would
 *    make the order depend on which arrived first, and merging their candidates would
 *    invent a link set neither row stated.
 * 4. **Nothing here reads a clock, a random source, a database or an environment.**
 *    {@link matchPaymentLifecycle} and {@link matchLifecycle} are pure and total.
 *
 * Task 13.3 owns property P5. No property test is written here; what is written is a
 * matcher whose determinism P5 can *observe* — including
 * {@link lifecycleMatchOrderKey}, so the comparison P5 makes over two runs does not
 * restate this module's ordering rule in the test.
 *
 * ## Decision 4 — the read seam
 *
 * {@link LifecycleLinkStore} is **injected**, and there is no PostgREST adapter here.
 * Same reason as `SettlementReconStore`, `SettlementScopeStore`, `LedgerStore` and
 * `EvidenceChainStore`: every table this would read — `razorpay_objects`,
 * `ledger_entry_sources` — is RLS `ENABLE`d **and** `FORCE`d with no policies until
 * task 26.1, so PostgREST matches zero rows for every role without `BYPASSRLS`. A live
 * adapter written today would report "nothing links to anything" for every Tenant,
 * which is the worst possible failure mode for this module in particular: it would look
 * exactly like a Tenant with an unlinked book.
 *
 * The Tenant travels explicitly and is never inferred: it is bound once at
 * construction ({@link createLifecycleMatcher}), no method takes it, and
 * {@link LifecycleLinkQuery} carries it into the store. A cross-Tenant Payment is
 * simply not returned — no rows, never a permission error (Requirement 14.4).
 *
 * ## Read, but not read at all — the distinction kept
 *
 * A Payment whose four record types are all `not_matched` is a **fact**: the links
 * were read and there are none. A Payment the store returned no row for at all is
 * **not a fact about links** — it may belong to another Tenant, it may have been
 * deleted, the read may have failed. {@link LifecycleMatchResult.payments_not_read}
 * keeps the two apart rather than reporting the second as the first, which is the same
 * objection this module makes to inference: an unknown presented as a finding.
 *
 * ## Reported, not silently patched
 *
 * 1. **`razorpay_payment_settlement_link_idx` indexes a field the Payment payload does
 *    not have.** design.md and `20260101000002_ingestion.sql` both create it on
 *    `(tenant_id, (payload ->> 'settlement_id')) WHERE object_type = 'payment'`, with
 *    the comment "payment -> settlement link, resolved from the stored identifier link
 *    only". The Razorpay Payment entity carries no `settlement_id`, and
 *    `test/fixtures/razorpay-seed.json` confirms it: every seeded Payment payload has
 *    `order_id` and `invoice_id` and no settlement field. So that index is over an
 *    expression that is `NULL` for every row, and the Payment → Settlement link is
 *    only reachable through the Settlement_Recon_Report line's `entity_id`. Nothing is
 *    invented to compensate — the join in decision 1 is a real stored link — but the
 *    index named for this task's job does not serve it, and fixing that needs a
 *    migration this task does not own.
 * 2. **No index supports the Order or the Razorpay_Invoice link.** Both are
 *    `payload ->>` reads on the Payment's own row, so the forward direction is served
 *    by the row lookup itself; the *reverse* Invoice direction
 *    (`razorpay_invoice.payload ->> 'payment_id'`) and the recon line's `entity_id`
 *    side are unindexed sequential scans. Correctness is unaffected and the 120-second
 *    run bound of task 13.2 is where it will be felt.
 * 3. **Requirement 4.14 covers 2 or more Settlements and 2 or more Razorpay_Invoices,
 *    and says nothing about 2 or more Orders.** The Order link is a single scalar field
 *    so the case should not arise, but {@link LinkMatch} can represent it and
 *    {@link ambiguousTypes} reports it, because an Order ambiguity that did arise would
 *    otherwise have to be silently discarded or silently resolved.
 *    {@link isAmbiguousMatch} follows 4.14 exactly — Settlement or Razorpay_Invoice —
 *    so task 13.5 raises exactly the Exceptions the requirement names.
 * 4. **A Ledger_Entry identifier is not a `source_record_type`.** The enum has
 *    `ledger_entry_set` and no `ledger_entry` label, and an entry identifier is a
 *    `ledger_entries.id` UUID rather than a Razorpay identifier. So
 *    {@link matchedSourceRefs} emits refs for the Payment and the three Razorpay types
 *    and **not** for the matched entries, which are carried on
 *    {@link LedgerEntriesMatch} instead. Requirement 4.1 asks for the matched
 *    identifier recorded per record type, which this satisfies; it is the *citation*
 *    vocabulary that cannot express an entry, and inventing an enum label would be a
 *    migration.
 * 5. **design.md declares no shape for any of this.** Its Reconciliation_Agent section
 *    is one sentence — "Matches Payment → Order → Razorpay_Invoice → Settlement →
 *    Ledger_Entries using stored identifier links only, with a not-matched marker per
 *    record type (Requirement 4.1)" — and its tool table names no matching type. Every
 *    interface below is therefore this module's, chosen to make Requirement 4.1's three
 *    clauses and Requirement 4.14's third state each representable exactly once.
 *
 * ## Scope — the line drawn with each sibling
 *
 * - **Task 13.2** owns `agent.ts`: scope resolution, the run, the run identifier, the
 *   `settlement_mismatch` Exception upserts, Requirement 4.7's examined counts and the
 *   120-second bound. **This module is the matcher it calls.** Nothing here creates an
 *   Exception, persists a row, resolves a scope, or reads a clock. The in-scope Payment
 *   identifiers are an **input** ({@link LifecycleMatcher.match}) for the same reason
 *   `run_id` is an input in `reconcile-settlement.ts`.
 * - **Task 13.3** owns property P5. See decision 3.
 * - **Task 13.5** owns the remaining detectors, including Requirement 4.14's
 *   `ambiguous_match` Exceptions. This module *represents* ambiguity and hands over the
 *   candidate refs ({@link ambiguousCandidateRefs}); it raises nothing. Requirement
 *   4.10's missing accrual is likewise its call to make from
 *   {@link PaymentLifecycleMatch.ledger_entries}.
 * - **Task 26.x** owns the RLS policies and the live adapter.
 * - **No Financial_Tool is declared here.** This is an agent-side module: no Zod
 *   schema, no `ToolResult` envelope, no catalogue entry, nothing under `src/tools/`.
 */

import { assertRefIdentifier } from '@/agents/exception-fingerprint';
import type { TenantId } from '@/config/configuration-service';
import type { SourceRef } from '@/ledger/posting-rules';

/* -------------------------------------------------------------------------- */
/* The four record types                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The four record types Requirement 4.1 matches a Payment to, in the order the
 * requirement and design.md's `Payment → Order → Razorpay_Invoice → Settlement →
 * Ledger_Entries` chain name them.
 *
 * `ledger_entries` is not a `source_record_type` label — see finding 4. The other
 * three are, and {@link matchedSourceRefs} relies on that.
 */
export const LIFECYCLE_RECORD_TYPES = [
  'order',
  'razorpay_invoice',
  'settlement',
  'ledger_entries',
] as const;

export type LifecycleRecordType = (typeof LIFECYCLE_RECORD_TYPES)[number];

/** The three of the four whose matched identifier is citable as a {@link SourceRef}. */
const CITABLE_TYPE: Readonly<Record<'order' | 'razorpay_invoice' | 'settlement', SourceRef['type']>> =
  {
    order: 'order',
    razorpay_invoice: 'razorpay_invoice',
    settlement: 'settlement',
  };

/** Thrown when a link set cannot be classified as stated. Never for an absent link. */
export class LifecycleMatchError extends Error {
  override readonly name = 'LifecycleMatchError';
}

/* -------------------------------------------------------------------------- */
/* The three outcomes                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Requirement 4.1's per-record-type outcome, for the three single-valued types.
 *
 * Exactly three arms, and the type admits no fourth: a link either names one record,
 * names none, or names several. There is no `probably`, no `score` and no
 * `inferred_from` — see the module doc comment.
 *
 * - `matched` carries **the** identifier the stored link names (Requirement 4.1's
 *   "matched identifier for each of the 4 record types").
 * - `not_matched` is Requirement 4.1's marker for a record type with no linked record.
 *   It carries nothing, deliberately: there is nothing to carry, and a field here
 *   would invite a reason string that shaded into a guess.
 * - `ambiguous` carries **every** candidate, ascending, because Requirement 4.14 wants
 *   the Exception to reference "the Payment identifier and every candidate record
 *   identifier" and because picking one of them would be inference by another name.
 */
export type LinkMatch =
  | { readonly kind: 'matched'; readonly id: string }
  | { readonly kind: 'not_matched' }
  | { readonly kind: 'ambiguous'; readonly candidate_ids: readonly string[] };

/**
 * The Ledger_Entries outcome. Many entries is the **normal** case — one Payment posts
 * a balanced set of 2..20 entries — so there is no `ambiguous` arm and one cannot be
 * constructed.
 *
 * `entry_ids` are `ledger_entries.id` UUIDs, deduplicated and ascending, and are never
 * empty in the `matched` arm.
 */
export type LedgerEntriesMatch =
  | { readonly kind: 'matched'; readonly entry_ids: readonly string[] }
  | { readonly kind: 'not_matched' };

/** The `not_matched` marker, shared so every absent link is the identical value. */
export const NOT_MATCHED: LinkMatch & { readonly kind: 'not_matched' } = Object.freeze({
  kind: 'not_matched',
});

/**
 * One Payment's whole lifecycle mapping: Requirement 4.1's four record types, each a
 * stored-link match or a not-matched marker.
 *
 * This is the record the requirement asks the agent to keep per Payment. It holds no
 * figure and no timestamp — see the module doc comment.
 */
export interface PaymentLifecycleMatch {
  readonly payment_id: string;
  readonly order: LinkMatch;
  readonly razorpay_invoice: LinkMatch;
  readonly settlement: LinkMatch;
  readonly ledger_entries: LedgerEntriesMatch;
}

/* -------------------------------------------------------------------------- */
/* The store's input shape                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The stored identifier links an adapter read for one Payment, before classification.
 *
 * **Every field is a list of identifiers the stored links name, and nothing else.**
 * There is no amount, no currency, no timestamp and no provider status on this
 * interface, so an adapter has no way to smuggle an inference through it and this
 * module has no way to make one. The exact field or join each list comes from is
 * decision 1 in the module doc comment, and it is part of the
 * {@link LifecycleLinkStore} contract.
 *
 * A list may hold 0, 1 or many identifiers, in any order, with repeats. Repeats
 * collapse ({@link canonicalLinkIds}) because two rows naming one record describe one
 * link, which is the same stance `canonicalSourceRefs` takes in
 * `src/agents/exception-fingerprint.ts`.
 */
export interface PaymentLinks {
  readonly payment_id: string;
  /** `payload ->> 'order_id'` on the Payment row. 0 or 1 in practice. */
  readonly order_ids: readonly string[];
  /** The Payment's `invoice_id`, plus any Invoice whose `payment_id` names it. */
  readonly razorpay_invoice_ids: readonly string[];
  /** `settlement_id` of every recon-report line whose `entity_id` is this Payment. */
  readonly settlement_ids: readonly string[];
  /** `ledger_entry_sources.entry_id` where the source record is this Payment. */
  readonly ledger_entry_ids: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Canonicalisation and classification                                        */
/* -------------------------------------------------------------------------- */

/**
 * An identifier that can be carried, compared and later hashed into an Exception
 * fingerprint.
 *
 * The rule is not restated here: {@link assertRefIdentifier} from
 * `src/agents/exception-fingerprint.ts` **is** the rule — non-empty, no padding, no
 * `|`, `,`, `:` or control character — and it is applied at this boundary so a link
 * identifier that would collide two Exception identities is rejected while it is still
 * a link rather than after task 13.5 has built a ref set out of it. Reusing the
 * function rather than copying the pattern is the point; the rejection is re-thrown as
 * a {@link LifecycleMatchError} so a caller of this module catches one error type.
 */
function assertLinkIdentifier(id: string, what: string): string {
  try {
    return assertRefIdentifier(id, what);
  } catch (cause) {
    throw new LifecycleMatchError(cause instanceof Error ? cause.message : String(cause), {
      cause,
    });
  }
}

/**
 * A candidate list as an identity: validated, deduplicated, ascending.
 *
 * Deduplication makes the classification a function of the **set** of stored links,
 * so a Payment named twice by one Settlement's recon report is matched once rather
 * than reported as ambiguous — the repeat describes one link, and calling it two would
 * manufacture a Requirement 4.14 Exception out of a join fan-out. Ascending order is
 * what makes the result independent of the order the adapter returned rows in
 * (decision 3).
 *
 * @throws {LifecycleMatchError} for an identifier that cannot be carried unambiguously.
 */
export function canonicalLinkIds(ids: readonly string[], what: string): readonly string[] {
  const seen = new Set<string>();
  for (const [position, id] of ids.entries()) {
    seen.add(assertLinkIdentifier(id, `${what}[${position}]`));
  }
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Requirement 4.1's marker, or the matched identifier, or Requirement 4.14's
 * ambiguity — decided by the **count** of stored links and by nothing else.
 *
 * @throws {LifecycleMatchError} for a malformed identifier.
 */
export function classifyLink(ids: readonly string[], what: string): LinkMatch {
  const candidates = canonicalLinkIds(ids, what);
  const [only] = candidates;
  if (only === undefined) {
    return NOT_MATCHED;
  }
  if (candidates.length === 1) {
    return { kind: 'matched', id: only };
  }
  return { kind: 'ambiguous', candidate_ids: candidates };
}

/**
 * The Ledger_Entries arm: matched with every linked entry, or the not-matched marker.
 *
 * Never `ambiguous` — see {@link LedgerEntriesMatch}.
 *
 * @throws {LifecycleMatchError} for a malformed entry identifier.
 */
export function classifyLedgerEntries(ids: readonly string[], what: string): LedgerEntriesMatch {
  const entries = canonicalLinkIds(ids, what);
  if (entries.length === 0) {
    return { kind: 'not_matched' };
  }
  return { kind: 'matched', entry_ids: entries };
}

/**
 * Requirement 4.1 for one Payment: the four record types, each a stored-link match or
 * a not-matched marker.
 *
 * **Pure and total.** No clock, no database, no Tenant, no figure — so task 13.3's
 * property P5 can drive it directly, and two runs over one {@link PaymentLinks} value
 * are identical by construction.
 *
 * @throws {LifecycleMatchError} for a malformed Payment or link identifier.
 */
export function matchPaymentLifecycle(links: PaymentLinks): PaymentLifecycleMatch {
  const paymentId = assertLinkIdentifier(links.payment_id, 'payment_id');
  const where = (field: string): string => `${paymentId}.${field}`;
  return {
    payment_id: paymentId,
    order: classifyLink(links.order_ids, where('order_ids')),
    razorpay_invoice: classifyLink(links.razorpay_invoice_ids, where('razorpay_invoice_ids')),
    settlement: classifyLink(links.settlement_ids, where('settlement_ids')),
    ledger_entries: classifyLedgerEntries(links.ledger_entry_ids, where('ledger_entry_ids')),
  };
}

/**
 * The key {@link matchLifecycle} orders on: the Payment identifier, which is unique
 * per Tenant and therefore a **total** order with no tie to break.
 *
 * Exported so task 13.3's P5 comparison uses this module's ordering rule rather than
 * restating it — a determinism test that re-derived the order would be asserting its
 * own copy of the rule.
 */
export function lifecycleMatchOrderKey(match: PaymentLifecycleMatch): string {
  return match.payment_id;
}

/**
 * Requirement 4.1 for a set of in-scope Payments, in ascending Payment identifier
 * order.
 *
 * Pure, total, and a function of the **set**: `links` may arrive in any order and the
 * result is identical, which is what Requirement 4.15 and property P5 need.
 *
 * @throws {LifecycleMatchError} when two entries describe the same Payment. Merging
 * them would invent a link set neither stated, and keeping both would make the order
 * depend on arrival — see decision 3.
 */
export function matchLifecycle(
  links: readonly PaymentLinks[],
): readonly PaymentLifecycleMatch[] {
  const byPayment = new Map<string, PaymentLifecycleMatch>();
  for (const one of links) {
    const match = matchPaymentLifecycle(one);
    if (byPayment.has(match.payment_id)) {
      throw new LifecycleMatchError(
        `${match.payment_id} appears twice in one lifecycle match; a Payment identifier is ` +
          `unique per Tenant, so two rows for it describe two different link sets and merging ` +
          `them would state a mapping neither row carries`,
      );
    }
    byPayment.set(match.payment_id, match);
  }
  return [...byPayment.values()].sort((a, b) => {
    const left = lifecycleMatchOrderKey(a);
    const right = lifecycleMatchOrderKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/* -------------------------------------------------------------------------- */
/* Reading a classification                                                   */
/* -------------------------------------------------------------------------- */

/** How many records a classification names: `0`, `1`, or the candidate count. */
export function candidateCount(match: LinkMatch): number {
  switch (match.kind) {
    case 'not_matched':
      return 0;
    case 'matched':
      return 1;
    default:
      return match.candidate_ids.length;
  }
}

/**
 * The number `ScopedPayment.settlement_candidate_count` in
 * `src/tools/get-unsettled-payments.ts` states: how many Settlements the stored
 * identifier links name.
 *
 * The one definition both sides use, so the matcher and `get_unsettled_payments`
 * cannot disagree about what a link is. `0` is Requirement 4.11's unsettled, `1` is
 * settled, `2` or more is Requirement 4.14's ambiguous match.
 *
 * It stops at the count on purpose. 12.4 also requires `status_rzp === 'captured'`
 * before a Payment is *reported* as unsettled, and that gate stays there: this module
 * holds no provider status — a status is a fact about the Payment, not about its links
 * — and duplicating the gate here would put Requirement 4.11's eligibility rule in two
 * places that could drift.
 */
export function settlementCandidateCount(match: PaymentLifecycleMatch): number {
  return candidateCount(match.settlement);
}

/** How many Razorpay_Invoices the stored links name. Requirement 4.14's other half. */
export function invoiceCandidateCount(match: PaymentLifecycleMatch): number {
  return candidateCount(match.razorpay_invoice);
}

/**
 * Requirement 4.14's classification: 2 or more candidate Settlements **or** 2 or more
 * candidate Razorpay_Invoices for a single Payment.
 *
 * Exactly the requirement's two types, so task 13.5 raises exactly the
 * `ambiguous_match` Exceptions it names. An Order ambiguity is reported by
 * {@link ambiguousTypes} and is not this predicate's business — see finding 3.
 */
export function isAmbiguousMatch(match: PaymentLifecycleMatch): boolean {
  return match.settlement.kind === 'ambiguous' || match.razorpay_invoice.kind === 'ambiguous';
}

/**
 * Every record type whose stored links name 2 or more records, in
 * {@link LIFECYCLE_RECORD_TYPES} order. Includes `order`, which Requirement 4.14 does
 * not cover; see finding 3.
 */
export function ambiguousTypes(match: PaymentLifecycleMatch): readonly LifecycleRecordType[] {
  const types: LifecycleRecordType[] = [];
  if (match.order.kind === 'ambiguous') {
    types.push('order');
  }
  if (match.razorpay_invoice.kind === 'ambiguous') {
    types.push('razorpay_invoice');
  }
  if (match.settlement.kind === 'ambiguous') {
    types.push('settlement');
  }
  return types;
}

/**
 * Requirement 4.1's not-matched markers, as the list of record types that carry one,
 * in {@link LIFECYCLE_RECORD_TYPES} order.
 *
 * The aggregate form of the marker, for the run report task 13.2 assembles and for
 * Requirement 4.10's missing-accrual detector in task 13.5 — `ledger_entries` here
 * means no Ledger_Entry references this Payment as a Source_Record, which is that
 * requirement's condition exactly.
 */
export function notMatchedTypes(match: PaymentLifecycleMatch): readonly LifecycleRecordType[] {
  const types: LifecycleRecordType[] = [];
  if (match.order.kind === 'not_matched') {
    types.push('order');
  }
  if (match.razorpay_invoice.kind === 'not_matched') {
    types.push('razorpay_invoice');
  }
  if (match.settlement.kind === 'not_matched') {
    types.push('settlement');
  }
  if (match.ledger_entries.kind === 'not_matched') {
    types.push('ledger_entries');
  }
  return types;
}

/**
 * The matched records as Source_Record refs: the Payment itself, plus each of the
 * three Razorpay types whose link named exactly one record.
 *
 * Sorted on **type then id**, the ordering `canonicalSourceRefs` in
 * `src/agents/exception-fingerprint.ts` applies before hashing, so a caller passing
 * these into an Exception or an Evidence_Chain hands over a canonical set already.
 *
 * An `ambiguous` type contributes **nothing** here — no candidate is "the" matched
 * record, and citing one would be the inference this module exists to refuse. Use
 * {@link ambiguousCandidateRefs} for those. Matched Ledger_Entries contribute nothing
 * either: an entry identifier is not a `source_record_type` (finding 4).
 */
export function matchedSourceRefs(match: PaymentLifecycleMatch): readonly SourceRef[] {
  const refs: SourceRef[] = [{ type: 'payment', id: match.payment_id }];
  for (const [field, type] of Object.entries(CITABLE_TYPE) as readonly [
    'order' | 'razorpay_invoice' | 'settlement',
    SourceRef['type'],
  ][]) {
    const link = match[field];
    if (link.kind === 'matched') {
      refs.push({ type, id: link.id });
    }
  }
  return sortRefs(refs);
}

/**
 * Requirement 4.14's Exception refs: the Payment identifier and **every** candidate
 * record identifier, for the types 4.14 names.
 *
 * Empty when the match is not ambiguous by 4.14's definition, so task 13.5 can use a
 * non-empty result as the condition itself. Sorted on type then id, as above.
 */
export function ambiguousCandidateRefs(match: PaymentLifecycleMatch): readonly SourceRef[] {
  if (!isAmbiguousMatch(match)) {
    return [];
  }
  const refs: SourceRef[] = [{ type: 'payment', id: match.payment_id }];
  if (match.razorpay_invoice.kind === 'ambiguous') {
    for (const id of match.razorpay_invoice.candidate_ids) {
      refs.push({ type: 'razorpay_invoice', id });
    }
  }
  if (match.settlement.kind === 'ambiguous') {
    for (const id of match.settlement.candidate_ids) {
      refs.push({ type: 'settlement', id });
    }
  }
  return sortRefs(refs);
}

/** Ascending type, then ascending id: the house ref order. */
function sortRefs(refs: readonly SourceRef[]): readonly SourceRef[] {
  return [...refs].sort((a, b) =>
    a.type < b.type ? -1 : a.type > b.type ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

/* -------------------------------------------------------------------------- */
/* The read seam                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One scoped read of stored identifier links.
 *
 * `tenant_id` comes from the session and travels explicitly; it is never inferred and
 * never an argument a caller of the matcher supplies (Requirement 12.7, 14.10).
 * `payment_ids` are the in-scope Payments **task 13.2 resolved** — scope resolution is
 * its concern, not this module's.
 */
export interface LifecycleLinkQuery {
  readonly tenant_id: TenantId;
  /** Deduplicated and ascending, so the query is a function of the in-scope set. */
  readonly payment_ids: readonly string[];
}

/**
 * What the store answers.
 *
 * `payments` holds one entry per requested Payment the Tenant actually holds. A
 * requested Payment with no entry is reported as
 * {@link LifecycleMatchResult.payments_not_read} rather than as a Payment with four
 * not-matched markers — see the module doc comment.
 */
export interface LifecycleLinkResult {
  readonly payments: readonly PaymentLinks[];
  /**
   * Records the store knows contribute and could not read. Carried through so task
   * 13.2 can report an incomplete run (Requirement 15.6) instead of presenting a
   * partial mapping as a complete one.
   */
  readonly unreadable?: readonly SourceRef[];
}

/**
 * Where stored identifier links come from. Injected, with **no live adapter here** —
 * decision 4 in the module doc comment.
 *
 * Four contracts every adapter owes:
 *
 * 1. **Only the stored links of decision 1.** No amount is compared, no date is
 *    compared, no `ORDER BY` on a timestamp decides which record a Payment links to,
 *    and no `LIMIT 1` silently resolves an ambiguity — 2 candidates must arrive as 2
 *    (Requirement 4.1, 4.14).
 * 2. **Tenant scoping is the query's, and rows outside it do not exist.** A
 *    cross-Tenant Payment yields no entry, never a permission error
 *    (Requirement 14.4).
 * 3. **A repeat is allowed; a fabricated identifier is not.** Join fan-out may repeat
 *    an identifier and {@link canonicalLinkIds} collapses it. An identifier that is
 *    absent or JSON `null` in the payload must be **omitted**, never coerced to
 *    `'null'` or to an empty string, both of which this module rejects.
 * 4. **One entry per Payment.** Two entries for one Payment are rejected by
 *    {@link matchLifecycle}; an adapter aggregates its own join.
 */
export interface LifecycleLinkStore {
  readLinks(query: LifecycleLinkQuery): Promise<LifecycleLinkResult>;
}

/**
 * The whole matching result for a run's in-scope Payments.
 *
 * `matches` is ascending by Payment identifier (decision 3).
 */
export interface LifecycleMatchResult {
  readonly matches: readonly PaymentLifecycleMatch[];
  /**
   * Requested Payments the store returned no links entry for — another Tenant's, or
   * gone, or unread. **Not** the same as a Payment whose four types are all
   * `not_matched`, which is a read fact. Ascending.
   */
  readonly payments_not_read: readonly string[];
  /** Passed through from the store, for task 13.2's incomplete-run report. */
  readonly unreadable: readonly SourceRef[];
}

/**
 * Requirement 4.1's matching for **one** Tenant.
 *
 * No method takes a `tenant_id`: it is bound once at construction from the session, so
 * an unscoped read is not expressible — the same stance `createSettlementReconciler`
 * takes in `./reconcile-settlement.ts`.
 */
export interface LifecycleMatcher {
  /**
   * Map every in-scope Payment to its Order, Razorpay_Invoice, Settlement and
   * Ledger_Entries, using stored identifier links only.
   *
   * @throws {LifecycleMatchError} for an empty request, a malformed identifier, a
   * duplicate Payment entry, or a store that answers about a Payment nobody asked
   * about.
   */
  match(paymentIds: readonly string[]): Promise<LifecycleMatchResult>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LifecycleMatcherDeps {
  readonly store: LifecycleLinkStore;
  /** The session Tenant. Never an argument to a method (Requirement 12.7). */
  readonly tenantId: TenantId;
}

/** Build a matcher bound to one Tenant. */
export function createLifecycleMatcher(deps: LifecycleMatcherDeps): LifecycleMatcher {
  const { store } = deps;
  if (!UUID_RE.test(deps.tenantId)) {
    throw new LifecycleMatchError(
      `createLifecycleMatcher requires the session Tenant identifier as a UUID, got ` +
        `${JSON.stringify(deps.tenantId)}. The Tenant travels explicitly and is never inferred`,
    );
  }
  const tenantId = deps.tenantId;

  return {
    async match(paymentIds: readonly string[]): Promise<LifecycleMatchResult> {
      const requested = canonicalLinkIds(paymentIds, 'payment_ids');
      if (requested.length === 0) {
        // An empty request is a caller mistake, not an empty answer: task 13.2 resolves
        // the scope, and "match nothing" would report four not-matched markers for zero
        // Payments as a successful mapping of the run.
        throw new LifecycleMatchError(
          `no in-scope Payment was given to match; the run scope is resolved by the ` +
            `Reconciliation_Agent (task 13.2) and an empty scope is its case to report, not a ` +
            `mapping this module can answer`,
        );
      }

      const result = await store.readLinks({ tenant_id: tenantId, payment_ids: requested });
      const matches = matchLifecycle(result.payments);

      const asked = new Set(requested);
      const answered = new Set<string>();
      for (const match of matches) {
        if (!asked.has(match.payment_id)) {
          // Reading about a Payment nobody asked about means the query was not the scope,
          // and 13.2's examined counts would then describe a set it never resolved.
          throw new LifecycleMatchError(
            `the store answered about ${match.payment_id}, which is not in the requested ` +
              `in-scope Payment set; a matching result must describe the scope it was asked for`,
          );
        }
        answered.add(match.payment_id);
      }

      return {
        matches,
        payments_not_read: requested.filter((id) => !answered.has(id)),
        unreadable: result.unreadable ?? [],
      };
    },
  };
}
