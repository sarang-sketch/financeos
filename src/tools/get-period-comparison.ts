/**
 * Read-only Period Comparison tool (Task 36 / Requirement 10.1..10.9, 12.1, 12.2).
 */

import { add, assertInRange, subtract, sum, type Paise } from '@/calc/calculation-service';
import type { TenantId } from '@/config/configuration-service';
import {
  createEvidenceChainBuilder,
  type EvidenceChainStore,
  type EvidenceSourceCitation,
  incompleteEvidence,
} from '@/evidence/chain-builder';
import type { DateOnly, SourceRef } from '@/ledger/posting-rules';
import { z } from 'zod';

import {
  computeMetricChange,
  detectUnusualTransactions,
  getPrecedingPeriod,
  type FinancialMetricSet,
  type MetricChange,
  type PeriodComparisonResult,
  type TopContributor,
  type UnusualTransaction,
} from '@/agents/analyst/period';
import { catalogued } from './registry';
import { assertDateRange, type DateRange } from './settlement-scope';
import {
  type ErasedFinancialTool,
  type FinancialTool,
  TOOL_TIMEOUT_MS,
  type ToolContext,
  type ToolResult,
} from './tool';

export const GET_PERIOD_COMPARISON = 'get_period_comparison';

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

export type GetPeriodComparisonInput = z.infer<typeof inputSchema>;

const metricSetSchema = z.strictObject({
  revenue_paise: z.bigint(),
  expense_paise: z.bigint(),
  margin_paise: z.bigint(),
  cash_movement_paise: z.bigint(),
  transaction_count: z.number().int().nonnegative(),
});

const metricChangeSchema = z.strictObject({
  current_paise: z.bigint(),
  prior_paise: z.bigint(),
  change_paise: z.bigint(),
  change_percent: z.number().nullable(),
  status: z.enum(['growth', 'decline', 'flat', 'not_applicable']),
});

const unusualTxSchema = z.strictObject({
  payment_id: z.string(),
  transaction_date: z.iso.date(),
  amount_paise: z.bigint().nonnegative(),
  median_paise: z.bigint().nonnegative(),
  multiple: z.number(),
});

const topContributorSchema = z.strictObject({
  category: z.string(),
  description: z.string(),
  contribution_paise: z.bigint().nonnegative(),
  percentage_of_total: z.number(),
});

const outputSchema = z.strictObject({
  current_from: z.iso.date(),
  current_to: z.iso.date(),
  prior_from: z.iso.date(),
  prior_to: z.iso.date(),
  current_metrics: metricSetSchema,
  prior_metrics: metricSetSchema,
  revenue_change: metricChangeSchema,
  expense_change: metricChangeSchema,
  margin_change: metricChangeSchema,
  cash_movement_change: metricChangeSchema,
  unusual_transactions: z.array(unusualTxSchema),
  total_unusual_count: z.number().int().nonnegative(),
  top_contributors: z.array(topContributorSchema),
  evidence_chain_id: z.uuid(),
});

export type GetPeriodComparisonOutput = z.infer<typeof outputSchema>;

export interface PeriodComparisonDataRead {
  readonly current_metrics: FinancialMetricSet;
  readonly prior_metrics: FinancialMetricSet;
  readonly current_payments: readonly { id: string; date: DateOnly; amount_paise: Paise }[];
  readonly median_paise: Paise;
  readonly top_contributors: readonly TopContributor[];
  readonly record_updated_at: string;
  readonly unreadable?: readonly SourceRef[];
}

export interface PeriodComparisonStore {
  fetchPeriodData(query: { tenant_id: TenantId; current_range: DateRange; prior_range: DateRange }): Promise<PeriodComparisonDataRead>;
}

export interface GetPeriodComparisonDeps {
  readonly store: (ctx: ToolContext) => PeriodComparisonStore;
  readonly chains: (ctx: ToolContext) => EvidenceChainStore;
}

export class GetPeriodComparisonTool
  implements FinancialTool<GetPeriodComparisonInput, GetPeriodComparisonOutput>
{
  readonly name = GET_PERIOD_COMPARISON;
  readonly mode = 'read_only' as const;
  readonly inputSchema = inputSchema;
  readonly outputSchema = outputSchema;
  readonly timeoutMs = TOOL_TIMEOUT_MS;

  constructor(private readonly deps: GetPeriodComparisonDeps) {}

  async execute(
    ctx: ToolContext,
    input: GetPeriodComparisonInput,
  ): Promise<ToolResult<GetPeriodComparisonOutput>> {
    const currentRange: DateRange = { from: input.from as DateOnly, to: input.to as DateOnly };
    assertDateRange(currentRange);

    const priorRange = getPrecedingPeriod(currentRange);

    const store = this.deps.store(ctx);
    const data = await store.fetchPeriodData({
      tenant_id: ctx.tenant_id,
      current_range: currentRange,
      prior_range: priorRange,
    });

    if (data.unreadable && data.unreadable.length > 0) {
      return incompleteEvidence(data.unreadable);
    }

    const revChange = computeMetricChange(
      data.current_metrics.revenue_paise,
      data.prior_metrics.revenue_paise,
      data.prior_metrics.transaction_count,
    );
    const expChange = computeMetricChange(
      data.current_metrics.expense_paise,
      data.prior_metrics.expense_paise,
      data.prior_metrics.transaction_count,
    );
    const marginChange = computeMetricChange(
      data.current_metrics.margin_paise,
      data.prior_metrics.margin_paise,
      data.prior_metrics.transaction_count,
    );
    const cashChange = computeMetricChange(
      data.current_metrics.cash_movement_paise,
      data.prior_metrics.cash_movement_paise,
      data.prior_metrics.transaction_count,
    );

    const { unusual, total_count } = detectUnusualTransactions(
      data.current_payments,
      data.median_paise,
    );

    const citations: EvidenceSourceCitation[] = [
      {
        ref: { type: 'ledger_entry_set', id: 'les_current_period_aggregate' },
        field: 'amount_paise',
        record_updated_at: data.record_updated_at,
      },
    ];

    const chainBuilder = createEvidenceChainBuilder({
      store: this.deps.chains(ctx),
      tenantId: ctx.tenant_id,
    });
    const built = await chainBuilder.build({
      produced_by: GET_PERIOD_COMPARISON,
      figure_paise: data.current_metrics.revenue_paise,
      sources: citations,
      steps: [
        {
          index: 1,
          operation: 'sum',
          operands: [
            {
              kind: 'source',
              ref: { type: 'ledger_entry_set', id: 'les_current_period_aggregate' },
              field: 'amount_paise',
            },
          ],
          result_paise: data.current_metrics.revenue_paise,
        },
      ],
    });

    if (!built.ok) {
      return built;
    }

    return {
      ok: true,
      value: {
        current_from: currentRange.from,
        current_to: currentRange.to,
        prior_from: priorRange.from,
        prior_to: priorRange.to,
        current_metrics: data.current_metrics,
        prior_metrics: data.prior_metrics,
        revenue_change: revChange,
        expense_change: expChange,
        margin_change: marginChange,
        cash_movement_change: cashChange,
        unusual_transactions: unusual.map((u) => ({
          payment_id: u.payment_id,
          transaction_date: u.transaction_date,
          amount_paise: u.amount_paise,
          median_paise: u.median_paise,
          multiple: u.multiple,
        })),
        total_unusual_count: total_count,
        top_contributors: data.top_contributors.map((t) => ({
          category: t.category,
          description: t.description,
          contribution_paise: t.contribution_paise,
          percentage_of_total: t.percentage_of_total,
        })),
        evidence_chain_id: built.evidence.evidence_chain_id,
      },
      evidence: built.evidence,
    };
  }
}

export function catalogueEntryFor(deps: GetPeriodComparisonDeps): ErasedFinancialTool {
  return catalogued(new GetPeriodComparisonTool(deps));
}
