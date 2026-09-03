import { describe, expect, it } from 'vitest';

import { memoryExceptionStore } from './agent.test-support';
import {
  ambiguousMatchExceptionFor,
  createRemainingDetectorRunner,
  excludeAmbiguousMatchesFromUnsettled,
  missingAccrualExceptionFor,
  possibleDuplicateRefundExceptionFor,
  type CreditNoteReconciliation,
  RemainingDetectorError,
  unmatchedCreditNoteExceptionFor,
} from './remaining-detectors';
import { matchPaymentLifecycle, type PaymentLinks } from './match';
import type { DuplicateRefundCandidateRow } from '@/tools/get-duplicate-refund-candidates';
import type { MissingAccrualRow } from '@/tools/get-missing-accruals';

const TENANT = '11111111-1111-4111-8111-111111111111';
const DETECTED = '2026-07-30T09:15:00.000Z';
const LATER = '2026-07-31T09:15:00.000Z';
const CHAIN = '33333333-3333-4333-8333-333333333333';

function links(overrides: Partial<PaymentLinks> = {}): PaymentLinks {
  return {
    payment_id: 'pay_one',
    order_ids: [],
    razorpay_invoice_ids: [],
    settlement_ids: [],
    ledger_entry_ids: [],
    ...overrides,
  };
}

function duplicate(overrides: Partial<DuplicateRefundCandidateRow> = {}): DuplicateRefundCandidateRow {
  return {
    payment_id: 'pay_dup',
    payment_paise: 100n,
    refund_ids: ['rfnd_b', 'rfnd_a'],
    combined_refund_paise: 101n,
    excess_paise: 1n,
    evidence_chain_id: CHAIN,
    evidence_as_of: DETECTED,
    ...overrides,
  };
}

function missing(
  type: 'payment' | 'refund',
  id: string,
  amountPaise = 500n,
): MissingAccrualRow {
  return {
    ref: { type, id },
    amount_paise: amountPaise,
    evidence_chain_id: CHAIN,
    evidence_as_of: DETECTED,
  };
}

function note(overrides: Partial<CreditNoteReconciliation> = {}): CreditNoteReconciliation {
  return {
    credit_note_id: 'cn_one',
    value_paise: 700n,
    linked_invoice_id: null,
    linked_invoice_adjusted_value_paise: null,
    evidence_chain_id: CHAIN,
    ...overrides,
  };
}
describe('possible duplicate Refund detector (Requirement 4.8)', () => {
  it('creates a one-paisa Exception referencing the Payment and every Refund', () => {
    const exception = possibleDuplicateRefundExceptionFor(duplicate(), DETECTED);
    expect(exception).toMatchObject({
      category: 'possible_duplicate_refund',
      impact_paise: 1n,
      direction: 'not_applicable',
      evidence_chain_id: CHAIN,
    });
    expect(exception?.source_refs).toEqual([
      { type: 'payment', id: 'pay_dup', role: 'payment' },
      { type: 'refund', id: 'rfnd_a', role: 'contributing_refund' },
      { type: 'refund', id: 'rfnd_b', role: 'contributing_refund' },
    ]);
  });

  it('creates no Exception at or below the Payment value, or with fewer than two Refunds', () => {
    expect(
      possibleDuplicateRefundExceptionFor(
        duplicate({ combined_refund_paise: 100n, excess_paise: 0n }),
        DETECTED,
      ),
    ).toBeNull();
    expect(
      possibleDuplicateRefundExceptionFor(
        duplicate({ combined_refund_paise: 99n, excess_paise: -1n }),
        DETECTED,
      ),
    ).toBeNull();
    expect(possibleDuplicateRefundExceptionFor(duplicate({ refund_ids: ['rfnd_a'] }), DETECTED))
      .toBeNull();
  });

  it('rejects a tool row whose stated excess disagrees with exact paise subtraction', () => {
    expect(() => possibleDuplicateRefundExceptionFor(duplicate({ excess_paise: 2n }), DETECTED))
      .toThrow(RemainingDetectorError);
  });
});

describe('Unmatched_Credit_Note detector (Requirement 4.9)', () => {
  it('detects no linked Invoice and references only the Credit_Note', () => {
    const exception = unmatchedCreditNoteExceptionFor(note(), DETECTED);
    expect(exception?.impact_paise).toBe(700n);
    expect(exception?.source_refs).toEqual([
      { type: 'credit_note', id: 'cn_one', role: 'credit_note' },
    ]);
    expect(exception?.detail.failing_rule).toBe('no_linked_invoice');
  });

  it('detects a linked Invoice adjusted-value mismatch and references both records', () => {
    const exception = unmatchedCreditNoteExceptionFor(
      note({ linked_invoice_id: 'inv_one', linked_invoice_adjusted_value_paise: 699n }),
      DETECTED,
    );
    expect(exception?.source_refs.map((source) => `${source.type}:${source.id}`)).toEqual([
      'credit_note:cn_one',
      'razorpay_invoice:inv_one',
    ]);
    expect(exception?.detail).toMatchObject({
      failing_rule: 'linked_invoice_adjusted_value_mismatch',
      credit_note_value_paise: '700',
      linked_invoice_adjusted_value_paise: '699',
    });
  });

  it('creates no Exception when the stored linked Invoice adjusted value reconciles exactly', () => {
    expect(
      unmatchedCreditNoteExceptionFor(
        note({ linked_invoice_id: 'inv_one', linked_invoice_adjusted_value_paise: 700n }),
        DETECTED,
      ),
    ).toBeNull();
  });
});
describe('missing accrual detector (Requirement 4.10)', () => {
  it('uses the lifecycle not-matched marker for a Payment and the exact tool fact for a Refund', () => {
    const payment = matchPaymentLifecycle(links({ payment_id: 'pay_missing' }));
    const byPayment = new Map([[payment.payment_id, payment]]);
    expect(missingAccrualExceptionFor(missing('payment', 'pay_missing'), byPayment, DETECTED))
      .toMatchObject({ category: 'missing_accrual', impact_paise: 500n });
    expect(missingAccrualExceptionFor(missing('refund', 'rfnd_missing'), byPayment, DETECTED))
      .toMatchObject({ category: 'missing_accrual', impact_paise: 500n });
  });

  it('creates no Payment Exception when lifecycle links a Ledger_Entry', () => {
    const payment = matchPaymentLifecycle(
      links({ payment_id: 'pay_posted', ledger_entry_ids: ['entry_one'] }),
    );
    expect(
      missingAccrualExceptionFor(
        missing('payment', 'pay_posted'),
        new Map([[payment.payment_id, payment]]),
        DETECTED,
      ),
    ).toBeNull();
  });

  it('refuses to infer a missing Payment accrual without a lifecycle result', () => {
    expect(() => missingAccrualExceptionFor(missing('payment', 'pay_unknown'), new Map(), DETECTED))
      .toThrow(/no identifier-only lifecycle result/);
  });
});

describe('ambiguous match detector and unsettled exclusion (Requirement 4.14)', () => {
  const ambiguous = matchPaymentLifecycle(
    links({
      payment_id: 'pay_ambiguous',
      settlement_ids: ['setl_b', 'setl_a'],
      razorpay_invoice_ids: ['inv_b', 'inv_a'],
    }),
  );
  const invoiceOnly = matchPaymentLifecycle(
    links({ payment_id: 'pay_invoice_only', razorpay_invoice_ids: ['inv_d', 'inv_c'] }),
  );

  it('references the Payment and every candidate from identifier-only matcher exports', () => {
    expect(ambiguousMatchExceptionFor(ambiguous, DETECTED)?.source_refs).toEqual([
      { type: 'payment', id: 'pay_ambiguous', role: 'payment' },
      { type: 'razorpay_invoice', id: 'inv_a', role: 'candidate' },
      { type: 'razorpay_invoice', id: 'inv_b', role: 'candidate' },
      { type: 'settlement', id: 'setl_a', role: 'candidate' },
      { type: 'settlement', id: 'setl_b', role: 'candidate' },
    ]);
  });

  it('creates no Exception for zero or one candidate', () => {
    expect(ambiguousMatchExceptionFor(matchPaymentLifecycle(links()), DETECTED)).toBeNull();
    expect(
      ambiguousMatchExceptionFor(
        matchPaymentLifecycle(links({ settlement_ids: ['setl_one'] })),
        DETECTED,
      ),
    ).toBeNull();
  });

  it('excludes Settlement ambiguity and Invoice-only ambiguity from unsettled rows', () => {
    const rows = [
      { payment_id: 'pay_ambiguous' },
      { payment_id: 'pay_invoice_only' },
      { payment_id: 'pay_truly_unsettled' },
    ];
    expect(excludeAmbiguousMatchesFromUnsettled(rows, [ambiguous, invoiceOnly])).toEqual([
      { payment_id: 'pay_truly_unsettled' },
    ]);
  });
});
describe('remaining detector runner', () => {
  it('upserts all four categories through the shared fingerprint lifecycle', async () => {
    const exceptions = memoryExceptionStore();
    const lifecycle = [
      matchPaymentLifecycle(links({ payment_id: 'pay_missing' })),
      matchPaymentLifecycle(
        links({ payment_id: 'pay_ambiguous', settlement_ids: ['setl_a', 'setl_b'] }),
      ),
    ];
    const runner = createRemainingDetectorRunner({ tenantId: TENANT, exceptions });
    const first = await runner.run({
      duplicate_refunds: [duplicate()],
      credit_notes: [note()],
      missing_accruals: [missing('payment', 'pay_missing'), missing('refund', 'rfnd_missing')],
      lifecycle_matches: lifecycle,
      detected_at: DETECTED,
    });

    expect(first.created_count).toBe(5);
    expect(first.updated_count).toBe(0);
    expect(first.detections.map((item) => item.exception.category)).toEqual([
      'possible_duplicate_refund',
      'unmatched_credit_note',
      'missing_accrual',
      'missing_accrual',
      'ambiguous_match',
    ]);
    expect(first.unsettled_excluded_payment_ids).toEqual(['pay_ambiguous']);
    expect(exceptions.rows.size).toBe(5);

    const second = await runner.run({
      duplicate_refunds: [duplicate()],
      credit_notes: [note()],
      missing_accruals: [missing('refund', 'rfnd_missing'), missing('payment', 'pay_missing')],
      lifecycle_matches: [...lifecycle].reverse(),
      detected_at: LATER,
    });
    expect(second.created_count).toBe(0);
    expect(second.updated_count).toBe(5);
    expect(exceptions.rows.size).toBe(5);
    for (const stored of exceptions.rows.values()) {
      expect(stored.first_detected_at).toBe(DETECTED);
      expect(stored.last_detected_at).toBe(LATER);
    }
  });

  it('reports a closed Exception without reopening it', async () => {
    const exceptions = memoryExceptionStore();
    const runner = createRemainingDetectorRunner({ tenantId: TENANT, exceptions });
    const input = {
      duplicate_refunds: [duplicate()],
      credit_notes: [],
      missing_accruals: [],
      lifecycle_matches: [],
      detected_at: DETECTED,
    } as const;
    await runner.run(input);
    const stored = [...exceptions.rows.values()][0];
    if (stored === undefined) throw new Error('first run wrote no Exception');
    stored.state = 'resolved';

    const report = await runner.run({ ...input, detected_at: LATER });
    expect(report.not_reopened_count).toBe(1);
    expect(report.created_count).toBe(0);
    expect(stored.state).toBe('resolved');
    expect(stored.last_detected_at).toBe(DETECTED);
  });
});
