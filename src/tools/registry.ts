/**
 * The Financial_Tool catalogue, and the registration-time audit that makes
 * "rejects unknown keys and rejects any free-form text or SQL argument" a checked
 * fact rather than a comment (task 10.1). Requirements 12.1, 12.7, 12.9, 12.11.
 *
 * `./tool.ts` owns the contract and the invoker. This module owns the catalogue:
 * every tool declares `name`, `mode`, `inputSchema` and `outputSchema`, and nothing
 * enters the catalogue without passing {@link auditToolDeclaration}.
 *
 * ## Registration is eager, and a rejection is a startup failure
 *
 * {@link createToolRegistry} audits every tool as it is added and throws
 * {@link ToolRegistryError} on the first failure. The alternative — auditing at
 * invocation — would let a tool with a smuggle-able argument sit in the catalogue
 * until an Agent found it, which is the wrong moment to discover it. So a
 * malformed declaration is a process that does not start, not a request that
 * fails.
 *
 * The registry is also the single source of truth the **task 10.2** contract
 * harness iterates over: {@link ToolRegistry.list} returns every tool with its
 * declared `mode`, `inputSchema`, `outputSchema`, `timeoutMs` and
 * `freeTextArguments`, which is everything 10.2 needs to drive each entry
 * generically. Names are unique and the list is in registration order, so the
 * harness produces a stable, ordered set of cases.
 *
 * ## How the free-form prohibition is actually enforced
 *
 * Requirement 12.9 forbids an argument carrying free-form query text or free-form
 * SQL. A comment cannot enforce that, so {@link auditToolDeclaration} walks the
 * input schema and requires **every string-typed leaf to be bounded**:
 *
 * | Leaf | Verdict |
 * |---|---|
 * | `z.enum([...])`, `z.literal(...)` | accepted — a closed set |
 * | `z.string().regex(...)`, `z.uuid()`, `z.iso.date()`, any `string_format` check | accepted — pattern-bounded |
 * | `z.number()`, `z.int()`, `z.boolean()`, `z.date()`, `z.bigint()`, `z.null()` | accepted — not text |
 * | `z.string().max(n)` with no pattern | accepted **only** if the path is named in `freeTextArguments` |
 * | `z.string()` with neither | **rejected** |
 * | `z.any()`, `z.unknown()`, `z.custom()`, `z.record(z.string(), …)` | **rejected** — unbounded by construction |
 * | any node kind this walk does not recognise | **rejected** — it fails closed |
 *
 * Two further shape rules, both about the object itself rather than its leaves:
 *
 * - **Every object node must be `.strict()`**, not only the top one. A nested
 *   `z.object({...})` strips unknown keys, and a caller whose smuggled key was
 *   stripped believes it was accepted. Verified structurally *and* behaviourally:
 *   the audit also parses a sentinel unknown key and requires an
 *   `unrecognized_keys` issue, so the check does not depend on Zod's internal
 *   representation staying put.
 * - **No argument may be named `tenant_id`, at any depth.** The Tenant comes from
 *   the session (Requirement 12.7), and a schema that declared the key would make
 *   `.strict()` accept it.
 *
 * And a name denylist: an argument named `sql`, `query`, `where`, `filter`,
 * `order_by`, `raw` or `expression` is refused whatever its type, because those are
 * the names a query-passthrough argument arrives under, and a pattern-bounded
 * `query` is still a query.
 *
 * **What this cannot catch.** It is a *shape* audit, so it proves that no argument
 * is an unbounded string; it does not prove that a bounded one is harmless. A
 * `z.string().regex(/^[a-z_]+$/)` argument that a tool then interpolates into SQL
 * is still an injection, and no schema audit can see that — parameterised queries
 * are what prevent it. A `z.enum` of 400 labels is a closed set by this audit's
 * reckoning and a rich channel by a determined caller's. And an `In` whose schema
 * is built dynamically at runtime is audited as it stood at registration.
 *
 * ## `freeTextArguments`, and why the allowance exists at all
 *
 * design.md's own catalogue contradicts Requirement 12.9:
 * `mark_exception_resolved` takes `resolution_note: string`, which is prose. Rather
 * than weaken the audit for every tool, a tool may name that one path in
 * `freeTextArguments`; the audit then requires the leaf to carry a **maximum
 * length**, and refuses a declaration whose named path does not exist or is not a
 * string, so a stale allowance breaks loudly instead of widening silently. The
 * allowance is on the tool, visible in the registry, and enumerable by the task
 * 10.2 harness — which is the point. Reported as a design.md gap in `./tool.ts`,
 * not silently patched.
 *
 * ## Scope
 *
 * No production tool is registered here. The catalogue is populated by tasks 11.x
 * and 12.x; {@link createToolRegistry} is called with their list at composition
 * time. The specimen tool in `./registry.test.ts` is a test fixture and is not
 * exported.
 */

import type { ZodType } from 'zod';

import {
  type ErasedFinancialTool,
  type FinancialTool,
  TOOL_TIMEOUT_MS,
  type ToolMode,
} from './tool';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Thrown when a declaration may not enter the catalogue.
 *
 * Always at registration, never at invocation: a tool the catalogue accepted is a
 * tool whose declaration was proven, so `invoke` has no schema-shape check to
 * repeat.
 */
export class ToolRegistryError extends Error {
  override readonly name = 'ToolRegistryError';
}

/* -------------------------------------------------------------------------- */
/* Naming                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `snake_case`, 3..64 characters. Every name in design.md's catalogue matches.
 *
 * A tool name reaches the wire as the `{tool_name}` path segment of
 * `POST /internal/tools/{tool_name}` and reaches the Audit_Log as a payload field,
 * so it is constrained to a shape that needs no escaping in either.
 */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;

/**
 * Argument names that read as query passthrough, refused whatever their type.
 *
 * Cheap and name-based, and it does not pretend otherwise: it catches the obvious
 * `{ sql: '...' }` and `{ where: '...' }` shapes and nothing subtler. The load is
 * carried by the string-boundedness rule above; this is a second, independent
 * screen at the place a reviewer would look first.
 */
export const REFUSED_ARGUMENT_NAMES: readonly string[] = [
  'sql',
  'query',
  'where',
  'filter',
  'order_by',
  'raw',
  'expression',
] as const;

/** The one name that must never be an argument at any depth (Requirement 12.7). */
export const SESSION_ONLY_ARGUMENT = 'tenant_id';

/** The key the strictness probe sends. Chosen so no real schema could declare it. */
const UNKNOWN_KEY_PROBE = '__financeos_unknown_key_probe__';

/* -------------------------------------------------------------------------- */
/* Zod introspection                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The internals this audit reads: `schema._zod.def`, which is Zod 4's public-ish
 * definition record.
 *
 * Declared structurally rather than imported because Zod's own `$ZodTypeDef` union
 * is not exported in a shape that discriminates usefully. The audit's fail-closed
 * default is what makes reading internals safe: an unrecognised node is rejected,
 * so a Zod upgrade that renames a field turns into a loud registration failure
 * rather than a silently skipped check.
 */
interface ZodDef {
  readonly type?: string;
  readonly format?: string;
  readonly checks?: readonly { readonly _zod?: { readonly def?: { readonly check?: string } } }[];
  readonly shape?: Readonly<Record<string, unknown>>;
  readonly catchall?: unknown;
  readonly element?: unknown;
  readonly items?: readonly unknown[];
  readonly rest?: unknown;
  readonly options?: readonly unknown[];
  readonly left?: unknown;
  readonly right?: unknown;
  readonly innerType?: unknown;
  readonly in?: unknown;
  readonly out?: unknown;
  readonly keyType?: unknown;
  readonly valueType?: unknown;
  readonly getter?: () => unknown;
  readonly values?: readonly unknown[];
  readonly entries?: Readonly<Record<string, unknown>>;
}

function defOf(schema: unknown): ZodDef | null {
  if (typeof schema !== 'object' || schema === null) {
    return null;
  }
  const internals = (schema as { readonly _zod?: { readonly def?: unknown } })._zod;
  const def = internals?.def;
  if (typeof def !== 'object' || def === null) {
    return null;
  }
  return def as ZodDef;
}

function checkNames(def: ZodDef): readonly string[] {
  return (def.checks ?? []).map((check) => check._zod?.def?.check ?? '');
}

/** A string leaf constrained to a pattern: `z.uuid()`, `.regex()`, `z.iso.date()`. */
function isPatternBounded(def: ZodDef): boolean {
  return def.format !== undefined || checkNames(def).includes('string_format');
}

/** A string leaf constrained only in length: prose with a ceiling. */
function isLengthBounded(def: ZodDef): boolean {
  return checkNames(def).includes('max_length');
}

/* -------------------------------------------------------------------------- */
/* The schema audit                                                           */
/* -------------------------------------------------------------------------- */

/** What the walk learned about one argument path. */
export interface AuditedArgument {
  /** Dotted, with `[]` for an array element: `entries[].amount_paise`. */
  readonly path: string;
  /** The Zod node kind at that path. */
  readonly kind: string;
  /** `pattern` for a regex or format, `length` for a bare maximum, `closed` for an enum or literal. */
  readonly bound: 'pattern' | 'length' | 'closed' | 'non_text';
}

/** What {@link auditInputSchema} reports on success. */
export interface SchemaAudit {
  /** Every leaf the walk reached, in walk order. Useful to the 10.2 harness. */
  readonly arguments: readonly AuditedArgument[];
  /** The `freeTextArguments` paths the walk actually matched. */
  readonly freeTextMatched: readonly string[];
}

/**
 * A refusal, as a value.
 *
 * Returned rather than thrown so every call site reads `throw refusal(...)`, which
 * keeps the control flow visible to a reader — and to the linter — at the end of a
 * `switch` case.
 */
function refusal(toolName: string, message: string): ToolRegistryError {
  return new ToolRegistryError(`${toolName}: ${message}`);
}

/**
 * Walk an input schema and prove every argument bounded, every object strict, and
 * no argument named `tenant_id` or a query passthrough.
 *
 * Pure and database-free: it reads the schema and nothing else, so a malformed
 * declaration is refused with no connection opened and no row read — the same
 * discipline as the composition funnel in `@/evidence/chain-builder`.
 *
 * @throws {ToolRegistryError} naming the offending path and why it was refused.
 */
export function auditInputSchema(
  toolName: string,
  schema: ZodType,
  freeTextArguments: readonly string[] = [],
): SchemaAudit {
  const declared = new Set(freeTextArguments);
  const matched = new Set<string>();
  const args: AuditedArgument[] = [];
  const seen = new Set<unknown>();

  const root = defOf(schema);
  if (root === null || root.type !== 'object') {
    throw refusal(
      toolName,
      `inputSchema must be a strict object schema; a tool's arguments are a named set, and a ` +
        `${root?.type ?? 'non-Zod'} schema at the root has no argument names to audit`,
    );
  }

  function walk(node: unknown, path: string): void {
    const def = defOf(node);
    if (def === null || def.type === undefined) {
      throw refusal(toolName, `argument ${path} is not a Zod schema, so nothing about it can be proven`);
    }
    // A recursive schema would otherwise walk forever. Seen once is audited once.
    if (seen.has(node)) {
      return;
    }
    seen.add(node);

    switch (def.type) {
      case 'object': {
        const catchall = defOf(def.catchall);
        if (catchall === null || catchall.type !== 'never') {
          throw refusal(
            toolName,
            `the object at ${path === '' ? '(root)' : path} is not strict; unknown keys must be ` +
              `rejected rather than stripped, or a caller whose smuggled key was silently ` +
              `dropped believes it was accepted. Use z.strictObject({...}) or .strict()`,
          );
        }
        for (const [key, child] of Object.entries(def.shape ?? {})) {
          const childPath = path === '' ? key : `${path}.${key}`;
          if (key === SESSION_ONLY_ARGUMENT) {
            throw refusal(
              toolName,
              `declares an argument ${childPath}; the Tenant comes from the session and never ` +
                `from a tool argument (Requirement 12.7), so the key is not an argument at any ` +
                `depth. ToolContext.tenant_id is the only Tenant a tool sees`,
            );
          }
          if (REFUSED_ARGUMENT_NAMES.includes(key)) {
            throw refusal(
              toolName,
              `declares an argument ${childPath}; an argument named ${key} is a query ` +
                `passthrough by convention, and Requirement 12.9 admits no free-form query text ` +
                `or SQL however it is spelled`,
            );
          }
          walk(child, childPath);
        }
        return;
      }

      /* Wrappers: audit what they wrap. */
      case 'optional':
      case 'nullable':
      case 'default':
      case 'prefault':
      case 'nonoptional':
      case 'readonly':
      case 'catch':
      case 'promise':
        walk(def.innerType, path);
        return;

      case 'pipe':
        // `.transform()` and `.pipe()`. The caller supplies the `in` side, so that
        // is the side an argument audit is about.
        walk(def.in, path);
        return;

      case 'lazy': {
        if (typeof def.getter !== 'function') {
          throw refusal(toolName, `argument ${path} is a lazy schema with no getter`);
        }
        walk(def.getter(), path);
        return;
      }

      case 'array':
        walk(def.element, `${path}[]`);
        return;

      case 'tuple': {
        (def.items ?? []).forEach((item, index) => {
          walk(item, `${path}[${index}]`);
        });
        if (def.rest !== undefined && def.rest !== null) {
          walk(def.rest, `${path}[]`);
        }
        return;
      }

      case 'union':
        (def.options ?? []).forEach((option, index) => {
          walk(option, `${path}|${index}`);
        });
        return;

      case 'intersection':
        walk(def.left, path);
        walk(def.right, path);
        return;

      case 'record':
      case 'map':
        // A record's keys are supplied by the caller, so the argument *names* are
        // free-form even when the values are typed. There is no bounded form of
        // that, so it is refused outright rather than audited.
        throw refusal(
          toolName,
          `argument ${path} is a ${def.type}, whose keys are caller-supplied and therefore ` +
            `free-form. Declare the arguments you accept as a strict object instead`,
        );

      /* Closed sets and non-text leaves. */
      case 'enum':
      case 'literal':
        args.push({ path, kind: def.type, bound: 'closed' });
        return;

      case 'number':
      case 'bigint':
      case 'boolean':
      case 'date':
      case 'null':
      case 'undefined':
      case 'void':
      case 'nan':
        args.push({ path, kind: def.type, bound: 'non_text' });
        return;

      case 'string': {
        if (isPatternBounded(def)) {
          args.push({ path, kind: 'string', bound: 'pattern' });
          return;
        }
        if (declared.has(path)) {
          if (!isLengthBounded(def)) {
            throw refusal(
              toolName,
              `argument ${path} is declared in freeTextArguments but carries no maximum length; ` +
                `bounded prose still needs a ceiling, or the allowance is an unbounded text ` +
                `channel with a note attached`,
            );
          }
          matched.add(path);
          args.push({ path, kind: 'string', bound: 'length' });
          return;
        }
        throw refusal(
          toolName,
          `argument ${path} is an unconstrained string. Requirement 12.9 admits no free-form ` +
            `text or SQL argument, so a string argument must carry a pattern — ` +
            `z.string().regex(...), z.uuid(), z.iso.date() — or be an enum or literal. A field ` +
            `that is genuinely prose must be named in freeTextArguments and carry a maximum ` +
            `length`,
        );
      }

      default:
        // Fail closed: `any`, `unknown`, `custom`, `symbol`, `file`,
        // `template_literal`, and anything a later Zod adds. An argument this walk
        // cannot reason about is an argument whose boundedness is unproven, and
        // unproven is not accepted.
        throw refusal(
          toolName,
          `argument ${path === '' ? '(root)' : path} is a ${def.type} schema, whose contents ` +
            `this audit cannot prove bounded. Requirement 12.9 needs every argument ` +
            `constrained, so declare it as an enum, a literal, a pattern-constrained string, ` +
            `or a number`,
        );
    }
  }

  walk(schema, '');

  for (const path of declared) {
    if (!matched.has(path)) {
      throw refusal(
        toolName,
        `freeTextArguments names ${path}, which is not a string argument of this tool's input ` +
          `schema. A stale allowance must break loudly rather than sit there widening nothing`,
      );
    }
  }

  /*
   * The behavioural half of the strictness check. The structural walk read Zod's
   * internal `catchall`; this proves the schema actually errors on an unknown key,
   * so the audit does not rest on a representation detail.
   */
  const probe = schema.safeParse({ [UNKNOWN_KEY_PROBE]: 'probe' });
  if (probe.success) {
    throw refusal(
      toolName,
      `inputSchema accepted an object carrying only the unknown key ${UNKNOWN_KEY_PROBE}; an ` +
        `input schema must reject unknown keys (Requirement 12.9)`,
    );
  }
  const rejectedTheKey = probe.error.issues.some((issue) => issue.code === 'unrecognized_keys');
  if (!rejectedTheKey) {
    throw refusal(
      toolName,
      `inputSchema rejected the probe object but reported no unrecognized_keys issue, so an ` +
        `unknown key is being stripped rather than refused. Use z.strictObject({...})`,
    );
  }

  return { arguments: args, freeTextMatched: [...matched] };
}

/**
 * Everything a declaration must satisfy: name, mode, bound, both schemas present,
 * and the whole input-schema audit.
 *
 * @throws {ToolRegistryError} on the first failure.
 */
export function auditToolDeclaration(tool: ErasedFinancialTool): SchemaAudit {
  if (!TOOL_NAME_RE.test(tool.name)) {
    throw new ToolRegistryError(
      `${JSON.stringify(tool.name)} is not a Financial_Tool name: snake_case, 3..64 characters, ` +
        `matching ${String(TOOL_NAME_RE)}. The name is a URL path segment and an Audit_Log ` +
        `payload field`,
    );
  }
  if (tool.mode !== 'read_only' && tool.mode !== 'write_capable') {
    throw refusal(tool.name, `declares mode ${JSON.stringify(tool.mode)}; the modes are read_only and write_capable`);
  }
  if (tool.timeoutMs !== TOOL_TIMEOUT_MS) {
    throw refusal(
      tool.name,
      `declares timeoutMs ${String(tool.timeoutMs)}; Requirement 12.11 fixes the bound at ` +
        `${TOOL_TIMEOUT_MS} ms and a tool does not choose its own`,
    );
  }
  if (defOf(tool.outputSchema) === null) {
    throw refusal(tool.name, `declares no output schema; Requirement 12.1 wants a typed output schema`);
  }
  if (typeof tool.execute !== 'function') {
    throw refusal(tool.name, `declares no execute function`);
  }
  return auditInputSchema(tool.name, tool.inputSchema, tool.freeTextArguments ?? []);
}

/* -------------------------------------------------------------------------- */
/* The registry                                                               */
/* -------------------------------------------------------------------------- */

/** One catalogue entry: the erased tool plus what the audit learned about it. */
export interface CatalogueEntry {
  readonly tool: ErasedFinancialTool;
  readonly audit: SchemaAudit;
}

/**
 * The catalogue. Immutable once built, so the set of tools an Agent can reach
 * cannot change under it.
 */
export interface ToolRegistry {
  /** The erased tool, or `undefined` for a name the catalogue does not hold. */
  get(name: string): ErasedFinancialTool | undefined;
  has(name: string): boolean;
  /** Every entry, in registration order. What the task 10.2 harness iterates. */
  list(): readonly CatalogueEntry[];
  /** Every entry of one mode, in registration order. */
  byMode(mode: ToolMode): readonly CatalogueEntry[];
  /** Every name, in registration order. */
  names(): readonly string[];
}

/**
 * Build a catalogue, auditing every declaration eagerly.
 *
 * @throws {ToolRegistryError} for a duplicate name or any audit failure. A tool
 * that cannot be proven is a process that does not start.
 */
export function createToolRegistry(tools: readonly ErasedFinancialTool[]): ToolRegistry {
  const entries = new Map<string, CatalogueEntry>();

  for (const tool of tools) {
    const audit = auditToolDeclaration(tool);
    if (entries.has(tool.name)) {
      // A name selects a tool over the internal endpoint, so two tools under one
      // name is one tool an Agent can never reach and one it reaches by accident.
      throw new ToolRegistryError(
        `${tool.name} is registered twice; a Financial_Tool name selects exactly one tool over ` +
          `POST /internal/tools/{tool_name}`,
      );
    }
    entries.set(tool.name, { tool, audit });
  }

  const ordered: readonly CatalogueEntry[] = [...entries.values()];

  return {
    get(name: string): ErasedFinancialTool | undefined {
      return entries.get(name)?.tool;
    },
    has(name: string): boolean {
      return entries.has(name);
    },
    list(): readonly CatalogueEntry[] {
      return ordered;
    },
    byMode(mode: ToolMode): readonly CatalogueEntry[] {
      return ordered.filter((entry) => entry.tool.mode === mode);
    },
    names(): readonly string[] {
      return ordered.map((entry) => entry.tool.name);
    },
  };
}

/**
 * A typed tool as a catalogue entry.
 *
 * Identity at runtime. It exists so a call site can hand a typed
 * `FinancialTool<In, Out>` to {@link createToolRegistry} and have TypeScript check
 * the declaration — including `NoTenantId<In>`, which is what makes a `tenant_id`
 * argument uninhabitable — at the point of the hand-off rather than losing it in an
 * erased list. No cast is needed: `ErasedFinancialTool.execute` is declared with
 * method syntax, whose parameters are bivariant, and `ZodType`'s parameters are
 * covariant.
 */
export function catalogued<In, Out>(tool: FinancialTool<In, Out>): ErasedFinancialTool {
  return tool;
}
