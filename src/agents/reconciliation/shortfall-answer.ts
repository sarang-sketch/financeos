/**
 * User-facing settlement shortfall answer (task 13.4).
 *
 * This module only composes `get_settlement_reconciliation` and
 * `get_settlement_difference_breakdown`. It performs no monetary arithmetic: the
 * positive-Difference total, row figures, and absolute remainder are forwarded
 * from those tools with their persisted Evidence_Chain references.
 *
 * Requirements 4.6, 4.7.
 */

import type { Paise } from '@/calc/calculation-service';
import type { DateOnly } from '@/ledger/posting-rules';
import type {
  DifferenceRow,
  GetSettlementDifferenceBreakdownInput,
  GetSettlementDifferenceBreakdownOutput,
} from '@/tools/get-settlement-difference-breakdown';
import { MAX_BREAKDOWN_LIMIT } from '@/tools/get-settlement-difference-breakdown';
import type {
  GetSettlementReconciliationInput,
  GetSettlementReconciliationOutput,
} from '@/tools/get-settlement-reconciliation';
import {
  resolveSettlementScope,
  type DateRange,
  type ExaminedRecordCounts,
} from '@/tools/settlement-scope';
import type { ToolResult } from '@/tools/tool';

/** A request may state both date bounds or neither. */
export interface ShortfallAnswerRequest {
  readonly from?: DateOnly | undefined;
  readonly to?: DateOnly | undefined;
}

/** A retrievable chain accompanying the monetary figure(s) beside it. */
export interface AnswerEvidenceRef {
  readonly evidence_chain_id: string;
  readonly evidence_as_of: string;
}
/** One of the at-most-50 Settlement rows required by Requirement 4.6. */
export interface ShortfallSettlementRow extends DifferenceRow {
  readonly kind: 'settlement';
}

/** The single aggregate row, always present even when its count and figure are zero. */
export interface ShortfallRemainderRow extends AnswerEvidenceRef {
  readonly kind: 'remainder';
  readonly count: number;
  /** Absolute and therefore non-netting, exactly as returned by the breakdown tool. */
  readonly total_absolute_difference_paise: Paise;
}

export type ShortfallAnswerRow = ShortfallSettlementRow | ShortfallRemainderRow;

export interface ShortfallAnswer {
  /** The inclusive Settlement date range actually passed to both tools. */
  readonly scope: DateRange;
  readonly examined: ExaminedRecordCounts;
  /** Count of Settlements whose unexplained residual is non-zero, either direction. */
  readonly unexplained_residual_nonzero_count: number;
  /**
   * Σ positive Difference. This is what did not arrive before fee/GST explanation;
   * negative Differences never reduce it.
   */
  readonly total_missing_paise: Paise;
  readonly total_missing_evidence: AnswerEvidenceRef;
  /** At most 50 Settlement rows followed by exactly one remainder row. */
  readonly rows: readonly ShortfallAnswerRow[];
}

type ToolUnsuccessful = Exclude<ToolResult<never>, { readonly ok: true }>;

export type ShortfallAnswerResult =
  | { readonly ok: true; readonly value: ShortfallAnswer }
  | ToolUnsuccessful;

export interface ShortfallAnswerDeps {
  readonly getSettlementReconciliation: (
    input: GetSettlementReconciliationInput,
  ) => Promise<ToolResult<GetSettlementReconciliationOutput>>;
  readonly getSettlementDifferenceBreakdown: (
    input: GetSettlementDifferenceBreakdownInput,
  ) => Promise<ToolResult<GetSettlementDifferenceBreakdownOutput>>;
  /** Read once to anchor Requirement 4.7's default trailing window. */
  readonly now?: () => Date;
}

export interface ShortfallAnswerService {
  answer(request?: ShortfallAnswerRequest): Promise<ShortfallAnswerResult>;
}

/** A tool violated the contract the answer relies on. */
export class ShortfallAnswerError extends Error {
  override readonly name = 'ShortfallAnswerError';
}
/**
 * Create the task 13.4 answer path.
 *
 * T1 runs first because its scope and examined counts define the answer. If either
 * tool withholds its result, no partial monetary answer is returned. T2 is always
 * called with the fixed maximum of 50; the caller cannot request a wider display.
 */
export function createShortfallAnswer(deps: ShortfallAnswerDeps): ShortfallAnswerService {
  return {
    async answer(request: ShortfallAnswerRequest = {}): Promise<ShortfallAnswerResult> {
      const runAt = (deps.now ?? (() => new Date()))();
      const scope = resolveSettlementScope({
        from: request.from,
        to: request.to,
        runAt,
      });

      const reconciliation = await deps.getSettlementReconciliation(scope);
      if (!reconciliation.ok) {
        return reconciliation;
      }
      assertSameScope(scope, reconciliation.value.scope);

      const breakdown = await deps.getSettlementDifferenceBreakdown({
        ...scope,
        limit: MAX_BREAKDOWN_LIMIT,
      });
      if (!breakdown.ok) {
        return breakdown;
      }
      if (breakdown.value.rows.length > MAX_BREAKDOWN_LIMIT) {
        throw new ShortfallAnswerError(
          `${breakdown.value.rows.length} Settlement rows escaped a limit of ${MAX_BREAKDOWN_LIMIT}`,
        );
      }

      const settlementRows: ShortfallSettlementRow[] = breakdown.value.rows.map((row) => ({
        kind: 'settlement',
        ...row,
      }));
      const remainder: ShortfallRemainderRow = {
        kind: 'remainder',
        count: breakdown.value.remainder.count,
        total_absolute_difference_paise:
          breakdown.value.remainder.total_absolute_difference_paise,
        evidence_chain_id: breakdown.evidence.evidence_chain_id,
        evidence_as_of: breakdown.evidence.as_of,
      };

      return {
        ok: true,
        value: {
          scope: reconciliation.value.scope,
          examined: reconciliation.value.examined,
          unexplained_residual_nonzero_count:
            reconciliation.value.residual_nonzero_count,
          total_missing_paise: reconciliation.value.total_shortfall_paise,
          total_missing_evidence: {
            evidence_chain_id: reconciliation.evidence.evidence_chain_id,
            evidence_as_of: reconciliation.evidence.as_of,
          },
          rows: [...settlementRows, remainder],
        },
      };
    },
  };
}

function assertSameScope(expected: DateRange, reported: DateRange): void {
  if (expected.from !== reported.from || expected.to !== reported.to) {
    throw new ShortfallAnswerError(
      `get_settlement_reconciliation reported ${reported.from}..${reported.to} after ` +
        `the answer applied ${expected.from}..${expected.to}`,
    );
  }
}
