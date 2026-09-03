import { NextResponse } from 'next/server';
import { AgenticCommerceService } from '@/services/agentic-commerce-service';

export async function GET() {
  const summary = AgenticCommerceService.getSummary();

  const response = {
    '@context': 'https://schema.org',
    '@type': 'AgenticCommerceCatalog',
    protocolStandards: ['NPCI_UAP', 'ACP_1.2', 'HTTP_x402', 'AP2'],
    merchantId: 'merch_playcraft_toys_001',
    merchantName: 'PlayCraft Toys & Robotics Ltd (FinanceOS)',
    paymentGateway: 'Razorpay Test-Mode',
    currency: 'INR',
    agentDiscoveryEndpoint: '/api/agentic/catalog',
    agentCheckoutEndpoint: '/api/agentic/checkout',
    totalItems: summary.catalog.length,
    items: summary.catalog.map((item) => ({
      '@type': 'Product',
      sku: item.sku,
      name: item.name,
      category: item.category,
      price: item.pricePaise / 100,
      priceCurrency: 'INR',
      pricePaise: item.pricePaise,
      inventoryLevel: item.stockAvailable,
      agentPurchasable: item.agentPurchasable,
      maxAllowedPerTransaction: item.maxPerTransaction,
      recommendedAddons: item.crossSellAffinities,
      description: item.description,
      protocolSupport: item.agentProtocolSpec,
    })),
    autonomousPolicyRules: {
      singleTransactionLimitPaise: 5000000, // ₹50,000 ceiling
      requireSignature: true,
      instantSettlementEnabled: true,
      gracefulMitigationActive: true,
    },
  };

  return NextResponse.json(response, {
    status: 200,
    headers: {
      'X-Agent-Protocol': 'ACP/1.2, UAP/1.0, x402',
      'X-Payment-Gateway': 'Razorpay-TestMode',
      'Cache-Control': 'no-cache, no-store',
    },
  });
}
