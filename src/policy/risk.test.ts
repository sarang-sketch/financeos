/**
 * The Proposal risk score (task 22.2). Requirement 5.15.
 *
 * The exhaustive tables — every band boundary, every action type, absent counts of 0,
 * 1, 3 and 4 — belong to task 22.3. What is pinned here is the behaviour that a
 * refactor could silently break and that no table would catch:
 *
 * 1. **The bands are half-open.** A magnitude exactly on a ceiling scores the *higher*
 *    band, so a `<=` written for a `<` fails here rather than a paisa at a time in
 *    production.
 * 2. **Monotone non-decreasing in each input**, which design.md states and
 *    `docs/14_ACCEPTANCE_CRITERIA.md` makes merge-gating. Asserted over a walk of the
 *    band edges rather than over one pair.
 * 3. **An unlisted action type has no score.** It raises rather than scoring 0, which
 *    at the default Auto_Execute_Threshold of 0 would auto-execute an unknown action.
 * 4. **The absolute value is taken on `bigint`** and a negative impact scores exactly
 *    as its positive twin.
 */

import { describe, expect, it } from 'vitest';

import { PaiseRangeError, PaiseTypeError } from '@/calc/paise';

import {
  absentEvidencePoints,
  ACTION_POINTS,
  actionTypePoints,
  EVIDENCE_MAX_POINTS,
  IMPACT_BANDS,
  IMPACT_MAX_POINTS,
  impactPointsFor,
  isProposalActionType,
  isRiskScore,
  PROPOSAL_ACTION_TYPES,
  RISK_SCORE_MAX,
  riskScore,
  riskScoreBreakdown,
  RiskScoreError,
  riskScoreFromChecks,
} from './risk';

/** The five rupee boundaries task 22.3 names, in paise. */
const BOUNDARY_PAISE = [100_000n, 1_000_000n, 10_000_000n, 100_000_000n, 1_000_000_000n] as const;

const LIGHTEST = 'mark_exception_resolved';
const HEAVIEST = 'initiate_payment_retry';

describe('the impact term', () => {
  it('treats every band ceiling as exclusive, so a boundary scores the higher band', () => {
    for (const [position, ceiling] of BOUNDARY_PAISE.entries()) {
      const below = IMPACT_BANDS[position]?.points;
      const atOrAbove = IMPACT_BANDS[position + 1]?.points ?? IMPACT_MAX_POINTS;

      expect(impactPointsFor(ceiling - 1n)).toBe(below);
      expect(impactPointsFor(ceiling)).toBe(atOrAbove);
    }
  });

  it('scores below the first ceiling at 0 and at or above the last at the maximum', () => {
    expect(impactPointsFor(0n)).toBe(0);
    expect(impactPointsFor(99_999n)).toBe(0);
    expect(impactPointsFor(1_000_000_000n)).toBe(IMPACT_MAX_POINTS);
    expect(impactPointsFor(99_999_999_999_999n)).toBe(IMPACT_MAX_POINTS);
  });

  it('scores a negative impact exactly as its positive twin (Requirement 5.15, absolute)', () => {
    for (const magnitude of [...BOUNDARY_PAISE, 38_200_000n, 1n]) {
      expect(impactPointsFor(-magnitude)).toBe(impactPointsFor(magnitude));
    }
    // The symmetric paise range is what makes the bigint negation safe.
    expect(impactPointsFor(-99_999_999_999_999n)).toBe(IMPACT_MAX_POINTS);
  });

  it('refuses an impact that is not in-range paise', () => {
    expect(() => impactPointsFor(100_000_000_000_000n)).toThrow(PaiseRangeError);
    // A `number` impact is the mistake the whole paise discipline exists to catch.
    expect(() => impactPointsFor(38_200_000 as unknown as bigint)).toThrow(PaiseTypeError);
  });
});

describe('the action type term', () => {
  it('scores the three action types in ascending order of what they touch', () => {
    expect(PROPOSAL_ACTION_TYPES.map((type) => actionTypePoints(type))).toEqual([5, 15, 25]);
    expect(ACTION_POINTS[LIGHTEST]).toBeLessThan(ACTION_POINTS[HEAVIEST]);
  });

  it('refuses an action type outside the three rather than scoring it 0', () => {
    // `post_reversal` is the fixture value in test/db/proposals-authorizations.test.ts
    // and src/policy/checks.test.ts, and it is not a Proposal action type. See FINDING 1.
    expect(isProposalActionType('post_reversal')).toBe(false);
    expect(() => actionTypePoints('post_reversal')).toThrow(RiskScoreError);
    expect(() => actionTypePoints('')).toThrow(RiskScoreError);
  });
});

describe('the absent-evidence term', () => {
  it('scores 5 per absent Source_Record and saturates at 15', () => {
    expect([0, 1, 2, 3, 4, 400].map((count) => absentEvidencePoints(count))).toEqual([
      0, 5, 10, 15, 15, 15,
    ]);
    expect(absentEvidencePoints(3)).toBe(EVIDENCE_MAX_POINTS);
  });

  it('refuses a negative or fractional count, which would lower the score', () => {
    expect(() => absentEvidencePoints(-1)).toThrow(RiskScoreError);
    expect(() => absentEvidencePoints(1.5)).toThrow(RiskScoreError);
  });
});

describe('the score', () => {
  it('is monotone non-decreasing in each input independently', () => {
    const walk = [0n, ...BOUNDARY_PAISE.flatMap((p) => [p - 1n, p])];

    // Impact, holding the other two fixed.
    let previous = -1;
    for (const impact_paise of walk) {
      const score = riskScore({
        impact_paise,
        action_type: LIGHTEST,
        absent_evidence_source_count: 0,
      });
      expect(score).toBeGreaterThanOrEqual(previous);
      previous = score;
    }

    // Action type, holding the other two fixed.
    const byAction = PROPOSAL_ACTION_TYPES.map((action_type) =>
      riskScore({ impact_paise: 38_200_000n, action_type, absent_evidence_source_count: 0 }),
    );
    expect([...byAction].sort((a, b) => a - b)).toEqual(byAction);

    // Absent count, holding the other two fixed.
    const byAbsent = [0, 1, 2, 3, 4].map((absent_evidence_source_count) =>
      riskScore({
        impact_paise: 38_200_000n,
        action_type: LIGHTEST,
        absent_evidence_source_count,
      }),
    );
    expect([...byAbsent].sort((a, b) => a - b)).toEqual(byAbsent);
  });

  it('reaches exactly 100 at the maximum of all three terms, without clamping', () => {
    const breakdown = riskScoreBreakdown({
      impact_paise: 1_000_000_000n,
      action_type: HEAVIEST,
      absent_evidence_source_count: 3,
    });
    expect(breakdown).toEqual({
      magnitude_points: IMPACT_MAX_POINTS,
      action_points: 25,
      evidence_points: EVIDENCE_MAX_POINTS,
      total_points: RISK_SCORE_MAX,
      score: RISK_SCORE_MAX,
      clamped: false,
    });
  });

  it('never scores 0 for a real action type, so nothing auto-executes at threshold 0', () => {
    // The safety default of Requirement 5.15 rests on this: the lightest action type
    // over a zero impact with complete evidence still scores 5.
    for (const action_type of PROPOSAL_ACTION_TYPES) {
      const score = riskScore({
        impact_paise: 0n,
        action_type,
        absent_evidence_source_count: 0,
      });
      expect(score).toBeGreaterThanOrEqual(5);
      expect(isRiskScore(score)).toBe(true);
    }
  });

  it('reads the absent count the gate already computed', () => {
    // ₹3,82,000 sits in the fourth band (40), and the action calls a Razorpay write API (25).
    const proposal = { impact_paise: 38_200_000n, action_type: HEAVIEST };
    expect(riskScoreFromChecks(proposal, { absent_evidence_count: 0 })).toBe(40 + 25);
    expect(riskScoreFromChecks(proposal, { absent_evidence_count: 2 })).toBe(40 + 25 + 10);
  });
});
