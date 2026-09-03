/**
 * Read-only Failed Payment Recovery Profile tool (Task 35 / Requirement 9.1..9.5, 12.1, 12.2).
 */

import { assertInRange, type Paise } from '@/calc/calculation-service';
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
  computeChannelProbability,
  evaluateRetryProposal,
  type ChannelStats,
  type FailedPaymentProfile,
  type RecoveryChannel,
} from '@/agents/recovery/probability';
import { catalogued } from './registry';
import {
  type ErasedFinancialTool,
  type FinancialTool,
  TOOL_TIMEOUT_MS,
  type ToolContext,
  type ToolResult,
} from './tool';

export const GET_FAILED_PAYMENT_RECOVERY_PROFILE = 'get_failed_payment_recovery_profile';

const inputSchema = z.strictObject({
  payment_id: z.string().min(1),
  lookback_days: z.number().int().min(1).max(366).default(90),
});

export type GetFailedPaymentRecoveryProfileInput = z.infer<typeof inputSchema>;

const channelProbabilitySchema = z.strictObject({
  channel: z.enum(['upi', 'card', 'netbanking', 'wallet']),
  probability_percent: z.number().int().min(0).max(100),
  basis: z.enum(['70_30_blend', 'tenant_fallback']),
  customer_sample_size: z.number().int().nonnegative(),
  tenant_sample_size: z.number().int().nonnegative(),
});

const outputSchema = z.strictObject({
  payment_id: z.string(),
  customer_id: z.string().nullable(),
  amount_paise: z.bigint().nonnegative(),
  failure_reason: z.string(),
  prior_successful_payments_count: z.number().int().nonnegative(),
  most_recent_successful_method: z.string(),
  customer_lifetime_value_paise: z.bigint().nonnegative(),
  recommended_channel: z.enum(['upi', 'card', 'netbanking', 'wallet']).nullable(),
  channels: z.array(channelProbabilitySchema),
  should_propose_retry: z.boolean(),
  suppression_reason: z.enum(['below_minimum_sample', 'already_recovered', 'already_retried', 'exceeds_maximum_age']).optional(),
  age_in_days: z.number().int().nonnegative(),
  lookback_days_used: z.number().int(),
  evidence_chain_id: z.uuid(),
});

export type GetFailedPaymentRecoveryProfileOutput = z.infer<typeof outputSchema>;

export interface RecoveryDataRead {
  readonly profile: FailedPaymentProfile;
  readonly channel_stats: readonly ChannelStats[];
  readonly is_already_recovered?: boolean;
  readonly is_already_retried?: boolean;
  readonly record_updated_at: string;
  readonly unreadable?: readonly SourceRef[];
}

export interface RecoveryStore {
  fetchRecoveryData(query: { tenant_id: TenantId; payment_id: string; lookback_days: number }): Promise<RecoveryDataRead>;
}

export interface GetFailedPaymentRecoveryProfileDeps {
  readonly store: (ctx: ToolContext) => RecoveryStore;
  readonly chains: (ctx: ToolContext) => EvidenceChainStore;
}

export class GetFailedPaymentRecoveryProfileTool
  implements FinancialTool<GetFailedPaymentRecoveryProfileInput, GetFailedPaymentRecoveryProfileOutput>
{
  readonly name = GET_FAILED_PAYMENT_RECOVERY_PROFILE;
  readonly mode = 'read_only' as const;
  readonly inputSchema = inputSchema;
  readonly outputSchema = outputSchema;
  readonly timeoutMs = TOOL_TIMEOUT_MS;

  constructor(private readonly deps: GetFailedPaymentRecoveryProfileDeps) {}

  async execute(
    ctx: ToolContext,
    input: GetFailedPaymentRecoveryProfileInput,
  ): Promise<ToolResult<GetFailedPaymentRecoveryProfileOutput>> {
    const store = this.deps.store(ctx);
    const data = await store.fetchRecoveryData({
      tenant_id: ctx.tenant_id,
      payment_id: input.payment_id,
      lookback_days: input.lookback_days,
    });

    if (data.unreadable && data.unreadable.length > 0) {
      return incompleteEvidence(data.unreadable);
    }

    const statsMap = new Map<RecoveryChannel, ChannelStats>();
    for (const cs of data.channel_stats) {
      statsMap.set(cs.channel, cs);
    }

    const probabilities = data.channel_stats.map((cs) => computeChannelProbability(cs));
    const nowIso = new Date().toISOString();

    const recommendation = evaluateRetryProposal({
      profile: data.profile,
      channelProbabilities: probabilities,
      channelStats: statsMap,
      current_timestamp: nowIso,
      is_already_recovered: data.is_already_recovered,
      is_already_retried: data.is_already_retried,
    });

    const citations: EvidenceSourceCitation[] = [
      {
        ref: { type: 'payment', id: data.profile.payment_id },
        field: 'amount_paise',
        record_updated_at: data.record_updated_at,
      },
    ];

    const chainBuilder = createEvidenceChainBuilder({
      store: this.deps.chains(ctx),
      tenantId: ctx.tenant_id,
    });
    const built = await chainBuilder.build({
      produced_by: GET_FAILED_PAYMENT_RECOVERY_PROFILE,
      figure_paise: data.profile.amount_paise,
      sources: citations,
      steps: [
        {
          index: 1,
          operation: 'sum',
          operands: [
            {
              kind: 'source',
              ref: { type: 'payment', id: data.profile.payment_id },
              field: 'amount_paise',
            },
          ],
          result_paise: data.profile.amount_paise,
        },
      ],
    });

    if (!built.ok) {
      return built;
    }

    return {
      ok: true,
      value: {
        payment_id: data.profile.payment_id,
        customer_id: data.profile.customer_id,
        amount_paise: data.profile.amount_paise,
        failure_reason: data.profile.failure_reason,
        prior_successful_payments_count: data.profile.prior_successful_payments_count,
        most_recent_successful_method: data.profile.most_recent_successful_method,
        customer_lifetime_value_paise: data.profile.customer_lifetime_value_paise,
        recommended_channel: recommendation.recommended_channel,
        channels: recommendation.channels.map((c) => ({
          channel: c.channel,
          probability_percent: c.probability_percent,
          basis: c.basis,
          customer_sample_size: c.customer_sample_size,
          tenant_sample_size: c.tenant_sample_size,
        })),
        should_propose_retry: recommendation.should_propose_retry,
        suppression_reason: recommendation.suppression_reason,
        age_in_days: recommendation.age_in_days,
        lookback_days_used: input.lookback_days,
        evidence_chain_id: built.evidence.evidence_chain_id,
      },
      evidence: built.evidence,
    };
  }
}

export function catalogueEntryFor(deps: GetFailedPaymentRecoveryProfileDeps): ErasedFinancialTool {
  return catalogued(new GetFailedPaymentRecoveryProfileTool(deps));
}
