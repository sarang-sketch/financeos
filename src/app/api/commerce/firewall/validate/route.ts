import { NextResponse } from 'next/server';
import { MoneyFirewall } from '@/commerce/money-firewall';

/**
 * POST /api/commerce/firewall/validate
 *
 * The Money Firewall endpoint. Evaluates a proposed action against
 * merchant policy constraints. Returns APPROVED or BLOCKED with
 * deterministic reasons and counter-offers.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      action = 'DISCOUNT' as const,
      merchant_id = 'merchant_001',
      requested_discount_percent = 10,
      base_price_paise = 449900,
      product_margin_percent = 44.0,
      override_policy = null,
    } = body;

    const evaluation = await MoneyFirewall.evaluateAction({
      action,
      merchantId: merchant_id,
      amountPaise: base_price_paise,
      requestedDiscountPercent: requested_discount_percent,
      productMarginPercent: product_margin_percent,
      overridePolicy: override_policy,
    });

    return NextResponse.json({
      allowed: evaluation.allowed,
      gate_action: evaluation.allowed ? 'ACTION_APPROVED' : 'ACTION_BLOCKED',
      governance_level: evaluation.governanceLevel,
      reason: evaluation.reason,
      requested_discount_percent: evaluation.requestedDiscountPercent,
      max_discount_allowed: evaluation.maxDiscountAllowed,
      minimum_margin_floor: evaluation.minimumMarginFloor,
      projected_margin_percent: evaluation.projectedMarginPercent,
      max_transaction_limit_paise: evaluation.maxTransactionLimitPaise,
      counter_offer_paise: evaluation.counterOfferPaise,
      counter_offer_discount_percent: evaluation.counterOfferDiscountPercent,
      audit_event_id: evaluation.auditEventId,
      audit_sha256: evaluation.sha256Digest,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Firewall evaluation error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
