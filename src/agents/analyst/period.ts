/**
 * Analyst_Agent — Period-over-period financial comparison, percentage metrics, unusual transactions.
 *
 * Requirements: 10.1..10.9
 */

import { add, assertInRange, subtract, sum, type Paise } from '@/calc/calculation-service';
import type { TenantId } from '@/config/configuration-service';
import type { DateOnly } from '@/ledger/posting-rules';
import { assertDateOnlyValue, rangeLengthInDays, type DateRange } from '@/tools/settlement-scope';

export interface FinancialMetricSet {
  readonly revenue_paise: Paise;
  readonly expense_paise: Paise;
  readonly margin_paise: Paise;
  readonly cash_movement_paise: Paise;
  readonly transaction_count: number;
}

export interface MetricChange {
  readonly current_paise: Paise;
  readonly prior_paise: Paise;
  readonly change_paise: Paise;
  readonly change_percent: number | null; // Rounded half-up to 1 decimal place, or null if not applicable
  readonly status: 'growth' | 'decline' | 'flat' | 'not_applicable';
}

export interface UnusualTransaction {
  readonly payment_id: string;
  readonly transaction_date: DateOnly;
  readonly amount_paise: Paise;
  readonly median_paise: Paise;
  readonly multiple: number;
}

export interface TopContributor {
  readonly category: string;
  readonly description: string;
  readonly contribution_paise: Paise;
  readonly percentage_of_total: number;
}

export interface PeriodComparisonResult {
  readonly current_range: DateRange;
  readonly prior_range: DateRange;
  readonly current_metrics: FinancialMetricSet;
  readonly prior_metrics: FinancialMetricSet;
  readonly revenue_change: MetricChange;
  readonly expense_change: MetricChange;
  readonly margin_change: MetricChange;
  readonly cash_movement_change: MetricChange;
  readonly unusual_transactions: readonly UnusualTransaction[];
  readonly total_unusual_count: number;
  readonly top_contributors: readonly TopContributor[];
}

/**
 * Compute metric change and percentage growth according to Requirement 10.2 & 10.3.
 */
export function computeMetricChange(current: Paise, prior: Paise, priorCount: number): MetricChange {
  const diff = subtract(current, prior);

  if (prior <= 0n || priorCount === 0) {
    return {
      current_paise: current,
      prior_paise: prior,
      change_paise: diff,
      change_percent: null,
      status: 'not_applicable',
    };
  }

  const rawPercent = (Number(diff) / Number(prior)) * 100;
  const rounded = Math.round(rawPercent * 10) / 10;

  let status: MetricChange['status'] = 'flat';
  if (rounded > 0) status = 'growth';
  else if (rounded < 0) status = 'decline';

  return {
    current_paise: current,
    prior_paise: prior,
    change_paise: diff,
    change_percent: rounded,
    status,
  };
}

/**
 * Identify the immediately preceding equal-length period.
 */
export function getPrecedingPeriod(current: DateRange): DateRange {
  assertDateOnlyValue(current.from, 'current.from');
  assertDateOnlyValue(current.to, 'current.to');

  const days = rangeLengthInDays(current);
  const fromDate = new Date(`${current.from}T00:00:00.000Z`);

  const priorToDate = new Date(fromDate);
  priorToDate.setUTCDate(priorToDate.getUTCDate() - 1);

  const priorFromDate = new Date(priorToDate);
  priorFromDate.setUTCDate(priorFromDate.getUTCDate() - days + 1);

  return {
    from: priorFromDate.toISOString().slice(0, 10) as DateOnly,
    to: priorToDate.toISOString().slice(0, 10) as DateOnly,
  };
}

/**
 * Detect unusual transactions against median (Req 10.4).
 */
export function detectUnusualTransactions(
  payments: readonly { id: string; date: DateOnly; amount_paise: Paise }[],
  medianPaise: Paise,
  unusualMultiple = 3.0,
): { unusual: readonly UnusualTransaction[]; total_count: number } {
  if (medianPaise <= 0n) {
    return { unusual: [], total_count: 0 };
  }

  const thresholdPaise = BigInt(Math.round(Number(medianPaise) * unusualMultiple));

  const matching: UnusualTransaction[] = [];
  for (const p of payments) {
    if (p.amount_paise >= thresholdPaise) {
      matching.push({
        payment_id: p.id,
        transaction_date: p.date,
        amount_paise: p.amount_paise,
        median_paise: medianPaise,
        multiple: Math.round((Number(p.amount_paise) / Number(medianPaise)) * 10) / 10,
      });
    }
  }

  // Sort descending amount
  matching.sort((a, b) => (a.amount_paise > b.amount_paise ? -1 : 1));

  return {
    unusual: matching.slice(0, 20),
    total_count: matching.length,
  };
}
