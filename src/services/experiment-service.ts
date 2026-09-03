export interface StrategyMetrics {
  strategyId: string;
  name: string;
  description: string;
  recoveryRatePercent: number;
  grossRecoveredPaise: number;
  netRecoveredPaise: number;
  averageAttemptsPerRecovery: number;
  customerFrictionScore: 'Low' | 'Medium' | 'High';
  averageTimeMinutes: number;
  unnecessaryRetryBurnCount: number;
  upliftVsBaselinePercent: number;
  netDollarUpliftPaise: number;
}

export class ExperimentService {
  static getStrategiesComparison(): StrategyMetrics[] {
    return [
      {
        strategyId: 'STRAT_B_ADAPTIVE',
        name: 'FinanceOS Digital Twin Adaptive Recovery (Recommended)',
        description: 'Simulates 7 futures, optimizes Net Expected Value, incorporates Weather Map delay debounce & customer memory.',
        recoveryRatePercent: 86.8,
        grossRecoveredPaise: 371500000, // ₹37.15L
        netRecoveredPaise: 362400000, // ₹36.24L
        averageAttemptsPerRecovery: 1.18,
        customerFrictionScore: 'Low',
        averageTimeMinutes: 8.4,
        unnecessaryRetryBurnCount: 14,
        upliftVsBaselinePercent: 25.7,
        netDollarUpliftPaise: 74100000, // +₹7.41L Net Gain
      },
      {
        strategyId: 'STRAT_C_CHANNEL_SWITCH',
        name: 'Multi-Channel Sequential Cascade',
        description: 'Sequentially cascades across Card -> UPI -> WhatsApp link without temporal debounce or EV optimization.',
        recoveryRatePercent: 78.2,
        grossRecoveredPaise: 334200000, // ₹33.42L
        netRecoveredPaise: 316500000, // ₹31.65L
        averageAttemptsPerRecovery: 2.34,
        customerFrictionScore: 'Medium',
        averageTimeMinutes: 24.5,
        unnecessaryRetryBurnCount: 168,
        upliftVsBaselinePercent: 9.8,
        netDollarUpliftPaise: 28200000, // +₹2.82L
      },
      {
        strategyId: 'STRAT_A_BASELINE',
        name: 'Immediate Blind Retry (Industry Standard Baseline)',
        description: 'Standard cron/webhook loop retrying the same channel immediately upon failure.',
        recoveryRatePercent: 71.4,
        grossRecoveredPaise: 305400000, // ₹30.54L
        netRecoveredPaise: 288300000, // ₹28.83L
        averageAttemptsPerRecovery: 2.85,
        customerFrictionScore: 'High',
        averageTimeMinutes: 4.2,
        unnecessaryRetryBurnCount: 356,
        upliftVsBaselinePercent: 0,
        netDollarUpliftPaise: 0,
      },
    ];
  }
}
