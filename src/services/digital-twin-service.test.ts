import { describe, it, expect } from 'vitest';
import { DigitalTwinService } from './digital-twin-service';

describe('DigitalTwinService', () => {
  it('creates digital twin and simulates 7 candidate futures', () => {
    const twin = DigitalTwinService.createDigitalTwin('pay_fail_901');

    expect(twin.paymentId).toBe('pay_fail_901');
    expect(twin.amountPaise).toBe(850000);
    expect(twin.simulatedActions.length).toBe(7);

    // Verify all 7 action types are present
    const types = twin.simulatedActions.map((a) => a.actionType);
    expect(types).toContain('DELAY_RETRY_10M');
    expect(types).toContain('CARD_RETRY_NOW');
    expect(types).toContain('WHATSAPP_LINK');
    expect(types).toContain('UPI_COLLECT');
    expect(types).toContain('PAYMENT_LINK_SMS');
    expect(types).toContain('HUMAN_ESCALATION');
    expect(types).toContain('NO_ACTION');
  });

  it('selects action with highest Expected Net Recovered Value', () => {
    const twin = DigitalTwinService.createDigitalTwin('pay_fail_901');

    expect(twin.optimalAction).toBeDefined();
    expect(twin.optimalAction.isOptimal).toBe(true);

    // Ensure optimal action has higher net expected paise than all non-optimal actions
    for (const action of twin.simulatedActions) {
      if (!action.isOptimal) {
        expect(twin.optimalAction.netExpectedPaise).toBeGreaterThanOrEqual(action.netExpectedPaise);
      }
    }
  });

  it('produces comparative reasoning explaining why alternatives were not chosen', () => {
    const twin = DigitalTwinService.createDigitalTwin('pay_fail_901');

    expect(twin.comparativeReasoning.whySelectedAction.length).toBeGreaterThan(0);
    expect(twin.comparativeReasoning.whyNotAlternatives.length).toBeGreaterThan(0);

    const firstAlt = twin.comparativeReasoning.whyNotAlternatives[0];
    expect(firstAlt?.actionLabel).toBeDefined();
    expect(firstAlt?.reasons.length).toBeGreaterThan(0);
  });

  it('generates temporal recovery curve across multiple time intervals', () => {
    const twin = DigitalTwinService.createDigitalTwin('pay_fail_901');

    expect(twin.temporalCurve.length).toBe(7);
    const intervals = twin.temporalCurve.map((p) => p.timeOffsetLabel);
    expect(intervals).toEqual(['NOW', '+2 min', '+5 min', '+10 min', '+15 min', '+30 min', '+60 min']);
  });
});
