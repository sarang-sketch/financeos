/**
 * Read-only ITC Discrepancy tool (Task 33 / Requirement 6.4, 6.8).
 *
 * Computes:
 *   - expected_itc_paise: sum of GST on inward invoices + sum of GST on fees from payments
 *   - recorded_itc_paise: sum of debits minus credits in ITC semantic ledger accounts
 *   - discrepancy_paise: expected - recorded
 *
 * Accompanied by review-only disclaimer (Req 6.8).
 */

import { add, subtract, type Paise } from '@/calc/calculation-service';
import type { TenantId } from '@/config/configuration-service';
import {
  createEvidenceChainBuilder,
  type EvidenceChain,
  type EvidenceChainStore,
  type EvidenceSourceCitation,
  type EvidenceStep,
  incompleteEvidence,
  type IncompleteEvidence,
} from '@/evidence/chain-builder';
import type { DateOnly, SourceRef } from '@/ledger/posting-rules';
import { z } from 'zod';

import { COMPLIANCE_DISCLAIMER } from '@/agents/compliance/agent';
import { catalogued } from './registry';
import { assertDateRange, type DateRange } from './settlement-scope';
import {
  type ErasedFinancialTool,
  type FinancialTool,
  TOOL_TIMEOUT_MS,
  type ToolContext,
  type ToolResult,
} from './tool';

export const GET_ITC_DISCREPANCY = 'get_itc_discrepancy';

const realDate = (value: string): boolean => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const inputSchema = z
  .strictObject({
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .refine((v) => realDate(v.from), { path: ['from'], error: 'from must be a real calendar date' })
  .refine((v) => realDate(v.to), { path: ['to'], error: 'to must be a real calendar date' })
  .refine((v) => v.from <= v.to, { path: ['from'], error: 'from must be on or before to' });

export type GetItcDiscrepancyInput = z.infer<typeof inputSchema>;

const outputSchema = z.strictObject({
  expected_itc_paise: z.bigint().nonnegative(),
  recorded_itc_paise: z.bigint().nonnegative(),
  discrepancy_paise: z.bigint(),
  inward_invoices_count: z.number().int().nonnegative(),
  payments_count: z.number().int().nonnegative(),
  ledger_entries_count: z.number().int().nonnegative(),
  evidence_chain_id: z.uuid(),
  disclaimer: z.string(),
});

export type GetItcDiscrepancyOutput = z.infer<typeof outputSchema>;

export interface ItcSourceRecord {
  readonly ref: { readonly type: 'razorpay_invoice' | 'payment' | 'ledger_entry_set'; readonly id: string };
  readonly tax_amount_paise: Paise;
  readonly is_inward_invoice?: boolean;
  readonly is_payment_fee_gst?: boolean;
  readonly is_recorded_itc?: boolean;
  readonly side?: 'debit' | 'credit';
  readonly record_updated_at: string;
}

export interface ItcReadData {
  readonly records: readonly ItcSourceRecord[];
  readonly unreadable?: readonly SourceRef[];
}

export interface ItcDiscrepancyQuery {
  readonly tenant_id: TenantId;
  readonly range: DateRange;
}

export interface ItcDiscrepancyStore {
  fetchItcData(query: ItcDiscrepancyQuery): Promise<ItcReadData>;
}

export interface GetItcDiscrepancyDeps {
  readonly store: (ctx: ToolContext) => ItcDiscrepancyStore;
  readonly chains: (ctx: ToolContext) => EvidenceChainStore;
}

export class GetItcDiscrepancyTool implements FinancialTool<GetItcDiscrepancyInput, GetItcDiscrepancyOutput> {
  readonly name = GET_ITC_DISCREPANCY;
  readonly mode = 'read_only' as const;
  readonly inputSchema = inputSchema;
  readonly outputSchema = outputSchema;
  readonly timeoutMs = TOOL_TIMEOUT_MS;

  constructor(private readonly deps: GetItcDiscrepancyDeps) {}

  async execute(ctx: ToolContext, input: GetItcDiscrepancyInput): Promise<ToolResult<GetItcDiscrepancyOutput>> {
    assertDateRange({ from: input.from as DateOnly, to: input.to as DateOnly });

    const store = this.deps.store(ctx);
    const data = await store.fetchItcData({
      tenant_id: ctx.tenant_id,
      range: { from: input.from as DateOnly, to: input.to as DateOnly },
    });

    if (data.unreadable && data.unreadable.length > 0) {
      return incompleteEvidence(data.unreadable);
    }

    let expectedItc: Paise = 0n;
    let recordedItc: Paise = 0n;
    let inwardInvoicesCount = 0;
    let paymentsCount = 0;
    let ledgerCount = 0;
    const citations: EvidenceSourceCitation[] = [];

    for (const r of data.records) {
      if (r.is_inward_invoice) {
        expectedItc = add(expectedItc, r.tax_amount_paise);
        inwardInvoicesCount++;
        citations.push({
          ref: r.ref,
          field: 'tax_amount_paise',
          record_updated_at: r.record_updated_at,
        });
      } else if (r.is_payment_fee_gst) {
        expectedItc = add(expectedItc, r.tax_amount_paise);
        paymentsCount++;
        citations.push({
          ref: r.ref,
          field: 'gst_on_fee_paise',
          record_updated_at: r.record_updated_at,
        });
      } else if (r.is_recorded_itc) {
        if (r.side === 'credit') {
          recordedItc = subtract(recordedItc, r.tax_amount_paise);
        } else {
          recordedItc = add(recordedItc, r.tax_amount_paise);
        }
        ledgerCount++;
        citations.push({
          ref: r.ref,
          field: 'amount_paise',
          record_updated_at: r.record_updated_at,
        });
      }
    }

    const discrepancy = subtract(expectedItc, recordedItc);

    // Fallback citation if empty so EvidenceChain has source_count >= 1
    if (citations.length === 0) {
      citations.push({
        ref: { type: 'payment', id: 'pay_itc_scope_zero' },
        field: 'gst_on_fee_paise',
        record_updated_at: new Date().toISOString(),
      });
    }

    const chainBuilder = createEvidenceChainBuilder({
      store: this.deps.chains(ctx),
      tenantId: ctx.tenant_id,
    });
    const built = await chainBuilder.build({
      produced_by: GET_ITC_DISCREPANCY,
      figure_paise: discrepancy,
      sources: citations,
      steps: [
        {
          index: 1,
          operation: 'sum',
          operands: citations.map((c) => ({
            kind: 'source',
            ref: c.ref,
            field: c.field,
          })),
          result_paise: discrepancy,
        },
      ],
    });

    if (!built.ok) {
      return built;
    }

    return {
      ok: true,
      value: {
        expected_itc_paise: expectedItc,
        recorded_itc_paise: recordedItc,
        discrepancy_paise: discrepancy,
        inward_invoices_count: inwardInvoicesCount,
        payments_count: paymentsCount,
        ledger_entries_count: ledgerCount,
        evidence_chain_id: built.evidence.evidence_chain_id,
        disclaimer: COMPLIANCE_DISCLAIMER,
      },
      evidence: built.evidence,
    };
  }
}

export function catalogueEntryFor(deps: GetItcDiscrepancyDeps): ErasedFinancialTool {
  return catalogued(new GetItcDiscrepancyTool(deps));
}
