/**
 * design.md's `arbitrarySourceRecord`, shared by the Semantic_Ledger property tests.
 *
 * These generators were written for **P1** (`./p1-ledger-set-balance.property.test.ts`,
 * task 8.5) and were extracted here unchanged when **P2** (task 8.6) needed the same
 * Source_Records. One copy, not two: a second divergent copy would mean P1 and P2 were
 * asserting over different input spaces while claiming to share design.md's generator, and
 * a boundary added to one would silently not reach the other. **P13 (task 8.7) should import
 * from here rather than fork a third copy.**
 *
 * ## What is here, and what deliberately is not
 *
 * The balanced half: a `PostingSource` for each of the five Source_Records with a posting
 * rule (`payment`, `refund`, `settlement`, `transfer`, and `transfer_reversal`).
 * `arbitraryImbalancedDraft` and its `perturbOneEntry` stay in P1, because
 * "a draft no posting rule produces" is P1's subject and nothing else needs it. Keeping this
 * module to generators means it has no `describe`, no `expect` and no database, so importing
 * it registers no tests.
 *
 * ## The identifier pools keep their `_p1_` infix on purpose
 *
 * `pay_p1_a`, `rfnd_p1_a` and friends read oddly in a shared module, and renaming them was
 * considered and rejected: P1's file header quotes committed, shrunk counterexamples by
 * identifier (`"payment_id":"pay_p1_a"`), and those are only reproducible from P1's
 * committed seed while the drawn values stay bit-identical. Renaming the pool would change
 * every draw and silently invalidate that record. The prefix is historical, nothing more.
 *
 * Pools are small — 3 Payments and 2 each of Refunds, Settlements, Transfers, and
 * Transfer_Reversals — which is what makes a repeated `(type, id)` the common case rather than a rare one. P2 depends on that: its whole subject
 * is what a *second* derivation from one Source_Record does, and duplicates inside a single
 * generated array exercise it without waiting for the second pass.
 *
 * ## Two ceilings, and why the gross amount takes a parameter
 *
 * A Ledger_Entry amount is the `paise_positive` domain, `0 < VALUE <= 99999999999999`
 * ({@link PAISE_MAX}). A **stored** Razorpay amount is the `paise_ingested` domain,
 * `0 <= VALUE <= 999999999999` (`PAISE_INGESTED_MAX`) — two orders of magnitude
 * lower. P1 posts drafts it derived in memory, so it wants the full paise range; P2 derives
 * through `postFromSource`, which reads the amounts back out of `razorpay_objects`, so
 * anything above the ingested ceiling could not be stored to derive from in the first place.
 * Hence {@link sourceRecordArbitrary} takes `maxGrossPaise`, defaulting to `PAISE_MAX` so
 * P1's draws are unchanged.
 *
 * Every fee shape keeps `F + G <= A`, so a Payment's debit side sums to exactly `A` and its
 * credit side to exactly `A`; a Refund and a Settlement post one amount twice. Both sides
 * are therefore bounded by the drawn gross amount, and no running total inside `sum` can
 * leave the paise range — `PaiseRangeError` is unreachable from these generators by
 * construction rather than by a filter.
 */

import fc from 'fast-check';

import { PAISE_MAX, type Paise } from '@/calc/paise';
import type { PostingSource } from '@/ledger/posting-rules';

/** How wide a generated Source_Record may be. */
export interface SourceRecordConstraints {
  /**
   * Ceiling for every drawn gross amount, and therefore for the fee and the GST under it.
   * Defaults to {@link PAISE_MAX}; pass `PAISE_INGESTED_MAX` from `@/calc/paise` when the
   * record has to survive a round trip through `razorpay_objects`.
   */
  readonly maxGrossPaise?: Paise;
}

/**
 * Gross amounts across the whole permitted range, biased to the boundaries task 8.2 named:
 * the smallest Payment that admits a posting at all, the smallest that still posts four
 * lines, the ceiling, and one below the ceiling.
 *
 * The fixed values above `max` are dropped rather than clamped, so a lowered ceiling shifts
 * no probability onto a value the ceiling excludes.
 */
export function grossPaiseArbitrary(max: Paise = PAISE_MAX): fc.Arbitrary<Paise> {
  const boundaries = [1n, 2n, 3n, 100n, 2_784n, 100_000n, max - 1n, max].filter(
    (value) => value >= 1n && value <= max,
  );
  return fc.oneof(
    { arbitrary: fc.constantFrom(...boundaries), weight: 3 },
    { arbitrary: fc.bigInt({ min: 1n, max }), weight: 5 },
  );
}

/**
 * How the Razorpay_Fee and the GST_On_Fee sit under the gross amount. Every shape keeps
 * `F + G <= A` — see the module doc comment.
 */
type FeeShape = 'none' | 'fee_only' | 'gst_only' | 'both' | 'consumes_all' | 'net_one';

const FEE_SHAPES: readonly FeeShape[] = [
  'none',
  'fee_only',
  'gst_only',
  'both',
  'consumes_all',
  'net_one',
];

/**
 * `F` and `G` for a shape, folded into range with `%` rather than filtered, so every draw
 * is used and shrinking stays monotone.
 *
 * `A = 1` collapses several shapes: `both` cannot give each component at least 1 paisa and
 * `net_one` cannot leave a 1-paisa net under a non-zero fee, so both fall back to a shape
 * that exists at 1 paisa. That is a real boundary of the rules, not a gap in the generator.
 */
function feeAndGstFor(
  gross: Paise,
  shape: FeeShape,
  r1: bigint,
  r2: bigint,
): { readonly fee: Paise; readonly gst: Paise } {
  switch (shape) {
    case 'none':
      return { fee: 0n, gst: 0n };
    case 'fee_only':
      // [1, A]. At F = A the net is 0 and its line is omitted.
      return { fee: 1n + (r1 % gross), gst: 0n };
    case 'gst_only':
      return { fee: 0n, gst: 1n + (r1 % gross) };
    case 'both': {
      if (gross < 2n) {
        return { fee: gross, gst: 0n };
      }
      const fee = 1n + (r1 % (gross - 1n)); // [1, A-1]
      const gst = 1n + (r2 % (gross - fee)); // [1, A-F]
      return { fee, gst };
    }
    case 'consumes_all': {
      // F + G = A exactly, so the settlement-pending line is omitted.
      if (gross < 2n) {
        return { fee: gross, gst: 0n };
      }
      const fee = 1n + (r1 % (gross - 1n));
      return { fee, gst: gross - fee };
    }
    case 'net_one': {
      // F + G = A - 1, the tightest surviving net line.
      if (gross < 2n) {
        return { fee: 0n, gst: 0n };
      }
      const fee = r1 % gross; // [0, A-1]
      return { fee, gst: gross - 1n - fee };
    }
  }
}

/** Real calendar dates, so `assertEntryDate` is exercised over 3 years including a leap day. */
const ENTRY_DATE_EPOCH_MS = Date.UTC(2024, 0, 1);

export const arbitraryEntryDate: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 1_095 })
  .map((offsetDays) =>
    new Date(ENTRY_DATE_EPOCH_MS + offsetDays * 86_400_000).toISOString().slice(0, 10),
  );

/**
 * Small identifier pools. None of these collides with a `*_baseline` identifier, which
 * matters because `ledger_set_derivation_uniq` is declared on
 * `(tenant_id, source_record_type, source_record_id)` and each property commits a baseline
 * set of its own. See the module doc comment for why the `_p1_` infix stays.
 */
export const PAYMENT_IDS = ['pay_p1_a', 'pay_p1_b', 'pay_p1_c'];
export const REFUND_IDS = ['rfnd_p1_a', 'rfnd_p1_b'];
export const SETTLEMENT_IDS = ['setl_p1_a', 'setl_p1_b'];
export const REPORT_IDS = ['rep_p1_a', 'rep_p1_b'];
export const TRANSFER_IDS = ['trf_p1_a', 'trf_p1_b'];
export const TRANSFER_REVERSAL_IDS = ['trfr_p1_a', 'trfr_p1_b'];

/**
 * The scale the fee shapes fold with `%`. Fixed at {@link PAISE_MAX} regardless of
 * `maxGrossPaise`: it is a modulus, never an amount, and holding it fixed keeps a lowered
 * ceiling from changing the shape of the fold.
 */
const arbitraryScale = fc.bigInt({ min: 0n, max: PAISE_MAX });

export function paymentArbitrary(
  constraints: SourceRecordConstraints = {},
): fc.Arbitrary<PostingSource> {
  return fc
    .record({
      payment_id: fc.constantFrom(...PAYMENT_IDS),
      entry_date: arbitraryEntryDate,
      gross: grossPaiseArbitrary(constraints.maxGrossPaise),
      r1: arbitraryScale,
      r2: arbitraryScale,
      // Shape discriminator last, per design.md's shrinking note.
      shape: fc.constantFrom(...FEE_SHAPES),
    })
    .map(({ payment_id, entry_date, gross, r1, r2, shape }) => {
      const { fee, gst } = feeAndGstFor(gross, shape, r1, r2);
      return {
        type: 'payment' as const,
        payment_id,
        entry_date,
        amount_paise: gross,
        fee_paise: fee,
        gst_on_fee_paise: gst,
      };
    });
}

export function refundArbitrary(
  constraints: SourceRecordConstraints = {},
): fc.Arbitrary<PostingSource> {
  return fc
    .record({
      refund_id: fc.constantFrom(...REFUND_IDS),
      payment_id: fc.constantFrom(...PAYMENT_IDS),
      entry_date: arbitraryEntryDate,
      amount_paise: grossPaiseArbitrary(constraints.maxGrossPaise),
    })
    .map((refund) => ({ type: 'refund' as const, ...refund }));
}

export function settlementArbitrary(
  constraints: SourceRecordConstraints = {},
): fc.Arbitrary<PostingSource> {
  return fc
    .record({
      settlement_id: fc.constantFrom(...SETTLEMENT_IDS),
      entry_date: arbitraryEntryDate,
      received_amount_paise: grossPaiseArbitrary(constraints.maxGrossPaise),
      // `null` is the not-yet-ingested report: the set then carries the Settlement link
      // alone, which is the 1-ref end of Requirement 2.10.
      settlement_recon_report_id: fc.option(fc.constantFrom(...REPORT_IDS), { nil: null }),
    })
    .map((settlement) => ({ type: 'settlement' as const, ...settlement }));
}

export function transferArbitrary(
  constraints: SourceRecordConstraints = {},
): fc.Arbitrary<PostingSource> {
  return fc
    .record({
      transfer_id: fc.constantFrom(...TRANSFER_IDS),
      entry_date: arbitraryEntryDate,
      amount_paise: grossPaiseArbitrary(constraints.maxGrossPaise),
    })
    .map((transfer) => ({ type: 'transfer' as const, ...transfer }));
}

export function transferReversalArbitrary(
  constraints: SourceRecordConstraints = {},
): fc.Arbitrary<PostingSource> {
  return fc
    .record({
      transfer_reversal_id: fc.constantFrom(...TRANSFER_REVERSAL_IDS),
      entry_date: arbitraryEntryDate,
      reversed_amount_paise: grossPaiseArbitrary(constraints.maxGrossPaise),
    })
    .map((reversal) => ({ type: 'transfer_reversal' as const, ...reversal }));
}

/** design.md's `arbitrarySourceRecord`, across all five posting tables. */
export function sourceRecordArbitrary(
  constraints: SourceRecordConstraints = {},
): fc.Arbitrary<PostingSource> {
  return fc.oneof(
    paymentArbitrary(constraints),
    refundArbitrary(constraints),
    settlementArbitrary(constraints),
    transferArbitrary(constraints),
    transferReversalArbitrary(constraints),
  );
}

/** The full-paise-range forms, as P1 draws them. */
export const arbitraryPayment: fc.Arbitrary<PostingSource> = paymentArbitrary();
export const arbitraryRefund: fc.Arbitrary<PostingSource> = refundArbitrary();
export const arbitrarySettlement: fc.Arbitrary<PostingSource> = settlementArbitrary();
export const arbitraryTransfer: fc.Arbitrary<PostingSource> = transferArbitrary();
export const arbitraryTransferReversal: fc.Arbitrary<PostingSource> =
  transferReversalArbitrary();
export const arbitrarySourceRecord: fc.Arbitrary<PostingSource> = sourceRecordArbitrary();
