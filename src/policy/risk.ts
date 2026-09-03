/**
 * The Proposal risk score (task 22.2, first half).
 * Requirement 5.15, with 5.4 requiring the score be returned and 5.6/5.7 comparing it.
 *
 * Three inputs and nothing else, exactly as Requirement 5.15 fixes them: the
 * **absolute INR impact** of the Proposal, the **Proposal action type**, and the
 * **count of absent Evidence_Chain Source_Records**. The output is an integer 0..100.
 * The gate itself is `./checks.ts`; the decision that orders this score against the
 * Auto_Execute_Threshold is `./decide.ts`. This module computes a number and does
 * nothing else — no clock, no I/O, no database, no decision.
 *
 * ## The tables are transcribed, not invented
 *
 * design.md's "Risk score and the Safe_Action / Sensitive_Action / block decision"
 * section states every constant below, and they are copied across value for value:
 * five band ceilings with an ancillary maximum, three action types, 5 points per
 * absent Source_Record capped at 15, and a `Math.min(100, ...)` clamp. Nothing here
 * is tuned. Where a reading was needed rather than a transcription it is recorded in
 * the FINDINGS list.
 *
 * | Input | Points |
 * |---|---|
 * | impact below ₹1,000 / ₹10,000 / ₹1,00,000 / ₹10,00,000 / ₹1,00,00,000 | 0 / 10 / 25 / 40 / 52 |
 * | impact at or above ₹1,00,00,000 | 60 |
 * | `mark_exception_resolved` / `post_reconciliation_adjustment` / `initiate_payment_retry` | 5 / 15 / 25 |
 * | each absent Evidence_Chain Source_Record | 5, capped at 15 |
 *
 * The maximum is `60 + 25 + 15 = 100`, so {@link RISK_SCORE_MAX}'s clamp is a guard
 * against a future constant change rather than a routine path — a distinction worth
 * keeping, because a clamp that fires routinely hides the band it fired on.
 *
 * ## Monotonicity is the property that makes the score explainable
 *
 * The score is **monotone non-decreasing in each input independently**: a larger
 * absolute impact never lowers it, a heavier action type never lowers it, and one
 * more absent Source_Record never lowers it. design.md states it and
 * `docs/14_ACCEPTANCE_CRITERIA.md` makes it a merge-gated unit assertion. Two
 * consequences are enforced below rather than hoped for:
 *
 * - the band points ascend with the ceilings, and {@link IMPACT_BANDS} is asserted
 *   ascending by {@link assertImpactBandsAscending} at module load, so a mistyped
 *   constant fails immediately instead of quietly making a bigger impact safer;
 * - a **negative** absent count is refused rather than absorbed. `-1 * 5 = -5` would
 *   subtract from the score, which is monotonicity broken in the direction that
 *   auto-executes something it should not.
 *
 * ## Sign, and why the absolute value cannot overflow
 *
 * Requirement 5.15 says *absolute* INR impact, so a shortfall and an excess of the
 * same magnitude score identically — the risk of an action is its size, not its
 * direction. The magnitude is taken on `bigint` (`impact < 0n ? -impact : impact`),
 * never through `Math.abs`, and `impact_paise` is range-checked first by
 * `assertInRange`. That check is what makes the negation safe: `PAISE_MIN` is
 * `-99999999999999n` and `PAISE_MAX` is `99999999999999n`, so the range is symmetric
 * and no in-range value negates out of range. `Number(...)`, `toFixed` and
 * `Intl.NumberFormat` appear nowhere on this path (Requirement 15.1, 15.8).
 *
 * The score itself is a plain `number`. It is an ordinal 0..100 — `proposals.
 * risk_score` is `SMALLINT CHECK (risk_score BETWEEN 0 AND 100)` — and not money, so
 * the `Paise` discipline does not apply to it. `eslint.config.mjs` says the same in
 * its `MONEY_DIRS` comment for `src/policy`.
 *
 * ## FINDINGS — reported, not silently patched
 *
 * 1. **`post_reversal` is not a Proposal action type.** design.md's `ACTION_POINTS`
 *    is keyed by `ProposalActionType`, which is the three write-capable tools of its
 *    Financial_Tool catalogue — `mark_exception_resolved`,
 *    `post_reconciliation_adjustment`, `initiate_payment_retry`. Both existing
 *    fixtures use `post_reversal` instead: `test/db/proposals-authorizations.test.ts`
 *    inserts it as `proposals.action_type`, and `src/policy/checks.test.ts` builds
 *    every submission with it. `proposals.action_type` is `TEXT` with no CHECK, so
 *    the database accepts it and only this module notices. An unlisted action type
 *    has **no** points, so the score cannot be computed at all:
 *    {@link actionTypePoints} throws {@link RiskScoreError} rather than scoring it as
 *    0 (which would auto-execute an unknown action at the default threshold) or as
 *    the maximum (which would silently invent a policy). The caller's response is to
 *    submit `risk_score: null`, which fails the risk threshold Policy_Check and
 *    yields `block` — the safe direction. Whoever owns those fixtures should move
 *    them onto a real action type, or a CHECK constraint should be added to
 *    `proposals.action_type`; both are outside this task.
 * 2. **design.md writes the crore ceiling as `1000_000_000n`.** Read as a number that
 *    is 1,000,000,000 paise = ₹1,00,00,000, which matches its own comment and task
 *    22.3's boundary list, so the grouping is a typo in the digit separators and not
 *    a different value. Transcribed here as `1_000_000_000n`.
 * 3. **The bands are half-open, and the requirements do not say so.** design.md's
 *    `find(b => magnitude < b.ceiling_paise)` makes each ceiling **exclusive**, so
 *    exactly ₹1,000 scores 10 rather than 0 and exactly ₹1,00,00,000 scores 60. The
 *    boundary therefore belongs to the *higher* band. That is the conservative
 *    reading — a Proposal exactly on a boundary is treated as the larger one — and
 *    task 22.3 pins all five boundaries because a `<=` written for a `<` shifts every
 *    one of them by a paisa.
 * 4. **Nothing states what an absent count above 3 means.** 5 points each capped at
 *    15 means counts of 3, 4 and 400 all score 15; the cap is design.md's, and the
 *    saturation is deliberate. Note the interaction with the gate: any absent count
 *    above 0 already fails the transaction evidence Policy_Check (Requirement 12.2),
 *    so a Proposal whose evidence points are non-zero is blocked regardless of its
 *    score. The evidence term therefore only ever changes the number a User is shown
 *    on a blocked Proposal, never a decision — which is exactly why the score must
 *    still be computed and returned on the block path (Requirement 5.4).
 */

import { assertInRange, type Paise } from '@/calc/paise';

import type { PolicyChecksOutcome, ProposalUnderReview } from './checks';

/** Thrown when the risk score cannot be computed from the inputs given. */
export class RiskScoreError extends Error {
  override readonly name = 'RiskScoreError';
}

/* -------------------------------------------------------------------------- */
/* The score's range                                                          */
/* -------------------------------------------------------------------------- */

/** Requirement 5.15's floor. Also `proposals.risk_score`'s CHECK lower bound. */
export const RISK_SCORE_MIN = 0;

/** Requirement 5.15's ceiling. Also `proposals.risk_score`'s CHECK upper bound. */
export const RISK_SCORE_MAX = 100;

/** True for an integer in `0..100`: a risk score, or an Auto_Execute_Threshold. */
export function isRiskScore(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= RISK_SCORE_MIN &&
    value <= RISK_SCORE_MAX
  );
}

/* -------------------------------------------------------------------------- */
/* Input 1 of 3: the absolute INR impact                                      */
/* -------------------------------------------------------------------------- */

/** One impact band: every magnitude strictly below `ceiling_paise` scores `points`. */
export interface ImpactBand {
  /** **Exclusive.** See FINDING 3 — a magnitude exactly here falls in the next band. */
  readonly ceiling_paise: Paise;
  readonly points: number;
}

/**
 * design.md's five bands, in ascending ceiling order. The comments are the rupee
 * boundaries task 22.3 tests: ₹1,000, ₹10,000, ₹1,00,000, ₹10,00,000, ₹1,00,00,000.
 */
export const IMPACT_BANDS: readonly ImpactBand[] = [
  { ceiling_paise: 100_000n, points: 0 }, //         below ₹1,000
  { ceiling_paise: 1_000_000n, points: 10 }, //      below ₹10,000
  { ceiling_paise: 10_000_000n, points: 25 }, //     below ₹1,00,000
  { ceiling_paise: 100_000_000n, points: 40 }, //    below ₹10,00,000
  { ceiling_paise: 1_000_000_000n, points: 52 }, //  below ₹1,00,00,000 (FINDING 2)
];

/** Points for a magnitude at or above the last band's ceiling. */
export const IMPACT_MAX_POINTS = 60;

/**
 * Monotonicity, checked at module load rather than trusted: both ceilings and points
 * must ascend strictly, and the last band's points must sit below
 * {@link IMPACT_MAX_POINTS}. A constant edited into the wrong order would make a
 * larger impact score lower, which is the one thing the score promises never to do.
 */
function assertImpactBandsAscending(): void {
  for (const [position, band] of IMPACT_BANDS.entries()) {
    const previous = IMPACT_BANDS[position - 1];
    if (previous !== undefined) {
      if (band.ceiling_paise <= previous.ceiling_paise || band.points <= previous.points) {
        throw new RiskScoreError(
          `IMPACT_BANDS[${position}] does not ascend: a larger absolute impact must never ` +
            `score lower (Requirement 5.15, design.md's monotonicity)`,
        );
      }
    }
    if (!Number.isInteger(band.points) || band.points < RISK_SCORE_MIN) {
      throw new RiskScoreError(`IMPACT_BANDS[${position}].points must be a non-negative integer`);
    }
  }
  const last = IMPACT_BANDS[IMPACT_BANDS.length - 1];
  if (last !== undefined && last.points >= IMPACT_MAX_POINTS) {
    throw new RiskScoreError(
      'IMPACT_MAX_POINTS must exceed the highest band, or the top band would score lower than ' +
        'the band below it',
    );
  }
}

assertImpactBandsAscending();

/**
 * Points for the Proposal's **absolute** impact (Requirement 5.15).
 *
 * @throws {PaiseTypeError} for an impact that is not a `bigint`.
 * @throws {PaiseRangeError} for an impact outside the signed paise range — the check
 * that also makes the negation below safe. See the module doc comment.
 */
export function impactPointsFor(impactPaise: Paise): number {
  assertInRange(impactPaise);
  const magnitude = impactPaise < 0n ? -impactPaise : impactPaise;
  return IMPACT_BANDS.find((band) => magnitude < band.ceiling_paise)?.points ?? IMPACT_MAX_POINTS;
}

/* -------------------------------------------------------------------------- */
/* Input 2 of 3: the Proposal action type                                     */
/* -------------------------------------------------------------------------- */

/**
 * The 3 Proposal action types, which are design.md's 3 write-capable Financial_Tools
 * — the only tools that change Tenant state, so the only things a Proposal can
 * propose. First transcription in the TypeScript runtime; `test/contract/
 * tool-contract.ts` holds the same three names as tool entries.
 *
 * See FINDING 1 for `post_reversal`, which is in two fixtures and is not one of them.
 */
export const PROPOSAL_ACTION_TYPES = [
  'mark_exception_resolved',
  'post_reconciliation_adjustment',
  'initiate_payment_retry',
] as const;

export type ProposalActionType = (typeof PROPOSAL_ACTION_TYPES)[number];

/** True for one of the 3 {@link PROPOSAL_ACTION_TYPES} labels. */
export function isProposalActionType(value: unknown): value is ProposalActionType {
  return typeof value === 'string' && (PROPOSAL_ACTION_TYPES as readonly string[]).includes(value);
}

/**
 * design.md's action points, with its reasoning kept: the scale is *what the action
 * touches*, not how much it is worth — the amount is already the impact term.
 */
export const ACTION_POINTS: Readonly<Record<ProposalActionType, number>> = Object.freeze({
  mark_exception_resolved: 5, //         no money moves, no ledger write
  post_reconciliation_adjustment: 15, // writes the ledger, reversible
  initiate_payment_retry: 25, //         calls a Razorpay write API
});

/**
 * Points for the Proposal's action type.
 *
 * @throws {RiskScoreError} for an action type outside {@link PROPOSAL_ACTION_TYPES}.
 * An unlisted action type has no points, so refusing is the only answer that neither
 * invents a policy nor scores an unknown action as harmless — see FINDING 1.
 */
export function actionTypePoints(actionType: string): number {
  if (!isProposalActionType(actionType)) {
    throw new RiskScoreError(
      `${JSON.stringify(actionType)} is not a Proposal action type, so it carries no risk ` +
        `points and the score of Requirement 5.15 cannot be computed; the 3 action types are ` +
        `${PROPOSAL_ACTION_TYPES.join(', ')}. Scoring an unknown action as 0 would auto-execute ` +
        `it at the default Auto_Execute_Threshold of 0`,
    );
  }
  return ACTION_POINTS[actionType];
}

/* -------------------------------------------------------------------------- */
/* Input 3 of 3: the count of absent Evidence_Chain Source_Records            */
/* -------------------------------------------------------------------------- */

/** Points per target Source_Record the Evidence_Chain does not cite. */
export const EVIDENCE_POINTS_PER_ABSENT = 5;

/** The cap on the evidence term. Reached at 3 absent records. */
export const EVIDENCE_MAX_POINTS = 15;

/**
 * Points for the count of absent Evidence_Chain Source_Records (Requirement 5.15),
 * saturating at {@link EVIDENCE_MAX_POINTS}. See FINDING 4 on the cap.
 *
 * @throws {RiskScoreError} for a non-integer or negative count. A negative count
 * would *subtract* from the score, breaking the monotonicity the score promises.
 */
export function absentEvidencePoints(absentCount: number): number {
  if (!Number.isInteger(absentCount) || absentCount < 0) {
    throw new RiskScoreError(
      `the count of absent Evidence_Chain Source_Records must be a non-negative integer, got ` +
        `${JSON.stringify(absentCount)}; a negative count would lower the risk score, and the ` +
        `score is monotone non-decreasing in each of its 3 inputs`,
    );
  }
  return Math.min(EVIDENCE_MAX_POINTS, absentCount * EVIDENCE_POINTS_PER_ABSENT);
}

/* -------------------------------------------------------------------------- */
/* The score                                                                  */
/* -------------------------------------------------------------------------- */

/** Requirement 5.15's three inputs, and nothing else. */
export interface RiskScoreInput {
  /** `proposals.impact_paise`. Signed; the score uses its absolute value. */
  readonly impact_paise: Paise;
  /** `proposals.action_type`. One of {@link PROPOSAL_ACTION_TYPES}. */
  readonly action_type: string;
  /** Target Source_Records the Evidence_Chain does not cite. */
  readonly absent_evidence_source_count: number;
}

/**
 * The score with its three terms shown separately, so "why is this 65?" has an
 * answer on the Proposal row rather than in this file (`docs/08_UI_UX_SPEC.md`
 * renders the score beside the threshold used).
 *
 * `magnitude_points` rather than `impact_points`: the money-name lint rule of
 * `eslint.config.mjs` fires on a `number`-typed field whose name reads as money, and
 * it is right to — a reader seeing `impact_points` beside `impact_paise` could
 * reasonably take it for an amount. It is an ordinal.
 */
export interface RiskScoreBreakdown {
  readonly magnitude_points: number;
  readonly action_points: number;
  readonly evidence_points: number;
  /** The three terms summed, before the {@link RISK_SCORE_MAX} clamp. */
  readonly total_points: number;
  /** The clamped score. Integer {@link RISK_SCORE_MIN}..{@link RISK_SCORE_MAX}. */
  readonly score: number;
  /** True when the clamp changed the total. Not a routine path — see the doc comment. */
  readonly clamped: boolean;
}

/** The score and its three terms. Pure. */
export function riskScoreBreakdown(input: RiskScoreInput): RiskScoreBreakdown {
  const magnitude_points = impactPointsFor(input.impact_paise);
  const action_points = actionTypePoints(input.action_type);
  const evidence_points = absentEvidencePoints(input.absent_evidence_source_count);
  const total_points = magnitude_points + action_points + evidence_points;
  const score = Math.min(RISK_SCORE_MAX, total_points);
  return {
    magnitude_points,
    action_points,
    evidence_points,
    total_points,
    score,
    clamped: score !== total_points,
  };
}

/**
 * The Proposal risk score: an integer 0..100 from the absolute INR impact, the action
 * type and the count of absent Evidence_Chain Source_Records (Requirement 5.15).
 *
 * Pure, synchronous, and deterministic — the same three inputs always give the same
 * score, which is what lets `proposals.risk_score` be re-derived on a resubmission
 * (Requirement 5.9) and compared against what was persisted.
 *
 * @throws {RiskScoreError} for an unlisted action type or a negative absent count.
 * @throws {PaiseTypeError | PaiseRangeError} for an impact that is not in-range paise.
 */
export function riskScore(input: RiskScoreInput): number {
  return riskScoreBreakdown(input).score;
}

/**
 * The score for a Proposal whose six Policy_Checks have already been evaluated.
 *
 * Reads `absent_evidence_count` from the outcome `./checks.ts` returns, so the absent
 * Source_Records are counted **once**, by the transaction evidence check that already
 * had to compute them, rather than derived again from a second read of the
 * Evidence_Chain. Two reads could disagree, and the one shown to the User would then
 * not be the one the gate acted on.
 */
export function riskScoreFromChecks(
  proposal: Pick<ProposalUnderReview, 'impact_paise' | 'action_type'>,
  outcome: Pick<PolicyChecksOutcome, 'absent_evidence_count'>,
): number {
  return riskScore({
    impact_paise: proposal.impact_paise,
    action_type: proposal.action_type,
    absent_evidence_source_count: outcome.absent_evidence_count,
  });
}
