/**
 * The contract suite over the **real** Financial_Tool catalogue (task 12.7).
 * Requirements 12.1, 12.2, 12.3, 12.7, 12.9, 12.11.
 *
 * This is the wiring task 10.2 left a trip-wire for. `@/tools/catalogue` builds the
 * registry, `./slice-1-catalogue.ts` supplies one fixture per tool, and
 * {@link runToolContract} generates ten cases per entry from the registry itself — the
 * declaration audit, a conforming input, argument coverage, the schema-violation battery
 * with zero connections acquired, output-schema drift, the declared mode, write
 * authorization, monetary grounding, Requirement 12.3's withheld figure, and the
 * ten-second bound.
 *
 * Nothing is asserted per tool by hand. A tool added to `@/tools/catalogue` with no
 * fixture **fails** this suite, and a fixture naming a tool the catalogue does not hold
 * fails it too, so neither the catalogue nor the fixture map can drift from the other.
 *
 * The catalogue's distance from design.md's twenty tools is asserted here rather than
 * assumed: `catalogueGaps` names the seven that are still absent, so the suite reads as
 * "these thirteen are under contract, those seven are not yet built" instead of implying
 * completeness.
 *
 * **Task 24.3 added the write-capable mode assertions.** The generated
 * `writeAuthorizationCase` was written in task 10.2 and had never run against a
 * `write_capable` tool, because the catalogue held none: for a read-only tool it asserts
 * only that the fixture supplies no Proposal pair and that the tool is not refused as an
 * unauthorized write. With `post_reconciliation_adjustment` and `mark_exception_resolved`
 * registered it now runs its real branch on both — an invocation carrying **no** pair, and
 * one carrying the pair with **no** authorization source at all, each of which must be
 * refused as `unauthorized_write` with zero connections acquired, zero executions, and
 * `unauthorized_write_rejected` appended (Requirement 12.10). `modeCase` likewise now
 * exercises its `write_capable` direction: the connection handed to each write tool is the
 * one the provider answers for `write_capable`, and a provider answering `read_only`
 * instead is a fault rather than a fallback.
 */

import { describe, expect, it } from 'vitest';

import { SLICE_1_TOOL_NAMES } from '@/tools/catalogue';

import { SLICE_1_FIXTURES, SLICE_1_REGISTRY } from './slice-1-catalogue';
import { catalogueGaps, DESIGN_CATALOGUE, runToolContract } from './tool-contract';

/* -------------------------------------------------------------------------- */
/* Every clause of the contract, for every tool in the catalogue              */
/* -------------------------------------------------------------------------- */

runToolContract({ registry: SLICE_1_REGISTRY, fixtures: SLICE_1_FIXTURES });

/* -------------------------------------------------------------------------- */
/* What the catalogue holds, and what it does not                             */
/* -------------------------------------------------------------------------- */

/** The seven design.md tools no task has built yet, in design.md's order. */
const NOT_YET_BUILT: readonly string[] = [
  'get_compliance_findings',
  'get_itc_discrepancy',
  'get_cash_forecast',
  'simulate_cash_action',
  'get_failed_payment_recovery_profile',
  'get_period_comparison',
  // The one write-capable tool 24.3 does not build: it is the only tool that calls a
  // Razorpay write API, which is a different problem from writing the ledger.
  'initiate_payment_retry',
];

/** The two write-capable tools of task 24.3, in design.md's catalogue order. */
const WRITE_CAPABLE: readonly string[] = [
  'post_reconciliation_adjustment',
  'mark_exception_resolved',
];

describe('the Slice 1 catalogue against design.md', () => {
  it('registers eleven read_only tools and the two write_capable ones, in catalogue order', () => {
    expect(SLICE_1_REGISTRY.names()).toEqual(SLICE_1_TOOL_NAMES);
    expect(SLICE_1_REGISTRY.byMode('write_capable').map((entry) => entry.tool.name)).toEqual(
      WRITE_CAPABLE,
    );
    expect(SLICE_1_REGISTRY.byMode('read_only')).toHaveLength(
      SLICE_1_TOOL_NAMES.length - WRITE_CAPABLE.length,
    );
    // The bound is the layer's, not the tool's, and a write-capable tool does not get to
    // widen it (Requirement 12.11).
    for (const entry of SLICE_1_REGISTRY.list()) {
      expect(entry.tool.timeoutMs).toBe(10_000);
    }
  });

  it('names the seven design.md tools still missing, and holds none design.md does not name', () => {
    const gaps = catalogueGaps(SLICE_1_REGISTRY);
    expect(gaps.missing).toEqual(NOT_YET_BUILT);
    expect(gaps.unexpected).toEqual([]);
    // A write-capable tool registered as read_only would be a privilege declaration the
    // connection does not back, so the mode is checked against design.md by name.
    expect(gaps.wrongMode).toEqual([]);
    expect(gaps.missing.length + SLICE_1_TOOL_NAMES.length).toBe(DESIGN_CATALOGUE.length);
  });

  it('is the one place the prose allowance of Requirement 12.9 is used', () => {
    const allowances = SLICE_1_REGISTRY.list()
      .filter((entry) => (entry.tool.freeTextArguments ?? []).length > 0)
      .map((entry) => [entry.tool.name, entry.tool.freeTextArguments] as const);
    // design.md's catalogue forces exactly one prose argument, and the registration audit
    // requires it to carry a maximum length. Any second one would be a new decision.
    expect(allowances).toEqual([['mark_exception_resolved', ['resolution_note']]]);
  });

  it('has a fixture for every registered tool and no fixture for anything else', () => {
    // `runToolContract` asserts this too; restated here because it is the fact that
    // makes "no tool escapes the harness" true rather than hopeful, and a reader of a
    // failing run should not have to find it inside a generated describe block.
    expect(Object.keys(SLICE_1_FIXTURES).sort()).toEqual([...SLICE_1_TOOL_NAMES].sort());
  });
});

/* -------------------------------------------------------------------------- */
/* What task 12.7 found, decided, and left open                               */
/* -------------------------------------------------------------------------- */

/**
 * 1. **The single-`evidence` envelope still cannot carry a chain per figure** (task 10.1's
 *    finding 1). Unchanged here: `ToolResult` and `@/tools/tool` were **not** widened.
 *    Nine tools resolved it inside `Out`, and the harness now reads all three shapes they
 *    use — a per-row chain, a per-cell chain, and a `<field>_evidence_chain_id` sibling.
 * 2. **Two sibling figures with two chains: adopted** (task 12.3's finding 4).
 *    `attributeMonetaryFields` grounds `debit_total_paise` in
 *    `debit_total_evidence_chain_id` where the same object names one, so both of
 *    `get_trial_balance`'s grand-total chains are resolved and each must present the
 *    figure it is named for. Before this, the credit chain was never resolved at all and a
 *    swapped pair passed. No tool changed for it: the convention was already
 *    `get_trial_balance`'s own.
 * 3. **The empty scope is still open, and is not a tool's to close.** Four tools refuse an
 *    empty window as `tool_failure`/`execution_error` because
 *    `evidence_chains.source_count >= 1` is a database CHECK and `ToolResult` has no
 *    chainless success variant. `source_count` was **not** relaxed and no `empty_scope`
 *    variant was added; both are shared contract changes above a tool task. The harness
 *    accommodates the documented refusal — no case asserts anything about an empty scope —
 *    and every fixture supplies a scope holding at least one record. Still escalated.
 * 4. **Requirement 12.3 needed a per-figure reading, and got one.**
 *    `get_control_tower_metrics` answers four independent questions in one invocation and
 *    Requirement 3.9 requires one metric's fault to leave the other three standing, so it
 *    withholds a **cell** rather than the invocation. The harness gained
 *    `incompleteEvidenceScope: 'per_figure'` for that: the withheld cell must carry valid
 *    unavailable types, no monetary field and no chain, and the surviving figures must
 *    remain grounded. Opt-in per fixture, so the other eight tools are still held to the
 *    invocation-wide refusal.
 * 5. **Two tools were changed to satisfy Requirement 12.3, not the harness.**
 *    `list_exceptions_by_category` and `get_exception_evidence` threw when an Exception's
 *    Evidence_Chain could not be read, which surfaced as `tool_failure` — a figure
 *    withheld, but with nothing said about *what* was unavailable. Neither composes its
 *    figure (an Exception's impact is its chain's figure), so an unreadable chain is
 *    literally an unreadable contributor, and both now answer `incomplete_evidence`
 *    naming the Exception's own cited Source_Record types. See `@/tools/exception-tools`.
 * 6. **`isRealDate` is still redundant against `z.iso.date()`** on five tools (12.3's
 *    finding 7), and was left alone. The harness requires a refusal to *name the
 *    argument*, not to name it once — a tool reporting one violation per failing check and
 *    a tool reporting one per argument are both conforming — so no assertion is at stake
 *    and there is nothing here to justify editing five schemas.
 * 7. **`read_only` performs no data write is still unprovable.** The database role with no
 *    write grants lands in task 26.1; until then the mode case proves only that the
 *    connection handed to the tool is the one the provider answers for `tool.mode`, and a
 *    provider answering the other mode is a fault rather than a fallback. Unchanged from
 *    task 10.2, restated because nine tools now depend on it.
 */
