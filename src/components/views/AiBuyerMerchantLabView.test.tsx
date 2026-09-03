import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AiBuyerMerchantLabView } from './AiBuyerMerchantLabView';
import { AgenticCommerceService } from '@/services/agentic-commerce-service';

describe('AiBuyerMerchantLabView', () => {
  it('renders dual-screen centerpiece header and split view', () => {
    const html = renderToStaticMarkup(<AiBuyerMerchantLabView />);

    expect(html).toContain('Razorpay CommerceOS: The AI Merchant That Sells to AI');
    expect(html).toContain('LEFT: Autonomous AI Buyer');
    expect(html).toContain('RIGHT: Merchant Control Room &amp; Policy Gate');
    expect(html).toContain('THE MONEY FIREWALL (POLICY GATE)');
  });

  it('evaluates Money Firewall constraints correctly', () => {
    // Under-limit: 10% allowed
    const pass = AgenticCommerceService.evaluateMoneyFirewall(10, 449900, 44);
    expect(pass.allowed).toBe(true);
    expect(pass.reason).toContain('POLICY PASSED');

    // Over-limit: 30% blocked
    const fail = AgenticCommerceService.evaluateMoneyFirewall(30, 449900, 44);
    expect(fail.allowed).toBe(false);
    expect(fail.reason).toContain('POLICY VIOLATION');
    expect(fail.counterOfferDiscountPercent).toBe(10);
  });

  it('generates autonomous revenue plan with bounded downside', () => {
    const plan = AgenticCommerceService.getAutonomousRevenuePlan();
    expect(plan.goal).toContain('+15% Revenue Expansion');
    expect(plan.expectedRevenueUpliftInr).toBe('+₹1,31,000.00');
    expect(plan.maximumDownsideInr).toContain('₹42,000.00');
  });
});
