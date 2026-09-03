/**
 * `get_trial_balance` — the third production Financial_Tool (task 12.3).
 * Requirements 2.5, 12.2.
 *
 * The two settlement tools answer questions about Razorpay's view of the money. This
 * one answers a question about FinanceOS's own books: **for an inclusive date range,
 * what did each account total on each side, where did it close, and do the two grand
 * totals agree**. It is the tool a Compliance or Reconciliation Agent reaches for when
 * a User asks whether the ledger balances, and it is the read behind Requirement 2.5's
 * guarantee that Σdebit equals Σcredit.
 *
 * design.md fixes the contract exactly:
 *
 *     in   { from: DateOnly; to: DateOnly }
 *     out  { accounts: Array<{ account_code: string; account_name: string;
 *                              debit_total_paise: Paise; credit_total_paise: Paise;
 *                              closing_paise: Paise }>;
 *            debit_total_paise: Paise; credit_total_paise: Paise }
 *
 * ## This file is an envelope over an algorithm it does not own
 *
 * | Concern | Where |
 * |---|---|
 * | per-account totals, the closing sign rule, the two grand totals | `@/ledger/semantic-ledger` (task 8.4) — `trialBalance`, `trialBalanceDebitTotalPaise`, `trialBalanceCreditTotalPaise` |
 * | the entry read seam, the grouping, the citation identity, `account_name` | `./ledger-scope.ts` |
 * | the three steps per account and the two aggregate chains | `./ledger-evidence.ts` |
 * | the inclusive `DateRange` and its validation | `./settlement-scope.ts` (task 12.1) |
 * | composing, validating and persisting a chain | `@/evidence/chain-builder` (task 9.1) |
 * | parse, authorize, bound, envelope check | `./tool.ts` (task 10.1) |
 *
 * **No money is computed in this file.** Every figure comes from `trialBalance` or from
 * its two exported grand-total helpers, which exist — its doc comment says so — "so
 * `get_trial_balance` (task 12.3) does not rewrite the summation". The recomputation
 * that grounds those figures happens in `./ledger-evidence.ts` and is cross-checked
 * against them before anything is written.
 *
 * ## Decision 1: two reads over the same range, cross-checked
 *
 * `trialBalance` aggregates **in SQL** and therefore names none of the rows it summed,
 * while Requirement 12.2 needs an ordered step list whose operands are those rows. So
 * this tool issues two reads: the aggregate, and the entry list behind it
 * ({@link LedgerEntryScopeStore}). It then requires them to agree exactly —
 * {@link assertReadsAgree} refuses an account present in one and absent from the other,
 * and `./ledger-evidence.ts` refuses a per-account total or closing balance the entries
 * do not reproduce.
 *
 * A disagreement is refused rather than reconciled. Two reads of one range that differ
 * mean one of them is wrong, and there is no way to tell which from inside the tool; a
 * trial balance assembled from the half that happened to be believed is worse than no
 * answer.
 *
 * ## Decision 2: five figures per account and two grand totals, seven chains
 *
 * Task 10.1's finding 1 is still open — `ToolResult<T>`'s success variant carries a
 * **single** `EvidenceChain` — and this tool does **not** widen it. 12.1 and 12.2
 * resolved the per-row half inside `Out` and nominated their one top-level figure's
 * chain for the envelope. This tool is the first with **two** top-level figures, which
 * needs one more decision:
 *
 * - **Every account row carries its own `evidence_chain_id`**, grounding all three of
 *   its monetary fields. That chain is `./ledger-evidence.ts`'s three steps, with
 *   `closing_paise` as the figure and the two totals as intermediates at
 *   {@link ACCOUNT_DEBIT_TOTAL_STEP_INDEX} and {@link ACCOUNT_CREDIT_TOTAL_STEP_INDEX}.
 * - **Each grand total names its own chain in `Out`**, through
 *   `debit_total_evidence_chain_id` / `credit_total_evidence_chain_id` and their as-of
 *   timestamps. Two separate aggregate chains, because Σdebit and Σcredit are equal in
 *   value and different in derivation: they sum disjoint operand sets, and one chain
 *   cannot present both without misstating what it summed.
 * - **The envelope chain is the debit grand total's.** One of the two has to be, since
 *   the envelope is a single chain; `debit_total_paise` is the field design.md lists
 *   first, and Requirement 2.5 makes the two figures equal, so
 *   `evidence.figure_paise` equals *both* top-level figures whichever is nominated.
 *
 * `test/contract/tool-contract.ts`'s `attributeMonetaryFields` needed **no change**: it
 * attributes each `*_paise` field to the nearest enclosing object declaring an
 * `evidence_chain_id` and falls back to the envelope, so the account rows are covered by
 * their own chains and both grand totals by the envelope. It also skips its
 * figure-equality check where the covering object holds more than one monetary field,
 * which is the case at the root here — and the equality would hold anyway, per the
 * previous paragraph.
 *
 * **Reported as a gap in the harness rather than patched**: the nearest-enclosing-object
 * rule cannot express "two sibling figures, two chains", so it credits both grand totals
 * to the envelope even though `Out` names a chain per figure. A convention it could read
 * — a `<field>_evidence_chain_id` sibling, which is exactly what this output states —
 * would close it. `test/contract/tool-contract.ts` belongs to task 10.2 and the wiring
 * to 12.7, so this is a note for whoever holds them, not an edit made here.
 *
 * ## Decision 3: a range holding no Ledger_Entry is refused
 *
 * Requirement 2.5 and `trialBalance` agree that such a range yields **zero accounts and
 * `0n` for both grand totals**, and that guarantee is the Semantic_Ledger's rather than
 * this tool's: `trialBalanceDebitTotalPaise` states it, and property P13 (task 8.7)
 * asserts it directly against `trialBalance`. It holds, it is proven, and nothing here
 * weakens it.
 *
 * What this **tool** cannot do is return that answer, and the reason is not arithmetic:
 * `evidence_chains.source_count >= 1` is a database CHECK, so a figure citing no
 * Source_Record has **no storable chain**, and Requirement 12.2 admits no figure without
 * one. `incomplete_evidence` would be a lie, because nothing was unreadable — the range
 * genuinely holds nothing.
 *
 * So an empty range surfaces as `tool_failure` with cause `execution_error`, which is
 * the same call 12.1 and 12.2 made for an empty settlement scope.
 *
 * **This is the third tool to refuse identically, so it is a finding against design.md
 * rather than a per-tool judgement call — and it is recorded here, not fixed here.**
 * "Your window contains nothing" is an ordinary question with no specified result shape,
 * and it has no honest answer under the current schema. Two fixes exist and **both are
 * shared contract changes above this task**: relaxing `source_count` to `>= 0` for a
 * genuinely empty aggregate (a migration plus `@/evidence/chain-builder`), or an
 * explicit `empty_scope` variant of `ToolResult` carrying the range and no figure
 * (`./tool.ts` plus `test/contract/tool-contract.ts`). Task 12.3 owns none of those
 * files, and a unilateral widening from one tool would leave the other two refusing.
 * Until one lands deliberately, three tools refuse the same way, which is at least
 * uniform and is what `./get-trial-balance.test.ts` asserts.
 *
 * ## Decision 4: what the output adds to design.md's shape, and what it does not
 *
 * Added: the per-row `evidence_chain_id` / `evidence_as_of` that Requirement 12.2 and
 * 12.4 need against every figure, and the two grand-total chain identifiers and as-ofs.
 * design.md's row type has no field for any of them, exactly as it had none for 12.1's
 * rows.
 *
 * Not added: no echoed range, no examined counts, no `kind` per account. Requirement 2.5
 * asks for none of them; `get_settlement_reconciliation` reports a scope and counts
 * because Requirement 4.7 asks it to. Widening this output would put a second tool in
 * the business of answering that requirement. `kind` is on `TrialBalanceRow` and is
 * deliberately *not* forwarded: the sign rule is the Semantic_Ledger's, property P13
 * asserts it there, and echoing the kind beside a signed figure invites a caller to
 * re-derive the sign itself.
 *
 * ## Counts are `number`, figures are `Paise`
 *
 * There is no count in this output at all — every field is either an identifier, a
 * timestamp, an account name or a `Paise` (`bigint`). The decimal-string encoding is the
 * transport layer's, through `toWire`, and nothing here converts.
 *
 * ## The read seams, and what is not here
 *
 * `ctx.db` is **not read**. `ledger_entries`, `ledger_entry_sets` and `evidence_chains`
 * are `ENABLE`d and `FORCE`d for row-level security with no policies until task 26.1, so
 * PostgREST matches zero rows for every role without `BYPASSRLS`; a live adapter written
 * today would answer "no entries" for every Tenant and this tool would then refuse every
 * range. All three seams — the {@link SemanticLedger}, the entry store and the
 * `EvidenceChainStore` — are injected as **factories over the `ToolContext`**, exactly as
 * 12.1 and 12.2 inject theirs, so 26.x supplies `ctx.db`-backed adapters with no change
 * to this file.
 *
 * `tenant_id` reaches every seam from `ctx.tenant_id` — the session — and is not an
 * argument at any depth (Requirement 12.7). A cross-Tenant request answers zero rows,
 * never a permission error, and then refuses for want of a grounded figure.
 *
 * ## Scope — deliberately left elsewhere
 *
 * - **Task 12.7** runs the contract harness over the Slice 1 catalogue. This module
 *   exports {@link createGetTrialBalance} and {@link catalogueEntryFor}, and
 *   `./catalogue.ts` — 12.7's module, not this one — registers it in one line. 12.7 also
 *   **adopted the sibling convention finding 4 proposes**: `attributeMonetaryFields` now
 *   grounds a `<field>_paise` in its `<field>_evidence_chain_id` sibling, so both grand
 *   total chains are resolved and each must present the figure it is named for. Nothing
 *   in this file changed for it — the convention was already this output's.
 * - **Task 13.x** owns the Agent runs that call this tool, the 120-second agent bound
 *   and any Exception a failing trial balance should raise. This tool is `read_only`: it
 *   posts nothing, creates no Exception, and the only thing it writes is the
 *   Evidence_Chain a figure cannot exist without.
 * Route postings are covered because `seller_payout_clearing` is part of the
 * default chart. A Tenant-defined account still requires a chart read seam;
 * until that exists, a range containing one refuses on the missing
 * `account_name` rather than guessing it. See `./ledger-scope.ts`.
 * - **Task 26.x** owns the RLS policies, the read-only role with no write grants, and
 *   the live store adapters.
 *
 * ## Reported, not silently patched
 *
 * 1. **A range holding no Ledger_Entry has no specified, storable result shape.** Third
 *    occurrence across the read-only catalogue, and the fix is a shared contract change
 *    (`source_count`, or a `ToolResult` variant) that no single tool task owns. Escalated
 *    for design.md rather than patched from here; see decision 3.
 * 2. **`source_record_type` has `ledger_entry_set` and no `ledger_entry`**, so the rows
 *    Requirement 2.5 sums are not directly citable. Worked around through
 *    `(set_id, line_no)`; see `./ledger-scope.ts`.
 * 3. **design.md's `account_name` presupposes a chart-of-accounts read the tool layer
 *    has no seam for.** Resolved from the seeded chart, refusing rather than guessing a
 *    display name; see `./ledger-scope.ts`.
 * 4. **`attributeMonetaryFields` could not express two sibling figures with two chains.**
 *    See decision 2. **Closed by task 12.7**, which adopted the `<field>_evidence_chain_id`
 *    convention proposed there rather than widening `ToolResult`; the harness now resolves
 *    both grand-total chains and requires each to present its own figure.
 * 5. **`DateRange` lives in a settlement-named module.** A ledger tool importing
 *    `./settlement-scope.ts` reads oddly; the type is settlement-agnostic and wants a
 *    home of its own. Not moved, because that file belongs to another task in flight.
 * 6. **design.md names the per-account closing field `closing_paise` while the ledger
 *    calls it `closing_balance_paise`.** Both names are kept, at the boundary they
 *    belong to: the tool's output uses design.md's, `TrialBalanceRow` keeps the ledger's,
 *    and {@link rowFor} is the single place they meet.
 */

import { z } from 'zod';

import type { Paise } from '@/calc/calculation-service';
import {
  createEvidenceChainBuilder,
  type EvidenceChain,
  type EvidenceChainInput,
  type EvidenceChainStore,
  incompleteEvidence,
  type IncompleteEvidence,
} from '@/evidence/chain-builder';
import {
  type SemanticLedger,
  type TrialBalance,
  trialBalanceCreditTotalPaise,
  trialBalanceDebitTotalPaise,
  type TrialBalanceRow,
} from '@/ledger/semantic-ledger';

import {
  ACCOUNT_CREDIT_TOTAL_STEP_INDEX,
  ACCOUNT_DEBIT_TOTAL_STEP_INDEX,
  accountChain,
  grandTotalChain,
} from './ledger-evidence';
import {
  type AccountEntries,
  accountEntriesInOrder,
  accountNameOf,
  type LedgerEntryScopeStore,
  unreadableIn,
} from './ledger-scope';
import { catalogued } from './registry';
import { assertDateRange } from './settlement-scope';
import {
  type ErasedFinancialTool,
  type FinancialTool,
  TOOL_TIMEOUT_MS,
  type ToolContext,
  type ToolResult,
} from './tool';

export { ACCOUNT_CREDIT_TOTAL_STEP_INDEX, ACCOUNT_DEBIT_TOTAL_STEP_INDEX };

/** design.md's catalogue name, and `evidence_chains.produced_by` for every chain here. */
export const GET_TRIAL_BALANCE = 'get_trial_balance';

/* -------------------------------------------------------------------------- */
/* Input schema                                                               */
/* -------------------------------------------------------------------------- */

/** `YYYY-MM-DD` that is also a real calendar date. `2026-02-30` is neither. */
function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const inputSchema = z
  .strictObject({
    from: z.iso.date(),
    to: z.iso.date(),
  })
  // The refinements are here rather than in `execute` so a bad range is a
  // `schema_violation` naming the argument, with no connection opened and the rejection
  // appended to the Audit_Log (Requirement 12.9). Reaching `trialBalance` with an
  // inverted range would raise a `SemanticLedgerError` instead, which surfaces as
  // `tool_failure` and tells the caller nothing about which argument was wrong.
  .refine((value) => isRealDate(value.from), {
    error: 'from must be a real calendar date',
    path: ['from'],
  })
  .refine((value) => isRealDate(value.to), {
    error: 'to must be a real calendar date',
    path: ['to'],
  })
  .refine((value) => value.from <= value.to, {
    error: 'from must be on or before to; Requirement 2.5 asks for a range that runs forward',
    path: ['from'],
  });

export type GetTrialBalanceInput = z.infer<typeof inputSchema>;

/* -------------------------------------------------------------------------- */
/* Output schema                                                              */
/* -------------------------------------------------------------------------- */

const paise = z.bigint();

/**
 * `chart_of_accounts.account_code`: lower snake case, bounded so a row cannot carry
 * free-form text. Every code in `DEFAULT_CHART_OF_ACCOUNTS` matches.
 */
const ACCOUNT_CODE_RE = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * One account of design.md's `accounts` array, plus the two fields Requirement 12.2 and
 * 12.4 need against a figure and which design.md's row type has no place for.
 *
 * No field is nullable: a row exists only for an account holding at least one
 * Ledger_Entry in the range (Requirement 2.5), and such an account has all three
 * figures. `closing_paise` is signed by the Semantic_Ledger and is **not** recomputed
 * here.
 */
export const trialBalanceAccountSchema = z.strictObject({
  account_code: z.string().regex(ACCOUNT_CODE_RE),
  /** From the chart of accounts. Never derived from the code. */
  account_name: z.string().min(1).max(120),
  debit_total_paise: paise,
  credit_total_paise: paise,
  /** The ledger's `closing_balance_paise`, under design.md's name for it. */
  closing_paise: paise,
  /** Grounds all three monetary fields of this row (Requirement 12.2). Never null. */
  evidence_chain_id: z.uuid(),
  /** The chain's as-of: the newest contributing `record_updated_at`. */
  evidence_as_of: z.iso.datetime(),
});

const outputSchema = z.strictObject({
  /** Ascending `account_code`, as `trialBalance` orders its rows. */
  accounts: z.array(trialBalanceAccountSchema),
  /** Σ of every row's debit total. Equal to {@link credit_total_paise} (Requirement 2.5). */
  debit_total_paise: paise,
  /** Σ of every row's credit total. */
  credit_total_paise: paise,
  /** The chain grounding `debit_total_paise`. Also the envelope chain — see decision 2. */
  debit_total_evidence_chain_id: z.uuid(),
  debit_total_evidence_as_of: z.iso.datetime(),
  /** The chain grounding `credit_total_paise`. A separate derivation, hence a separate chain. */
  credit_total_evidence_chain_id: z.uuid(),
  credit_total_evidence_as_of: z.iso.datetime(),
});

export type GetTrialBalanceOutput = z.infer<typeof outputSchema>;
export type TrialBalanceAccount = z.infer<typeof trialBalanceAccountSchema>;

/* -------------------------------------------------------------------------- */
/* Dependencies                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The three seams, as factories over the invocation context.
 *
 * Factories rather than instances, the same shape 12.1 and 12.2 declare: the Tenant and
 * the connection travel from `ToolContext` into each seam, which is what lets task 26.x
 * hand back `ctx.db`-backed adapters with no change here. A unit test hands back
 * in-memory ones.
 */
export interface GetTrialBalanceDeps {
  /** Requirement 2.5's algorithm. This tool computes none of it. */
  readonly ledger: (ctx: ToolContext) => SemanticLedger;
  /** The rows behind the aggregate, for Requirement 12.2's operands. */
  readonly entries: (ctx: ToolContext) => LedgerEntryScopeStore;
  readonly chains: (ctx: ToolContext) => EvidenceChainStore;
}

/* -------------------------------------------------------------------------- */
/* The tool                                                                   */
/* -------------------------------------------------------------------------- */

/** Aborted or refused mid-invocation. Becomes `tool_failure` cause `execution_error`. */
export class TrialBalanceToolError extends Error {
  override readonly name = 'TrialBalanceToolError';
}

/**
 * The two reads must cover the same accounts.
 *
 * `trialBalance` returns a row per account holding at least one in-range Ledger_Entry,
 * and the entry list groups to exactly those accounts. An account in one and not the
 * other means the aggregate and the entry read disagree about the range, which is
 * refused: see decision 1.
 *
 * @throws {TrialBalanceToolError} for any account present in one read and absent from
 * the other.
 */
export function assertReadsAgree(
  accounts: readonly AccountEntries[],
  rows: readonly TrialBalanceRow[],
): void {
  const withEntries = new Set(accounts.map((account) => account.account_code));
  const withRows = new Set(rows.map((row) => row.account_code));

  const missingRows = [...withEntries].filter((code) => !withRows.has(code)).sort();
  const missingEntries = [...withRows].filter((code) => !withEntries.has(code)).sort();
  if (missingRows.length === 0 && missingEntries.length === 0) {
    return;
  }
  throw new TrialBalanceToolError(
    `the trial balance aggregate and the Ledger_Entry read disagree over the requested range: ` +
      `[${missingRows.join(', ')}] hold entries with no aggregate row, and ` +
      `[${missingEntries.join(', ')}] have an aggregate row with no entry. One of the two reads ` +
      `is wrong and there is no way to tell which from here, so no trial balance is returned`,
  );
}

/**
 * Requirement 2.5's own guarantee, checked before the answer leaves.
 *
 * Both figures come from the Semantic_Ledger's helpers, so this asserts rather than
 * computes. A trial balance whose two grand totals differ is not a trial balance, and
 * presenting one would let a store fault read as an accounting fact.
 *
 * @throws {TrialBalanceToolError} when the two grand totals differ.
 */
export function assertBalanced(debitTotal: Paise, creditTotal: Paise): void {
  if (debitTotal !== creditTotal) {
    throw new TrialBalanceToolError(
      `the trial balance sums to ${debitTotal} paise debit and ${creditTotal} paise credit; ` +
        `Requirement 2.5 requires the two grand totals to be equal, and every persisted ` +
        `Ledger_Entry set balances (Requirement 2.7), so an unequal pair means the read is wrong`,
    );
  }
}

/**
 * Build the tool. A factory because all three seams are injected — see
 * {@link GetTrialBalanceDeps}.
 */
export function createGetTrialBalance(
  deps: GetTrialBalanceDeps,
): FinancialTool<GetTrialBalanceInput, GetTrialBalanceOutput> {
  return {
    name: GET_TRIAL_BALANCE,
    // Reads only. It persists Evidence_Chains, which is not Tenant financial state: a
    // figure cannot be returned without one (Requirement 12.2), and design.md declares
    // this tool read-only.
    mode: 'read_only',
    inputSchema,
    outputSchema,
    timeoutMs: TOOL_TIMEOUT_MS,

    async execute(
      ctx: ToolContext,
      input: GetTrialBalanceInput,
    ): Promise<ToolResult<GetTrialBalanceOutput>> {
      // Already accepted by the input schema; this is the single place the range is
      // named, and both reads are issued for exactly it.
      const range = assertDateRange({ from: input.from, to: input.to }, 'range');

      const read = await deps.entries(ctx).listEntriesInRange({
        // From the session, never from an argument (Requirement 12.7).
        tenant_id: ctx.tenant_id,
        range,
      });

      // Requirement 12.3, before any figure is computed: one unreadable contributing
      // record withholds every figure, because the grand totals are composed from every
      // in-range entry. No chain is composed and no statement is issued.
      const unreadable = unreadableIn(read);
      if (unreadable.length > 0) {
        return incompleteEvidence(unreadable);
      }

      const accounts = accountEntriesInOrder(read.entries);

      // Requirement 2.5's algorithm, unchanged. The tool supplies the Tenant from the
      // session and the range it validated, and computes nothing.
      const balance: TrialBalance = await deps
        .ledger(ctx)
        .trialBalance(ctx.tenant_id, range.from, range.to);

      assertReadsAgree(accounts, balance.rows);

      if (balance.rows.length === 0) {
        // Decision 3: correct as a trial balance, unstorable as evidence.
        throw new TrialBalanceToolError(
          `${GET_TRIAL_BALANCE} found no Ledger_Entry dated in ${range.from}..${range.to}, so ` +
            `both grand totals would be 0 paise citing no Source_Record. ` +
            `evidence_chains.source_count >= 1 makes an ungrounded figure unstorable and ` +
            `Requirement 12.2 admits no figure without a chain, so the range is refused rather ` +
            `than answered with an ungrounded zero. Nothing was unreadable, so this is not ` +
            `incomplete_evidence`,
        );
      }

      // Both from the Semantic_Ledger's own helpers, which exist so this tool does not
      // rewrite the summation.
      const debitTotal = trialBalanceDebitTotalPaise(balance);
      const creditTotal = trialBalanceCreditTotalPaise(balance);
      assertBalanced(debitTotal, creditTotal);

      const builder = createEvidenceChainBuilder({
        store: deps.chains(ctx),
        // The session Tenant, bound once. No method takes one.
        tenantId: ctx.tenant_id,
      });

      /**
       * Compose and persist one chain.
       *
       * `builder.build` answers either the composed chain or `incomplete_evidence`, and
       * the latter is already a `ToolResult` variant, so it is returned as-is rather
       * than translated.
       */
      const persist = async (
        chain: EvidenceChainInput,
      ): Promise<EvidenceChain | IncompleteEvidence> => {
        if (ctx.signal.aborted) {
          // The 10-second bound has elapsed. Stop before issuing another write rather
          // than leaving chains behind for a figure that will never be returned.
          throw new TrialBalanceToolError(
            `${GET_TRIAL_BALANCE} was aborted while composing Evidence_Chains`,
          );
        }
        const built = await builder.build(chain);
        return built.ok ? built.evidence : built;
      };

      const byAccountCode = new Map(accounts.map((account) => [account.account_code, account]));
      const rows: TrialBalanceAccount[] = [];
      for (const row of balance.rows) {
        const account = byAccountCode.get(row.account_code);
        if (account === undefined) {
          // Unreachable: `assertReadsAgree` already proved the two sets are equal.
          throw new TrialBalanceToolError(
            `account ${row.account_code} has a trial balance row and no in-range Ledger_Entry`,
          );
        }
        // Three steps, cross-checked against this row before anything is written.
        const persisted = await persist(accountChain(GET_TRIAL_BALANCE, account, row));
        if ('ok' in persisted) {
          return persisted;
        }
        rows.push(rowFor(row, persisted.evidence_chain_id, persisted.as_of));
      }

      // One aggregate chain per grand total. Separate derivations over disjoint operand
      // sets, so separate chains — see decision 2.
      const debitEnvelope = await persist(
        grandTotalChain(GET_TRIAL_BALANCE, 'debit', accounts, debitTotal),
      );
      if ('ok' in debitEnvelope) {
        return debitEnvelope;
      }
      const creditEnvelope = await persist(
        grandTotalChain(GET_TRIAL_BALANCE, 'credit', accounts, creditTotal),
      );
      if ('ok' in creditEnvelope) {
        return creditEnvelope;
      }

      return {
        ok: true,
        value: {
          accounts: rows,
          debit_total_paise: debitTotal,
          credit_total_paise: creditTotal,
          debit_total_evidence_chain_id: debitEnvelope.evidence_chain_id,
          debit_total_evidence_as_of: debitEnvelope.as_of,
          credit_total_evidence_chain_id: creditEnvelope.evidence_chain_id,
          credit_total_evidence_as_of: creditEnvelope.as_of,
        },
        // The debit grand total's chain. Its figure equals both top-level figures,
        // because Requirement 2.5 makes them equal.
        evidence: debitEnvelope,
      };
    },
  };
}

/**
 * The tool as a catalogue entry, ready for `createToolRegistry` (task 12.7).
 *
 * `catalogued` is identity at runtime; it exists so TypeScript checks the whole
 * declaration — including `NoTenantId<In>`, which is what makes a `tenant_id` argument
 * uninhabitable — at the hand-off rather than losing it in an erased list.
 */
export function catalogueEntryFor(deps: GetTrialBalanceDeps): ErasedFinancialTool {
  return catalogued(createGetTrialBalance(deps));
}

/**
 * One output row from a trial balance row and the chain that grounds it.
 *
 * The single place `closing_balance_paise` (the ledger's name) becomes `closing_paise`
 * (design.md's), and the single place `account_name` is resolved. `kind` is deliberately
 * not forwarded — see decision 4.
 */
function rowFor(
  row: TrialBalanceRow,
  evidenceChainId: string,
  evidenceAsOf: string,
): TrialBalanceAccount {
  return {
    account_code: row.account_code,
    account_name: accountNameOf(row.account_code),
    debit_total_paise: row.total_debit_paise,
    credit_total_paise: row.total_credit_paise,
    closing_paise: row.closing_balance_paise,
    evidence_chain_id: evidenceChainId,
    evidence_as_of: evidenceAsOf,
  };
}
