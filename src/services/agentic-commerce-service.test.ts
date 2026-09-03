import { describe, it, expect } from 'vitest';
import { AgenticCommerceService } from './agentic-commerce-service';

describe('AgenticCommerceService (AI Growth & Agentic Commerce)', () => {
  it('returns valid merchant growth metrics and supported protocols', () => {
    const summary = AgenticCommerceService.getSummary();

    expect(summary.totalAgenticVolumePaise).toBeGreaterThan(10000000);
    expect(summary.aiBuyersServedCount).toBeGreaterThan(50);
    expect(summary.supportedProtocols).toContain('NPCI UAP (Unified Autonomous Payments)');
    expect(summary.supportedProtocols).toContain('ACP v1.2 (Agentic Commerce Protocol)');
    expect(summary.supportedProtocols).toContain('HTTP x402 (Payment Required Header for AI Agents)');
  });

  it('exposes a valid agent-readable catalog with protocol specs and cross-sells', () => {
    const summary = AgenticCommerceService.getSummary();

    expect(summary.catalog.length).toBeGreaterThanOrEqual(4);
    const apiCredits = summary.catalog.find((item) => item.sku === 'SKU_AI_01');
    expect(apiCredits).toBeDefined();
    expect(apiCredits?.agentPurchasable).toBe(true);
    expect(apiCredits?.agentProtocolSpec.uapEligible).toBe(true);
    expect(apiCredits?.agentProtocolSpec.x402HeaderSupported).toBe(true);
    expect(apiCredits?.crossSellAffinities.length).toBeGreaterThan(0);
  });

  it('executes successful AI buyer checkout simulation', () => {
    const tx = AgenticCommerceService.triggerSimulatedAiPurchase('SUCCESS');

    expect(tx.id).toBeDefined();
    expect(tx.executionStatus).toBe('SETTLED');
    expect(tx.policyStatus).toBe('PASSED');
    expect(tx.auditSha256).toBeDefined();
    expect(tx.amountPaise).toBeGreaterThan(0);
  });

  it('handles graceful failure when an AI buyer breaches budget ceilings', () => {
    const failTx = AgenticCommerceService.triggerSimulatedAiPurchase('FAILURE_GRACEFUL');

    expect(failTx.id).toBeDefined();
    expect(failTx.executionStatus).toBe('FAILED_GRACEFULLY_HANDLED');
    expect(failTx.policyStatus).toBe('GATE_BLOCKED_AND_MITIGATED');
    expect(failTx.mitigationApplied).toBeDefined();
    expect(failTx.auditSha256).toBeDefined();
  });

  it('returns valid upsell pairings with positive margin lift', () => {
    const summary = AgenticCommerceService.getSummary();

    expect(summary.upsells.length).toBeGreaterThanOrEqual(2);
    expect(summary.upsells[0]?.incrementalMarginPaise).toBeGreaterThan(0);
    expect(summary.upsells[0]?.expectedAovLiftPercent).toBeGreaterThan(20);
  });

  it('provides active buyer activities with contact details and cart values', () => {
    const activities = AgenticCommerceService.getBuyerActivities();

    expect(activities.length).toBeGreaterThanOrEqual(4);
    const session = activities[0];
    expect(session).toBeDefined();
    expect(session?.phone).toMatch(/^\+91/);
    expect(session?.email).toContain('@');
    expect(session?.items.length).toBeGreaterThan(0);
    expect(session?.totalCartPaise).toBeGreaterThan(0);
  });

  it('dispatches a multi-channel cart recovery nudge and generates audit digest', () => {
    const result = AgenticCommerceService.dispatchBuyerNudge('session_01', 'WHATSAPP');

    expect(result.success).toBe(true);
    expect(result.message).toContain('WhatsApp');
    expect(result.auditDigest).toBeDefined();
    expect(result.session.lastNudgeStatus).toBe('DELIVERED');
  });

  it('autonomously nudges all high-intent carts above policy threshold', () => {
    const autoResult = AgenticCommerceService.autoNudgeAllHighIntent();

    expect(autoResult.count).toBeGreaterThanOrEqual(1);
    expect(autoResult.totalValueInr).toContain('₹');
    expect(autoResult.message).toContain('Autonomous Nudge Agent');
  });
});
