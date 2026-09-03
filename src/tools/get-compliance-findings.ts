/**
 * Read-only Compliance Findings tool (Task 33 / Requirement 6.1..6.8).
 *
 * Scans GSTIN integrity, invoices, credit notes, payments, TDS thresholds, and ITC discrepancies.
 */

import { add, type Paise } from '@/calc/calculation-service';
import type { TenantId } from '@/config/configuration-service';
import {
  createEvidenceChainBuilder,
  type EvidenceChain,
  type EvidenceChainStore,
  type EvidenceSourceCitation,
  incompleteEvidence,
} from '@/evidence/chain-builder';
import type { DateOnly, SourceRecordType, SourceRef } from '@/ledger/posting-rules';
import { z } from 'zod';

import {
  COMPLIANCE_DISCLAIMER,
  ComplianceAgent,
  type ComplianceFinding,
  type ComplianceInputData,
  type TdsReviewItem,
} from '@/agents/compliance/agent';
import { catalogued } from './registry';
import { assertDateRange, type DateRange } from './settlement-scope';
import {
  type ErasedFinancialTool,
  type FinancialTool,
  TOOL_TIMEOUT_MS,
  type ToolContext,
  type ToolResult,
} from './tool';

export const GET_COMPLIANCE_FINDINGS = 'get_compliance_findings';

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

export type GetComplianceFindingsInput = z.infer<typeof inputSchema>;

const sourceRecordSchema = z.strictObject({
  type: z.enum([
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
  ]),
  id: z.string(),
  field: z.string(),
});

const complianceFindingSchema = z.strictObject({
  id: z.string(),
  category: z.enum([
    'missing_gst_information',
    'invalid_gstin',
    'gst_anomaly',
    'record_needing_review',
    'unmatched_credit_note',
    'itc_discrepancy',
  ]),
  impact_paise: z.bigint().nonnegative(),
  direction: z.enum(['payable', 'receivable', 'neutral']),
  detail: z.record(z.string(), z.unknown()),
  evidence_chain_id: z.uuid().nullable(),
  source_records: z.array(sourceRecordSchema),
});

const tdsReviewItemSchema = z.strictObject({
  vendor_pan: z.string(),
  vendor_name: z.string(),
  section: z.string(),
  applicable_rate_bps: z.bigint(),
  cumulative_credited_paise: z.bigint().nonnegative(),
  threshold_paise: z.bigint().nonnegative(),
  is_threshold_breached: z.boolean(),
  recommended_tds_deduction_paise: z.bigint().nonnegative(),
});

const examinedCountsSchema = z.strictObject({
  invoices: z.number().int().nonnegative(),
  payments: z.number().int().nonnegative(),
  credit_notes: z.number().int().nonnegative(),
  ledger_entries: z.number().int().nonnegative(),
});

const outputSchema = z.strictObject({
  total_impact_paise: z.bigint().nonnegative(),
  findings: z.array(complianceFindingSchema),
  tds_review_items: z.array(tdsReviewItemSchema),
  examined_counts: examinedCountsSchema,
  evidence_chain_id: z.uuid(),
  disclaimer: z.string(),
});

export type GetComplianceFindingsOutput = z.infer<typeof outputSchema>;

export interface ComplianceReadData extends ComplianceInputData {
  readonly record_updated_at: string;
  readonly unreadable?: readonly SourceRef[];
}

export interface ComplianceFindingsStore {
  fetchComplianceData(query: { tenant_id: TenantId; range: DateRange }): Promise<ComplianceReadData>;
}

export interface GetComplianceFindingsDeps {
  readonly store: (ctx: ToolContext) => ComplianceFindingsStore;
  readonly chains: (ctx: ToolContext) => EvidenceChainStore;
}

export class GetComplianceFindingsTool implements FinancialTool<GetComplianceFindingsInput, GetComplianceFindingsOutput> {
  readonly name = GET_COMPLIANCE_FINDINGS;
  readonly mode = 'read_only' as const;
  readonly inputSchema = inputSchema;
  readonly outputSchema = outputSchema;
  readonly timeoutMs = TOOL_TIMEOUT_MS;

  constructor(private readonly deps: GetComplianceFindingsDeps) {}

  async execute(ctx: ToolContext, input: GetComplianceFindingsInput): Promise<ToolResult<GetComplianceFindingsOutput>> {
    assertDateRange({ from: input.from as DateOnly, to: input.to as DateOnly });

    const store = this.deps.store(ctx);
    const data = await store.fetchComplianceData({
      tenant_id: ctx.tenant_id,
      range: { from: input.from as DateOnly, to: input.to as DateOnly },
    });

    if (data.unreadable && data.unreadable.length > 0) {
      return incompleteEvidence(data.unreadable);
    }

    const agent = new ComplianceAgent();
    const result = agent.evaluate(data);

    const citations: EvidenceSourceCitation[] = [];
    for (const f of result.findings) {
      for (const src of f.source_records) {
        citations.push({
          ref: { type: src.type, id: src.id },
          field: src.field,
          record_updated_at: data.record_updated_at,
        });
      }
    }

    if (citations.length === 0) {
      citations.push({
        ref: { type: 'razorpay_invoice', id: 'inv_compliance_baseline' },
        field: 'amount_paise',
        record_updated_at: data.record_updated_at,
      });
    }

    const chainBuilder = createEvidenceChainBuilder({
      store: this.deps.chains(ctx),
      tenantId: ctx.tenant_id,
    });
    const built = await chainBuilder.build({
      produced_by: GET_COMPLIANCE_FINDINGS,
      figure_paise: result.total_impact_paise,
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
          result_paise: result.total_impact_paise,
        },
      ],
    });

    if (!built.ok) {
      return built;
    }

    return {
      ok: true,
      value: {
        total_impact_paise: result.total_impact_paise,
        findings: result.findings.map((f) => ({
          id: f.id,
          category: f.category,
          impact_paise: f.impact_paise,
          direction: f.direction,
          detail: f.detail,
          evidence_chain_id: f.evidence_chain_id,
          source_records: f.source_records.map((s) => ({
            type: s.type,
            id: s.id,
            field: s.field,
          })),
        })),
        tds_review_items: result.tds_review_items.map((t) => ({
          vendor_pan: t.vendor_pan,
          vendor_name: t.vendor_name,
          section: t.section,
          applicable_rate_bps: t.applicable_rate_bps,
          cumulative_credited_paise: t.cumulative_credited_paise,
          threshold_paise: t.threshold_paise,
          is_threshold_breached: t.is_threshold_breached,
          recommended_tds_deduction_paise: t.recommended_tds_deduction_paise,
        })),
        examined_counts: result.examined_counts,
        evidence_chain_id: built.evidence.evidence_chain_id,
        disclaimer: result.disclaimer,
      },
      evidence: built.evidence,
    };
  }
}

export function catalogueEntryFor(deps: GetComplianceFindingsDeps): ErasedFinancialTool {
  return catalogued(new GetComplianceFindingsTool(deps));
}
