import { NextResponse } from 'next/server';
import { AiBuyer } from '@/commerce/ai-buyer';
import { CommerceDatabase } from '@/commerce/commerce-db';

/**
 * POST /api/commerce/buyer
 *
 * AI Buyer endpoint — takes natural language query, returns structured intent,
 * matched products, selected product, and AI explanation.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { query } = body;

    if (!query || typeof query !== 'string') {
      return NextResponse.json({ error: 'Query is required and must be a string' }, { status: 400 });
    }

    // Run the AI Buyer full discovery pipeline
    const result = await AiBuyer.runFullDiscovery(query);

    // Fetch recent audit trail
    const auditTrail = await CommerceDatabase.getAuditEvents({ limit: 10 });

    return NextResponse.json({
      intent: result.intent,
      candidates: result.candidates,
      selected: result.selectedProduct,
      explanation: result.explanation,
      auditTrail: auditTrail.map((e) => ({
        id: e.id,
        actor: e.actor,
        action: e.action,
        result: e.result,
        timestamp: e.timestamp,
      })),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'AI Buyer error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
