/**
 * The contract harness's own suite (task 10.2). Requirements 12.1, 12.2, 12.3, 12.7,
 * 12.9, 12.11.
 *
 * The real catalogue is driven by `./slice-1-catalogue.test.ts` as of task 12.7. This file
 * is where the harness itself is proven, which a green run over conforming production
 * tools cannot do: a check that never fires looks exactly like a check that passes. So
 * every clause is exercised in two directions:
 *
 * 1. **Positively.** {@link runToolContract} runs over a registry of three specimen
 *    tools that between them exercise every clause: a single-figure read tool, a
 *    per-cell-chain read tool (task 10.1's reported gap 1), and a write tool with a
 *    length-bounded prose argument (`freeTextArguments`, design.md's own
 *    contradiction of Requirement 12.9). Their Evidence_Chains are **real**: composed
 *    through `createEvidenceChainBuilder` over an in-memory store and read back
 *    through `EvidenceChainBuilder.read`, so "resolvable" means the builder found it,
 *    not that the string looked like a UUID. Task 12.7 added two more specimens, for the
 *    two clauses it taught the harness: a tool with two sibling figures grounded by two
 *    chains, and a tool that withholds one figure of several.
 * 2. **Negatively.** Every check is then run against a deliberately non-conforming
 *    specimen and asserted to *produce the finding*. A harness whose only evidence of
 *    working is a green run over conforming tools has not been tested — that is why
 *    every case answers findings as a value instead of calling `expect` itself.
 *
 * Every tool here is a **specimen fixture**. None is registered in any production
 * catalogue, and none belongs to design.md's 20.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Paise } from '@/calc/paise';
import { SOURCE_RECORD_TYPES } from '@/ledger/posting-rules';
import {
  createEvidenceChainBuilder,
  type EvidenceChainHeaderRow,
  type EvidenceChainStepRow,
  type EvidenceChainStore,
  type EvidenceChainWrite,
  type EvidenceSourceRow,
  type SourceRef,
} from '@/evidence/chain-builder';
import { type CatalogueEntry, createToolRegistry, ToolRegistryError } from '@/tools/registry';
import {
  type ErasedFinancialTool,
  type EvidenceChain,
  type ProposalAuthorizationLookup,
  TOOL_TIMEOUT_MS,
  type ToolContext,
  type ToolResult,
} from '@/tools/tool';

import {
  attributeMonetaryFields,
  catalogueGaps,
  CONTRACT_ACTOR,
  CONTRACT_NOW,
  CONTRACT_TENANT,
  type ContractCheck,
  DESIGN_CATALOGUE,
  formatFindings,
  monetaryFieldPathsOf,
  nonConformingCasesFor,
  recordingConnections,
  type ResolvedChain,
  runToolContract,
  type ToolContractFixture,
  toolContractCases,
  unreachableArgumentPaths,
} from './tool-contract';

/* -------------------------------------------------------------------------- */
/* An in-memory Evidence_Chain store, so a chain is really readable back       */
/* -------------------------------------------------------------------------- */

interface MemoryStore extends EvidenceChainStore {
  readonly inserted: string[];
}

/**
 * The three evidence tables in memory, keyed the way the SQL adapter keys them.
 *
 * `test/db/evidence-chain.test.ts` proves the SQL side; what matters here is that a
 * chain a specimen tool composed can be found again by identifier, which is what
 * `resolveEvidenceChain` means in this harness.
 */
function memoryStore(): MemoryStore {
  interface Stored {
    readonly header: EvidenceChainHeaderRow;
    readonly steps: readonly EvidenceChainStepRow[];
    readonly sources: readonly EvidenceSourceRow[];
  }
  const chains = new Map<string, Stored>();
  const inserted: string[] = [];
  let counter = 0;

  return {
    inserted,
    insertChain(write: EvidenceChainWrite) {
      counter += 1;
      const chainId = `92810000-0000-4281-8281-${String(counter).padStart(12, '0')}`;
      const byRecord = new Map<string, { fields: string[]; updatedAt: string; ref: SourceRef }>();
      for (const source of write.sources) {
        const key = `${source.source_record_type}\u0000${source.source_record_id}`;
        const existing = byRecord.get(key);
        if (existing === undefined) {
          byRecord.set(key, {
            fields: [source.field],
            updatedAt: source.record_updated_at,
            ref: { type: source.source_record_type, id: source.source_record_id },
          });
        } else {
          existing.fields.push(source.field);
        }
      }
      chains.set(chainId, {
        header: {
          chain_id: chainId,
          figure_paise: write.figure_paise,
          source_count: write.source_count,
          as_of: write.as_of,
          produced_by: write.produced_by,
        },
        steps: write.steps.map((step) => ({
          step_index: step.step_index,
          operation: step.operation,
          operands: JSON.parse(step.operands_json) as unknown,
          result_paise: step.result_paise,
          note: step.note,
        })),
        sources: [...byRecord.values()].map((entry) => ({
          source_record_type: entry.ref.type,
          source_record_id: entry.ref.id,
          fields: [...entry.fields].sort(),
          record_updated_at: entry.updatedAt,
        })),
      });
      inserted.push(chainId);
      return Promise.resolve({ ok: true as const, chain_id: chainId });
    },
    findChain(_tenantId: string, chainId: string) {
      return Promise.resolve(chains.get(chainId)?.header ?? null);
    },
    listSteps(_tenantId: string, chainId: string) {
      return Promise.resolve(chains.get(chainId)?.steps ?? []);
    },
    listSourcePage(query) {
      const all = [...(chains.get(query.chain_id)?.sources ?? [])].sort((a, b) =>
        `${a.source_record_type}\u0000${a.source_record_id}` <
        `${b.source_record_type}\u0000${b.source_record_id}`
          ? -1
          : 1,
      );
      const after = query.after;
      const remaining =
        after === null
          ? all
          : all.filter(
              (row) =>
                `${row.source_record_type}\u0000${row.source_record_id}` >
                `${after.type}\u0000${after.id}`,
            );
      return Promise.resolve(remaining.slice(0, query.limit));
    },
  };
}

const STORE = memoryStore();

const resolveChain = async (id: string): Promise<ResolvedChain | null> =>
  createEvidenceChainBuilder({ store: STORE, tenantId: CONTRACT_TENANT }).read(id);

const SETTLEMENT: SourceRef = { type: 'settlement', id: 'setl_9281' };
const UPDATED_AT = '2026-07-30T08:59:00.000Z';

/** Compose and persist a real one-step chain for `figure`. */
async function realChain(
  ctx: ToolContext,
  producedBy: string,
  figure: Paise,
  ref: SourceRef = SETTLEMENT,
): Promise<EvidenceChain> {
  const built = await createEvidenceChainBuilder({ store: STORE, tenantId: ctx.tenant_id }).build({
    produced_by: producedBy,
    figure_paise: figure,
    steps: [
      {
        index: 1,
        operation: 'sum',
        operands: [{ kind: 'source', ref, field: 'amount' }],
        result_paise: figure,
      },
    ],
    sources: [{ ref, field: 'amount', record_updated_at: UPDATED_AT }],
  });
  if (!built.ok) {
    throw new Error('the specimen chain could not be composed');
  }
  return built.evidence;
}

/* -------------------------------------------------------------------------- */
/* Specimen 1: one figure, grounded by the envelope chain                      */
/* -------------------------------------------------------------------------- */

const ITC_INPUT = z.strictObject({
  from: z.iso.date(),
  to: z.iso.date(),
  linked_account_ids: z.array(z.string().regex(/^acc_[A-Za-z0-9]+$/)),
});

const ITC_OUTPUT = z.strictObject({ discrepancy_paise: z.string().regex(/^-?[0-9]+$/) });

const ITC_FIGURE = 382_000n;

const specimenItc: ErasedFinancialTool = {
  name: 'specimen_itc_discrepancy',
  mode: 'read_only',
  inputSchema: ITC_INPUT,
  outputSchema: ITC_OUTPUT,
  timeoutMs: TOOL_TIMEOUT_MS,
  async execute(ctx: ToolContext): Promise<ToolResult<unknown>> {
    return {
      ok: true,
      value: { discrepancy_paise: ITC_FIGURE.toString() },
      evidence: await realChain(ctx, 'specimen_itc_discrepancy', ITC_FIGURE),
    };
  },
};

/** The same declaration, with its one contributing Settlement unreadable. */
function specimenItcWithHiddenRecord(): ErasedFinancialTool {
  return {
    ...specimenItc,
    async execute(ctx: ToolContext): Promise<ToolResult<unknown>> {
      // Through the real builder, so `unavailable` is composed the way a tool's
      // would be: distinct identifiers, counted per type, figure absent.
      const built = await createEvidenceChainBuilder({ store: STORE, tenantId: ctx.tenant_id }).build({
        produced_by: 'specimen_itc_discrepancy',
        figure_paise: ITC_FIGURE,
        steps: [
          {
            index: 1,
            operation: 'sum',
            operands: [{ kind: 'source', ref: SETTLEMENT, field: 'amount' }],
            result_paise: ITC_FIGURE,
          },
        ],
        sources: [{ ref: SETTLEMENT, field: 'amount', record_updated_at: UPDATED_AT }],
        unreadable: [SETTLEMENT],
      });
      if (built.ok) {
        throw new Error('the hidden-record specimen composed a chain, which defeats its purpose');
      }
      return built;
    },
  };
}

const itcFixture: ToolContractFixture = {
  validInput: { from: '2026-07-01', to: '2026-07-31', linked_account_ids: ['acc_9281'] },
  hiddenContributingRecord: specimenItcWithHiddenRecord,
  resolveEvidenceChain: resolveChain,
};

/* -------------------------------------------------------------------------- */
/* Specimen 2: one chain per cell — task 10.1's reported gap 1                 */
/* -------------------------------------------------------------------------- */

const CELL = z.strictObject({
  state: z.enum(['ready', 'processing', 'failed']),
  value_paise: z.string().regex(/^-?[0-9]+$/),
  evidence_chain_id: z.uuid(),
});

const METRICS_OUTPUT = z.strictObject({ cash: CELL, runway: CELL });

const CASH_FIGURE = 5_000_000n;
const RUNWAY_FIGURE = 2_500_000n;

/**
 * Two independent figures, each with its own chain, exactly as
 * `get_control_tower_metrics` will need them.
 *
 * design.md's envelope carries **one** `evidence`, so this specimen nominates the
 * cash cell's chain for it and states the per-cell identifiers inside `Out` — the
 * workaround task 10.1 reported and left for 11.x to decide. The harness asserts both
 * cells' chains resolve, so neither shape is blessed and neither is failed.
 */
const specimenMetrics: ErasedFinancialTool = {
  name: 'specimen_control_tower_metrics',
  mode: 'read_only',
  inputSchema: z.strictObject({}),
  outputSchema: METRICS_OUTPUT,
  timeoutMs: TOOL_TIMEOUT_MS,
  async execute(ctx: ToolContext): Promise<ToolResult<unknown>> {
    const cash = await realChain(ctx, 'specimen_control_tower_metrics', CASH_FIGURE);
    const runway = await realChain(ctx, 'specimen_control_tower_metrics', RUNWAY_FIGURE, {
      type: 'forecast_component',
      id: 'fc_runway',
    });
    return {
      ok: true,
      value: {
        cash: {
          state: 'ready',
          value_paise: CASH_FIGURE.toString(),
          evidence_chain_id: cash.evidence_chain_id,
        },
        runway: {
          state: 'ready',
          value_paise: RUNWAY_FIGURE.toString(),
          evidence_chain_id: runway.evidence_chain_id,
        },
      },
      evidence: cash,
    };
  },
};

const metricsFixture: ToolContractFixture = {
  validInput: {},
  hiddenContributingRecord: (): ErasedFinancialTool => ({
    ...specimenMetrics,
    async execute(ctx: ToolContext): Promise<ToolResult<unknown>> {
      const built = await createEvidenceChainBuilder({ store: STORE, tenantId: ctx.tenant_id }).build({
        produced_by: 'specimen_control_tower_metrics',
        figure_paise: CASH_FIGURE,
        steps: [
          {
            index: 1,
            operation: 'sum',
            operands: [{ kind: 'source', ref: SETTLEMENT, field: 'amount' }],
            result_paise: CASH_FIGURE,
          },
        ],
        sources: [{ ref: SETTLEMENT, field: 'amount', record_updated_at: UPDATED_AT }],
        unreadable: [SETTLEMENT, { type: 'forecast_component', id: 'fc_runway' }],
      });
      if (built.ok) {
        throw new Error('the hidden-record specimen composed a chain, which defeats its purpose');
      }
      return built;
    },
  }),
  resolveEvidenceChain: resolveChain,
};

/* -------------------------------------------------------------------------- */
/* Specimen 3: a write tool with length-bounded prose                          */
/* -------------------------------------------------------------------------- */

const RESOLVE_INPUT = z.strictObject({
  exception_id: z.uuid(),
  resolution_note: z.string().max(2000),
});

const RESOLVE_OUTPUT = z.strictObject({
  exception_id: z.uuid(),
  lifecycle_state: z.literal('resolved'),
  resolved_at: z.iso.datetime(),
});

const PROPOSAL: SourceRef = { type: 'proposal', id: 'prop_9281' };

/**
 * A `write_capable` specimen whose output carries **no figure**.
 *
 * It still composes a chain, because `createToolInvoker` requires a resolvable
 * Evidence_Chain on *every* `ok: true` result rather than only on one carrying a
 * figure. Reported, not patched — see this file's findings block at the end.
 */
const specimenResolve: ErasedFinancialTool = {
  name: 'specimen_mark_exception_resolved',
  mode: 'write_capable',
  inputSchema: RESOLVE_INPUT,
  outputSchema: RESOLVE_OUTPUT,
  timeoutMs: TOOL_TIMEOUT_MS,
  freeTextArguments: ['resolution_note'],
  async execute(ctx: ToolContext, input: never): Promise<ToolResult<unknown>> {
    const { exception_id: exceptionId } = input as unknown as { readonly exception_id: string };
    return {
      ok: true,
      value: {
        exception_id: exceptionId,
        lifecycle_state: 'resolved',
        resolved_at: '2026-07-30T09:00:00.000Z',
      },
      evidence: await realChain(ctx, 'specimen_mark_exception_resolved', 0n, PROPOSAL),
    };
  },
};

const alwaysAuthorized: ProposalAuthorizationLookup = {
  isAuthorized: () => Promise.resolve(true),
};

const resolveFixture: ToolContractFixture = {
  validInput: {
    exception_id: '5f0b1d2e-3c4a-4b5c-8d6e-7f8091a2b3c4',
    resolution_note: 'Matched against the Settlement_Recon_Report; the residual is the GST on fee.',
  },
  session: { proposal_id: 'prop_9281', authorization_id: 'auth_9281' },
  authorization: alwaysAuthorized,
};

/* -------------------------------------------------------------------------- */
/* The harness, over the specimen catalogue                                   */
/* -------------------------------------------------------------------------- */

const SPECIMEN_REGISTRY = createToolRegistry([specimenItc, specimenMetrics, specimenResolve]);

runToolContract({
  registry: SPECIMEN_REGISTRY,
  fixtures: {
    specimen_itc_discrepancy: itcFixture,
    specimen_control_tower_metrics: metricsFixture,
    specimen_mark_exception_resolved: resolveFixture,
  },
});

/* -------------------------------------------------------------------------- */
/* Running one check against one specimen                                     */
/* -------------------------------------------------------------------------- */

function entryFor(tool: ErasedFinancialTool): CatalogueEntry {
  const entry = createToolRegistry([tool]).list()[0];
  if (entry === undefined) {
    throw new Error('the specimen registry is empty');
  }
  return entry;
}

/** Findings from one check, as one string per finding. */
async function findingsFor(
  entry: CatalogueEntry,
  fixture: ToolContractFixture,
  check: ContractCheck,
): Promise<readonly string[]> {
  const contractCase = toolContractCases(entry, fixture, { actor: CONTRACT_ACTOR, now: CONTRACT_NOW }).find(
    (candidate) => candidate.check === check,
  );
  if (contractCase === undefined) {
    throw new Error(`no ${check} case was generated`);
  }
  return formatFindings(await contractCase.run());
}

const ACK_OUTPUT = z.strictObject({ acknowledged: z.literal(true) });

/** A read specimen with no monetary field, so only the check under test speaks. */
function ackTool(overrides: Partial<ErasedFinancialTool>): ErasedFinancialTool {
  return {
    name: 'specimen_acknowledgement',
    mode: 'read_only',
    inputSchema: z.strictObject({ reference: z.string().regex(/^ref_[0-9]+$/) }),
    outputSchema: ACK_OUTPUT,
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(ctx: ToolContext): Promise<ToolResult<unknown>> {
      return {
        ok: true,
        value: { acknowledged: true },
        evidence: await realChain(ctx, 'specimen_acknowledgement', 1n),
      };
    },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Non-vacuity: every check catches its own defect                            */
/* -------------------------------------------------------------------------- */

describe('the harness catches a declaration that bypassed the registry', () => {
  it('names the bad name, the bad bound, the tenant_id argument and the undeclared prose', async () => {
    // Hand-assembled, because `createToolRegistry` would have refused it. A finding
    // here means someone built a catalogue entry without the audit.
    const bypassed: CatalogueEntry = {
      tool: {
        name: 'SQL Tool',
        mode: 'read_only',
        inputSchema: z.strictObject({ tenant_id: z.uuid() }),
        outputSchema: z.unknown(),
        timeoutMs: 30_000 as unknown as typeof TOOL_TIMEOUT_MS,
        execute: () => Promise.resolve({ ok: false, kind: 'tool_failure', tool: 'SQL Tool', cause: 'execution_error' }),
      },
      audit: {
        arguments: [
          { path: 'tenant_id', kind: 'string', bound: 'pattern' },
          { path: 'note', kind: 'string', bound: 'length' },
        ],
        freeTextMatched: [],
      },
    };

    const findings = (await findingsFor(bypassed, { validInput: {} }, 'declaration')).join(' | ');

    expect(findings).toContain('does not match');
    expect(findings).toContain('timeoutMs 30000');
    expect(findings).toContain('the registration audit refuses this declaration');
    expect(findings).toContain('the Tenant comes from the session only');
    expect(findings).toContain('not named in freeTextArguments');
    expect(findings).toContain('accepts `undefined`');
  });
});

describe('the harness catches a pattern that is not really a bound', () => {
  it('reports free-form SQL accepted by a permissive regex', async () => {
    // 10.1 stated this limit plainly: the audit proves an argument is *shaped*, not
    // that the shape is narrow. `/.*/ ` is pattern-bounded by its reckoning.
    const loose = ackTool({
      name: 'specimen_loose_pattern',
      inputSchema: z.strictObject({ reference: z.string().regex(/.*/) }),
    });

    const findings = (
      await findingsFor(entryFor(loose), { validInput: { reference: 'ref_1' } }, 'schema_violation')
    ).join(' | ');

    expect(findings).toContain('free-form SQL');
    expect(findings).toContain('was not refused as a schema_violation');
  });
});

describe('the harness catches an output schema that constrains nothing', () => {
  it('reports a z.unknown() output as undetectable drift', async () => {
    const loose = ackTool({ name: 'specimen_unchecked_output', outputSchema: z.unknown() });

    const findings = (
      await findingsFor(entryFor(loose), { validInput: { reference: 'ref_1' } }, 'output_schema')
    ).join(' | ');

    expect(findings).toContain('constrains nothing');
  });

  it('reports output the declared schema rejects as a returned figure', async () => {
    // The invoker turns drift into `tool_failure`, so a finding here would mean the
    // envelope check had been bypassed. The positive direction is the specimen suite
    // above; this asserts the case actually invokes the drifting variant.
    const drifting = ackTool({ name: 'specimen_output_drift' });
    const findings = await findingsFor(entryFor(drifting), { validInput: { reference: 'ref_1' } }, 'output_schema');
    expect(findings).toEqual([]);
  });
});

describe('the harness catches an ungrounded or mis-grounded figure', () => {
  const MONEY_OUTPUT = z.strictObject({ discrepancy_paise: z.string().regex(/^-?[0-9]+$/) });

  it('reports a monetary field returned as a JavaScript number', async () => {
    const numeric = ackTool({
      name: 'specimen_number_money',
      outputSchema: z.strictObject({ total_paise: z.number() }),
      async execute(ctx: ToolContext): Promise<ToolResult<unknown>> {
        return {
          ok: true,
          value: { total_paise: 382_000 },
          evidence: await realChain(ctx, 'specimen_number_money', ITC_FIGURE),
        };
      },
    });

    const findings = (
      await findingsFor(
        entryFor(numeric),
        { validInput: { reference: 'ref_1' }, resolveEvidenceChain: resolveChain, hiddenContributingRecord: () => numeric },
        'monetary_evidence',
      )
    ).join(' | ');

    expect(findings).toContain('is a JavaScript number');
  });

  it('reports an evidence_chain_id that resolves to nothing', async () => {
    const unresolvable = ackTool({
      name: 'specimen_unresolvable_chain',
      outputSchema: MONEY_OUTPUT,
      execute(): Promise<ToolResult<unknown>> {
        return Promise.resolve({
          ok: true,
          value: { discrepancy_paise: ITC_FIGURE.toString() },
          // Well-formed, and stored nowhere: exactly the Requirement 12.6 failure.
          evidence: {
            evidence_chain_id: '00000000-0000-4000-8000-0000000000ff',
            figure_paise: ITC_FIGURE,
            sources: [SETTLEMENT],
            source_count: 1,
            steps: [
              {
                index: 1,
                operation: 'sum',
                operands: [{ kind: 'source', ref: SETTLEMENT, field: 'amount' }],
                result_paise: ITC_FIGURE,
              },
            ],
            as_of: UPDATED_AT,
            produced_by: 'specimen_unresolvable_chain',
          },
        });
      },
    });

    const findings = (
      await findingsFor(
        entryFor(unresolvable),
        { validInput: { reference: 'ref_1' }, resolveEvidenceChain: resolveChain, hiddenContributingRecord: () => unresolvable },
        'monetary_evidence',
      )
    ).join(' | ');

    expect(findings).toContain('does not resolve to a stored Evidence_Chain');
  });

  it('reports a figure that disagrees with the chain grounding it', async () => {
    const disagreeing = ackTool({
      name: 'specimen_figure_disagrees',
      outputSchema: MONEY_OUTPUT,
      async execute(ctx: ToolContext): Promise<ToolResult<unknown>> {
        return {
          ok: true,
          value: { discrepancy_paise: '999' },
          evidence: await realChain(ctx, 'specimen_figure_disagrees', ITC_FIGURE),
        };
      },
    });

    const findings = (
      await findingsFor(
        entryFor(disagreeing),
        { validInput: { reference: 'ref_1' }, resolveEvidenceChain: resolveChain, hiddenContributingRecord: () => disagreeing },
        'monetary_evidence',
      )
    ).join(' | ');

    expect(findings).toContain('states 999 paise but its Evidence_Chain');
  });

  it('reports a fixture that supplies no resolver for a tool that returns money', async () => {
    const money = ackTool({
      name: 'specimen_money_no_resolver',
      outputSchema: MONEY_OUTPUT,
      async execute(ctx: ToolContext): Promise<ToolResult<unknown>> {
        return {
          ok: true,
          value: { discrepancy_paise: ITC_FIGURE.toString() },
          evidence: await realChain(ctx, 'specimen_money_no_resolver', ITC_FIGURE),
        };
      },
    });

    const findings = (
      await findingsFor(entryFor(money), { validInput: { reference: 'ref_1' } }, 'monetary_evidence')
    ).join(' | ');

    expect(findings).toContain('supplies no resolveEvidenceChain');
  });
});

describe('the harness reads two sibling figures grounded by two chains (task 12.3 finding 4)', () => {
  const TWO_TOTALS = z.strictObject({
    debit_total_paise: z.bigint(),
    debit_total_evidence_chain_id: z.uuid(),
    credit_total_paise: z.bigint(),
    credit_total_evidence_chain_id: z.uuid(),
  });

  const DEBIT_FIGURE = 700_000n;
  const CREDIT_FIGURE = 300_000n;

  /**
   * Two top-level figures, a chain each, named by the `<field>_evidence_chain_id`
   * convention `get_trial_balance` states.
   *
   * The two figures are deliberately **unequal** here, which a real trial balance's are
   * not: equal figures would let a swapped pair pass, so the specimen makes the pairing
   * observable.
   */
  function twoTotalsTool(options: { readonly swapped: boolean }): ErasedFinancialTool {
    return ackTool({
      name: 'specimen_two_grand_totals',
      outputSchema: TWO_TOTALS,
      async execute(ctx: ToolContext): Promise<ToolResult<unknown>> {
        const debit = await realChain(ctx, 'specimen_two_grand_totals', DEBIT_FIGURE);
        const credit = await realChain(ctx, 'specimen_two_grand_totals', CREDIT_FIGURE, {
          type: 'ledger_entry_set',
          id: '92810000-0000-4281-8281-0000000000c1',
        });
        return {
          ok: true,
          value: {
            debit_total_paise: DEBIT_FIGURE,
            credit_total_paise: CREDIT_FIGURE,
            debit_total_evidence_chain_id: options.swapped
              ? credit.evidence_chain_id
              : debit.evidence_chain_id,
            credit_total_evidence_chain_id: options.swapped
              ? debit.evidence_chain_id
              : credit.evidence_chain_id,
          },
          evidence: debit,
        };
      },
    });
  }

  it('accepts a tool whose two chains each present the figure they are named for', async () => {
    const tool = twoTotalsTool({ swapped: false });
    const findings = await findingsFor(
      entryFor(tool),
      { validInput: { reference: 'ref_1' }, resolveEvidenceChain: resolveChain },
      'monetary_evidence',
    );
    expect(findings).toEqual([]);
  });

  it('catches a tool that swapped its two chain identifiers', async () => {
    // Under the old nearest-enclosing-object rule both totals were credited to the
    // envelope, the covering object held two monetary fields, and the figure-equality
    // check was skipped — so this specimen passed. The sibling rule is what fails it.
    const findings = (
      await findingsFor(
        entryFor(twoTotalsTool({ swapped: true })),
        { validInput: { reference: 'ref_1' }, resolveEvidenceChain: resolveChain },
        'monetary_evidence',
      )
    ).join(' | ');

    expect(findings).toContain(`debit_total_paise states ${DEBIT_FIGURE}`);
    expect(findings).toContain(`credit_total_paise states ${CREDIT_FIGURE}`);
  });
});

describe('the harness checks a tool that withholds one figure of several (per_figure)', () => {
  const CELL = z.discriminatedUnion('state', [
    z.strictObject({
      state: z.literal('ready'),
      value_paise: z.bigint(),
      evidence_chain_id: z.uuid(),
    }),
    z.strictObject({
      state: z.literal('incomplete_evidence'),
      unavailable: z
        .array(z.strictObject({ type: z.enum(SOURCE_RECORD_TYPES), count: z.number().int().positive() }))
        .min(1),
    }),
  ]);
  const CELLS = z.strictObject({ cash: CELL, revenue: CELL });

  const CASH = 4_000_000n;
  const REVENUE = 1_500_000n;

  /** Two independent figures; `withhold` decides whether the first one is answered. */
  function cellsTool(options: { readonly withholdCash: boolean }): ErasedFinancialTool {
    return ackTool({
      name: 'specimen_two_cells',
      outputSchema: CELLS,
      async execute(ctx: ToolContext): Promise<ToolResult<unknown>> {
        const revenue = await realChain(ctx, 'specimen_two_cells', REVENUE);
        if (options.withholdCash) {
          return {
            ok: true,
            value: {
              cash: { state: 'incomplete_evidence', unavailable: [{ type: 'settlement', count: 1 }] },
              revenue: {
                state: 'ready',
                value_paise: REVENUE,
                evidence_chain_id: revenue.evidence_chain_id,
              },
            },
            evidence: revenue,
          };
        }
        const cash = await realChain(ctx, 'specimen_two_cells', CASH);
        return {
          ok: true,
          value: {
            cash: { state: 'ready', value_paise: CASH, evidence_chain_id: cash.evidence_chain_id },
            revenue: {
              state: 'ready',
              value_paise: REVENUE,
              evidence_chain_id: revenue.evidence_chain_id,
            },
          },
          evidence: revenue,
        };
      },
    });
  }

  const fixtureFor = (withholdCash: boolean): ToolContractFixture => ({
    validInput: { reference: 'ref_1' },
    resolveEvidenceChain: resolveChain,
    incompleteEvidenceScope: 'per_figure',
    hiddenContributingRecord: () => cellsTool({ withholdCash }),
  });

  it('accepts a tool that withholds the unreadable figure and answers the rest', async () => {
    const findings = await findingsFor(
      entryFor(cellsTool({ withholdCash: false })),
      fixtureFor(true),
      'incomplete_evidence',
    );
    expect(findings).toEqual([]);
  });

  it('reports a per-figure tool that answered every figure anyway', async () => {
    const findings = (
      await findingsFor(
        entryFor(cellsTool({ withholdCash: false })),
        fixtureFor(false),
        'incomplete_evidence',
      )
    ).join(' | ');
    expect(findings).toContain('withheld no figure');
  });
});

describe('the harness catches an unwithheld figure and a missing hidden-record fixture', () => {
  it('reports a hidden contributing record that still yielded a figure', async () => {
    const findings = (
      await findingsFor(
        entryFor(specimenItc),
        { ...itcFixture, hiddenContributingRecord: () => specimenItc },
        'incomplete_evidence',
      )
    ).join(' | ');

    expect(findings).toContain('rather than incomplete_evidence');
  });

  it('reports a money-returning tool whose fixture cannot hide a record', async () => {
    const findings = (
      await findingsFor(
        entryFor(specimenItc),
        { validInput: itcFixture.validInput, resolveEvidenceChain: resolveChain },
        'incomplete_evidence',
      )
    ).join(' | ');

    expect(findings).toContain('supplies no hiddenContributingRecord');
  });
});

describe('the harness catches a fixture whose validInput leaves an argument unexercised', () => {
  it('names the argument path no rejection case could be generated for', async () => {
    const findings = (
      await findingsFor(
        entryFor(specimenItc),
        { ...itcFixture, validInput: { from: '2026-07-01', to: '2026-07-31' } },
        'argument_coverage',
      )
    ).join(' | ');

    expect(findings).toContain('linked_account_ids[0]');
  });
});

describe('the harness catches a connection provider that answers the wrong mode', () => {
  it('reports a read_only tool handed a write_capable connection', async () => {
    const findings = (
      await findingsFor(
        entryFor(specimenItc),
        { ...itcFixture, connections: () => recordingConnections({ answerMode: 'write_capable' }) },
        'mode',
      )
    ).join(' | ');

    expect(findings).toContain('a conforming invocation on a read_only tool threw');
  });
});

describe('the harness catches a write fixture with no authorized Proposal', () => {
  it('reports the missing session pair and the missing lookup', async () => {
    const findings = (
      await findingsFor(entryFor(specimenResolve), { validInput: resolveFixture.validInput }, 'write_authorization')
    ).join(' | ');

    expect(findings).toContain('must supply session.proposal_id and session.authorization_id');
    expect(findings).toContain('must supply an authorization lookup');
  });
});

describe('the harness catches a hold variant that does not hold', () => {
  it('reports an invocation that settled before the bound elapsed', async () => {
    const findings = (
      await findingsFor(
        entryFor(specimenItc),
        {
          ...itcFixture,
          holdPastDeadline: (): ErasedFinancialTool => ({
            ...specimenItc,
            execute: () =>
              Promise.resolve({
                ok: true,
                value: { discrepancy_paise: ITC_FIGURE.toString() },
                evidence: {
                  evidence_chain_id: '00000000-0000-4000-8000-0000000000ff',
                  figure_paise: ITC_FIGURE,
                  sources: [SETTLEMENT],
                  source_count: 1,
                  steps: [
                    {
                      index: 1,
                      operation: 'sum',
                      operands: [{ kind: 'source', ref: SETTLEMENT, field: 'amount' }],
                      result_paise: ITC_FIGURE,
                    },
                  ],
                  as_of: UPDATED_AT,
                  produced_by: 'specimen_itc_discrepancy',
                },
              }),
          }),
        },
        'timeout',
      )
    ).join(' | ');

    expect(findings).toContain(`settled before ${TOOL_TIMEOUT_MS} ms had elapsed`);
  });
});

/* -------------------------------------------------------------------------- */
/* Registration-time: a malformed declaration never reaches the harness        */
/* -------------------------------------------------------------------------- */

/**
 * The half of "free-form text/SQL rejected" that is enforced at **registration**.
 *
 * `createToolRegistry` throws on the first audit failure, so these declarations are a
 * process that does not start rather than a request that fails. The harness therefore
 * does not restate the audit at invocation time; it proves the audit happens.
 */
describe('createToolRegistry refuses a declaration the contract does not admit', () => {
  const cases: readonly { readonly why: string; readonly tool: ErasedFinancialTool; readonly message: RegExp }[] = [
    {
      why: 'an unbounded string argument',
      tool: ackTool({ name: 'specimen_unbounded', inputSchema: z.strictObject({ note: z.string() }) }),
      message: /unconstrained string/,
    },
    {
      why: 'a record, whose keys the caller supplies',
      tool: ackTool({
        name: 'specimen_record',
        inputSchema: z.strictObject({ tags: z.record(z.string(), z.string()) }),
      }),
      message: /caller-supplied and therefore free-form/,
    },
    {
      why: 'a nested object that strips unknown keys instead of refusing them',
      tool: ackTool({
        name: 'specimen_loose_nested',
        inputSchema: z.strictObject({ window: z.object({ from: z.iso.date() }) }),
      }),
      message: /is not strict/,
    },
    {
      why: 'a tenant_id argument at depth',
      tool: ackTool({
        name: 'specimen_nested_tenant',
        inputSchema: z.strictObject({ scope: z.strictObject({ tenant_id: z.uuid() }) }),
      }),
      message: /the Tenant comes from the session/,
    },
    {
      why: 'an argument named order_by',
      tool: ackTool({
        name: 'specimen_order_by',
        inputSchema: z.strictObject({ order_by: z.enum(['amount', 'date']) }),
      }),
      message: /query passthrough/,
    },
    {
      why: 'prose allowed with no ceiling',
      tool: ackTool({
        name: 'specimen_unbounded_prose',
        inputSchema: z.strictObject({ note: z.string() }),
        freeTextArguments: ['note'],
      }),
      message: /carries no maximum length/,
    },
    {
      why: 'a stale free-text allowance',
      tool: ackTool({ name: 'specimen_stale_allowance', freeTextArguments: ['note'] }),
      message: /which is not a string argument/,
    },
    {
      why: 'a tool declaring its own bound',
      tool: ackTool({
        name: 'specimen_own_bound',
        timeoutMs: 30_000 as unknown as typeof TOOL_TIMEOUT_MS,
      }),
      message: /fixes the bound at 10000 ms/,
    },
    {
      why: 'a name that is not snake_case',
      tool: ackTool({ name: 'Specimen Tool' }),
      message: /is not a Financial_Tool name/,
    },
  ];

  for (const testCase of cases) {
    it(`refuses ${testCase.why}`, () => {
      expect(() => createToolRegistry([testCase.tool])).toThrow(ToolRegistryError);
      expect(() => createToolRegistry([testCase.tool])).toThrow(testCase.message);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* The empty production catalogue                                             */
/* -------------------------------------------------------------------------- */

describe('the production Financial_Tool catalogue', () => {
  it('reports every design.md tool missing from an empty registry', () => {
    // Chosen over a hard-coded "expect 20 tools" assertion because it names *which*
    // tools are absent, which is what a reader of a failing run needs. The production
    // catalogue's own gaps are asserted in `./slice-1-catalogue.test.ts`; this is the
    // mechanism, over a registry that holds nothing.
    const gaps = catalogueGaps(createToolRegistry([]));
    expect(gaps.missing).toHaveLength(DESIGN_CATALOGUE.length);
    expect(DESIGN_CATALOGUE.filter((tool) => tool.mode === 'read_only')).toHaveLength(17);
    expect(DESIGN_CATALOGUE.filter((tool) => tool.mode === 'write_capable')).toHaveLength(3);
    expect(gaps.missing).toContain('get_settlement_reconciliation');
    expect(gaps.missing).toContain('post_reconciliation_adjustment');
  });

  it('exists as one module, and is wired into runToolContract rather than sitting unused', () => {
    // **This replaced task 10.2's trip-wire.** Until task 12.7 this asserted that
    // `src/tools/{catalogue,catalog,index}.ts` did *not* exist, so that whoever added a
    // production catalogue would be forced to wire it into this harness. 12.7 added
    // `src/tools/catalogue.ts` and tripped it, so the assertion is now the stronger fact
    // the trip-wire was protecting: the catalogue exists, it is spelled one way, and a
    // suite really does drive it through `runToolContract`. Deleting either the wiring or
    // the fixtures fails here rather than silently reducing this project to specimens.
    const toolsDir = fileURLToPath(new URL('../../src/tools/', import.meta.url));
    expect(existsSync(`${toolsDir}catalogue.ts`)).toBe(true);
    // One spelling, and no barrel: a tool is imported from its own module, and a second
    // catalogue would be a second answer to "what can an Agent reach".
    for (const forbidden of ['catalog.ts', 'index.ts']) {
      expect({ forbidden, exists: existsSync(`${toolsDir}${forbidden}`) }).toEqual({
        forbidden,
        exists: false,
      });
    }

    const suite = fileURLToPath(new URL('./slice-1-catalogue.test.ts', import.meta.url));
    const fixtures = fileURLToPath(new URL('./slice-1-catalogue.ts', import.meta.url));
    expect(existsSync(suite)).toBe(true);
    expect(existsSync(fixtures)).toBe(true);
    const suiteSource = readFileSync(suite, 'utf8');
    expect(suiteSource).toContain('runToolContract({ registry: SLICE_1_REGISTRY');
    expect(readFileSync(fixtures, 'utf8')).toContain('createSliceOneToolRegistry(');
  });

  it('reports a registered tool design.md does not name, and a mode that disagrees', () => {
    const gaps = catalogueGaps(SPECIMEN_REGISTRY);
    expect(gaps.unexpected).toEqual([
      'specimen_itc_discrepancy',
      'specimen_control_tower_metrics',
      'specimen_mark_exception_resolved',
    ]);

    const misdeclared = catalogueGaps(
      createToolRegistry([ackTool({ name: 'get_trial_balance', mode: 'write_capable' })]),
    );
    expect(misdeclared.wrongMode).toEqual([
      { name: 'get_trial_balance', declared: 'write_capable', expected: 'read_only' },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* The generators and walkers the cases are built from                        */
/* -------------------------------------------------------------------------- */

describe('monetaryFieldPathsOf', () => {
  it('finds a per-cell monetary field through nested objects', () => {
    expect([...monetaryFieldPathsOf(METRICS_OUTPUT)].sort()).toEqual([
      'cash.value_paise',
      'runway.value_paise',
    ]);
  });

  it('finds monetary fields through arrays, optionals and unions', () => {
    const schema = z.strictObject({
      total_paise: z.string(),
      rows: z.array(z.strictObject({ amount_paise: z.string(), payment_id: z.string() })),
      remainder: z.optional(z.strictObject({ total_absolute_difference_paise: z.string() })),
      either: z.union([z.strictObject({ a_paise: z.string() }), z.strictObject({ b_paise: z.string() })]),
    });
    expect([...monetaryFieldPathsOf(schema)].sort()).toEqual([
      'either.a_paise',
      'either.b_paise',
      'remainder.total_absolute_difference_paise',
      'rows[].amount_paise',
      'total_paise',
    ]);
  });

  it('finds none where a tool returns no figure', () => {
    expect(monetaryFieldPathsOf(RESOLVE_OUTPUT)).toEqual([]);
  });
});

describe('attributeMonetaryFields', () => {
  it('attributes each cell to its own chain rather than to the envelope', () => {
    const cash = '92810000-0000-4281-8281-00000000000a';
    const runway = '92810000-0000-4281-8281-00000000000b';
    const attributions = attributeMonetaryFields(
      {
        cash: { value_paise: '5000000', evidence_chain_id: cash },
        runway: { value_paise: '2500000', evidence_chain_id: runway },
      },
      cash,
    );
    expect(attributions.map((a) => ({ path: a.path, chainId: a.chainId, own: a.fromOwnChain }))).toEqual([
      { path: 'cash.value_paise', chainId: cash, own: true },
      { path: 'runway.value_paise', chainId: runway, own: true },
    ]);
  });

  it('falls back to the envelope chain for a figure with no chain of its own', () => {
    const envelope = '92810000-0000-4281-8281-00000000000c';
    const attributions = attributeMonetaryFields(
      { total_shortfall_paise: '382000', rows: [{ shortfall_paise: '382000' }] },
      envelope,
    );
    expect(attributions.map((a) => a.path).sort()).toEqual(['rows[0].shortfall_paise', 'total_shortfall_paise']);
    expect(attributions.every((a) => a.chainId === envelope && !a.fromOwnChain)).toBe(true);
  });

  it('reports an uncovered figure when nothing grounds it', () => {
    const attributions = attributeMonetaryFields({ total_paise: '1' }, null);
    expect(attributions).toEqual([
      { path: 'total_paise', value: '1', chainId: null, fromOwnChain: false, siblingMonetaryFields: 1 },
    ]);
  });
});

describe('nonConformingCasesFor', () => {
  it('generates the object-level cases plus a wrong-type and a SQL case per argument', () => {
    const labels = nonConformingCasesFor(entryFor(specimenItc), itcFixture.validInput).map((c) => c.label);
    expect(labels).toContain('an unknown key');
    expect(labels).toContain('a smuggled tenant_id');
    expect(labels).toContain('a free-form sql key');
    expect(labels).toContain('an input that is not an object');
    expect(labels).toContain('from carrying a value of the wrong type');
    expect(labels).toContain('from carrying free-form SQL');
    expect(labels).toContain('linked_account_ids[0] carrying free-form SQL');
    expect(unreachableArgumentPaths(entryFor(specimenItc), itcFixture.validInput)).toEqual([]);
  });

  it('generates the over-long case rather than the SQL case for declared prose', () => {
    const labels = nonConformingCasesFor(entryFor(specimenResolve), resolveFixture.validInput).map((c) => c.label);
    // A length-bounded prose argument legitimately accepts arbitrary text — that is
    // what `freeTextArguments` makes visible — so the ceiling is what gets probed.
    expect(labels).toContain('resolution_note carrying prose past its maximum length');
    expect(labels).not.toContain('resolution_note carrying free-form SQL');
    expect(labels).toContain('exception_id carrying free-form SQL');
  });
});

/* -------------------------------------------------------------------------- */
/* Findings reported rather than patched                                      */
/* -------------------------------------------------------------------------- */

/**
 * Two things this task found and did not change, since `src/tools/**` is task 10.1's
 * and a contract's auditor does not edit the thing it audits:
 *
 * 1. **`createToolInvoker` requires an Evidence_Chain on every `ok: true` result**,
 *    including a tool whose output carries no figure. design.md's envelope rule is
 *    conditional — "every monetary figure inside `Out` is `Paise` accompanied by an
 *    `EvidenceChain`" — but `carriesResolvableChain` is unconditional, and an
 *    `EvidenceChain` needs a `figure_paise`, at least one citation and at least one
 *    step. So `mark_exception_resolved` and `initiate_payment_retry`, whose outputs
 *    are an identifier and a timestamp, must compose a chain with a figure of `0`
 *    citing the Proposal — which `specimenResolve` above does, to show what 11.x/23.x
 *    will have to do. Either the invoker relaxes the check for a tool whose
 *    `outputSchema` declares no `*_paise` field, or design.md states that every
 *    success carries a chain regardless. Not decided here.
 * 2. **design.md gap 1 is unchanged in `ToolResult`, and closed in the harness**: one
 *    `evidence` per result still cannot carry `get_control_tower_metrics`'s per-cell
 *    chains, and nine production tools resolved that inside `Out` rather than by widening
 *    the envelope. Task 12.7 taught {@link attributeMonetaryFields} the third shape that
 *    needed — a `<field>_evidence_chain_id` sibling, which `get_trial_balance` states for
 *    its two grand totals — so all three are read and none is blessed. The envelope
 *    itself is untouched; whether design.md should carry chains per figure is still open.
 */
