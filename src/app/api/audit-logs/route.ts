import { NextResponse } from 'next/server';
import { CommerceDatabase } from '@/commerce/commerce-db';

/**
 * GET /api/audit-logs
 *
 * Fetches commerce audit events. Supports filtering by orderId, transactionId,
 * and source=commerce for commerce-specific events.
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const orderId = searchParams.get('orderId') || undefined;
    const transactionId = searchParams.get('transactionId') || undefined;
    const limit = searchParams.has('limit') ? parseInt(searchParams.get('limit')!, 10) : 50;

    const events = await CommerceDatabase.getAuditEvents({
      orderId,
      transactionId,
      limit,
    });

    return NextResponse.json({
      logs: events.map((e) => ({
        id: e.id,
        time: e.timestamp,
        actor: e.actor,
        action: e.action,
        entity: e.orderId || e.transactionId || e.id,
        status: e.result,
        hash: e.sha256Digest.substring(0, 16) + '...',
        input: e.input,
        decision: e.decision,
        reason: e.reason,
        policy: e.policySnapshot,
        result: e.result,
        sha256_digest: e.sha256Digest,
      })),
      count: events.length,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to fetch audit logs';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
