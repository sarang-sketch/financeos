export interface CustomerRecoveryBehavior {
  customerId: string;
  customerName: string;
  cardTimeoutRecoveryRate: { success: number; attempts: number; percent: number };
  paymentLinkConversionRate: { success: number; attempts: number; percent: number };
  upiCollectSuccessRate: { success: number; attempts: number; percent: number };
  whatsAppInteractiveRate: { success: number; attempts: number; percent: number };
  preferredRecoveryIntervention: string;
  totalRevenueRecoveredPaise: number;
  lastUpdated: string;
}

export interface CascadeStep {
  stepNumber: number;
  phase: 'DETECTION' | 'DIAGNOSIS' | 'INTERVENTION_1' | 'OBSERVATION' | 'REEVALUATION' | 'INTERVENTION_2' | 'SETTLEMENT_RECON' | 'MEMORY_UPDATE';
  title: string;
  description: string;
  confidencePercent: number;
  expectedValuePaise: number;
  actualOutcome: 'SUCCESS' | 'WAITING' | 'RETRY_NEEDED' | 'RECOVERED';
  timestamp: string;
  sha256AuditDigest: string;
}

export interface AdaptiveRecoveryCascade {
  cascadeId: string;
  paymentId: string;
  customerName: string;
  amountPaise: number;
  status: 'COMPLETED' | 'IN_PROGRESS' | 'HALTED_POLICY';
  steps: CascadeStep[];
  netRecoveredPaise: number;
  totalTimeMinutes: number;
}

export class RecoveryMemoryService {
  private static customerMemories: CustomerRecoveryBehavior[] = [
    {
      customerId: 'cust_88',
      customerName: 'TechLearn Pro Pvt Ltd',
      cardTimeoutRecoveryRate: { success: 4, attempts: 5, percent: 80 },
      paymentLinkConversionRate: { success: 1, attempts: 4, percent: 25 },
      upiCollectSuccessRate: { success: 2, attempts: 2, percent: 100 },
      whatsAppInteractiveRate: { success: 3, attempts: 4, percent: 75 },
      preferredRecoveryIntervention: 'Card Dynamic Retry (Delayed 10m)',
      totalRevenueRecoveredPaise: 4250000, // ₹42,500.00
      lastUpdated: '12 mins ago',
    },
    {
      customerId: 'cust_92',
      customerName: 'Apex Innovations',
      cardTimeoutRecoveryRate: { success: 0, attempts: 1, percent: 0 },
      paymentLinkConversionRate: { success: 2, attempts: 3, percent: 67 },
      upiCollectSuccessRate: { success: 3, attempts: 4, percent: 75 },
      whatsAppInteractiveRate: { success: 2, attempts: 2, percent: 100 },
      preferredRecoveryIntervention: 'WhatsApp Interactive UPI Link',
      totalRevenueRecoveredPaise: 3600000,
      lastUpdated: '1 hour ago',
    },
    {
      customerId: 'cust_44',
      customerName: 'Zenith Logistics LLP',
      cardTimeoutRecoveryRate: { success: 3, attempts: 4, percent: 75 },
      paymentLinkConversionRate: { success: 2, attempts: 3, percent: 67 },
      upiCollectSuccessRate: { success: 1, attempts: 2, percent: 50 },
      whatsAppInteractiveRate: { success: 5, attempts: 5, percent: 100 },
      preferredRecoveryIntervention: 'WhatsApp Interactive Link',
      totalRevenueRecoveredPaise: 2250000,
      lastUpdated: '2 hours ago',
    },
    {
      customerId: 'cust_201',
      customerName: 'Aarav Enterprise Solutions',
      cardTimeoutRecoveryRate: { success: 8, attempts: 8, percent: 100 },
      paymentLinkConversionRate: { success: 3, attempts: 3, percent: 100 },
      upiCollectSuccessRate: { success: 1, attempts: 1, percent: 100 },
      whatsAppInteractiveRate: { success: 2, attempts: 2, percent: 100 },
      preferredRecoveryIntervention: 'Direct Gateway Card Retry',
      totalRevenueRecoveredPaise: 9500000,
      lastUpdated: '3 hours ago',
    },
  ];

  static getCustomerMemories(): CustomerRecoveryBehavior[] {
    return this.customerMemories;
  }

  static getActiveCascade(): AdaptiveRecoveryCascade {
    return {
      cascadeId: 'casc_live_901',
      paymentId: 'pay_fail_901',
      customerName: 'TechLearn Pro Pvt Ltd',
      amountPaise: 1450000, // ₹14,500.00
      status: 'COMPLETED',
      netRecoveredPaise: 1415780, // Net ₹14,157.80 after MDR + GST
      totalTimeMinutes: 11.2,
      steps: [
        {
          stepNumber: 1,
          phase: 'DETECTION',
          title: 'Payment Failure Webhook Ingested',
          description: 'Payment pay_fail_901 (₹14,500.00) failed due to bank_server_timeout on HDFC Card Route.',
          confidencePercent: 100,
          expectedValuePaise: 1450000,
          actualOutcome: 'SUCCESS',
          timestamp: '14:20:12 IST',
          sha256AuditDigest: 'e3b0c442...9821',
        },
        {
          stepNumber: 2,
          phase: 'DIAGNOSIS',
          title: 'Weather & Gateway Health Diagnostic',
          description: 'HDFC gateway latency elevated (+340% error spike). Systemic degradation detected.',
          confidencePercent: 96,
          expectedValuePaise: 1450000,
          actualOutcome: 'SUCCESS',
          timestamp: '14:20:14 IST',
          sha256AuditDigest: '849201ab...4192',
        },
        {
          stepNumber: 3,
          phase: 'INTERVENTION_1',
          title: 'Optimal Timing Delay Strategy',
          description: 'Suppressed immediate retry; scheduled 10-minute cooldown window to allow bank buffer to clear.',
          confidencePercent: 93,
          expectedValuePaise: 1348500,
          actualOutcome: 'WAITING',
          timestamp: '14:20:15 IST',
          sha256AuditDigest: '38a192fc...9812',
        },
        {
          stepNumber: 4,
          phase: 'OBSERVATION',
          title: 'Gateway Health Recovery Confirmed',
          description: 'At +10m, HDFC latency normalized from 340ms to 42ms. Error rate dropped from 11.8% to 2.4%.',
          confidencePercent: 98,
          expectedValuePaise: 1348500,
          actualOutcome: 'SUCCESS',
          timestamp: '14:30:15 IST',
          sha256AuditDigest: '710293ea...6510',
        },
        {
          stepNumber: 5,
          phase: 'INTERVENTION_2',
          title: 'Dispatched Card Dynamic Retry',
          description: 'Executed autonomous Card Dynamic Retry with zero customer friction.',
          confidencePercent: 93,
          expectedValuePaise: 1348500,
          actualOutcome: 'RECOVERED',
          timestamp: '14:30:48 IST',
          sha256AuditDigest: '559102ac...1194',
        },
        {
          stepNumber: 6,
          phase: 'SETTLEMENT_RECON',
          title: 'Double-Entry Ledger Balancing',
          description: 'Posted ₹14,500.00 gross inflow, ₹290.00 MDR (2%), ₹52.20 GST (18%), ₹14,157.80 net cash.',
          confidencePercent: 100,
          expectedValuePaise: 1415780,
          actualOutcome: 'SUCCESS',
          timestamp: '14:31:02 IST',
          sha256AuditDigest: '994821ea...0041',
        },
        {
          stepNumber: 7,
          phase: 'MEMORY_UPDATE',
          title: 'Recovery Memory Updated',
          description: 'Updated TechLearn Pro Card timeout recovery affinity to 5/6 (83.3% success). Feedback loop closed.',
          confidencePercent: 100,
          expectedValuePaise: 1415780,
          actualOutcome: 'SUCCESS',
          timestamp: '14:31:05 IST',
          sha256AuditDigest: '109284be...7731',
        },
      ],
    };
  }
}
