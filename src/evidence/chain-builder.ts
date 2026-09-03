/**
 * The Evidence_Chain builder: compose one, persist it, read it back, page its
 * sources (task 9.1). Requirements 12.2, 12.3, 12.5.
 *
 * This module owns design.md's `EvidenceStep` / `EvidenceChain` shapes — see
 * "Shared types used throughout" — and is the only place they are declared.
 * `test/fixtures/set-9281.ts` held a second copy until this file landed and now
 * imports them from here.
 *
 * ## What the database enforces, and what this module enforces
 *
 * `20260101000006_evidence_chains.sql` records four FINDINGs. Two of them are
 * gaps this module has to close, so the split is written down here rather than
 * left for a reader to infer from the schema — the schema does **not** check
 * everything a replay needs:
 *
 * | Invariant | Enforced by |
 * |---|---|
 * | `source_count >= 1` | **database** CHECK `evidence_chains_source_count_check`, **and** here before any statement |
 * | `step_index >= 1` | **database** CHECK, and here |
 * | one row per `(chain_id, step_index)` | **database** PK |
 * | one row per `(chain_id, type, id, field)` | **database** PK (which also makes `field` NOT NULL — FINDING 4) |
 * | `figure_paise` / `result_paise` in paise range | **database** `paise` domain, and here via `assertInRange` |
 * | `record_updated_at` and `as_of` present | **database** NOT NULL |
 * | `tenant_id` exists | **database** FK to `tenants` |
 * | **`step_index` gapless `1..n`** | **this module only** (FINDING 2) |
 * | **`{ kind: 'step' }` operands reference a *lower* index** | **this module only** (FINDING 2) |
 * | **`step_index` fits `SMALLINT`** | **this module only** — the column is `SMALLINT` with no upper CHECK |
 * | **every `{ kind: 'source' }` operand is cited in `evidence_chain_sources`** | **this module only** |
 * | **`source_count` equals the number of distinct identifiers** | **this module only** (FINDING 3) |
 * | **`as_of` is the newest contributing `record_updated_at`** | **this module only** |
 * | **the terminal step's `result_paise` equals `figure_paise`** | **this module only** |
 *
 * Nothing below papers over a FINDING by adding a migration: the schema is the
 * task-4 group's, and the gaps are closed in TypeScript, before any statement is
 * issued, in the {@link composeEvidenceChain} funnel.
 *
 * ## Nothing is attempted for a chain that cannot be replayed
 *
 * Same discipline as `src/ledger/semantic-ledger.ts` and
 * `src/ingestion/ingestion-service.ts`: the whole chain is staged in memory and
 * validated as a pure function first, so a malformed chain issues **no
 * statement at all** rather than being rolled back. A partially written chain is
 * exactly the failure mode Requirement 12.3 exists to prevent — a figure with an
 * incomplete chain is worse than no figure.
 *
 * ## Steps are read through the chain, because they carry no `tenant_id`
 *
 * FINDING 1: `evidence_chain_steps` is the one child table with no denormalised
 * `tenant_id`, so no query on it can be scoped by a local column. Every read
 * here therefore begins with a `evidence_chains` lookup filtered by the session
 * Tenant ({@link EvidenceChainStore.findChain}), and the step and source queries
 * are only issued for a chain that lookup returned. {@link EvidenceChainStore}
 * additionally requires the step query to qualify through `evidence_chains`, so
 * the scoping does not depend on the service getting the order right. A chain
 * belonging to another Tenant is indistinguishable from one that does not exist:
 * both yield `null`, never a "not yours" error, because an error of that shape
 * confirms existence (Requirement 14.4).
 *
 * `tenant_id` is bound once, at construction, from the session context. No
 * method takes one (Requirement 12.7).
 *
 * ## `incomplete_evidence`, and who owns `ToolResult`
 *
 * Requirement 12.3 wants the figure **omitted**, not zeroed and not nulled
 * beside a count. {@link IncompleteEvidence} therefore has no figure field at
 * all — omitting it is structural, not a convention a caller could forget. It is
 * the only outcome besides success that {@link EvidenceChainResult} carries.
 *
 * `ToolResult<T>`, `FinancialTool<In, Out>` and `ToolContext` are **task 10.1's**
 * and are not declared here. design.md puts `ToolResult` in the same shared-types
 * block as `EvidenceChain`, but its other three variants — `schema_violation`,
 * `tool_failure`, `unauthorized_write` — are facts about an invocation, not about
 * evidence, and they belong with the layer that enforces them. What 10.1 gets
 * from this module is the `ok: true` payload ({@link EvidenceChain}) and the
 * `incomplete_evidence` variant ({@link IncompleteEvidence}), which it composes
 * into the union. Declaring the union here would duplicate it there or force the
 * tool layer to import its own contract from the evidence layer.
 *
 * ## Retrieval order, and why pagination needs a total order
 *
 * Sources are paged at most {@link MAX_SOURCE_PAGE_SIZE} identifiers per page
 * with no omission (Requirement 12.2). Pagination over a partial order can drop
 * or repeat a row across pages, so the order is the **full identity key**:
 * ascending `source_record_type`, then ascending `source_record_id`, both
 * compared as text under the `C` collation so the sequence does not shift with
 * the database locale. That pair is the identity of a Source_Record, so the
 * order is total and paging is keyset, not `OFFSET`.
 *
 * One page row is one **distinct Source_Record identifier**, not one
 * `evidence_chain_sources` row: a chain that reads three fields of one Payment
 * has three rows but one identifier, and `source_count` counts identifiers
 * (Requirement 12.2, and the SET-9281 fixture, whose 14 citations are 8
 * identifiers). So `source_count` equals the number of rows across every page,
 * which is what property P6 (task 9.3) asserts. The fields cited for an
 * identifier travel with it, ascending, so the drill-down UI can show them.
 *
 * {@link EvidenceChain.sources} as returned by {@link build} is in
 * **first-citation order** instead — the order the tool read them, which is what
 * makes a chain readable next to its steps. Retrieval order is the collated key
 * order. Both cover the same set exactly once; only the sequence differs, and no
 * caller should depend on the two agreeing.
 *
 * ## The stale indicator, and what it can and cannot see
 *
 * Every page row carries `record_updated_at` (the cited record's update
 * timestamp as it stood when the chain was composed) next to the chain's `as_of`
 * (the newest of them), plus the derived `stale` flag, which is exactly
 * `record_updated_at > as_of` (Requirement 12.5).
 *
 * **A gap worth stating plainly**: because `as_of` is *defined* as the maximum of
 * the stored `record_updated_at` values, `stale` is `false` for every row of a
 * freshly composed chain, and stays `false` forever, since neither column is
 * rewritten. Detecting "a referenced Source_Record has been updated since" needs
 * the record's **current** timestamp, which lives in `razorpay_objects`, not in
 * `evidence_chain_sources`. This module exposes the pair the requirement names
 * and computes the comparison; the live re-read that can actually make it `true`
 * belongs to whoever renders the drill-down (task 22.x) or re-invokes the tool
 * after 15 minutes (Requirement 12.4). design.md does not say which, and
 * `evidence_chain_sources_idx (tenant_id, source_record_type, source_record_id)`
 * exists for precisely that reverse lookup. Reported, not invented here.
 *
 * ## Money
 *
 * `figure_paise` and every `result_paise` are `Paise` — `bigint`, integer paise
 * (Requirement 15.1, 15.8). Into and out of the database they travel as integer
 * strings through `toWire` / `fromWire`, which range-check on the way; there is
 * no ad-hoc conversion in this module and no `Number(...)` on a monetary value
 * anywhere. A monetary **literal** operand is a string for the same reason:
 * `operands` is `JSONB`, and a JSON numeric literal parses back through an
 * IEEE-754 double, so a literal written as a number could replay to a different
 * value than the one stored.
 *
 * Note that `JSONB` is not a byte-preserving round trip — Postgres reorders
 * object keys and normalises whitespace — so nothing here asserts on the text of
 * `operands`. It is written with `JSON.stringify` and read back **structurally**,
 * through {@link parseEvidenceOperands}, which rejects any shape that is not one
 * of design.md's three operand kinds.
 *
 * ## Scope
 *
 * The independent replay interpreter is **task 9.2** and deliberately shares no
 * code with this module: it consumes the persisted `EvidenceStep` schema and
 * nothing else, so there is no arithmetic here for it to import. Property P6 is
 * **task 9.3**. The `FinancialTool` envelope is **task 10.1**. The tools that
 * compose chains — `get_settlement_reconciliation` and the rest — are tasks 11.x
 * and 12.x; this module is the machinery they call.
 */

import { assertInRange, type Paise } from '@/calc/paise';
import type { TenantId } from '@/config/configuration-service';
import {
  SOURCE_RECORD_TYPES,
  type SourceRecordType,
  type SourceRef,
} from '@/ledger/posting-rules';
import { fromWire, type PaiseWire, toWire } from '@/wire/paise-wire';

/**
 * `SourceRef` and `SourceRecordType` are **owned by `@/ledger/posting-rules`**
 * (task 8.1), which declared them first and whose `SOURCE_RECORD_TYPES` is the
 * single transcription of the `source_record_type` enum. They are imported from
 * there and re-exported here — not redeclared — so a consumer of the evidence
 * shapes can take every type it needs from one module while there remains
 * exactly one definition in the codebase.
 */
export type { SourceRecordType, SourceRef };

/* -------------------------------------------------------------------------- */
/* design.md's shared evidence types                                          */
/* -------------------------------------------------------------------------- */

/**
 * The 9 labels of the `evidence_operation` enum, in migration order.
 *
 * The closed set the replay interpreter of task 9.2 must be total over
 * (Requirement 12.8). A label added here without a case added there turns that
 * interpreter into a partial function and P6 into a false pass.
 */
export const EVIDENCE_OPERATIONS = [
  'sum',
  'subtract',
  'add',
  'multiply',
  'divide',
  'round_half_up',
  'negate',
  'select',
  'compare',
] as const;

export type EvidenceOperation = (typeof EVIDENCE_OPERATIONS)[number];

/**
 * One input to a step: a field of a Source_Record, a preceding step's output, or
 * a literal.
 *
 * `literal.value` is a **string** — a monetary literal is never a JSON number
 * (see the module doc comment). `step.index` is an ordinal rather than money, so
 * it is a plain number.
 */
export type EvidenceOperand =
  | { readonly kind: 'source'; readonly ref: SourceRef; readonly field: string }
  | { readonly kind: 'step'; readonly index: number }
  | { readonly kind: 'literal'; readonly value: string };

/**
 * One computation step, stating exactly one arithmetic operation
 * (Requirement 12.2).
 *
 * `index` is design.md's field name and maps to the 1-based
 * `evidence_chain_steps.step_index` column. The names differ deliberately —
 * design.md's in-memory shape says `index`, the schema says `step_index` — and
 * {@link evidenceChainWriteFor} is the single place the mapping happens.
 *
 * `result_paise` is `null` for a step with no single monetary result: `compare`
 * yields a boolean, `select` can pick a non-monetary field.
 */
export interface EvidenceStep {
  readonly index: number;
  readonly operation: EvidenceOperation;
  readonly operands: readonly EvidenceOperand[];
  readonly result_paise: Paise | null;
  readonly note?: string;
}

/**
 * design.md's `EvidenceChain`, plus `produced_by` for the `NOT NULL`
 * `evidence_chains.produced_by` column that design.md's DDL has and its
 * TypeScript block omits.
 *
 * `sources` holds every distinct Source_Record identifier in first-citation
 * order. On **retrieval** the identifiers arrive in pages of at most
 * {@link MAX_SOURCE_PAGE_SIZE} in the collated key order instead — see the
 * module doc comment.
 */
export interface EvidenceChain {
  readonly evidence_chain_id: string;
  /** The figure the chain presents: the result of its terminal step. */
  readonly figure_paise: Paise;
  readonly sources: readonly SourceRef[];
  /** A count of distinct identifiers. Always `>= 1`. */
  readonly source_count: number;
  readonly steps: readonly EvidenceStep[];
  /** ISO-8601 UTC, ms precision. The newest contributing `record_updated_at`. */
  readonly as_of: string;
  /** The Financial_Tool name. */
  readonly produced_by: string;
}

/* -------------------------------------------------------------------------- */
/* incomplete_evidence (Requirement 12.3)                                     */
/* -------------------------------------------------------------------------- */

/** One unavailable Source_Record type with its count of unavailable records. */
export interface UnavailableSourceCount {
  readonly type: SourceRecordType;
  /** Distinct unreadable identifiers of this type. Always `>= 1`. */
  readonly count: number;
}

/**
 * Requirement 12.3's result. **There is no figure field**: the figure is omitted
 * entirely rather than returned as `0`, as `null`, or beside a count.
 */
export interface IncompleteEvidence {
  readonly ok: false;
  readonly kind: 'incomplete_evidence';
  /** One entry per type, in `source_record_type` enum order. Never empty. */
  readonly unavailable: readonly UnavailableSourceCount[];
}

/**
 * What {@link EvidenceChainBuilder.build} returns.
 *
 * Task 10.1 composes `ToolResult<T>` from these two shapes plus the three
 * invocation-level variants it owns — see the module doc comment.
 */
export type EvidenceChainResult =
  | { readonly ok: true; readonly evidence: EvidenceChain }
  | IncompleteEvidence;

/* -------------------------------------------------------------------------- */
/* Composition input                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One `(record, field)` the chain read, with that record's update timestamp.
 *
 * `field` is mandatory: `evidence_chain_sources.field` is part of the primary
 * key, so Postgres marks it `NOT NULL` and a citation of a whole record with no
 * particular field is not representable (FINDING 4).
 */
export interface EvidenceSourceCitation {
  readonly ref: SourceRef;
  readonly field: string;
  /** ISO-8601 UTC, ms precision, as the record stood when the chain was composed. */
  readonly record_updated_at: string;
}

/** What a Financial_Tool hands the builder. */
export interface EvidenceChainInput {
  /** The Financial_Tool name. `evidence_chains.produced_by`. */
  readonly produced_by: string;
  /** The presented figure. Must equal the terminal step's `result_paise`. */
  readonly figure_paise: Paise;
  /** Gapless `1..n`, in order, at least 1. */
  readonly steps: readonly EvidenceStep[];
  /** At least 1 citation, one per `(record, field)` read. */
  readonly sources: readonly EvidenceSourceCitation[];
  /**
   * Source_Records the tool could not read. Non-empty means the figure is
   * **omitted** and {@link IncompleteEvidence} is returned instead — no chain is
   * composed and no statement is issued (Requirement 12.3).
   */
  readonly unreadable?: readonly SourceRef[];
}

/**
 * A validated chain, staged in memory and not yet persisted.
 *
 * Everything {@link composeEvidenceChain} derives is stated here so the derived
 * values are assertable without a database: `as_of` as the newest citation,
 * `source_count` as the distinct identifier count, `sources` in first-citation
 * order, and `citations` deduplicated and ordered by the identity key.
 */
export interface EvidenceChainDraft {
  readonly produced_by: string;
  readonly figure_paise: Paise;
  readonly source_count: number;
  readonly as_of: string;
  readonly steps: readonly EvidenceStep[];
  readonly sources: readonly SourceRef[];
  /** Deduplicated, ordered by `(type, id, field)`. One row each on insert. */
  readonly citations: readonly EvidenceSourceCitation[];
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Thrown when a chain is malformed in a way no result shape carries.
 *
 * A malformed chain is a caller fault: no Financial_Tool composes a chain with a
 * gap in its step indexes or a forward step reference, and `EvidenceChainResult`
 * has no variant for one. `incomplete_evidence` is different — Requirement 12.3
 * requires it as a *result*, so it is returned, never thrown.
 */
export class EvidenceChainError extends Error {
  override readonly name = 'EvidenceChainError';
}

/* -------------------------------------------------------------------------- */
/* Limits                                                                     */
/* -------------------------------------------------------------------------- */

/** Requirement 12.2: at most 500 Source_Record identifiers per retrieved page. */
export const MAX_SOURCE_PAGE_SIZE = 500;

/** Requirement 12.5: the drill-down UI pages at 100, well inside the 500 cap. */
export const UI_SOURCE_PAGE_SIZE = 100;

/**
 * `evidence_chain_steps.step_index` is `SMALLINT`, so the largest index the
 * column can hold is 32767 and a chain of more steps than that cannot be stored.
 * The schema states no upper CHECK, so the bound is enforced here.
 */
export const MAX_STEP_INDEX = 32767;

/* -------------------------------------------------------------------------- */
/* Composition: the validation funnel, pure and database-free                  */
/* -------------------------------------------------------------------------- */

const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `\u0000` cannot appear in a Postgres text value, so it is a safe key joiner. */
const SEP = '\u0000';

const recordKey = (ref: SourceRef): string => `${ref.type}${SEP}${ref.id}`;

const citationKey = (ref: SourceRef, field: string): string =>
  `${ref.type}${SEP}${ref.id}${SEP}${field}`;

/**
 * The operations whose operand count is fixed beyond doubt. Everything else —
 * `sum`, `add`, `multiply`, `round_half_up`, `select` — is left to the replay
 * interpreter of task 9.2, because design.md fixes no arity table and a guess
 * here would reject a legitimate chain. `sum` over a single operand is a real
 * shape: SET-9281 step 2 sums one Refund line.
 */
const FIXED_ARITY: ReadonlyMap<EvidenceOperation, number> = new Map<EvidenceOperation, number>([
  ['subtract', 2],
  ['divide', 2],
  ['negate', 1],
  ['compare', 2],
]);

/** ISO-8601 UTC to millisecond precision, or a rejection naming the field. */
function assertIsoUtcMs(value: string, what: string): string {
  if (typeof value !== 'string' || !ISO_UTC_MS.test(value)) {
    throw new EvidenceChainError(
      `${what} must be ISO-8601 UTC to millisecond precision ` +
        `(YYYY-MM-DDTHH:MM:SS.sssZ), got ${JSON.stringify(value)}`,
    );
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new EvidenceChainError(`${what} is not a real instant: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertNonEmpty(value: string, what: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EvidenceChainError(`${what} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function assertKnownType(type: SourceRecordType, what: string): SourceRecordType {
  if (!(SOURCE_RECORD_TYPES as readonly string[]).includes(type)) {
    throw new EvidenceChainError(
      `${what} is not a source_record_type label: ${JSON.stringify(type)}`,
    );
  }
  return type;
}

/**
 * Deduplicate and order the citations, and derive `as_of`.
 *
 * Two citations of the same `(record, field)` carrying the same timestamp are one
 * citation — one `evidence_chain_sources` row, which is all the primary key
 * admits — so the repeat is collapsed rather than rejected: a tool that reads one
 * field in two steps has done nothing wrong. Two citations of the same
 * `(record, field)` carrying **different** timestamps are a contradiction about
 * one record and are rejected, because silently keeping either one would make
 * `as_of` and the stale indicator depend on argument order.
 */
function collectCitations(input: EvidenceChainInput): {
  readonly citations: readonly EvidenceSourceCitation[];
  readonly sources: readonly SourceRef[];
  readonly as_of: string;
} {
  if (input.sources.length === 0) {
    // `source_count >= 1` is a database CHECK, but an ungrounded figure is the
    // exact failure this system exists to prevent, so it never reaches a
    // statement (Requirement 12.2).
    throw new EvidenceChainError(
      'an Evidence_Chain must cite at least 1 Source_Record; a figure with no source is ' +
        'ungrounded and `evidence_chains.source_count >= 1` would reject it anyway',
    );
  }

  const byKey = new Map<string, EvidenceSourceCitation>();
  const firstSeen = new Map<string, SourceRef>();
  let newest = '';

  for (const [position, citation] of input.sources.entries()) {
    const where = `sources[${position}]`;
    assertKnownType(citation.ref.type, `${where}.ref.type`);
    assertNonEmpty(citation.ref.id, `${where}.ref.id`);
    assertNonEmpty(citation.field, `${where}.field`);
    const updatedAt = assertIsoUtcMs(citation.record_updated_at, `${where}.record_updated_at`);

    const key = citationKey(citation.ref, citation.field);
    const existing = byKey.get(key);
    if (existing !== undefined && existing.record_updated_at !== updatedAt) {
      throw new EvidenceChainError(
        `${where} cites ${citation.ref.type} ${citation.ref.id} field ${citation.field} with ` +
          `record_updated_at ${updatedAt}, but the same citation already carries ` +
          `${existing.record_updated_at}; one Source_Record field has one update timestamp, and ` +
          `as_of and the stale indicator must not depend on argument order`,
      );
    }
    if (existing === undefined) {
      byKey.set(key, {
        ref: { type: citation.ref.type, id: citation.ref.id },
        field: citation.field,
        record_updated_at: updatedAt,
      });
    }

    const record = recordKey(citation.ref);
    if (!firstSeen.has(record)) {
      firstSeen.set(record, { type: citation.ref.type, id: citation.ref.id });
    }
    // ISO-8601 UTC at fixed precision compares lexicographically as it does
    // chronologically, so the newest is a string maximum.
    if (updatedAt > newest) {
      newest = updatedAt;
    }
  }

  const citations = [...byKey.values()].sort((a, b) =>
    citationKey(a.ref, a.field) < citationKey(b.ref, b.field) ? -1 : 1,
  );

  return { citations, sources: [...firstSeen.values()], as_of: newest };
}

/**
 * Steps: gapless 1-based indexes, backward-only step references, every source
 * operand cited, every monetary result in range, and the terminal result equal to
 * the presented figure.
 *
 * The first two are FINDING 2 in the migration: the schema accepts indexes
 * `(1, 2, 5)` and a step 3 whose operand cites step 7, and either shape leaves a
 * replay with no value to read, so P6 would be *undefined* rather than failing.
 */
function assertStepsWellFormed(
  input: EvidenceChainInput,
  cited: ReadonlySet<string>,
): void {
  if (input.steps.length === 0) {
    throw new EvidenceChainError(
      'an Evidence_Chain must state at least 1 computation step; the figure is the result of ' +
        'the terminal step and there is nothing to replay without one',
    );
  }
  if (input.steps.length > MAX_STEP_INDEX) {
    throw new EvidenceChainError(
      `an Evidence_Chain may hold at most ${MAX_STEP_INDEX} steps, got ${input.steps.length}: ` +
        `evidence_chain_steps.step_index is SMALLINT`,
    );
  }

  for (const [position, step] of input.steps.entries()) {
    const expected = position + 1;
    if (step.index !== expected) {
      throw new EvidenceChainError(
        `step at position ${position} declares index ${step.index}, expected ${expected}: ` +
          `step indexes are 1-based and gapless, in order. The schema constrains step_index >= 1 ` +
          `and uniqueness only, so a gap would store and then replay to nothing`,
      );
    }
    if (!(EVIDENCE_OPERATIONS as readonly string[]).includes(step.operation)) {
      throw new EvidenceChainError(
        `step ${step.index} states operation ${JSON.stringify(step.operation)}, which is not an ` +
          `evidence_operation label`,
      );
    }
    if (step.operands.length === 0) {
      throw new EvidenceChainError(`step ${step.index} states no operands`);
    }
    const arity = FIXED_ARITY.get(step.operation);
    if (arity !== undefined && step.operands.length !== arity) {
      throw new EvidenceChainError(
        `step ${step.index} states operation ${step.operation} with ${step.operands.length} ` +
          `operands, which takes exactly ${arity}`,
      );
    }

    for (const [operandPosition, operand] of step.operands.entries()) {
      const where = `step ${step.index} operand ${operandPosition}`;
      switch (operand.kind) {
        case 'source': {
          assertKnownType(operand.ref.type, `${where}.ref.type`);
          assertNonEmpty(operand.ref.id, `${where}.ref.id`);
          assertNonEmpty(operand.field, `${where}.field`);
          if (!cited.has(citationKey(operand.ref, operand.field))) {
            throw new EvidenceChainError(
              `${where} reads ${operand.ref.type} ${operand.ref.id} field ${operand.field}, ` +
                `which the chain does not cite; Requirement 12.2 wants every contributing ` +
                `Source_Record identifier in the Evidence_Chain, and a replay of this step has ` +
                `no row to read from`,
            );
          }
          break;
        }
        case 'step': {
          if (!Number.isSafeInteger(operand.index) || operand.index < 1) {
            throw new EvidenceChainError(
              `${where} references step index ${operand.index}, which is not a 1-based ordinal`,
            );
          }
          if (operand.index >= step.index) {
            throw new EvidenceChainError(
              `${where} references step ${operand.index}, which is not a *preceding* step: ` +
                `operands may cite lower step indexes only. The schema does not constrain this ` +
                `(FINDING 2), and a forward reference leaves a replay with no value to read`,
            );
          }
          break;
        }
        case 'literal': {
          if (typeof operand.value !== 'string') {
            throw new EvidenceChainError(
              `${where} carries a non-string literal ${JSON.stringify(operand.value)}: a ` +
                `monetary literal in JSONB must be a string, because a JSON numeric literal ` +
                `parses back through an IEEE-754 double`,
            );
          }
          break;
        }
        default: {
          // Reachable from untyped input, and from a JSONB round trip.
          const kind: string = (operand as { kind: string }).kind;
          throw new EvidenceChainError(`${where} states an unknown operand kind ${JSON.stringify(kind)}`);
        }
      }
    }

    if (step.result_paise !== null) {
      // The single shared paise guard. Raises rather than saturating.
      assertInRange(step.result_paise);
    }
  }

  const terminal = input.steps[input.steps.length - 1];
  if (terminal === undefined || terminal.result_paise === null) {
    throw new EvidenceChainError(
      'the terminal step of an Evidence_Chain must carry a monetary result: ' +
        'evidence_chains.figure_paise is NOT NULL and Requirement 12.8 replays the whole ' +
        'ordered step list to reproduce it',
    );
  }
  if (terminal.result_paise !== input.figure_paise) {
    throw new EvidenceChainError(
      `figure_paise ${input.figure_paise} is not the result of terminal step ` +
        `${terminal.index} (${terminal.result_paise}); replaying every step reproduces the ` +
        `terminal result, so a figure taken from an intermediate step is unreachable by replay ` +
        `(Requirement 12.8). Persist the prefix ending at that step instead`,
    );
  }
}

/**
 * Validate and stage one chain. **Pure**: no statement, no clock, no database.
 *
 * Every rejection this can raise happens here, before {@link EvidenceChainBuilder.build}
 * issues anything, so a malformed chain leaves no partial rows to roll back.
 *
 * @throws {EvidenceChainError} for any invariant in the module doc's
 * "this module only" column, and for an absent citation, an unknown operation, or
 * a bad timestamp.
 * @throws {PaiseRangeError} for a `result_paise` or `figure_paise` outside the
 * paise range (Requirement 15.1, 15.8).
 */
export function composeEvidenceChain(input: EvidenceChainInput): EvidenceChainDraft {
  assertNonEmpty(input.produced_by, 'produced_by');
  assertInRange(input.figure_paise);

  const { citations, sources, as_of } = collectCitations(input);
  const cited = new Set(citations.map((c) => citationKey(c.ref, c.field)));
  assertStepsWellFormed(input, cited);

  return {
    produced_by: input.produced_by,
    figure_paise: input.figure_paise,
    // A count of distinct identifiers, not of citation rows: SET-9281 cites 14
    // (record, field) pairs across 8 identifiers and its source_count is 8.
    source_count: sources.length,
    as_of,
    steps: input.steps,
    sources,
    citations,
  };
}

/**
 * Requirement 12.3's result, from the Source_Records that could not be read.
 *
 * Counts are of **distinct identifiers**, so a record whose absence was noticed
 * twice counts once, and the entries are ordered by `source_record_type` enum
 * order so the result is deterministic. Exported because a tool may discover
 * unreadable records without ever reaching {@link EvidenceChainBuilder.build} —
 * for instance when the first read fails.
 */
export function incompleteEvidence(unreadable: readonly SourceRef[]): IncompleteEvidence {
  if (unreadable.length === 0) {
    throw new EvidenceChainError(
      'incomplete_evidence must identify at least 1 unavailable Source_Record type with its ' +
        'count (Requirement 12.3)',
    );
  }
  const distinct = new Map<string, SourceRef>();
  for (const [position, ref] of unreadable.entries()) {
    assertKnownType(ref.type, `unreadable[${position}].type`);
    assertNonEmpty(ref.id, `unreadable[${position}].id`);
    distinct.set(recordKey(ref), ref);
  }
  const counts = new Map<SourceRecordType, number>();
  for (const ref of distinct.values()) {
    counts.set(ref.type, (counts.get(ref.type) ?? 0) + 1);
  }
  const unavailable = SOURCE_RECORD_TYPES.filter((type) => counts.has(type)).map((type) => ({
    type,
    count: counts.get(type) ?? 0,
  }));
  return { ok: false, kind: 'incomplete_evidence', unavailable };
}

/* -------------------------------------------------------------------------- */
/* Persistence seam                                                           */
/* -------------------------------------------------------------------------- */

/**
 * One `evidence_chain_steps` row.
 *
 * `step_index` is the column name; the in-memory field is `index`
 * ({@link EvidenceStep}). `operands_json` is the JSON **text** of the operand
 * array, ready for the `JSONB` column — the adapter casts, it does not build.
 * `result_paise` is an integer string or `null`, never a number.
 */
export interface EvidenceChainStepWrite {
  readonly step_index: number;
  readonly operation: EvidenceOperation;
  readonly operands_json: string;
  readonly result_paise: PaiseWire | null;
  readonly note: string | null;
}

/** One `evidence_chain_sources` row. `field` is never null (FINDING 4). */
export interface EvidenceChainSourceWrite {
  readonly tenant_id: TenantId;
  readonly source_record_type: SourceRecordType;
  readonly source_record_id: string;
  readonly field: string;
  readonly record_updated_at: string;
}

/**
 * One whole chain: the header, every step, every citation. The complete unit of
 * work, so the store writes it in a single transaction and an aborted insert
 * leaves nothing — the `ingestion-service` precedent, where a run is staged and
 * committed once.
 *
 * `figure_paise` is an integer string produced by `toWire`, which range-checked
 * it. `source_count` already equals the number of distinct identifiers among
 * `sources`, and `as_of` is already the newest `record_updated_at`; both are
 * stated because the schema stores them (FINDING 3: nothing in the database ties
 * them to the rows).
 */
export interface EvidenceChainWrite {
  readonly tenant_id: TenantId;
  readonly figure_paise: PaiseWire;
  readonly source_count: number;
  readonly as_of: string;
  readonly produced_by: string;
  readonly steps: readonly EvidenceChainStepWrite[];
  readonly sources: readonly EvidenceChainSourceWrite[];
}

/**
 * The name of the grounding CHECK on `evidence_chains`:
 * `CHECK (source_count >= 1)`, which Postgres names after the table and column.
 *
 * Declared so every store adapter matches the same string and matches it **by
 * name**, exactly as `LEDGER_SET_DERIVATION_UNIQ` is matched in
 * `src/ledger/semantic-ledger.ts`. A store that read any SQLSTATE `23514` as
 * "ungrounded figure" would report an unrelated check violation — a `paise`
 * domain range, say — as one, and a rename must break loudly rather than be
 * quietly reinterpreted.
 */
export const EVIDENCE_SOURCE_COUNT_CHECK = 'evidence_chains_source_count_check';

/**
 * What a store reports back from an insert.
 *
 * The grounding rejection arrives as a **value** so it funnels into one place in
 * the service rather than being caught in two, matching the `LedgerWriteOutcome`
 * pattern in `src/ledger/semantic-ledger.ts`. It is unreachable from
 * {@link EvidenceChainBuilder.build}, which rejects an uncited figure before any
 * statement; reaching it means the store built a header the draft did not
 * describe, which is a store fault. Anything else — a connection fault, a
 * duplicate `(chain_id, step_index)`, a `paise` range violation — is a failure
 * and the store throws.
 */
export type EvidenceChainWriteOutcome =
  | { readonly ok: true; readonly chain_id: string }
  | {
      readonly ok: false;
      readonly kind: 'ungrounded_figure';
      readonly constraint: typeof EVIDENCE_SOURCE_COUNT_CHECK;
    };

/** One `evidence_chains` row. Money arrives as an integer string, never a number. */
export interface EvidenceChainHeaderRow {
  readonly chain_id: string;
  readonly figure_paise: PaiseWire;
  readonly source_count: number;
  /** ISO-8601 UTC, ms precision. */
  readonly as_of: string;
  readonly produced_by: string;
}

/**
 * One `evidence_chain_steps` row as read back.
 *
 * `operands` is the **parsed** JSONB value, of unknown shape: `JSONB` reorders
 * object keys and normalises whitespace, so nothing may assume the text came back
 * as it went in. {@link parseEvidenceOperands} validates the structure.
 */
export interface EvidenceChainStepRow {
  readonly step_index: number;
  readonly operation: EvidenceOperation;
  readonly operands: unknown;
  readonly result_paise: PaiseWire | null;
  readonly note: string | null;
}

/**
 * One page row: one **distinct Source_Record identifier**, with every field the
 * chain cited for it and the newest `record_updated_at` among them.
 *
 * Grouping happens in SQL because that is what makes `source_count` — a count of
 * identifiers — equal the number of rows across every page.
 */
export interface EvidenceSourceRow {
  readonly source_record_type: SourceRecordType;
  readonly source_record_id: string;
  /** Ascending. At least 1 (`field` is part of the primary key). */
  readonly fields: readonly string[];
  /** ISO-8601 UTC, ms precision: `max(record_updated_at)` for this identifier. */
  readonly record_updated_at: string;
}

/** The identity key of the last row of a page: where the next page resumes. */
export interface EvidenceSourceCursor {
  readonly type: SourceRecordType;
  readonly id: string;
}

/** One keyset page request. `after` is exclusive. */
export interface EvidenceSourcePageQuery {
  readonly tenant_id: TenantId;
  readonly chain_id: string;
  readonly after: EvidenceSourceCursor | null;
  /**
   * How many rows to return. The service asks for one more than the page size so
   * it can tell "page full" from "more rows exist" without a second query, so an
   * adapter may see `MAX_SOURCE_PAGE_SIZE + 1` here. The **page** it returns is
   * still capped at {@link MAX_SOURCE_PAGE_SIZE}.
   */
  readonly limit: number;
}

/**
 * Persistence for Evidence_Chains. Injected rather than imported, so composition
 * and retrieval are unit-testable with no database and the transaction boundary
 * is the adapter's concern.
 *
 * **There is no PostgREST adapter here, deliberately**, for the same reason
 * `LedgerStore` has none: a chain is three inserts — header, steps, citations —
 * and PostgREST gives each request its own transaction, so a half-written chain
 * would be reachable, which is precisely what Requirement 12.3 forbids. And all
 * three tables are `FORCE ROW LEVEL SECURITY` with no policies until task 26.1,
 * so PostgREST matches zero rows for every role today regardless.
 * `test/db/evidence-chain.test.ts` implements this interface over a real
 * transactional SQL session, which is where atomicity is actually proven.
 *
 * Two contracts every adapter owes:
 *
 * 1. **Timestamps in, timestamps out, are ISO-8601 UTC with millisecond
 *    precision.** `TIMESTAMPTZ` renders in the session time zone by default, and
 *    a value like `2026-07-28 00:00:00+00` is not what this module parses. Select
 *    it as `to_char(x AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.
 * 2. **`listSteps` must qualify through `evidence_chains`.**
 *    `evidence_chain_steps` carries no `tenant_id` (FINDING 1), so the only
 *    tenant scope available to it is the header's. The service also calls
 *    {@link findChain} first, but the scoping must not depend on the service
 *    getting the order right.
 */
export interface EvidenceChainStore {
  /**
   * Write the header, every step and every citation in one transaction.
   *
   * A `source_count >= 1` violation — SQLSTATE `23514` with constraint
   * {@link EVIDENCE_SOURCE_COUNT_CHECK}, and only that name — is reported as
   * `{ ok: false, kind: 'ungrounded_figure' }`. Any other error throws.
   */
  insertChain(write: EvidenceChainWrite): Promise<EvidenceChainWriteOutcome>;

  /**
   * The header for `chainId` within this Tenant, or `null`.
   *
   * `null` covers both "no such chain" and "not this Tenant's chain", and the two
   * are indistinguishable on purpose: an error that distinguished them would
   * confirm the existence of another Tenant's chain (Requirement 14.4).
   */
  findChain(tenantId: TenantId, chainId: string): Promise<EvidenceChainHeaderRow | null>;

  /** Every step of `chainId`, ascending by `step_index`. See contract 2 above. */
  listSteps(tenantId: TenantId, chainId: string): Promise<readonly EvidenceChainStepRow[]>;

  /**
   * One keyset page of distinct Source_Record identifiers.
   *
   * Ordered by `source_record_type` then `source_record_id`, both as text under
   * the `C` collation, ascending — a total order over the identity key, so no
   * identifier can be dropped or repeated across pages. The same collated
   * expressions must appear in the `after` comparison as in the `ORDER BY`, or
   * the keyset and the order disagree.
   */
  listSourcePage(query: EvidenceSourcePageQuery): Promise<readonly EvidenceSourceRow[]>;
}

/* -------------------------------------------------------------------------- */
/* Write mapping                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A validated draft as rows. The single place `index` becomes `step_index` and
 * the single place a `Paise` becomes an integer string, through `toWire`, which
 * range-checks it (Requirement 15.1, 15.8).
 */
export function evidenceChainWriteFor(
  tenantId: TenantId,
  draft: EvidenceChainDraft,
): EvidenceChainWrite {
  return {
    tenant_id: tenantId,
    figure_paise: toWire(draft.figure_paise),
    source_count: draft.source_count,
    as_of: draft.as_of,
    produced_by: draft.produced_by,
    steps: draft.steps.map((step) => ({
      step_index: step.index,
      operation: step.operation,
      // JSON text for the JSONB column. Not asserted on after a round trip:
      // Postgres reorders keys and normalises whitespace.
      operands_json: JSON.stringify(step.operands),
      result_paise: step.result_paise === null ? null : toWire(step.result_paise),
      note: step.note ?? null,
    })),
    sources: draft.citations.map((citation) => ({
      tenant_id: tenantId,
      source_record_type: citation.ref.type,
      source_record_id: citation.ref.id,
      field: citation.field,
      record_updated_at: citation.record_updated_at,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Read mapping                                                               */
/* -------------------------------------------------------------------------- */

function operandFrom(value: unknown, where: string): EvidenceOperand {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EvidenceChainError(`${where} is not an operand object: ${JSON.stringify(value)}`);
  }
  const record = value as Record<string, unknown>;
  switch (record['kind']) {
    case 'source': {
      const ref = record['ref'];
      if (typeof ref !== 'object' || ref === null) {
        throw new EvidenceChainError(`${where} carries no source ref`);
      }
      const { type, id } = ref as Record<string, unknown>;
      if (typeof type !== 'string' || typeof id !== 'string' || typeof record['field'] !== 'string') {
        throw new EvidenceChainError(`${where} carries a malformed source ref`);
      }
      assertKnownType(type as SourceRecordType, `${where}.ref.type`);
      return { kind: 'source', ref: { type: type as SourceRecordType, id }, field: record['field'] };
    }
    case 'step': {
      const index = record['index'];
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 1) {
        throw new EvidenceChainError(`${where} carries a step index that is not a 1-based ordinal`);
      }
      return { kind: 'step', index };
    }
    case 'literal': {
      const literal = record['value'];
      if (typeof literal !== 'string') {
        // A JSONB numeric literal read back through a double is the hazard the
        // string encoding exists to prevent, so it is rejected rather than coerced.
        throw new EvidenceChainError(
          `${where} carries a non-string literal ${JSON.stringify(literal)}`,
        );
      }
      return { kind: 'literal', value: literal };
    }
    default:
      throw new EvidenceChainError(
        `${where} states an unknown operand kind ${JSON.stringify(record['kind'])}`,
      );
  }
}

/**
 * The `operands` JSONB value of one step, validated structurally.
 *
 * Exported because it is the boundary where a stored chain becomes a typed one:
 * an operand shape design.md does not define is rejected rather than handed to a
 * replay that would have to guess.
 */
export function parseEvidenceOperands(
  value: unknown,
  where: string,
): readonly EvidenceOperand[] {
  if (!Array.isArray(value)) {
    throw new EvidenceChainError(`${where} operands is not a JSON array`);
  }
  if (value.length === 0) {
    throw new EvidenceChainError(`${where} operands is empty`);
  }
  return value.map((operand, position) => operandFrom(operand, `${where} operand ${position}`));
}

/* -------------------------------------------------------------------------- */
/* Retrieval shapes                                                           */
/* -------------------------------------------------------------------------- */

/** One retrieved Source_Record identifier, with what the stale indicator needs. */
export interface EvidenceSourceEntry {
  readonly ref: SourceRef;
  /** Every field the chain cited for this record, ascending. */
  readonly fields: readonly string[];
  /** The record's update timestamp as the chain recorded it. */
  readonly record_updated_at: string;
  /** The chain's `as_of`, repeated so the comparison travels with the row. */
  readonly as_of: string;
  /** `record_updated_at > as_of` (Requirement 12.5). See the module doc comment. */
  readonly stale: boolean;
}

/** One page of at most {@link MAX_SOURCE_PAGE_SIZE} identifiers. */
export interface EvidenceSourcePage {
  /** 1-based. */
  readonly page_index: number;
  readonly page_size: number;
  readonly sources: readonly EvidenceSourceEntry[];
  /** Where the next page resumes, or `null` when this is the last page. */
  readonly next: EvidenceSourceCursor | null;
  /** `evidence_chains.source_count`: the total across every page. */
  readonly source_count: number;
}

/**
 * A retrieved chain: the header, every step in order, and the first page of
 * identifiers. Further pages come from
 * {@link EvidenceChainBuilder.sourcePage} / {@link EvidenceChainBuilder.sourcePages}.
 */
export interface EvidenceChainView {
  readonly evidence_chain_id: string;
  readonly figure_paise: Paise;
  readonly source_count: number;
  readonly as_of: string;
  readonly produced_by: string;
  readonly steps: readonly EvidenceStep[];
  readonly first_page: EvidenceSourcePage;
}

/* -------------------------------------------------------------------------- */
/* The builder                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Compose, persist and retrieve Evidence_Chains for **one** Tenant.
 *
 * No method takes a `tenant_id`: it is bound once at construction from the
 * session context, so an unscoped read or write is not expressible
 * (Requirement 12.7, 14.10).
 */
export interface EvidenceChainBuilder {
  /**
   * Compose one chain and persist it, or return `incomplete_evidence` with the
   * figure omitted (Requirement 12.2, 12.3).
   *
   * @throws {EvidenceChainError} for a malformed chain — nothing is written, and
   * no statement is issued.
   */
  build(input: EvidenceChainInput): Promise<EvidenceChainResult>;

  /**
   * The header, the ordered steps and the first page of identifiers, or `null`
   * when this Tenant has no such chain. Absent and another Tenant's are the same
   * answer.
   */
  read(chainId: string, pageSize?: number): Promise<EvidenceChainView | null>;

  /**
   * One page of at most {@link MAX_SOURCE_PAGE_SIZE} identifiers, resuming after
   * `cursor`. `null` when this Tenant has no such chain.
   */
  sourcePage(
    chainId: string,
    cursor?: EvidenceSourceCursor | null,
    pageSize?: number,
  ): Promise<EvidenceSourcePage | null>;

  /**
   * Every page in order, so a caller can concatenate them without driving the
   * cursor itself. Yields nothing for an absent chain.
   */
  sourcePages(chainId: string, pageSize?: number): AsyncIterableIterator<EvidenceSourcePage>;
}

export interface EvidenceChainBuilderDeps {
  readonly store: EvidenceChainStore;
  /** The session Tenant. Never an argument to a method (Requirement 12.7). */
  readonly tenantId: TenantId;
}

function assertPageSize(pageSize: number): number {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_SOURCE_PAGE_SIZE) {
    throw new EvidenceChainError(
      `a source page holds 1..${MAX_SOURCE_PAGE_SIZE} identifiers (Requirement 12.2), ` +
        `got ${pageSize}`,
    );
  }
  return pageSize;
}

export function createEvidenceChainBuilder(
  deps: EvidenceChainBuilderDeps,
): EvidenceChainBuilder {
  const { store } = deps;

  if (!UUID_RE.test(deps.tenantId)) {
    throw new EvidenceChainError(
      `createEvidenceChainBuilder requires the session Tenant identifier as a UUID, got ` +
        `${JSON.stringify(deps.tenantId)}; an unscoped evidence read or write must be ` +
        `impossible to issue by accident`,
    );
  }
  const tenantId = deps.tenantId;

  function requireChainId(chainId: string, operation: string): string {
    if (!UUID_RE.test(chainId)) {
      // Says nothing about existence: a malformed identifier is a caller fault,
      // and every well-formed one that is not this Tenant's answers `null`.
      throw new EvidenceChainError(
        `${operation} requires an Evidence_Chain identifier as a UUID, got ` +
          `${JSON.stringify(chainId)}`,
      );
    }
    return chainId;
  }

  /** Steps in `step_index` order, decoded and re-checked for gaplessness. */
  function stepsFrom(
    chainId: string,
    rows: readonly EvidenceChainStepRow[],
  ): readonly EvidenceStep[] {
    if (rows.length === 0) {
      throw new EvidenceChainError(
        `Evidence_Chain ${chainId} has a header but no computation steps; there is nothing to ` +
          `replay (Requirement 12.8)`,
      );
    }
    const ordered = [...rows].sort((a, b) => a.step_index - b.step_index);
    return ordered.map((row, position) => {
      const expected = position + 1;
      if (row.step_index !== expected) {
        // FINDING 2 again, from the read side: the schema admits (1, 2, 5), and a
        // gap must fail loudly rather than be replayed as if contiguous.
        throw new EvidenceChainError(
          `Evidence_Chain ${chainId} step indexes are not gapless 1..n: found ` +
            `${row.step_index} where ${expected} was expected`,
        );
      }
      const where = `Evidence_Chain ${chainId} step ${row.step_index}`;
      const step: EvidenceStep = {
        index: row.step_index,
        operation: row.operation,
        operands: parseEvidenceOperands(row.operands, where),
        result_paise:
          row.result_paise === null ? null : fromWire(row.result_paise, `${where} result_paise`),
        ...(row.note === null ? {} : { note: row.note }),
      };
      return step;
    });
  }

  function entryFrom(row: EvidenceSourceRow, asOf: string): EvidenceSourceEntry {
    const updatedAt = assertIsoUtcMs(row.record_updated_at, 'record_updated_at');
    return {
      ref: { type: row.source_record_type, id: row.source_record_id },
      fields: row.fields,
      record_updated_at: updatedAt,
      as_of: asOf,
      // Both sides are ISO-8601 UTC at fixed precision, so the string comparison
      // is the chronological one.
      stale: updatedAt > asOf,
    };
  }

  async function pageFor(
    header: EvidenceChainHeaderRow,
    cursor: EvidenceSourceCursor | null,
    pageSize: number,
    pageIndex: number,
  ): Promise<EvidenceSourcePage> {
    // One row more than the page, so "the page is full" and "more rows exist" are
    // distinguishable without a second query and without a trailing empty page.
    const rows = await store.listSourcePage({
      tenant_id: tenantId,
      chain_id: header.chain_id,
      after: cursor,
      limit: pageSize + 1,
    });
    const kept = rows.slice(0, pageSize);
    const overflow = rows[pageSize];
    const last = kept[kept.length - 1];
    return {
      page_index: pageIndex,
      page_size: pageSize,
      sources: kept.map((row) => entryFrom(row, header.as_of)),
      next:
        overflow === undefined || last === undefined
          ? null
          : { type: last.source_record_type, id: last.source_record_id },
      source_count: header.source_count,
    };
  }

  return {
    async build(input: EvidenceChainInput): Promise<EvidenceChainResult> {
      // Requirement 12.3 first: an unreadable contributing record means the figure
      // is omitted, so no chain is composed and no statement is issued at all.
      if (input.unreadable !== undefined && input.unreadable.length > 0) {
        return incompleteEvidence(input.unreadable);
      }

      // Pure, and everything it rejects it rejects before any statement.
      const draft = composeEvidenceChain(input);

      const outcome = await store.insertChain(evidenceChainWriteFor(tenantId, draft));
      if (!outcome.ok) {
        // Unreachable from here: `composeEvidenceChain` rejects a chain with no
        // citation. Reaching it means the store built a header the draft did not
        // describe, which is a store fault and has no result shape.
        throw new EvidenceChainError(
          `the store rejected the Evidence_Chain on ${outcome.constraint}: source_count ` +
            `${draft.source_count} was refused as ungrounded, which the composition funnel ` +
            `already excludes`,
        );
      }

      return {
        ok: true,
        evidence: {
          evidence_chain_id: outcome.chain_id,
          figure_paise: draft.figure_paise,
          sources: draft.sources,
          source_count: draft.source_count,
          steps: draft.steps,
          as_of: draft.as_of,
          produced_by: draft.produced_by,
        },
      };
    },

    async read(
      chainId: string,
      pageSize: number = MAX_SOURCE_PAGE_SIZE,
    ): Promise<EvidenceChainView | null> {
      requireChainId(chainId, 'read');
      const size = assertPageSize(pageSize);

      // The Tenant gate. Every step and source read below is issued only for a
      // header this Tenant owns — which is the whole tenant scope available to
      // `evidence_chain_steps`, since it carries no `tenant_id` (FINDING 1).
      const header = await store.findChain(tenantId, chainId);
      if (header === null) {
        return null;
      }

      const steps = stepsFrom(header.chain_id, await store.listSteps(tenantId, header.chain_id));
      const firstPage = await pageFor(header, null, size, 1);

      return {
        evidence_chain_id: header.chain_id,
        figure_paise: fromWire(header.figure_paise, 'figure_paise'),
        source_count: header.source_count,
        as_of: assertIsoUtcMs(header.as_of, 'as_of'),
        produced_by: header.produced_by,
        steps,
        first_page: firstPage,
      };
    },

    async sourcePage(
      chainId: string,
      cursor: EvidenceSourceCursor | null = null,
      pageSize: number = MAX_SOURCE_PAGE_SIZE,
    ): Promise<EvidenceSourcePage | null> {
      requireChainId(chainId, 'sourcePage');
      const size = assertPageSize(pageSize);
      const header = await store.findChain(tenantId, chainId);
      if (header === null) {
        return null;
      }
      // Page index is unknown for an arbitrary cursor, and a wrong number would be
      // worse than an honest 1. Callers wanting the sequence use `sourcePages`.
      return pageFor(header, cursor, size, 1);
    },

    async *sourcePages(
      chainId: string,
      pageSize: number = MAX_SOURCE_PAGE_SIZE,
    ): AsyncIterableIterator<EvidenceSourcePage> {
      requireChainId(chainId, 'sourcePages');
      const size = assertPageSize(pageSize);
      const header = await store.findChain(tenantId, chainId);
      if (header === null) {
        return;
      }
      let cursor: EvidenceSourceCursor | null = null;
      let pageIndex = 1;
      for (;;) {
        const page: EvidenceSourcePage = await pageFor(header, cursor, size, pageIndex);
        yield page;
        if (page.next === null) {
          return;
        }
        cursor = page.next;
        pageIndex += 1;
      }
    },
  };
}
