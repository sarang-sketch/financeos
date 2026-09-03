/**
 * The catalogue and the registration-time schema audit (task 10.1).
 *
 * The audit is a pure function over a Zod schema, so almost everything here is a
 * declaration and an expected rejection. The point of the suite is that
 * Requirement 12.9's "no free-form text or SQL argument" is *checked* rather than
 * documented: each rejected declaration below would compile and run happily
 * without the audit, and would give a Model a text channel into the data layer.
 *
 * Requirements: 12.1, 12.7, 12.9, 12.11.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  auditInputSchema,
  catalogued,
  createToolRegistry,
  REFUSED_ARGUMENT_NAMES,
  TOOL_NAME_RE,
  ToolRegistryError,
} from './registry';
import {
  type EvidenceChain,
  type ErasedFinancialTool,
  type FinancialTool,
  TOOL_TIMEOUT_MS,
  type ToolContext,
  type ToolMode,
  type ToolResult,
} from './tool';

const CHAIN: EvidenceChain = {
  evidence_chain_id: '92810000-0000-4281-8281-000000009281',
  figure_paise: 1n,
  sources: [{ type: 'settlement', id: 'setl_1' }],
  source_count: 1,
  steps: [
    {
      index: 1,
      operation: 'select',
      operands: [{ kind: 'source', ref: { type: 'settlement', id: 'setl_1' }, field: 'amount' }],
      result_paise: 1n,
    },
  ],
  as_of: '2026-07-30T08:00:00.000Z',
  produced_by: 'specimen_tool',
};

/* -------------------------------------------------------------------------- */
/* A test-only specimen. The catalogue itself is tasks 11.x and 12.x.          */
/* -------------------------------------------------------------------------- */

const OUTPUT = z.strictObject({ total_paise: z.string().regex(/^-?[0-9]+$/) });

function tool(options: {
  readonly name?: string;
  readonly mode?: ToolMode;
  readonly inputSchema: z.ZodType;
  readonly freeTextArguments?: readonly string[];
  readonly timeoutMs?: typeof TOOL_TIMEOUT_MS;
}): ErasedFinancialTool {
  return {
    name: options.name ?? 'specimen_tool',
    mode: options.mode ?? 'read_only',
    inputSchema: options.inputSchema,
    outputSchema: OUTPUT,
    timeoutMs: options.timeoutMs ?? TOOL_TIMEOUT_MS,
    ...(options.freeTextArguments === undefined
      ? {}
      : { freeTextArguments: options.freeTextArguments }),
    execute(): Promise<ToolResult<unknown>> {
      return Promise.resolve({ ok: true, value: { total_paise: '1' }, evidence: CHAIN });
    },
  };
}

/** Shapes drawn from design.md's real catalogue: dates, bounded ints, enums, ids. */
const CATALOGUE_SHAPED_INPUT = z.strictObject({
  from: z.iso.date(),
  to: z.iso.date(),
  limit: z.number().int().min(1).max(50),
  settlement_ids: z.array(z.string().regex(/^setl_[A-Za-z0-9]{6,32}$/)).optional(),
  state: z.enum(['open', 'resolved', 'dismissed']),
  page: z.strictObject({ index: z.number().int().min(1), size: z.number().int().max(100) }),
  entries: z.array(
    z.strictObject({
      account_code: z.string().regex(/^[0-9]{4}$/),
      side: z.enum(['debit', 'credit']),
      amount_paise: z.string().regex(/^-?[0-9]+$/),
    }),
  ),
});

/* -------------------------------------------------------------------------- */
/* Accepted declarations                                                       */
/* -------------------------------------------------------------------------- */

describe('auditInputSchema: what it accepts', () => {
  it('accepts the argument shapes design.md\u2019s catalogue actually uses', () => {
    const audit = auditInputSchema('specimen_tool', CATALOGUE_SHAPED_INPUT);
    const byPath = new Map(audit.arguments.map((a) => [a.path, a.bound]));

    expect(byPath.get('from')).toBe('pattern');
    expect(byPath.get('limit')).toBe('non_text');
    expect(byPath.get('settlement_ids[]')).toBe('pattern');
    expect(byPath.get('state')).toBe('closed');
    expect(byPath.get('page.size')).toBe('non_text');
    expect(byPath.get('entries[].side')).toBe('closed');
    expect(byPath.get('entries[].amount_paise')).toBe('pattern');
  });

  it('accepts an empty argument set, which get_control_tower_metrics needs', () => {
    expect(auditInputSchema('specimen_tool', z.strictObject({})).arguments).toEqual([]);
  });

  it('walks through optional, nullable, default and transform wrappers', () => {
    const audit = auditInputSchema(
      'specimen_tool',
      z.strictObject({
        a: z.iso.date().optional(),
        b: z.uuid().nullable(),
        c: z.number().int().default(30),
        d: z
          .string()
          .regex(/^[a-z]+$/)
          .transform((s) => s.toUpperCase()),
      }),
    );
    expect(audit.arguments.map((a) => a.path)).toEqual(['a', 'b', 'c', 'd']);
  });
});

/* -------------------------------------------------------------------------- */
/* The free-form prohibition (Requirement 12.9)                                */
/* -------------------------------------------------------------------------- */

describe('auditInputSchema: free-form arguments', () => {
  it('rejects an unconstrained string argument', () => {
    expect(() =>
      auditInputSchema('specimen_tool', z.strictObject({ note: z.string() })),
    ).toThrow(/argument note is an unconstrained string/);
  });

  it('rejects an unconstrained string nested inside an array of objects', () => {
    expect(() =>
      auditInputSchema(
        'specimen_tool',
        z.strictObject({ entries: z.array(z.strictObject({ memo: z.string() })) }),
      ),
    ).toThrow(/argument entries\[\]\.memo is an unconstrained string/);
  });

  it('rejects a length-bounded string that was not declared as prose', () => {
    // A ceiling alone is not a bound on *content*, so it needs the explicit,
    // visible allowance rather than passing quietly.
    expect(() =>
      auditInputSchema('specimen_tool', z.strictObject({ note: z.string().max(500) })),
    ).toThrow(/unconstrained string/);
  });

  it('accepts a declared prose argument that carries a maximum length', () => {
    const audit = auditInputSchema(
      'mark_exception_resolved',
      z.strictObject({ exception_id: z.uuid(), resolution_note: z.string().max(2000) }),
      ['resolution_note'],
    );
    expect(audit.freeTextMatched).toEqual(['resolution_note']);
  });

  it('refuses a declared prose argument with no ceiling', () => {
    expect(() =>
      auditInputSchema(
        'mark_exception_resolved',
        z.strictObject({ resolution_note: z.string() }),
        ['resolution_note'],
      ),
    ).toThrow(/carries no maximum length/);
  });

  it('refuses a stale allowance that matches no argument', () => {
    expect(() =>
      auditInputSchema('specimen_tool', z.strictObject({ from: z.iso.date() }), ['resolution_note']),
    ).toThrow(/freeTextArguments names resolution_note/);
  });

  it.each(REFUSED_ARGUMENT_NAMES)('refuses an argument named %s whatever its type', (name) => {
    expect(() =>
      auditInputSchema('specimen_tool', z.strictObject({ [name]: z.enum(['a', 'b']) })),
    ).toThrow(new RegExp(`declares an argument ${name}`));
  });

  it('refuses any and unknown, which are text channels by construction', () => {
    expect(() => auditInputSchema('specimen_tool', z.strictObject({ a: z.any() }))).toThrow(
      /is a any schema/,
    );
    expect(() => auditInputSchema('specimen_tool', z.strictObject({ a: z.unknown() }))).toThrow(
      /is a unknown schema/,
    );
  });

  it('refuses a record, whose keys the caller supplies', () => {
    expect(() =>
      auditInputSchema('specimen_tool', z.strictObject({ by: z.record(z.string(), z.number()) })),
    ).toThrow(/whose keys are caller-supplied/);
  });
});

/* -------------------------------------------------------------------------- */
/* Strictness and the Tenant (Requirement 12.7, 12.9)                          */
/* -------------------------------------------------------------------------- */

describe('auditInputSchema: strictness and tenant_id', () => {
  it('refuses a root object that strips unknown keys', () => {
    expect(() => auditInputSchema('specimen_tool', z.object({ from: z.iso.date() }))).toThrow(
      /\(root\) is not strict/,
    );
  });

  it('refuses a nested object that strips unknown keys', () => {
    // The nested case is the dangerous one: a caller whose smuggled key was
    // stripped believes it was accepted.
    expect(() =>
      auditInputSchema(
        'specimen_tool',
        z.strictObject({ page: z.object({ size: z.number().int() }) }),
      ),
    ).toThrow(/the object at page is not strict/);
  });

  it('refuses a schema declaring tenant_id at the top level', () => {
    expect(() =>
      auditInputSchema('specimen_tool', z.strictObject({ tenant_id: z.uuid() })),
    ).toThrow(/the Tenant comes from the session/);
  });

  it('refuses a schema declaring tenant_id at any depth', () => {
    expect(() =>
      auditInputSchema(
        'specimen_tool',
        z.strictObject({ scope: z.strictObject({ tenant_id: z.uuid() }) }),
      ),
    ).toThrow(/scope\.tenant_id/);
  });

  it('refuses a non-object root, which has no argument names to audit', () => {
    expect(() => auditInputSchema('specimen_tool', z.array(z.uuid()))).toThrow(
      /must be a strict object schema/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The registry                                                                */
/* -------------------------------------------------------------------------- */

describe('createToolRegistry', () => {
  const read = tool({ name: 'get_specimen_report', inputSchema: CATALOGUE_SHAPED_INPUT });
  const write = tool({
    name: 'post_specimen_adjustment',
    mode: 'write_capable',
    inputSchema: z.strictObject({ entry_date: z.iso.date() }),
  });

  it('holds every tool with everything the task 10.2 harness needs', () => {
    const registry = createToolRegistry([read, write]);

    expect(registry.names()).toEqual(['get_specimen_report', 'post_specimen_adjustment']);
    expect(registry.has('get_specimen_report')).toBe(true);
    expect(registry.get('post_specimen_adjustment')?.mode).toBe('write_capable');
    expect(registry.get('nonexistent_tool')).toBeUndefined();

    for (const entry of registry.list()) {
      // Exactly the four declarations the task requires, plus the audit result.
      expect(entry.tool.name).toMatch(TOOL_NAME_RE);
      expect(['read_only', 'write_capable']).toContain(entry.tool.mode);
      expect(entry.tool.inputSchema).toBeDefined();
      expect(entry.tool.outputSchema).toBeDefined();
      expect(entry.tool.timeoutMs).toBe(TOOL_TIMEOUT_MS);
      expect(entry.audit.arguments).toBeInstanceOf(Array);
    }
  });

  it('partitions by mode, in registration order', () => {
    const registry = createToolRegistry([read, write]);
    expect(registry.byMode('read_only').map((e) => e.tool.name)).toEqual(['get_specimen_report']);
    expect(registry.byMode('write_capable').map((e) => e.tool.name)).toEqual([
      'post_specimen_adjustment',
    ]);
  });

  it('refuses a duplicate name, since a name selects exactly one tool', () => {
    expect(() => createToolRegistry([read, read])).toThrow(ToolRegistryError);
  });

  it('refuses a name that is not snake_case', () => {
    expect(() =>
      createToolRegistry([tool({ name: 'Get Settlement', inputSchema: z.strictObject({}) })]),
    ).toThrow(/is not a Financial_Tool name/);
  });

  it('refuses a tool declaring its own timeout', () => {
    expect(() =>
      createToolRegistry([
        tool({
          inputSchema: z.strictObject({}),
          timeoutMs: 30_000 as unknown as typeof TOOL_TIMEOUT_MS,
        }),
      ]),
    ).toThrow(/fixes the bound at 10000 ms/);
  });

  it('audits eagerly, so a smuggle-able argument is a startup failure', () => {
    // Not a request that fails later, when an Agent has already found it.
    expect(() =>
      createToolRegistry([tool({ inputSchema: z.strictObject({ sql: z.string() }) })]),
    ).toThrow(ToolRegistryError);
  });
});

/* -------------------------------------------------------------------------- */
/* The type-level half of "tenant_id is never an argument"                     */
/* -------------------------------------------------------------------------- */

describe('the tenant_id constraint at the type level', () => {
  /** An input type that declares the one key a tool may not take. */
  interface TenantCarrying {
    readonly tenant_id: string;
    readonly from: string;
  }

  type Out = { readonly total_paise: string };

  const TENANT_CARRYING_SCHEMA = z.strictObject({ tenant_id: z.uuid(), from: z.iso.date() });

  it('does not compile for an input type declaring tenant_id', () => {
    // `NoTenantId<TenantCarrying>` is `TenantIdIsNotAnArgument`, which this schema
    // and this handler cannot satisfy, so the declaration itself is the error.
    // `tsc --noEmit` failing is the assertion; loosening `NoTenantId` breaks it.
    const bad: FinancialTool<TenantCarrying, Out> = {
      name: 'bad_tool',
      mode: 'read_only',
      // @ts-expect-error tenant_id is not representable as a tool argument
      inputSchema: TENANT_CARRYING_SCHEMA,
      outputSchema: OUTPUT,
      timeoutMs: TOOL_TIMEOUT_MS,
      // @ts-expect-error tenant_id is not representable as a tool argument
      execute(_ctx: ToolContext, _input: TenantCarrying): Promise<ToolResult<Out>> {
        return Promise.resolve({ ok: true, value: { total_paise: '1' }, evidence: CHAIN });
      },
    };
    expect(bad.name).toBe('bad_tool');

    // And the runtime half, for a caller whose `In` was inferred loosely.
    expect(() => auditInputSchema('bad_tool', TENANT_CARRYING_SCHEMA)).toThrow(ToolRegistryError);
  });

  it('compiles, and catalogues, an input type that takes no Tenant', () => {
    const good: FinancialTool<{ readonly from: string }, Out> = {
      name: 'good_tool',
      mode: 'read_only',
      inputSchema: z.strictObject({ from: z.iso.date() }),
      outputSchema: OUTPUT,
      timeoutMs: TOOL_TIMEOUT_MS,
      execute(): Promise<ToolResult<Out>> {
        return Promise.resolve({ ok: true, value: { total_paise: '1' }, evidence: CHAIN });
      },
    };
    // The other half of the assertion: a legitimate input must not be caught by the
    // guardrail. A `{ tenant_id?: never }` constraint would have rejected this one.
    expect(createToolRegistry([catalogued(good)]).names()).toEqual(['good_tool']);
  });
});
