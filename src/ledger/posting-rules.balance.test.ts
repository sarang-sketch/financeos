/**
 * Task 8.2: the arithmetic of the posting rules.
 *
 * A sibling of `posting-rules.test.ts` rather than an extension of it. That file
 * opens by declaring what it owns — the chart of accounts, the Source_Record
 * links, the debit/credit designations, the inputs that admit no posting — and
 * says the arithmetic is deliberately absent. Keeping the two apart keeps that
 * boundary legible, and lets the fee/GST case table below be shared by every
 * assertion in this file instead of threaded through structural tests that do
 * not need it. The `unit` project globs `src/**\/*.test.ts`, so it is picked up
 * with no config change.
 *
 * Three things are asserted here, all example-based:
 *
 * 1. **Σdebit = Σcredit, per table.** `imbalancePaise(draft)` is `0n` exactly —
 *    `toBe(0n)`, not a tolerance and not a truthiness check — and
 *    `totalDebitPaise` equals `totalCreditPaise` as a separate assertion, so a
 *    bug that made both sides wrong by the same amount is still visible.
 *
 * 2. **The `settlement_pending` amount equals `A − F − G` at a difference of 0
 *    paise** (Requirement 2.3). The oracle is derived independently of the
 *    implementation: `paymentPostingDraft` computes
 *    `subtract(subtract(A, F), G)`, and this file computes
 *    `subtract(A, sum([F, G]))` — `A − (F + G)`, a different association and a
 *    different call sequence over the same calculation service. An
 *    associativity or operand-ordering fault would separate the two. The
 *    difference is then asserted as a difference: `subtract(posted, expected)`
 *    is `0n`, which is the shape property P1 (task 8.5) generalises.
 *
 * 3. **A no-fee Payment produces a valid 2-entry set** — `F = 0n`, `G = 0n`,
 *    debit `settlement_pending` `A`, credit `revenue` `A`. This is the case 8.1
 *    covered for the partial omissions (GST-only zero, net zero) but not for
 *    both-zero.
 *
 * The cheap structural invariants P1 also asserts are pinned across every draft
 * this file produces: every amount strictly `> 0n` (the `paise_positive`
 * domain), entry count within 2..20, `source_refs` non-empty.
 *
 * **Validates: Requirements 2.1, 2.3**
 */

import { describe, expect, it } from 'vitest';

import { PAISE_MAX, type Paise, subtract, sum } from '@/calc/calculation-service';
import {
  ACCOUNT,
  imbalancePaise,
  type LedgerEntrySetDraft,
  paymentPostingDraft,
  refundPostingDraft,
  settlementPostingDraft,
  transferPostingDraft,
  transferReversalPostingDraft,
  totalCreditPaise,
  totalDebitPaise,
} from './posting-rules';

const DATE = '2026-02-14';

// ---------------------------------------------------------------------------
// The fee/GST spread
// ---------------------------------------------------------------------------

interface PaymentCase {
  /** What the case is for, so a failure names itself. */
  readonly label: string;
  /** Gross `A`. */
  readonly gross_paise: Paise;
  /** Razorpay_Fee `F`. */
  readonly fee_paise: Paise;
  /** GST_On_Fee `G`. */
  readonly gst_on_fee_paise: Paise;
  /** How many entries survive the omit-zero step. */
  readonly expectedEntryCount: number;
}

/**
 * A spread rather than one worked example: both components zero, fee only, GST
 * only, both present, the two of them consuming the whole gross amount, the
 * smallest Payment that admits a posting at all, and the top of the paise range
 * both with and without a surviving net line.
 */
const PAYMENT_CASES: readonly PaymentCase[] = [
  {
    label: 'no fee and no GST',
    gross_paise: 100000n,
    fee_paise: 0n,
    gst_on_fee_paise: 0n,
    expectedEntryCount: 2,
  },
  {
    label: 'fee only',
    gross_paise: 100000n,
    fee_paise: 2360n,
    gst_on_fee_paise: 0n,
    expectedEntryCount: 3,
  },
  {
    label: 'GST only, with no fee under it',
    gross_paise: 100000n,
    fee_paise: 0n,
    gst_on_fee_paise: 424n,
    expectedEntryCount: 3,
  },
  {
    label: 'fee and GST both present',
    gross_paise: 100000n,
    fee_paise: 2360n,
    gst_on_fee_paise: 424n,
    expectedEntryCount: 4,
  },
  {
    label: 'fee plus GST equal to the gross amount, so the net line is omitted',
    gross_paise: 2784n,
    fee_paise: 2360n,
    gst_on_fee_paise: 424n,
    expectedEntryCount: 3,
  },
  {
    label: 'the smallest valid Payment: 1 paisa, nothing else',
    gross_paise: 1n,
    fee_paise: 0n,
    gst_on_fee_paise: 0n,
    expectedEntryCount: 2,
  },
  {
    label: 'the smallest Payment that still posts all four lines',
    gross_paise: 3n,
    fee_paise: 1n,
    gst_on_fee_paise: 1n,
    expectedEntryCount: 4,
  },
  {
    label: 'a 1-paisa net under a fee: the tightest surviving net line',
    gross_paise: 2n,
    fee_paise: 1n,
    gst_on_fee_paise: 0n,
    expectedEntryCount: 3,
  },
  {
    label: 'a 1-paisa net under GST alone',
    gross_paise: 2n,
    fee_paise: 0n,
    gst_on_fee_paise: 1n,
    expectedEntryCount: 3,
  },
  {
    label: 'the top of the paise range with a net that still survives',
    gross_paise: PAISE_MAX,
    fee_paise: 1n,
    gst_on_fee_paise: 1n,
    expectedEntryCount: 4,
  },
  {
    label: 'the top of the paise range with no fee at all',
    gross_paise: PAISE_MAX,
    fee_paise: 0n,
    gst_on_fee_paise: 0n,
    expectedEntryCount: 2,
  },
  {
    label: 'the top of the paise range consumed entirely by fee and GST',
    gross_paise: PAISE_MAX,
    fee_paise: PAISE_MAX - 1n,
    gst_on_fee_paise: 1n,
    expectedEntryCount: 3,
  },
];

/** Refund amounts `R`: the floor, a working figure, and the ceiling. */
const REFUND_AMOUNTS: readonly Paise[] = [1n, 40000n, 81940000n, PAISE_MAX];

/** Settlement received amounts `S`, over the same span. */
const SETTLEMENT_AMOUNTS: readonly Paise[] = [1n, 500n, 81940000n, PAISE_MAX];

/** Route amounts `T` and `V`, including floor, working values, and ceiling. */
const ROUTE_AMOUNTS: readonly Paise[] = [1n, 500n, 12_345n, PAISE_MAX];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function draftFor(paymentCase: PaymentCase): LedgerEntrySetDraft {
  return paymentPostingDraft({
    payment_id: `pay_${paymentCase.gross_paise}_${paymentCase.fee_paise}_${paymentCase.gst_on_fee_paise}`,
    entry_date: DATE,
    amount_paise: paymentCase.gross_paise,
    fee_paise: paymentCase.fee_paise,
    gst_on_fee_paise: paymentCase.gst_on_fee_paise,
  });
}

/**
 * The oracle for `N`, derived independently of `paymentPostingDraft`.
 *
 * The implementation associates left: `(A − F) − G`, two `subtract` calls. This
 * associates right: `A − (F + G)`, a `sum` then one `subtract`. Both go through
 * the calculation service, so both are exact — but they are not the same
 * expression evaluated the same way, which is the point.
 */
function expectedNetPaise(paymentCase: PaymentCase): Paise {
  return subtract(
    paymentCase.gross_paise,
    sum([paymentCase.fee_paise, paymentCase.gst_on_fee_paise]),
  );
}

/**
 * The amount actually posted to `settlement_pending`, `0n` when the line was
 * omitted. Omission and a 0-paise posting are the same accounting fact — the
 * account did not move — so treating them alike lets the `A − F − G` identity be
 * stated once for every case in the table, including the ones where fee and GST
 * consume the whole gross amount.
 */
function postedSettlementPendingPaise(draft: LedgerEntrySetDraft): Paise {
  const entry = draft.entries.find((e) => e.account_code === ACCOUNT.SETTLEMENT_PENDING);
  return entry === undefined ? 0n : entry.amount_paise;
}

/** Every draft this file produces, across all five tables. */
function allDrafts(): readonly { readonly label: string; readonly draft: LedgerEntrySetDraft }[] {
  return [
    ...PAYMENT_CASES.map((c) => ({ label: `Payment: ${c.label}`, draft: draftFor(c) })),
    ...REFUND_AMOUNTS.map((amount) => ({
      label: `Refund of ${amount} paise`,
      draft: refundPostingDraft({
        refund_id: `rfnd_${amount}`,
        payment_id: `pay_${amount}`,
        entry_date: DATE,
        amount_paise: amount,
      }),
    })),
    ...SETTLEMENT_AMOUNTS.map((amount) => ({
      label: `Settlement of ${amount} paise`,
      draft: settlementPostingDraft({
        settlement_id: `setl_${amount}`,
        settlement_recon_report_id: `rep_${amount}`,
        entry_date: DATE,
        received_amount_paise: amount,
      }),
    })),
    ...ROUTE_AMOUNTS.flatMap((amount) => [
      {
        label: `Transfer of ${amount} paise`,
        draft: transferPostingDraft({
          transfer_id: `trf_${amount}`,
          entry_date: DATE,
          amount_paise: amount,
        }),
      },
      {
        label: `Transfer_Reversal of ${amount} paise`,
        draft: transferReversalPostingDraft({
          transfer_reversal_id: `trfr_${amount}`,
          entry_date: DATE,
          reversed_amount_paise: amount,
        }),
      },
    ]),
  ];
}

// ---------------------------------------------------------------------------
// 1. Σdebit = Σcredit, per table
// ---------------------------------------------------------------------------

describe('the Payment table balances at exactly 0 paise', () => {
  it.each(PAYMENT_CASES)('$label', (paymentCase) => {
    const draft = draftFor(paymentCase);
    expect(imbalancePaise(draft)).toBe(0n);
    expect(totalDebitPaise(draft)).toBe(totalCreditPaise(draft));
    // The credit side of a Payment is the gross amount alone, so Σdebit lands
    // on `A` too. Asserting that pins which value the sides agree on, not just
    // that they agree.
    expect(totalDebitPaise(draft)).toBe(paymentCase.gross_paise);
    expect(draft.entries).toHaveLength(paymentCase.expectedEntryCount);
  });
});

describe('the Refund table balances at exactly 0 paise', () => {
  it.each(REFUND_AMOUNTS)('a Refund of %s paise', (amount) => {
    const draft = refundPostingDraft({
      refund_id: `rfnd_${amount}`,
      payment_id: 'pay_ABC123',
      entry_date: DATE,
      amount_paise: amount,
    });
    expect(imbalancePaise(draft)).toBe(0n);
    expect(totalDebitPaise(draft)).toBe(totalCreditPaise(draft));
    expect(totalDebitPaise(draft)).toBe(amount);
  });
});

describe('the Settlement table balances at exactly 0 paise', () => {
  it.each(SETTLEMENT_AMOUNTS)('a Settlement of %s paise', (amount) => {
    const draft = settlementPostingDraft({
      settlement_id: `setl_${amount}`,
      settlement_recon_report_id: null,
      entry_date: DATE,
      received_amount_paise: amount,
    });
    expect(imbalancePaise(draft)).toBe(0n);
    expect(totalDebitPaise(draft)).toBe(totalCreditPaise(draft));
    expect(totalDebitPaise(draft)).toBe(amount);
  });
});

// ---------------------------------------------------------------------------
// 2. The settlement-pending amount is A − F − G, difference 0 paise
// ---------------------------------------------------------------------------

describe('the settlement-pending amount equals A - F - G with a difference of 0 paise', () => {
  it.each(PAYMENT_CASES)('$label', (paymentCase) => {
    const draft = draftFor(paymentCase);
    const expected = expectedNetPaise(paymentCase);
    const posted = postedSettlementPendingPaise(draft);

    // Stated as a difference, the way Requirement 2.3 and property P1 state it.
    expect(subtract(posted, expected)).toBe(0n);
    expect(posted).toBe(expected);

    const entry = draft.entries.find((e) => e.account_code === ACCOUNT.SETTLEMENT_PENDING);
    if (expected === 0n) {
      // A 0-paise net is omitted, never posted: `amount_paise` is the
      // `paise_positive` domain, so the row would be rejected outright.
      expect(entry).toBeUndefined();
    } else {
      expect(entry?.side).toBe('debit');
      expect(entry?.amount_paise).toBe(expected);
    }
  });

  it('holds the identity independently of the order the fee and GST are subtracted in', () => {
    for (const paymentCase of PAYMENT_CASES) {
      const { gross_paise: gross, fee_paise: fee, gst_on_fee_paise: gst } = paymentCase;
      // (A - F) - G, A - (F + G), and (A - G) - F are the three orderings a
      // caller could plausibly write. All three must agree exactly, which is
      // what makes the oracle above a legitimate independent check.
      const leftAssociated = subtract(subtract(gross, fee), gst);
      const rightAssociated = subtract(gross, sum([fee, gst]));
      const gstFirst = subtract(subtract(gross, gst), fee);
      expect(subtract(leftAssociated, rightAssociated)).toBe(0n);
      expect(subtract(gstFirst, rightAssociated)).toBe(0n);
      expect(postedSettlementPendingPaise(draftFor(paymentCase))).toBe(rightAssociated);
    }
  });

  it('leaves the fee and GST lines at the amounts they were read from', () => {
    // The identity is only meaningful if the other two debit lines carry F and
    // G unchanged: a net of A - F - G against a fee line of some other value
    // would still balance, and would still be wrong.
    for (const paymentCase of PAYMENT_CASES) {
      const draft = draftFor(paymentCase);
      const amountOn = (code: string): Paise =>
        draft.entries.find((e) => e.account_code === code)?.amount_paise ?? 0n;
      expect(amountOn(ACCOUNT.RAZORPAY_FEE_EXPENSE)).toBe(paymentCase.fee_paise);
      expect(amountOn(ACCOUNT.GST_INPUT_CREDIT)).toBe(paymentCase.gst_on_fee_paise);
      expect(amountOn(ACCOUNT.REVENUE)).toBe(paymentCase.gross_paise);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. A no-fee Payment is a valid 2-entry set
// ---------------------------------------------------------------------------

describe('a Payment with no fee and no GST', () => {
  const NO_FEE_AMOUNTS: readonly Paise[] = [1n, 100n, 100000n, PAISE_MAX];

  it.each(NO_FEE_AMOUNTS)(
    'posts exactly 2 entries for a gross amount of %s paise',
    (gross) => {
      const draft = paymentPostingDraft({
        payment_id: `pay_nofee_${gross}`,
        entry_date: DATE,
        amount_paise: gross,
        fee_paise: 0n,
        gst_on_fee_paise: 0n,
      });

      expect(draft.entries).toHaveLength(2);
      expect(draft.entries).toEqual([
        { account_code: ACCOUNT.SETTLEMENT_PENDING, side: 'debit', amount_paise: gross },
        { account_code: ACCOUNT.REVENUE, side: 'credit', amount_paise: gross },
      ]);

      // Both amounts are the gross amount, since N = A - 0 - 0 = A.
      const [debitEntry, creditEntry] = draft.entries;
      expect(debitEntry?.side).toBe('debit');
      expect(debitEntry?.amount_paise).toBe(gross);
      expect(creditEntry?.side).toBe('credit');
      expect(creditEntry?.amount_paise).toBe(gross);

      expect(subtract(postedSettlementPendingPaise(draft), gross)).toBe(0n);
      expect(imbalancePaise(draft)).toBe(0n);
      expect(totalDebitPaise(draft)).toBe(totalCreditPaise(draft));
      // Neither omitted account appears at all, rather than appearing at 0.
      const codes = draft.entries.map((e) => e.account_code);
      expect(codes).not.toContain(ACCOUNT.RAZORPAY_FEE_EXPENSE);
      expect(codes).not.toContain(ACCOUNT.GST_INPUT_CREDIT);
    },
  );
});

// ---------------------------------------------------------------------------
// The cheap structural invariants P1 also asserts
// ---------------------------------------------------------------------------

describe('every draft from every table', () => {
  it.each(allDrafts())('$label holds the paise_positive domain', ({ draft }) => {
    for (const entry of draft.entries) {
      expect(entry.amount_paise > 0n).toBe(true);
    }
  });

  it.each(allDrafts())('$label holds 2..20 entries', ({ draft }) => {
    expect(draft.entries.length).toBeGreaterThanOrEqual(2);
    expect(draft.entries.length).toBeLessThanOrEqual(20);
  });

  it.each(allDrafts())('$label carries at least 1 Source_Record ref', ({ draft }) => {
    expect(draft.source_refs.length).toBeGreaterThanOrEqual(1);
    for (const ref of draft.source_refs) {
      expect(ref.id.trim().length).toBeGreaterThan(0);
    }
  });
});
