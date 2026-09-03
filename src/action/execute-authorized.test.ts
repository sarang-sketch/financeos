/**
 * Authorized execution (task 23.2).
 * Requirements 5.9, 5.14, 12.10.
 *
 * The world here is the **real** write path, not a stub of one: the real
 * `post_reconciliation_adjustment`, the real `createWriteCapableTool` gate around it, the
 * real `createToolInvoker` funnel in front of it and the real `createSemanticLedger`
 * behind it, over the in-memory seams `src/tools/write-tools.test-support.ts` already
 * shares with task 24.3's own tests. So "invokes a write-capable tool carrying both
 * identifiers" is asserted by the Ledger_Entry set actually landing — which it cannot do
 * unless the pair reached `ToolSession` and satisfied both gates — rather than by
 * counting calls on a fake.
 *
 * What is pinned:
 *
 * 1. **An execution rests on a resolvable Authorization** (Requirement 5.14): the
 *    Authorization is resolved before a tool is looked up, and every refusal invokes
 *    nothing and writes nothing.
 * 2. **The tool is the Proposal's, never the caller's.** It is selected by
 *    `proposals.action_type`, so the crossed-over pair `src/tools/write-tool.ts` finding 2
 *    describes is not expressible through this entry point.
 * 3. **`authorized` is the only executable state**, which is the half of Property P8
 *    (task 23.6) that says no blocked, awaiting-approval, rejected or expired Proposal
 *    reaches EXECUTE.
 * 4. **A refused write is not a completed one**: no `state = 'executed'` is written for a
 *    `tool_failure`, and an `unauthorized_write` is reported as a withholding because
 *    both gates refuse before any write seam is reachable.
 * 5. **The two statements** are asserted textually: the `authorized` guard, `state` and
 *    `executed_at` moving together, and both identifiers in the Authorization lookup's
 *    `WHERE` clause.
 */

import { describe, expect, it } from 'vitest';

import { createSemanticLedger, type LedgerAuditEvent } from '@/ledger/semantic-ledger';
import type { LedgerEntrySetDraft, SourceRef } from '@/ledger/posting-rules';
import type { ProposalState, RecordedAuthorization } from '@/policy/checks';
import { MemoryEvidenceStore } from '@/tools/exception-tools.test-support';
import {
  createPostReconciliationAdjustment,
  POST_RECONCILIATION_ADJUSTMENT,
} from '@/tools/post-reconciliation-adjustment';
import { createToolRegistry, type ToolRegistry } from '@/tools/registry';
import {
  createToolInvoker,
  type ToolConnection,
  type ToolConnections,
  type ToolDbClient,
  type ToolMode,
} from '@/tools/tool';
import {
  adjustmentSourceStore,
  ADJUSTMENT_DATE,
  approval,
  AUTHORIZATION_ID,
  authorizationLookup,
  balancedEntries,
  citedRecord,
  MemoryLedgerStore,
  PROPOSAL_ID,
  recordingWriteAudit,
  WRITE_ACTOR,
  WRITE_NOW,
  WRITE_TENANT,
  WRITE_USER,
  writeGate,
} from '@/tools/write-tools.test-support';

import { ActionServiceError } from './action-service';
import {
  adjustmentArgumentsFrom,
  createAuthorizedExecutor,
  EXECUTABLE_STATES,
  EXECUTION_AUTHORIZATION_LOOKUP_SQL,
  executeAuthorizedProposal,
  executionAuthorizationLookupParams,
  executionAuthorizationRefusal,
  executionSession,
  PROPOSAL_EXECUTED_SQL,
  proposalExecutedParams,
  type AuthorizedExecutorDeps,
  type ExecutionStore,
  type ProposalExecutionSnapshot,
} from './execute-authorized';

const SETTLEMENT: SourceRef = { type: 'settlement', id: 'setl_SYNTHETIC9281' };
const RECON: SourceRef = { type: 'settlement_recon_report', id: 'pay_SYNTHETIC92811' };

const EXECUTED_AT = WRITE_NOW().toISOString();

/** The Proposal's stated Ledger_Entry effect, and therefore its tool arguments. */
const BALANCED: LedgerEntrySetDraft = {
  source_refs: [SETTLEMENT, RECON],
  entry_date: ADJUSTMENT_DATE,
  entries: balancedEntries(),
};

/* -------------------------------------------------------------------------- */
/* The world                                                                  */
/* -------------------------------------------------------------------------- */

interface World {
  readonly deps: AuthorizedExecutorDeps;
  readonly calls: string[];
  readonly ledgerStore: MemoryLedgerStore;
  readonly rejections: readonly { readonly eventType: string }[];
  state(): ProposalState;
  executedAt(): string | null;
}

function world(
  options: {
    readonly state?: ProposalState;
    readonly actionType?: string;
    readonly toolArguments?: unknown;
    readonly authorizations?: readonly RecordedAuthorization[];
    /** The pair the *gate* knows about. Empty makes the gate refuse. */
    readonly gateKnowsPair?: boolean;
    readonly registry?: ToolRegistry;
  } = {},
): World {
  const calls: string[] = [];
  let state: ProposalState = options.state ?? 'authorized';
  let executedAt: string | null = null;

  const authorizations = options.authorizations ?? [approval(PROPOSAL_ID, AUTHORIZATION_ID)];

  const store: ExecutionStore = {
    loadForExecution(proposalId: string): Promise<ProposalExecutionSnapshot | null> {
      calls.push(`load:${proposalId}`);
      if (proposalId !== PROPOSAL_ID) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        proposal_id: PROPOSAL_ID,
        action_type: options.actionType ?? POST_RECONCILIATION_ADJUSTMENT,
        state,
        tool_arguments:
          options.toolArguments === undefined
            ? adjustmentArgumentsFrom(BALANCED)
            : options.toolArguments,
      });
    },
    findAuthorization(proposalId: string, authorizationId: string) {
      calls.push(`authorization:${proposalId}:${authorizationId}`);
      return Promise.resolve(
        authorizations.find(
          (recorded) => recorded.id === authorizationId && recorded.proposal_id === proposalId,
        ) ?? null,
      );
    },
    markExecuted(proposalId: string, at: string): Promise<void> {
      if (state !== 'authorized') {
        // The adapter contract: a transition that matched no row must throw.
        return Promise.reject(new Error(`state guard: ${state} is not authorized`));
      }
      calls.push(`executed:${proposalId}:${at}`);
      state = 'executed';
      executedAt = at;
      return Promise.resolve();
    },
  };

  /* The real tool, the real gate, the real ledger. */
  const ledgerStore = new MemoryLedgerStore();
  const ledgerAudit: LedgerAuditEvent[] = [];
  const ledger = createSemanticLedger({
    store: ledgerStore,
    audit: {
      append: (event: LedgerAuditEvent): Promise<void> => {
        ledgerAudit.push(event);
        return Promise.resolve();
      },
    },
    actor: WRITE_ACTOR,
    now: WRITE_NOW,
  });
  const chains = new MemoryEvidenceStore();
  const lookup = authorizationLookup(options.gateKnowsPair === false ? [] : undefined);
  const tool = createPostReconciliationAdjustment(
    {
      ledger: () => ledger,
      sources: () =>
        adjustmentSourceStore([
          citedRecord(SETTLEMENT.type, SETTLEMENT.id),
          citedRecord(RECON.type, RECON.id),
        ]),
      chains: () => chains,
      now: WRITE_NOW,
    },
    writeGate({ authorization: lookup }),
  );

  const connections: ToolConnections = {
    acquire(mode: ToolMode): Promise<ToolConnection> {
      calls.push(`acquire:${mode}`);
      const connection: ToolConnection = {
        db: {} as ToolDbClient,
        mode,
        release: (disposition): Promise<void> => {
          calls.push(`release:${disposition}`);
          return Promise.resolve();
        },
      };
      return Promise.resolve(connection);
    },
  };

  const audit = recordingWriteAudit();
  const invoker = createToolInvoker({
    connections,
    audit,
    actor: WRITE_ACTOR,
    authorization: lookup,
    now: WRITE_NOW,
  });

  return {
    deps: {
      store,
      registry: options.registry ?? createToolRegistry([tool]),
      invoker,
      session: {
        tenant_id: WRITE_TENANT,
        user_id: WRITE_USER,
        permissions: ['run_agents', 'approve_sensitive_actions'],
      },
      now: WRITE_NOW,
    },
    calls,
    ledgerStore,
    rejections: audit.events,
    state: () => state,
    executedAt: () => executedAt,
  };
}

const execute = (w: World, proposalId = PROPOSAL_ID, authorizationId = AUTHORIZATION_ID) =>
  executeAuthorizedProposal(proposalId, authorizationId, w.deps);

/* -------------------------------------------------------------------------- */

describe('executeAuthorizedProposal', () => {
  it('invokes the write-capable tool the Proposal names, carrying both identifiers (Requirement 5.9, 5.14, 12.10)', async () => {
    const w = world();

    const outcome = await execute(w);

    expect(outcome).toEqual({
      kind: 'executed',
      proposal_id: PROPOSAL_ID,
      authorization_id: AUTHORIZATION_ID,
      executed_at: EXECUTED_AT,
    });
    // The Ledger_Entry set landed, which is only reachable through both gates: the
    // invoker's `write_capable` check and the tool's own `AuthorizedWrite` token.
    expect(w.ledgerStore.writes).toHaveLength(1);
    expect(w.ledgerStore.writes[0]?.tenant_id).toBe(WRITE_TENANT);
    expect(w.ledgerStore.writes[0]?.total_debit_paise).toBe(2_320_000n);
    // Nothing was refused on the way.
    expect(w.rejections).toEqual([]);
    expect(w.calls).toEqual([
      `load:${PROPOSAL_ID}`,
      `authorization:${PROPOSAL_ID}:${AUTHORIZATION_ID}`,
      'acquire:write_capable',
      'release:commit',
      `executed:${PROPOSAL_ID}:${EXECUTED_AT}`,
    ]);
    expect(w.state()).toBe('executed');
    expect(w.executedAt()).toBe(EXECUTED_AT);
  });

  it('refuses without a resolvable Authorization, invoking nothing and writing nothing', async () => {
    const cases: readonly { readonly why: string; readonly authorizations: readonly RecordedAuthorization[] }[] = [
      { why: 'no such Authorization', authorizations: [] },
      {
        why: 'a rejection is not an authorization to execute (Requirement 5.10)',
        authorizations: [approval(PROPOSAL_ID, AUTHORIZATION_ID, { decision: 'rejected' })],
      },
    ];

    for (const { why, authorizations } of cases) {
      const w = world({ authorizations });

      const outcome = await execute(w);

      expect(outcome.kind, why).toBe('withheld');
      if (outcome.kind !== 'withheld') {
        throw new Error('unreachable');
      }
      expect(outcome.reason, why).toBe('authorization_unresolvable');
      // No tool was looked up, no connection acquired, no set posted, no state written.
      expect(w.calls, why).toEqual([
        `load:${PROPOSAL_ID}`,
        `authorization:${PROPOSAL_ID}:${AUTHORIZATION_ID}`,
      ]);
      expect(w.ledgerStore.writes, why).toEqual([]);
      expect(w.state(), why).toBe('authorized');
    }
  });

  it('refuses an Authorization recorded against a different Proposal', async () => {
    const other = '66666666-6666-4666-8666-666666666666';
    const w = world({ authorizations: [approval(other, AUTHORIZATION_ID)] });

    const outcome = await execute(w);

    expect(outcome.kind).toBe('withheld');
    if (outcome.kind !== 'withheld') {
      throw new Error('unreachable');
    }
    expect(outcome.reason).toBe('authorization_unresolvable');
    expect(w.ledgerStore.writes).toEqual([]);
  });

  it('executes only from authorized, so no blocked, awaiting-approval, rejected or expired Proposal reaches EXECUTE (P8)', async () => {
    const held: readonly ProposalState[] = [
      'proposed',
      'blocked',
      'awaiting_approval',
      'executed',
      'verified',
      'verification_failed',
      'execution_failed',
      'rejected',
      'expired',
    ];

    for (const state of held) {
      const w = world({ state });

      const outcome = await execute(w);

      expect(outcome.kind, state).toBe('withheld');
      if (outcome.kind !== 'withheld') {
        throw new Error('unreachable');
      }
      expect(outcome.reason, state).toBe('not_authorized_for_execution');
      expect(outcome.detail, state).toContain(state);
      expect(w.ledgerStore.writes, state).toEqual([]);
      expect(w.state(), state).toBe(state);
      expect(w.calls.some((call) => call.startsWith('acquire:')), state).toBe(false);
    }

    expect(EXECUTABLE_STATES).toEqual(['authorized']);
  });

  it('withholds for a Proposal that does not resolve for this Tenant', async () => {
    const w = world();
    const foreign = '77777777-7777-4777-8777-777777777777';

    const outcome = await execute(w, foreign);

    expect(outcome.kind).toBe('withheld');
    if (outcome.kind !== 'withheld') {
      throw new Error('unreachable');
    }
    expect(outcome.reason).toBe('proposal_absent');
    expect(w.calls).toEqual([`load:${foreign}`]);
  });

  it('withholds when the action_type names no write-capable catalogue tool', async () => {
    // `initiate_payment_retry` is design.md's third action type and is not part of task
    // 24.3, so the catalogue does not hold it.
    const w = world({ actionType: 'initiate_payment_retry' });

    const outcome = await execute(w);

    expect(outcome.kind).toBe('withheld');
    if (outcome.kind !== 'withheld') {
      throw new Error('unreachable');
    }
    expect(outcome.reason).toBe('execution_tool_absent');
    expect(outcome.detail).toContain('initiate_payment_retry');
    expect(w.ledgerStore.writes).toEqual([]);
  });

  it('reports a refused write as execution_failed and marks nothing executed (Requirement 5.17)', async () => {
    // The Proposal's stated arguments do not conform to the tool's schema, so the invoker
    // refuses at step 1 — no connection, no Tenant data read (Requirement 12.9).
    const w = world({ toolArguments: { entry_date: 'not-a-date', entries: [], source_refs: [] } });

    const outcome = await execute(w);

    expect(outcome.kind).toBe('execution_failed');
    if (outcome.kind !== 'execution_failed') {
      throw new Error('unreachable');
    }
    expect(outcome.failure).toBe('schema_violation');
    expect(outcome.tool).toBe(POST_RECONCILIATION_ADJUSTMENT);
    expect(outcome.authorization_id).toBe(AUTHORIZATION_ID);
    // Nothing posted, and the Proposal is left `authorized` for task 23.4's path — the
    // execution_failed transition is one part of Requirement 5.17's four, not this task's.
    expect(w.ledgerStore.writes).toEqual([]);
    expect(w.state()).toBe('authorized');
    expect(w.rejections.map((event) => event.eventType)).toEqual(['tool_invocation_rejected']);
  });

  it('reports the gate refusing as a withholding, because nothing was written (Requirement 12.10)', async () => {
    // The pair resolves for this module's store and not for the gate's lookup. Finding 3.
    const w = world({ gateKnowsPair: false });

    const outcome = await execute(w);

    expect(outcome.kind).toBe('withheld');
    if (outcome.kind !== 'withheld') {
      throw new Error('unreachable');
    }
    expect(outcome.reason).toBe('authorization_unresolvable');
    expect(outcome.detail).toContain('missing_authorized_proposal');
    expect(w.ledgerStore.writes).toEqual([]);
    expect(w.state()).toBe('authorized');
    expect(w.rejections.map((event) => event.eventType)).toEqual(['unauthorized_write_rejected']);
    // Refused before a connection was acquired.
    expect(w.calls.some((call) => call.startsWith('acquire:'))).toBe(false);
  });

  it('raises on an empty identifier rather than reporting it as a withholding', async () => {
    const w = world();
    await expect(execute(w, '  ')).rejects.toThrow(ActionServiceError);
    await expect(execute(w, PROPOSAL_ID, '')).rejects.toThrow(ActionServiceError);
    expect(w.calls).toEqual([]);
  });

  it('raises on a stored state that is not a proposal_state label', async () => {
    const w = world({ state: 'AUTHORIZED' as unknown as ProposalState });
    await expect(execute(w)).rejects.toThrow(ActionServiceError);
    expect(w.ledgerStore.writes).toEqual([]);
  });
});

describe('createAuthorizedExecutor', () => {
  it('is the AuthorizedExecutor seam the approval path of task 23.1 calls', async () => {
    const w = world();
    const executor = createAuthorizedExecutor(w.deps);

    const outcome = await executor.executeAuthorized(PROPOSAL_ID, AUTHORIZATION_ID);

    expect(outcome.kind).toBe('executed');
    expect(w.ledgerStore.writes).toHaveLength(1);
  });
});

describe('executionAuthorizationRefusal', () => {
  it('admits only the approval recorded against this Proposal', () => {
    expect(
      executionAuthorizationRefusal(
        PROPOSAL_ID,
        AUTHORIZATION_ID,
        approval(PROPOSAL_ID, AUTHORIZATION_ID),
      ),
    ).toBeNull();
    // A Policy_Engine approval is an Authorization too (Requirement 5.6).
    expect(
      executionAuthorizationRefusal(
        PROPOSAL_ID,
        AUTHORIZATION_ID,
        approval(PROPOSAL_ID, AUTHORIZATION_ID, {
          actor_kind: 'policy_engine',
          actor_user_id: null,
        }),
      ),
    ).toBeNull();
    expect(executionAuthorizationRefusal(PROPOSAL_ID, AUTHORIZATION_ID, null)).toContain('5.14');
    expect(
      executionAuthorizationRefusal(PROPOSAL_ID, AUTHORIZATION_ID, {
        ...approval(PROPOSAL_ID, AUTHORIZATION_ID),
        id: 'another',
      }),
    ).toContain('another');
  });
});

describe('executionSession', () => {
  it('carries both identifiers and cannot be overridden by the caller session', () => {
    const session = executionSession(
      {
        tenant_id: WRITE_TENANT,
        user_id: WRITE_USER,
        permissions: ['run_agents'],
        // A caller that smuggled a pair in anyway: the Omit stops it at compile time, and
        // the spread order stops it at run time.
        ...({ proposal_id: 'smuggled', authorization_id: 'smuggled' } as object),
      },
      PROPOSAL_ID,
      AUTHORIZATION_ID,
    );

    expect(session.proposal_id).toBe(PROPOSAL_ID);
    expect(session.authorization_id).toBe(AUTHORIZATION_ID);
    expect(session.tenant_id).toBe(WRITE_TENANT);
  });
});

describe('adjustmentArgumentsFrom', () => {
  it('projects the three arguments design.md names, bigint amounts untouched', () => {
    expect(adjustmentArgumentsFrom(BALANCED)).toEqual({
      entry_date: ADJUSTMENT_DATE,
      entries: balancedEntries(),
      source_refs: [SETTLEMENT, RECON],
    });
    expect(adjustmentArgumentsFrom(BALANCED).entries[0]?.amount_paise).toBe(2_320_000n);
  });

  it('refuses a stated absence of a ledger effect and a reversal it cannot express', () => {
    expect(() =>
      adjustmentArgumentsFrom({ kind: 'none', reason: 'this action only re-links a Credit_Note' }),
    ).toThrow(ActionServiceError);
    // Finding 2: the tool declares no reverses_set_id argument, and dropping it would post
    // an ordinary adjustment for a Proposal that promised a reversing set.
    expect(() => adjustmentArgumentsFrom({ ...BALANCED, reverses_set_id: 'set-1' })).toThrow(
      ActionServiceError,
    );
  });
});

describe('what reaches the database', () => {
  it('matches both identifiers when resolving the Authorization', () => {
    expect(EXECUTION_AUTHORIZATION_LOOKUP_SQL).toContain('WHERE tenant_id = $1');
    expect(EXECUTION_AUTHORIZATION_LOOKUP_SQL).toContain('AND proposal_id = $2::uuid');
    expect(EXECUTION_AUTHORIZATION_LOOKUP_SQL).toContain('AND id = $3::uuid');
    expect(
      executionAuthorizationLookupParams(WRITE_TENANT, PROPOSAL_ID, AUTHORIZATION_ID),
    ).toEqual([WRITE_TENANT, PROPOSAL_ID, AUTHORIZATION_ID]);
  });

  it('moves state and executed_at together, guarded on authorized', () => {
    expect(PROPOSAL_EXECUTED_SQL).toContain("SET state = 'executed'");
    expect(PROPOSAL_EXECUTED_SQL).toContain('executed_at = $3::timestamptz');
    expect(PROPOSAL_EXECUTED_SQL).toContain("AND state = 'authorized'");
    expect(PROPOSAL_EXECUTED_SQL).toContain('RETURNING id, state, executed_at');
    // The failure and verification transitions belong to tasks 23.4 and 23.3.
    expect(PROPOSAL_EXECUTED_SQL).not.toContain('execution_failed');
    expect(PROPOSAL_EXECUTED_SQL).not.toContain('verified_at');
    expect(proposalExecutedParams(WRITE_TENANT, PROPOSAL_ID, EXECUTED_AT)).toEqual([
      WRITE_TENANT,
      PROPOSAL_ID,
      EXECUTED_AT,
    ]);
  });
});
