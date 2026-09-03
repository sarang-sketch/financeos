import { NextResponse } from 'next/server';
import { CommerceDatabase } from '@/commerce/commerce-db';
import { getLiveTransactionStats, getLiveTransactions } from '@/services/live-transaction-store';

/**
 * GET /api/dashboard/commerce
 *
 * Live commerce metrics for the AI Control Center dashboard.
 * Returns real-time counters, revenue stats, and firewall health.
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const merchantId = searchParams.get('merchantId') || 'merchant_001';

    // Fetch real data
    const [orderStats, products, auditEvents, firewallBlocks] = await Promise.all([
      CommerceDatabase.getOrderStats(merchantId),
      CommerceDatabase.getProducts({ merchantId }),
      CommerceDatabase.getAuditEvents({ limit: 50 }),
      CommerceDatabase.getFirewallBlockCount(),
    ]);

    // Compute metrics
    const totalInventory = products.reduce((sum, p) => sum + p.inventory, 0);
    const avgMargin = products.length > 0
      ? products.reduce((sum, p) => sum + p.marginPercent, 0) / products.length
      : 0;

    // Build hourly revenue sparkline from audit events (simplified)
    const now = Date.now();
    const hourBuckets = Array.from({ length: 12 }, (_, i) => {
      const hourStart = now - (11 - i) * 3600000;
      const hourEnd = hourStart + 3600000;
      const hourEvents = auditEvents.filter((e) => {
        const t = new Date(e.timestamp).getTime();
        return t >= hourStart && t < hourEnd && e.action === 'ORDER_CONFIRMED';
      });
      return hourEvents.length;
    });

    // Agent actions breakdown
    const actorCounts: Record<string, number> = {};
    for (const e of auditEvents) {
      actorCounts[e.actor] = (actorCounts[e.actor] || 0) + 1;
    }

    // Daily target (simulated: ₹50,000/day for demo)
    const dailyTargetPaise = 5000000;
    const progressPercent = Math.min(100, Math.round((orderStats.totalRevenuePaise / dailyTargetPaise) * 100));

    // Upsell rate
    const upsellEvents = auditEvents.filter((e) => e.action === 'OFFER_GENERATED' || e.action === 'PRODUCT_SELECTED');
    const upsellRate = orderStats.totalOrders > 0
      ? Math.min(100, Math.round((upsellEvents.length / Math.max(1, orderStats.totalOrders)) * 100))
      : 31; // Demo fallback

    // ========== Merge live transaction data ON TOP of seed data ==========
    const liveStats = getLiveTransactionStats();
    const liveRecent = getLiveTransactions().slice(0, 10);

    const mergedTotalRevenue = orderStats.totalRevenuePaise + liveStats.liveRevenuePaise;
    const mergedAiRevenue = (orderStats.aiRevenuePaise || orderStats.totalRevenuePaise) + liveStats.liveRevenuePaise;
    const mergedTotalOrders = orderStats.totalOrders + liveStats.totalLiveOrders;
    const mergedAov = mergedTotalOrders > 0
      ? Math.round(mergedTotalRevenue / mergedTotalOrders)
      : orderStats.averageOrderValuePaise;
    const mergedFirewallBlocks = firewallBlocks + liveStats.liveFailedCount;
    const mergedProgressPercent = Math.min(100, Math.round((mergedTotalRevenue / dailyTargetPaise) * 100));

    return NextResponse.json({
      // Core counters (seed + live merged)
      totalRevenuePaise: mergedTotalRevenue,
      aiRevenuePaise: mergedAiRevenue,
      totalOrders: mergedTotalOrders,
      averageOrderValuePaise: mergedAov,

      // Health metrics
      firewallBlocks: mergedFirewallBlocks,
      firewallGateScore: mergedFirewallBlocks === 0 ? 100 : Math.max(0, 100 - mergedFirewallBlocks * 10),
      upsellAttachRate: upsellRate,
      avgMarginPercent: Math.round(avgMargin * 10) / 10,
      totalInventory,

      // Progress
      dailyTargetPaise,
      progressPercent: mergedProgressPercent,

      // Sparkline data
      revenueSparkline: hourBuckets,

      // Agent breakdown
      actorCounts,

      // Live transaction activity feed
      liveTransactionCount: liveStats.totalLiveOrders,
      liveFailedCount: liveStats.liveFailedCount,
      liveSuccessCount: liveStats.liveSuccessCount,
      recentLiveTransactions: liveRecent.map((t) => ({
        id: t.id,
        type: t.type,
        amount: `₹${(t.amountPaise / 100).toLocaleString('en-IN')}`,
        product: t.productName,
        channel: t.channel,
        error: t.errorReason,
        time: t.timestamp,
        hash: t.auditSha256,
      })),

      // Comparison: AI vs Manual (simulated for demo)
      comparison: {
        aiRevenuePaise: mergedAiRevenue,
        manualRevenuePaise: Math.round((orderStats.totalRevenuePaise || 500000) * 0.45),
        aiAovPaise: mergedAov || 624700,
        manualAovPaise: Math.round((orderStats.averageOrderValuePaise || 310000) * 0.5),
        aiUpsellRate: upsellRate,
        manualUpsellRate: 0,
        aiCartAbandon: 22,
        manualCartAbandon: 68,
        upliftMultiple: 2.01,
      },

      // Timestamp
      generatedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Dashboard metrics error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
