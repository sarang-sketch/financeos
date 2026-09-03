/**
 * `mark_exception_resolved` — the second write-capable Financial_Tool (task 24.3).
 * Requirements 3.5, 4.12, 4.15, 5.11, 12.2, 12.3, 12.7, 12.10.
 *
 * design.md fixes the contract:
 *
 *     in   { exception_id: string; resolution_note: string }
 *     out  { exception_id: string; lifecycle_state: 'resolved'; resolved_at: string }
 *
 * It is the one transition in the Exception lifecycle a Proposal can perform. Nothing
 * else in this module moves an Exception, and it moves one only from `open`.
 *
 * ## A resolved Exception is never reopened, and a dismissed one is never resolved
 *
 * `@/agents/exception-fingerprint` guards the detection path with
 * `WHERE exceptions.lifecycle_state = 'open'`, so a re-run cannot reopen an Exception a
 * User closed (Requirement 4.15). This tool is the other direction and carries the same
 * guard, in {@link EXCEPTION_RESOLVE_SQL} and in {@link ExceptionResolutionStore}:
 *
 * | Stored state | What happens |
 * |---|---|
 * | `open` | the transition is written: `lifecycle_state = 'resolved'`, `resolved_at`, `resolved_by`, and the note merged into `detail` |
 * | `resolved` | **no write at all**, and the stored `resolved_at` is returned. The Exception is already in the state the caller asked for, so reporting success is the truthful answer and re-stamping `resolved_at` would overwrite when it was actually closed |
 * | `dismissed` | **refused.** A dismissal is a User's decision that the condition needs no resolution; rewriting it as `resolved` would silently replace one closure with another |
 *
 * The `open` path's guard is in the `WHERE` clause rather than in a preceding read, so
 * two concurrent resolutions cannot both win: the second `UPDATE` matches no row and
 * {@link ExceptionResolutionStore.resolve} answers `not_open` rather than resolving
 * twice. The read before it is for the Evidence_Chain and for the `dismissed` refusal,
 * not for the guard.
 *
 * ## The envelope chain is the Exception's own, and nothing new is composed
 *
 * `createToolInvoker` requires a resolvable Evidence_Chain on **every** `ok: true`
 * result, including one carrying no figure — task 10.2 reported that and it is still
 * open. This tool answers it without inventing a figure: an Exception's impact *is* its
 * persisted Evidence_Chain's figure (see `./exception-tools.ts`), so the chain composed
 * when the Exception was detected is exactly the chain that grounds what is being
 * resolved. It is read back through the Tenant gate and projected onto the envelope by
 * `envelopeFromExceptionEvidence`, the same two functions `get_exception_evidence` uses.
 *
 * Two consequences, both deliberate:
 *
 * - **No new chain is persisted.** A resolution derives no new figure, so composing one
 *   would be a chain whose only step restated a number it did not compute.
 * - **An Exception whose chain cannot be read is not resolvable through this tool.** It
 *   answers `incomplete_evidence` naming the Exception's own cited Source_Record types
 *   (Requirement 12.3, via `unreadableRefsOf`) and writes nothing. That is the same
 *   call `list_exceptions_by_category` and `get_exception_evidence` made in task 12.7.
 *   It is a real limitation — a corrupt chain blocks the closure of an Exception — and
 *   it is reported as finding 2 rather than worked around, because the alternative is
 *   returning a success with an unresolvable `evidence_chain_id`, which Requirement
 *   12.6 would withhold anyway.
 *
 * The read is ordered **before** the write for the same reason as in
 * `./post-reconciliation-adjustment.ts`: a withheld figure must leave Tenant state
 * unchanged, and ordering makes that true without a compensating write.
 *
 * ## `resolution_note` is prose, which Requirement 12.9 forbids
 *
 * design.md's catalogue and Requirement 12.9 contradict each other here, and
 * `./registry.ts` resolved it before this tool existed: a tool may name a genuinely
 * prose argument in `freeTextArguments`, and the registration audit then requires that
 * leaf to carry a **maximum length**. This is the one tool in the catalogue that uses
 * the allowance. {@link MAX_RESOLUTION_NOTE_LENGTH} is that ceiling, and the note is
 * also held to carrying no control character, because it is stored in `detail` (JSONB,
 * which rejects `\u0000` outright, SQLSTATE `22P05`) and read by humans.
 *
 * ## Reported, not silently patched
 *
 * 1. **`exceptions` has no column for `resolution_note`.** The table has
 *    `resolved_at` and `resolved_by` and nothing else about a closure, and design.md
 *    never says where the note goes. Three places were possible: a new column (a
 *    migration, outside this task), the Audit_Event payload only (which would make the
 *    note invisible to anyone reading the Exception), or `detail`, which is
 *    `JSONB NOT NULL` and already holds the named fields of the detection.
 *    {@link EXCEPTION_RESOLVE_SQL} merges it as `detail || {"resolution_note": $3}`, so
 *    the detection payload is preserved key for key and only that one key is added. A
 *    column is the cleaner home and belongs to whoever revisits migration 5.
 * 2. **An unreadable Evidence_Chain blocks resolution** — see above. Closing it needs
 *    either a chainless success variant on `ToolResult` or an envelope check that
 *    exempts a figureless result, both changes to `./tool.ts` and the contract harness.
 * 3. **Nothing states whether resolving an Exception must also close its Proposal, or
 *    what `resolved_by` should be for an Agent-driven resolution.** `resolved_by` is
 *    `UUID REFERENCES users(id)`, so it cannot hold an Agent name — this tool writes
 *    `ctx.user_id`, the session the Proposal was authorized under, which is the User
 *    whose Authorization the write rests on (Requirement 5.9, 5.14). An Agent
 *    resolution with no User session behind it would violate the foreign key, and that
 *    is the fail-closed direction rather than a `NULL` that loses attribution.
 * 4. **Requirement 5.11's Verification has nothing monetary to compare here.** The
 *    observed post-execution state of a resolution is a lifecycle state and a
 *    timestamp, and the 1-paisa tolerance does not apply to either. The output states
 *    both so task 23.3's comparison has something exact to read; the shape of
 *    `proposals.expected_outcome` is still task 23.1's FINDING 2.
 *
 * ## Money
 *
 * No figure is computed, converted or formatted in this file. The one monetary value
 * involved — the Exception's impact — is read from its persisted chain as `bigint` and
 * is not restated in the output.
 */

import type { TenantId } from '@/config/configuration-service';
import {
  createEvidenceChainBuilder,
  type EvidenceChainStore,
  incompleteEvidence,
  MAX_SOURCE_PAGE_SIZE,
} from '@/evidence/chain-builder';
import { z } from 'zod';

import {
  envelopeFromExceptionEvidence,
  exceptionEvidencePage,
  type ExceptionStore,
  unreadableRefsOf,
} from './exception-tools';
import { catalogued } from './registry';
import type { ErasedFinancialTool, FinancialTool, ToolContext, ToolResult } from './tool';
import {
  type AuthorizedWrite,
  createWriteCapableTool,
  type WriteCapableToolGate,
  type WriteSeam,
} from './write-tool';

/** design.md's catalogue name. */
export const MARK_EXCEPTION_RESOLVED = 'mark_exception_resolved';

/**
 * The ceiling on `resolution_note`, which the registration audit requires of any
 * argument named in `freeTextArguments`.
 *
 * 2000 characters, matching the specimen in `src/tools/registry.test.ts` and
 * `test/contract/tool-contract.test.ts` so the one prose allowance in the catalogue has
 * one bound rather than two.
 */
export const MAX_RESOLUTION_NOTE_LENGTH = 2000;

/* -------------------------------------------------------------------------- */
/* Input and output schemas                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A control character in the note would reach `detail` (JSONB rejects `\u0000`
 * outright) and the Audit_Log, both of which are read by humans.
 */
// The control range is the thing being matched, which is what rejects the note, so the
// rule is disabled for this line rather than the class being narrowed.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const inputSchema = z.strictObject({
  /** `exceptions.id`. */
  exception_id: z.uuid(),
  /**
   * Prose, by design.md's own catalogue. Length-bounded and control-character-free,
   * and named in `freeTextArguments` so the allowance is visible in the registry
   * rather than implied (Requirement 12.9).
   */
  resolution_note: z
    .string()
    .min(1)
    .max(MAX_RESOLUTION_NOTE_LENGTH)
    .refine((value) => !CONTROL_CHARACTER.test(value), {
      error: 'resolution_note must carry no control character',
    }),
});

export type MarkExceptionResolvedInput = z.infer<typeof inputSchema>;

const outputSchema = z.strictObject({
  exception_id: z.uuid(),
  /** The only state this tool produces. A literal, so no other value is expressible. */
  lifecycle_state: z.literal('resolved'),
  /** `exceptions.resolved_at`. ISO-8601 UTC. */
  resolved_at: z.iso.datetime(),
});

export type MarkExceptionResolvedOutput = z.infer<typeof outputSchema>;

/* -------------------------------------------------------------------------- */
/* The statement an adapter runs                                              */
/* -------------------------------------------------------------------------- */

/**
 * The resolution. Parameters:
 * `($1 tenant_id, $2 exception_id, $3 resolution_note, $4 resolved_at, $5 resolved_by)`.
 *
 * Three things about it are load-bearing:
 *
 * - **`WHERE lifecycle_state = 'open'`** is the guard, and it is the concurrency
 *   control: two concurrent resolutions both run this statement and only the first
 *   matches a row. Zero rows means the Exception is no longer open, which the adapter
 *   reports as `not_open` rather than as a silent success.
 * - **`resolved_at` and `lifecycle_state` move together**, because
 *   `(lifecycle_state = 'open') = (resolved_at IS NULL)` is a CHECK on the table
 *   (migration 5, Requirement 4.12). Setting one without the other is not a state this
 *   statement can produce.
 * - **`detail || jsonb_build_object(...)`** merges rather than replaces, so the
 *   detection payload survives and only `resolution_note` is added. See finding 1: the
 *   note has no column of its own.
 *
 * `first_detected_at` and `last_detected_at` are untouched: a resolution is not a
 * detection.
 */
export const EXCEPTION_RESOLVE_SQL = `
UPDATE exceptions
   SET lifecycle_state = 'resolved',
       resolved_at     = $4::timestamptz,
       resolved_by     = $5::uuid,
       detail          = detail || jsonb_build_object('resolution_note', $3::text)
 WHERE tenant_id = $1
   AND id = $2::uuid
   AND lifecycle_state = 'open'
RETURNING id, lifecycle_state, resolved_at`.trim();

/**
 * Why {@link EXCEPTION_RESOLVE_SQL} returned nothing: `($1 tenant, $2 exception_id)`.
 *
 * Run in the **same transaction** as the update, so the answer is the row the update
 * declined to touch rather than a later state. Zero rows here means the Exception does
 * not exist for this Tenant, which is a different fact from "not open" and must not be
 * reported as one.
 */
export const EXCEPTION_RESOLUTION_STATE_PROBE_SQL = `
SELECT id, lifecycle_state
  FROM exceptions
 WHERE tenant_id = $1
   AND id = $2::uuid`.trim();

/** The parameter tuple {@link EXCEPTION_RESOLVE_SQL} expects, in order. */
export function exceptionResolveParams(
  tenantId: TenantId,
  request: ExceptionResolutionRequest,
): readonly [TenantId, string, string, string, string] {
  return [
    tenantId,
    request.exception_id,
    request.resolution_note,
    request.resolved_at,
    request.resolved_by,
  ];
}

/* -------------------------------------------------------------------------- */
/* Write seam                                                                 */
/* -------------------------------------------------------------------------- */

/** Requirement 3.5's closure, as one row to write. */
export interface ExceptionResolutionRequest {
  readonly exception_id: string;
  /** Bounded prose. See {@link MAX_RESOLUTION_NOTE_LENGTH}. */
  readonly resolution_note: string;
  /** ISO-8601 UTC, ms precision. */
  readonly resolved_at: string;
  /** `exceptions.resolved_by`: a User identifier. See finding 3. */
  readonly resolved_by: string;
}

/**
 * What the write answers.
 *
 * `not_open` is a **value**, not an exception, for the same reason
 * `ExceptionNotReopened` is one in `@/agents/exception-fingerprint`: "the guard declined"
 * and "the statement failed" are different facts, and the caller has to be able to tell
 * them apart. `absent` covers the Exception that does not exist for this Tenant, which a
 * `not_open` would misreport.
 */
export type ExceptionResolutionOutcome =
  | { readonly kind: 'resolved'; readonly resolved_at: string }
  | { readonly kind: 'not_open'; readonly state: string }
  | { readonly kind: 'absent' };

export interface ExceptionResolutionStore {
  /**
   * {@link EXCEPTION_RESOLVE_SQL}, followed by
   * {@link EXCEPTION_RESOLUTION_STATE_PROBE_SQL} in the same transaction when it
   * matched no row.
   *
   * Must **throw** for anything other than those three outcomes. A resolution that was
   * not written is not a resolution, and reporting one would let a User believe an
   * Exception was closed when it is still on the Attention_Panel.
   */
  resolve(
    tenantId: TenantId,
    request: ExceptionResolutionRequest,
  ): Promise<ExceptionResolutionOutcome>;
}

/* -------------------------------------------------------------------------- */
/* Dependencies                                                              */
/* -------------------------------------------------------------------------- */

export interface MarkExceptionResolvedDeps {
  /** The Exception read: its state, its cited Source_Records and its chain identifier. */
  readonly exceptions: (ctx: ToolContext) => ExceptionStore;
  /**
   * The transition, reachable **only with the gate's proof** ({@link WriteSeam}) — the
   * structural half of Requirement 12.10. There is no way to obtain this seam from a
   * `ToolContext` alone, so a lifecycle transition with no Authorization behind it is
   * not expressible in this module.
   */
  readonly resolution: WriteSeam<ExceptionResolutionStore>;
  /** Where the Exception's persisted Evidence_Chain is read from. */
  readonly chains: (ctx: ToolContext) => EvidenceChainStore;
  /** Injectable clock, so `resolved_at` is assertable. Defaults to the wall clock. */
  readonly now?: () => Date;
}

/** Refused mid-invocation. Becomes `tool_failure` with cause `execution_error`. */
export class MarkExceptionResolvedError extends Error {
  override readonly name = 'MarkExceptionResolvedError';
}

/* -------------------------------------------------------------------------- */
/* The tool                                                                   */
/* -------------------------------------------------------------------------- */

export function createMarkExceptionResolved(
  deps: MarkExceptionResolvedDeps,
  gate: WriteCapableToolGate,
): FinancialTool<MarkExceptionResolvedInput, MarkExceptionResolvedOutput> {
  const clock = deps.now ?? ((): Date => new Date());

  /**
   * `resolved_at` for the Exception once it is resolved: the instant this resolution
   * was written, or the instant an earlier one was.
   *
   * The three lifecycle branches live here, in one place, so no caller can reach the
   * write without passing through them.
   */
  async function resolvedAtFor(
    ctx: ToolContext,
    input: MarkExceptionResolvedInput,
    state: string,
    storedResolvedAt: string | null,
    authorized: AuthorizedWrite,
  ): Promise<string> {
    if (state === 'resolved') {
      if (storedResolvedAt === null) {
        // `(lifecycle_state = 'open') = (resolved_at IS NULL)` is a CHECK, so this is a
        // corrupt row rather than an Exception that can be reported as resolved.
        throw new MarkExceptionResolvedError(
          `Exception ${input.exception_id} is resolved with no resolved_at, which the ` +
            `lifecycle CHECK of Requirement 4.12 forbids`,
        );
      }
      // Already in the state asked for. No write, and the original closure time stands.
      return storedResolvedAt;
    }
    if (state !== 'open') {
      throw new MarkExceptionResolvedError(
        `Exception ${input.exception_id} is ${state}, so it is already closed by a decision this ` +
          `tool must not overwrite; only an open Exception is resolvable (Requirement 4.12, 4.15)`,
      );
    }

    if (ctx.signal.aborted) {
      // The 10-second bound elapsed. Stop before writing a transition for a result that
      // will never be returned.
      throw new MarkExceptionResolvedError(
        `${MARK_EXCEPTION_RESOLVED} was aborted before writing the resolution`,
      );
    }

    const resolvedAt = new Date(clock().getTime()).toISOString();
    const outcome = await deps.resolution(ctx, authorized).resolve(ctx.tenant_id, {
      exception_id: input.exception_id,
      resolution_note: input.resolution_note,
      resolved_at: resolvedAt,
      // The User whose Authorization this write rests on. See finding 3.
      resolved_by: ctx.user_id,
    });

    switch (outcome.kind) {
      case 'resolved':
        return outcome.resolved_at;
      case 'not_open':
        // The guard declined between the read and the write. Reported rather than
        // retried: a concurrent decision has already closed this Exception, and
        // resolving it anyway would overwrite that decision.
        throw new MarkExceptionResolvedError(
          `Exception ${input.exception_id} became ${outcome.state} between the read and the ` +
            `write, so the resolution matched no open row and nothing was changed`,
        );
      default:
        throw new MarkExceptionResolvedError(
          `Exception ${input.exception_id} disappeared between the read and the write`,
        );
    }
  }

  return createWriteCapableTool<MarkExceptionResolvedInput, MarkExceptionResolvedOutput>(
    {
      name: MARK_EXCEPTION_RESOLVED,
      inputSchema,
      outputSchema,
      // The one prose allowance in the catalogue, declared so the registration audit
      // can require its ceiling (Requirement 12.9).
      freeTextArguments: ['resolution_note'],

      async execute(
        ctx: ToolContext,
        input: MarkExceptionResolvedInput,
        authorized: AuthorizedWrite,
      ): Promise<ToolResult<MarkExceptionResolvedOutput>> {
        /* 1. The Exception. Absent and another Tenant's are indistinguishable. */
        const row = await deps.exceptions(ctx).find(ctx.tenant_id, input.exception_id);
        if (row === null) {
          throw new MarkExceptionResolvedError(
            `no Exception ${input.exception_id} for this Tenant, so there is nothing to resolve`,
          );
        }

        /* 2. Its persisted chain, before anything is written (Requirement 12.3). */
        const reader = createEvidenceChainBuilder({
          store: deps.chains(ctx),
          // The session Tenant, bound once. No method takes one.
          tenantId: ctx.tenant_id,
        });
        const evidence = await exceptionEvidencePage(reader, row.evidence_chain_id, {
          offset: 0,
          limit: MAX_SOURCE_PAGE_SIZE,
        });
        if (evidence === null) {
          // The impact this Exception presents is its chain's figure, so a chain that
          // cannot be read is a contributing record that cannot be read. Nothing is
          // written and no figure is returned.
          return incompleteEvidence(unreadableRefsOf(row));
        }

        /* 3. The transition, from `open` only. */
        const resolvedAt = await resolvedAtFor(ctx, input, row.state, row.resolved_at, authorized);

        return {
          ok: true,
          value: {
            exception_id: row.exception_id,
            lifecycle_state: 'resolved',
            resolved_at: resolvedAt,
          },
          // The Exception's own chain, projected onto the shared envelope. Nothing new
          // is composed: a resolution derives no figure.
          evidence: envelopeFromExceptionEvidence(evidence),
        };
      },
    },
    gate,
  );
}

/**
 * The tool as a catalogue entry, ready for `createToolRegistry`.
 *
 * The gate is applied exactly once, by {@link createMarkExceptionResolved}.
 */
export function catalogueEntryFor(
  deps: MarkExceptionResolvedDeps,
  gate: WriteCapableToolGate,
): ErasedFinancialTool {
  return catalogued(createMarkExceptionResolved(deps, gate));
}
