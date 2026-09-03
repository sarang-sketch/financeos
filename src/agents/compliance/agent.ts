/**
 * Compliance_Agent — India tax issue detection and review.
 *
 * Requirements: 6.1..6.12
 *
 * Key duties:
 *   1. Examines Invoices, Payments, Credit Notes, GSTINs, HSN/SAC, and tax amounts
 *      over a date range (default preceding 90 days, max 366 days).
 *   2. Detects 6 Exception categories:
 *      - missing_gst_information (Req 6.2)
 *      - invalid_gstin (Req 6.3)
 *      - itc_discrepancy (Req 6.4)
 *      - record_needing_review (Req 6.5)
 *      - unmatched_credit_note (Req 6.6)
 *      - gst_anomaly (Req 6.10)
 *   3. Computes TDS Review Items (Req 6.7)
 *   4. Attaches non-negotiable review-only disclaimer (Req 6.8, 6.9)
 *   5. Fingerprint-based upsert for idempotency on re-run (Req 6.12)
 */

import {
  createExceptionUpserter,
  exceptionFingerprint,
  exceptionWriteFor,
  type ExceptionCategory,
  type ExceptionDetail,
  type ExceptionDirection,
  type ExceptionStore,
  type ExceptionWrite,
} from '@/agents/exception-fingerprint';
import {
  add,
  applyRate,
  assertInRange,
  roundHalfUpToPaisa,
  subtract,
  sum,
  type Paise,
} from '@/calc/calculation-service';
import { validateGstin, type GstinValidationFailure } from '@/compliance/gstin';
import type { TenantId } from '@/config/configuration-service';
import type { DateOnly, SourceRecordType, SourceRef } from '@/ledger/posting-rules';
import { assertDateOnlyValue, rangeLengthInDays, type DateRange } from '@/tools/settlement-scope';

export const COMPLIANCE_DISCLAIMER =
  'This item is for review only and is not authoritative tax advice.';

export const DEFAULT_VALID_GST_RATES = [0, 0.25, 3, 5, 12, 18, 28] as const;

export interface ComplianceInvoiceLine {
  readonly hsn_sac?: string | null;
  readonly amount_paise: Paise;
  readonly tax_amount_paise?: Paise | null;
}

export interface ComplianceInvoice {
  readonly id: string;
  readonly invoice_date: DateOnly;
  readonly customer_id?: string | null;
  readonly customer_gstin?: string | null;
  readonly total_amount_paise: Paise;
  readonly taxable_amount_paise: Paise;
  readonly tax_amount_paise?: Paise | null;
  readonly lines?: readonly ComplianceInvoiceLine[];
  readonly is_inward?: boolean; // For inward purchase invoices for ITC computation
}

export interface CompliancePayment {
  readonly id: string;
  readonly payment_date: DateOnly;
  readonly customer_id?: string | null;
  readonly vendor_id?: string | null;
  readonly customer_gstin?: string | null;
  readonly vendor_gstin?: string | null;
  readonly amount_paise: Paise;
  readonly fee_paise: Paise;
  readonly gst_on_fee_paise: Paise;
  readonly is_vendor_payment?: boolean;
  readonly category?: string | null; // e.g. 'professional_services', 'rent', 'contractor'
}

export interface ComplianceCreditNote {
  readonly id: string;
  readonly credit_note_date: DateOnly;
  readonly invoice_id?: string | null;
  readonly amount_paise: Paise;
  readonly invoice_adjusted_amount_paise?: Paise | null;
}

export interface ComplianceLedgerEntry {
  readonly id: string;
  readonly entry_date: DateOnly;
  readonly account_code: string;
  readonly side: 'debit' | 'credit';
  readonly amount_paise: Paise;
  readonly is_itc_account?: boolean;
}

export interface TdsReviewItem {
  readonly vendor_pan: string;
  readonly vendor_name: string;
  readonly section: string;
  readonly applicable_rate_bps: bigint;
  readonly cumulative_credited_paise: Paise;
  readonly threshold_paise: Paise;
  readonly is_threshold_breached: boolean;
  readonly recommended_tds_deduction_paise: Paise;
}

export interface ComplianceExaminedCounts {
  readonly invoices: number;
  readonly payments: number;
  readonly credit_notes: number;
  readonly ledger_entries: number;
}

export interface ComplianceRunConfig {
  readonly review_threshold_paise?: Paise; // Default 50,000 INR = 5,000,000 paise
  readonly valid_gst_rates?: readonly number[]; // Default [0, 0.25, 3, 5, 12, 18, 28]
  readonly tds_rates?: Readonly<Record<string, number>>; // Category -> percentage e.g. { 'professional_services': 10.0 }
}

export interface ComplianceRunInput {
  readonly tenant_id: TenantId;
  readonly range: DateRange;
  readonly invoices: readonly ComplianceInvoice[];
  readonly payments: readonly CompliancePayment[];
  readonly credit_notes: readonly ComplianceCreditNote[];
  readonly ledger_entries?: readonly ComplianceLedgerEntry[];
  readonly config?: ComplianceRunConfig;
  readonly detected_at?: string; // ISO UTC ms
}

export type ComplianceInputData = ComplianceRunInput;

export interface ComplianceFinding {
  readonly id: string;
  readonly category:
    | 'missing_gst_information'
    | 'invalid_gstin'
    | 'gst_anomaly'
    | 'record_needing_review'
    | 'unmatched_credit_note'
    | 'itc_discrepancy';
  readonly impact_paise: Paise;
  readonly direction: 'receivable' | 'payable' | 'neutral';
  readonly detail: Record<string, unknown>;
  readonly evidence_chain_id: string | null;
  readonly source_records: readonly { type: SourceRecordType; id: string; field: string }[];
}

export interface ComplianceEvaluationResult {
  readonly total_impact_paise: Paise;
  readonly findings: readonly ComplianceFinding[];
  readonly tds_review_items: readonly TdsReviewItem[];
  readonly examined_counts: ComplianceExaminedCounts;
  readonly disclaimer: string;
}

export interface ComplianceExceptionItem {
  readonly tenant_id: TenantId;
  readonly category: ExceptionCategory;
  readonly impact_paise: Paise;
  readonly direction: ExceptionDirection;
  readonly detail: Record<string, unknown>;
  readonly fingerprint: string;
  readonly source_records: readonly { type: SourceRecordType; id: string }[];
}

export interface ComplianceRunResult {
  readonly range: DateRange;
  readonly examined_counts: ComplianceExaminedCounts;
  readonly exceptions: readonly ComplianceExceptionItem[];
  readonly writes: readonly ExceptionWrite[];
  readonly tds_review_items: readonly TdsReviewItem[];
  readonly itc_expected_paise: Paise;
  readonly itc_recorded_paise: Paise;
  readonly itc_discrepancy_paise: Paise;
  readonly disclaimer: string;
}

export class ComplianceAgent {
  constructor(private readonly exceptionStore?: ExceptionStore) {}

  /**
   * Run compliance evaluation synchronously for tools.
   */
  evaluate(input: ComplianceRunInput): ComplianceEvaluationResult {
    const res = this.runSync(input);
    const findings: ComplianceFinding[] = res.exceptions.map((exc, idx) => {
      let dir: 'receivable' | 'payable' | 'neutral' = 'neutral';
      if (exc.direction === 'shortfall') dir = 'payable';
      else if (exc.direction === 'excess') dir = 'receivable';

      return {
        id: `cf_${exc.category}_${idx + 1}`,
        category: exc.category as ComplianceFinding['category'],
        impact_paise: exc.impact_paise,
        direction: dir,
        detail: exc.detail,
        evidence_chain_id: null,
        source_records: exc.source_records.map((s) => ({
          type: s.type,
          id: s.id,
          field: 'amount_paise',
        })),
      };
    });

    const totalImpact = sum(findings.map((f) => f.impact_paise));

    return {
      total_impact_paise: totalImpact,
      findings,
      tds_review_items: res.tds_review_items,
      examined_counts: res.examined_counts,
      disclaimer: COMPLIANCE_DISCLAIMER,
    };
  }

  /**
   * Run compliance detection and analysis for a given date range.
   */
  async run(input: ComplianceRunInput): Promise<ComplianceRunResult> {
    const result = this.runSync(input);

    if (this.exceptionStore && result.exceptions.length > 0) {
      const upserter = createExceptionUpserter({
        store: this.exceptionStore,
        tenantId: input.tenant_id,
      });

      for (const exc of result.exceptions) {
        await upserter.upsert({
          category: exc.category,
          source_refs: exc.source_records.map((s) => ({ type: s.type, id: s.id })),
          impact_paise: exc.impact_paise,
          direction: exc.direction,
          detail: exc.detail as unknown as ExceptionDetail,
          evidence_chain_id: null,
          detected_at: input.detected_at ?? new Date().toISOString(),
        });
      }
    }

    return result;
  }

  private runSync(input: ComplianceRunInput): ComplianceRunResult {
    assertDateOnlyValue(input.range.from, 'ComplianceRunInput.range.from');
    assertDateOnlyValue(input.range.to, 'ComplianceRunInput.range.to');
    const days = rangeLengthInDays(input.range);
    if (days < 1 || days > 366) {
      throw new Error(`Compliance range must be between 1 and 366 days, got ${days}`);
    }

    const reviewThresholdPaise = input.config?.review_threshold_paise ?? 5000000n; // 50,000 INR default
    const validGstRates = input.config?.valid_gst_rates ?? DEFAULT_VALID_GST_RATES;
    const tdsRates = input.config?.tds_rates ?? {};
    const detectedAt = input.detected_at ?? new Date().toISOString();

    const inRangeInvoices = input.invoices.filter(
      (inv) => inv.invoice_date >= input.range.from && inv.invoice_date <= input.range.to,
    );
    const inRangePayments = input.payments.filter(
      (p) => p.payment_date >= input.range.from && p.payment_date <= input.range.to,
    );
    const inRangeCreditNotes = input.credit_notes.filter(
      (cn) => cn.credit_note_date >= input.range.from && cn.credit_note_date <= input.range.to,
    );
    const inRangeLedger = (input.ledger_entries ?? []).filter(
      (le) => le.entry_date >= input.range.from && le.entry_date <= input.range.to,
    );

    const items: ComplianceExceptionItem[] = [];
    const writes: ExceptionWrite[] = [];
    const tdsItems: TdsReviewItem[] = [];

    const recordException = (
      category: ExceptionCategory,
      impactPaise: Paise,
      direction: ExceptionDirection,
      detail: Record<string, unknown>,
      sourceRefs: readonly { type: SourceRecordType; id: string }[],
    ) => {
      const fingerprint = exceptionFingerprint({
        tenant_id: input.tenant_id,
        category,
        source_refs: sourceRefs.map((s) => ({ type: s.type, id: s.id })),
      });

      items.push({
        tenant_id: input.tenant_id,
        category,
        impact_paise: impactPaise,
        direction,
        detail,
        fingerprint,
        source_records: sourceRefs,
      });

      const write = exceptionWriteFor(input.tenant_id, {
        category,
        impact_paise: impactPaise,
        direction,
        detail: detail as unknown as ExceptionDetail,
        evidence_chain_id: null,
        detected_at: detectedAt,
        source_refs: sourceRefs,
      });
      writes.push(write);
    };

    // 1. Missing GST Information (Req 6.2) & GST Anomaly (Req 6.10) & Invalid GSTIN on Invoices (Req 6.3)
    for (const inv of inRangeInvoices) {
      const absentFields: string[] = [];
      if (!inv.customer_gstin || inv.customer_gstin.trim().length === 0) {
        absentFields.push('customer_gstin');
      } else {
        const gstinRes = validateGstin(inv.customer_gstin);
        if (!gstinRes.valid) {
          recordException(
            'invalid_gstin',
            inv.tax_amount_paise ?? 0n,
            'not_applicable',
            {
              record_type: 'razorpay_invoice',
              record_id: inv.id,
              gstin: inv.customer_gstin,
              failed_rule: gstinRes.failingRule,
              reason: gstinRes.reason,
            },
            [{ type: 'razorpay_invoice', id: inv.id }],
          );
        }
      }

      if (inv.lines && inv.lines.length > 0) {
        for (const line of inv.lines) {
          if (!line.hsn_sac || line.hsn_sac.trim().length === 0) {
            if (!absentFields.includes('hsn_sac')) {
              absentFields.push('hsn_sac');
            }
          }
        }
      }

      if (absentFields.length > 0) {
        recordException(
          'missing_gst_information',
          inv.tax_amount_paise ?? 0n,
          'not_applicable',
          {
            record_type: 'razorpay_invoice',
            record_id: inv.id,
            absent_fields: absentFields,
          },
          [{ type: 'razorpay_invoice', id: inv.id }],
        );
      }

      // GST Anomaly: rate not matching standard slab rates
      if (inv.taxable_amount_paise > 0n && inv.tax_amount_paise && inv.tax_amount_paise > 0n) {
        const effectiveRate =
          (Number(inv.tax_amount_paise) / Number(inv.taxable_amount_paise)) * 100;
        const matchingSlab = validGstRates.some((rate) => Math.abs(rate - effectiveRate) < 0.15);
        if (!matchingSlab) {
          recordException(
            'gst_anomaly',
            inv.tax_amount_paise,
            'not_applicable',
            {
              record_type: 'razorpay_invoice',
              record_id: inv.id,
              effective_rate_percent: Math.round(effectiveRate * 100) / 100,
              valid_slabs: validGstRates.map((r) => `${r}%`),
            },
            [{ type: 'razorpay_invoice', id: inv.id }],
          );
        }
      }
    }

    // 2. Vendor payments & TDS Review
    const customerPaymentsTotal = new Map<string, Paise>();
    for (const p of inRangePayments) {
      if (p.customer_id) {
        const existing = customerPaymentsTotal.get(p.customer_id) ?? 0n;
        customerPaymentsTotal.set(p.customer_id, add(existing, p.amount_paise));
      }

      const ratePercent = p.category ? tdsRates[p.category] : undefined;
      if (p.is_vendor_payment && ratePercent !== undefined) {
        const rateBps = BigInt(Math.round(ratePercent * 100));
        const tdsCalc = applyRate(p.amount_paise, rateBps);
        tdsItems.push({
          vendor_pan: p.vendor_id ?? 'PAN_NOT_PROVIDED',
          vendor_name: p.vendor_id ?? 'Vendor',
          section: '194C / 194J',
          applicable_rate_bps: rateBps,
          cumulative_credited_paise: p.amount_paise,
          threshold_paise: reviewThresholdPaise,
          is_threshold_breached: p.amount_paise >= reviewThresholdPaise,
          recommended_tds_deduction_paise: tdsCalc.result,
        });
      }
    }

    // 3. Record Needing Review: Absent GSTIN with total payments >= threshold
    for (const [custId, totalPaise] of customerPaymentsTotal.entries()) {
      if (totalPaise >= reviewThresholdPaise) {
        const matchingPayments = inRangePayments.filter((p) => p.customer_id === custId);
        const hasGstin = matchingPayments.some(
          (p) => p.customer_gstin && p.customer_gstin.trim().length > 0,
        );
        if (!hasGstin) {
          recordException(
            'record_needing_review',
            totalPaise,
            'not_applicable',
            {
              customer_id: custId,
              cumulative_payment_paise: totalPaise.toString(),
              threshold_paise: reviewThresholdPaise.toString(),
              reason: 'Cumulative payments exceeded threshold without registered GSTIN',
            },
            matchingPayments.slice(0, 5).map((p) => ({ type: 'payment', id: p.id })),
          );
        }
      }
    }

    // 4. Unmatched Credit Notes (Req 6.6)
    for (const cn of inRangeCreditNotes) {
      if (!cn.invoice_id) {
        recordException(
          'unmatched_credit_note',
          cn.amount_paise,
          'not_applicable',
          {
            credit_note_id: cn.id,
            reason: 'Credit note has no associated original invoice reference',
          },
          [{ type: 'credit_note', id: cn.id }],
        );
      } else {
        const origInvoice = input.invoices.find((inv) => inv.id === cn.invoice_id);
        if (!origInvoice) {
          recordException(
            'unmatched_credit_note',
            cn.amount_paise,
            'not_applicable',
            {
              credit_note_id: cn.id,
              referenced_invoice_id: cn.invoice_id,
              reason: 'Referenced invoice not found in records',
            },
            [{ type: 'credit_note', id: cn.id }],
          );
        }
      }
    }

    // 5. Expected vs Recorded ITC (Req 6.4)
    let expectedItc: Paise = 0n;
    for (const inv of inRangeInvoices) {
      if (inv.is_inward && inv.tax_amount_paise) {
        expectedItc = add(expectedItc, inv.tax_amount_paise);
      }
    }
    for (const p of inRangePayments) {
      if (p.gst_on_fee_paise > 0n) {
        expectedItc = add(expectedItc, p.gst_on_fee_paise);
      }
    }

    let recordedItc: Paise = 0n;
    for (const le of inRangeLedger) {
      if (le.is_itc_account) {
        if (le.side === 'credit') {
          recordedItc = subtract(recordedItc, le.amount_paise);
        } else {
          recordedItc = add(recordedItc, le.amount_paise);
        }
      }
    }

    const itcDiscrepancy = subtract(expectedItc, recordedItc);
    if (itcDiscrepancy !== 0n) {
      const itcDirection: ExceptionDirection = itcDiscrepancy > 0n ? 'shortfall' : 'excess';
      const absImpact = itcDiscrepancy >= 0n ? itcDiscrepancy : -itcDiscrepancy;

      const itcRefs: { type: SourceRecordType; id: string }[] = [];
      for (const inv of inRangeInvoices) {
        if (inv.is_inward && inv.tax_amount_paise) {
          itcRefs.push({ type: 'razorpay_invoice', id: inv.id });
        }
      }
      for (const p of inRangePayments) {
        if (p.gst_on_fee_paise > 0n) {
          itcRefs.push({ type: 'payment', id: p.id });
        }
      }
      for (const le of inRangeLedger) {
        if (le.is_itc_account) {
          itcRefs.push({ type: 'ledger_entry_set', id: le.id });
        }
      }

      if (itcRefs.length > 0) {
        recordException(
          'itc_discrepancy',
          absImpact,
          itcDirection,
          {
            expected_itc_paise: expectedItc.toString(),
            recorded_itc_paise: recordedItc.toString(),
            discrepancy_paise: itcDiscrepancy.toString(),
          },
          itcRefs.slice(0, 5),
        );
      }
    }

    return {
      range: input.range,
      examined_counts: {
        invoices: inRangeInvoices.length,
        payments: inRangePayments.length,
        credit_notes: inRangeCreditNotes.length,
        ledger_entries: inRangeLedger.length,
      },
      exceptions: items,
      writes,
      tds_review_items: tdsItems,
      itc_expected_paise: expectedItc,
      itc_recorded_paise: recordedItc,
      itc_discrepancy_paise: itcDiscrepancy,
      disclaimer: COMPLIANCE_DISCLAIMER,
    };
  }
}
