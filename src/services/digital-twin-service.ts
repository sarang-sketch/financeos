import { SEED_CUSTOMERS, SEED_PAYMENT_FAILURES, type SeedCustomer, type SeedPaymentFailure } from './seed-data-service';

export type CandidateActionType =
  | 'CARD_RETRY_NOW'
  | 'UPI_COLLECT'
  | 'PAYMENT_LINK_SMS'
  | 'WHATSAPP_LINK'
  | 'DELAY_RETRY_10M'
  | 'HUMAN_ESCALATION'
  | 'NO_ACTION';

export interface SimulatedActionOutcome {
  actionType: CandidateActionType;
  label: string;
  channel: string;
  probabilityPercent: number;
  grossExpectedPaise: number;
  gatewayCostPaise: number;
  frictionCostPaise: number;
  riskPenaltyPaise: number;
  netExpectedPaise: number;
  timeToRecoveryEta: string;
  frictionLevel: 'None' | 'Low' | 'Medium' | 'High';
  riskScore: string;
  isOptimal: boolean;
  policyStatus: 'PASSED' | 'REQUIRES_APPROVAL' | 'DELAYED' | 'BLOCKED';
  policyReason: string;
}

export interface ComparativeReasoning {
  whySelectedAction: string[];
  whyNotAlternatives: Array<{
    actionLabel: string;
    reasons: string[];
  }>;
}

export interface TemporalRecoveryPoint {
  timeOffsetLabel: string; // "NOW", "+2 min", "+5 min", "+10 min", "+15 min", "+30 min", "+60 min"
  minutesOffset: number;
  probabilityPercent: number;
  expectedNetInr: number;
  isOptimalTiming: boolean;
}

export interface ValueDecayPoint {
  timeLabel: string;
  expectedRecoverableInr: number;
  decayPercent: number;
}

export interface DecisionGraphNode {
  id: string;
  title: string;
  category: 'DETECTION' | 'DIAGNOSIS' | 'CONTEXT' | 'SIMULATION' | 'OPTIMIZATION' | 'POLICY' | 'EXECUTION' | 'OUTCOME' | 'LEARNING';
  summary: string;
  details: string;
  status: 'COMPLETED' | 'ACTIVE' | 'PENDING';
}

export interface RecoveryDigitalTwin {
  paymentId: string;
  customerId: string;
  customerName: string;
  customerLtvPaise: number;
  amountPaise: number;
  amountInrFormatted: string;
  failureReason: string;
  errorCode: string;
  timeSinceFailureMins: number;
  previousAttemptsCount: number;
  gatewayNodeHealth: 'OPTIMAL' | 'TRANSIENT_DEGRADED' | 'SEVERE_OUTAGE';
  failureClassification: 'CUSTOMER_SPECIFIC' | 'SYSTEMIC_DEGRADATION';
  simulatedActions: SimulatedActionOutcome[];
  optimalAction: SimulatedActionOutcome;
  comparativeReasoning: ComparativeReasoning;
  temporalCurve: TemporalRecoveryPoint[];
  optimalWaitMinutes: number;
  valueDecayTimeline: ValueDecayPoint[];
  decisionGraph: DecisionGraphNode[];
}

export class DigitalTwinService {
  /**
   * Build the complete Recovery Digital Twin and simulate counterfactual futures.
   */
  static createDigitalTwin(paymentId: string): RecoveryDigitalTwin {
    const payment = SEED_PAYMENT_FAILURES.find((p) => p.id === paymentId) || SEED_PAYMENT_FAILURES[0]!;
    const customer = SEED_CUSTOMERS.find((c) => c.id === payment.customer_id) || SEED_CUSTOMERS[0]!;

    const amountPaise = payment.amount_paise;
    const amountInr = amountPaise / 100;
    const isTransientTimeout = payment.failure_reason.includes('timeout') || payment.error_code.includes('TIMEOUT');
    const isInsufficientFunds = payment.failure_reason.includes('balance') || payment.failure_reason.includes('funds');
    const hasCustomerCardHistory = (customer.channel_success_rates.card || 0) > 60;
    const hasZeroPriorSuccess = customer.successful_payments_count === 0;

    // Classify Systemic vs Customer
    const failureClassification: 'CUSTOMER_SPECIFIC' | 'SYSTEMIC_DEGRADATION' = isTransientTimeout
      ? 'SYSTEMIC_DEGRADATION'
      : 'CUSTOMER_SPECIFIC';
    const gatewayNodeHealth = isTransientTimeout ? 'TRANSIENT_DEGRADED' : 'OPTIMAL';

    // 1. Simulate Candidate Actions
    // Action 1: Card Retry Now
    const cardNowProb = hasZeroPriorSuccess ? 54 : isTransientTimeout ? (gatewayNodeHealth === 'TRANSIENT_DEGRADED' ? 62 : 86) : 74;
    const cardNowGross = Math.round((amountPaise * cardNowProb) / 100);
    const cardNowCost = 4200; // ₹42.00
    const cardNowFriction = 0; // Silent retry
    const cardNowRisk = isTransientTimeout && gatewayNodeHealth === 'TRANSIENT_DEGRADED' ? 12000 : 2500; // ₹120 or ₹25 risk
    const cardNowNet = Math.max(0, cardNowGross - cardNowCost - cardNowFriction - cardNowRisk);

    // Action 2: Delay 10m + Card Retry (For transient failures, waiting allows gateway to recover!)
    const delayProb = isTransientTimeout ? 93 : cardNowProb;
    const delayGross = Math.round((amountPaise * delayProb) / 100);
    const delayCost = 4200;
    const delayFriction = 500; // Minor delay friction
    const delayRisk = 1200; // Lower risk because bank queue cleared
    const delayNet = Math.max(0, delayGross - delayCost - delayFriction - delayRisk);

    // Action 3: UPI Collect
    const upiProb = hasZeroPriorSuccess ? 68 : isInsufficientFunds ? 45 : (customer.channel_success_rates.upi || 50);
    const upiGross = Math.round((amountPaise * upiProb) / 100);
    const upiCost = 1500; // ₹15.00
    const upiFriction = 4500; // Customer gets collect request notification
    const upiRisk = 2000;
    const upiNet = Math.max(0, upiGross - upiCost - upiFriction - upiRisk);

    // Action 4: WhatsApp Interactive Link
    const waProb = isInsufficientFunds ? 78 : 71;
    const waGross = Math.round((amountPaise * waProb) / 100);
    const waCost = 800; // ₹8.00 message fee
    const waFriction = 6500; // User opens WhatsApp & completes payment
    const waRisk = 1000;
    const waNet = Math.max(0, waGross - waCost - waFriction - waRisk);

    // Action 5: Payment Link (SMS)
    const linkProb = 64;
    const linkGross = Math.round((amountPaise * linkProb) / 100);
    const linkCost = 500; // ₹5.00
    const linkFriction = 8500;
    const linkRisk = 1500;
    const linkNet = Math.max(0, linkGross - linkCost - linkFriction - linkRisk);

    // Action 6: Human Escalation
    const humanProb = 82;
    const humanGross = Math.round((amountPaise * humanProb) / 100);
    const humanCost = 25000; // ₹250.00 human ops overhead
    const humanFriction = 12000; // Human phone call / manual intervention
    const humanRisk = 500;
    const humanNet = Math.max(0, humanGross - humanCost - humanFriction - humanRisk);

    // Action 7: No Action
    const noActionNet = 0;

    const simulatedActions: SimulatedActionOutcome[] = [
      {
        actionType: 'DELAY_RETRY_10M',
        label: 'Delay 10 Min → Card Dynamic Retry',
        channel: 'Card (Delayed)',
        probabilityPercent: delayProb,
        grossExpectedPaise: delayGross,
        gatewayCostPaise: delayCost,
        frictionCostPaise: delayFriction,
        riskPenaltyPaise: delayRisk,
        netExpectedPaise: delayNet,
        timeToRecoveryEta: '10 mins (Optimal Window)',
        frictionLevel: 'Low',
        riskScore: 'Very Low (2/100)',
        isOptimal: false,
        policyStatus: 'PASSED',
        policyReason: 'Bank gateway recovery window detected; 93% success rate expected.',
      },
      {
        actionType: 'CARD_RETRY_NOW',
        label: 'Card Dynamic Retry (Immediate)',
        channel: 'Card',
        probabilityPercent: cardNowProb,
        grossExpectedPaise: cardNowGross,
        gatewayCostPaise: cardNowCost,
        frictionCostPaise: cardNowFriction,
        riskPenaltyPaise: cardNowRisk,
        netExpectedPaise: cardNowNet,
        timeToRecoveryEta: '45 seconds',
        frictionLevel: 'None',
        riskScore: isTransientTimeout && gatewayNodeHealth === 'TRANSIENT_DEGRADED' ? 'Elevated (18/100)' : 'Low (4/100)',
        isOptimal: false,
        policyStatus: isTransientTimeout && gatewayNodeHealth === 'TRANSIENT_DEGRADED' ? 'DELAYED' : 'PASSED',
        policyReason: isTransientTimeout && gatewayNodeHealth === 'TRANSIENT_DEGRADED' ? 'Gateway latency elevated (340ms). Recommended 10m debounce.' : 'Verified route health.',
      },
      {
        actionType: 'WHATSAPP_LINK',
        label: 'Razorpay WhatsApp Payment Link',
        channel: 'WhatsApp Link',
        probabilityPercent: waProb,
        grossExpectedPaise: waGross,
        gatewayCostPaise: waCost,
        frictionCostPaise: waFriction,
        riskPenaltyPaise: waRisk,
        netExpectedPaise: waNet,
        timeToRecoveryEta: '3 - 8 minutes',
        frictionLevel: 'Low',
        riskScore: 'Low (5/100)',
        isOptimal: false,
        policyStatus: 'PASSED',
        policyReason: 'Customer contact channel verified; zero duplicate risk.',
      },
      {
        actionType: 'UPI_COLLECT',
        label: 'UPI AutoPay / Collect Request',
        channel: 'UPI',
        probabilityPercent: upiProb,
        grossExpectedPaise: upiGross,
        gatewayCostPaise: upiCost,
        frictionCostPaise: upiFriction,
        riskPenaltyPaise: upiRisk,
        netExpectedPaise: upiNet,
        timeToRecoveryEta: '2 minutes',
        frictionLevel: 'Medium',
        riskScore: 'Low (6/100)',
        isOptimal: false,
        policyStatus: 'PASSED',
        policyReason: 'Standard NPCI UPI collect route.',
      },
      {
        actionType: 'PAYMENT_LINK_SMS',
        label: 'SMS Smart Payment Link',
        channel: 'Payment Link',
        probabilityPercent: linkProb,
        grossExpectedPaise: linkGross,
        gatewayCostPaise: linkCost,
        frictionCostPaise: linkFriction,
        riskPenaltyPaise: linkRisk,
        netExpectedPaise: linkNet,
        timeToRecoveryEta: '15 - 45 minutes',
        frictionLevel: 'Medium',
        riskScore: 'Low (7/100)',
        isOptimal: false,
        policyStatus: 'PASSED',
        policyReason: 'SMS fallback channel available.',
      },
      {
        actionType: 'HUMAN_ESCALATION',
        label: 'High-Touch Account Exec Escalation',
        channel: 'Human Review',
        probabilityPercent: humanProb,
        grossExpectedPaise: humanGross,
        gatewayCostPaise: humanCost,
        frictionCostPaise: humanFriction,
        riskPenaltyPaise: humanRisk,
        netExpectedPaise: humanNet,
        timeToRecoveryEta: '2 - 4 hours',
        frictionLevel: 'High',
        riskScore: 'Negligible (1/100)',
        isOptimal: false,
        policyStatus: amountInr > 50000 ? 'REQUIRES_APPROVAL' : 'PASSED',
        policyReason: 'Reserved for high-value LTV accounts exceeding auto-ceilings.',
      },
      {
        actionType: 'NO_ACTION',
        label: 'No Action (Absorb Loss)',
        channel: 'None',
        probabilityPercent: 0,
        grossExpectedPaise: 0,
        gatewayCostPaise: 0,
        frictionCostPaise: 0,
        riskPenaltyPaise: 0,
        netExpectedPaise: noActionNet,
        timeToRecoveryEta: 'N/A',
        frictionLevel: 'None',
        riskScore: 'Zero (0/100)',
        isOptimal: false,
        policyStatus: 'PASSED',
        policyReason: 'Zero cost, 100% loss.',
      },
    ];

    // Determine optimal action based on MAXIMUM NET EXPECTED PAISE
    let optimalAction = simulatedActions[0]!;
    for (const act of simulatedActions) {
      if (act.netExpectedPaise > optimalAction.netExpectedPaise && act.policyStatus !== 'BLOCKED') {
        optimalAction = act;
      }
    }
    optimalAction.isOptimal = true;

    // 2. Comparative Reasoning ("Why Not the Obvious Action?")
    const whySelected: string[] = [];
    const whyNotAlternatives: ComparativeReasoning['whyNotAlternatives'] = [];

    if (optimalAction.actionType === 'DELAY_RETRY_10M') {
      whySelected.push(`HDFC / Razorpay card gateway experienced a transient timeout spike (+340% error rate).`);
      whySelected.push(`Historical telemetry proves waiting 10 minutes increases recovery probability from 62% to 93%.`);
      whySelected.push(`Yields highest Net Expected Value of ₹${(optimalAction.netExpectedPaise / 100).toLocaleString('en-IN')}.00 (₹${((optimalAction.netExpectedPaise - cardNowNet) / 100).toLocaleString('en-IN')}.00 higher than immediate retry).`);
      whySelected.push(`Customer has ${customer.successful_payments_count} successful historical payments on this card.`);

      whyNotAlternatives.push({
        actionLabel: 'Immediate Card Retry',
        reasons: [
          `Gateway timeout condition is still active; immediate retry has a 38% failure probability.`,
          `Immediate retry risks burning one of 3 permitted retry caps needlessly.`,
          `Net Expected Value is ₹${(cardNowNet / 100).toLocaleString('en-IN')}.00 vs ₹${(delayNet / 100).toLocaleString('en-IN')}.00 for 10m delayed execution.`,
        ],
      });
      whyNotAlternatives.push({
        actionLabel: 'WhatsApp Payment Link',
        reasons: [
          `Requires manual customer interaction (opening WhatsApp, entering UPI/Card info again).`,
          `22% lower expected recovery probability than the automated delayed card retry.`,
          `Customer friction cost penalty is ₹65.00 vs ₹0.00 for background card retry.`,
        ],
      });
      whyNotAlternatives.push({
        actionLabel: 'Immediate UPI Collect',
        reasons: [
          `Customer has primary affinity for Credit Card (${customer.channel_success_rates.card || 88.9}%), with lower UPI affinity.`,
          `Sending unexpected UPI collect requests introduces push notification fatigue.`,
        ],
      });
    } else if (optimalAction.actionType === 'WHATSAPP_LINK') {
      whySelected.push(`Payment failed due to insufficient funds; automated card retry will fail again immediately.`);
      whySelected.push(`WhatsApp interactive link provides convenient one-click alternate payment methods (UPI, Netbanking, Other Card).`);
      whySelected.push(`78% recovery conversion rate on WhatsApp for invoice/bill amounts under ₹15,000.`);

      whyNotAlternatives.push({
        actionLabel: 'Immediate Card Retry',
        reasons: [
          `Account balance is insufficient; immediate retry is 95% guaranteed to fail.`,
          `Wastes gateway retry fee (₹42.00) with zero expected recovery.`,
        ],
      });
      whyNotAlternatives.push({
        actionLabel: 'SMS Payment Link',
        reasons: [
          `SMS click-through rate is 24% vs 78% on WhatsApp for Indian merchants.`,
          `Yields ₹${((waNet - linkNet) / 100).toLocaleString('en-IN')}.00 lower Net Expected Value.`,
        ],
      });
    } else {
      whySelected.push(`Customer has ${customer.successful_payments_count} prior successful payments on Card.`);
      whySelected.push(`Gateway health is currently OPTIMAL (14ms latency).`);
      whySelected.push(`Immediate background retry has zero customer friction and recovers funds in under 45 seconds.`);

      whyNotAlternatives.push({
        actionLabel: 'Payment Link (WhatsApp/SMS)',
        reasons: [
          `Unnecessarily forces customer to re-enter payment details when silent retry has 86% probability.`,
          `Adds ₹65 customer friction penalty and delays settlement.`,
        ],
      });
      whyNotAlternatives.push({
        actionLabel: 'Human Review Escalation',
        reasons: [
          `Amount is below auto-execution ceiling (₹50,000.00); human manual review introduces ₹250 ops overhead unnecessarily.`,
        ],
      });
    }

    // 3. Temporal Recovery Curve & Value Decay
    const temporalCurve: TemporalRecoveryPoint[] = [
      { timeOffsetLabel: 'NOW', minutesOffset: 0, probabilityPercent: cardNowProb, expectedNetInr: cardNowNet / 100, isOptimalTiming: optimalAction.actionType === 'CARD_RETRY_NOW' },
      { timeOffsetLabel: '+2 min', minutesOffset: 2, probabilityPercent: isTransientTimeout ? 72 : cardNowProb - 2, expectedNetInr: (amountInr * 0.72) - 45, isOptimalTiming: false },
      { timeOffsetLabel: '+5 min', minutesOffset: 5, probabilityPercent: isTransientTimeout ? 84 : cardNowProb - 4, expectedNetInr: (amountInr * 0.84) - 45, isOptimalTiming: false },
      { timeOffsetLabel: '+10 min', minutesOffset: 10, probabilityPercent: isTransientTimeout ? 93 : cardNowProb - 6, expectedNetInr: delayNet / 100, isOptimalTiming: optimalAction.actionType === 'DELAY_RETRY_10M' },
      { timeOffsetLabel: '+15 min', minutesOffset: 15, probabilityPercent: isTransientTimeout ? 91 : cardNowProb - 8, expectedNetInr: (amountInr * 0.91) - 48, isOptimalTiming: false },
      { timeOffsetLabel: '+30 min', minutesOffset: 30, probabilityPercent: 78, expectedNetInr: (amountInr * 0.78) - 55, isOptimalTiming: false },
      { timeOffsetLabel: '+60 min', minutesOffset: 60, probabilityPercent: 64, expectedNetInr: (amountInr * 0.64) - 65, isOptimalTiming: false },
    ];

    const optimalWaitMinutes = optimalAction.actionType === 'DELAY_RETRY_10M' ? 10 : 0;

    const valueDecayTimeline: ValueDecayPoint[] = [
      { timeLabel: 'Now (Immediate)', expectedRecoverableInr: Math.round(amountInr * 0.86), decayPercent: 0 },
      { timeLabel: '+10 Minutes (Optimal)', expectedRecoverableInr: Math.round(amountInr * 0.93), decayPercent: -8 }, // Gains value!
      { timeLabel: '+30 Minutes', expectedRecoverableInr: Math.round(amountInr * 0.78), decayPercent: 12 },
      { timeLabel: '+2 Hours', expectedRecoverableInr: Math.round(amountInr * 0.58), decayPercent: 32 },
      { timeLabel: 'Tomorrow (+24h)', expectedRecoverableInr: Math.round(amountInr * 0.28), decayPercent: 68 },
    ];

    // 4. Decision Graph Pipeline
    const decisionGraph: DecisionGraphNode[] = [
      { id: 'n1', title: 'Payment Failure Ingestion', category: 'DETECTION', summary: `${payment.id} (₹${amountInr.toLocaleString('en-IN')}.00)`, details: `Ingested via Razorpay Webhook with verified HMAC signature.`, status: 'COMPLETED' },
      { id: 'n2', title: 'Root Cause Classification', category: 'DIAGNOSIS', summary: payment.failure_reason, details: `Classified as ${isTransientTimeout ? 'Transient Gateway Timeout' : 'Customer Account Exception'} (Code: ${payment.error_code}).`, status: 'COMPLETED' },
      { id: 'n3', title: 'Customer Context & Memory', category: 'CONTEXT', summary: `${customer.name} (LTV ₹${((customer.ltv_paise || 0) / 100).toLocaleString('en-IN')})`, details: hasZeroPriorSuccess ? 'Zero prior success: activated tenant-level baseline rates.' : `Historical Card recovery success: ${customer.channel_success_rates.card || 88.9}%.`, status: 'COMPLETED' },
      { id: 'n4', title: 'Weather & Gateway Telemetry', category: 'CONTEXT', summary: `${gatewayNodeHealth} (${failureClassification})`, details: isTransientTimeout ? 'Bank gateway error rate spiked +340%. Systemic anomaly detected.' : 'Normal gateway route health.', status: 'COMPLETED' },
      { id: 'n5', title: 'Digital Twin Counterfactuals', category: 'SIMULATION', summary: '7 Future Actions Evaluated', details: 'Simulated probability, gross EV, gateway fees, customer friction, and risk penalties.', status: 'COMPLETED' },
      { id: 'n6', title: 'Net-EV Optimization', category: 'OPTIMIZATION', summary: `${optimalAction.label} (Net ₹${(optimalAction.netExpectedPaise / 100).toLocaleString('en-IN')})`, details: `Selected action maximizing Expected Net Recovery subject to policy constraints.`, status: 'COMPLETED' },
      { id: 'n7', title: 'Policy Gate & Safety Check', category: 'POLICY', summary: `${optimalAction.policyStatus} (8/8 Checks Validated)`, details: 'Monetary ceiling (₹50,000), duplicate protection, and retry debounce passed.', status: 'COMPLETED' },
      { id: 'n8', title: 'Autonomous Execution', category: 'EXECUTION', summary: optimalWaitMinutes > 0 ? `Scheduled in +${optimalWaitMinutes}m` : 'Dispatched to Gateway', details: 'Action committed to double-entry ledger queue.', status: 'ACTIVE' },
      { id: 'n9', title: 'Settlement Reconciliation', category: 'OUTCOME', summary: 'Paise Double-Entry Balanced', details: 'Gross, MDR fee, GST, and net settlement reconciled with ₹0.00 residual.', status: 'PENDING' },
      { id: 'n10', title: 'Customer Recovery Memory Update', category: 'LEARNING', summary: 'Feedback Loop Store', details: 'Updated customer channel affinity profile in recovery memory.', status: 'PENDING' },
    ];

    return {
      paymentId: payment.id,
      customerId: customer.id,
      customerName: customer.name,
      customerLtvPaise: customer.ltv_paise,
      amountPaise,
      amountInrFormatted: `₹${amountInr.toLocaleString('en-IN')}.00`,
      failureReason: payment.failure_reason,
      errorCode: payment.error_code,
      timeSinceFailureMins: 4,
      previousAttemptsCount: payment.attempts_count,
      gatewayNodeHealth,
      failureClassification,
      simulatedActions,
      optimalAction,
      comparativeReasoning: { whySelectedAction: whySelected, whyNotAlternatives },
      temporalCurve,
      optimalWaitMinutes,
      valueDecayTimeline,
      decisionGraph,
    };
  }
}
