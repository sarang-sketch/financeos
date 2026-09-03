import { describe, it, expect } from 'vitest';
import { CommerceDatabase } from './commerce-db';

describe('CommerceDatabase & AI Catalog', () => {
  it('retrieves products matching AI buyer intent filters', async () => {
    const all = await CommerceDatabase.getProducts();
    expect(all.length).toBeGreaterThanOrEqual(6);

    const giftable = await CommerceDatabase.getProducts({ giftable: true });
    expect(giftable.every((p) => p.aiMetadata.giftable)).toBe(true);

    const gear = await CommerceDatabase.getProducts({ category: 'Gear' });
    expect(gear.some((p) => p.name.includes('Backpack'))).toBe(true);
  });

  it('retrieves and dynamically updates merchant firewall policy', async () => {
    const defaultPolicy = await CommerceDatabase.getMerchantPolicy();
    expect(defaultPolicy.maxDiscountPercent).toBe(10);
    expect(defaultPolicy.minimumMarginPercent).toBe(25);

    // Update with slider value
    await CommerceDatabase.updateMerchantPolicy({ maxDiscountPercent: 15, minimumMarginPercent: 20 });
    const updated = await CommerceDatabase.getMerchantPolicy();
    expect(updated.maxDiscountPercent).toBe(15);
    expect(updated.minimumMarginPercent).toBe(20);

    // Reset back
    await CommerceDatabase.updateMerchantPolicy({ maxDiscountPercent: 10, minimumMarginPercent: 25 });
  });

  it('records orders and transitions states safely', async () => {
    const order = await CommerceDatabase.createOrder({
      id: 'ord_test_999',
      merchantId: 'merchant_001',
      buyerAgentId: 'buyer_bot_01',
      subtotalPaise: 449900,
      discountPaise: 20000,
      upsellPaise: 19900,
      totalPaise: 449800,
      status: 'PAYMENT_PENDING',
      createdAt: new Date().toISOString(),
    });

    expect(order.id).toBe('ord_test_999');

    await CommerceDatabase.updateOrderStatus('ord_test_999', 'PAID');
    const updated = await CommerceDatabase.getOrderById('ord_test_999');
    expect(updated?.status).toBe('PAID');
  });

  it('records immutable audit events with SHA-256 digests', async () => {
    const event = await CommerceDatabase.recordAuditEvent({
      actor: 'MONEY_FIREWALL',
      action: 'POLICY_EVALUATE',
      input: { discount: 10 },
      decision: { allowed: true },
      reason: 'Within merchant boundary',
      policySnapshot: { max_discount: 10 },
      result: 'APPROVED',
    });

    expect(event.id).toBeTruthy();
    expect(event.sha256Digest).toBeTruthy();
    expect(event.sha256Digest.length).toBe(64); // SHA-256 hex

    const events = await CommerceDatabase.getAuditEvents();
    expect(events.some((e) => e.id === event.id)).toBe(true);
  });
});
