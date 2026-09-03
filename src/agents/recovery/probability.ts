/**
 * Recovery_Agent — Failed payment profiling, 70/30 channel blend, and retry proposal logic.
 *
 * Requirements: 9.1..9.12
 */

import { add, applyRate, assertInRange, type Paise } from '@/calc/calculation-service';
import type { TenantId } from '@/config/configuration-service';
import type { DateOnly } from '@/ledger/posting-rules';

export const RECOVERY_CHANNELS = ['upi', 'card', 'netbanking', 'wallet'] as const;
export type RecoveryChannel = (typeof RECOVERY_CHANNELS)[number];

export interface FailedPaymentProfile {
  readonly payment_id: string;
  readonly customer_id: string | null;
  readonly amount_paise: Paise;
  readonly failure_reason: string;
  readonly created_at: string;
  readonly prior_successful_payments_count: number;
  readonly most_recent_successful_method: string;
  readonly customer_lifetime_value_paise: Paise;
}

export interface ChannelStats {
  readonly channel: RecoveryChannel;
  readonly customer_attempts: number;
  readonly customer_successes: number;
  readonly tenant_attempts: number;
  readonly tenant_successes: number;
}

export interface ChannelProbabilityResult {
  readonly channel: RecoveryChannel;
  readonly probability_percent: number; // 0..100 integer
  readonly basis: '70_30_blend' | 'tenant_fallback';
  readonly customer_sample_size: number;
  readonly tenant_sample_size: number;
}

export interface RecoveryRecommendation {
  readonly payment_id: string;
  readonly recommended_channel: RecoveryChannel | null;
  readonly channels: readonly ChannelProbabilityResult[];
  readonly should_propose_retry: boolean;
  readonly suppression_reason?: 'below_minimum_sample' | 'already_recovered' | 'already_retried' | 'exceeds_maximum_age';
  readonly age_in_days: number;
}

/**
 * Compute recovery probability for a payment method channel using the 70/30 blend.
 */
export function computeChannelProbability(stats: ChannelStats): ChannelProbabilityResult {
  if (stats.customer_attempts === 0) {
    // Tenant fallback
    const tenantRate =
      stats.tenant_attempts > 0 ? (stats.tenant_successes / stats.tenant_attempts) * 100 : 0;
    return {
      channel: stats.channel,
      probability_percent: Math.round(tenantRate),
      basis: 'tenant_fallback',
      customer_sample_size: 0,
      tenant_sample_size: stats.tenant_attempts,
    };
  }

  const custRate = (stats.customer_successes / stats.customer_attempts) * 100;
  const tenantRate =
    stats.tenant_attempts > 0 ? (stats.tenant_successes / stats.tenant_attempts) * 100 : 0;

  // 70% customer + 30% tenant
  const blended = custRate * 0.7 + tenantRate * 0.3;

  return {
    channel: stats.channel,
    probability_percent: Math.min(100, Math.max(0, Math.round(blended))),
    basis: '70_30_blend',
    customer_sample_size: stats.customer_attempts,
    tenant_sample_size: stats.tenant_attempts,
  };
}

/**
 * Rank and select optimal channel applying tie-break chain (Req 9.7).
 */
export function rankRecoveryChannels(
  probabilities: readonly ChannelProbabilityResult[],
  channelStats: ReadonlyMap<RecoveryChannel, ChannelStats>,
): readonly ChannelProbabilityResult[] {
  const channelPriority: Record<RecoveryChannel, number> = {
    upi: 1,
    card: 2,
    netbanking: 3,
    wallet: 4,
  };

  return [...probabilities].sort((a, b) => {
    // 1. Highest probability
    if (a.probability_percent !== b.probability_percent) {
      return b.probability_percent - a.probability_percent;
    }
    // 2. More Tenant successes
    const aTenantSucc = channelStats.get(a.channel)?.tenant_successes ?? 0;
    const bTenantSucc = channelStats.get(b.channel)?.tenant_successes ?? 0;
    if (aTenantSucc !== bTenantSucc) {
      return bTenantSucc - aTenantSucc;
    }
    // 3. Fixed tie-break order: UPI -> card -> netbanking -> wallet
    return channelPriority[a.channel] - channelPriority[b.channel];
  });
}

/**
 * Evaluate retry proposal eligibility for a failed payment.
 */
export function evaluateRetryProposal(params: {
  readonly profile: FailedPaymentProfile;
  readonly channelProbabilities: readonly ChannelProbabilityResult[];
  readonly channelStats: ReadonlyMap<RecoveryChannel, ChannelStats>;
  readonly current_timestamp: string;
  readonly minimum_sample_size?: number; // default 5
  readonly maximum_retry_age_days?: number; // default 7
  readonly is_already_recovered?: boolean;
  readonly is_already_retried?: boolean;
}): RecoveryRecommendation {
  const minSample = params.minimum_sample_size ?? 5;
  const maxAge = params.maximum_retry_age_days ?? 7;

  const createdMs = Date.parse(params.profile.created_at);
  const nowMs = Date.parse(params.current_timestamp);
  const ageDays = Math.max(0, Math.floor((nowMs - createdMs) / (1000 * 60 * 60 * 24)));

  const ranked = rankRecoveryChannels(params.channelProbabilities, params.channelStats);
  const first = ranked[0];
  const bestChannel = first ? first.channel : null;

  if (params.is_already_recovered) {
    return {
      payment_id: params.profile.payment_id,
      recommended_channel: bestChannel,
      channels: ranked,
      should_propose_retry: false,
      suppression_reason: 'already_recovered',
      age_in_days: ageDays,
    };
  }

  if (params.is_already_retried) {
    return {
      payment_id: params.profile.payment_id,
      recommended_channel: bestChannel,
      channels: ranked,
      should_propose_retry: false,
      suppression_reason: 'already_retried',
      age_in_days: ageDays,
    };
  }

  if (ageDays > maxAge) {
    return {
      payment_id: params.profile.payment_id,
      recommended_channel: bestChannel,
      channels: ranked,
      should_propose_retry: false,
      suppression_reason: 'exceeds_maximum_age',
      age_in_days: ageDays,
    };
  }

  const totalHistoricalPayments = params.profile.prior_successful_payments_count;
  if (totalHistoricalPayments < minSample) {
    return {
      payment_id: params.profile.payment_id,
      recommended_channel: bestChannel,
      channels: ranked,
      should_propose_retry: false,
      suppression_reason: 'below_minimum_sample',
      age_in_days: ageDays,
    };
  }

  return {
    payment_id: params.profile.payment_id,
    recommended_channel: bestChannel,
    channels: ranked,
    should_propose_retry: true,
    age_in_days: ageDays,
  };
}
