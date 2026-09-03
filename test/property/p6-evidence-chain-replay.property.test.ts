// Feature: financeos-control-tower, Property 6: Evidence chain replay — for all monetary
// figures presented with an Evidence_Chain, replaying the ordered computation steps over the
// referenced Source_Records reproduces the presented figure exactly in integer paise with zero
// difference; the chain's `source_count` equals the number of identifiers across its retrieved
// pages; and concatenating those 500-per-page pages yields each identifier exactly once.
//
// **Validates: Requirements 10.1, 12.2, 12.8**
//
// THE HONEST STATE OF THIS PROPERTY, FIRST
// ----------------------------------------
// design.md's P6 generator input is `arbitraryTenantDataset`, "then every read-only tool in the
// catalogue invoked over it". **The catalogue is empty.** The 17 read-only tools are tasks 12.1
// through 12.6, and `src/tools/registry.ts` (task 10.1) registers no production tool — nothing
// even calls `createToolRegistry` outside its own test. So the generator design.md specifies
// cannot be written today, and a P6 that iterated the catalogue alone would pass over zero
// inputs.
//
// This file is therefore in two halves, and says which is which:
//
//   1. **Chains generated directly** (`arbitraryEvidenceChainCase`), composed through 9.1's
//      funnel, persisted, read back and replayed. Real, non-vacuous, and provable now: it is a
//      property of the `EvidenceStep` schema, of the chain builder's keyset walk, and of the
//      agreement between the production Calculation_Service and 9.2's independent interpreter.
//   2. **Every `read_only` tool in the catalogue**, discovered rather than listed
//      (`test/property/tool-catalogue.ts`), which covers zero tools today and covers each of
//      tasks 12.x's automatically. It is proven to actually run, against a specimen tool in
//      `test/property/fixtures/`, so it is exercised code rather than code that has never
//      executed.
//
// **What task 17 needs to know.** Task 17 is the Slice 1 property gate and re-runs P6 among the
// nine non-waivable properties. Half 2's strength at that moment is exactly the strength of the
// catalogue: if tasks 12.x have landed, every read-only tool is covered; if 17 is reached with
// tools that somehow bypassed discovery, `missingProbes` is what fails. Half 1 holds regardless.
// A green P6 does **not** by itself mean "every tool's figures replay" until the catalogue is
// populated — read the two `describe` blocks below to see which claim was actually made.
//
// WHAT 9.1'S AND 9.2'S TESTS ALREADY PROVE, AND WHAT P6 ADDS
// ---------------------------------------------------------
// The audit, done before a line of this file was written, so nothing here restates an example
// test as a property:
//
// | Fact | Already proven, where | What P6 adds |
// |---|---|---|
// | The twelve-step SET-9281 chain replays to `0n` and its Difference to `2320000n` | `test/evidence/replay-interpreter.test.ts` (9.2), on the in-memory fixture | Nothing. Not restated. The figure-level assertion over the *persisted* chain is **task 11.3's**, and this file does not write it |
// | The 9 operation labels, their arities, the rounding rule, and all 16 rejections | `test/evidence/replay-interpreter.test.ts` (9.2), one example each | Every generated chain draws from those operations in combination — folds over 1000 operands, `divide` chained into `subtract`, a `compare` mid-chain — rather than one step at a time |
// | Pagination at 499 / 500 / 501 / 1000 / 1001, each identifier once, ascending | `src/evidence/chain-builder.test.ts` (9.1) with a **hand-written** `source_count` on a **hand-written** row set | The rows are no longer hand-written: `source_count` is the funnel's derived distinct-identifier count, the page rows are the citations the chain actually made, and the two are compared to each other. A drift between "what the chain cited" and "what the header counted" is invisible to 9.1's shape and is what P6 catches |
// | The SQL `ORDER BY` under the `C` collation, and the `after` keyset, at those sizes | `test/db/evidence-chain.test.ts` (9.1), real Postgres | Nothing. Deliberately not restated — see the store note below |
// | A step's stated `result_paise` equals what an independent interpreter recomputes | Nowhere, for anything but the two SET-9281 fixtures | **This.** For every generated chain, over arbitrary field values including the paise boundaries, with the producer's arithmetic coming from `@/calc/calculation-service` and the replay's from a module that imports none of it |
//
// FAKE STORE, NOT SUPABASE LOCAL
// ------------------------------
// design.md is explicit that "P3, P4, **P6**, P11 and P12 run in-process against the pure
// functions", and the reasoning holds on inspection: the replay clause is arithmetic over
// `evidence_chain_steps` rows, and the pagination clause is a property of the keyset walk in
// `createEvidenceChainBuilder`, which is TypeScript. The SQL half — the `C`-collation `ORDER BY`
// and the exclusive `after` comparison — is already proven against real Postgres by
// `test/db/evidence-chain.test.ts` at 499, 500, 501, 1000 and 1001 identifiers, so restating it
// here would buy a slower copy of a covered fact. And the cost is real: a `wide` iteration
// writes up to 1000 citation rows, and `npm run test:property` already spends ~490 s.
// `test/property/evidence-chain-memory-store.ts` is faithful about the two things that matter —
// grouping by identifier, and the composite-key order — and says where a non-ASCII identifier
// could make its string comparison diverge from the `C` collation.
//
// The chain still makes the full round trip: `evidenceChainWriteFor` maps it to rows, `operands`
// goes through `JSON.stringify` / `JSON.parse`, money crosses as integer text, and the steps come
// back **unordered** from the store, so what P6 replays is the persisted shape rather than the
// object the generator built.
//
// GENERATOR BUG VERSUS PROPERTY FAILURE
// ------------------------------------
// A chain the interpreter *refuses* is a generator bug wearing a property failure's clothes, so
// the two are separated at the point of failure. Every generated chain is inside the
// intersection of both contracts by construction (see the generator module's doc comment:
// gapless indexes, backward-only references, 9.2's stricter arities, `compare` never terminal and
// never an operand, denominators away from zero, results bounded well inside the paise range with
// a documented degradation to `select` rather than a filter). If one is refused anyway,
// {@link replayOrExplain} reads `ReplayFailureKind` and labels the failure:
//
//   - the 14 **structural** kinds (`arity`, `forward_step_reference`, `missing_record`,
//     `unresolvable_field`, `non_monetary_terminal_step`, …) → `GENERATOR FAULT`, meaning this
//     file's generator emitted a chain no producer would ever emit, and the counterexample is a
//     bug in the generator;
//   - the 2 **value** kinds (`result_disagreement`, `out_of_range`) → `P6 FAILURE`, meaning the
//     producer's arithmetic and the replay's disagree, or a figure left the paise range. That is
//     the property being false.
//
// Both fail the test — nothing is swallowed — but the message says which side to look at. A
// third guard sits earlier: `composeEvidenceChain` throwing inside the property body is labelled
// a generator fault too, since the funnel rejects only malformed chains.
//
// `verifyStatedResults`: BOTH, AND THEY ARE DIFFERENT CLAIMS
// ---------------------------------------------------------
// Every chain is replayed twice.
//
//   - **On** (the default) checks every intermediate `result_paise` against the recomputed
//     value, so a chain whose figure happens to be right while step 4 is wrong fails. That is
//     the stronger clause, and it is the one that catches a rounding divergence in the middle of
//     a chain.
//   - **Off** ignores every stated result and recomputes from the operands alone, which is the
//     only way to know the interpreter is not echoing the chain back. With verification on, an
//     interpreter that simply returned the terminal `result_paise` would pass every iteration.
//
// Asserting both costs one extra pass over a handful of steps and closes both holes, so P6 does
// not have to choose which one to leave open.
//
// ITERATIONS, SEED, COST, AND THE OBSERVED DISTRIBUTION
// -----------------------------------------------------
// `numRuns: 100`, design.md's stated minimum, deliberately not inflated: 1000 is reserved for
// P1, P3, P11 and P12. Measured: **0.55 s of test time for the whole file**, which is what an
// in-process property with no database costs; the `property` project's 300 s file cap is not
// approached, and `npm run test:property` went from ~490 s to 494 s with this file in it.
//
// At the committed seed the breadth split is **73 narrow / 27 wide**, the widest chain holds
// **1000 identifiers**, and **127 pages** are walked for 100 chains — so more than 500 sources
// is not a theoretical branch, it happens in a quarter of the iterations, and the assertions
// after `fc.assert` fail if that ever stops being true.
//
// The seed is explicit and committed, so any counterexample is reproducible from this file alone.
//
// NOT VACUOUS
// -----------
// Falsified deliberately, three ways, before being committed. All three were reverted; no
// regression test is committed for any of them, because the counterexamples came from
// deliberately broken test code rather than from a defect in the system.
//
//   1. **A stated intermediate that lies by one paisa** (`result_paise + 1n` on the first step
//      of the read-back chain). Fails after 1 test, shrinks 10 times to the smallest chain there
//      is — one Payment, `amount: 0n`, one `sum` step — with
//      `P6 FAILURE ... result_disagreement at step 1 ...: states result_paise 1 but recomputes to
//      0, a difference of -1`. So clause 1 is load bearing at the intermediate level, not only at
//      the figure.
//   2. **Dropping the last identifier of the final page** in the store's `listSourcePage`. Fails
//      with `expected [] to have a length of 1 but got +0` on the one-identifier chain, and
//      `expected [ …(500) ] to have a length of 501 but got 500` at the page boundary. So clauses
//      2 and 3 are reading the pages rather than restating the header.
//   3. **Truncating instead of rounding half away from zero** in the producer (replacing
//      `roundHalfUpToPaisa` with `input / literal`). Fails after 13 tests, shrinks 31 times, with
//      `result_disagreement at step 3 ...: states result_paise 866 but recomputes to 867`. So the
//      rounding rule is genuinely cross-checked between the Calculation_Service and the
//      interpreter, which is the one clause a shared implementation would have made vacuous.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  composeEvidenceChain,
  createEvidenceChainBuilder,
  type EvidenceChainInput,
  type EvidenceChainView,
  type EvidenceSourcePage,
  MAX_SOURCE_PAGE_SIZE,
  type SourceRef,
} from '@/evidence/chain-builder';
import {
  recordLookupFromRecords,
  replaySteps,
  type ReplayFailureKind,
  type ReplaySourceRecord,
  type SourceRecordLookup,
} from '../evidence/replay-interpreter';
import {
  arbitraryEvidenceChainCase,
  arbitraryEvidenceTenantDataset,
  buildChain,
  evidenceTenantDatasetOfSize,
  type EvidenceTenantDataset,
  WIDE_SOURCE_COUNTS,
} from './evidence-chain-generators';
import { createMemoryEvidenceStore } from './evidence-chain-memory-store';
import {
  discoverCatalogue,
  missingProbes,
  type P6ToolProbe,
  PRODUCTION_ROOTS,
  SPECIMEN_ROOT,
  strandedProbes,
} from './tool-catalogue';

/** design.md's stated minimum. P6 is not one of the four properties raised to 1000. */
const NUM_RUNS = 100;

/** Explicit and committed, so any counterexample is reproducible from this file alone. */
const SEED = 20260306;

const PARAMS = { numRuns: NUM_RUNS, seed: SEED } as const;

/** The session Tenant. Bound once at construction; never a method argument. */
const TENANT = '33333333-3333-4333-8333-333333333333';

/* -------------------------------------------------------------------------- */
/* Replay, with the two failure classes kept apart                            */
/* -------------------------------------------------------------------------- */

/**
 * The refusals that mean **this file's generator** produced a chain no producer
 * would: every structural kind. A counterexample carrying one of these is a bug
 * in `evidence-chain-generators.ts`, not a false property.
 */
const GENERATOR_FAULT_KINDS: ReadonlySet<ReplayFailureKind> = new Set<ReplayFailureKind>([
  'empty_chain',
  'step_index_not_gapless',
  'unknown_operation',
  'arity',
  'unknown_operand_kind',
  'non_string_literal',
  'malformed_literal',
  'forward_step_reference',
  'invalid_step_reference',
  'missing_record',
  'unresolvable_field',
  'non_monetary_field',
  'non_monetary_operand',
  'division_by_zero',
  'non_monetary_result_stated',
  'non_monetary_terminal_step',
]);

/**
 * Replay, or throw with the failure classified.
 *
 * `out_of_range` and `result_disagreement` are the two kinds that mean the
 * property is false: the producer's arithmetic and the replay's disagree, or a
 * figure left the paise range. Everything else is a malformed chain.
 */
function replayOrExplain(
  view: Pick<EvidenceChainView, 'steps' | 'figure_paise'>,
  lookup: SourceRecordLookup,
  verifyStatedResults: boolean,
): bigint {
  const outcome = replaySteps(view.steps, { lookup, verifyStatedResults });
  if (outcome.ok) {
    return outcome.figure_paise;
  }
  const failure = outcome.failure;
  const label = GENERATOR_FAULT_KINDS.has(failure.kind)
    ? 'GENERATOR FAULT (the generated chain is malformed; fix evidence-chain-generators.ts)'
    : 'P6 FAILURE (the producing arithmetic and the replay disagree)';
  throw new Error(
    `${label}: ${failure.kind} at step ${String(failure.step_index)} operand ` +
      `${String(failure.operand_position)} (verifyStatedResults=${String(verifyStatedResults)}): ` +
      failure.message,
  );
}

/* -------------------------------------------------------------------------- */
/* Persist, read back, walk every page                                        */
/* -------------------------------------------------------------------------- */

interface PersistedChain {
  readonly view: EvidenceChainView;
  readonly pages: readonly EvidenceSourcePage[];
}

/**
 * Compose one chain, persist it, read it back, and walk every source page.
 *
 * The read-back is the point: the steps P6 replays have been through
 * `evidenceChainWriteFor`, a JSONB round trip and `parseEvidenceOperands`, and
 * arrive from the store out of order.
 */
async function persistAndWalk(input: EvidenceChainInput): Promise<PersistedChain> {
  const store = createMemoryEvidenceStore();
  const builder = createEvidenceChainBuilder({ store, tenantId: TENANT });

  // The funnel. A rejection here is a malformed chain, so it is labelled as this
  // file's fault rather than surfacing as an opaque property failure.
  try {
    composeEvidenceChain(input);
  } catch (error) {
    throw new Error(
      `GENERATOR FAULT (composeEvidenceChain rejected a generated chain): ${String(error)}`,
      { cause: error },
    );
  }

  const built = await builder.build(input);
  expect(built.ok).toBe(true);
  if (!built.ok) {
    throw new Error('unreachable: the funnel accepted the chain and the store accepted the write');
  }

  const view = await builder.read(built.evidence.evidence_chain_id);
  expect(view).not.toBeNull();
  if (view === null) {
    throw new Error('unreachable: the chain was just written for this Tenant');
  }

  const pages: EvidenceSourcePage[] = [];
  for await (const page of builder.sourcePages(view.evidence_chain_id)) {
    pages.push(page);
  }
  return { view, pages };
}

const refKey = (ref: SourceRef): string => `${ref.type}\u0000${ref.id}`;

/**
 * The three clauses of P6, asserted over one persisted chain.
 *
 * `expectedFigure` is what the producer said the figure was, so the equality is a
 * three-way one: producer → persisted header → replay.
 */
function assertP6(
  persisted: PersistedChain,
  records: readonly (ReplaySourceRecord & { readonly ref: SourceRef })[],
  expectedFigure: bigint,
  expectedSourceCount: number,
): void {
  const { view, pages } = persisted;
  const lookup = recordLookupFromRecords(records);

  // Clause 1: exact bigint equality, zero difference, no tolerance. Twice — with
  // the stated intermediates verified, and with them ignored entirely.
  expect(view.figure_paise).toBe(expectedFigure);
  expect(replayOrExplain(view, lookup, true)).toBe(view.figure_paise);
  expect(replayOrExplain(view, lookup, false)).toBe(view.figure_paise);

  // Clause 2: `source_count` is the number of identifiers across every page.
  const identifiers = pages.flatMap((page) => page.sources.map((source) => refKey(source.ref)));
  expect(view.source_count).toBe(expectedSourceCount);
  expect(identifiers).toHaveLength(view.source_count);

  // Clause 3: each identifier exactly once — asserted on distinctness, not only
  // on the count, since a dropped identifier and a repeated one cancel out in a
  // length check. And no page exceeds the 500 cap (Requirement 12.2).
  expect(new Set(identifiers).size).toBe(identifiers.length);
  for (const page of pages) {
    expect(page.sources.length).toBeLessThanOrEqual(MAX_SOURCE_PAGE_SIZE);
    expect(page.source_count).toBe(view.source_count);
  }
  // Every page but the last is full, and only the last has no successor: a short
  // interior page would mean the walk skipped rows.
  pages.forEach((page, index) => {
    const isLast = index === pages.length - 1;
    expect(page.next === null).toBe(isLast);
    if (!isLast) {
      expect(page.sources.length).toBe(MAX_SOURCE_PAGE_SIZE);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Half 1: generated Evidence_Chains                                          */
/* -------------------------------------------------------------------------- */

describe('P6 over generated Evidence_Chains', () => {
  it('replays every chain to its figure and pages every identifier exactly once', async () => {
    /** Observed breadth, asserted after the run so the >500 case cannot vanish. */
    const observed = { narrow: 0, wide: 0, widest: 0, pagesSeen: 0 };

    await fc.assert(
      fc.asyncProperty(arbitraryEvidenceChainCase, async (testCase) => {
        const persisted = await persistAndWalk(testCase.input);

        assertP6(
          persisted,
          testCase.dataset.records,
          testCase.input.figure_paise,
          testCase.expected_source_count,
        );

        observed[testCase.breadth] += 1;
        observed.widest = Math.max(observed.widest, testCase.expected_source_count);
        observed.pagesSeen += persisted.pages.length;
      }),
      PARAMS,
    );

    // The >500-source case is drawn from an explicit weighted branch, so this is a
    // statement about the distribution rather than a hope about `fc.array` sizing.
    expect(observed.narrow + observed.wide).toBe(NUM_RUNS);
    expect(observed.wide).toBeGreaterThan(0);
    expect(observed.widest).toBeGreaterThan(MAX_SOURCE_PAGE_SIZE);
    // A wide chain is at least two pages, so more pages were walked than chains.
    expect(observed.pagesSeen).toBeGreaterThan(NUM_RUNS);
  });

  it('pages a chain with more than 500 sources across the boundary, at both wide sizes', async () => {
    // The sizes matter enough to be pinned as examples too: `fc.constantFrom` draws
    // them, but a distribution assertion cannot say WHICH wide size ran, and 501 —
    // one identifier past the cap — is the shape a keyset walk gets wrong.
    for (const size of WIDE_SOURCE_COUNTS) {
      const [dataset] = fc.sample(evidenceTenantDatasetOfSize(size), { numRuns: 1, seed: SEED });
      expect(dataset).toBeDefined();
      if (dataset === undefined) {
        return;
      }
      const input = buildChain(dataset, []);
      const persisted = await persistAndWalk(input);

      assertP6(persisted, dataset.records, input.figure_paise, size);
      const sizes = persisted.pages.map((page) => page.sources.length);
      expect(sizes.reduce((total, count) => total + count, 0)).toBe(size);
      expect(sizes[0]).toBe(MAX_SOURCE_PAGE_SIZE);
      expect(sizes.length).toBeGreaterThan(1);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Half 2: every read_only tool in the catalogue                              */
/* -------------------------------------------------------------------------- */

/** Datasets for the tool-driven half: mostly narrow, with the page boundary crossed. */
const arbitraryProbeDataset: fc.Arbitrary<EvidenceTenantDataset> = fc.oneof(
  { weight: 5, arbitrary: arbitraryEvidenceTenantDataset },
  { weight: 1, arbitrary: evidenceTenantDatasetOfSize(MAX_SOURCE_PAGE_SIZE + 1) },
);

/**
 * Invoke one probe over one dataset and assert P6 on every figure it presented.
 *
 * The probed chain is re-persisted into P6's own store before the pages are
 * walked: a probe hands back a chain, not the store holding it. The identifiers
 * and citations are the tool's own — nothing is reconstructed to make the
 * arithmetic work — and where a probe omits citation timestamps, one citation per
 * identifier is synthesised from `evidence.as_of`, which is enough for the
 * pagination clauses and is stated in `ProbedFigure`.
 */
async function assertProbe(
  probe: P6ToolProbe,
  dataset: EvidenceTenantDataset,
): Promise<number> {
  const figures = await probe.figuresFor(dataset);
  for (const figure of figures) {
    const citations =
      figure.citations ??
      figure.evidence.sources.map((ref) => ({
        ref,
        field: 'amount',
        record_updated_at: figure.evidence.as_of,
      }));
    const persisted = await persistAndWalk({
      produced_by: figure.evidence.produced_by,
      figure_paise: figure.evidence.figure_paise,
      steps: figure.evidence.steps,
      sources: citations,
    });
    assertP6(
      persisted,
      figure.records,
      figure.evidence.figure_paise,
      figure.evidence.source_count,
    );
  }
  return figures.length;
}

describe('P6 over every read_only Financial_Tool in the catalogue', () => {
  it('records that the production read-only catalogue is still empty (tasks 12.x)', async () => {
    const catalogue = await discoverCatalogue(PRODUCTION_ROOTS);

    // Discovery genuinely ran: `src/tools` holds `tool.ts` and `registry.ts` today.
    expect(catalogue.modules.length).toBeGreaterThan(0);
    // WHEN THIS FAILS, tasks 12.x have landed a read-only tool. That is the
    // intended trigger, not a regression: the tool is now covered by the property
    // below, and this test — plus `test/property/fixtures/specimen-read-only-tool.ts`
    // and the specimen property that exercises it — should be deleted, since the
    // machinery no longer needs a stand-in to prove it runs.
    expect(catalogue.registry.byMode('read_only').map((entry) => entry.tool.name)).toEqual([]);
  });

  it('leaves no read-only tool without a P6 probe, and no probe stranded', async () => {
    const catalogue = await discoverCatalogue(PRODUCTION_ROOTS);

    // A registered read-only tool with no probe cannot be replayed by P6, and a
    // figure no property can replay is exactly what Requirement 12.8 forbids
    // going unchecked. Empty today, and the check is what makes half 2 inescapable.
    expect(missingProbes(catalogue)).toEqual([]);
    expect(strandedProbes(catalogue)).toEqual([]);
  });

  it('holds for every discovered read-only tool over generated datasets', async () => {
    const catalogue = await discoverCatalogue(PRODUCTION_ROOTS);
    if (catalogue.readOnly.length === 0) {
      // Vacuous today, by the state of the catalogue rather than by omission. The
      // specimen property below is what proves this loop's body executes.
      return;
    }

    await fc.assert(
      fc.asyncProperty(arbitraryProbeDataset, async (dataset) => {
        for (const entry of catalogue.readOnly) {
          const probe = catalogue.probes.get(entry.tool.name);
          expect(probe).toBeDefined();
          if (probe === undefined) {
            return;
          }
          await assertProbe(probe, dataset);
        }
      }),
      PARAMS,
    );
  });

  it('runs against a specimen read-only tool, so the tool-driven path is not dead code', async () => {
    const catalogue = await discoverCatalogue([SPECIMEN_ROOT]);

    // The specimen passed the real registration audit: strict schema, bounded
    // argument, snake_case name, the fixed 10-second bound.
    expect(catalogue.readOnly.map((entry) => entry.tool.name)).toEqual([
      'get_specimen_evidence_figure',
    ]);
    expect(missingProbes(catalogue)).toEqual([]);

    let figuresChecked = 0;
    await fc.assert(
      fc.asyncProperty(arbitraryProbeDataset, async (dataset) => {
        for (const entry of catalogue.readOnly) {
          const probe = catalogue.probes.get(entry.tool.name);
          expect(probe).toBeDefined();
          if (probe === undefined) {
            return;
          }
          figuresChecked += await assertProbe(probe, dataset);
        }
      }),
      PARAMS,
    );

    // A probe that returned no figure for every dataset would leave the loop body
    // asserting nothing, which is the failure mode this half exists to avoid.
    expect(figuresChecked).toBe(NUM_RUNS);
  });
});
