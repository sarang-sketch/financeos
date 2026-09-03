/**
 * The Financial_Tool envelope and its enforcement, in process (task 10.1).
 *
 * The assertions here are mostly about **what did not happen**: a schema violation
 * must acquire zero connections and call zero stores, an unauthorized write must
 * acquire zero connections, and a timeout must roll back. A fake connection
 * provider can count acquisitions and record dispositions where a database cannot,
 * which is the same shape as the `incomplete_evidence` test in
 * `@/evidence/chain-builder`'s suite.
 *
 * The 10-second bound runs under fake timers. A real wait would make this suite
 * take ten seconds to prove one branch.
 *
 * Requirements: 12.1, 12.3, 12.7, 12.9, 12.10, 12.11.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { Actor } from '@/config/configuration-service';
import type { EvidenceChain } from '@/evidence/chain-builder';

import {
  createToolInvoker,
  type FinancialTool,
  TOOL_TIMEOUT_MS,
  type ToolAuditEvent,
  ToolContractError,
  type ToolConnection,
  type ToolConnections,
  type ToolContext,
  type ToolDbClient,
  type ToolMode,
  type ToolResult,
  type ToolSession,
  violationsFromIssues,
} from './tool';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CHAIN = '92810000-0000-4281-8281-000000009281';
const ACTOR: Actor = { kind: 'agent', id: 'reconciliation_agent' };
const CLOCK = (): Date => new Date('2026-07-30T09:00:00.000Z');

const SESSION: ToolSession = {
  tenant_id: TENANT,
  user_id: 'user-1',
  permissions: ['view_financial_data'],
};

/* -------------------------------------------------------------------------- */
/* A specimen tool. Test-only: the catalogue is tasks 11.x and 12.x.           */
/* -------------------------------------------------------------------------- */

const SPECIMEN_INPUT = z.strictObject({
  from: z.iso.date(),
  to: z.iso.date(),
  limit: z.number().int().min(1).max(50),
});

const SPECIMEN_OUTPUT = z.strictObject({
  total_paise: z.string().regex(/^-?[0-9]+$/),
});

type SpecimenIn = z.infer<typeof SPECIMEN_INPUT>;
type SpecimenOut = z.infer<typeof SPECIMEN_OUTPUT>;

const CHAIN_VALUE: EvidenceChain = {
  evidence_chain_id: CHAIN,
  figure_paise: 382_000n,
  sources: [{ type: 'settlement', id: 'setl_9281' }],
  source_count: 1,
  steps: [
    {
      index: 1,
      operation: 'sum',
      operands: [
        { kind: 'source', ref: { type: 'settlement', id: 'setl_9281' }, field: 'amount' },
      ],
      result_paise: 382_000n,
    },
  ],
  as_of: '2026-07-30T08:59:00.000Z',
  produced_by: 'specimen_read_tool',
};

const OK_RESULT: ToolResult<SpecimenOut> = {
  ok: true,
  value: { total_paise: '382000' },
  evidence: CHAIN_VALUE,
};

interface SpecimenOptions {
  readonly mode?: ToolMode;
  readonly name?: string;
  readonly timeoutMs?: typeof TOOL_TIMEOUT_MS;
  readonly execute?: (ctx: ToolContext, input: SpecimenIn) => Promise<ToolResult<SpecimenOut>>;
}

/** The tool under test, and the contexts it was handed. */
interface Specimen {
  readonly tool: FinancialTool<SpecimenIn, SpecimenOut>;
  readonly contexts: ToolContext[];
  readonly inputs: SpecimenIn[];
}

function specimen(options: SpecimenOptions = {}): Specimen {
  const contexts: ToolContext[] = [];
  const inputs: SpecimenIn[] = [];
  const tool: FinancialTool<SpecimenIn, SpecimenOut> = {
    name: options.name ?? 'specimen_read_tool',
    mode: options.mode ?? 'read_only',
    inputSchema: SPECIMEN_INPUT,
    outputSchema: SPECIMEN_OUTPUT,
    timeoutMs: options.timeoutMs ?? TOOL_TIMEOUT_MS,
    execute(ctx: ToolContext, input: SpecimenIn): Promise<ToolResult<SpecimenOut>> {
      contexts.push(ctx);
      inputs.push(input);
      return options.execute === undefined
        ? Promise.resolve(OK_RESULT)
        : options.execute(ctx, input);
    },
  };
  return { tool, contexts, inputs };
}

const VALID_INPUT = { from: '2026-07-01', to: '2026-07-31', limit: 50 };

/* -------------------------------------------------------------------------- */
/* Fakes that count                                                            */
/* -------------------------------------------------------------------------- */

interface FakeConnections extends ToolConnections {
  /** One entry per acquisition, in order. Zero is the assertion that matters most. */
  readonly acquired: ToolMode[];
  readonly dispositions: ('commit' | 'rollback')[];
}

function fakeConnections(options: {
  readonly failAcquire?: boolean;
  readonly failRelease?: boolean;
  readonly answerMode?: ToolMode;
} = {}): FakeConnections {
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
      const connection: ToolConnection = {
        // The tool only ever holds the client the provider handed it; nothing in
        // this suite issues a query, which is the point of counting instead.
        db: {} as unknown as ToolDbClient,
        mode: options.answerMode ?? mode,
        release(disposition: 'commit' | 'rollback'): Promise<void> {
          dispositions.push(disposition);
          return options.failRelease === true
            ? Promise.reject(new Error('rollback refused'))
            : Promise.resolve();
        },
      };
      return Promise.resolve(connection);
    },
  };
}

interface FakeAudit {
  readonly events: ToolAuditEvent[];
  append(event: ToolAuditEvent): Promise<void>;
}

function fakeAudit(options: { readonly fail?: boolean } = {}): FakeAudit {
  const events: ToolAuditEvent[] = [];
  return {
    events,
    append(event: ToolAuditEvent): Promise<void> {
      events.push(event);
      return options.fail === true
        ? Promise.reject(new Error('audit sink unavailable'))
        : Promise.resolve();
    },
  };
}

interface Harness {
  readonly connections: FakeConnections;
  readonly audit: FakeAudit;
  readonly invoke: ReturnType<typeof createToolInvoker>['invoke'];
  readonly lookups: unknown[];
}

function harness(options: {
  readonly connections?: FakeConnections;
  readonly audit?: FakeAudit;
  readonly authorized?: boolean;
  readonly withLookup?: boolean;
} = {}): Harness {
  const connections = options.connections ?? fakeConnections();
  const audit = options.audit ?? fakeAudit();
  const lookups: unknown[] = [];
  const invoker = createToolInvoker({
    connections,
    audit,
    actor: ACTOR,
    now: CLOCK,
    ...(options.withLookup === true
      ? {
          authorization: {
            isAuthorized(ref: unknown): Promise<boolean> {
              lookups.push(ref);
              return Promise.resolve(options.authorized === true);
            },
          },
        }
      : {}),
  });
  return { connections, audit, invoke: invoker.invoke, lookups };
}

afterEach(() => {
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */
/* The success path                                                            */
/* -------------------------------------------------------------------------- */

describe('a conforming invocation', () => {
  it('returns the figure with its chain, on a connection of the declared mode', async () => {
    const { tool, contexts, inputs } = specimen();
    const h = harness();

    const result = await h.invoke(tool, SESSION, VALID_INPUT);

    expect(result).toEqual(OK_RESULT);
    expect(h.connections.acquired).toEqual(['read_only']);
    expect(h.connections.dispositions).toEqual(['commit']);
    expect(h.audit.events).toEqual([]);
    expect(inputs).toEqual([VALID_INPUT]);
    // The Tenant reached the tool through the context, never through an argument.
    expect(contexts[0]?.tenant_id).toBe(TENANT);
    expect(Object.keys(inputs[0] ?? {})).not.toContain('tenant_id');
  });

  it('hands the tool the connection it was given and a live abort signal', async () => {
    const { tool, contexts } = specimen();
    const h = harness();

    await h.invoke(tool, SESSION, VALID_INPUT);

    expect(contexts[0]?.signal.aborted).toBe(false);
    expect(contexts[0]?.db).toBeDefined();
  });

  it('asks a write_capable tool for a write_capable connection', async () => {
    const { tool } = specimen({ mode: 'write_capable', name: 'specimen_write_tool' });
    const h = harness({ withLookup: true, authorized: true });

    const result = await h.invoke(tool, { ...SESSION, proposal_id: 'p-1', authorization_id: 'a-1' }, VALID_INPUT);

    expect(result.ok).toBe(true);
    expect(h.connections.acquired).toEqual(['write_capable']);
    expect(h.lookups).toEqual([
      { tenantId: TENANT, proposalId: 'p-1', authorizationId: 'a-1' },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* schema_violation (Requirement 12.9)                                         */
/* -------------------------------------------------------------------------- */

describe('schema_violation', () => {
  it('names each non-conforming argument', async () => {
    const { tool } = specimen();
    const h = harness();

    const result = await h.invoke(tool, SESSION, { from: '2026-07-01', to: 'not-a-date', limit: 0 });

    expect(result.ok).toBe(false);
    if (result.ok || result.kind !== 'schema_violation') {
      throw new Error('expected a schema_violation');
    }
    expect(result.violations.map((v) => v.argument).sort()).toEqual(['limit', 'to']);
  });

  it('rejects a smuggled tenant_id by name rather than stripping it', async () => {
    const { tool, inputs } = specimen();
    const h = harness();

    const result = await h.invoke(tool, SESSION, { ...VALID_INPUT, tenant_id: 'some-other-tenant' });

    if (result.ok || result.kind !== 'schema_violation') {
      throw new Error('expected a schema_violation');
    }
    // Named, so a caller learns its scoping attempt was refused rather than
    // believing it had scoped a request it had not.
    expect(result.violations).toEqual([
      {
        argument: 'tenant_id',
        reason: expect.stringContaining('unrecognized argument') as unknown as string,
      },
    ]);
    expect(inputs).toEqual([]);
  });

  it('rejects any unknown key, not only tenant_id', async () => {
    const { tool } = specimen();
    const h = harness();

    const result = await h.invoke(tool, SESSION, { ...VALID_INPUT, order_by: 'amount desc' });

    if (result.ok || result.kind !== 'schema_violation') {
      throw new Error('expected a schema_violation');
    }
    expect(result.violations.map((v) => v.argument)).toEqual(['order_by']);
  });

  it('opens no connection and calls no tool at all', async () => {
    const { tool, inputs, contexts } = specimen();
    const h = harness();

    await h.invoke(tool, SESSION, { nonsense: true });

    // "No Tenant data is read at all" in its strongest form: nothing was attempted.
    expect(h.connections.acquired).toEqual([]);
    expect(h.connections.dispositions).toEqual([]);
    expect(inputs).toEqual([]);
    expect(contexts).toEqual([]);
  });

  it('appends tool_invocation_rejected with argument names and no argument values', async () => {
    const { tool } = specimen();
    const h = harness();

    await h.invoke(tool, SESSION, { ...VALID_INPUT, tenant_id: 'leaked-tenant-value' });

    expect(h.audit.events).toHaveLength(1);
    const event = h.audit.events[0];
    expect(event?.eventType).toBe('tool_invocation_rejected');
    expect(event?.outcome).toBe('blocked');
    expect(event?.tenantId).toBe(TENANT);
    expect(event?.actor).toEqual(ACTOR);
    expect(event?.occurredAt).toBe('2026-07-30T09:00:00.000Z');
    expect(event?.sourceRefs).toEqual([]);
    // The rejected value never reaches the Audit_Log: a rejected argument is
    // exactly where injected text would be.
    expect(JSON.stringify(event?.payload)).not.toContain('leaked-tenant-value');
    expect(JSON.stringify(event?.payload)).toContain('tenant_id');
  });

  it('propagates an audit sink failure rather than reporting an unrecorded rejection', async () => {
    const { tool } = specimen();
    const h = harness({ audit: fakeAudit({ fail: true }) });

    await expect(h.invoke(tool, SESSION, { nonsense: true })).rejects.toThrow(
      'audit sink unavailable',
    );
  });
});

describe('violationsFromIssues', () => {
  it('renders a nested path the way a caller wrote it', () => {
    expect(
      violationsFromIssues([
        { code: 'invalid_type', path: ['entries', 0, 'amount_paise'], message: 'expected string' },
      ]),
    ).toEqual([{ argument: 'entries[0].amount_paise', reason: 'expected string' }]);
  });

  it('names every unrecognized key, since Zod reports them with an empty path', () => {
    const violations = violationsFromIssues([
      { code: 'unrecognized_keys', path: [], keys: ['tenant_id', 'sql'], message: 'Unrecognized keys' },
    ]);
    expect(violations.map((v) => v.argument)).toEqual(['tenant_id', 'sql']);
  });

  it('never returns an empty list', () => {
    expect(violationsFromIssues([])).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* unauthorized_write (Requirement 12.10)                                      */
/* -------------------------------------------------------------------------- */

describe('unauthorized_write', () => {
  const WRITE = { mode: 'write_capable' as const, name: 'specimen_write_tool' };

  it('rejects a write_capable invocation carrying neither identifier', async () => {
    const { tool, inputs } = specimen(WRITE);
    const h = harness({ withLookup: true, authorized: true });

    const result = await h.invoke(tool, SESSION, VALID_INPUT);

    expect(result).toEqual({
      ok: false,
      kind: 'unauthorized_write',
      reason: 'missing_authorized_proposal',
    });
    // Tenant state unchanged in the strongest form: no connection, no execution.
    expect(h.connections.acquired).toEqual([]);
    expect(inputs).toEqual([]);
    expect(h.lookups).toEqual([]);
  });

  it('rejects an invocation carrying only one of the pair', async () => {
    const { tool } = specimen(WRITE);
    const h = harness({ withLookup: true, authorized: true });

    const result = await h.invoke(tool, { ...SESSION, proposal_id: 'p-1' }, VALID_INPUT);

    expect(result.ok).toBe(false);
    expect(h.lookups).toEqual([]);
  });

  it('rejects when the pair does not resolve to an authorized Proposal', async () => {
    const { tool } = specimen(WRITE);
    const h = harness({ withLookup: true, authorized: false });

    const result = await h.invoke(
      tool,
      { ...SESSION, proposal_id: 'p-1', authorization_id: 'a-1' },
      VALID_INPUT,
    );

    expect(result.ok).toBe(false);
    expect(h.connections.acquired).toEqual([]);
  });

  it('fails closed when no authorization source is configured', async () => {
    const { tool } = specimen(WRITE);
    // No lookup injected: `proposals` and `authorizations` are task 21.1's.
    const h = harness();

    const result = await h.invoke(
      tool,
      { ...SESSION, proposal_id: 'p-1', authorization_id: 'a-1' },
      VALID_INPUT,
    );

    expect(result).toEqual({
      ok: false,
      kind: 'unauthorized_write',
      reason: 'missing_authorized_proposal',
    });
  });

  it('appends unauthorized_write_rejected without disclosing whether a Proposal exists', async () => {
    const { tool } = specimen(WRITE);
    const h = harness({ withLookup: true, authorized: false });

    await h.invoke(tool, { ...SESSION, proposal_id: 'p-1', authorization_id: 'a-1' }, VALID_INPUT);

    expect(h.audit.events).toHaveLength(1);
    expect(h.audit.events[0]?.eventType).toBe('unauthorized_write_rejected');
    expect(h.audit.events[0]?.outcome).toBe('blocked');
    expect(h.audit.events[0]?.payload).toMatchObject({
      tool: 'specimen_write_tool',
      reason: 'missing_authorized_proposal',
      proposal_id_supplied: true,
      authorization_id_supplied: true,
    });
  });

  it('leaves a read_only tool alone when the pair is absent', async () => {
    const { tool } = specimen();
    const h = harness();

    const result = await h.invoke(tool, SESSION, VALID_INPUT);

    expect(result.ok).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* tool_failure (Requirement 12.11)                                            */
/* -------------------------------------------------------------------------- */

describe('the 10-second bound', () => {
  it('returns tool_failure with cause timeout and rolls the connection back', async () => {
    vi.useFakeTimers();
    // A tool that never resolves: the bound, not the tool, ends the invocation.
    const { tool, contexts } = specimen({ execute: () => new Promise(() => {}) });
    const h = harness();

    const pending = h.invoke(tool, SESSION, VALID_INPUT);
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_MS);
    const result = await pending;

    expect(result).toEqual({
      ok: false,
      kind: 'tool_failure',
      tool: 'specimen_read_tool',
      cause: 'timeout',
    });
    // The rollback is what makes "Tenant state unchanged" true; the abandoned
    // promise is not.
    expect(h.connections.dispositions).toEqual(['rollback']);
    expect(contexts[0]?.signal.aborted).toBe(true);
  });

  it('does not fire before the bound', async () => {
    vi.useFakeTimers();
    let settle: (() => void) | undefined;
    const { tool } = specimen({
      execute: () =>
        new Promise<ToolResult<SpecimenOut>>((resolve) => {
          settle = (): void => {
            resolve(OK_RESULT);
          };
        }),
    });
    const h = harness();

    const pending = h.invoke(tool, SESSION, VALID_INPUT);
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_MS - 1);
    settle?.();
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(h.connections.dispositions).toEqual(['commit']);
  });

  it('appends tool_failure with the cause and the bound', async () => {
    vi.useFakeTimers();
    const { tool } = specimen({ execute: () => new Promise(() => {}) });
    const h = harness();

    const pending = h.invoke(tool, SESSION, VALID_INPUT);
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_MS);
    await pending;

    expect(h.audit.events).toHaveLength(1);
    expect(h.audit.events[0]?.eventType).toBe('tool_failure');
    expect(h.audit.events[0]?.outcome).toBe('failed');
    expect(h.audit.events[0]?.payload).toMatchObject({
      tool: 'specimen_read_tool',
      cause: 'timeout',
      timeout_ms: TOOL_TIMEOUT_MS,
    });
  });

  it('records a failed rollback on the audit payload rather than losing the result', async () => {
    vi.useFakeTimers();
    const { tool } = specimen({ execute: () => new Promise(() => {}) });
    const h = harness({ connections: fakeConnections({ failRelease: true }) });

    const pending = h.invoke(tool, SESSION, VALID_INPUT);
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_MS);
    const result = await pending;

    // The Agent must still be able to tell "timed out" from "never arrived".
    expect(result).toMatchObject({ kind: 'tool_failure', cause: 'timeout' });
    expect(h.audit.events[0]?.payload).toMatchObject({
      connection_release_failed: 'rollback refused',
    });
  });
});

describe('tool_failure from a thrown error', () => {
  it('returns cause execution_error and rolls back', async () => {
    const { tool } = specimen({
      execute: () => Promise.reject(new Error('settlement report unavailable')),
    });
    const h = harness();

    const result = await h.invoke(tool, SESSION, VALID_INPUT);

    expect(result).toEqual({
      ok: false,
      kind: 'tool_failure',
      tool: 'specimen_read_tool',
      cause: 'execution_error',
    });
    expect(h.connections.dispositions).toEqual(['rollback']);
    expect(h.audit.events[0]?.payload).toMatchObject({
      cause: 'execution_error',
      error: 'settlement report unavailable',
    });
  });

  it('reports a connection that could not be acquired as an execution error', async () => {
    const { tool, inputs } = specimen();
    const h = harness({ connections: fakeConnections({ failAcquire: true }) });

    const result = await h.invoke(tool, SESSION, VALID_INPUT);

    expect(result).toMatchObject({ kind: 'tool_failure', cause: 'execution_error' });
    expect(inputs).toEqual([]);
    expect(h.audit.events[0]?.payload).toMatchObject({ stage: 'acquire_connection' });
  });
});

/* -------------------------------------------------------------------------- */
/* The envelope: a figure never escapes without its chain                      */
/* -------------------------------------------------------------------------- */

describe('the success envelope', () => {
  it('refuses an ok result carrying no resolvable Evidence_Chain', async () => {
    const { tool } = specimen({
      execute: () =>
        Promise.resolve({
          ok: true,
          value: { total_paise: '382000' },
          // A chain identifier that resolves to nothing is the failure mode
          // Requirement 12.6 withholds a whole response for.
          evidence: { ...CHAIN_VALUE, evidence_chain_id: 'not-a-uuid' },
        }),
    });
    const h = harness();

    const result = await h.invoke(tool, SESSION, VALID_INPUT);

    expect(result).toMatchObject({ kind: 'tool_failure', cause: 'execution_error' });
    expect(h.connections.dispositions).toEqual(['rollback']);
    expect(h.audit.events[0]?.payload).toMatchObject({
      reason: 'ok_result_without_resolvable_evidence_chain',
    });
  });

  it('refuses output that does not satisfy the declared output schema', async () => {
    const { tool } = specimen({
      execute: () =>
        Promise.resolve({
          ok: true,
          // A float where the wire contract wants a decimal integer string.
          value: { total_paise: '3820.00' } as unknown as SpecimenOut,
          evidence: CHAIN_VALUE,
        }),
    });
    const h = harness();

    const result = await h.invoke(tool, SESSION, VALID_INPUT);

    expect(result).toMatchObject({ kind: 'tool_failure', cause: 'execution_error' });
    expect(h.audit.events[0]?.payload).toMatchObject({ reason: 'output_schema_violation' });
  });

  it('passes incomplete_evidence through, rolls back, and records the type counts', async () => {
    const { tool } = specimen({
      execute: () =>
        Promise.resolve({
          ok: false,
          kind: 'incomplete_evidence',
          unavailable: [{ type: 'settlement', count: 2 }],
        }),
    });
    const h = harness();

    const result = await h.invoke(tool, SESSION, VALID_INPUT);

    expect(result).toEqual({
      ok: false,
      kind: 'incomplete_evidence',
      unavailable: [{ type: 'settlement', count: 2 }],
    });
    // Requirement 12.3: no figure at all, not a zero and not a null.
    expect(Object.keys(result)).not.toContain('value');
    expect(h.connections.dispositions).toEqual(['rollback']);
    expect(h.audit.events[0]?.eventType).toBe('incomplete_evidence');
    expect(h.audit.events[0]?.payload).toMatchObject({
      unavailable: [{ type: 'settlement', count: 2 }],
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Contract faults, which are exceptions rather than results                    */
/* -------------------------------------------------------------------------- */

describe('ToolContractError', () => {
  it('refuses a session with no Tenant identifier', async () => {
    const { tool } = specimen();
    const h = harness();

    await expect(h.invoke(tool, { ...SESSION, tenant_id: '' }, VALID_INPUT)).rejects.toThrow(
      ToolContractError,
    );
    expect(h.connections.acquired).toEqual([]);
  });

  it('refuses a tool declaring its own bound', async () => {
    const { tool } = specimen({ timeoutMs: 30_000 as unknown as typeof TOOL_TIMEOUT_MS });
    const h = harness();

    await expect(h.invoke(tool, SESSION, VALID_INPUT)).rejects.toThrow(ToolContractError);
  });

  it('refuses a provider that answered with the wrong mode', async () => {
    // The mode declaration is only worth the connection behind it.
    const { tool } = specimen();
    const h = harness({ connections: fakeConnections({ answerMode: 'write_capable' }) });

    await expect(h.invoke(tool, SESSION, VALID_INPUT)).rejects.toThrow(ToolContractError);
    expect(h.connections.dispositions).toEqual(['rollback']);
  });
});
