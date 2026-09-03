import { NextResponse } from 'next/server';
import { MerchantAgent } from '@/commerce/merchant-agent';

/**
 * POST /api/commerce/offer
 *
 * Generates a merchant offer for a product, including dynamic upsell
 * selection and Money Firewall validation.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      buyer = {},
      product_id = 'prod_003',
      requested_discount_percent = 5,
    } = body;
    const { intent = 'birthday gift', budget = 5000, requirements = [] } = buyer;

    const offer = await MerchantAgent.generateOffer({
      productId: product_id,
      buyerIntent: { intent, budget, requirements },
      requestedDiscountPercent: requested_discount_percent,
    });

    return NextResponse.json({
      success: true,
      ...offer,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to generate offer';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
