/**
 * Verification with the 1-paisa tolerance (task 23.3).
 * Requirements 5.11, 5.12.
 *
 * The Exception writer here is the **real** one — `createExceptionUpserter` over the same
 * in-memory `exceptions_fingerprint_uniq` store the Reconciliation_Agent's own tests use —
 * so "creates a `verification_failure` Exception with the absolute INR difference as impact
 * and the Proposal and target identifiers attached" is asserted by the row that lands,
 * through the real fingerprint, the real `impact_paise >= 0` rule and the real
 * direction-against-zero rule. A stub would have accepted an Exception the database rejects.
 *
 * What is pinned:
 *
 * 1. **The tolerance is inclusive at 1 paisa in both directions**, decided on `bigint`, and
 *    still exact at the top of the paise range (Requirement 5.11, 15.1).
 * 2. **A non-monetary difference fails Verification on its own**, with an impact of 0 and
 *    `not_applicable` — the only combination `exceptions_direction_check` and
 *    `assertExceptionUpsertable` admit for a zero impact (Requirement 5.12).
 * 3. **The 60-second window is enforced before anything is observed**: a late call observes
 *    nothing, writes nothing, and is not reported as a Verification that failed.
 * 4. **"No further automatic change"** — the failure path issues exactly two writes, in the
 *    order Exception-then-transition, and a second call refuses.
 * 5. **The two statements** are asserted textually: the `executed` guard, the state
 *    literals, the `::paise` casts, and that they differ in nothing but the state.
 */

import { describe, expect, it } from 'vitest';

import {
  createExceptionUpserter,
  type ExceptionUpsertInput,
} from '@/agents/exception-fingerprint';
import {
  memoryExceptionStore,
  type MemoryExceptionStore,
} from '@/agents/reconciliation/agent.test-support';
import type { TenantId } from '@/config/configuration-service';
import type { SourceRef } from '@/ledger/posting-rules';
import { PROPOSAL_STATES, type ProposalState } from '@/policy/checks';
import { toWire } from '@/wire/paise-wire';

import { ActionServiceError } from './action-service';
import {
  compareOutcomes,
  createExecutionVerifier,
  fieldDifferences,
  NOT_VERIFIED_REASONS,
  PAISA_TOLERANCE,
  PROPOSAL_VERIFICATION_FAILED_SQL,
  PROPOSAL_VERIFICATION_LOAD_SQL,
  PROPOSAL_VERIFIED_SQL,
  proposalVerificationParams,
  verifiableOutcomeFrom,
  VERIFICATION_WINDOW_MS,
  verificationDeadline,
  verificationDirectionFor,
  verificationFailureException,
  verifyExecutedProposal,
  VERIFIABLE_STATES,
  withinPaisaTolerance,
  type ProposalVerificationSnapshot,
  type VerifiableOutcome,
  type VerificationOutcome,
  type VerifierDeps,
  type VerificationStore,
} from './verify-execution';

const TENANT: TenantId = '11111111-1111-4111-8111-111111111111';
const PROPOSAL_ID = '22222222-2222-4222-8222-222222222222';
const CHAIN_ID = '33333333-3333-4333-8333-333333333333';
const EXECUTED_AT = '2026-03-01T00:05:00.000Z';
/** 30 s after execution: comfortably inside Requirement 5.11's window. */
const VERIFIED_AT = '2026-03-01T00:05:30.000Z';
/** ₹3,82,000 in paise. The figure the Proposal promised. */
const EXPECTED_PAISE = 38200000n;

const TARGETS: readonly SourceRef[] = [
  { type: 'settlement', id: 'setl_SYNTHETIC9281' },
  { type: 'settlement_recon_report', id: 'setlrcn_SYNTHETIC9281' },
];

const expectedOutcome = (paise = EXPECTED_PAISE, fields?: Record<string, string>): unknown => ({
  paise: toWire(paise),
  ...(fields === undefined ? {} : { fields }),
});

const observedOutcome = (
  paise = EXPECTED_PAISE,
  fields: Record<string, string> = {},
): VerifiableOutcome => ({ paise, fields });

/* -------------------------------------------------------------------------- */
/* The world                                                                  */
/* -------------------------------------------------------------------------- */

/** `proposals`, in the four columns this stage reads and writes. */
interface Row {
  state: ProposalState;
  verified_at: string | null;
  /** Integer paise as text, exactly as the `paise` column holds it. */
  observed_paise: string | null;
  difference_paise: string | null;
}

interface World {
  readonly deps: VerifierDeps;
  /** Every write, in order, so Exception-before-transition is assertable. */
  readonly log: string[];
  readonly exceptions: MemoryExceptionStore;
  readonly row: Row;
  observations(): number;
}

function world(
  options: {
    readonly state?: ProposalState;
    readonly executedAt?: string | null;
    readonly expected?: unknown;
    readonly observed?: VerifiableOutcome;
    readonly observe?: () => Promise<VerifiableOutcome>;
    readonly at?: string;
    readonly absent?: boolean;
  } = {},
): World {
  const log: string[] = [];
  const exceptions = memoryExceptionStore(() => log.push('exception'));
  const row: Row = {
    state: options.state ?? 'executed',
    verified_at: null,
    observed_paise: null,
    difference_paise: null,
  };
  let observations = 0;

  const snapshot: ProposalVerificationSnapshot = {
    proposal_id: PROPOSAL_ID,
    action_type: 'post_reconciliation_adjustment',
    state: row.state,
    executed_at: options.executedAt === undefined ? EXECUTED_AT : options.executedAt,
    target_source_records: TARGETS,
    evidence_chain_id: CHAIN_ID,
    expected_outcome: options.expected === undefined ? expectedOutcome() : options.expected,
  };

  /** The `AND state = 'executed'` guard, and the throw-on-no-row rule the seam states. */
  const transition = (label: string, verifiedAt: string, observed: bigint, difference: bigint): void => {
    if (row.state !== 'executed') {
      throw new Error(`${label} matched no row: the Proposal is ${row.state}`);
    }
    row.state = label === 'verified' ? 'verified' : 'verification_failed';
    row.verified_at = verifiedAt;
    row.observed_paise = toWire(observed);
    row.difference_paise = toWire(difference);
    log.push(label);
  };

  const store: VerificationStore = {
    loadForVerification: (id) =>
      Promise.resolve(
        options.absent === true || id !== PROPOSAL_ID ? null : { ...snapshot, state: row.state },
      ),
    markVerified: (_id, verifiedAt, observed, difference) => {
      transition('verified', verifiedAt, observed, difference);
      return Promise.resolve();
    },
    markVerificationFailed: (_id, verifiedAt, observed, difference) => {
      transition('verification_failed', verifiedAt, observed, difference);
      return Promise.resolve();
    },
  };

  return {
    log,
    exceptions,
    row,
    observations: () => observations,
    deps: {
      store,
      observer: {
        observe: () => {
          observations += 1;
          return options.observe === undefined
            ? Promise.resolve(options.observed ?? observedOutcome())
            : options.observe();
        },
      },
      exceptions: createExceptionUpserter({ store: exceptions, tenantId: TENANT }),
      now: () => new Date(options.at ?? VERIFIED_AT),
    },
  };
}

const verify = (w: World): Promise<VerificationOutcome> =>
  verifyExecutedProposal(PROPOSAL_ID, w.deps);

/** The one Exception the failure path raised. */
function raisedException(w: World): {
  readonly impact_paise: string;
  readonly direction: string;
  readonly links: readonly { readonly source_record_type: string; readonly source_record_id: string; readonly role: string }[];
  readonly detail: Record<string, unknown>;
  readonly category: string;
} {
  expect(w.exceptions.writes).toHaveLength(1);
  const write = w.exceptions.writes[0];
  if (write === undefined) {
    throw new Error('no Exception was written');
  }
  return {
    impact_paise: write.impact_paise,
    direction: write.direction,
    links: write.links,
    detail: JSON.parse(write.detail) as Record<string, unknown>,
    category: write.category,
  };
}

/* -------------------------------------------------------------------------- */
/* Requirement 5.11: the tolerance                                            */
/* -------------------------------------------------------------------------- */

describe('the 1-paisa tolerance (Requirement 5.11)', () => {
  it('is 1 paisa as a bigint, inclusive, in both directions', () => {
    expect(PAISA_TOLERANCE).toBe(1n);
    expect(typeof PAISA_TOLERANCE).toBe('bigint');

    expect([-2n, -1n, 0n, 1n, 2n].map(withinPaisaTolerance)).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
  });

  it('decides the boundary exactly at the top of the paise range', () => {
    // Integer paise, so the 1-paisa boundary is decidable at any magnitude the domain
    // admits. This is the whole reason money is bigint (Requirement 15.1, 15.8).
    const top = 99999999999999n;
    expect(compareOutcomes(observedOutcome(top), observedOutcome(top - 1n))).toMatchObject({
      difference_paise: 1n,
      matched: true,
    });
    expect(compareOutcomes(observedOutcome(top), observedOutcome(top - 2n))).toMatchObject({
      difference_paise: 2n,
      matched: false,
    });
  });

  it('reports the difference as expected minus observed', () => {
    // The same convention `settlement_reconciliations.difference_paise` uses, and the
    // reason `proposals.difference_paise` is on the signed domain.
    expect(compareOutcomes(observedOutcome(500n), observedOutcome(300n)).difference_paise).toBe(200n);
    expect(compareOutcomes(observedOutcome(300n), observedOutcome(500n)).difference_paise).toBe(-200n);
  });

  it('marks a Proposal verified within tolerance and raises no Exception', async () => {
    for (const drift of [0n, 1n, -1n]) {
      const w = world({ observed: observedOutcome(EXPECTED_PAISE - drift) });
      const outcome = await verify(w);

      expect(outcome).toMatchObject({
        kind: 'verified',
        matched: true,
        proposal_id: PROPOSAL_ID,
        expected_paise: EXPECTED_PAISE,
        observed_paise: EXPECTED_PAISE - drift,
        difference_paise: drift,
        verified_at: VERIFIED_AT,
      });
      expect(w.row).toEqual({
        state: 'verified',
        verified_at: VERIFIED_AT,
        observed_paise: toWire(EXPECTED_PAISE - drift),
        difference_paise: toWire(drift),
      });
      // No Exception for a matching Verification, and exactly one observation.
      expect(w.exceptions.writes).toEqual([]);
      expect(w.log).toEqual(['verified']);
      expect(w.observations()).toBe(1);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 5.12: the failure                                              */
/* -------------------------------------------------------------------------- */

describe('a monetary difference above 1 paisa (Requirement 5.12)', () => {
  it('marks the Proposal verification-failed and raises the Exception', async () => {
    const w = world({ observed: observedOutcome(EXPECTED_PAISE - 200n) });
    const outcome = await verify(w);

    expect(outcome).toMatchObject({
      kind: 'verification_failed',
      matched: false,
      monetary_matched: false,
      difference_paise: 200n,
      field_differences: [],
      exception_open: true,
    });
    expect(w.row).toEqual({
      state: 'verification_failed',
      verified_at: VERIFIED_AT,
      observed_paise: toWire(EXPECTED_PAISE - 200n),
      // Signed on the row; the Exception impact is the absolute value.
      difference_paise: '200',
    });

    const raised = raisedException(w);
    expect(raised.category).toBe('verification_failure');
    expect(raised.impact_paise).toBe('200');
    expect(raised.direction).toBe('shortfall');
  });

  it('attaches the Proposal identifier and the target Source_Record identifiers', async () => {
    const w = world({ observed: observedOutcome(EXPECTED_PAISE + 5000n) });
    await verify(w);

    // Requirement 5.12's "the Proposal identifier and target Source_Record identifiers
    // attached", as `exception_source_records` rows. `proposal` is one of the 13
    // source_record_type labels, so the Proposal is attached as a Source_Record rather
    // than buried in detail.
    expect(raisedException(w).links).toEqual([
      { source_record_type: 'proposal', source_record_id: PROPOSAL_ID, role: 'proposal' },
      { source_record_type: 'settlement', source_record_id: 'setl_SYNTHETIC9281', role: 'target' },
      {
        source_record_type: 'settlement_recon_report',
        source_record_id: 'setlrcn_SYNTHETIC9281',
        role: 'target',
      },
    ]);
    // Observed above expected: the sign lives in `direction`, the impact is a magnitude.
    expect(raisedException(w).impact_paise).toBe('5000');
    expect(raisedException(w).direction).toBe('excess');
  });

  it('carries every figure in detail as an integer string, never a JSON number', async () => {
    const w = world({ observed: observedOutcome(EXPECTED_PAISE - 200n) });
    await verify(w);
    const detail = raisedException(w).detail;

    expect(detail).toMatchObject({
      proposal_id: PROPOSAL_ID,
      action_type: 'post_reconciliation_adjustment',
      executed_at: EXECUTED_AT,
      verified_at: VERIFIED_AT,
      expected_paise: '38200000',
      observed_paise: '38199800',
      difference_paise: '200',
      tolerance_paise: '1',
      monetary_matched: false,
    });
    for (const key of ['expected_paise', 'observed_paise', 'difference_paise', 'tolerance_paise']) {
      expect(typeof detail[key], key).toBe('string');
    }
  });

  it('fails a 1-paisa difference that also carries a non-monetary difference', async () => {
    // The tolerance covers the monetary half only. The impact is still "the absolute INR
    // difference" — 1 paisa — because that is what Requirement 5.12 says it is.
    const w = world({
      expected: expectedOutcome(EXPECTED_PAISE, { lifecycle_state: 'resolved' }),
      observed: observedOutcome(EXPECTED_PAISE - 1n, { lifecycle_state: 'open' }),
    });
    const outcome = await verify(w);

    expect(outcome).toMatchObject({
      kind: 'verification_failed',
      monetary_matched: true,
      difference_paise: 1n,
      field_differences: [
        { field: 'lifecycle_state', kind: 'value_differs', expected: 'resolved', observed: 'open' },
      ],
    });
    expect(raisedException(w).impact_paise).toBe('1');
    expect(raisedException(w).direction).toBe('shortfall');
  });
});

describe('a non-monetary difference alone (Requirement 5.12)', () => {
  it('fails Verification with a zero impact and no direction', async () => {
    const w = world({
      expected: expectedOutcome(EXPECTED_PAISE, { lifecycle_state: 'resolved' }),
      observed: observedOutcome(EXPECTED_PAISE, { lifecycle_state: 'open' }),
    });
    const outcome = await verify(w);

    expect(outcome).toMatchObject({ kind: 'verification_failed', monetary_matched: true, difference_paise: 0n });
    expect(w.row.state).toBe('verification_failed');
    // `assertExceptionUpsertable` rejects any direction but `not_applicable` against a
    // zero impact, so this is the only pair the real upserter accepts here.
    expect(raisedException(w).impact_paise).toBe('0');
    expect(raisedException(w).direction).toBe('not_applicable');
  });

  it('reports a field only one side states, rather than ignoring it', () => {
    expect(
      fieldDifferences(observedOutcome(0n, { a: 'x' }), observedOutcome(0n, { b: 'y' })),
    ).toEqual([
      { field: 'a', kind: 'absent_from_observed', expected: 'x' },
      { field: 'b', kind: 'absent_from_expected', observed: 'y' },
    ]);
  });

  it('distinguishes a null value from an absent field', () => {
    expect(fieldDifferences(observedOutcome(0n), { paise: 0n, fields: { note: null } })).toEqual([
      { field: 'note', kind: 'absent_from_expected', observed: null },
    ]);
    expect(fieldDifferences({ paise: 0n, fields: { note: null } }, { paise: 0n, fields: { note: null } })).toEqual([]);
  });

  it('renders both sides of a field difference in detail, so absent and null stay distinct', async () => {
    const w = world({
      expected: expectedOutcome(EXPECTED_PAISE, { lifecycle_state: 'resolved' }),
      observed: observedOutcome(EXPECTED_PAISE, { set_id: 'set_1' }),
    });
    await verify(w);

    expect(raisedException(w).detail.field_differences).toEqual([
      { field: 'lifecycle_state', kind: 'absent_from_observed', expected: '"resolved"', observed: 'absent' },
      { field: 'set_id', kind: 'absent_from_expected', expected: 'absent', observed: '"set_1"' },
    ]);
  });
});

describe('"make no further automatic change" (Requirement 5.12)', () => {
  it('writes the Exception before the state transition, and nothing else', async () => {
    const w = world({ observed: observedOutcome(EXPECTED_PAISE - 200n) });
    await verify(w);

    // The Exception is the idempotent step and the transition is the irreversible one, so
    // a crash between them leaves a condition a retry can complete rather than a Proposal
    // that looks handled with nothing in the Attention_Panel.
    expect(w.log).toEqual(['exception', 'verification_failed']);
    expect(w.exceptions.rows.size).toBe(1);
  });

  it('refuses a second Verification of the same Proposal', async () => {
    const w = world({ observed: observedOutcome(EXPECTED_PAISE - 200n) });
    await verify(w);
    const again = await verify(w);

    expect(again).toMatchObject({
      kind: 'not_verified',
      reason: 'already_verified',
      state: 'verification_failed',
    });
    // No second Exception, no second transition, no second observation.
    expect(w.log).toEqual(['exception', 'verification_failed']);
    expect(w.observations()).toBe(1);
  });

  it('reports an Exception a User had already closed as not reopened', async () => {
    const w = world({ observed: observedException() });
    const first = await verify(w);
    expect(first.kind).toBe('verification_failed');

    // A User resolves it, and the same condition is re-detected (reachable only if the
    // Proposal state was moved back outside this module).
    for (const row of w.exceptions.rows.values()) {
      row.state = 'resolved';
    }
    w.row.state = 'executed';
    const second = await verify(w);

    expect(second).toMatchObject({ kind: 'verification_failed', exception_open: false });
    expect(w.exceptions.rows.size).toBe(1);
  });
});

/** An observation 200 paise short of what the Proposal promised. */
function observedException(): VerifiableOutcome {
  return observedOutcome(EXPECTED_PAISE - 200n);
}

/* -------------------------------------------------------------------------- */
/* The 60-second window                                                       */
/* -------------------------------------------------------------------------- */

describe('the 60-second window (Requirement 5.11)', () => {
  it('is 60 seconds, and the deadline is executed_at plus that', () => {
    expect(VERIFICATION_WINDOW_MS).toBe(60_000);
    expect(verificationDeadline(EXECUTED_AT)).toBe('2026-03-01T00:06:00.000Z');
  });

  it('verifies at exactly the deadline', async () => {
    const w = world({ at: verificationDeadline(EXECUTED_AT) });
    await expect(verify(w)).resolves.toMatchObject({ kind: 'verified' });
  });

  it('observes nothing and writes nothing one millisecond past the deadline', async () => {
    const w = world({ at: '2026-03-01T00:06:00.001Z', observed: observedException() });
    const outcome = await verify(w);

    expect(outcome).toMatchObject({
      kind: 'not_verified',
      reason: 'verification_window_elapsed',
      state: 'executed',
    });
    // A difference observed this late is not attributable to this execution, so it is not
    // reported as a Verification that failed — and nothing was read to report.
    expect(w.observations()).toBe(0);
    expect(w.log).toEqual([]);
    expect(w.row).toMatchObject({ state: 'executed', verified_at: null, difference_paise: null });
  });
});

/* -------------------------------------------------------------------------- */
/* Refusals and faults                                                        */
/* -------------------------------------------------------------------------- */

describe('what Verification refuses', () => {
  it('reports an absent Proposal as absent, never as an error confirming it exists', async () => {
    const w = world({ absent: true });
    await expect(verify(w)).resolves.toMatchObject({
      kind: 'not_verified',
      reason: 'proposal_absent',
    });
    expect(w.observations()).toBe(0);
  });

  it('verifies from `executed` and from no other state', async () => {
    expect(VERIFIABLE_STATES).toEqual(['executed']);

    for (const state of PROPOSAL_STATES) {
      const w = world({ state, observed: observedException() });
      const outcome = await verify(w);

      if (state === 'executed') {
        expect(outcome.kind, state).toBe('verification_failed');
        continue;
      }
      expect(outcome, state).toMatchObject({
        kind: 'not_verified',
        reason: state === 'verified' || state === 'verification_failed' ? 'already_verified' : 'not_executed',
        state,
      });
      // Nothing observed, nothing written, for every state but `executed`.
      expect(w.observations(), state).toBe(0);
      expect(w.log, state).toEqual([]);
    }
  });

  it('names every refusal reason it can return', () => {
    expect([...NOT_VERIFIED_REASONS]).toEqual([
      'proposal_absent',
      'not_executed',
      'already_verified',
      'verification_window_elapsed',
    ]);
  });
});

describe('faults, which are not verdicts', () => {
  it('rejects an empty identifier as a caller fault', async () => {
    await expect(verifyExecutedProposal('  ', world().deps)).rejects.toThrow(ActionServiceError);
  });

  it('throws for an executed Proposal with no executed_at', async () => {
    // Task 23.2 writes `state` and `executed_at` in one update, so this is a corrupt row.
    await expect(verify(world({ executedAt: null }))).rejects.toThrow(/not an instant/);
  });

  it('throws for a clock reading before executed_at', async () => {
    await expect(verify(world({ at: '2026-03-01T00:04:59.999Z' }))).rejects.toThrow(
      /before executed_at/,
    );
  });

  it('throws for a stored state that is not a proposal_state label', async () => {
    const w = world({ state: 'settled' as ProposalState });
    await expect(verify(w)).rejects.toThrow(ActionServiceError);
  });
});

/* -------------------------------------------------------------------------- */
/* The assumed shape of expected_outcome (FINDING 1)                          */
/* -------------------------------------------------------------------------- */

describe('the expected outcome as stored', () => {
  it('reads one monetary figure as a decimal string and its non-monetary fields', () => {
    expect(verifiableOutcomeFrom({ paise: '-38200000', fields: { a: 'x', b: true, c: null } }, 'e')).toEqual({
      paise: -38200000n,
      fields: { a: 'x', b: true, c: null },
    });
    expect(verifiableOutcomeFrom({ paise: '0' }, 'e')).toEqual({ paise: 0n, fields: {} });
  });

  it('rejects a JSON number for the monetary figure', () => {
    // JSONB would have kept 38200000.0 as an IEEE-754 double (Requirement 15.1, 15.8).
    expect(() => verifiableOutcomeFrom({ paise: 38200000 }, 'e')).toThrow(/IEEE-754 double/);
  });

  it('rejects a key the comparison does not read, rather than verifying half the statement', () => {
    expect(() => verifiableOutcomeFrom({ paise: '0', status: 'adjusted' }, 'e')).toThrow(/"status"/);
  });

  it('rejects a number, an object and an array inside fields', () => {
    expect(() => verifiableOutcomeFrom({ paise: '0', fields: { total: 2 } }, 'e')).toThrow(/number 2/);
    expect(() => verifiableOutcomeFrom({ paise: '0', fields: { nested: {} } }, 'e')).toThrow(/scalar/);
    expect(() => verifiableOutcomeFrom({ paise: '0', fields: { list: [] } }, 'e')).toThrow(/scalar/);
  });

  it('rejects a stated outcome that is not an object, or states no figure', () => {
    expect(() => verifiableOutcomeFrom([], 'e')).toThrow(/an array/);
    expect(() => verifiableOutcomeFrom(null, 'e')).toThrow(/JSON object/);
    expect(() => verifiableOutcomeFrom({}, 'e')).toThrow(/decimal string/);
  });

  it('throws through verify for an unusable stored expected_outcome', async () => {
    const w = world({ expected: { status: 'adjusted' } });
    await expect(verify(w)).rejects.toThrow(ActionServiceError);
    expect(w.observations()).toBe(0);
    expect(w.log).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The pure Exception builder                                                 */
/* -------------------------------------------------------------------------- */

describe('the verification_failure Exception, built purely', () => {
  const build = (difference: bigint): ExceptionUpsertInput =>
    verificationFailureException({
      proposal_id: PROPOSAL_ID,
      action_type: 'post_reconciliation_adjustment',
      target_source_records: TARGETS,
      evidence_chain_id: CHAIN_ID,
      executed_at: EXECUTED_AT,
      comparison: compareOutcomes(
        observedOutcome(EXPECTED_PAISE),
        observedOutcome(EXPECTED_PAISE - difference),
      ),
      detected_at: VERIFIED_AT,
    });

  it('maps the sign of the difference onto direction and the magnitude onto impact', () => {
    expect(verificationDirectionFor(1n)).toBe('shortfall');
    expect(verificationDirectionFor(-1n)).toBe('excess');
    expect(verificationDirectionFor(0n)).toBe('not_applicable');

    expect(build(-4200n)).toMatchObject({ impact_paise: 4200n, direction: 'excess' });
    expect(build(4200n)).toMatchObject({ impact_paise: 4200n, direction: 'shortfall' });
  });

  it('states no scope, because verification_failure is identified by its refs alone', () => {
    // Requirement 4.15: only the two Marketplace categories are range-scoped, and
    // `exceptionScopeSegment` rejects a scope on any other.
    expect(build(200n).scope).toBeUndefined();
    expect(build(200n).category).toBe('verification_failure');
    expect(build(200n).evidence_chain_id).toBe(CHAIN_ID);
  });

  it('does not link the Proposal twice when it is also one of its own targets', () => {
    const input = verificationFailureException({
      proposal_id: PROPOSAL_ID,
      action_type: 'post_reconciliation_adjustment',
      target_source_records: [{ type: 'proposal', id: PROPOSAL_ID }, ...TARGETS],
      evidence_chain_id: CHAIN_ID,
      executed_at: EXECUTED_AT,
      comparison: compareOutcomes(observedOutcome(1n), observedOutcome(0n)),
      detected_at: VERIFIED_AT,
    });

    expect(input.source_refs.filter((ref) => ref.type === 'proposal')).toEqual([
      { type: 'proposal', id: PROPOSAL_ID, role: 'proposal' },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* The statements                                                             */
/* -------------------------------------------------------------------------- */

describe('the statements an adapter runs', () => {
  it('guards both transitions on `executed` and writes all four columns together', () => {
    for (const sql of [PROPOSAL_VERIFIED_SQL, PROPOSAL_VERIFICATION_FAILED_SQL]) {
      expect(sql).toContain("AND state = 'executed'");
      expect(sql).toContain('verified_at = $3::timestamptz');
      expect(sql).toContain('observed_paise = $4::paise');
      expect(sql).toContain('difference_paise = $5::paise');
      expect(sql).toContain('RETURNING id, state, verified_at');
      // Tenant-scoped, and the identifier is a parameter (Requirement 12.7, 14.1).
      expect(sql).toContain('WHERE tenant_id = $1');
      // No float or decimal type anywhere near money.
      expect(sql).not.toMatch(/numeric|float|::text/i);
    }
  });

  it('carries its state as a literal, so neither statement can be bent into the other', () => {
    expect(PROPOSAL_VERIFIED_SQL).toContain("SET state = 'verified'");
    expect(PROPOSAL_VERIFICATION_FAILED_SQL).toContain("SET state = 'verification_failed'");
    // Identical but for the state: one write, recorded with the same provenance either way.
    expect(PROPOSAL_VERIFIED_SQL.replace("'verified'", "'verification_failed'")).toBe(
      PROPOSAL_VERIFICATION_FAILED_SQL,
    );
    expect(PROPOSAL_VERIFIED_SQL).not.toContain('execution_failed');
  });

  it('selects what the comparison and the Exception need, and not impact_paise', () => {
    for (const column of [
      'expected_outcome',
      'target_source_records',
      'evidence_chain_id',
      'executed_at',
      'verified_at',
      'state',
    ]) {
      expect(PROPOSAL_VERIFICATION_LOAD_SQL, column).toContain(column);
    }
    // The Proposal's stated impact is not the figure Verification compares.
    expect(PROPOSAL_VERIFICATION_LOAD_SQL).not.toContain('impact_paise');
  });

  it('binds money as decimal strings', () => {
    expect(proposalVerificationParams(TENANT, PROPOSAL_ID, VERIFIED_AT, 38199800n, -200n)).toEqual([
      TENANT,
      PROPOSAL_ID,
      VERIFIED_AT,
      '38199800',
      '-200',
    ]);
  });

  it('is reachable through design.md\u2019s verify(proposalId)', async () => {
    const w = world();
    await expect(createExecutionVerifier(w.deps).verify(PROPOSAL_ID)).resolves.toMatchObject({
      kind: 'verified',
    });
  });
});
