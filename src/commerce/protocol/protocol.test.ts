import { describe, it, expect } from 'vitest';
import {
  InternalAdapter,
  type CommerceIntent,
  type CommerceOffer,
  type CommerceAuthorization,
  type CommerceResult,
  type ProtocolAdapter,
} from './index';

describe('CommerceOS Protocol Adapter Layer', () => {
  it('instantiates InternalAdapter conforming to ProtocolAdapter interface', () => {
    const adapter: ProtocolAdapter = new InternalAdapter();
    expect(adapter.protocolName).toBe('INTERNAL');
    expect(adapter.protocolVersion).toBe('1.0');
  });

  it('parses and preserves internal commerce intent', () => {
    const adapter = new InternalAdapter();
    const intent: CommerceIntent = {
      id: 'intent_123',
      buyerAgentId: 'agent_buyer_001',
      naturalLanguageQuery: 'Find a premium waterproof hiking backpack under 5000 INR',
      structuredIntent: {
        category: 'Gear',
        budgetMaxPaise: 500000,
        requirements: ['waterproof', 'hiking'],
        deliveryDeadline: '2026-09-10T12:00:00Z',
        occasion: 'Trek',
        giftableRequired: false,
      },
      timestamp: '2026-09-03T12:00:00Z',
    };

    const parsed = adapter.parseIntent(intent);
    expect(parsed).toEqual(intent);
    expect(parsed.id).toBe('intent_123');
    expect(parsed.structuredIntent.budgetMaxPaise).toBe(500000);
  });

  it('formats internal offer without modification', () => {
    const adapter = new InternalAdapter();
    const offer: CommerceOffer = {
      id: 'ofr_456',
      intentId: 'intent_123',
      productId: 'prod_backpack_01',
      basePricePaise: 449900,
      discountPaise: 44900,
      finalPricePaise: 405000,
      upsell: {
        productId: 'prod_raincover_01',
        pricePaise: 19900,
      },
      totalPaise: 424900,
      reasons: ['First-time buyer discount 10%', 'Compatible raincover bundled'],
      expiresAt: '2026-09-03T13:00:00Z',
    };

    const formatted = adapter.formatOffer(offer);
    expect(formatted).toEqual(offer);
  });

  it('formats authorization result without modification', () => {
    const adapter = new InternalAdapter();
    const auth: CommerceAuthorization = {
      id: 'auth_789',
      offerId: 'ofr_456',
      allowed: true,
      governanceLevel: 'STANDARD_BOUNDS',
      reason: 'Offer discount of 9.98% is below max limit of 15%',
      policySnapshot: {
        maxDiscountPercent: 15,
        minimumMarginPercent: 20,
      },
      sha256Digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    };

    const formatted = adapter.formatAuthorization(auth);
    expect(formatted).toEqual(auth);
  });

  it('formats final commerce result without modification', () => {
    const adapter = new InternalAdapter();
    const result: CommerceResult = {
      transactionId: 'txn_001',
      orderId: 'ord_001',
      status: 'CONFIRMED',
      auditTrail: [
        {
          eventId: 'evt_001',
          action: 'INTENT_DISPATCH',
          timestamp: '2026-09-03T12:00:01Z',
          result: 'OFFER_RECEIVED',
        },
        {
          eventId: 'evt_002',
          action: 'FIREWALL_AUTHORIZATION',
          timestamp: '2026-09-03T12:00:02Z',
          result: 'APPROVED',
        },
      ],
    };

    const formatted = adapter.formatResult(result);
    expect(formatted).toEqual(result);
  });
});
