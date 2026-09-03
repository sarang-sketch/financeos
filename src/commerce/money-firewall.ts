import { CommerceDatabase, MerchantPolicy } from '@/commerce/commerce-db';

export type ActionType = 'DISCOUNT' | 'REFUND' | 'UPSELL' | 'BUNDLE' | 'PRICE_OVERRIDE' | 'CHECKOUT';
export type GovernanceLevel = 'LEVEL_1_AI_RECOMMENDATION' | 'LEVEL_2_HUMAN_GATED' | 'LEVEL_3_AUTO_BOUNDED';

export interface EvaluateActionParams {
  action: ActionType;
  merchantId: string;
  amountPaise: number;
  requestedDiscountPercent?: number;
  productMarginPercent?: number;
  overridePolicy?: Partial<MerchantPolicy>;
}

export interface EvaluationResult {
  allowed: boolean;
  governanceLevel: GovernanceLevel;
  reason: string;
  requestedDiscountPercent: number;
  maxDiscountAllowed: number;
  minimumMarginFloor: number;
  projectedMarginPercent: number;
  maxTransactionLimitPaise: number;
  counterOfferPaise?: number;
  counterOfferDiscountPercent?: number;
  auditEventId: string;
  sha256Digest: string;
}

export class MoneyFirewall {
  /**
   * Deterministically evaluates a commerce action against merchant policies.
   * This is the TRUST layer of CommerceOS.
   */
  static async evaluateAction(params: EvaluateActionParams): Promise<EvaluationResult> {
    const {
      action,
      merchantId,
      amountPaise,
      requestedDiscountPercent = 0,
      productMarginPercent = 100,
      overridePolicy,
    } = params;

    // 1. Fetch policy
    let policy: MerchantPolicy;
    if (overridePolicy) {
      policy = await CommerceDatabase.updateMerchantPolicy({ merchantId, ...overridePolicy });
    } else {
      policy = await CommerceDatabase.getMerchantPolicy(merchantId);
    }

    let allowed = true;
    let reason = 'Action within policy bounds.';

    // 2. Run deterministic checks
    if (requestedDiscountPercent > policy.maxDiscountPercent) {
      allowed = false;
      reason = `Requested discount (${requestedDiscountPercent}%) exceeds policy maximum (${policy.maxDiscountPercent}%).`;
    }

    const projectedMarginPercent = productMarginPercent - requestedDiscountPercent;
    if (projectedMarginPercent < policy.minimumMarginPercent) {
      allowed = false;
      reason = `Projected margin (${projectedMarginPercent}%) falls below policy minimum (${policy.minimumMarginPercent}%).`;
    }

    if (amountPaise > policy.maxTransactionPaise) {
      allowed = false;
      reason = `Transaction amount (${amountPaise / 100} INR) exceeds policy maximum (${policy.maxTransactionPaise / 100} INR).`;
    }

    if (action === 'REFUND' && amountPaise > policy.dailyRefundLimitPaise) {
      allowed = false;
      reason = `Refund amount (${amountPaise / 100} INR) exceeds daily refund limit (${policy.dailyRefundLimitPaise / 100} INR).`;
    }

    // 3. Determine governance level
    let governanceLevel: GovernanceLevel = 'LEVEL_3_AUTO_BOUNDED';
    if (amountPaise > policy.autoApprovalLimitPaise) {
      governanceLevel = 'LEVEL_2_HUMAN_GATED';
    } else if (action === 'UPSELL' || action === 'BUNDLE') {
      governanceLevel = 'LEVEL_1_AI_RECOMMENDATION';
    }

    // 4. If BLOCKED, compute counter-offer
    let counterOfferPaise: number | undefined;
    let counterOfferDiscountPercent: number | undefined;
    const maxDiscountAllowed = Math.max(0, Math.min(policy.maxDiscountPercent, productMarginPercent - policy.minimumMarginPercent));
    
    if (!allowed) {
      counterOfferDiscountPercent = maxDiscountAllowed;
      const originalPricePaise = amountPaise / (1 - requestedDiscountPercent / 100);
      counterOfferPaise = Math.floor(originalPricePaise * (1 - counterOfferDiscountPercent / 100));
    }

    // 5. Record audit event
    const auditResult = allowed ? (governanceLevel === 'LEVEL_2_HUMAN_GATED' ? 'VERIFIED' : 'APPROVED') : 'BLOCKED';
    
    const auditEvent = await CommerceDatabase.recordAuditEvent({
      actor: 'MONEY_FIREWALL',
      action,
      input: {
        amountPaise,
        requestedDiscountPercent,
        productMarginPercent,
      },
      decision: {
        allowed,
        governanceLevel,
        counterOfferDiscountPercent,
      },
      reason,
      policySnapshot: { ...policy } as Record<string, unknown>,
      result: !allowed && counterOfferDiscountPercent !== undefined && counterOfferDiscountPercent > 0 ? 'COUNTERED' : auditResult,
    });

    // 6. Return evaluation result
    return {
      allowed,
      governanceLevel,
      reason,
      requestedDiscountPercent,
      maxDiscountAllowed,
      minimumMarginFloor: policy.minimumMarginPercent,
      projectedMarginPercent,
      maxTransactionLimitPaise: policy.maxTransactionPaise,
      counterOfferPaise,
      counterOfferDiscountPercent,
      auditEventId: auditEvent.id,
      sha256Digest: auditEvent.sha256Digest,
    };
  }
}
