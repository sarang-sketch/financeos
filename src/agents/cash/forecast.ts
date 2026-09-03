/**
 * Cash_Agent — day-by-day cash projection, runway, affordability and headroom.
 *
 * Requirements: 8.1..8.14, 3.4, 3.12
 */

import {
  add,
  applyRate,
  assertInRange,
  subtract,
  type Paise,
} from '@/calc/calculation-service';
import type { DateOnly } from '@/ledger/posting-rules';
import { assertDateOnlyValue } from '@/tools/settlement-scope';

export type DateBasis = 'settlement_cycle' | 'default_delay';

export interface CashForecastComponent {
  readonly name: string;
  readonly kind: 'inflow' | 'outflow';
  readonly amount_paise: Paise;
  readonly date_basis: DateBasis;
  readonly source_record_refs: readonly { type: string; id: string }[];
}

export interface CashForecastDay {
  readonly date: DateOnly;
  readonly opening_paise: Paise;
  readonly inflows_paise: Paise;
  readonly outflows_paise: Paise;
  readonly closing_paise: Paise;
  readonly components: readonly CashForecastComponent[];
}

export interface CashForecast {
  readonly horizon_days: number;
  readonly start_date: DateOnly;
  readonly end_date: DateOnly;
  readonly opening_cash_paise: Paise;
  readonly closing_cash_paise: Paise;
  readonly partial_history: boolean;
  readonly runway_months: number | null;
  readonly runway_basis: 'calculated' | 'non_positive_outflow' | 'exceeds_maximum' | 'not_applicable';
  readonly days: readonly CashForecastDay[];
}

export interface AffordabilityInput {
  readonly target_date: DateOnly;
  readonly obligation_paise: Paise;
  readonly forecast: CashForecast;
  readonly configured_safety_buffer_paise?: Paise;
}

export interface AffordabilityResult {
  readonly target_date: DateOnly;
  readonly closing_cash_paise: Paise;
  readonly obligation_paise: Paise;
  readonly safety_buffer_paise: Paise;
  readonly safety_buffer_basis: 'configured' | 'ten_percent_rule';
  readonly headroom_paise: Paise;
  readonly shortfall_paise: Paise;
  readonly buffer_shortfall_paise: Paise;
  readonly risk_level: 'low' | 'medium' | 'high';
  readonly affordable: boolean;
  readonly primary_cause?: string;
}

export interface ProjectedCashAction {
  readonly action_type: string;
  readonly effective_date: DateOnly;
  readonly target_identifier: string;
  readonly impact_paise: Paise;
  readonly improvement_paise: Paise;
  readonly description: string;
}

/**
 * Generate a day-by-day cash forecast.
 */
export function projectForecast(params: {
  readonly start_date: DateOnly;
  readonly horizon_days: number;
  readonly opening_cash_paise: Paise;
  readonly scheduled_inflows: readonly { date: DateOnly; amount_paise: Paise; basis: DateBasis; ref: { type: string; id: string } }[];
  readonly scheduled_outflows: readonly { date: DateOnly; amount_paise: Paise; name: string; ref: { type: string; id: string } }[];
  readonly historical_days_count?: number;
  readonly average_monthly_net_outflow_paise?: Paise;
}): CashForecast {
  if (params.horizon_days < 30 || params.horizon_days > 180) {
    throw new Error(`Forecast horizon must be between 30 and 180 days, got ${params.horizon_days}`);
  }

  assertDateOnlyValue(params.start_date, 'start_date');
  assertInRange(params.opening_cash_paise);

  const days: CashForecastDay[] = [];
  let currentClosing = params.opening_cash_paise;

  const startDateObj = new Date(`${params.start_date}T00:00:00.000Z`);

  for (let i = 0; i < params.horizon_days; i++) {
    const d = new Date(startDateObj);
    d.setUTCDate(d.getUTCDate() + i);
    const dateStr = d.toISOString().slice(0, 10) as DateOnly;

    const opening = currentClosing;

    const dayInflows = params.scheduled_inflows.filter((inf) => inf.date === dateStr);
    const dayOutflows = params.scheduled_outflows.filter((out) => out.date === dateStr);

    let totalInflow: Paise = 0n;
    const comps: CashForecastComponent[] = [];

    for (const inf of dayInflows) {
      totalInflow = add(totalInflow, inf.amount_paise);
      comps.push({
        name: 'Settlement Inflow',
        kind: 'inflow',
        amount_paise: inf.amount_paise,
        date_basis: inf.basis,
        source_record_refs: [inf.ref],
      });
    }

    let totalOutflow: Paise = 0n;
    for (const out of dayOutflows) {
      totalOutflow = add(totalOutflow, out.amount_paise);
      comps.push({
        name: out.name,
        kind: 'outflow',
        amount_paise: out.amount_paise,
        date_basis: 'default_delay',
        source_record_refs: [out.ref],
      });
    }

    const closing = subtract(add(opening, totalInflow), totalOutflow);
    assertInRange(closing);
    currentClosing = closing;

    days.push({
      date: dateStr,
      opening_paise: opening,
      inflows_paise: totalInflow,
      outflows_paise: totalOutflow,
      closing_paise: closing,
      components: comps,
    });
  }

  const partialHistory = (params.historical_days_count ?? 30) < 30;

  // Runway calculation (Req 8.10, 8.11, 3.4, 3.12)
  let runwayMonths: number | null = null;
  let runwayBasis: CashForecast['runway_basis'] = 'not_applicable';

  const monthlyOutflow = params.average_monthly_net_outflow_paise;
  if (monthlyOutflow !== undefined && monthlyOutflow !== null) {
    if (monthlyOutflow <= 0n) {
      runwayBasis = 'non_positive_outflow';
    } else if (params.opening_cash_paise < 0n) {
      runwayMonths = 0.0;
      runwayBasis = 'calculated';
    } else {
      const rawMonths = Number(params.opening_cash_paise) / Number(monthlyOutflow);
      const rounded = Math.round(rawMonths * 10) / 10;
      if (rounded > 120.0) {
        runwayMonths = null;
        runwayBasis = 'exceeds_maximum';
      } else {
        runwayMonths = rounded;
        runwayBasis = 'calculated';
      }
    }
  }

  const lastDay = days[days.length - 1];
  const endDate = lastDay ? lastDay.date : params.start_date;

  return {
    horizon_days: params.horizon_days,
    start_date: params.start_date,
    end_date: endDate,
    opening_cash_paise: params.opening_cash_paise,
    closing_cash_paise: currentClosing,
    partial_history: partialHistory,
    runway_months: runwayMonths,
    runway_basis: runwayBasis,
    days,
  };
}

/**
 * Check affordability of an obligation on a specific target date.
 */
export function checkAffordability(input: AffordabilityInput): AffordabilityResult {
  const day = input.forecast.days.find((d) => d.date === input.target_date);
  if (!day) {
    throw new Error(
      `Target date ${input.target_date} outside forecast range (${input.forecast.start_date} to ${input.forecast.end_date})`,
    );
  }

  assertInRange(input.obligation_paise);

  let safetyBuffer: Paise;
  let bufferBasis: 'configured' | 'ten_percent_rule';

  if (input.configured_safety_buffer_paise !== undefined && input.configured_safety_buffer_paise !== null) {
    safetyBuffer = input.configured_safety_buffer_paise;
    bufferBasis = 'configured';
  } else {
    // 10% of obligation rounded half up
    safetyBuffer = applyRate(input.obligation_paise, 1000n).result;
    bufferBasis = 'ten_percent_rule';
  }

  const closing = day.closing_paise;
  const totalRequired = add(input.obligation_paise, safetyBuffer);
  const headroom = subtract(closing, totalRequired);

  let riskLevel: 'low' | 'medium' | 'high';
  let affordable: boolean;
  let shortfall: Paise = 0n;
  let bufferShortfall: Paise = 0n;
  let primaryCause: string | undefined;

  if (closing >= totalRequired) {
    riskLevel = 'low';
    affordable = true;
  } else if (closing >= input.obligation_paise) {
    riskLevel = 'medium';
    affordable = true;
    bufferShortfall = subtract(totalRequired, closing);
    primaryCause = 'Safety buffer compromised';
  } else {
    riskLevel = 'high';
    affordable = false;
    shortfall = subtract(input.obligation_paise, closing);
    bufferShortfall = safetyBuffer;
    primaryCause = 'Insufficient cash balance for base obligation';
  }

  return {
    target_date: input.target_date,
    closing_cash_paise: closing,
    obligation_paise: input.obligation_paise,
    safety_buffer_paise: safetyBuffer,
    safety_buffer_basis: bufferBasis,
    headroom_paise: headroom,
    shortfall_paise: shortfall,
    buffer_shortfall_paise: bufferShortfall,
    risk_level: riskLevel,
    affordable,
    primary_cause: primaryCause,
  };
}

/**
 * Rank at most 5 recommended actions by improvement descending.
 */
export function rankCashActions(actions: readonly ProjectedCashAction[]): readonly ProjectedCashAction[] {
  return [...actions]
    .sort((a, b) => {
      if (a.improvement_paise !== b.improvement_paise) {
        return a.improvement_paise > b.improvement_paise ? -1 : 1;
      }
      if (a.effective_date !== b.effective_date) {
        return a.effective_date < b.effective_date ? -1 : 1;
      }
      if (a.action_type !== b.action_type) {
        return a.action_type.localeCompare(b.action_type);
      }
      return a.target_identifier.localeCompare(b.target_identifier);
    })
    .slice(0, 5);
}
