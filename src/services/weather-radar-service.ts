import { SEED_CUSTOMERS, SEED_PAYMENT_FAILURES, type SeedCustomer, type SeedPaymentFailure } from './seed-data-service';

export interface BankGatewayNode {
  name: string;
  code: string;
  status: 'OPERATIONAL' | 'ELEVATED_TIMEOUTS' | 'DEGRADED' | 'OUTAGE';
  latencyMs: number;
  failureRatePercent: number;
  baselineRatePercent: number;
  spikeFactor: number;
  volume24hPaise: number;
  affectedTransactionsCount: number;
  primaryChannel: string;
  recommendedStrategy: string;
  failureVelocityCurrent: number; // failures / min
  failureVelocityBaseline: number;
  accelerationFactor: number;
  revenueExposedPaise: number;
  recoverablePaise: number;
}

export interface RevenueLeakAlert {
  id: string;
  title: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  category: 'GATEWAY_DEGRADATION' | 'CHANNEL_DROPOUT' | 'CUSTOMER_FATIGUE' | 'HIGH_LTV_CHURN_RISK';
  amountAtRiskPaise: number;
  estimatedRecoverablePaise: number;
  affectedCount: number;
  baselineFailurePercent: number;
  currentFailurePercent: number;
  detectedTime: string;
  rootCauseDiagnosis: string;
  recommendedIntervention: string;
  status: 'ACTIVE' | 'MITIGATED' | 'MONITORING';
  suppressedRetriesCount: number;
  revenuePreservedPaise: number;
  decayTimeline: Array<{
    timeLabel: string;
    projectedRecoverableInr: number;
    decayLossInr: number;
  }>;
}

export interface RevenueDefenseAction {
  id: string;
  rank: number;
  actionTitle: string;
  category: 'PAUSE_RETRY' | 'REROUTE_CHANNEL' | 'PRIORITIZE_LTV' | 'INVESTIGATE';
  protectedRevenueInr: string;
  confidencePercent: number;
  urgency: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  actionSummary: string;
  whyRationale: string;
  expectedNetValueInr: string;
  riskAssessment: string;
  policyCheckStatus: 'PASSED' | 'REQUIRES_APPROVAL' | 'DELAYED';
  evidenceChainId: string;
}

export interface HighLtvProtectedCustomer {
  customerId: string;
  customerName: string;
  ltvInr: string;
  amountAtRiskInr: string;
  recoveryProbabilityPercent: number;
  recommendedAction: string;
  urgency: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  channelPreference: string;
}

export interface FailureCascadeEvent {
  time: string;
  failuresCount: number;
  cumulativeExposureInr: string;
  stageSummary: string;
}

export interface IncidentTimelineNode {
  time: string;
  title: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL' | 'SUCCESS';
  description: string;
  evidenceRef: string;
}

export interface StormRadarNetworkNode {
  id: string;
  label: string;
  type: 'GATEWAY' | 'BANK' | 'METHOD' | 'FAILURE_TYPE' | 'SEGMENT' | 'EXPOSURE';
  exposureInr: string;
  recoverableInr: string;
  affectedCount: number;
  status: 'CRITICAL' | 'WARNING' | 'NORMAL';
  latencyMs?: number;
  failureRate?: number;
  baselineRate?: number;
  spikeFactor?: number;
  description: string;
}

export interface WeatherRadarSummary {
  stormIndex: number; // 0..100
  stormSeverity: 'CRITICAL' | 'ELEVATED' | 'MODERATE' | 'NORMAL';
  stormExplanation: string;
  overallSystemHealth: 'STABLE' | 'WEATHER_ALERT' | 'CRITICAL';
  systemicFailureSharePercent: number;
  customerSpecificSharePercent: number;
  activeLeaksCount: number;
  totalRevenueAtRiskPaise: number;
  totalRecoverableAtRiskPaise: number;
  totalRevenueDefendedPaise: number; // Revenue loss avoided
  unnecessaryRetriesPrevented: number;
  savedRetryCostsPaise: number;
  suppressedRetriesTotal: number;
  currentFailureVelocity: number; // failures/min
  baselineFailureVelocity: number;
  velocityAcceleration: number; // x multiplier
  velocityHistory: Array<{ timeOffset: string; velocity: number }>;
  earlyWarning: {
    isTriggered: boolean;
    estimatedWindowMins: string;
    latencyDeviationPercent: number;
    concentrationIncreasePercent: number;
    confidencePercent: number;
    projectedExposureInr: string;
    preparationGuidance: string;
  };
  blastRadius: {
    gatewaysAffected: number;
    paymentMethodsAffected: number;
    transactionsAffected: number;
    customersAffected: number;
    grossExposureInr: string;
    recoverableInr: string;
    netExpectedInr: string;
  };
  autonomyState: 'OBSERVE' | 'PREDICT' | 'RECOMMEND' | 'POLICY_CHECK' | 'READY_FOR_AUTONOMOUS_DEFENSE';
  bankNodes: BankGatewayNode[];
  activeLeaks: RevenueLeakAlert[];
  defenseActions: RevenueDefenseAction[];
  highLtvCustomers: HighLtvProtectedCustomer[];
  cascadeProgression: FailureCascadeEvent[];
  incidentTimeline: IncidentTimelineNode[];
  networkNodes: StormRadarNetworkNode[];
}

export class WeatherRadarService {
  static getTelemetry(): WeatherRadarSummary {
    const bankNodes: BankGatewayNode[] = [
      {
        name: 'HDFC Bank Gateway',
        code: 'HDFC_PG',
        status: 'ELEVATED_TIMEOUTS',
        latencyMs: 340,
        failureRatePercent: 11.8,
        baselineRatePercent: 3.2,
        spikeFactor: 3.69,
        volume24hPaise: 342000000,
        affectedTransactionsCount: 127,
        primaryChannel: 'Credit & Debit Cards',
        recommendedStrategy: 'Apply 10m retry debounce; redirect eligible checkouts to UPI.',
        failureVelocityCurrent: 18.4,
        failureVelocityBaseline: 5.1,
        accelerationFactor: 3.61,
        revenueExposedPaise: 84000000, // ₹8.40L
        recoverablePaise: 69000000, // ₹6.90L
      },
      {
        name: 'State Bank of India (SBI)',
        code: 'SBI_UPI',
        status: 'OPERATIONAL',
        latencyMs: 48,
        failureRatePercent: 2.1,
        baselineRatePercent: 2.4,
        spikeFactor: 0.88,
        volume24hPaise: 284000000,
        affectedTransactionsCount: 14,
        primaryChannel: 'UPI & Netbanking',
        recommendedStrategy: 'Standard autonomous execution; high confidence.',
        failureVelocityCurrent: 2.3,
        failureVelocityBaseline: 2.6,
        accelerationFactor: 0.88,
        revenueExposedPaise: 11200000,
        recoverablePaise: 9800000,
      },
      {
        name: 'ICICI Bank Gateway',
        code: 'ICICI_PG',
        status: 'OPERATIONAL',
        latencyMs: 38,
        failureRatePercent: 1.9,
        baselineRatePercent: 2.0,
        spikeFactor: 0.95,
        volume24hPaise: 198000000,
        affectedTransactionsCount: 8,
        primaryChannel: 'Credit Card & UPI AutoPay',
        recommendedStrategy: 'Instant background retry permitted.',
        failureVelocityCurrent: 1.1,
        failureVelocityBaseline: 1.2,
        accelerationFactor: 0.92,
        revenueExposedPaise: 6800000,
        recoverablePaise: 6200000,
      },
      {
        name: 'Axis Bank PG Node',
        code: 'AXIS_PG',
        status: 'DEGRADED',
        latencyMs: 520,
        failureRatePercent: 14.5,
        baselineRatePercent: 4.1,
        spikeFactor: 3.54,
        volume24hPaise: 86000000,
        affectedTransactionsCount: 42,
        primaryChannel: 'Corporate Netbanking',
        recommendedStrategy: 'Temporarily switch failed Netbanking to WhatsApp Payment Link.',
        failureVelocityCurrent: 7.2,
        failureVelocityBaseline: 2.0,
        accelerationFactor: 3.60,
        revenueExposedPaise: 38500000,
        recoverablePaise: 31000000,
      },
      {
        name: 'Kotak Mahindra Bank',
        code: 'KOTAK_PG',
        status: 'OPERATIONAL',
        latencyMs: 42,
        failureRatePercent: 2.5,
        baselineRatePercent: 2.8,
        spikeFactor: 0.89,
        volume24hPaise: 74000000,
        affectedTransactionsCount: 5,
        primaryChannel: 'Cards & UPI',
        recommendedStrategy: 'Normal recovery operations.',
        failureVelocityCurrent: 0.9,
        failureVelocityBaseline: 1.0,
        accelerationFactor: 0.90,
        revenueExposedPaise: 4200000,
        recoverablePaise: 3800000,
      },
    ];

    const activeLeaks: RevenueLeakAlert[] = [
      {
        id: 'LEAK_01',
        title: 'HDFC Card 3DS / Gateway Authorization Timeout Spike',
        severity: 'CRITICAL',
        category: 'GATEWAY_DEGRADATION',
        amountAtRiskPaise: 84000000, // ₹8.40 Lakh
        estimatedRecoverablePaise: 69000000, // ₹6.90 Lakh
        affectedCount: 127,
        baselineFailurePercent: 3.2,
        currentFailurePercent: 11.8,
        detectedTime: '18 mins ago (Active)',
        rootCauseDiagnosis: 'HDFC core banking authorization server timeout (>5,000ms response time). Blasting immediate retries causes 85% duplicate failure.',
        recommendedIntervention: 'Enable 10-minute temporal wait before retry; route alternative payments to WhatsApp Link.',
        status: 'ACTIVE',
        suppressedRetriesCount: 117,
        revenuePreservedPaise: 78400000, // ₹7.84 Lakh
        decayTimeline: [
          { timeLabel: 'NOW', projectedRecoverableInr: 840000, decayLossInr: 0 },
          { timeLabel: '+30 MIN', projectedRecoverableInr: 781000, decayLossInr: 59000 },
          { timeLabel: '+1 HR', projectedRecoverableInr: 692000, decayLossInr: 148000 },
          { timeLabel: '+3 HR', projectedRecoverableInr: 547000, decayLossInr: 293000 },
          { timeLabel: '+6 HR', projectedRecoverableInr: 391000, decayLossInr: 449000 },
          { timeLabel: '+24 HR', projectedRecoverableInr: 184000, decayLossInr: 656000 },
        ],
      },
      {
        id: 'LEAK_02',
        title: 'Corporate Netbanking Dropout on Large B2B Invoices',
        severity: 'HIGH',
        category: 'CHANNEL_DROPOUT',
        amountAtRiskPaise: 38500000, // ₹3.85 Lakh
        estimatedRecoverablePaise: 31000000, // ₹3.10 Lakh
        affectedCount: 22,
        baselineFailurePercent: 4.1,
        currentFailurePercent: 14.5,
        detectedTime: '42 mins ago (Active)',
        rootCauseDiagnosis: 'Axis / PSU Bank corporate token authentication dropouts during afternoon settlement window.',
        recommendedIntervention: 'Trigger Smart Virtual Account NEFT / RTGS fallback payment link with automated reconciliation.',
        status: 'ACTIVE',
        suppressedRetriesCount: 18,
        revenuePreservedPaise: 29500000,
        decayTimeline: [
          { timeLabel: 'NOW', projectedRecoverableInr: 385000, decayLossInr: 0 },
          { timeLabel: '+30 MIN', projectedRecoverableInr: 340000, decayLossInr: 45000 },
          { timeLabel: '+1 HR', projectedRecoverableInr: 290000, decayLossInr: 95000 },
          { timeLabel: '+3 HR', projectedRecoverableInr: 210000, decayLossInr: 175000 },
          { timeLabel: '+6 HR', projectedRecoverableInr: 140000, decayLossInr: 245000 },
          { timeLabel: '+24 HR', projectedRecoverableInr: 60000, decayLossInr: 325000 },
        ],
      },
      {
        id: 'LEAK_03',
        title: 'High-LTV Customer Subscription Mandate Failures',
        severity: 'MEDIUM',
        category: 'HIGH_LTV_CHURN_RISK',
        amountAtRiskPaise: 24000000, // ₹2.40 Lakh
        estimatedRecoverablePaise: 21500000, // ₹2.15 Lakh
        affectedCount: 16,
        baselineFailurePercent: 1.5,
        currentFailurePercent: 6.8,
        detectedTime: '1 hour ago',
        rootCauseDiagnosis: 'Card expiry & bank UPI autopay limit reached for enterprise recurring billing tiers.',
        recommendedIntervention: 'Dispatch personalized WhatsApp interactive card-update link before subscription expiry.',
        status: 'MONITORING',
        suppressedRetriesCount: 12,
        revenuePreservedPaise: 18500000,
        decayTimeline: [
          { timeLabel: 'NOW', projectedRecoverableInr: 240000, decayLossInr: 0 },
          { timeLabel: '+30 MIN', projectedRecoverableInr: 225000, decayLossInr: 15000 },
          { timeLabel: '+1 HR', projectedRecoverableInr: 200000, decayLossInr: 40000 },
          { timeLabel: '+3 HR', projectedRecoverableInr: 160000, decayLossInr: 80000 },
          { timeLabel: '+6 HR', projectedRecoverableInr: 110000, decayLossInr: 130000 },
          { timeLabel: '+24 HR', projectedRecoverableInr: 45000, decayLossInr: 195000 },
        ],
      },
    ];

    const defenseActions: RevenueDefenseAction[] = [
      {
        id: 'ACT_01',
        rank: 1,
        actionTitle: 'Pause & Debounce HDFC Card Retries (10 Minutes)',
        category: 'PAUSE_RETRY',
        protectedRevenueInr: '₹2.84 Lakh',
        confidencePercent: 94,
        urgency: 'CRITICAL',
        actionSummary: 'Temporarily suppress immediate retries for 127 HDFC card transactions to prevent duplicate gateway burn.',
        whyRationale: 'HDFC gateway latency spiked to 340ms (+369% error rate). Immediate retries yield 85% duplicate failure. Waiting 10m increases conversion from 62% to 93%.',
        expectedNetValueInr: '₹2,68,500.00',
        riskAssessment: 'Very Low (2/100) — Protects retry limits and prevents card issuing bank throttling.',
        policyCheckStatus: 'PASSED',
        evidenceChainId: 'chain_storm_hdfc',
      },
      {
        id: 'ACT_02',
        rank: 2,
        actionTitle: 'Reroute Eligible Degraded Checkouts to UPI Payment Links',
        category: 'REROUTE_CHANNEL',
        protectedRevenueInr: '₹1.17 Lakh',
        confidencePercent: 91,
        urgency: 'HIGH',
        actionSummary: 'Dispatch Razorpay WhatsApp payment links with pre-filled UPI handle for active dropouts.',
        whyRationale: 'UPI clearing rails (SBI/ICICI) are operating normally (48ms latency). Rerouting bypasses congested card authorization queue.',
        expectedNetValueInr: '₹1,09,200.00',
        riskAssessment: 'Low (4/100) — Verified merchant WhatsApp business channel with 78% conversion.',
        policyCheckStatus: 'PASSED',
        evidenceChainId: 'chain_storm_reroute',
      },
      {
        id: 'ACT_03',
        rank: 3,
        actionTitle: 'Prioritize High-LTV Enterprise Accounts Revenue Shield',
        category: 'PRIORITIZE_LTV',
        protectedRevenueInr: '₹74,000.00',
        confidencePercent: 87,
        urgency: 'HIGH',
        actionSummary: 'Fast-track high-LTV customer accounts (LTV > ₹50,000) with dedicated concierge retry sequence.',
        whyRationale: 'TechLearn Pro (₹84k LTV) and Aarav Enterprise (₹1.25L LTV) represent 48% of total exposed margin.',
        expectedNetValueInr: '₹71,400.00',
        riskAssessment: 'Low (5/100) — Account executive notification dispatched with audit digest.',
        policyCheckStatus: 'PASSED',
        evidenceChainId: 'chain_storm_high_ltv',
      },
      {
        id: 'ACT_04',
        rank: 4,
        actionTitle: 'Open Affected Corporate Netbanking Transaction Set for Audit',
        category: 'INVESTIGATE',
        protectedRevenueInr: '₹42,000.00',
        confidencePercent: 79,
        urgency: 'MEDIUM',
        actionSummary: 'Inspect 22 Axis B2B corporate transactions and reconcile virtual account ledger lines.',
        whyRationale: 'Reconciles incomplete gateway auth callbacks against bank NEFT clearing logs.',
        expectedNetValueInr: '₹38,000.00',
        riskAssessment: 'Negligible (1/100) — Read-only cryptographic inspection.',
        policyCheckStatus: 'PASSED',
        evidenceChainId: 'chain_storm_investigate',
      },
    ];

    const highLtvCustomers: HighLtvProtectedCustomer[] = [
      {
        customerId: 'cust_201',
        customerName: 'Aarav Enterprise Solutions',
        ltvInr: '₹1,25,000.00',
        amountAtRiskInr: '₹18,500.00',
        recoveryProbabilityPercent: 94,
        recommendedAction: 'Concierge Card Dynamic Retry (+10m)',
        urgency: 'CRITICAL',
        channelPreference: 'Credit Card (Corporate)',
      },
      {
        customerId: 'cust_88',
        customerName: 'TechLearn Pro Pvt Ltd',
        ltvInr: '₹84,000.00',
        amountAtRiskInr: '₹14,500.00',
        recoveryProbabilityPercent: 93,
        recommendedAction: 'Debounced Card Dynamic Retry (+10m)',
        urgency: 'CRITICAL',
        channelPreference: 'Credit Card (88.9% success)',
      },
      {
        customerId: 'cust_44',
        customerName: 'Zenith Logistics LLP',
        ltvInr: '₹38,500.00',
        amountAtRiskInr: '₹9,500.00',
        recoveryProbabilityPercent: 88,
        recommendedAction: 'Razorpay WhatsApp Interactive Link',
        urgency: 'HIGH',
        channelPreference: 'WhatsApp Link (100% conversion)',
      },
      {
        customerId: 'cust_19',
        customerName: 'Kavita Sharma',
        ltvInr: '₹14,200.00',
        amountAtRiskInr: '₹4,500.00',
        recoveryProbabilityPercent: 84,
        recommendedAction: 'SMS Smart Payment Link',
        urgency: 'MEDIUM',
        channelPreference: 'Debit Card & UPI',
      },
    ];

    const cascadeProgression: FailureCascadeEvent[] = [
      { time: '09:31 IST', failuresCount: 7, cumulativeExposureInr: '₹58,000.00', stageSummary: 'First transient timeout anomaly detected on HDFC PG Node.' },
      { time: '09:34 IST', failuresCount: 19, cumulativeExposureInr: '₹1,42,000.00', stageSummary: 'Failure velocity crossed 12.0/min threshold. Latency increased to 180ms.' },
      { time: '09:37 IST', failuresCount: 48, cumulativeExposureInr: '₹3,60,000.00', stageSummary: 'HDFC authorization error spike (+280%). Secondary card failures propagating.' },
      { time: '09:40 IST', failuresCount: 103, cumulativeExposureInr: '₹6,90,000.00', stageSummary: 'FinanceOS classified systemic failure. Automatic retry suppression triggered.' },
      { time: '09:42 IST', failuresCount: 127, cumulativeExposureInr: '₹8,40,000.00', stageSummary: 'Cascade contained. 117 duplicate retries prevented. Defense plan active.' },
    ];

    const incidentTimeline: IncidentTimelineNode[] = [
      { time: '09:31 IST', title: 'First Anomaly Detected', severity: 'INFO', description: 'HDFC gateway response time elevated to 140ms.', evidenceRef: 'ev_0931' },
      { time: '09:34 IST', title: 'Failure Velocity Crossed Threshold', severity: 'WARNING', description: 'Velocity rose to 18.4 failures/min (3.6x baseline).', evidenceRef: 'ev_0934' },
      { time: '09:37 IST', title: 'Gateway Health Classified Degraded', severity: 'CRITICAL', description: 'Failure rate reached 11.8% vs 3.2% baseline.', evidenceRef: 'ev_0937' },
      { time: '09:39 IST', title: 'Revenue Exposure Crossed ₹5.0L', severity: 'CRITICAL', description: 'Exposure reached ₹8.40L across 127 payments.', evidenceRef: 'ev_0939' },
      { time: '09:40 IST', title: 'Systemic Failure Classified', severity: 'WARNING', description: 'Separated from customer-specific errors; initiated defense protocol.', evidenceRef: 'ev_0940' },
      { time: '09:41 IST', title: 'Automatic Retry Suppression Activated', severity: 'SUCCESS', description: '117 retries placed into 10-minute optimal cooldown.', evidenceRef: 'ev_0941' },
      { time: '09:42 IST', title: 'Alternative Routing Recommended', severity: 'SUCCESS', description: 'Eligible payments prepared for WhatsApp/UPI dispatch.', evidenceRef: 'ev_0942' },
      { time: '09:43 IST', title: 'Revenue Defense Plan Generated', severity: 'SUCCESS', description: 'Expected Net Recovery optimized to ₹6.90L.', evidenceRef: 'ev_0943' },
    ];

    const networkNodes: StormRadarNetworkNode[] = [
      { id: 'node_hdfc', label: 'HDFC Gateway', type: 'GATEWAY', exposureInr: '₹8.40L', recoverableInr: '₹6.90L', affectedCount: 127, status: 'CRITICAL', latencyMs: 340, failureRate: 11.8, baselineRate: 3.2, spikeFactor: 3.69, description: 'Core clearing PG node experiencing 3DS timeouts.' },
      { id: 'node_axis', label: 'Axis PG Node', type: 'GATEWAY', exposureInr: '₹3.85L', recoverableInr: '₹3.10L', affectedCount: 42, status: 'WARNING', latencyMs: 520, failureRate: 14.5, baselineRate: 4.1, spikeFactor: 3.54, description: 'Corporate token authorization timeout.' },
      { id: 'node_sbi', label: 'SBI UPI Rail', type: 'GATEWAY', exposureInr: '₹1.12L', recoverableInr: '₹0.98L', affectedCount: 14, status: 'NORMAL', latencyMs: 48, failureRate: 2.1, baselineRate: 2.4, spikeFactor: 0.88, description: 'Normal operational health; stable fallback route.' },
      { id: 'node_card', label: 'Credit/Debit Cards', type: 'METHOD', exposureInr: '₹8.40L', recoverableInr: '₹6.90L', affectedCount: 127, status: 'CRITICAL', description: 'Card processing congested by gateway timeouts.' },
      { id: 'node_netbanking', label: 'Netbanking B2B', type: 'METHOD', exposureInr: '₹3.85L', recoverableInr: '₹3.10L', affectedCount: 42, status: 'WARNING', description: 'PSU token timeouts during settlement.' },
      { id: 'node_3ds', label: '3DS Server Timeout', type: 'FAILURE_TYPE', exposureInr: '₹8.40L', recoverableInr: '₹6.90L', affectedCount: 127, status: 'CRITICAL', description: 'Issuing bank OTP / 3DS redirect failure.' },
      { id: 'node_enterprise', label: 'Mid-Market & Enterprise', type: 'SEGMENT', exposureInr: '₹6.80L', recoverableInr: '₹5.90L', affectedCount: 78, status: 'CRITICAL', description: 'High-LTV accounts (LTV > ₹50k).' },
      { id: 'node_smb', label: 'SMB & Retail Customers', type: 'SEGMENT', exposureInr: '₹5.45L', recoverableInr: '₹4.30L', affectedCount: 91, status: 'WARNING', description: 'Standard checkout transactions.' },
    ];

    const velocityHistory = [
      { timeOffset: '-60m', velocity: 4.8 },
      { timeOffset: '-50m', velocity: 5.2 },
      { timeOffset: '-40m', velocity: 5.0 },
      { timeOffset: '-30m', velocity: 7.4 },
      { timeOffset: '-20m', velocity: 12.8 },
      { timeOffset: '-10m', velocity: 16.5 },
      { timeOffset: 'Now', velocity: 18.4 },
    ];

    return {
      stormIndex: 82,
      stormSeverity: 'CRITICAL',
      stormExplanation: 'Storm severity reached 82/100 because failure velocity is 3.61x baseline (18.4/min) with ₹8.40L currently exposed across HDFC card authorization clearing routes.',
      overallSystemHealth: 'WEATHER_ALERT',
      systemicFailureSharePercent: 42,
      customerSpecificSharePercent: 58,
      activeLeaksCount: activeLeaks.length,
      totalRevenueAtRiskPaise: 146500000, // ₹14.65 Lakh
      totalRecoverableAtRiskPaise: 121500000, // ₹12.15 Lakh
      totalRevenueDefendedPaise: 78400000, // ₹7.84 Lakh Revenue Defended
      unnecessaryRetriesPrevented: 342,
      savedRetryCostsPaise: 1436400,
      suppressedRetriesTotal: 147,
      currentFailureVelocity: 18.4,
      baselineFailureVelocity: 5.1,
      velocityAcceleration: 3.61,
      velocityHistory,
      earlyWarning: {
        isTriggered: true,
        estimatedWindowMins: '11–18 mins',
        latencyDeviationPercent: 48,
        concentrationIncreasePercent: 31,
        confidencePercent: 81,
        projectedExposureInr: '₹4.20 Lakh',
        preparationGuidance: 'Pre-stage alternative UPI and WhatsApp Payment Link routing routes before peak settlement cutoff.',
      },
      blastRadius: {
        gatewaysAffected: 2,
        paymentMethodsAffected: 2,
        transactionsAffected: 169,
        customersAffected: 127,
        grossExposureInr: '₹14.65 Lakh',
        recoverableInr: '₹12.15 Lakh',
        netExpectedInr: '₹11.42 Lakh',
      },
      autonomyState: 'READY_FOR_AUTONOMOUS_DEFENSE',
      bankNodes,
      activeLeaks,
      defenseActions,
      highLtvCustomers,
      cascadeProgression,
      incidentTimeline,
      networkNodes,
    };
  }
}
