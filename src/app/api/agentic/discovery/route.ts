import { NextResponse } from 'next/server';

export async function GET() {
  const manifest = {
    '@context': 'https://schema.org',
    '@type': 'AgenticCommerceEndpoint',
    protocol: 'ACP/1.2',
    supportedStandards: [
      'NPCI_UAP',
      'ACP_v1.2',
      'HTTP_x402',
      'AP2_GOOGLE',
      'MCP_2024_11_05',
    ],
    merchant: {
      name: 'EdTech India Ltd (FinanceOS)',
      merchantId: 'merch_edtech_india_001',
      currency: 'INR',
      gateway: 'Razorpay Test-Mode',
    },
    endpoints: {
      catalog: '/api/agentic/catalog',
      checkout: '/api/agentic/checkout',
      nudge: '/api/agentic/nudge',
      discovery: '/api/agentic/discovery',
    },
    autonomousPolicy: {
      maxTransactionLimitInr: 50000,
      requiresPreAuthSignature: true,
      instantSettlementSupported: true,
      gracefulFailureMitigationEnabled: true,
    },
    mcpTools: [
      {
        name: 'query_merchant_catalog',
        description: 'Fetch machine-readable product catalog with live stock, pricing, and bundle affinities',
        endpoint: '/api/agentic/catalog',
      },
      {
        name: 'request_agent_checkout',
        description: 'Submit autonomous purchase request with cryptographic x402 / UAP authorization voucher',
        endpoint: '/api/agentic/checkout',
      },
    ],
  };

  return NextResponse.json(manifest, {
    status: 200,
    headers: {
      'X-Agent-Discovery': 'ACP-v1.2, UAP-v1.0, MCP-v1',
      'Cache-Control': 'no-cache, no-store',
    },
  });
}
