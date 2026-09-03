import { type RecoveryDigitalTwin, type SimulatedActionOutcome } from './digital-twin-service';

export type RecoveryPassportDecision = 'WAIT' | 'EXECUTE' | 'ABORT';
export type RecoveryRouteHealth = 'DEGRADED' | 'HEALTHY';

export interface RecoveryPassportEvaluation {
  readonly decision: RecoveryPassportDecision;
  readonly title: string;
  readonly detail: string;
  readonly auditEvent: string;
}

export interface RecoveryPassport {
  readonly id: string;
  readonly paymentId: string;
  readonly dataDisclosure: string;
  readonly action: SimulatedActionOutcome;
  readonly immediateAlternative: SimulatedActionOutcome;
  readonly notBeforeMinutes: number;
  readonly expiresAfterMinutes: number;
  readonly maxAttempts: number;
  readonly attemptsUsed: number;
  readonly expectedNetAdvantagePaise: number;
  readonly rules: readonly {
    readonly id: string;
    readonly label: string;
    readonly enforcement: string;
  }[];
}

export interface RecoveryPassportObservation {
  readonly minutesSinceFailure: number;
  readonly paymentRecovered: boolean;
  readonly attemptsUsed: number;
  readonly routeHealth: RecoveryRouteHealth;
}

function immediateRetry(twin: RecoveryDigitalTwin): SimulatedActionOutcome {
  const action = twin.simulatedActions.find((candidate) => candidate.actionType === 'CARD_RETRY_NOW');
  if (!action) {
    throw new Error('Recovery Passport requires an immediate retry counterfactual.');
  }
  return action;
}

/**
 * Compiles an action into a small, inspectable execution contract.
 *
 * A passport is deliberately created before the action becomes eligible. It
 * describes the exact conditions under which the recovery must wait, run, or
 * permanently stop; it is not an after-the-fact explanation.
 */
export function compileRecoveryPassport(twin: RecoveryDigitalTwin): RecoveryPassport {
  const action = twin.optimalAction;
  const immediateAlternative = immediateRetry(twin);
  const notBeforeMinutes = twin.optimalWaitMinutes;

  return {
    id: `RCP-${twin.paymentId.toUpperCase()}`,
    paymentId: twin.paymentId,
    dataDisclosure: 'Policy-issued action envelope. It is re-evaluated against payment, route, and duplicate-event state before execution.',
    action,
    immediateAlternative,
    notBeforeMinutes,
    expiresAfterMinutes: 30,
    maxAttempts: 3,
    attemptsUsed: twin.previousAttemptsCount,
    expectedNetAdvantagePaise: action.netExpectedPaise - immediateAlternative.netExpectedPaise,
    rules: [
      {
        id: 'cooldown',
        label: `No execution before T+${notBeforeMinutes} minutes`,
        enforcement: 'The immediate card retry is withheld while the correlated route is degraded.',
      },
      {
        id: 'retry_budget',
        label: `Maximum ${3} attempts per payment`,
        enforcement: `This payment has ${twin.previousAttemptsCount} recorded attempt(s); no retry is allowed after the budget is consumed.`,
      },
      {
        id: 'duplicate_guard',
        label: 'Cancel if a payment success arrives first',
        enforcement: 'A late webhook or a customer-completed payment wins over every scheduled recovery action.',
      },
      {
        id: 'route_health',
        label: 'Execute only after route health recovers',
        enforcement: 'A still-degraded route keeps the action on hold; the agent does not escalate retry pressure during an incident.',
      },
      {
        id: 'expiry',
        label: 'Auto-expire at T+30 minutes',
        enforcement: 'An expired recommendation is aborted and must be re-evaluated against fresh evidence.',
      },
    ],
  };
}

/** Applies the passport deterministically to current payment and route state. */
export function evaluateRecoveryPassport(
  passport: RecoveryPassport,
  observation: RecoveryPassportObservation,
): RecoveryPassportEvaluation {
  if (observation.paymentRecovered) {
    return {
      decision: 'ABORT',
      title: 'Cancelled: payment is already recovered',
      detail: 'The duplicate-action guard won. No retry, message, or payment link can be sent.',
      auditEvent: 'RECOVERY_ABORTED_ALREADY_RECOVERED',
    };
  }

  if (observation.attemptsUsed >= passport.maxAttempts) {
    return {
      decision: 'ABORT',
      title: 'Cancelled: retry budget is exhausted',
      detail: `The payment has reached its ${passport.maxAttempts}-attempt limit. Fresh human review is required.`,
      auditEvent: 'RECOVERY_ABORTED_RETRY_BUDGET',
    };
  }

  if (observation.minutesSinceFailure > passport.expiresAfterMinutes) {
    return {
      decision: 'ABORT',
      title: 'Expired: evidence is too old to act on',
      detail: 'The recovery recommendation is discarded rather than reused after its evidence window.',
      auditEvent: 'RECOVERY_ABORTED_EXPIRED',
    };
  }

  if (observation.minutesSinceFailure < passport.notBeforeMinutes) {
    return {
      decision: 'WAIT',
      title: `Cooldown active until T+${passport.notBeforeMinutes}m`,
      detail: 'The action is intentionally delayed to let the correlated bank route recover.',
      auditEvent: 'RECOVERY_HELD_COOLDOWN',
    };
  }

  if (observation.routeHealth === 'DEGRADED') {
    return {
      decision: 'WAIT',
      title: 'Route remains degraded',
      detail: 'The action stays held. FinanceOS waits for a healthy route instead of turning an outage into customer fatigue.',
      auditEvent: 'RECOVERY_HELD_ROUTE_DEGRADED',
    };
  }

  return {
    decision: 'EXECUTE',
    title: 'Eligible: bounded recovery may execute',
    detail: 'Cooldown, route health, retry budget, freshness, and duplicate checks have all passed.',
    auditEvent: 'RECOVERY_ELIGIBLE_FOR_EXECUTION',
  };
}
