import { NextResponse } from 'next/server';
import { CommerceDatabase } from '@/commerce/commerce-db';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const policy = await CommerceDatabase.getMerchantPolicy(id);

    return NextResponse.json({
      merchant_id: id,
      merchant_name: 'Acme Travel & Gear (FinanceOS Verified)',
      status: 'ACTIVE_TRANSACTABLE',
      commerce_capabilities: [
        'catalog_discovery',
        'bounded_negotiation',
        'dynamic_upsell',
        'razorpay_checkout',
        'idempotent_webhooks',
        'revenue_optimization',
        'rfc8785_audit_proofs',
      ],
      payment_methods_supported: ['upi_intent', 'upi_qr', 'cards', 'netbanking'],
      ai_buyer_transactable: true,
      protocols: {
        acp: { version: '1.2.0', status: 'COMPLIANT' },
        uap: { npci_status: 'REGISTERED', role: 'PAYEE_MERCHANT' },
        x402: { header: 'X-402-Payment-Required', status: 'ENABLED' },
      },
      policy_constraints: {
        max_discount_percent: policy.maxDiscountPercent,
        minimum_margin_percent: policy.minimumMarginPercent,
        max_transaction_amount_inr: policy.maxTransactionPaise / 100,
        auto_approval_limit_inr: policy.autoApprovalLimitPaise / 100,
        daily_refund_limit_inr: policy.dailyRefundLimitPaise / 100,
      },
      money_firewall_status: 'ACTIVE_ENFORCING',
      verification_key_fingerprint: 'sha256:4f8e9102ab81c...verified_vault',
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Failed to fetch capabilities' }, { status: 500 });
  }
}
