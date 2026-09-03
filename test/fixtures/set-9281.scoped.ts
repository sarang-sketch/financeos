/**
 * SET-9281 as a {@link ScopedSettlement}: the worked example in the shape
 * `src/tools/settlement-scope.ts`'s read seam answers with (task 12.1).
 *
 * Every identifier and every figure is **derived from `./set-9281.ts`**, never
 * restated. `SET_9281.chain.sources` already fixes the eight Source_Record
 * identifiers in first-citation order — three Payment lines, one Refund line, one
 * chargeback line, two adjustment lines, then the Settlement object — and
 * `SET_9281.lines` fixes the figures in the same order. Pairing them positionally
 * is what makes the composed Evidence_Chain comparable to the fixture's chain
 * step for step: if either list is edited, this converter builds a different
 * Settlement and the comparison fails, which is the point.
 *
 * Lives under `test/fixtures/` rather than beside `src/tools/` because it is a
 * fixture and because nothing in `src/` may import from `test/`.
 */

import type { ScopedSettlement } from '@/tools/settlement-scope';
import type { SourceRef } from '@/ledger/posting-rules';

import type { WorkedExample } from './set-9281';

/** The eight refs a worked example's chain cites, in first-citation order. */
function citedRefs(example: WorkedExample): readonly SourceRef[] {
  return example.chain.sources;
}

function lineIdAt(example: WorkedExample, position: number): string {
  const ref = citedRefs(example)[position];
  if (ref === undefined) {
    throw new Error(
      `${example.display_name} cites ${citedRefs(example).length} Source_Records; position ` +
        `${position} does not exist. This converter pairs the cited identifiers with ` +
        `SET_9281.lines positionally`,
    );
  }
  return ref.id;
}

function figureAt(figures: readonly bigint[], position: number, what: string): bigint {
  const figure = figures[position];
  if (figure === undefined) {
    throw new Error(`the fixture states no ${what} at position ${position}`);
  }
  return figure;
}

/**
 * One worked example as the store would hand it over.
 *
 * `record_updated_at` is the example's `chain.as_of` for every record, which is what
 * the fixture states: every line's `settled_at` and the Settlement's `created_at`
 * are the same instant, and `as_of` is the newest of them.
 */
export function scopedSettlementFor(example: WorkedExample): ScopedSettlement {
  const updatedAt = example.chain.as_of;
  const { lines } = example;
  return {
    settlement_id: example.settlement_id,
    settlement_date: example.settlement_date,
    received_paise: example.received_paise,
    record_updated_at: updatedAt,
    recon_report_id: example.recon_report_id,
    payments: lines.payments.map((amount, position) => ({
      line_id: lineIdAt(example, position),
      record_updated_at: updatedAt,
      amount_paise: amount,
      fee_paise: figureAt(lines.fees, position, 'fee line'),
      gst_on_fee_paise: figureAt(lines.gst_on_fees, position, 'GST-on-fee line'),
    })),
    refunds: lines.refunds.map((amount, position) => ({
      line_id: lineIdAt(example, lines.payments.length + position),
      record_updated_at: updatedAt,
      amount_paise: amount,
    })),
    chargebacks: lines.chargebacks.map((amount, position) => ({
      line_id: lineIdAt(example, lines.payments.length + lines.refunds.length + position),
      record_updated_at: updatedAt,
      amount_paise: amount,
    })),
    adjustments: lines.adjustments.map((signed, position) => ({
      line_id: lineIdAt(
        example,
        lines.payments.length + lines.refunds.length + lines.chargebacks.length + position,
      ),
      record_updated_at: updatedAt,
      signed_amount_paise: signed,
    })),
  };
}

/**
 * A Settlement whose Settlement_Recon_Report is absent, which is the first half of
 * Requirement 4.13. `recon_report_id` is `null` and every line list is empty.
 */
export function settlementWithNoReconReport(options: {
  readonly settlement_id: string;
  readonly settlement_date: string;
  readonly received_paise: bigint;
  readonly record_updated_at: string;
}): ScopedSettlement {
  return {
    ...options,
    recon_report_id: null,
    payments: [],
    refunds: [],
    chargebacks: [],
    adjustments: [],
  };
}
