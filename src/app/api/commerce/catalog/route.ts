import { NextResponse } from 'next/server';
import { CommerceDatabase } from '@/commerce/commerce-db';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const category = searchParams.get('category') || undefined;
    const giftable = searchParams.has('giftable') ? searchParams.get('giftable') === 'true' : undefined;

    const products = await CommerceDatabase.getProducts({ category, giftable });

    return NextResponse.json({
      merchant: {
        id: 'merchant_001',
        name: 'Acme Travel & Gear',
        currency: 'INR',
        aiCommerceEnabled: true,
      },
      products: products.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        price: p.pricePaise / 100,
        price_paise: p.pricePaise,
        currency: 'INR',
        availability: p.inventory > 0 ? 'in_stock' : 'out_of_stock',
        inventory: p.inventory,
        features: p.aiMetadata.features,
        delivery: {
          min_days: p.aiMetadata.deliveryDays,
          max_days: p.aiMetadata.deliveryDays + 1,
        },
        giftable: p.aiMetadata.giftable,
        category: p.category,
      })),
      protocols_supported: ['ACP_v1_2', 'NPCI_UAP', 'HTTP_x402'],
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Failed to fetch catalog' }, { status: 500 });
  }
}
