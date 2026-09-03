/**
 * CommerceOS Revenue Agent
 *
 * Revenue analysis and strategy engine with analyze → simulate → approve → execute lifecycle.
 * All strategies have governance levels and bounded exposure.
 */

import { CommerceDatabase } from '@/commerce/commerce-db';

export interface Strategy {
  id: string;
  type: 'AUTONOMOUS_BUNDLE' | 'CART_RECOVERY_NUDGE' | 'WARRANTY_UPSELL' | 'PRICE_OPTIMIZATION';
  title: string;
  targetSegment: string;
  historicalAttachRate: number;
  expectedUpliftPaise: number;
  maximumDownsidePaise: number;
  governanceLevel: 'LEVEL_1_AI_RECOMMENDATION' | 'LEVEL_2_HUMAN_GATED' | 'LEVEL_3_AUTONOMOUS_BOUNDED';
  status: 'READY_TO_DEPLOY' | 'APPROVED' | 'EXECUTING' | 'COMPLETED';
}

export interface RevenueAnalysis {
  weeklyRunRatePaise: number;
  aovPaise: number;
  totalOrders: number;
  totalRevenuePaise: number;
  aiRevenuePaise: number;
  bestSellingProducts: { name: string; pricePaise: number; marginPercent: number }[];
  inventoryAlerts: { name: string; inventory: number }[];
}

export interface RevenuePlan {
  goal: string;
  currentWeeklyRunRatePaise: number;
  currentWeeklyRunRateInr: string;
  strategies: Strategy[];
  expectedUpliftPaise: number;
  maximumDownsidePaise: number;
}

/** Format paise to INR with Indian locale */
function formatInr(paise: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100);
}

/** Simple Box-Muller normal distribution */
function randomNormal(mean: number, stdDev: number): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v) * stdDev + mean;
}

let strategyCounter = 100;
function generateStrategyId(): string {
  strategyCounter++;
  return `strat_${strategyCounter}`;
}

export class RevenueAgent {

  /**
   * Analyze merchant performance for a given period.
   */
  static async analyzePerformance(merchantId: string, period: '7_days' | '30_days' | '90_days' = '30_days'): Promise<RevenueAnalysis> {
    const periodWeeks = period === '7_days' ? 1 : period === '30_days' ? 4.3 : 12.9;

    const orderStats = await CommerceDatabase.getOrderStats(merchantId);
    const products = await CommerceDatabase.getProducts({ merchantId });

    const weeklyRunRatePaise = Math.floor(orderStats.totalRevenuePaise / periodWeeks);

    // Inventory alerts: products with < 10 units
    const inventoryAlerts = products
      .filter((p) => p.inventory < 10)
      .map((p) => ({ name: p.name, inventory: p.inventory }));

    // Best selling: top 3 by margin
    const bestSellingProducts = [...products]
      .sort((a, b) => b.marginPercent - a.marginPercent)
      .slice(0, 3)
      .map((p) => ({ name: p.name, pricePaise: p.pricePaise, marginPercent: p.marginPercent }));

    return {
      weeklyRunRatePaise,
      aovPaise: orderStats.averageOrderValuePaise,
      totalOrders: orderStats.totalOrders,
      totalRevenuePaise: orderStats.totalRevenuePaise,
      aiRevenuePaise: orderStats.aiRevenuePaise,
      bestSellingProducts,
      inventoryAlerts,
    };
  }

  /**
   * Generate candidate strategies based on analysis.
   */
  static generateStrategies(analysis: RevenueAnalysis, goal: string): Strategy[] {
    const strategies: Strategy[] = [];

    const medianPrice = analysis.bestSellingProducts.length > 0
      ? analysis.bestSellingProducts[Math.floor(analysis.bestSellingProducts.length / 2)]!.pricePaise
      : 100000;

    // If AOV is low, suggest bundling
    if (analysis.aovPaise < medianPrice) {
      strategies.push({
        id: generateStrategyId(),
        type: 'AUTONOMOUS_BUNDLE',
        title: 'Smart Product Bundling',
        targetSegment: 'Low AOV Customers',
        historicalAttachRate: 0.15,
        expectedUpliftPaise: 5000000,
        maximumDownsidePaise: 100000,
        governanceLevel: 'LEVEL_3_AUTONOMOUS_BOUNDED',
        status: 'READY_TO_DEPLOY',
      });
    }

    // If high inventory, suggest price optimization
    if (analysis.inventoryAlerts.length === 0) {
      strategies.push({
        id: generateStrategyId(),
        type: 'PRICE_OPTIMIZATION',
        title: 'Dynamic Overstock Pricing',
        targetSegment: 'Price Sensitive Buyers',
        historicalAttachRate: 0.08,
        expectedUpliftPaise: 2500000,
        maximumDownsidePaise: 50000,
        governanceLevel: 'LEVEL_2_HUMAN_GATED',
        status: 'READY_TO_DEPLOY',
      });
    }

    // If low volume, suggest cart recovery
    if (analysis.totalOrders < 50) {
      strategies.push({
        id: generateStrategyId(),
        type: 'CART_RECOVERY_NUDGE',
        title: 'Abandoned Cart AI Nudges',
        targetSegment: 'High Intent Droppers',
        historicalAttachRate: 0.22,
        expectedUpliftPaise: 7500000,
        maximumDownsidePaise: 0,
        governanceLevel: 'LEVEL_1_AI_RECOMMENDATION',
        status: 'READY_TO_DEPLOY',
      });
    }

    // Always suggest warranty upsell for toys & robotics
    strategies.push({
      id: generateStrategyId(),
      type: 'WARRANTY_UPSELL',
      title: 'Toy Accidental Damage Protection Upsell',
      targetSegment: 'RC Cars & Robotics Toy Buyers',
      historicalAttachRate: 0.18,
      expectedUpliftPaise: 3000000,
      maximumDownsidePaise: 0,
      governanceLevel: 'LEVEL_3_AUTONOMOUS_BOUNDED',
      status: 'READY_TO_DEPLOY',
    });

    return strategies;
  }

  /**
   * Monte Carlo-lite projection with confidence intervals.
   */
  static async simulateStrategy(strategyId: string, merchantId: string) {
    const analysis = await this.analyzePerformance(merchantId, '30_days');
    const baseRevenue = analysis.weeklyRunRatePaise || 500000; // Fallback for empty stores

    const iterations = 100;
    const uplifts: number[] = [];
    const attachRate = 0.15; // Default

    for (let i = 0; i < iterations; i++) {
      const sampled = randomNormal(attachRate, attachRate * 0.1);
      uplifts.push(sampled * baseRevenue * 0.2);
    }

    uplifts.sort((a, b) => a - b);

    const p10 = Math.floor(baseRevenue + uplifts[Math.floor(iterations * 0.1)]!);
    const p50 = Math.floor(baseRevenue + uplifts[Math.floor(iterations * 0.5)]!);
    const p90 = Math.floor(baseRevenue + uplifts[Math.floor(iterations * 0.9)]!);

    return {
      strategyId,
      currentRevenuePaise: baseRevenue,
      projectedRevenuePaise: { p10, p50, p90 },
      expectedUpliftPaise: p50 - baseRevenue,
      maximumDownsidePaise: Math.max(0, baseRevenue - p10),
      confidencePercent: 85,
    };
  }

  /**
   * Approve a strategy — moves to APPROVED status.
   */
  static async approveStrategy(strategyId: string, _merchantId: string) {
    await CommerceDatabase.updateStrategyStatus(strategyId, 'APPROVED');

    await CommerceDatabase.recordAuditEvent({
      actor: 'REVENUE_AGENT',
      action: 'STRATEGY_APPROVED',
      input: { strategyId },
      decision: { newStatus: 'APPROVED' },
      reason: `Revenue strategy ${strategyId} approved for execution.`,
      policySnapshot: {},
      result: 'APPROVED',
    });

    return { id: strategyId, status: 'APPROVED' as const };
  }

  /**
   * Execute a strategy — moves to EXECUTING status.
   */
  static async executeStrategy(strategyId: string, _merchantId: string) {
    await CommerceDatabase.updateStrategyStatus(strategyId, 'EXECUTING');

    await CommerceDatabase.recordAuditEvent({
      actor: 'REVENUE_AGENT',
      action: 'STRATEGY_EXECUTED',
      input: { strategyId },
      decision: { newStatus: 'EXECUTING' },
      reason: `Revenue strategy ${strategyId} execution started.`,
      policySnapshot: {},
      result: 'APPROVED',
    });

    return { id: strategyId, status: 'EXECUTING' as const, message: 'Strategy execution started' };
  }

  /**
   * Convenience: get full revenue plan for dashboard.
   */
  static async getRevenuePlan(merchantId: string): Promise<RevenuePlan> {
    const analysis = await this.analyzePerformance(merchantId, '30_days');
    const goal = 'Increase revenue by 15% this week';
    const strategies = this.generateStrategies(analysis, goal);

    const expectedUpliftPaise = strategies.reduce((sum, s) => sum + s.expectedUpliftPaise, 0);
    const maximumDownsidePaise = strategies.reduce((sum, s) => sum + s.maximumDownsidePaise, 0);

    return {
      goal,
      currentWeeklyRunRatePaise: analysis.weeklyRunRatePaise,
      currentWeeklyRunRateInr: formatInr(analysis.weeklyRunRatePaise),
      strategies,
      expectedUpliftPaise,
      maximumDownsidePaise,
    };
  }
}
