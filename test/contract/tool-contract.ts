/**
 * The registry-driven Financial_Tool contract harness (task 10.2, extended by 12.7).
 * Requirements 12.1, 12.2, 12.3, 12.7, 12.9, 12.11.
 *
 * This is a **library, not a test file** — hence `.ts` rather than `.test.ts`, and
 * hence the `contract` Vitest project's `test/contract/**\/*.test.ts` glob does not
 * collect it. Two suites run it:
 *
 * - `./tool-contract.test.ts` — the non-vacuity suite, over specimen tools including
 *   deliberately non-conforming ones.
 * - `./slice-1-catalogue.test.ts` — the **real** catalogue, built by
 *   `@/tools/catalogue` and driven through {@link runToolContract} (task 12.7). Every
 *   later tool task adds an entry there and a fixture beside it; task 24.3 added the two
 *   `write_capable` ones, which is the first time {@link writeAuthorizationCase} and the
 *   `write_capable` direction of {@link modeCase} ran against production declarations
 *   rather than specimens.
 *
 * ## How a tool task uses it
 *
 * ```ts
 * import { createSliceOneToolRegistry } from '@/tools/catalogue';
 * import { runToolContract } from './tool-contract';
 *
 * runToolContract({
 *   registry: createSliceOneToolRegistry(deps),
 *   fixtures: {
 *     get_settlement_reconciliation: {
 *       validInput: { from: '2026-07-01', to: '2026-07-31', settlement_ids: ['setl_9281'] },
 *       hiddenContributingRecord: () => reconciliationToolWithOneUnreadableSettlement(),
 *       resolveEvidenceChain: (id) => chainBuilder.read(id),
 *     },
 *   },
 * });
 * ```
 *
 * A registered tool with no fixture is a **failing case**, not a skipped one, and an
 * empty registry is a failing case too (see {@link ToolContractOptions.allowEmpty}).
 * That is what makes "every registered tool is covered" a checked fact rather than a
 * hope: a tool author cannot add a catalogue entry that escapes this suite, because
 * the suite is generated from `registry.list()` and demands a fixture for each entry.
 *
 * ## Registration-time versus invocation-time
 *
 * The task text's "free-form text/SQL rejected" spans both halves of the layer, and
 * they are not interchangeable:
 *
 * | Assertion | When |
 * |---|---|
 * | every argument is bounded; no `tenant_id` argument at any depth; no `sql`/`query`/`where`/`filter`/`order_by`/`raw`/`expression` argument; every object strict; no `z.record`/`z.any`/`z.unknown`; `freeTextArguments` length-bounded and non-stale; `timeoutMs` is the literal 10 s; a typed output schema exists | **registration** — `createToolRegistry` throws `ToolRegistryError`, so a malformed declaration is a process that does not start. Re-proven per entry by {@link declarationCase} and, negatively, by `./tool-contract.test.ts` |
 * | a conforming input is accepted; unknown keys, wrong types, over-long prose and SQL strings are refused as `schema_violation` naming the argument with **zero connections acquired and zero executions**; the output validates against the declared schema; the acquired connection matches the declared mode; a `write_capable` invocation with no authorized Proposal is refused; every monetary field is covered by a resolvable `evidence_chain_id`; a hidden contributing record yields `incomplete_evidence` with no figure; holding past 10 s yields `tool_failure` cause `timeout` | **invocation** — every case below |
 *
 * ## What "resolvable `evidence_chain_id`" means here
 *
 * Two tiers, because they prove different things:
 *
 * 1. **Well-formedness**, always: the identifier is a UUID. This is all
 *    `createToolInvoker` itself checks before it will return `ok: true`.
 * 2. **Readability**, required of any tool whose output schema declares a monetary
 *    field: {@link ToolContractFixture.resolveEvidenceChain} must read the chain
 *    back — in practice `EvidenceChainBuilder.read`, which goes through the Tenant
 *    gate — and the harness requires a non-`null` answer. A tool whose output
 *    declares money and whose fixture supplies no resolver is a finding, not a pass:
 *    Requirement 12.6 withholds a whole response for a chain identifier that
 *    resolves to nothing, so "the string looked like a UUID" is not the bar.
 *
 * Where an enclosing object holds exactly one monetary field, the resolved chain's
 * `figure_paise` must equal that field. With two or more the pairing is ambiguous —
 * a `DifferenceRow` carries several figures — so only resolution is required there.
 *
 * ## Finding the monetary fields of an arbitrary `Out`, and the per-row chain gap
 *
 * design.md's convention is that a monetary field is named `*_paise`, so both halves
 * of the search key on that suffix:
 *
 * - {@link monetaryFieldPathsOf} walks the **declared output schema**, which is what
 *   tells the harness whether a tool produces money at all — a value walk cannot,
 *   since one fixture's run may legitimately return no rows. It is also how the
 *   harness knows to demand `hiddenContributingRecord` and a chain resolver.
 * - {@link monetaryFieldsIn} walks the **returned value**, which is what actually
 *   escaped to the Agent, and is therefore what coverage is asserted over.
 *
 * Task 10.1 reported that the single-`evidence` envelope cannot carry
 * `get_settlement_difference_breakdown`'s per-row chains or
 * `get_control_tower_metrics`'s per-cell ones. This harness therefore **does not
 * assume one chain per result**. {@link attributeMonetaryFields} grounds each monetary
 * field in the most specific chain that claims it: its own
 * `<stem>_evidence_chain_id` sibling, else the nearest enclosing object declaring an
 * `evidence_chain_id`, else the envelope. So a per-cell `MetricCell` is covered by its
 * own identifier, `get_trial_balance`'s two grand totals by the two chains its output
 * names for them, and a single-figure tool by the envelope. All are then required to
 * resolve, and a chain named for exactly one field must present exactly that figure.
 * The `ToolResult` envelope is **unchanged**: the shapes differ inside `Out`, which is
 * where nine tools resolved 10.1's finding 1, and this harness reads all of them
 * without blessing one.
 *
 * ## The empty scope, which four tools refuse and this harness does not fault them for
 *
 * `evidence_chains.source_count >= 1` is a database CHECK and `ToolResult` has no
 * chainless success variant, so a window holding nothing has no grounded figure to
 * return: `get_settlement_reconciliation`, `get_settlement_difference_breakdown`,
 * `get_trial_balance` and `get_control_tower_metrics` all refuse it as `tool_failure`
 * with cause `execution_error`, and all four escalated it rather than patching it —
 * the honest fixes are a relaxed `source_count` or an `empty_scope` result variant,
 * both shared contract changes above any tool task. **No case here asserts anything
 * about an empty scope**, so the documented refusal is accommodated rather than
 * punished, and a fixture is expected to supply a scope holding something. What the
 * harness does still require is that whatever *is* returned is grounded — which is the
 * clause the refusal exists to protect.
 *
 * ## What cannot be proven until task 26.1
 *
 * "`read_only` performs no data write" (Requirement 12.7) is backed by a database
 * role with no write grants, and that role lands in the **task 26.1** RLS migration.
 * Until then the strongest available assertion is the one {@link modeCase} makes:
 * the connection handed to the tool is the one the provider answers for
 * `tool.mode`, and a provider answering the other mode is a `ToolContractError`
 * rather than a fallback. No case here claims the database refused a write, because
 * today it would not. When 26.1 lands, the assertion to add is a `read_only`
 * invocation attempting an `INSERT` on `ctx.db` and failing — which needs a real
 * connection and so belongs in a fixture, not in this generic harness.
 *
 * ## Money
 *
 * `bigint` only. A monetary field on the wire is a decimal string, and
 * {@link monetaryEvidenceCase} reports a monetary field returned as a JavaScript
 * `number` as a finding rather than coercing it: a figure that has already been
 * through an IEEE-754 double cannot be un-rounded (Requirement 15.1, 15.8).
 *
 * ## Two violations for one bad argument, which is not a finding here
 *
 * Five Slice 1 tools bound a date with `z.iso.date()` **and** a house `isRealDate`
 * refinement, so `2026-02-30` names `from` twice. Task 12.3 reported the redundancy.
 * {@link schemaViolationCase} requires the refusal to *name the argument*, not to name
 * it once, so both spellings pass and neither is preferred: a caller reading
 * `violations` sees the correct argument either way. The harness deliberately does not
 * assert a violation count — a tool that reported one issue per failing check and a tool
 * that reported one per argument are both conforming — so nothing here justifies editing
 * five tools' schemas, and the redundancy is left as 12.3 filed it.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Actor, TenantId } from '@/config/configuration-service';
import { SOURCE_RECORD_TYPES } from '@/ledger/posting-rules';
import {
  auditToolDeclaration,
  type CatalogueEntry,
  REFUSED_ARGUMENT_NAMES,
  SESSION_ONLY_ARGUMENT,
  TOOL_NAME_RE,
  type ToolRegistry,
} from '@/tools/registry';
import {
  createToolInvoker,
  type ErasedFinancialTool,
  type EvidenceChain,
  type FinancialTool,
  type ProposalAuthorizationLookup,
  TOOL_MODES,
  TOOL_TIMEOUT_MS,
  type ToolAuditEvent,
  type ToolConnection,
  type ToolConnections,
  type ToolContext,
  type ToolDbClient,
  type ToolMode,
  type ToolResult,
  type ToolSession,
} from '@/tools/tool';
import type { ZodType } from 'zod';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Tenant every case runs as, unless a fixture names another. */
export const CONTRACT_TENANT: TenantId = '11111111-1111-4111-8111-111111111111';

/** Who the harness invokes as. An Agent, because that is who invokes a tool. */
export const CONTRACT_ACTOR: Actor = { kind: 'agent', id: 'contract_harness' };

/** A fixed clock, so `occurred_at` is assertable. */
export const CONTRACT_NOW = (): Date => new Date('2026-07-30T09:00:00.000Z');

/** An unknown key no real input schema could declare. */
const UNKNOWN_KEY = '__contract_unknown_argument__';

/**
 * A value no audited leaf can accept: every leaf kind the registry admits is a
 * string, a number, a bigint, a boolean, a date, an enum, a literal, or a null-ish,
 * and none of them accepts a plain object. One probe therefore covers every
 * argument, whatever its declared bound.
 */
const WRONG_TYPE_PROBE: unknown = { __contract_wrong_type__: true };

/** Free-form SQL, which no argument may carry however it is spelled. */
const SQL_PROBE = "' OR 1=1; DROP TABLE settlements; --";

/** Prose past any sane ceiling, for an argument whose only bound is a maximum length. */
const OVER_LONG_PROBE = 'a'.repeat(1_000_000);

/**
 * design.md's catalogue: 17 read-only tools and 3 write-capable ones.
 *
 * Transcribed so {@link catalogueGaps} can say which of them are not yet
 * registered. It is a checklist, not a source of truth about the code — the
 * registry is that — and its purpose is to make an empty or partial catalogue
 * visible rather than silent.
 */
export const DESIGN_CATALOGUE: readonly { readonly name: string; readonly mode: ToolMode }[] = [
  { name: 'get_settlement_reconciliation', mode: 'read_only' },
  { name: 'get_settlement_difference_breakdown', mode: 'read_only' },
  { name: 'get_unsettled_payments', mode: 'read_only' },
  { name: 'get_duplicate_refund_candidates', mode: 'read_only' },
  { name: 'get_missing_accruals', mode: 'read_only' },
  { name: 'get_trial_balance', mode: 'read_only' },
  { name: 'list_exceptions_by_category', mode: 'read_only' },
  { name: 'get_exception_evidence', mode: 'read_only' },
  { name: 'get_compliance_findings', mode: 'read_only' },
  { name: 'get_itc_discrepancy', mode: 'read_only' },
  { name: 'get_seller_payout_chain', mode: 'read_only' },
  { name: 'get_linked_account_balance', mode: 'read_only' },
  { name: 'get_cash_forecast', mode: 'read_only' },
  { name: 'simulate_cash_action', mode: 'read_only' },
  { name: 'get_failed_payment_recovery_profile', mode: 'read_only' },
  { name: 'get_period_comparison', mode: 'read_only' },
  { name: 'get_control_tower_metrics', mode: 'read_only' },
  { name: 'post_reconciliation_adjustment', mode: 'write_capable' },
  { name: 'mark_exception_resolved', mode: 'write_capable' },
  { name: 'initiate_payment_retry', mode: 'write_capable' },
] as const;

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

/** One clause of the contract. One {@link ToolContractCase} per label, per tool. */
export type ContractCheck =
  | 'declaration'
  | 'valid_input_accepted'
  | 'argument_coverage'
  | 'schema_violation'
  | 'output_schema'
  | 'mode'
  | 'write_authorization'
  | 'monetary_evidence'
  | 'incomplete_evidence'
  | 'timeout';

/**
 * One way a tool, or its fixture, failed the contract.
 *
 * A value rather than an `expect` call, so every check is runnable outside Vitest
 * and `./tool-contract.test.ts` can prove that a deliberately non-conforming
 * specimen produces the finding it should. A harness whose only evidence of working
 * is a green run over conforming tools has not been tested.
 */
export interface ContractFinding {
  readonly tool: string;
  readonly check: ContractCheck;
  readonly detail: string;
}

function finding(tool: string, check: ContractCheck, detail: string): ContractFinding {
  return { tool, check, detail };
}

/** Findings as one line each, for a test failure message. */
export function formatFindings(findings: readonly ContractFinding[]): readonly string[] {
  return findings.map((f) => `${f.tool} [${f.check}] ${f.detail}`);
}

/* -------------------------------------------------------------------------- */
/* Recording fakes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A connection provider that counts. **Zero acquisitions** is the assertion that
 * makes "rejected without reading Tenant data" structural rather than asserted
 * (Requirement 12.9): `ToolContext.db` is the only database a tool is handed, and
 * it does not exist until `acquire` is called.
 */
export interface RecordingConnections extends ToolConnections {
  /** One entry per acquisition, in order. */
  readonly acquired: ToolMode[];
  /** One entry per release, in order. `rollback` is what leaves state unchanged. */
  readonly dispositions: ('commit' | 'rollback')[];
}

export function recordingConnections(
  options: {
    /** The client handed to the tool as `ctx.db`. Inert by default. */
    readonly db?: ToolDbClient;
    /** Answer this mode instead of the requested one, to prove the mode is checked. */
    readonly answerMode?: ToolMode;
    readonly failAcquire?: boolean;
    readonly failRelease?: boolean;
  } = {},
): RecordingConnections {
  const acquired: ToolMode[] = [];
  const dispositions: ('commit' | 'rollback')[] = [];
  return {
    acquired,
    dispositions,
    acquire(mode: ToolMode): Promise<ToolConnection> {
      acquired.push(mode);
      if (options.failAcquire === true) {
        return Promise.reject(new Error('no connection available'));
      }
      return Promise.resolve({
        // Inert unless a fixture supplies a real one: no case in this harness issues
        // a query, which is the point of counting acquisitions instead.
        db: options.db ?? ({} as unknown as ToolDbClient),
        mode: options.answerMode ?? mode,
        release(disposition: 'commit' | 'rollback'): Promise<void> {
          dispositions.push(disposition);
          return options.failRelease === true
            ? Promise.reject(new Error('rollback refused'))
            : Promise.resolve();
        },
      });
    },
  };
}

/** A recording Audit sink. `app.append_audit_event_autonomous` is broken (`2F003`). */
export interface RecordingAudit {
  readonly events: ToolAuditEvent[];
  append(event: ToolAuditEvent): Promise<void>;
}

export function recordingAudit(): RecordingAudit {
  const events: ToolAuditEvent[] = [];
  return {
    events,
    append(event: ToolAuditEvent): Promise<void> {
      events.push(event);
      return Promise.resolve();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** The minimum a resolver must answer with for a chain to count as resolvable. */
export interface ResolvedChain {
  readonly evidence_chain_id: string;
  readonly figure_paise: bigint;
}

/**
 * What a tool author supplies so the generic cases can run against their tool.
 *
 * Deliberately small: everything derivable from the registry is derived, and the
 * fixture states only what the registry cannot know — a conforming input, how to
 * reach a database, and how to make the tool fail in the two ways the contract
 * cares about.
 */
export interface ToolContractFixture {
  /**
   * One conforming input, populating **every** declared argument including the
   * optional ones. Optional arguments left out cannot have their wrong-type case
   * exercised, and {@link argumentCoverageCase} reports that rather than skipping it.
   */
  readonly validInput: Readonly<Record<string, unknown>>;
  /** Overrides on the session. `tenant_id` defaults to {@link CONTRACT_TENANT}. */
  readonly session?: Partial<ToolSession>;
  /** A **fresh** provider per invocation. Defaults to {@link recordingConnections}. */
  readonly connections?: () => RecordingConnections;
  /** Required for `write_capable`: answers `true` for this fixture's session pair. */
  readonly authorization?: ProposalAuthorizationLookup;
  /**
   * The same tool, configured so one contributing Source_Record cannot be read.
   * Required of any tool whose output schema declares a monetary field
   * (Requirement 12.3).
   */
  readonly hiddenContributingRecord?: () => ErasedFinancialTool;
  /**
   * At what granularity this tool withholds a figure it cannot ground.
   *
   * - `'invocation'` (the default): the whole result is `incomplete_evidence`, which is
   *   what a tool presenting **one answer** must do. Eight of the nine Slice 1 tools are
   *   this: a total shortfall composed from every in-scope Settlement is incomplete if
   *   any of them could not be read, so there is nothing to return.
   * - `'per_figure'`: the invocation succeeds and the **figure that could not be
   *   grounded is the one withheld**, carrying its own unavailable types.
   *
   * `'per_figure'` exists because `get_control_tower_metrics` answers **four independent
   * questions in one invocation** and Requirement 3.9 requires one metric's fault to
   * leave the other three intact — an unreadable Payment in the revenue window says
   * nothing about Cash. Collapsing that to an invocation-wide refusal would lose three
   * good answers, and asserting nothing would leave Requirement 12.3 untested for the
   * one tool whose cells each carry a figure. So the branch is a different shape of the
   * same assertion, not a relaxation: the withheld cell must carry the unavailable types
   * with valid counts, **no** monetary field and **no** `evidence_chain_id`, and every
   * figure the invocation still returned must remain grounded and resolvable.
   */
  readonly incompleteEvidenceScope?: 'invocation' | 'per_figure';
  /**
   * The same tool, configured to hold past the 10-second bound. Optional: the
   * harness synthesises a held variant of the declaration when this is absent, which
   * is enough to prove the bound is enforced for this tool's declaration. Supply one
   * only if it needs no real timers — the case runs under fake ones.
   */
  readonly holdPastDeadline?: () => ErasedFinancialTool;
  /**
   * Read a chain back. Required of any tool whose output schema declares a monetary
   * field. In practice `(id) => chainBuilder.read(id)`.
   */
  readonly resolveEvidenceChain?: (id: string) => Promise<ResolvedChain | null>;
}

export interface ToolContractOptions {
  readonly registry: ToolRegistry;
  /** One fixture per registered tool name. A missing one is a failing case. */
  readonly fixtures: Readonly<Record<string, ToolContractFixture>>;
  /**
   * Only for a suite that deliberately runs over no tool. Off by default, so an
   * empty catalogue fails loudly instead of passing vacuously.
   */
  readonly allowEmpty?: boolean;
  readonly actor?: Actor;
  readonly now?: () => Date;
}

/* -------------------------------------------------------------------------- */
/* Argument paths                                                             */
/* -------------------------------------------------------------------------- */

type PathSegment = { readonly kind: 'key'; readonly key: string } | { readonly kind: 'index'; readonly index: number };

/**
 * A `SchemaAudit` path as segments: `entries[].amount_paise` becomes key `entries`,
 * index 0, key `amount_paise`.
 *
 * A union alternative marker (`foo|0`, which the registry's walk appends per option)
 * is stripped, so the alternatives of one argument collapse to one path.
 */
export function segmentsOf(path: string): readonly PathSegment[] {
  const withoutAlternatives = path.replace(/\|\d+/g, '');
  const segments: PathSegment[] = [];
  for (const token of withoutAlternatives.match(/[^.[\]]+|\[\d*\]/g) ?? []) {
    if (token.startsWith('[')) {
      const inner = token.slice(1, -1);
      segments.push({ kind: 'index', index: inner === '' ? 0 : Number.parseInt(inner, 10) });
    } else {
      segments.push({ kind: 'key', key: token });
    }
  }
  return segments;
}

/** Segments as `ToolArgumentViolation.argument` renders them: `entries[0].amount_paise`. */
export function renderPath(segments: readonly PathSegment[]): string {
  let rendered = '';
  for (const segment of segments) {
    if (segment.kind === 'index') {
      rendered += `[${segment.index}]`;
    } else {
      rendered += rendered === '' ? segment.key : `.${segment.key}`;
    }
  }
  return rendered;
}

function childOf(container: unknown, segment: PathSegment): unknown {
  if (segment.kind === 'index') {
    return Array.isArray(container) ? (container as readonly unknown[])[segment.index] : undefined;
  }
  if (typeof container !== 'object' || container === null || Array.isArray(container)) {
    return undefined;
  }
  return (container as Record<string, unknown>)[segment.key];
}

/** Is every container on the way to this path present in `input`? */
function isReachable(input: unknown, segments: readonly PathSegment[]): boolean {
  let cursor: unknown = input;
  for (const segment of segments.slice(0, -1)) {
    cursor = childOf(cursor, segment);
    if (cursor === undefined || cursor === null) {
      return false;
    }
  }
  const last = segments[segments.length - 1];
  if (last === undefined) {
    return false;
  }
  if (last.kind === 'index') {
    return Array.isArray(cursor) && segments.length > 0 && (cursor as readonly unknown[]).length > last.index;
  }
  return typeof cursor === 'object' && cursor !== null;
}

/** A structural clone with one path replaced. Only called for a reachable path. */
function withValueAt(
  input: Readonly<Record<string, unknown>>,
  segments: readonly PathSegment[],
  value: unknown,
): Record<string, unknown> {
  const clone = structuredCloneish(input) as Record<string, unknown>;
  let cursor: unknown = clone;
  for (const segment of segments.slice(0, -1)) {
    cursor = childOf(cursor, segment);
  }
  const last = segments[segments.length - 1];
  if (last === undefined) {
    return clone;
  }
  if (last.kind === 'index') {
    if (Array.isArray(cursor)) {
      (cursor as unknown[])[last.index] = value;
    }
  } else if (typeof cursor === 'object' && cursor !== null) {
    (cursor as Record<string, unknown>)[last.key] = value;
  }
  return clone;
}

/**
 * A deep clone that keeps `bigint` and `Date` intact.
 *
 * `structuredClone` handles both, but a monetary `bigint` argument travelling through
 * `JSON.parse(JSON.stringify(...))` would throw, and a `Date` would become a string.
 */
function structuredCloneish(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => structuredCloneish(element));
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = structuredCloneish(child);
    }
    return out;
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Non-conforming inputs, generated per audited argument                       */
/* -------------------------------------------------------------------------- */

/** One generated rejection case. `argument` is what the violation must name. */
export interface NonConformingCase {
  readonly label: string;
  readonly input: unknown;
  /**
   * The argument the `schema_violation` must name, or `null` where the input is not
   * even an object and naming a particular argument is meaningless.
   */
  readonly argument: string | null;
}

/**
 * The rejection cases for one tool, generated from its {@link CatalogueEntry} — the
 * audit's `arguments` list with each argument's `bound` — rather than hand-written.
 *
 * Per audited argument:
 *
 * | Bound | Cases |
 * |---|---|
 * | `pattern` (regex, `z.uuid()`, `z.iso.date()`) | wrong type, and a SQL string |
 * | `closed` (enum, literal) | wrong type, and a SQL string |
 * | `non_text` (number, bigint, boolean, date) | wrong type, and a SQL string |
 * | `length` (declared free-form prose) | wrong type, and prose past the ceiling. **Not** the SQL string: a length-bounded prose argument legitimately accepts arbitrary text, which is exactly the allowance `freeTextArguments` makes visible |
 *
 * Plus four cases that belong to no particular argument: an unknown key, a smuggled
 * `tenant_id`, a `sql` key, and an input that is not an object at all.
 */
export function nonConformingCasesFor(
  entry: CatalogueEntry,
  validInput: Readonly<Record<string, unknown>>,
): readonly NonConformingCase[] {
  const cases: NonConformingCase[] = [...objectLevelCases(validInput)];
  const seen = new Set<string>();

  for (const argument of entry.audit.arguments) {
    const segments = segmentsOf(argument.path);
    const rendered = renderPath(segments);
    if (rendered === '' || seen.has(rendered)) {
      continue;
    }
    seen.add(rendered);
    if (!isReachable(validInput, segments)) {
      // Not exercisable, and not silently skipped either: `argumentCoverageCase`
      // reports it so the fixture is fixed rather than the case quietly lost.
      continue;
    }
    cases.push({
      label: `${rendered} carrying a value of the wrong type`,
      input: withValueAt(validInput, segments, WRONG_TYPE_PROBE),
      argument: rendered,
    });
    cases.push(
      argument.bound === 'length'
        ? {
            label: `${rendered} carrying prose past its maximum length`,
            input: withValueAt(validInput, segments, OVER_LONG_PROBE),
            argument: rendered,
          }
        : {
            label: `${rendered} carrying free-form SQL`,
            input: withValueAt(validInput, segments, SQL_PROBE),
            argument: rendered,
          },
    );
  }
  return cases;
}

/**
 * The audited argument paths the fixture's `validInput` does not populate, so their
 * wrong-type and SQL cases could not be generated.
 *
 * An optional argument absent from the fixture is a hole in the coverage, so it is
 * reported rather than skipped: the fix is a `validInput` that names every argument.
 */
export function unreachableArgumentPaths(
  entry: CatalogueEntry,
  validInput: Readonly<Record<string, unknown>>,
): readonly string[] {
  const unreachable = new Set<string>();
  for (const argument of entry.audit.arguments) {
    const segments = segmentsOf(argument.path);
    const rendered = renderPath(segments);
    if (rendered !== '' && !isReachable(validInput, segments)) {
      unreachable.add(rendered);
    }
  }
  return [...unreachable];
}

/** The four cases that are about the input object rather than one argument. */
function objectLevelCases(validInput: Readonly<Record<string, unknown>>): readonly NonConformingCase[] {
  return [
    { label: 'an unknown key', input: { ...validInput, [UNKNOWN_KEY]: 'x' }, argument: UNKNOWN_KEY },
    // Rejected, never stripped: a caller whose smuggled key was silently dropped
    // believes it scoped a request it did not (Requirement 12.7).
    { label: 'a smuggled tenant_id', input: { ...validInput, tenant_id: '00000000-0000-4000-8000-000000000000' }, argument: SESSION_ONLY_ARGUMENT },
    { label: 'a free-form sql key', input: { ...validInput, sql: 'select * from payments' }, argument: 'sql' },
    { label: 'an input that is not an object', input: jsonTextOf(validInput), argument: null },
  ];
}

/**
 * The conforming input as JSON **text**, which is the realistic "not an object" mistake:
 * a caller that posted the body instead of parsing it.
 *
 * A `bigint`-safe replacer, added in task 24.3. `post_reconciliation_adjustment` is the
 * first catalogue tool with a `bigint` argument — `entries[].amount_paise` — and a bare
 * `JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt` on it, so
 * this case crashed rather than running. {@link structuredCloneish} already kept `bigint`
 * intact for the per-argument probes; this is the same discipline for the object-level one.
 * The monetary value is rendered as a decimal string, which is what a `bigint` looks like
 * on the wire anyway (Requirement 15.1).
 */
function jsonTextOf(validInput: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(validInput, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

/* -------------------------------------------------------------------------- */
/* Monetary fields: the declared schema, and what actually escaped             */
/* -------------------------------------------------------------------------- */

/** design.md's convention: a monetary field is named `*_paise`. */
const MONETARY_KEY_RE = /_paise$/;

/** The `_paise` suffix, whose length is how a field's stem is taken. */
const MONETARY_SUFFIX = '_paise';

/**
 * The sibling convention that expresses "two figures in one object, one chain each".
 *
 * A field named `<stem>_paise` may be grounded by a sibling named
 * `<stem>_evidence_chain_id`. Adopted in task 12.7 at task 12.3's request — see
 * {@link attributeMonetaryFields}.
 */
const FIELD_CHAIN_SUFFIX = '_evidence_chain_id';

/** The `<stem>_evidence_chain_id` sibling of one monetary field, if the owner names one. */
function siblingChainIdFor(owner: Record<string, unknown>, monetaryKey: string): string | null {
  const stem = monetaryKey.slice(0, -MONETARY_SUFFIX.length);
  if (stem === '') {
    return null;
  }
  const id = owner[`${stem}${FIELD_CHAIN_SUFFIX}`];
  return typeof id === 'string' ? id : null;
}

interface OutputDef {
  readonly type?: string;
  readonly shape?: Readonly<Record<string, unknown>>;
  readonly element?: unknown;
  readonly items?: readonly unknown[];
  readonly rest?: unknown;
  readonly options?: readonly unknown[];
  readonly left?: unknown;
  readonly right?: unknown;
  readonly innerType?: unknown;
  readonly in?: unknown;
  readonly out?: unknown;
  readonly valueType?: unknown;
  readonly getter?: () => unknown;
}

function outputDefOf(schema: unknown): OutputDef | null {
  if (typeof schema !== 'object' || schema === null) {
    return null;
  }
  const def = (schema as { readonly _zod?: { readonly def?: unknown } })._zod?.def;
  return typeof def === 'object' && def !== null ? (def as OutputDef) : null;
}

/**
 * Every `*_paise` path the **declared output schema** can produce, dotted with `[]`
 * for an array element.
 *
 * This is the answer to "how do you find the monetary fields of an arbitrary `Out`".
 * The schema rather than the value, because the schema is what says whether a tool
 * produces money *at all*: a fixture whose run returns no rows would make a
 * value-only search conclude that `get_unsettled_payments` handles no money, and the
 * `incomplete_evidence` and chain-resolver demands would silently lapse.
 *
 * Unrecognised node kinds stop the descent rather than throwing. This walk is a
 * discovery aid, not the security audit — `auditInputSchema` is that, and it fails
 * closed. A node kind this walk cannot see is reported by
 * {@link monetaryFieldPathsOf}'s caller only insofar as the resulting paths are used;
 * design.md's output shapes are objects, arrays and unions of them.
 */
export function monetaryFieldPathsOf(schema: ZodType): readonly string[] {
  const paths = new Set<string>();

  /**
   * `stack` is the chain of nodes currently being walked, not every node ever seen:
   * one schema object is commonly reused at several paths — `get_control_tower_metrics`
   * declares the same `MetricCell` for all four cells — and a global seen-set would
   * report the first cell's figure and silently drop the rest. A node already on the
   * stack is a genuine cycle and stops the descent.
   */
  const walk = (node: unknown, path: string, stack: readonly unknown[]): void => {
    const def = outputDefOf(node);
    if (def === null || def.type === undefined || stack.includes(node) || stack.length > 64) {
      return;
    }
    const nested = [...stack, node];
    const walkChild = (child: unknown, childPath: string): void => {
      walk(child, childPath, nested);
    };
    switch (def.type) {
      case 'object': {
        for (const [key, child] of Object.entries(def.shape ?? {})) {
          const childPath = path === '' ? key : `${path}.${key}`;
          if (MONETARY_KEY_RE.test(key)) {
            paths.add(childPath);
            continue;
          }
          walkChild(child, childPath);
        }
        return;
      }
      case 'array':
        walkChild(def.element, `${path}[]`);
        return;
      case 'tuple': {
        (def.items ?? []).forEach((item, index) => {
          walkChild(item, `${path}[${index}]`);
        });
        walkChild(def.rest, `${path}[]`);
        return;
      }
      case 'union':
        (def.options ?? []).forEach((option) => {
          walkChild(option, path);
        });
        return;
      case 'intersection':
        walkChild(def.left, path);
        walkChild(def.right, path);
        return;
      case 'record':
      case 'map':
        walkChild(def.valueType, `${path}[]`);
        return;
      case 'lazy':
        walkChild(typeof def.getter === 'function' ? def.getter() : undefined, path);
        return;
      case 'pipe':
        // The declared output is the `out` side of a transform.
        walkChild(def.out ?? def.in, path);
        return;
      case 'optional':
      case 'nullable':
      case 'default':
      case 'prefault':
      case 'nonoptional':
      case 'readonly':
      case 'catch':
      case 'promise':
        walkChild(def.innerType, path);
        return;
      default:
        return;
    }
  };

  walk(schema, '', []);
  return [...paths];
}

/** One monetary field that actually escaped, with the chain that grounds it. */
export interface MonetaryAttribution {
  readonly path: string;
  readonly value: unknown;
  /**
   * The `evidence_chain_id` covering this figure: its own
   * `<stem>_evidence_chain_id` sibling, else the nearest enclosing object that declares
   * an `evidence_chain_id`, else the envelope's. `null` means nothing covers it.
   */
  readonly chainId: string | null;
  /**
   * Whether the chain was named inside `Out` — by this field's own sibling or by an
   * enclosing object — rather than taken from the envelope.
   */
  readonly fromOwnChain: boolean;
  /**
   * How many `*_paise` fields the covering chain grounds. `1` makes the pairing exact,
   * so the harness then requires the chain's `figure_paise` to equal this field.
   *
   * A field grounded by its own `<stem>_evidence_chain_id` sibling is always `1`: the
   * chain is named for that field and for no other.
   */
  readonly siblingMonetaryFields: number;
}

/**
 * Attribute every `*_paise` field in a returned value to the chain that grounds it.
 *
 * **This does not assume one chain per result.** Task 10.1 reported that
 * `get_settlement_difference_breakdown` and `get_control_tower_metrics` produce one
 * chain per row and per cell, which design.md's single-`evidence` envelope cannot
 * carry. Three rules are therefore tried in order, most specific first:
 *
 * 1. **This field's own `<stem>_evidence_chain_id` sibling.** `debit_total_paise` is
 *    grounded by `debit_total_evidence_chain_id` if the same object names one.
 * 2. **The nearest enclosing object declaring an `evidence_chain_id`**, walking
 *    outward. A `DifferenceRow`'s six figures and a `MetricCell`'s one are grounded
 *    this way.
 * 3. **The envelope chain**, when nothing inside `Out` covers the figure.
 *
 * ## Rule 1 is task 12.7's decision on task 12.3's finding 4
 *
 * `get_trial_balance` is the first tool with **two** top-level figures and a separate
 * chain for each: Σdebit and Σcredit are equal in value and different in derivation —
 * they sum disjoint operand sets — so one chain cannot present both without misstating
 * what it summed. Its `Out` says so, naming `debit_total_evidence_chain_id` and
 * `credit_total_evidence_chain_id`, and 12.3 reported that the nearest-enclosing-object
 * rule could not read that: it credited both grand totals to the envelope, which is the
 * debit chain, and then skipped the figure-equality check because the covering object
 * held two monetary fields. The tool passed, and the second chain went unexercised.
 *
 * 12.3 proposed the `<field>_evidence_chain_id` sibling convention and left the harness
 * to whoever held it. This is that decision, and it is **adopted**, for three reasons:
 *
 * - It is **strictly stronger**. Both chains are now resolved, and each is required to
 *   present exactly the figure it is named for, so a tool that swapped its two
 *   identifiers now fails. Under the old rule it passed.
 * - It **needs no widening of `ToolResult`**, which is what 10.1's finding 1 would
 *   otherwise force on all twenty tools for the benefit of one.
 * - It is **already the convention in the code**. `get_trial_balance` states it, and
 *   the per-row and per-cell `evidence_chain_id` of every other tool is the degenerate
 *   case of it, so no tool changed to satisfy this rule.
 *
 * Rule 1 is checked before rule 2 on purpose: an object may name both a chain of its own
 * and a chain per figure, and the per-figure one is the more specific claim.
 */
export function attributeMonetaryFields(
  value: unknown,
  envelopeChainId: string | null,
): readonly MonetaryAttribution[] {
  const attributions: MonetaryAttribution[] = [];

  const chainIdOf = (owner: Record<string, unknown>): string | null => {
    const id = owner['evidence_chain_id'];
    return typeof id === 'string' ? id : null;
  };

  const walk = (node: unknown, path: string, ancestors: readonly Record<string, unknown>[]): void => {
    if (Array.isArray(node)) {
      node.forEach((element, index) => {
        walk(element, `${path}[${index}]`, ancestors);
      });
      return;
    }
    if (typeof node !== 'object' || node === null || node instanceof Date) {
      return;
    }
    const owner = node as Record<string, unknown>;
    const chain = [owner, ...ancestors];
    const monetaryKeys = Object.keys(owner).filter((key) => MONETARY_KEY_RE.test(key));
    for (const key of monetaryKeys) {
      let covering: string | null = null;
      let fromOwn = false;
      let siblings = monetaryKeys.length;
      // Rule 1: a chain named for this field alone. Exactly one figure, so the
      // figure-equality check applies however many siblings the object holds.
      const named = siblingChainIdFor(owner, key);
      if (named !== null) {
        attributions.push({
          path: path === '' ? key : `${path}.${key}`,
          value: owner[key],
          chainId: named,
          fromOwnChain: true,
          siblingMonetaryFields: 1,
        });
        continue;
      }
      for (const [depth, candidate] of chain.entries()) {
        const id = chainIdOf(candidate);
        if (id !== null) {
          covering = id;
          fromOwn = true;
          siblings =
            depth === 0
              ? monetaryKeys.length
              : Object.keys(candidate).filter((k) => MONETARY_KEY_RE.test(k)).length;
          break;
        }
      }
      if (covering === null) {
        covering = envelopeChainId;
        fromOwn = false;
      }
      attributions.push({
        path: path === '' ? key : `${path}.${key}`,
        value: owner[key],
        chainId: covering,
        fromOwnChain: fromOwn,
        siblingMonetaryFields: siblings,
      });
    }
    for (const [key, child] of Object.entries(owner)) {
      if (MONETARY_KEY_RE.test(key)) {
        continue;
      }
      walk(child, path === '' ? key : `${path}.${key}`, chain);
    }
  };

  walk(value, '', []);
  return attributions;
}

/* -------------------------------------------------------------------------- */
/* Tool variants the harness builds from a declaration                        */
/* -------------------------------------------------------------------------- */

/** `FinancialTool<unknown, unknown>` is what an erased tool satisfies for `invoke`. */
type InvocableTool = FinancialTool<unknown, unknown>;

/**
 * An erased tool as something `ToolInvoker.invoke` accepts.
 *
 * No cast: `ErasedFinancialTool.execute` is declared with method syntax, whose
 * parameters are bivariant, and `NoTenantId<unknown>` is `unknown` because
 * `keyof unknown` is `never`.
 */
function invocable(tool: ErasedFinancialTool): InvocableTool {
  return tool;
}

/** The tool, plus every context and input its `execute` was handed. */
interface Instrumented {
  readonly tool: ErasedFinancialTool;
  readonly contexts: ToolContext[];
  readonly inputs: unknown[];
}

function instrumented(tool: ErasedFinancialTool): Instrumented {
  const contexts: ToolContext[] = [];
  const inputs: unknown[] = [];
  return {
    contexts,
    inputs,
    tool: {
      ...tool,
      execute(ctx: ToolContext, input: never): Promise<ToolResult<unknown>> {
        contexts.push(ctx);
        inputs.push(input);
        return tool.execute(ctx, input);
      },
    },
  };
}

/**
 * The same **declaration**, holding forever.
 *
 * The bound belongs to the layer, not to the tool, so a synthetic hold proves what
 * Requirement 12.11 asks of this tool: its declared `timeoutMs` is the enforced one,
 * the failure names it, the connection it was handed is rolled back, and its
 * `ctx.signal` is aborted. It does **not** prove the real tool is slow, and it is not
 * meant to: a fixture that can hold its own I/O passes
 * {@link ToolContractFixture.holdPastDeadline} instead.
 */
function heldVariant(tool: ErasedFinancialTool): ErasedFinancialTool {
  return {
    ...tool,
    execute(): Promise<ToolResult<unknown>> {
      return new Promise<ToolResult<unknown>>(() => {
        /* Never settles. The bound, not the tool, ends the invocation. */
      });
    },
  };
}

/**
 * A well-formed chain for the output-drift case, so the invoker's envelope check
 * reaches the output schema rather than stopping at a missing chain.
 */
function syntheticChain(toolName: string): EvidenceChain {
  const ref = { type: 'settlement', id: 'setl_contract_probe' } as const;
  return {
    evidence_chain_id: '92810000-0000-4281-8281-000000009281',
    figure_paise: 1n,
    sources: [ref],
    source_count: 1,
    steps: [
      {
        index: 1,
        operation: 'sum',
        operands: [{ kind: 'source', ref, field: 'amount' }],
        result_paise: 1n,
      },
    ],
    as_of: '2026-07-30T08:59:00.000Z',
    produced_by: toolName,
  };
}

/** The same declaration, returning a value its own output schema rejects. */
function driftingVariant(tool: ErasedFinancialTool, drift: unknown): ErasedFinancialTool {
  return {
    ...tool,
    execute(): Promise<ToolResult<unknown>> {
      return Promise.resolve({
        ok: true,
        value: drift,
        evidence: syntheticChain(tool.name),
      });
    },
  };
}

/** The first probe value the declared output schema rejects, or `null` if it takes all. */
function outputDriftValueFor(tool: ErasedFinancialTool): { readonly value: unknown } | null {
  for (const candidate of [null, undefined, WRONG_TYPE_PROBE, 42]) {
    if (!tool.outputSchema.safeParse(candidate).success) {
      return { value: candidate };
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* One invocation, with everything it touched recorded                        */
/* -------------------------------------------------------------------------- */

interface CaseContext {
  readonly entry: CatalogueEntry;
  readonly fixture: ToolContractFixture;
  readonly actor: Actor;
  readonly now: () => Date;
}

interface Invocation {
  readonly result: ToolResult<unknown>;
  readonly connections: RecordingConnections;
  readonly audit: RecordingAudit;
  readonly contexts: ToolContext[];
  readonly inputs: unknown[];
}

function sessionFor(ctx: CaseContext): ToolSession {
  return {
    tenant_id: CONTRACT_TENANT,
    user_id: 'contract-harness-user',
    permissions: ['view_financial_data', 'run_agents'],
    ...ctx.fixture.session,
  };
}

async function invokeOnce(
  ctx: CaseContext,
  tool: ErasedFinancialTool,
  input: unknown,
  options: {
    readonly connections?: RecordingConnections;
    readonly session?: ToolSession;
    readonly withoutAuthorization?: boolean;
  } = {},
): Promise<Invocation> {
  const connections =
    options.connections ?? (ctx.fixture.connections === undefined ? recordingConnections() : ctx.fixture.connections());
  const audit = recordingAudit();
  const probe = instrumented(tool);
  const invoker = createToolInvoker({
    connections,
    audit,
    actor: ctx.actor,
    now: ctx.now,
    ...(options.withoutAuthorization === true || ctx.fixture.authorization === undefined
      ? {}
      : { authorization: ctx.fixture.authorization }),
  });
  const result = await invoker.invoke(invocable(probe.tool), options.session ?? sessionFor(ctx), input);
  return { result, connections, audit, contexts: probe.contexts, inputs: probe.inputs };
}

/* -------------------------------------------------------------------------- */
/* The cases                                                                  */
/* -------------------------------------------------------------------------- */

/** One generated case: a name for the `it`, and a run that answers findings. */
export interface ToolContractCase {
  readonly tool: string;
  readonly check: ContractCheck;
  readonly name: string;
  run(): Promise<readonly ContractFinding[]>;
}

/* --- 1. The declaration, which the registry already audited ---------------- */

/**
 * The registration-time half, re-proven per catalogue entry.
 *
 * `createToolRegistry` already threw for any of these, so a finding here means the
 * registry was bypassed — a tool assembled by hand, or an audit that stopped short.
 * The negative direction, that a malformed declaration is actually refused, is
 * `./tool-contract.test.ts`'s specimen declarations.
 */
export function declarationCase(ctx: CaseContext): ToolContractCase {
  const { tool, audit } = ctx.entry;
  return {
    tool: tool.name,
    check: 'declaration',
    name: 'declares a bounded, strict, session-scoped input schema and a typed output schema',
    run(): Promise<readonly ContractFinding[]> {
      const findings: ContractFinding[] = [];
      const flag = (detail: string): void => {
        findings.push(finding(tool.name, 'declaration', detail));
      };

      if (!TOOL_NAME_RE.test(tool.name)) {
        flag(`name ${JSON.stringify(tool.name)} does not match ${String(TOOL_NAME_RE)}`);
      }
      if (!TOOL_MODES.includes(tool.mode)) {
        flag(`declares mode ${JSON.stringify(tool.mode)}`);
      }
      if (tool.timeoutMs !== TOOL_TIMEOUT_MS) {
        flag(`declares timeoutMs ${String(tool.timeoutMs)}; the bound is the literal ${TOOL_TIMEOUT_MS} ms`);
      }
      try {
        auditToolDeclaration(tool);
      } catch (error) {
        flag(
          `the registration audit refuses this declaration, so it entered the catalogue by some ` +
            `other path: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const declaredFreeText = new Set(tool.freeTextArguments ?? []);
      for (const argument of audit.arguments) {
        if (!['pattern', 'length', 'closed', 'non_text'].includes(argument.bound)) {
          flag(`argument ${argument.path} reports an unknown bound ${JSON.stringify(argument.bound)}`);
        }
        if (argument.bound === 'length' && !declaredFreeText.has(argument.path)) {
          flag(
            `argument ${argument.path} is bounded only by length but is not named in ` +
              `freeTextArguments, so free-form prose is admitted without a visible allowance`,
          );
        }
        for (const segment of segmentsOf(argument.path)) {
          if (segment.kind !== 'key') {
            continue;
          }
          if (segment.key === SESSION_ONLY_ARGUMENT) {
            flag(`declares an argument ${argument.path}; the Tenant comes from the session only`);
          }
          if (REFUSED_ARGUMENT_NAMES.includes(segment.key)) {
            flag(`declares an argument ${argument.path}, which reads as query passthrough`);
          }
        }
      }
      for (const path of declaredFreeText) {
        if (!audit.freeTextMatched.includes(path)) {
          flag(`freeTextArguments names ${path}, which the audit did not match to a string argument`);
        }
      }
      if (tool.outputSchema.safeParse(undefined).success) {
        flag('the declared output schema accepts `undefined`, so it constrains no output');
      }
      return Promise.resolve(findings);
    },
  };
}

/* --- 2. A conforming input is accepted ------------------------------------ */

export function validInputCase(ctx: CaseContext): ToolContractCase {
  const { tool } = ctx.entry;
  return {
    tool: tool.name,
    check: 'valid_input_accepted',
    name: 'accepts a conforming input and commits',
    async run(): Promise<readonly ContractFinding[]> {
      const findings: ContractFinding[] = [];
      const flag = (detail: string): void => {
        findings.push(finding(tool.name, 'valid_input_accepted', detail));
      };

      const parsed = tool.inputSchema.safeParse(ctx.fixture.validInput);
      if (!parsed.success) {
        flag(
          `the fixture's validInput does not satisfy the declared input schema: ` +
            `${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`,
        );
        return findings;
      }

      const invocation = await invokeOnce(ctx, tool, ctx.fixture.validInput);
      const { result } = invocation;
      if (!result.ok) {
        flag(
          `a conforming input yielded ${result.kind}` +
            (result.kind === 'schema_violation'
              ? `: ${result.violations.map((v) => `${v.argument} ${v.reason}`).join('; ')}`
              : ''),
        );
        return findings;
      }
      if (invocation.inputs.length !== 1) {
        flag(`execute was called ${invocation.inputs.length} times for one invocation`);
      }
      if (invocation.connections.dispositions.join(',') !== 'commit') {
        flag(
          `a validated success released the connection as ` +
            `[${invocation.connections.dispositions.join(', ')}]; only a checked success commits`,
        );
      }
      if (invocation.audit.events.length > 0) {
        flag(`an accepted invocation appended ${invocation.audit.events.map((e) => e.eventType).join(', ')}`);
      }
      // The Tenant reached the tool through the context, never through an argument.
      const handed = invocation.inputs[0];
      if (typeof handed === 'object' && handed !== null && SESSION_ONLY_ARGUMENT in handed) {
        flag('the parsed input handed to execute carries tenant_id');
      }
      if (invocation.contexts[0]?.tenant_id !== sessionFor(ctx).tenant_id) {
        flag('the context Tenant is not the session Tenant');
      }
      return findings;
    },
  };
}

/* --- 3. Every declared argument is actually exercised --------------------- */

export function argumentCoverageCase(ctx: CaseContext): ToolContractCase {
  const { tool, audit } = ctx.entry;
  return {
    tool: tool.name,
    check: 'argument_coverage',
    name: "the fixture's validInput populates every declared argument",
    run(): Promise<readonly ContractFinding[]> {
      const findings: ContractFinding[] = [];
      const unreachable = unreachableArgumentPaths(ctx.entry, ctx.fixture.validInput);
      if (unreachable.length > 0) {
        findings.push(
          finding(
            tool.name,
            'argument_coverage',
            `validInput does not populate ${unreachable.join(', ')}, so no wrong-type or ` +
              `free-form-text case could be generated for ${unreachable.length === 1 ? 'it' : 'them'}. ` +
              `Populate every declared argument, including the optional ones`,
          ),
        );
      }
      const generated = nonConformingCasesFor(ctx.entry, ctx.fixture.validInput);
      const perArgument = generated.filter((c) => c.argument !== null && c.argument !== UNKNOWN_KEY);
      if (audit.arguments.length > 0 && perArgument.length === 0) {
        findings.push(
          finding(
            tool.name,
            'argument_coverage',
            `${audit.arguments.length} arguments are declared but no per-argument rejection case ` +
              `was generated; the schema-violation case would prove nothing`,
          ),
        );
      }
      return Promise.resolve(findings);
    },
  };
}

/* --- 4. schema_violation, with no query issued (Requirement 12.9) --------- */

/**
 * One case per generated non-conforming input.
 *
 * Four assertions per input, and the last two are the ones that matter: the result is
 * a `schema_violation` **naming the argument**, `acquire` was called **zero** times,
 * `execute` was called **zero** times, and `tool_invocation_rejected` was appended
 * carrying argument names but not the rejected value.
 */
export function schemaViolationCase(ctx: CaseContext): ToolContractCase {
  const { tool } = ctx.entry;
  return {
    tool: tool.name,
    check: 'schema_violation',
    name: 'refuses unknown keys, wrong types, smuggled tenant_id and free-form SQL with no query issued',
    async run(): Promise<readonly ContractFinding[]> {
      const findings: ContractFinding[] = [];
      const flag = (detail: string): void => {
        findings.push(finding(tool.name, 'schema_violation', detail));
      };

      for (const nonConforming of nonConformingCasesFor(ctx.entry, ctx.fixture.validInput)) {
        const invocation = await invokeOnce(ctx, tool, nonConforming.input);
        const { result, connections, audit } = invocation;
        const where = `given ${nonConforming.label},`;

        if (result.ok || result.kind !== 'schema_violation') {
          flag(`${where} the invocation was not refused as a schema_violation (got ${result.ok ? 'ok' : result.kind})`);
          continue;
        }
        if (result.violations.length === 0) {
          flag(`${where} the schema_violation names no argument`);
        }
        if (
          nonConforming.argument !== null &&
          !result.violations.some((v) => v.argument === nonConforming.argument || v.argument.startsWith(`${nonConforming.argument}.`))
        ) {
          flag(
            `${where} the schema_violation names [${result.violations
              .map((v) => v.argument)
              .join(', ')}] rather than ${nonConforming.argument}`,
          );
        }
        if (connections.acquired.length > 0) {
          flag(`${where} ${connections.acquired.length} connection(s) were acquired; a refused invocation reads nothing`);
        }
        if (invocation.inputs.length > 0) {
          flag(`${where} execute was called despite the refusal`);
        }
        const events = audit.events;
        if (events.length !== 1 || events[0]?.eventType !== 'tool_invocation_rejected') {
          flag(`${where} the appended Audit_Events were [${events.map((e) => e.eventType).join(', ')}]`);
        }
        if (events[0]?.outcome !== 'blocked') {
          flag(`${where} the Audit_Event outcome was ${String(events[0]?.outcome)} rather than blocked`);
        }
        const payload = JSON.stringify(events[0]?.payload ?? {});
        if (payload.includes(SQL_PROBE) || payload.includes(OVER_LONG_PROBE.slice(0, 64))) {
          flag(`${where} the rejected argument value reached the Audit_Log payload`);
        }
      }
      return findings;
    },
  };
}

/* --- 5. The output validates against the declared schema ------------------ */

export function outputSchemaCase(ctx: CaseContext): ToolContractCase {
  const { tool } = ctx.entry;
  return {
    tool: tool.name,
    check: 'output_schema',
    name: 'validates its output against the declared schema, and refuses output that drifts from it',
    async run(): Promise<readonly ContractFinding[]> {
      const findings: ContractFinding[] = [];
      const flag = (detail: string): void => {
        findings.push(finding(tool.name, 'output_schema', detail));
      };

      const invocation = await invokeOnce(ctx, tool, ctx.fixture.validInput);
      if (invocation.result.ok) {
        const validated = tool.outputSchema.safeParse(invocation.result.value);
        if (!validated.success) {
          flag(
            `the returned value does not satisfy the declared output schema: ` +
              `${validated.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`,
          );
        }
      }

      const drift = outputDriftValueFor(tool);
      if (drift === null) {
        flag(
          'the declared output schema accepts null, undefined, an unrelated object and a bare ' +
            'number, so it constrains nothing and output drift is undetectable',
        );
        return findings;
      }
      const drifted = await invokeOnce(ctx, driftingVariant(tool, drift.value), ctx.fixture.validInput);
      const result = drifted.result;
      if (result.ok || result.kind !== 'tool_failure' || result.cause !== 'execution_error') {
        flag(
          `output the declared schema rejects yielded ${result.ok ? 'a returned figure' : result.kind} ` +
            `rather than tool_failure with cause execution_error`,
        );
      }
      if (drifted.connections.dispositions.join(',') !== 'rollback') {
        flag(`drifting output released the connection as [${drifted.connections.dispositions.join(', ')}]`);
      }
      const event = drifted.audit.events[0];
      if (event?.eventType !== 'tool_failure') {
        flag(`drifting output appended [${drifted.audit.events.map((e) => e.eventType).join(', ')}]`);
      }
      if (JSON.stringify(event?.payload ?? {}).includes('output_schema_violation') === false) {
        flag('the tool_failure payload does not record output_schema_violation as the reason');
      }
      return findings;
    },
  };
}

/* --- 6. The declared mode is backed by the connection --------------------- */

/**
 * What is provable about `mode` today.
 *
 * The connection handed to the tool is the one the provider answers for `tool.mode`,
 * and a provider answering the other mode is a `ToolContractError` rather than a
 * silent fallback. **Not** provable until task 26.1: that a `read_only` tool
 * attempting an `INSERT` is refused by the database, because the role with no write
 * grants is created in that migration. See the module doc comment.
 */
export function modeCase(ctx: CaseContext): ToolContractCase {
  const { tool } = ctx.entry;
  const other: ToolMode = tool.mode === 'read_only' ? 'write_capable' : 'read_only';
  return {
    tool: tool.name,
    check: 'mode',
    name: `runs on the connection acquired for its declared mode (${tool.mode})`,
    async run(): Promise<readonly ContractFinding[]> {
      const findings: ContractFinding[] = [];
      const flag = (detail: string): void => {
        findings.push(finding(tool.name, 'mode', detail));
      };

      try {
        const invocation = await invokeOnce(ctx, tool, ctx.fixture.validInput);
        if (invocation.connections.acquired.join(',') !== tool.mode) {
          flag(
            `a conforming invocation acquired [${invocation.connections.acquired.join(', ')}] for a ` +
              `${tool.mode} tool`,
          );
        }
      } catch (error) {
        // A provider that cannot answer the declared mode is the one contract fault
        // the invoker raises rather than returning, so it is reported as a finding
        // here instead of escaping as an exception from the generated case.
        flag(
          `a conforming invocation on a ${tool.mode} tool threw: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // A declaration is only worth the privilege behind it, so a provider answering
      // the wrong mode must be a fault rather than a fallback.
      const wrongMode = recordingConnections({ answerMode: other });
      try {
        const answered = await invokeOnce(ctx, tool, ctx.fixture.validInput, { connections: wrongMode });
        flag(
          `a provider answering a ${other} connection for a ${tool.mode} tool was accepted, ` +
            `returning ${answered.result.ok ? 'a figure' : answered.result.kind}`,
        );
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes(tool.mode)) {
          flag(`a wrong-mode connection threw ${String(error)}, which does not name the declared mode`);
        }
        if (wrongMode.dispositions.join(',') !== 'rollback') {
          flag(`a wrong-mode connection was released as [${wrongMode.dispositions.join(', ')}]`);
        }
      }
      return findings;
    },
  };
}

/* --- 7. write_capable needs an authorized Proposal (Requirement 12.10) ----- */

export function writeAuthorizationCase(ctx: CaseContext): ToolContractCase {
  const { tool } = ctx.entry;
  const isWrite = tool.mode === 'write_capable';
  return {
    tool: tool.name,
    check: 'write_authorization',
    name: isWrite
      ? 'refuses an invocation carrying no authorized Proposal, leaving Tenant state untouched'
      : 'needs no Proposal, being read_only',
    async run(): Promise<readonly ContractFinding[]> {
      const findings: ContractFinding[] = [];
      const flag = (detail: string): void => {
        findings.push(finding(tool.name, 'write_authorization', detail));
      };
      const session = sessionFor(ctx);

      if (!isWrite) {
        if (session.proposal_id !== undefined || session.authorization_id !== undefined) {
          flag('a read_only fixture supplies a Proposal pair, which a read never needs');
        }
        const invocation = await invokeOnce(ctx, tool, ctx.fixture.validInput);
        if (!invocation.result.ok && invocation.result.kind === 'unauthorized_write') {
          flag('a read_only tool was refused as an unauthorized write');
        }
        return findings;
      }

      if (session.proposal_id === undefined || session.authorization_id === undefined) {
        flag('a write_capable fixture must supply session.proposal_id and session.authorization_id');
      }
      if (ctx.fixture.authorization === undefined) {
        flag('a write_capable fixture must supply an authorization lookup answering for that pair');
      }

      // Neither identifier: refused before any connection is acquired.
      const bare = await invokeOnce(ctx, tool, ctx.fixture.validInput, {
        session: { ...session, proposal_id: undefined, authorization_id: undefined },
      });
      if (bare.result.ok || bare.result.kind !== 'unauthorized_write') {
        flag(`an invocation carrying no Proposal pair yielded ${bare.result.ok ? 'a figure' : bare.result.kind}`);
      }
      if (bare.connections.acquired.length > 0) {
        flag('an unauthorized write acquired a connection; Tenant state must be untouched');
      }
      if (bare.inputs.length > 0) {
        flag('an unauthorized write reached execute');
      }
      if (bare.audit.events[0]?.eventType !== 'unauthorized_write_rejected') {
        flag(`an unauthorized write appended [${bare.audit.events.map((e) => e.eventType).join(', ')}]`);
      }

      // The pair present but no authorization source at all: fails closed.
      const closed = await invokeOnce(ctx, tool, ctx.fixture.validInput, { withoutAuthorization: true });
      if (closed.result.ok || closed.result.kind !== 'unauthorized_write') {
        flag(
          `with no authorization source the invocation yielded ` +
            `${closed.result.ok ? 'a figure' : closed.result.kind}; an absent source is not an authorization`,
        );
      }
      return findings;
    },
  };
}

/* --- 8. Every monetary field carries a resolvable chain (Req 12.2) --------- */

export function monetaryEvidenceCase(ctx: CaseContext): ToolContractCase {
  const { tool } = ctx.entry;
  const declared = monetaryFieldPathsOf(tool.outputSchema);
  return {
    tool: tool.name,
    check: 'monetary_evidence',
    name:
      declared.length === 0
        ? 'declares no monetary field, so there is no figure to ground'
        : `grounds every monetary field (${declared.join(', ')}) in a resolvable Evidence_Chain`,
    async run(): Promise<readonly ContractFinding[]> {
      const findings: ContractFinding[] = [];
      const flag = (detail: string): void => {
        findings.push(finding(tool.name, 'monetary_evidence', detail));
      };
      if (declared.length === 0) {
        return findings;
      }

      const resolver = ctx.fixture.resolveEvidenceChain;
      if (resolver === undefined) {
        flag(
          `the output schema declares monetary fields (${declared.join(', ')}) but the fixture ` +
            `supplies no resolveEvidenceChain, so "resolvable" could only be checked as far as ` +
            `UUID well-formedness. Requirement 12.6 withholds a whole response for an identifier ` +
            `that resolves to nothing`,
        );
      }

      const invocation = await invokeOnce(ctx, tool, ctx.fixture.validInput);
      const result = invocation.result;
      if (!result.ok) {
        flag(`a conforming invocation yielded ${result.kind}, so no figure could be checked`);
        return findings;
      }

      const envelope = result.evidence.evidence_chain_id;
      if (!UUID_RE.test(envelope)) {
        flag(`the envelope evidence_chain_id ${JSON.stringify(envelope)} is not a UUID`);
      }
      const attributions = attributeMonetaryFields(result.value, envelope);
      if (attributions.length === 0) {
        flag(
          `the output schema declares monetary fields (${declared.join(', ')}) but this ` +
            `invocation returned none, so their grounding was not exercised. Supply a validInput ` +
            `whose result carries a figure`,
        );
        return findings;
      }

      const toResolve = new Map<string, MonetaryAttribution[]>();
      for (const attribution of attributions) {
        if (typeof attribution.value === 'number') {
          // A figure that has been through an IEEE-754 double cannot be un-rounded.
          flag(
            `${attribution.path} is a JavaScript number; a monetary field is a bigint in process ` +
              `and a decimal string on the wire (Requirement 15.1, 15.8)`,
          );
        }
        if (attribution.chainId === null) {
          flag(
            `${attribution.path} is covered by no evidence_chain_id: neither an enclosing object ` +
              `nor the envelope declares one, so this figure is not Tool_Grounded`,
          );
          continue;
        }
        if (!UUID_RE.test(attribution.chainId)) {
          flag(`${attribution.path} cites evidence_chain_id ${JSON.stringify(attribution.chainId)}, not a UUID`);
          continue;
        }
        const bucket = toResolve.get(attribution.chainId) ?? [];
        bucket.push(attribution);
        toResolve.set(attribution.chainId, bucket);
      }

      if (resolver === undefined) {
        return findings;
      }
      for (const [chainId, grounded] of toResolve) {
        const chain = await resolver(chainId);
        if (chain === null) {
          flag(
            `evidence_chain_id ${chainId}, cited by ${grounded.map((g) => g.path).join(', ')}, does ` +
              `not resolve to a stored Evidence_Chain`,
          );
          continue;
        }
        if (chain.evidence_chain_id !== chainId) {
          flag(`resolving ${chainId} answered a chain identified as ${chain.evidence_chain_id}`);
        }
        // Only where the pairing is unambiguous: a row with several figures gives no
        // way to say which one the chain's figure_paise is meant to be.
        for (const attribution of grounded) {
          if (grounded.length !== 1 || attribution.siblingMonetaryFields !== 1) {
            continue;
          }
          const stated = monetaryValueOf(attribution.value);
          if (stated === null) {
            flag(`${attribution.path} is neither a bigint nor a decimal string, so it cannot be a Paise figure`);
            continue;
          }
          if (stated !== chain.figure_paise) {
            flag(
              `${attribution.path} states ${stated} paise but its Evidence_Chain ${chainId} ` +
                `presents ${chain.figure_paise}`,
            );
          }
        }
      }
      return findings;
    },
  };
}

/** A monetary value as `bigint`: a `bigint`, or a decimal string. Never a number. */
function monetaryValueOf(value: unknown): bigint | null {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) {
    return BigInt(value);
  }
  return null;
}

/* --- 9. A hidden contributing record yields incomplete_evidence (Req 12.3) - */

/** One figure a tool withheld inside `Out`, with what it said about why. */
interface WithheldFigure {
  readonly path: string;
  readonly unavailable: readonly unknown[];
  /** `*_paise` keys on the withholding object. Requirement 12.3 admits none. */
  readonly monetaryKeys: readonly string[];
  /** Whether it cites a chain. A withheld figure has none to cite. */
  readonly citesChain: boolean;
}

/**
 * Every place inside a returned value where a figure was withheld.
 *
 * Found by shape rather than by label: an object carrying an `unavailable` array is
 * making Requirement 12.3's statement, whatever the surrounding discriminator is called.
 * `get_control_tower_metrics` spells it `{ state: 'incomplete_evidence', unavailable }`;
 * this walk does not require that spelling, so a later tool withholding one figure of
 * several is covered without the harness learning its cell type.
 */
function withheldFiguresIn(value: unknown): readonly WithheldFigure[] {
  const withheld: WithheldFigure[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((element, index) => {
        walk(element, `${path}[${index}]`);
      });
      return;
    }
    if (typeof node !== 'object' || node === null || node instanceof Date) {
      return;
    }
    const owner = node as Record<string, unknown>;
    const unavailable = owner['unavailable'];
    if (Array.isArray(unavailable)) {
      withheld.push({
        path: path === '' ? '(root)' : path,
        unavailable: unavailable as readonly unknown[],
        monetaryKeys: Object.keys(owner).filter((key) => MONETARY_KEY_RE.test(key)),
        citesChain: typeof owner['evidence_chain_id'] === 'string',
      });
      return;
    }
    for (const [key, child] of Object.entries(owner)) {
      walk(child, path === '' ? key : `${path}.${key}`);
    }
  };
  walk(value, '');
  return withheld;
}

/** One `{ type, count }` entry of an `unavailable` list, checked. */
function unavailableEntryFindings(
  tool: string,
  where: string,
  entry: unknown,
): readonly ContractFinding[] {
  const findings: ContractFinding[] = [];
  if (typeof entry !== 'object' || entry === null) {
    return [finding(tool, 'incomplete_evidence', `${where} reports ${String(entry)} as an unavailable type`)];
  }
  const record = entry as Record<string, unknown>;
  const type = record['type'];
  const count = record['count'];
  if (typeof type !== 'string' || !(SOURCE_RECORD_TYPES as readonly string[]).includes(type)) {
    findings.push(
      finding(tool, 'incomplete_evidence', `${where} names ${JSON.stringify(type)}, which is not a source_record_type`),
    );
  }
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) {
    findings.push(
      finding(tool, 'incomplete_evidence', `${where} reports count ${String(count)} for ${String(type)}`),
    );
  }
  return findings;
}

/**
 * The `'per_figure'` half of Requirement 12.3: the unreadable contributor's figure is
 * withheld and the rest of the answer survives.
 *
 * See {@link ToolContractFixture.incompleteEvidenceScope} for why this branch exists.
 */
function perFigureWithholdingFindings(
  ctx: CaseContext,
  result: ToolResult<unknown>,
): readonly ContractFinding[] {
  const tool = ctx.entry.tool.name;
  const findings: ContractFinding[] = [];
  const flag = (detail: string): void => {
    findings.push(finding(tool, 'incomplete_evidence', detail));
  };

  if (!result.ok) {
    flag(
      `one unreadable contributor yielded ${result.kind} for a tool that withholds per figure; ` +
        `the figures that could still be grounded must survive it (Requirement 3.9)`,
    );
    return findings;
  }

  const withheld = withheldFiguresIn(result.value);
  if (withheld.length === 0) {
    flag(
      'an unreadable contributing record withheld no figure: no part of the returned value ' +
        'reports an unavailable Source_Record type, so a figure was presented over a record ' +
        'that could not be read (Requirement 12.3)',
    );
    return findings;
  }

  for (const entry of withheld) {
    if (entry.unavailable.length === 0) {
      flag(`${entry.path} withholds a figure and identifies no unavailable Source_Record type`);
    }
    for (const unavailable of entry.unavailable) {
      findings.push(...unavailableEntryFindings(tool, `${entry.path}.unavailable`, unavailable));
    }
    if (entry.monetaryKeys.length > 0) {
      // Requirement 12.3 omits the figure entirely: not zeroed, not nulled, not beside
      // a count.
      flag(`${entry.path} withholds a figure and still carries [${entry.monetaryKeys.join(', ')}]`);
    }
    if (entry.citesChain) {
      flag(`${entry.path} withholds a figure and still cites an evidence_chain_id`);
    }
  }

  // The other figures survived, and are still grounded. Without this the branch would
  // accept a tool that withheld everything and called it isolation.
  const surviving = attributeMonetaryFields(result.value, result.evidence.evidence_chain_id);
  if (surviving.length === 0) {
    flag(
      'every figure was withheld, so per-figure isolation was not exercised: supply a ' +
        'hiddenContributingRecord that hides one contributor rather than all of them',
    );
  }
  for (const attribution of surviving) {
    if (attribution.chainId === null || !UUID_RE.test(attribution.chainId)) {
      flag(
        `${attribution.path} survived the withholding but is grounded by ` +
          `${JSON.stringify(attribution.chainId)}, which is not a resolvable chain identifier`,
      );
    }
  }
  return findings;
}

export function incompleteEvidenceCase(ctx: CaseContext): ToolContractCase {
  const { tool } = ctx.entry;
  const declared = monetaryFieldPathsOf(tool.outputSchema);
  return {
    tool: tool.name,
    check: 'incomplete_evidence',
    name:
      declared.length === 0
        ? 'composes no Evidence_Chain, so there is no figure to withhold'
        : 'returns incomplete_evidence with no figure when a contributing record cannot be read',
    async run(): Promise<readonly ContractFinding[]> {
      const findings: ContractFinding[] = [];
      const flag = (detail: string): void => {
        findings.push(finding(tool.name, 'incomplete_evidence', detail));
      };
      if (declared.length === 0) {
        return findings;
      }
      const build = ctx.fixture.hiddenContributingRecord;
      if (build === undefined) {
        flag(
          `the output schema declares monetary fields (${declared.join(', ')}) but the fixture ` +
            `supplies no hiddenContributingRecord, so Requirement 12.3 is untested for this tool`,
        );
        return findings;
      }

      const variant = build();
      if (variant.name !== tool.name || variant.mode !== tool.mode) {
        flag(
          `hiddenContributingRecord returned ${variant.name} (${variant.mode}) rather than the same ` +
            `declaration as ${tool.name} (${tool.mode})`,
        );
      }
      const invocation = await invokeOnce(ctx, variant, ctx.fixture.validInput);
      const result = invocation.result;
      if (ctx.fixture.incompleteEvidenceScope === 'per_figure') {
        findings.push(...perFigureWithholdingFindings(ctx, result));
        return findings;
      }
      if (result.ok || result.kind !== 'incomplete_evidence') {
        flag(
          `an unreadable contributing record yielded ${result.ok ? 'a figure' : result.kind} rather ` +
            `than incomplete_evidence`,
        );
        return findings;
      }
      if (result.unavailable.length === 0) {
        flag('incomplete_evidence identifies no unavailable Source_Record type');
      }
      for (const entry of result.unavailable) {
        if (!(SOURCE_RECORD_TYPES as readonly string[]).includes(entry.type)) {
          flag(`incomplete_evidence names ${JSON.stringify(entry.type)}, which is not a source_record_type`);
        }
        if (!Number.isSafeInteger(entry.count) || entry.count < 1) {
          flag(`incomplete_evidence reports count ${String(entry.count)} for ${entry.type}`);
        }
      }
      // Requirement 12.3 omits the figure entirely: not zeroed, not nulled, not
      // beside a count. The result's own key set is the proof.
      const keys = Object.keys(result).sort();
      if (keys.join(',') !== 'kind,ok,unavailable') {
        flag(`the incomplete_evidence result carries keys [${keys.join(', ')}]; the figure must be absent`);
      }
      if (attributeMonetaryFields(result, null).length > 0) {
        flag('the incomplete_evidence result carries a monetary field somewhere in its payload');
      }
      if (invocation.connections.dispositions.join(',') !== 'rollback') {
        flag(`incomplete_evidence released the connection as [${invocation.connections.dispositions.join(', ')}]`);
      }
      const event = invocation.audit.events[0];
      if (event?.eventType !== 'incomplete_evidence') {
        flag(`incomplete_evidence appended [${invocation.audit.events.map((e) => e.eventType).join(', ')}]`);
      }
      if (JSON.stringify(event?.payload ?? {}).includes('"count"') === false) {
        flag('the incomplete_evidence Audit_Event payload carries no per-type counts');
      }
      return findings;
    },
  };
}

/* --- 10. Holding past 10 s (Requirement 12.11) ---------------------------- */

/**
 * Under **fake timers**. A real ten-second wait per tool would make this suite take
 * minutes to prove one branch, and the bound is a `setTimeout`, so advancing the
 * clock exercises the same code path.
 */
export function timeoutCase(ctx: CaseContext): ToolContractCase {
  const { tool } = ctx.entry;
  return {
    tool: tool.name,
    check: 'timeout',
    name: `held past ${TOOL_TIMEOUT_MS} ms, returns tool_failure with cause timeout and rolls back`,
    async run(): Promise<readonly ContractFinding[]> {
      const findings: ContractFinding[] = [];
      const flag = (detail: string): void => {
        findings.push(finding(tool.name, 'timeout', detail));
      };

      const held = ctx.fixture.holdPastDeadline === undefined ? heldVariant(tool) : ctx.fixture.holdPastDeadline();
      if (held.name !== tool.name || held.timeoutMs !== tool.timeoutMs) {
        flag(`holdPastDeadline returned ${held.name} with bound ${String(held.timeoutMs)}`);
      }
      const probe = instrumented(held);
      const connections = ctx.fixture.connections === undefined ? recordingConnections() : ctx.fixture.connections();
      const audit = recordingAudit();
      const invoker = createToolInvoker({
        connections,
        audit,
        actor: ctx.actor,
        now: ctx.now,
        ...(ctx.fixture.authorization === undefined ? {} : { authorization: ctx.fixture.authorization }),
      });

      vi.useFakeTimers();
      try {
        let settled = false;
        const pending = invoker
          .invoke(invocable(probe.tool), sessionFor(ctx), ctx.fixture.validInput)
          .then((result) => {
            settled = true;
            return result;
          });
        await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_MS - 1);
        if (settled) {
          flag(`the invocation settled before ${TOOL_TIMEOUT_MS} ms had elapsed`);
        }
        await vi.advanceTimersByTimeAsync(1);
        // Returns rather than hangs: an unresolved promise here fails the case on the
        // project's own 30 s test timeout, which is above the 10 s bound on purpose.
        const result = await pending;

        if (result.ok || result.kind !== 'tool_failure' || result.cause !== 'timeout') {
          flag(`holding past the bound yielded ${result.ok ? 'a figure' : result.kind} rather than a timeout`);
        } else if (result.tool !== tool.name) {
          flag(`the tool_failure names ${result.tool} rather than ${tool.name}`);
        }
        if (probe.contexts[0]?.signal.aborted !== true) {
          flag('ctx.signal was not aborted at the deadline, so a signal-aware tool would keep running');
        }
        if (connections.dispositions.join(',') !== 'rollback') {
          flag(
            `a timeout released the connection as [${connections.dispositions.join(', ')}]; the ` +
              `rollback, not the abandoned promise, is what leaves Tenant state unchanged`,
          );
        }
        const event = audit.events[0];
        if (event?.eventType !== 'tool_failure' || event.outcome !== 'failed') {
          flag(`a timeout appended [${audit.events.map((e) => e.eventType).join(', ')}]`);
        }
        const payload = JSON.stringify(event?.payload ?? {});
        if (!payload.includes('"timeout"') || !payload.includes(String(TOOL_TIMEOUT_MS))) {
          flag(`the tool_failure payload does not record the cause and the bound: ${payload}`);
        }
      } finally {
        vi.useRealTimers();
      }
      return findings;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The suite, generated from the registry                                     */
/* -------------------------------------------------------------------------- */

/** Every case for one catalogue entry, in the order of the task text's clauses. */
export function toolContractCases(
  entry: CatalogueEntry,
  fixture: ToolContractFixture,
  options: { readonly actor?: Actor; readonly now?: () => Date } = {},
): readonly ToolContractCase[] {
  const ctx: CaseContext = {
    entry,
    fixture,
    actor: options.actor ?? CONTRACT_ACTOR,
    now: options.now ?? CONTRACT_NOW,
  };
  return [
    declarationCase(ctx),
    validInputCase(ctx),
    argumentCoverageCase(ctx),
    schemaViolationCase(ctx),
    outputSchemaCase(ctx),
    modeCase(ctx),
    writeAuthorizationCase(ctx),
    monetaryEvidenceCase(ctx),
    incompleteEvidenceCase(ctx),
    timeoutCase(ctx),
  ];
}

/**
 * Generate the whole contract suite from a registry: one `describe` per registered
 * tool, one `it` per contract clause, no hand-written case per tool.
 *
 * Three ways this fails rather than passing vacuously, which is the point of the task
 * landing before the tools:
 *
 * 1. An **empty registry** fails, unless `allowEmpty` is set. A suite that iterated
 *    nothing would be green and worthless.
 * 2. A **registered tool with no fixture** fails, so a tool cannot be added to the
 *    catalogue and left uncovered.
 * 3. A **fixture for an unregistered name** fails, so a renamed tool does not quietly
 *    lose its fixture.
 */
export function runToolContract(options: ToolContractOptions): void {
  const entries = options.registry.list();
  const names = new Set(entries.map((entry) => entry.tool.name));

  describe('the Financial_Tool catalogue', () => {
    it('holds at least one tool, so this suite proves something', () => {
      if (options.allowEmpty === true) {
        return;
      }
      expect(entries.map((entry) => entry.tool.name)).not.toEqual([]);
    });

    it('has a contract fixture for every registered tool, and no orphan fixtures', () => {
      const missingFixtures = [...names].filter((name) => options.fixtures[name] === undefined);
      const orphanFixtures = Object.keys(options.fixtures).filter((name) => !names.has(name));
      expect({ missingFixtures, orphanFixtures }).toEqual({ missingFixtures: [], orphanFixtures: [] });
    });
  });

  for (const entry of entries) {
    const fixture = options.fixtures[entry.tool.name];
    if (fixture === undefined) {
      // Reported once, above. A describe block with no fixture would be noise.
      continue;
    }
    describe(`${entry.tool.name} (${entry.tool.mode})`, () => {
      for (const contractCase of toolContractCases(entry, fixture, options)) {
        it(contractCase.name, async () => {
          const findings = await contractCase.run();
          expect(formatFindings(findings)).toEqual([]);
        });
      }
    });
  }
}

/* -------------------------------------------------------------------------- */
/* The catalogue as design.md states it                                       */
/* -------------------------------------------------------------------------- */

export interface CatalogueGaps {
  /** design.md catalogue tools this registry does not hold. */
  readonly missing: readonly string[];
  /** Registered tools design.md's catalogue does not name. */
  readonly unexpected: readonly string[];
  /** Registered tools whose mode differs from design.md's table. */
  readonly wrongMode: readonly { readonly name: string; readonly declared: ToolMode; readonly expected: ToolMode }[];
}

/**
 * How far the registry is from design.md's 20-tool catalogue.
 *
 * `@/tools/catalogue` holds **thirteen** tools as of task 24.3 — the eleven read-only ones
 * of Slice 1 and 19.4 plus `post_reconciliation_adjustment` and
 * `mark_exception_resolved` — so `missing` holds seven: six read-only tools still to be
 * built and `initiate_payment_retry`, the one write-capable tool that calls a Razorpay
 * write API. `./slice-1-catalogue.test.ts` asserts that list by name — a catalogue that
 * quietly claimed completeness would be worse than
 * one that says what it lacks — and `./tool-contract.test.ts` asserts that the catalogue
 * module is wired into {@link runToolContract}, which is the assertion that replaced
 * 10.2's "no catalogue module exists yet" trip-wire once 12.7 tripped it.
 */
export function catalogueGaps(registry: ToolRegistry): CatalogueGaps {
  const registered = new Map(registry.list().map((entry) => [entry.tool.name, entry.tool.mode]));
  const expected = new Map(DESIGN_CATALOGUE.map((tool) => [tool.name, tool.mode]));
  return {
    missing: DESIGN_CATALOGUE.filter((tool) => !registered.has(tool.name)).map((tool) => tool.name),
    unexpected: [...registered.keys()].filter((name) => !expected.has(name)),
    wrongMode: [...registered.entries()]
      .filter(([name, mode]) => expected.has(name) && expected.get(name) !== mode)
      .map(([name, mode]) => ({ name, declared: mode, expected: expected.get(name) ?? 'read_only' })),
  };
}
