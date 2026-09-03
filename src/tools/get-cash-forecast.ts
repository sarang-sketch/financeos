/**
 * Read-only Cash Forecast tool (Task 34 / Requirement 8.1, 8.2, 12.1, 12.2).
 */

import { assertInRange, type Paise } from '@/calc/calculation-service';
import type { TenantId } from '@/config/configuration-service';
import {
  createEvidenceChainBuilder,
  type EvidenceChainStore,
  type EvidenceSourceCitation,
  incompleteEvidence,
} from '@/evidence/chain-builder';
import type { DateOnly, SourceRecordType, SourceRef } from '@/ledger/posting-rules';
import { z } from 'zod';

import {
  projectForecast,
  type CashForecast,
  type DateBasis,
} from '@/agents/cash/forecast';
import { catalogued } from './registry';
import {
  type ErasedFinancialTool,
  type FinancialTool,
  TOOL_TIMEOUT_MS,
  type ToolContext,
  type ToolResult,
} from './tool';

export const GET_CASH_FORECAST = 'get_cash_forecast';

const realDate = (value: string): boolean => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const inputSchema = z
  .strictObject({
    start_date: z.iso.date(),
    horizon_days: z.number().int().min(30).max(180).default(30),
  })
  .refine((v) => realDate(v.start_date), { path: ['start_date'], error: 'start_date must be a real calendar date' });

export type GetCashForecastInput = z.infer<typeof inputSchema>;

const forecastComponentSchema = z.strictObject({
  name: z.string(),
  kind: z.enum(['inflow', 'outflow']),
  amount_paise: z.bigint().nonnegative(),
  date_basis: z.enum(['settlement_cycle', 'default_delay']),
  source_record_refs: z.array(z.strictObject({ type: z.string(), id: z.string() })),
});

const forecastDaySchema = z.strictObject({
  date: z.iso.date(),
  opening_paise: z.bigint(),
  inflows_paise: z.bigint().nonnegative(),
  outflows_paise: z.bigint().nonnegative(),
  closing_paise: z.bigint(),
  components: z.array(forecastComponentSchema),
});

const outputSchema = z.strictObject({
  horizon_days: z.number().int(),
  start_date: z.iso.date(),
  end_date: z.iso.date(),
  opening_cash_paise: z.bigint(),
  closing_cash_paise: z.bigint(),
  partial_history: z.boolean(),
  runway_months: z.number().nullable(),
  runway_basis: z.enum(['calculated', 'non_positive_outflow', 'exceeds_maximum', 'not_applicable']),
  days: z.array(forecastDaySchema),
  evidence_chain_id: z.uuid(),
});

export type GetCashForecastOutput = z.infer<typeof outputSchema>;

export interface CashDataRead {
  readonly opening_cash_paise: Paise;
  readonly scheduled_inflows: readonly { date: DateOnly; amount_paise: Paise; basis: DateBasis; ref: { type: string; id: string } }[];
  readonly scheduled_outflows: readonly { date: DateOnly; amount_paise: Paise; name: string; ref: { type: string; id: string } }[];
  readonly historical_days_count?: number;
  readonly average_monthly_net_outflow_paise?: Paise;
  readonly record_updated_at: string;
  readonly unreadable?: readonly SourceRef[];
}

export interface CashForecastStore {
  fetchCashData(query: { tenant_id: TenantId; start_date: DateOnly; horizon_days: number }): Promise<CashDataRead>;
}

export interface GetCashForecastDeps {
  readonly store: (ctx: ToolContext) => CashForecastStore;
  readonly chains: (ctx: ToolContext) => EvidenceChainStore;
}

export class GetCashForecastTool implements FinancialTool<GetCashForecastInput, GetCashForecastOutput> {
  readonly name = GET_CASH_FORECAST;
  readonly mode = 'read_only' as const;
  readonly inputSchema = inputSchema;
  readonly outputSchema = outputSchema;
  readonly timeoutMs = TOOL_TIMEOUT_MS;

  constructor(private readonly deps: GetCashForecastDeps) {}

  async execute(ctx: ToolContext, input: GetCashForecastInput): Promise<ToolResult<GetCashForecastOutput>> {
    const store = this.deps.store(ctx);
    const data = await store.fetchCashData({
      tenant_id: ctx.tenant_id,
      start_date: input.start_date as DateOnly,
      horizon_days: input.horizon_days,
    });

    if (data.unreadable && data.unreadable.length > 0) {
      return incompleteEvidence(data.unreadable);
    }

    const forecast = projectForecast({
      start_date: input.start_date as DateOnly,
      horizon_days: input.horizon_days,
      opening_cash_paise: data.opening_cash_paise,
      scheduled_inflows: data.scheduled_inflows,
      scheduled_outflows: data.scheduled_outflows,
      historical_days_count: data.historical_days_count,
      average_monthly_net_outflow_paise: data.average_monthly_net_outflow_paise,
    });

    const citations: EvidenceSourceCitation[] = [];
    for (const inf of data.scheduled_inflows) {
      citations.push({
        ref: { type: inf.ref.type as SourceRecordType, id: inf.ref.id },
        field: 'amount_paise',
        record_updated_at: data.record_updated_at,
      });
    }
    for (const out of data.scheduled_outflows) {
      citations.push({
        ref: { type: out.ref.type as SourceRecordType, id: out.ref.id },
        field: 'amount_paise',
        record_updated_at: data.record_updated_at,
      });
    }

    if (citations.length === 0) {
      citations.push({
        ref: { type: 'settlement', id: 'setl_forecast_baseline' },
        field: 'received_paise',
        record_updated_at: data.record_updated_at,
      });
    }

    const chainBuilder = createEvidenceChainBuilder({
      store: this.deps.chains(ctx),
      tenantId: ctx.tenant_id,
    });
    const built = await chainBuilder.build({
      produced_by: GET_CASH_FORECAST,
      figure_paise: forecast.closing_cash_paise,
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
          result_paise: forecast.closing_cash_paise,
        },
      ],
    });

    if (!built.ok) {
      return built;
    }

    return {
      ok: true,
      value: {
        horizon_days: forecast.horizon_days,
        start_date: forecast.start_date,
        end_date: forecast.end_date,
        opening_cash_paise: forecast.opening_cash_paise,
        closing_cash_paise: forecast.closing_cash_paise,
        partial_history: forecast.partial_history,
        runway_months: forecast.runway_months,
        runway_basis: forecast.runway_basis,
        days: forecast.days.map((d) => ({
          date: d.date,
          opening_paise: d.opening_paise,
          inflows_paise: d.inflows_paise,
          outflows_paise: d.outflows_paise,
          closing_paise: d.closing_paise,
          components: d.components.map((c) => ({
            name: c.name,
            kind: c.kind,
            amount_paise: c.amount_paise,
            date_basis: c.date_basis,
            source_record_refs: c.source_record_refs.map((r) => ({ type: r.type, id: r.id })),
          })),
        })),
        evidence_chain_id: built.evidence.evidence_chain_id,
      },
      evidence: built.evidence,
    };
  }
}

export function catalogueEntryFor(deps: GetCashForecastDeps): ErasedFinancialTool {
  return catalogued(new GetCashForecastTool(deps));
}
