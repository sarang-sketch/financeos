import { describe, expect, it } from 'vitest';
import { DigitalTwinService } from './digital-twin-service';
import { compileRecoveryPassport, evaluateRecoveryPassport } from './recovery-passport';

describe('Recovery Passport', () => {
  const passport = compileRecoveryPassport(DigitalTwinService.createDigitalTwin('pay_fail_901'));

  it('turns the counterfactual into a bounded action contract', () => {
    expect(passport.notBeforeMinutes).toBe(10);
    expect(passport.maxAttempts).toBe(3);
    expect(passport.attemptsUsed).toBe(2);
    expect(passport.expectedNetAdvantagePaise).toBe(273_800);
  });

  it('waits, executes, or aborts using the declared stopping rules', () => {
    expect(evaluateRecoveryPassport(passport, {
      minutesSinceFailure: 3,
      paymentRecovered: false,
      attemptsUsed: 2,
      routeHealth: 'DEGRADED',
    }).decision).toBe('WAIT');

    expect(evaluateRecoveryPassport(passport, {
      minutesSinceFailure: 10,
      paymentRecovered: false,
      attemptsUsed: 2,
      routeHealth: 'HEALTHY',
    }).decision).toBe('EXECUTE');

    expect(evaluateRecoveryPassport(passport, {
      minutesSinceFailure: 10,
      paymentRecovered: true,
      attemptsUsed: 2,
      routeHealth: 'HEALTHY',
    }).auditEvent).toBe('RECOVERY_ABORTED_ALREADY_RECOVERED');

    expect(evaluateRecoveryPassport(passport, {
      minutesSinceFailure: 31,
      paymentRecovered: false,
      attemptsUsed: 2,
      routeHealth: 'HEALTHY',
    }).auditEvent).toBe('RECOVERY_ABORTED_EXPIRED');
  });
});
