/**
 * The FinanceOS_Response_Validator boundary on the wire (task 29.3).
 * Requirements 15.1, 15.8; supports 11.11 and 12.6.
 *
 * The second of design.md's "three places money crosses". The Validator is Python,
 * so `allowed_values_paise` leaves TypeScript as a list of decimal strings and is
 * parsed to `int` on the far side **before any set-membership comparison**.
 *
 * ## Why this list in particular must not be coerced
 *
 * Requirement 11.11 is a zero-tolerance exact match: every monetary token in a
 * Model narrative must equal a member of `allowed_values_paise` exactly, or the
 * whole response is withheld. That test is only meaningful if the allowed set
 * arrived exactly. A coerced double anywhere in the set would silently widen what
 * counts as grounded — a figure the Model invented would match a neighbouring
 * rounded member — or narrow it, withholding a response that was correct. Either
 * way the failure is invisible: the set has the right length, the right shape and
 * the wrong contents.
 *
 * ## `tenant_id` is absent, deliberately
 *
 * design.md's `ResponseValidator.validate` shows a `tenant_id` argument because it
 * describes the in-process interface. On the wire the Tenant comes from the
 * forwarded session and a body-supplied one is rejected as a schema violation
 * rather than ignored (Requirement 12.7, 14.8), so the request schema does not
 * declare it and `z.strictObject` names it if a caller sends it anyway.
 */

import { z } from 'zod';

import { nullablePaiseWire, paiseWireArray } from './paise-schema';

/**
 * Requirement 11.9's payload bound: at most 200 tool values reach the Model, so at
 * most 200 values can be grounded. A larger allowed set would describe figures the
 * Model was never given.
 */
export const MAX_ALLOWED_VALUES = 200;

/** Requirement 11.9's input ceiling, and therefore the narrative ceiling. */
export const MAX_NARRATIVE_CHARS = 100_000;

/** Requirement 11.10 truncates Model output at 8000 characters before release. */
export const MAX_RELEASED_CHARS = 8_000;

/**
 * What an Agent hands the Validator.
 *
 * `allowed_values_paise` is exactly the Financial_Tool outputs supplied to the
 * Model — not a superset, and not a set assembled after the fact.
 */
export const responseValidatorRequestWire = z.strictObject({
  narrative: z.string().min(1).max(MAX_NARRATIVE_CHARS),
  allowed_values_paise: paiseWireArray({ max: MAX_ALLOWED_VALUES }),
  evidence_chain_ids: z.array(z.uuid()).max(MAX_ALLOWED_VALUES),
});

/**
 * design.md's `ValidationResult` on the wire.
 *
 * `parsed_paise` is nullable because a token that could not be normalised to paise
 * at all still has to be reported — the figure text is what a reviewer needs, and
 * `null` states that no paise value was recoverable from it. It is a decimal string
 * whenever it is present, so the withheld figure is reported at the same precision
 * it was compared at.
 */
export const validationResultWire = z.union([
  z.strictObject({ ok: z.literal(true), released: z.string().max(MAX_RELEASED_CHARS) }),
  z.strictObject({
    ok: z.literal(false),
    kind: z.literal('ungrounded_figure'),
    figure_text: z.string().min(1).max(200),
    parsed_paise: nullablePaiseWire,
  }),
  z.strictObject({
    ok: z.literal(false),
    kind: z.literal('unresolved_evidence_chain'),
    evidence_chain_id: z.uuid(),
  }),
]);

export type ResponseValidatorRequestWire = z.infer<typeof responseValidatorRequestWire>;
export type ValidationResultWire = z.infer<typeof validationResultWire>;
