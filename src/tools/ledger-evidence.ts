/**
 * The Evidence_Chains a trial-balance Financial_Tool composes: three steps per
 * account, and one aggregate chain per grand total (task 12.3).
 * Requirements 2.5, 12.2, 12.8.
 *
 * `./ledger-scope.ts` is the other half — the entry read seam, the grouping, the
 * citation identity and the `account_name` lookup. `SemanticLedger.trialBalance`
 * (task 8.4) owns the figures. This module owns only how those figures are grounded.
 *
 * ## Three steps per account
 *
 * | Step | Operation | Result |
 * |---|---|---|
 * | 1 | `sum` of every in-range **debit** entry's amount | `debit_total_paise` |
 * | 2 | `sum` of every in-range **credit** entry's amount | `credit_total_paise` |
 * | 3 | `subtract` of those two step results, in the order the reported closing figure takes | `closing_paise` — the chain's `figure_paise` |
 *
 * One chain per account, grounding all three of that account's monetary fields:
 * `evidence_chains` stores one figure, so the closing balance is the terminal result
 * and the two totals are intermediates at {@link ACCOUNT_DEBIT_TOTAL_STEP_INDEX} and
 * {@link ACCOUNT_CREDIT_TOTAL_STEP_INDEX}. A drill-down on either total reads a step
 * rather than a second chain — the same shape `get_settlement_reconciliation` uses for
 * its six per-row figures.
 *
 * ## The sign rule is read off the figure, not restated here
 *
 * `trialBalance` signs the closing balance per `account_kind`: `debits − credits` for
 * one set of kinds, `credits − debits` for the rest. `DEBIT_NORMAL_KINDS` is
 * deliberately **not exported** from `@/ledger/semantic-ledger`, so that property P13
 * cannot assert the rule against the implementation of the rule. This module keeps
 * that property intact: it does **not** import the rule, does not re-express it, and
 * does not read `TrialBalanceRow.kind` at all.
 *
 * Step 3's operand order is instead **inferred from the reported closing figure**. Both
 * subtractions are computed through the Calculation Service and compared against
 * `closing_balance_paise`; the order that reproduces it is the order the step states,
 * and a figure that matches neither is refused. So the chain replays to the reported
 * closing balance in exact paise (Requirement 12.8) while containing no statement about
 * which kinds are debit-normal. Where the two totals are equal both orders yield `0n`
 * and the debit-first order is stated, which replays exactly either way.
 *
 * This is the same discipline `./settlement-evidence.ts` applies to its twelve steps —
 * recompute, then check against what the caller reported, and refuse a chain that would
 * replay to something else — pointed at a rule this module is not allowed to know.
 *
 * ## The aggregate chains replay; they do not assert
 *
 * A grand total could have stated one `literal` operand per account total and summed
 * them. It does not, for the reason `totalShortfallChain` gives: a chain of literals
 * grounds nothing a drill-down can open. {@link grandTotalChain} inlines **one `sum`
 * step per account over that account's entries** and terminates in a single `sum` over
 * those step results, so replaying it reproduces the grand total from the Ledger_Entry
 * rows themselves (Requirement 12.8).
 *
 * `k + 1` steps for `k` accounts, hence the {@link MAX_GRAND_TOTAL_ACCOUNTS} ceiling:
 * `evidence_chain_steps.step_index` is `SMALLINT` and the schema states no upper CHECK
 * (`MAX_STEP_INDEX` in `@/evidence/chain-builder` is where that bound lives).
 *
 * **Each grand-total chain cites only the entries its own steps read** — the debit
 * chain cites the debit entries, the credit chain the credit entries. This diverges
 * from `totalShortfallChain`, which additionally cites every examined Settlement, and
 * the reason is that Requirement 4.7 asks that tool to report the examined scope beside
 * its figure while Requirement 2.5 asks for no such thing. Citing a record no operand
 * reads would overstate what the chain contributed to its figure.
 *
 * ## Two grand totals, two chains, and one envelope
 *
 * Task 10.1's finding 1 is still open: `ToolResult<T>`'s success variant carries a
 * **single** `EvidenceChain`. 12.1 and 12.2 each had one top-level figure and
 * nominated its chain for the envelope. This tool has **two**, and it does not widen
 * `ToolResult` either — see `./get-trial-balance.ts` for how both are named in `Out`.
 * This module's part is only that the two chains are separate: Σdebit and Σcredit are
 * equal in value (Requirement 2.5) but they are different derivations over disjoint
 * operand sets, and one chain cannot honestly present both. That the two arrive at the
 * same number from different entries is the whole content of a trial balance.
 *
 * ## Money
 *
 * Every intermediate goes through the Calculation Service (`sum`, `subtract`), which
 * range-checks each operand and each running total, so a range whose partial sum leaves
 * the paise domain raises rather than flowing onward (Requirement 15.1, 15.8). There is
 * no division, no rate and no rounding anywhere in this path, and every recomputed
 * value is checked against the figure `trialBalance` reported before anything is
 * written.
 */

import { type Paise, subtract, sum } from '@/calc/calculation-service';
import {
  type EvidenceChainInput,
  type EvidenceOperand,
  type EvidenceSourceCitation,
  type EvidenceStep,
  MAX_STEP_INDEX,
} from '@/evidence/chain-builder';
import type { TrialBalanceRow } from '@/ledger/semantic-ledger';
import type { SourceRef } from '@/ledger/posting-rules';

import type { AccountEntries, EntrySide, ScopedLedgerEntry } from './ledger-scope';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** Thrown when a chain cannot be composed as stated, before anything is written. */
export class LedgerEvidenceError extends Error {
  override readonly name = 'LedgerEvidenceError';
}

/* -------------------------------------------------------------------------- */
/* The step layout                                                            */
/* -------------------------------------------------------------------------- */

/** The step whose `result_paise` is the account's total debit (Requirement 2.5). */
export const ACCOUNT_DEBIT_TOTAL_STEP_INDEX = 1;

/** The step whose `result_paise` is the account's total credit (Requirement 2.5). */
export const ACCOUNT_CREDIT_TOTAL_STEP_INDEX = 2;

/** The terminal step, whose `result_paise` is the closing balance and the figure. */
export const ACCOUNT_CLOSING_STEP_INDEX = 3;

/** Three, per account. */
export const ACCOUNT_CHAIN_STEP_COUNT = 3;

/**
 * How many accounts one grand-total chain can carry: `k + 1 <= MAX_STEP_INDEX`, one
 * `sum` step per account plus the terminal `sum`.
 *
 * The default chart of accounts holds 5 accounts, so this is not a bound the system
 * can reach today. It is stated because the ceiling is a property of the schema rather
 * than of the chart: a Tenant-defined chart could grow, and a figure whose evidence had
 * been silently truncated at 32767 steps would be worse than a refusal.
 */
export const MAX_GRAND_TOTAL_ACCOUNTS = MAX_STEP_INDEX - 1;

/**
 * The `source_record_type` a Ledger_Entry is cited under.
 *
 * `ledger_entry_set`, because the enum has no `ledger_entry` label — see the module doc
 * comment of `./ledger-scope.ts` for the finding and for why the set plus a line
 * qualifier is exact.
 */
const LEDGER_ENTRY_SET: SourceRef['type'] = 'ledger_entry_set';

/**
 * The `evidence_chain_sources.field` one Ledger_Entry is cited under:
 * `line_<line_no>.amount_paise`.
 *
 * `(set_id, line_no)` is `UNIQUE` in `ledger_entries`, so the pair
 * `({ type: 'ledger_entry_set', id: set_id }, field)` is one entry and never two. A
 * replay resolves it to a single `amount_paise` in a single row.
 */
export function entrySetFieldFor(entry: ScopedLedgerEntry): string {
  return `line_${String(entry.line_no)}.amount_paise`;
}

/* -------------------------------------------------------------------------- */
/* Operand and citation helpers                                               */
/* -------------------------------------------------------------------------- */

const setRef = (setId: string): SourceRef => ({ type: LEDGER_ENTRY_SET, id: setId });

const sourceOperand = (ref: SourceRef, field: string): EvidenceOperand => ({
  kind: 'source',
  ref,
  field,
});

const stepOperand = (index: number): EvidenceOperand => ({ kind: 'step', index });

/**
 * The zero a side with no entry in range sums. A **string**, because `operands` is
 * `JSONB` and a JSON numeric literal parses back through an IEEE-754 double.
 *
 * An account debited in the range and never credited in it is ordinary — `revenue` is
 * credited by a Payment and debited only by a Refund — and `composeEvidenceChain`
 * rejects a step with no operands, so the step states the literal and says exactly what
 * it read: nothing.
 */
const ZERO_LITERAL: EvidenceOperand = { kind: 'literal', value: '0' };

function citation(entry: ScopedLedgerEntry): EvidenceSourceCitation {
  return {
    ref: setRef(entry.set_id),
    field: entrySetFieldFor(entry),
    record_updated_at: entry.record_updated_at,
  };
}

/* -------------------------------------------------------------------------- */
/* One side of one account                                                    */
/* -------------------------------------------------------------------------- */

/** One `sum` step over one side of one account, with what it read and produced. */
export interface SideTotalStep {
  readonly step: EvidenceStep;
  readonly citations: readonly EvidenceSourceCitation[];
  readonly result_paise: Paise;
}

/**
 * The `sum` step over one account's in-range entries on one side.
 *
 * @param index the absolute 1-based step index, so the block can be inlined into a
 * longer chain.
 * @throws {PaiseRangeError} when a running total leaves the paise range.
 */
export function sideTotalStep(
  account: AccountEntries,
  side: EntrySide,
  index: number,
): SideTotalStep {
  if (!Number.isSafeInteger(index) || index < 1) {
    throw new LedgerEvidenceError(`index must be a 1-based ordinal, got ${String(index)}`);
  }
  const entries = side === 'debit' ? account.debits : account.credits;
  const total = sum(entries.map((entry) => entry.amount_paise));
  return {
    step: {
      index,
      operation: 'sum',
      operands:
        entries.length === 0
          ? [ZERO_LITERAL]
          : entries.map((entry) => sourceOperand(setRef(entry.set_id), entrySetFieldFor(entry))),
      result_paise: total,
      note:
        `Σ ${side} Ledger_Entry amounts dated in the range for account ` +
        `${account.account_code} (Requirement 2.5)` +
        (entries.length === 0 ? '; the account holds no such entry in the range' : ''),
    },
    citations: entries.map(citation),
    result_paise: total,
  };
}

/* -------------------------------------------------------------------------- */
/* One account's chain                                                        */
/* -------------------------------------------------------------------------- */

/** The three step results, so a caller can check them against the reported row. */
export interface AccountStepResults {
  readonly debit_total_paise: Paise;
  readonly credit_total_paise: Paise;
  readonly closing_paise: Paise;
}

/** Steps and citations for one account, plus what those steps produced. */
export interface AccountStepBlock {
  readonly steps: readonly EvidenceStep[];
  readonly citations: readonly EvidenceSourceCitation[];
  readonly results: AccountStepResults;
}

/**
 * The three steps for one account, checked against the row `trialBalance` reported.
 *
 * @throws {LedgerEvidenceError} when the account and the row disagree on identity, when
 * either recomputed total disagrees with the reported one, or when the reported closing
 * balance is neither `debits − credits` nor `credits − debits` over those totals.
 * @throws {PaiseRangeError} when a running total or a difference leaves the paise range.
 */
export function accountStepBlock(
  account: AccountEntries,
  reported: TrialBalanceRow,
): AccountStepBlock {
  if (account.account_code !== reported.account_code) {
    throw new LedgerEvidenceError(
      `the entries of account ${account.account_code} were paired with the trial balance row of ` +
        `${reported.account_code}`,
    );
  }
  if (account.debits.length === 0 && account.credits.length === 0) {
    // Requirement 2.5 gives a row only to an account holding at least one entry in the
    // range, and `trialBalance` refuses a row that totals zero on both sides. An
    // account here with no entry means the aggregate and the entry list disagree.
    throw new LedgerEvidenceError(
      `account ${account.account_code} holds no Ledger_Entry in the range, so it has no trial ` +
        `balance row to state steps for (Requirement 2.5)`,
    );
  }

  const debit = sideTotalStep(account, 'debit', ACCOUNT_DEBIT_TOTAL_STEP_INDEX);
  const credit = sideTotalStep(account, 'credit', ACCOUNT_CREDIT_TOTAL_STEP_INDEX);

  const stated: readonly (readonly [string, Paise, Paise])[] = [
    ['total_debit_paise', reported.total_debit_paise, debit.result_paise],
    ['total_credit_paise', reported.total_credit_paise, credit.result_paise],
  ];
  for (const [name, figure, replayed] of stated) {
    if (figure !== replayed) {
      throw new LedgerEvidenceError(
        `account ${account.account_code} reports ${name} ${String(figure)} but summing its ` +
          `in-range Ledger_Entries produces ${replayed}; the SQL aggregate and the entry list ` +
          `disagree, and a figure whose chain replays to a different value is what ` +
          `Requirement 12.8 exists to prevent, so nothing is written`,
      );
    }
  }

  /*
   * The closing operand order, read off the reported figure rather than off the account
   * kind. See the module doc comment: `DEBIT_NORMAL_KINDS` is unexported so P13 can
   * assert the rule, and this module must not restate it.
   */
  const debitFirst = subtract(debit.result_paise, credit.result_paise);
  const creditFirst = subtract(credit.result_paise, debit.result_paise);
  const closing = reported.closing_balance_paise;
  let operands: readonly EvidenceOperand[];
  if (closing === debitFirst) {
    operands = [
      stepOperand(ACCOUNT_DEBIT_TOTAL_STEP_INDEX),
      stepOperand(ACCOUNT_CREDIT_TOTAL_STEP_INDEX),
    ];
  } else if (closing === creditFirst) {
    operands = [
      stepOperand(ACCOUNT_CREDIT_TOTAL_STEP_INDEX),
      stepOperand(ACCOUNT_DEBIT_TOTAL_STEP_INDEX),
    ];
  } else {
    throw new LedgerEvidenceError(
      `account ${account.account_code} reports a closing balance of ${closing} paise, which is ` +
        `neither ${debitFirst} (debits − credits) nor ${creditFirst} (credits − debits) over its ` +
        `in-range totals of ${debit.result_paise} debit and ${credit.result_paise} credit; no ` +
        `replayable step produces it`,
    );
  }

  return {
    steps: [
      debit.step,
      credit.step,
      {
        index: ACCOUNT_CLOSING_STEP_INDEX,
        operation: 'subtract',
        operands,
        result_paise: closing,
        note:
          `closing balance of ${account.account_code} as the Semantic_Ledger signed it for this ` +
          `account (Requirement 2.5). The operand order is the one that reproduces the reported ` +
          `figure; the sign rule itself lives in the Semantic_Ledger`,
      },
    ],
    citations: [...debit.citations, ...credit.citations],
    results: {
      debit_total_paise: debit.result_paise,
      credit_total_paise: credit.result_paise,
      closing_paise: closing,
    },
  };
}

/**
 * The three-step chain for one account, with the closing balance as its figure.
 *
 * @throws {LedgerEvidenceError} for any disagreement between the entries and the
 * reported row — see {@link accountStepBlock}.
 */
export function accountChain(
  producedBy: string,
  account: AccountEntries,
  reported: TrialBalanceRow,
): EvidenceChainInput {
  const block = accountStepBlock(account, reported);
  return {
    produced_by: producedBy,
    figure_paise: block.results.closing_paise,
    steps: block.steps,
    sources: block.citations,
  };
}

/* -------------------------------------------------------------------------- */
/* The aggregate chains                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The aggregate chain behind one grand total: one `sum` step per account over that
 * account's in-range entries on `side`, then one `sum` over those step results.
 *
 * `accounts` is every account with a trial balance row, in the order the tool reports
 * them, so the chain is a function of the entry set rather than of the store's return
 * order. An account with no entry on this side contributes a `literal '0'` step, which
 * states honestly that it had none.
 *
 * @throws {LedgerEvidenceError} when the summed step results do not equal
 * `totalPaise`, when no Ledger_Entry on this side is cited at all, or when there are
 * more accounts than {@link MAX_GRAND_TOTAL_ACCOUNTS}.
 * @throws {PaiseRangeError} when a running total leaves the paise range.
 */
export function grandTotalChain(
  producedBy: string,
  side: EntrySide,
  accounts: readonly AccountEntries[],
  totalPaise: Paise,
): EvidenceChainInput {
  if (accounts.length > MAX_GRAND_TOTAL_ACCOUNTS) {
    throw new LedgerEvidenceError(
      `${accounts.length} accounts hold Ledger_Entries in the range, and one Evidence_Chain can ` +
        `carry at most ${MAX_GRAND_TOTAL_ACCOUNTS} of them (one sum step each plus the terminal ` +
        `sum, against a SMALLINT step_index). Narrow the range rather than presenting a figure ` +
        `whose evidence is truncated`,
    );
  }

  const steps: EvidenceStep[] = [];
  const citations: EvidenceSourceCitation[] = [];
  const perAccountSteps: number[] = [];
  const perAccountTotals: Paise[] = [];

  for (const account of accounts) {
    const block = sideTotalStep(account, side, steps.length + 1);
    steps.push(block.step);
    citations.push(...block.citations);
    perAccountSteps.push(block.step.index);
    perAccountTotals.push(block.result_paise);
  }

  if (citations.length === 0) {
    // `evidence_chains.source_count >= 1` is a database CHECK, so a figure citing no
    // Source_Record has no storable chain. Refused here rather than discovered as an
    // ungrounded zero downstream — the same call `totalShortfallChain` and
    // `totalAbsoluteDifferenceChain` make.
    throw new LedgerEvidenceError(
      `the requested range holds no ${side} Ledger_Entry, so a total ${side} figure would cite ` +
        `no Source_Record; evidence_chains.source_count >= 1 makes an ungrounded figure ` +
        `unstorable, and returning one anyway is exactly what Requirement 12.2 forbids`,
    );
  }

  const summed = sum(perAccountTotals);
  if (summed !== totalPaise) {
    throw new LedgerEvidenceError(
      `the grand total ${side} was reported as ${totalPaise} paise but summing the ` +
        `${accounts.length} per-account ${side} totals produces ${summed}`,
    );
  }

  steps.push({
    index: steps.length + 1,
    operation: 'sum',
    operands: perAccountSteps.map((index) => stepOperand(index)),
    result_paise: summed,
    note:
      `grand total ${side}: Σ over the ${accounts.length} account(s) holding Ledger_Entries in ` +
      `the range. Requirement 2.5 requires this to equal the grand total ` +
      `${side === 'debit' ? 'credit' : 'debit'}`,
  });

  return { produced_by: producedBy, figure_paise: summed, steps, sources: citations };
}
