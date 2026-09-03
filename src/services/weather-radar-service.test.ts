import { describe, it, expect } from 'vitest';
import { WeatherRadarService } from './weather-radar-service';

describe('WeatherRadarService (Revenue Defense)', () => {
  it('returns valid banking nodes, revenue defense metrics, and storm index', () => {
    const telemetry = WeatherRadarService.getTelemetry();

    // Storm Index & Severity
    expect(telemetry.stormIndex).toBe(82);
    expect(telemetry.stormSeverity).toBe('CRITICAL');
    expect(telemetry.stormExplanation).toContain('82/100');

    // Failure Velocity & Acceleration
    expect(telemetry.currentFailureVelocity).toBe(18.4);
    expect(telemetry.baselineFailureVelocity).toBe(5.1);
    expect(telemetry.velocityAcceleration).toBe(3.61);
    expect(telemetry.velocityHistory.length).toBeGreaterThan(5);

    // Revenue Defended & Suppression
    expect(telemetry.totalRevenueDefendedPaise).toBe(78400000); // ₹7.84 Lakh
    expect(telemetry.suppressedRetriesTotal).toBe(147);
    expect(telemetry.unnecessaryRetriesPrevented).toBeGreaterThan(100);

    // Bank Nodes
    expect(telemetry.bankNodes.length).toBeGreaterThan(3);
    const hdfc = telemetry.bankNodes.find((n) => n.code === 'HDFC_PG');
    expect(hdfc).toBeDefined();
    expect(hdfc?.status).toBe('ELEVATED_TIMEOUTS');
    expect(hdfc?.spikeFactor).toBeGreaterThan(2);

    // Revenue Decay Forecast
    const leak1 = telemetry.activeLeaks[0];
    expect(leak1?.decayTimeline.length).toBe(6);
    expect(leak1?.decayTimeline[0]?.projectedRecoverableInr).toBe(840000);
    expect(leak1?.decayTimeline[5]?.projectedRecoverableInr).toBe(184000);
    expect(leak1?.decayTimeline[5]?.decayLossInr).toBe(656000);

    // Defense Actions
    expect(telemetry.defenseActions.length).toBeGreaterThanOrEqual(4);
    expect(telemetry.defenseActions[0]?.rank).toBe(1);
    expect(telemetry.defenseActions[0]?.protectedRevenueInr).toContain('2.84');

    // High-LTV Protection
    expect(telemetry.highLtvCustomers.length).toBeGreaterThanOrEqual(3);
    expect(telemetry.highLtvCustomers[0]?.customerId).toBe('cust_201');

    // Cascade & Timeline
    expect(telemetry.cascadeProgression.length).toBe(5);
    expect(telemetry.incidentTimeline.length).toBe(8);
  });
});
