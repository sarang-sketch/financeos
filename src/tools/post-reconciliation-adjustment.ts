/**
 * `post_reconciliation_adjustment` — the first write-capable Financial_Tool (task 24.3).
 * Requirements 2.1, 2.6, 5.17, 12.2, 12.3, 12.7, 12.10.
 *
 * design.md fixes the contract:
 *
 *     in   { entry_date: DateOnly;
 *            entries: Array<{ account_code: string; side: 'debit'|'credit'; amount_paise: Paise }>;
 *            source_refs: SourceRef[] }
 *     out  { set_id: string; total_debit_paise: Paise; total_credit_paise: Paise }
 *
 * and states what this module is for: *"`post_reconciliation_adjustment` delegates to
 * `SemanticLedger.postSet`, so an unbalanced adjustment is rejected atomically with
 * zero entries persisted and the imbalance recorded, exactly as a direct ledger post
 * would be (Requirement 2.6)."*
 *
 * ## The balance check is not here, and must not be
 *
 * There is no `Σdebit === Σcredit` comparison in this file. `postSet` computes
 * `Σdebit − Σcredit` from the draft and returns
 * `{ ok: false, kind: 'unbalanced', imbalance_paise, source_refs }` **without opening
 * a transaction and without issuing a statement** — see the "Nothing is attempted for
 * a set that cannot balance" section of `@/ledger/semantic-ledger`. Re-deriving the
 * check here would produce a second rejection funnel and a second place the
 * `ledger_set_rejected` Audit_Event could be forgotten, and it would make "zero
 * entries persisted" a property of this file rather than of the ledger.
 *
 * The two totals in `Out` are summed with `sum` from `@/calc/calculation-service`
 * **after** the post succeeded. That is arithmetic over an already-balanced set, not a
 * gate: the set is persisted by then, and a total is what Requirement 2.1 says a set
 * carries.
 *
 * ## Order of operations, and why the read comes first
 *
 * 1. **Read the cited Source_Records** ({@link AdjustmentSourceStore}) for their
 *    `record_updated_at`. Any one that cannot be read yields `incomplete_evidence`
 *    with **nothing posted** (Requirement 12.3): the returned totals need an
 *    Evidence_Chain, the chain cites the records the adjustment was derived from, and
 *    a figure whose chain is incomplete is withheld rather than returned. Doing this
 *    first is what makes "no adjustment is posted against a record we cannot read"
 *    true by ordering rather than by cleanup.
 * 2. **Post through `postSet`.** One call, one transaction, one rejection funnel.
 * 3. **Compose the two Evidence_Chains** over the set that now exists.
 *
 * Nothing is undone between 2 and 3, so a chain-store failure after a successful post
 * leaves the set persisted and returns `tool_failure`. That is the same exposure every
 * chain-composing tool has and it is stated rather than hidden: the alternative —
 * composing the chain first — would cite a `ledger_entry_set` that does not exist yet.
 * The Proposal is what recovers it: Requirement 5.17 reverses each change already
 * applied for a Proposal whose EXECUTE stage failed, through
 * `SemanticLedger.reverseSet` (task 24.1), which is why this tool needs no compensating
 * write of its own and deliberately has none.
 *
 * ## What grounds the two figures
 *
 * Two chains, one per grand total, named in `Out` through
 * `total_debit_evidence_chain_id` / `total_credit_evidence_chain_id` — the
 * `<field>_evidence_chain_id` sibling convention `get_trial_balance` established and
 * task 12.7 adopted in `test/contract/tool-contract.ts`. Σdebit and Σcredit are equal
 * in value and different in derivation: they sum disjoint operand sets, so one chain
 * cannot present both without misstating what it summed. The envelope chain is the
 * debit total's, which is the field design.md lists first; its `figure_paise` equals
 * both top-level figures, because a persisted set balances.
 *
 * Each chain cites:
 *
 * - **the newly persisted `ledger_entry_set`**, once per line on its side, under the
 *   field name `line_<n>.amount_paise`. Those lines *are* the records the totals were
 *   summed from, and `line_no` is `postSet`'s own numbering (the draft's order,
 *   1-based — see `writeFor` in `@/ledger/semantic-ledger`). `record_updated_at` is the
 *   instant of the post, which is when that record was last written; the tool's clock
 *   is injected so it is assertable.
 * - **every `source_refs` entry**, under the field name
 *   {@link SOURCE_RECORD_CITED_FIELD}, with the `record_updated_at` step 1 read. So
 *   the chain contains every contributing Source_Record identifier
 *   (Requirement 12.2) and its `as_of` is the newest of them.
 *
 * ## Reported, not silently patched
 *
 * 1. **`ToolResult` has no variant for a write refused on its merits.** An unbalanced
 *    adjustment is an *expected* outcome with a specified error response
 *    (Requirement 2.6: the imbalance in paise and the Source_Record identifiers), and
 *    the envelope can carry neither: `tool_failure` states a tool name and a cause and
 *    nothing else. So the refusal is raised with the imbalance in its message, which
 *    the invoker records on the `tool_failure` Audit_Event, and the authoritative
 *    record stays the ledger's own `ledger_set_rejected` event — appended on its own
 *    connection, carrying `imbalance_paise`, the declared totals and
 *    `entries_persisted: 0`. Two events for one rejection, both true. An
 *    `unbalanced_write` variant on `ToolResult` would be the honest fix and is a change
 *    to `./tool.ts` plus `test/contract/tool-contract.ts`, above this task.
 * 2. **design.md gives this tool no output shape for Requirement 2.8's idempotent
 *    no-op.** `postSet` answers `{ ok: true, created: false }` when
 *    `ledger_set_derivation_uniq` already holds a set for `(tenant, source_refs[0])`,
 *    with `set_id` naming the **retained** set. This tool cannot report that
 *    faithfully: it would have to state the retained set's totals, and it never read
 *    them — stating the draft's instead would present figures that are not the
 *    persisted set's. So a no-op is **refused** rather than reported as a success, and
 *    the retained set identifier is named in the refusal. That is also the safer
 *    reading of a Proposal-driven write: re-posting an adjustment whose derivation
 *    identity is already taken is the duplicate action Requirement 5.13's Policy_Check
 *    exists to catch, and answering "fine, here it is" would let a double execution
 *    read as a success.
 * 3. **`evidence_chain_sources.field` is mandatory, and a write tool reads no field of
 *    the records it cites.** The primary key makes a whole-record citation
 *    unrepresentable (`@/evidence/chain-builder` FINDING 4), so the derivation refs are
 *    cited under `record_updated_at` — literally the only field of them this tool
 *    reads, and what dates the chain. A drill-down therefore shows *which* records the
 *    adjustment was raised against and *when they last changed*, not an amount they do
 *    not contribute.
 * 4. **Nothing states that the Proposal's `expected_outcome` must match the entries
 *    posted.** Requirement 5.11's Verification compares observed state against the
 *    Proposal's expected outcome after the fact (task 23.3), but the gate in
 *    `./write-tool.ts` only proves *that* an Authorization exists, not that it
 *    authorized *these* entries — see finding 2 there. A caller holding one valid pair
 *    can post any balanced set. Escalated, because closing it needs a Proposal read
 *    seam and a stated `expected_outcome` shape (task 23.1's FINDING 2).
 *
 * ## Money
 *
 * `bigint` throughout. `amount_paise` arrives as `z.bigint()` and is range-checked by
 * the paise helpers; nothing here converts, rounds or formats a figure, and the two
 * totals go through `sum`, which range-checks every running total.
 */

import { type Paise, sum } from '@/calc/calculation-service';
import type { TenantId } from '@/config/configuration-service';
import {
  createEvidenceChainBuilder,
  type EvidenceChain,
  type EvidenceChainInput,
  type EvidenceChainStore,
  type EvidenceOperand,
  type EvidenceSourceCitation,
  incompleteEvidence,
  type IncompleteEvidence,
} from '@/evidence/chain-builder';
import type { LedgerEntrySetDraft, SourceRef } from '@/ledger/posting-rules';
import { SOURCE_RECORD_TYPES } from '@/ledger/posting-rules';
import type { SemanticLedger } from '@/ledger/semantic-ledger';
import { z } from 'zod';

import { catalogued } from './registry';
import type { ErasedFinancialTool, FinancialTool, ToolContext, ToolResult } from './tool';
import {
  type AuthorizedWrite,
  createWriteCapableTool,
  type WriteCapableToolGate,
  type WriteSeam,
} from './write-tool';

/** design.md's catalogue name, and `evidence_chains.produced_by` for both chains. */
export const POST_RECONCILIATION_ADJUSTMENT = 'post_reconciliation_adjustment';

/**
 * The field name a derivation Source_Record is cited under. See finding 3: a citation
 * needs a field, and the update timestamp is the only field of these records the tool
 * reads.
 */
export const SOURCE_RECORD_CITED_FIELD = 'record_updated_at';

/** `Σdebit` and `Σcredit` each get one step, so both chains are one step long. */
const TOTAL_STEP_INDEX = 1;

/* -------------------------------------------------------------------------- */
/* Input schema                                                               */
/* -------------------------------------------------------------------------- */

/** `chart_of_accounts.account_code`: lower snake case, bounded. */
const ACCOUNT_CODE_RE = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * A Source_Record identifier: Razorpay's `[A-Za-z0-9_]` plus `-` for the UUID of a
 * `ledger_entry_set` or a `proposal`. Bounded, so no argument carries free-form text
 * (Requirement 12.9).
 */
const SOURCE_RECORD_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** `YYYY-MM-DD` that is also a real calendar date. `2026-02-30` is neither. */
function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const sourceRefSchema = z.strictObject({
  type: z.enum(SOURCE_RECORD_TYPES),
  id: z.string().regex(SOURCE_RECORD_ID_RE),
});

/**
 * One drafted Ledger_Entry. `amount_paise` is `> 0` and direction is `side`, exactly
 * as `LedgerEntryDraft` declares — the schema states the same bounds so a malformed
 * entry is a `schema_violation` naming the argument rather than a `PostingRuleError`
 * surfacing as `tool_failure`.
 */
const entrySchema = z.strictObject({
  account_code: z.string().regex(ACCOUNT_CODE_RE),
  side: z.enum(['debit', 'credit']),
  amount_paise: z.bigint().positive(),
});

const inputSchema = z
  .strictObject({
    entry_date: z.iso.date(),
    /** Requirement 2.1's 2..20 Ledger_Entries, stated where a caller learns of it. */
    entries: z.array(entrySchema).min(2).max(20),
    /** At least 1 Source_Record link (Requirement 2.2). The first is the derivation identity. */
    source_refs: z.array(sourceRefSchema).min(1).max(50),
  })
  .refine((value) => isRealDate(value.entry_date), {
    error: 'entry_date must be a real calendar date',
    path: ['entry_date'],
  });

export type PostReconciliationAdjustmentInput = z.infer<typeof inputSchema>;

/* -------------------------------------------------------------------------- */
/* Output schema                                                              */
/* -------------------------------------------------------------------------- */

const paise = z.bigint();

const outputSchema = z.strictObject({
  /** `ledger_entry_sets.id` of the set that was persisted. */
  set_id: z.uuid(),
  total_debit_paise: paise.positive(),
  total_credit_paise: paise.positive(),
  /** Grounds `total_debit_paise`. Also the envelope chain. */
  total_debit_evidence_chain_id: z.uuid(),
  total_debit_evidence_as_of: z.iso.datetime(),
  /** Grounds `total_credit_paise`. A separate derivation, hence a separate chain. */
  total_credit_evidence_chain_id: z.uuid(),
  total_credit_evidence_as_of: z.iso.datetime(),
});

export type PostReconciliationAdjustmentOutput = z.infer<typeof outputSchema>;

/* -------------------------------------------------------------------------- */
/* Read seam: the cited Source_Records                                        */
/* -------------------------------------------------------------------------- */

/** One cited Source_Record, as this tool needs it: it exists, and when it last changed. */
export interface AdjustmentSourceRecord {
  readonly ref: SourceRef;
  /** ISO-8601 UTC, ms precision. Dates the Evidence_Chain (Requirement 12.2). */
  readonly record_updated_at: string;
}

/**
 * What the read answers.
 *
 * A requested ref absent from {@link records} is treated exactly as one listed in
 * {@link unreadable}: the tool cannot cite it, so the figure is withheld. Both spellings
 * are accepted because an adapter may know *that* a record was unreadable without being
 * able to enumerate it, and a cross-Tenant request answers zero rows rather than an
 * error (Requirement 14.4).
 */
export interface AdjustmentSourceRead {
  readonly records: readonly AdjustmentSourceRecord[];
  readonly unreadable?: readonly SourceRef[];
}

export interface AdjustmentSourceQuery {
  /** From the session, never from an argument (Requirement 12.7). */
  readonly tenant_id: TenantId;
  readonly refs: readonly SourceRef[];
}

export interface AdjustmentSourceStore {
  readSourceRecords(query: AdjustmentSourceQuery): Promise<AdjustmentSourceRead>;
}

/* -------------------------------------------------------------------------- */
/* Dependencies                                                               */
/* -------------------------------------------------------------------------- */

export interface PostReconciliationAdjustmentDeps {
  /**
   * The Semantic_Ledger, reachable **only with the gate's proof**
   * ({@link WriteSeam}). This is the structural half of Requirement 12.10: there is no
   * way to obtain a ledger from a `ToolContext` alone, so a post with no Authorization
   * behind it is not expressible in this module.
   */
  readonly ledger: WriteSeam<SemanticLedger>;
  /** The cited records' update timestamps. A read, so no proof is required. */
  readonly sources: (ctx: ToolContext) => AdjustmentSourceStore;
  readonly chains: (ctx: ToolContext) => EvidenceChainStore;
  /** Injectable clock. Dates the persisted set's citations. Defaults to the wall clock. */
  readonly now?: () => Date;
}

/** Refused mid-invocation. Becomes `tool_failure` with cause `execution_error`. */
export class PostAdjustmentToolError extends Error {
  override readonly name = 'PostAdjustmentToolError';
}

/* -------------------------------------------------------------------------- */
/* Evidence                                                                   */
/* -------------------------------------------------------------------------- */

/** The Source_Records the read could not answer for, in requested order. */
export function unreadableCitedRefs(
  requested: readonly SourceRef[],
  read: AdjustmentSourceRead,
): readonly SourceRef[] {
  // `\u0000` as the joiner, matching `@/evidence/chain-builder`: a Postgres text value
  // cannot contain it, so no pair of refs can collide on one key.
  const keyOf = (ref: SourceRef): string => `${ref.type}\u0000${ref.id}`;
  const answered = new Set(read.records.map((record) => keyOf(record.ref)));
  const declared = new Set((read.unreadable ?? []).map(keyOf));

  const unreadable: SourceRef[] = [];
  const seen = new Set<string>();
  for (const ref of [...requested, ...(read.unreadable ?? [])]) {
    const key = keyOf(ref);
    if (!declared.has(key) && answered.has(key)) {
      continue;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unreadable.push({ type: ref.type, id: ref.id });
  }
  return unreadable;
}

/**
 * One side's chain: a `sum` over the persisted set's lines on that side, citing those
 * lines and every derivation Source_Record.
 *
 * Pure, so what grounds a figure is unit-testable with no database and no ledger.
 */
export function adjustmentTotalChain(options: {
  readonly side: 'debit' | 'credit';
  readonly setId: string;
  readonly entries: readonly { readonly side: 'debit' | 'credit'; readonly amount_paise: Paise }[];
  readonly total_paise: Paise;
  /** When the set was written. `record_updated_at` of every line citation. */
  readonly posted_at: string;
  readonly cited: readonly AdjustmentSourceRecord[];
}): EvidenceChainInput {
  const set: SourceRef = { type: 'ledger_entry_set', id: options.setId };
  const lines = options.entries
    // `postSet` numbers lines by the draft's own order, 1-based (`writeFor`).
    .map((entry, index) => ({ entry, field: `line_${index + 1}.amount_paise` }))
    .filter(({ entry }) => entry.side === options.side);

  if (lines.length === 0) {
    throw new PostAdjustmentToolError(
      `the persisted set ${options.setId} has no ${options.side} line, so its ${options.side} ` +
        `total cannot be grounded; Requirement 2.1 gives every set at least one line on each side`,
    );
  }

  const operands: EvidenceOperand[] = lines.map(({ field }) => ({
    kind: 'source',
    ref: set,
    field,
  }));
  const citations: EvidenceSourceCitation[] = [
    ...lines.map(({ field }) => ({ ref: set, field, record_updated_at: options.posted_at })),
    // Every contributing Source_Record identifier (Requirement 12.2). See finding 3
    // for the field name.
    ...options.cited.map((record) => ({
      ref: record.ref,
      field: SOURCE_RECORD_CITED_FIELD,
      record_updated_at: record.record_updated_at,
    })),
  ];

  return {
    produced_by: POST_RECONCILIATION_ADJUSTMENT,
    figure_paise: options.total_paise,
    steps: [
      {
        index: TOTAL_STEP_INDEX,
        operation: 'sum',
        operands,
        result_paise: options.total_paise,
        note: `exact sum of the ${options.side} lines of the posted adjustment set`,
      },
    ],
    sources: citations,
  };
}

/* -------------------------------------------------------------------------- */
/* The tool                                                                   */
/* -------------------------------------------------------------------------- */

export function createPostReconciliationAdjustment(
  deps: PostReconciliationAdjustmentDeps,
  gate: WriteCapableToolGate,
): FinancialTool<PostReconciliationAdjustmentInput, PostReconciliationAdjustmentOutput> {
  const clock = deps.now ?? ((): Date => new Date());

  return createWriteCapableTool<
    PostReconciliationAdjustmentInput,
    PostReconciliationAdjustmentOutput
  >(
    {
      name: POST_RECONCILIATION_ADJUSTMENT,
      inputSchema,
      outputSchema,

      async execute(
        ctx: ToolContext,
        input: PostReconciliationAdjustmentInput,
        authorized: AuthorizedWrite,
      ): Promise<ToolResult<PostReconciliationAdjustmentOutput>> {
        /* 1. The cited records, for the chain's operands and its as-of. */
        const read = await deps.sources(ctx).readSourceRecords({
          // From the session (Requirement 12.7).
          tenant_id: ctx.tenant_id,
          refs: input.source_refs,
        });
        const unreadable = unreadableCitedRefs(input.source_refs, read);
        if (unreadable.length > 0) {
          // Requirement 12.3, before anything is posted: the totals cannot be grounded,
          // so they are withheld entirely and the ledger is not touched.
          return incompleteEvidence(unreadable);
        }

        assertNotAborted(ctx, 'before posting the adjustment');

        /* 2. The ledger's own path. The balance check and the rejection are its. */
        const draft: LedgerEntrySetDraft = {
          source_refs: input.source_refs,
          entry_date: input.entry_date,
          entries: input.entries,
        };
        const posted = await deps.ledger(ctx, authorized).postSet(ctx.tenant_id, draft);

        if (!posted.ok) {
          // Zero Ledger_Entries persisted, and `ledger_set_rejected` already appended
          // by the Semantic_Ledger on its own connection, carrying the imbalance and
          // the Source_Record identifiers (Requirement 2.6). Finding 1: `ToolResult`
          // cannot carry either, so the refusal is raised and the invoker records it.
          throw new PostAdjustmentToolError(
            `the adjustment is unbalanced by ${posted.imbalance_paise} paise, so the ` +
              `Semantic_Ledger rejected the whole Ledger_Entry set and persisted 0 entries ` +
              `(Requirement 2.6). The rejection is recorded with the imbalance and the ` +
              `Source_Record identifiers ${posted.source_refs
                .map((ref) => `${ref.type}:${ref.id}`)
                .join(', ')}`,
          );
        }
        if (!posted.created) {
          // Finding 2: a faithful success is not expressible, and a double execution
          // must not read as one.
          throw new PostAdjustmentToolError(
            `Ledger_Entry set ${posted.set_id} is already derived from ` +
              `${input.source_refs[0]?.type}:${input.source_refs[0]?.id} for this Tenant, so ` +
              `postSet retained it and created 0 additional Ledger_Entries (Requirement 2.8). ` +
              `This tool cannot state that set's totals without reading them, and re-posting an ` +
              `authorized adjustment is the duplicate action Requirement 5.13 screens for, so ` +
              `the invocation is refused rather than reported as a post`,
          );
        }

        /* 3. The two totals, over a set that is already persisted and balanced. */
        const totalDebit = sum(
          input.entries.filter((entry) => entry.side === 'debit').map((entry) => entry.amount_paise),
        );
        const totalCredit = sum(
          input.entries.filter((entry) => entry.side === 'credit').map((entry) => entry.amount_paise),
        );

        const postedAt = new Date(clock().getTime()).toISOString();
        const builder = createEvidenceChainBuilder({
          store: deps.chains(ctx),
          // The session Tenant, bound once. No method takes one.
          tenantId: ctx.tenant_id,
        });

        const persist = async (
          chain: EvidenceChainInput,
        ): Promise<EvidenceChain | IncompleteEvidence> => {
          assertNotAborted(ctx, 'while composing the adjustment Evidence_Chains');
          const built = await builder.build(chain);
          return built.ok ? built.evidence : built;
        };

        const debitChain = await persist(
          adjustmentTotalChain({
            side: 'debit',
            setId: posted.set_id,
            entries: input.entries,
            total_paise: totalDebit,
            posted_at: postedAt,
            cited: read.records,
          }),
        );
        if ('ok' in debitChain) {
          return debitChain;
        }
        const creditChain = await persist(
          adjustmentTotalChain({
            side: 'credit',
            setId: posted.set_id,
            entries: input.entries,
            total_paise: totalCredit,
            posted_at: postedAt,
            cited: read.records,
          }),
        );
        if ('ok' in creditChain) {
          return creditChain;
        }

        return {
          ok: true,
          value: {
            set_id: posted.set_id,
            total_debit_paise: totalDebit,
            total_credit_paise: totalCredit,
            total_debit_evidence_chain_id: debitChain.evidence_chain_id,
            total_debit_evidence_as_of: debitChain.as_of,
            total_credit_evidence_chain_id: creditChain.evidence_chain_id,
            total_credit_evidence_as_of: creditChain.as_of,
          },
          // The debit total's chain. Its figure equals both top-level figures, because
          // a persisted set balances (Requirement 2.1, 2.7).
          evidence: debitChain,
        };
      },
    },
    gate,
  );
}

/**
 * The tool as a catalogue entry, ready for `createToolRegistry`.
 *
 * `catalogued` is identity at runtime; it exists so TypeScript checks the whole
 * declaration — including `NoTenantId<In>`, which is what makes a `tenant_id` argument
 * uninhabitable — at the hand-off rather than losing it in an erased list. The gate is
 * applied exactly once, by {@link createPostReconciliationAdjustment}.
 */
export function catalogueEntryFor(
  deps: PostReconciliationAdjustmentDeps,
  gate: WriteCapableToolGate,
): ErasedFinancialTool {
  return catalogued(createPostReconciliationAdjustment(deps, gate));
}

/**
 * The 10-second bound has elapsed. Stop before issuing another write rather than
 * leaving a set or a chain behind for a figure that will never be returned.
 */
function assertNotAborted(ctx: ToolContext, where: string): void {
  if (ctx.signal.aborted) {
    throw new PostAdjustmentToolError(
      `${POST_RECONCILIATION_ADJUSTMENT} was aborted ${where}`,
    );
  }
}
