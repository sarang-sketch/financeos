/**
 * The tool boundary on the wire (task 29.3).
 * Requirements 15.1, 15.8 — the money wire contract; 12.7 and 12.9 for the two
 * shapes this boundary is not allowed to have.
 *
 * This is the first of design.md's "three places money crosses": the tool input a
 * Python Agent posts to `POST /internal/tools/{tool_name}`, and the
 * `ToolResult<Out>` envelope that comes back — including `figure_paise` on the
 * Evidence_Chain and `result_paise` on every {@link evidenceStepWire}.
 *
 * ## These mirror the production types; they do not invent shapes
 *
 * Every schema here is the wire projection of a type that already exists:
 * `EvidenceStep`, `EvidenceChain` and `IncompleteEvidence` from
 * `@/evidence/chain-builder`, `SchemaViolation`, `ToolFailure`,
 * `UnauthorizedWrite` and `ToolResult<T>` from `@/tools/tool`, and
 * `post_reconciliation_adjustment`'s input and output from its own module. The
 * closed sets — `SOURCE_RECORD_TYPES`, `EVIDENCE_OPERATIONS`, `TOOL_NAME_RE`,
 * `MAX_SOURCE_PAGE_SIZE` — are **imported**, not transcribed, so a label added on
 * one side cannot be missing on the other.
 *
 * The one difference is the only one that matters: in process a `Paise` is a
 * `bigint` and the in-process tool schemas declare `z.bigint()`. On the wire it is
 * {@link paiseWire} — a decimal string — because `JSON.stringify` throws on a
 * `bigint` and `JSON.parse` produces a double for every numeric literal
 * (Requirement 15.1, 15.8). That conversion is the whole reason this module is
 * separate from `@/tools/*` rather than folded into it.
 *
 * ## What is deliberately absent
 *
 * - **`tenant_id`.** It is not an argument at any depth (Requirement 12.7), and
 *   design.md's internal-endpoint contract rejects a body-supplied one as a
 *   schema violation rather than ignoring it. Every object here is
 *   `z.strictObject`, so a smuggled `tenant_id` is an unrecognised key and is
 *   named in the rejection. The endpoint that enforces this is task 29.5; the
 *   schema that makes it possible is here.
 * - **A coercing string.** Never `z.coerce.string()`. See `./paise-schema.ts`.
 *
 * ## Scope
 *
 * The tool-side coverage is `post_reconciliation_adjustment`, which is the only
 * tool in the catalogue carrying money in its **input** as well as its output, so
 * it is the one that exercises both directions of the contract. The envelope
 * itself is generic — {@link toolResultWire} takes any `Out` schema — so the
 * remaining catalogue entries need no new envelope when 29.5 wires them up. The
 * cross-runtime round-trip and the JSON-number rejection matrix are task 29.7.
 */

import { z } from 'zod';

import { EVIDENCE_OPERATIONS, MAX_SOURCE_PAGE_SIZE } from '@/evidence/chain-builder';
import { SOURCE_RECORD_TYPES } from '@/ledger/posting-rules';
import { TOOL_NAME_RE } from '@/tools/registry';

import { nullablePaiseWire, paiseWire } from './paise-schema';

/* -------------------------------------------------------------------------- */
/* Bounds, stated once                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `SourceRef.id` — a Razorpay identifier or a UUID, and nothing that needs
 * escaping in an Audit_Log payload. Same pattern as
 * `post_reconciliation_adjustment`'s own `SOURCE_RECORD_ID_RE`, which is private
 * to that module.
 */
const SOURCE_RECORD_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** `chart_of_accounts.account_code`: lower snake case, bounded. */
const ACCOUNT_CODE_RE = /^[a-z][a-z0-9_]{0,62}$/;

/** Requirement 2.1's 2..20 Ledger_Entries per set. */
const MIN_ENTRIES = 2;
const MAX_ENTRIES = 20;

/** `post_reconciliation_adjustment` takes at least 1 Source_Record link (Requirement 2.2). */
const MIN_SOURCE_REFS = 1;
const MAX_SOURCE_REFS = 50;

/* -------------------------------------------------------------------------- */
/* Evidence shapes                                                            */
/* -------------------------------------------------------------------------- */

/** `SourceRef` on the wire. Carries no money, so it is the same shape either side. */
export const sourceRefWire = z.strictObject({
  type: z.enum(SOURCE_RECORD_TYPES),
  id: z.string().regex(SOURCE_RECORD_ID_RE),
});

/**
 * `EvidenceOperand` on the wire.
 *
 * `literal.value` is a string in process too — a monetary literal is never a JSON
 * number, which is `@/evidence/chain-builder`'s rule and not a wire concession.
 * `step.index` is an ordinal, so it stays a number: the `_paise` suffix is what
 * marks money, and an ordinal does not carry it.
 */
export const evidenceOperandWire = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('source'),
    ref: sourceRefWire,
    field: z.string().min(1).max(128),
  }),
  z.strictObject({ kind: z.literal('step'), index: z.number().int().positive() }),
  z.strictObject({ kind: z.literal('literal'), value: z.string().min(1).max(128) }),
]);

/**
 * `EvidenceStep` on the wire.
 *
 * `result_paise` is {@link nullablePaiseWire}: `null` for a step with no single
 * monetary result — `compare` yields a boolean, `select` can pick a non-monetary
 * field — and a decimal string otherwise. Never a number, and never absent: a
 * step with no monetary result is a fact the wire states.
 */
export const evidenceStepWire = z.strictObject({
  index: z.number().int().positive(),
  operation: z.enum(EVIDENCE_OPERATIONS),
  operands: z.array(evidenceOperandWire).min(1),
  result_paise: nullablePaiseWire,
  note: z.string().min(1).max(500).optional(),
});

/**
 * `EvidenceChain` on the wire, including `produced_by`, which design.md's DDL has
 * and its TypeScript block omits.
 *
 * `sources` is capped at {@link MAX_SOURCE_PAGE_SIZE} because that is the page size
 * on retrieval (Requirement 12.2); a chain with more identifiers crosses the wire
 * one page at a time, so no single payload is unbounded.
 */
export const evidenceChainWire = z.strictObject({
  evidence_chain_id: z.uuid(),
  figure_paise: paiseWire,
  sources: z.array(sourceRefWire).min(1).max(MAX_SOURCE_PAGE_SIZE),
  source_count: z.number().int().positive(),
  steps: z.array(evidenceStepWire).min(1),
  as_of: z.iso.datetime(),
  produced_by: z.string().regex(TOOL_NAME_RE),
});

/* -------------------------------------------------------------------------- */
/* The four rejection variants of ToolResult<T>                               */
/* -------------------------------------------------------------------------- */

/**
 * Requirement 12.3's result. **There is no figure field** — the figure is omitted
 * entirely rather than sent as `0`, as `null`, or beside a count. That is a
 * property of this schema being `.strict()`: a figure smuggled in would be an
 * unrecognised key.
 */
export const incompleteEvidenceWire = z.strictObject({
  ok: z.literal(false),
  kind: z.literal('incomplete_evidence'),
  unavailable: z
    .array(
      z.strictObject({
        type: z.enum(SOURCE_RECORD_TYPES),
        count: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(SOURCE_RECORD_TYPES.length),
});

/** Requirement 12.9. One entry per non-conforming argument, named. Never empty. */
export const schemaViolationWire = z.strictObject({
  ok: z.literal(false),
  kind: z.literal('schema_violation'),
  violations: z
    .array(
      z.strictObject({
        argument: z.string().min(1).max(200),
        reason: z.string().min(1).max(500),
      }),
    )
    .min(1),
});

/**
 * Requirement 12.11. The distinction this variant carries across the process
 * boundary is the point of the Python client's longer deadline (task 29.5): "the
 * tool timed out and Tenant state is unchanged" is a different fact from "the
 * request never arrived", and only this shape states the first.
 */
export const toolFailureWire = z.strictObject({
  ok: z.literal(false),
  kind: z.literal('tool_failure'),
  tool: z.string().regex(TOOL_NAME_RE),
  cause: z.enum(['timeout', 'execution_error']),
});

/** Requirement 12.10. One reason, so a caller learns nothing about another Tenant. */
export const unauthorizedWriteWire = z.strictObject({
  ok: z.literal(false),
  kind: z.literal('unauthorized_write'),
  reason: z.literal('missing_authorized_proposal'),
});

/**
 * design.md's `ToolResult<Out>` on the wire, over any `Out` schema.
 *
 * A plain `z.union`, not a `z.discriminatedUnion`: the success variant has no
 * `kind` at all and discriminates on `ok`, which Zod's discriminated union cannot
 * key on across a branch that omits the field. The union is small and every
 * branch is `.strict()`, so the failure message still names the offending key.
 */
export function toolResultWire<Out extends z.ZodType>(value: Out) {
  return z.union([
    z.strictObject({ ok: z.literal(true), value, evidence: evidenceChainWire }),
    incompleteEvidenceWire,
    schemaViolationWire,
    toolFailureWire,
    unauthorizedWriteWire,
  ]);
}

/* -------------------------------------------------------------------------- */
/* post_reconciliation_adjustment, both directions                            */
/* -------------------------------------------------------------------------- */

/**
 * The wire form of `post_reconciliation_adjustment`'s input.
 *
 * The in-process schema declares `amount_paise: z.bigint().positive()`; here it is
 * a decimal string with the sign carried in the digits. The `> 0` bound is *not*
 * restated as a regex: a pattern that also excluded `0` and `-1` would be a second
 * spelling of the money format, and `./paise-schema.ts` exists so there is only
 * one. The positivity check belongs to the tool, which applies it after `fromWire`
 * with the range guard.
 */
export const postReconciliationAdjustmentInputWire = z.strictObject({
  entry_date: z.iso.date(),
  entries: z
    .array(
      z.strictObject({
        account_code: z.string().regex(ACCOUNT_CODE_RE),
        side: z.enum(['debit', 'credit']),
        amount_paise: paiseWire,
      }),
    )
    .min(MIN_ENTRIES)
    .max(MAX_ENTRIES),
  source_refs: z.array(sourceRefWire).min(MIN_SOURCE_REFS).max(MAX_SOURCE_REFS),
});

/** The wire form of `post_reconciliation_adjustment`'s output. Two figures, two chains. */
export const postReconciliationAdjustmentOutputWire = z.strictObject({
  set_id: z.uuid(),
  total_debit_paise: paiseWire,
  total_credit_paise: paiseWire,
  total_debit_evidence_chain_id: z.uuid(),
  total_debit_evidence_as_of: z.iso.datetime(),
  total_credit_evidence_chain_id: z.uuid(),
  total_credit_evidence_as_of: z.iso.datetime(),
});

/**
 * The whole envelope for that tool: the success variant carrying both output
 * figures and the Evidence_Chain, plus the four rejection variants.
 *
 * This is the concrete instance the field-typing audit walks, so `figure_paise`,
 * every `steps[].result_paise`, and both output totals are enumerated from a real
 * declaration rather than from a fixture written for the audit.
 */
export const postReconciliationAdjustmentResultWire = toolResultWire(
  postReconciliationAdjustmentOutputWire,
);

export type SourceRefWire = z.infer<typeof sourceRefWire>;
export type EvidenceStepWire = z.infer<typeof evidenceStepWire>;
export type EvidenceChainWire = z.infer<typeof evidenceChainWire>;
export type PostReconciliationAdjustmentInputWire = z.infer<
  typeof postReconciliationAdjustmentInputWire
>;
export type PostReconciliationAdjustmentOutputWire = z.infer<
  typeof postReconciliationAdjustmentOutputWire
>;
