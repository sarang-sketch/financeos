/**
 * The two AI_Gateway metering payloads on the wire (task 29.3).
 * Requirements 11.8, 11.13, 15.1, 15.8.
 *
 * The third of design.md's "three places money crosses". The Gateway is Python and
 * holds no database connection and no money arithmetic of its own: it reads the
 * monthly cap through `GET /internal/model-cost-cap` and posts a measurement to
 * `POST /internal/model-requests`, receiving a computed `cost_paise` back. Both
 * endpoints are task 29.6; these are the schemas they are held to.
 *
 * ## The two rejections these schemas carry structurally
 *
 * - **A body-supplied `cost_paise` is rejected, not ignored.** Cost is computed on
 *   the TypeScript side from the per-provider, per-model rate table through
 *   `CalculationService.applyRate`. {@link modelRequestPayloadWire} is
 *   `z.strictObject` and declares no `cost_paise`, so a payload carrying one is an
 *   unrecognised key and the rejection names it. A Gateway that priced its own
 *   measurement would be doing money arithmetic in the runtime that is not allowed
 *   to, and the failure would show up as a cost figure nobody could reproduce.
 * - **A body-supplied `tenant_id` is rejected the same way** (Requirement 12.7,
 *   14.8). Neither schema declares it; the Tenant comes from the forwarded session.
 *
 * ## `exceeded` is a boolean on the wire, computed with `>=` in TypeScript
 *
 * Requirement 11.13 rejects a request when month-to-date spend has *reached* the
 * cap, so the comparison is `>=` and reaching the cap exactly rejects. The
 * comparison ships as a boolean rather than being re-derived in Python from the two
 * strings: two implementations of one `>=` is one more than the number of places
 * that rule can be got right. The Gateway branches on the flag.
 *
 * The two figures still cross as decimal strings, because the Gateway reports them
 * back to the Agent in the `cost_cap_exceeded` result and a rounded cap would be
 * quoted to a User as fact.
 */

import { z } from 'zod';

import { paiseWire } from './paise-schema';

/* -------------------------------------------------------------------------- */
/* Closed sets, transcribed from design.md's DDL and routing table            */
/* -------------------------------------------------------------------------- */

/** `model_requests.provider`. The three Model_Providers of Requirement 11.2–11.4. */
export const MODEL_PROVIDERS = ['openrouter', 'gemini', 'groq'] as const;

/** `model_requests.task_class`. Agents declare the class; they do not choose the provider. */
export const TASK_CLASSES = [
  'complex_reasoning',
  'document_analysis',
  'fast_classification',
] as const;

/**
 * The failure categories a `ModelProviderAdapter` classifies into (Requirement
 * 11.5, 11.6, 11.7). `rate_limit` and `timeout` are retryable on the same
 * provider; `provider_error` fails over immediately.
 */
export const PROVIDER_FAILURE_KINDS = ['rate_limit', 'timeout', 'provider_error'] as const;

/** Requirement 11.6: at most 3 providers per request. */
export const MAX_PROVIDERS_PER_REQUEST = 3;

/** Requirement 11.5: at most 2 retries per provider, so 3 attempts per provider. */
export const MAX_ATTEMPTS_PER_PROVIDER = 3;

/** The ceiling on the per-attempt failure record list: every provider, every retry. */
export const MAX_ATTEMPT_RECORDS = MAX_PROVIDERS_PER_REQUEST * MAX_ATTEMPTS_PER_PROVIDER;

/** Requirement 11.5's configured timeout ceiling, which bounds any one attempt. */
const MAX_TIMEOUT_MS = 60_000;

/**
 * A whole request's latency: three providers, three attempts each, plus the two
 * retry delays per provider. A ceiling rather than an exact budget — its job is to
 * make the field bounded, not to restate the retry schedule.
 */
const MAX_LATENCY_MS = MAX_ATTEMPT_RECORDS * MAX_TIMEOUT_MS;

/** A generous per-request token ceiling; the field's job is to be bounded, not tight. */
const MAX_TOKENS = 10_000_000;

/* -------------------------------------------------------------------------- */
/* GET /internal/model-cost-cap                                               */
/* -------------------------------------------------------------------------- */

/**
 * The cost-cap response (Requirement 11.13).
 *
 * There is no request schema: the endpoint is a `GET` whose only inputs are the
 * service credential and the forwarded user context, both of which are headers
 * rather than a body. A body carrying a `tenant_id` is rejected by the endpoint
 * (task 29.6) precisely because there is no body shape for it to conform to.
 */
export const modelCostCapResponseWire = z.strictObject({
  cap_paise: paiseWire,
  month_to_date_paise: paiseWire,
  /** `month_to_date_paise >= cap_paise`, computed in TypeScript. */
  exceeded: z.boolean(),
});

/* -------------------------------------------------------------------------- */
/* POST /internal/model-requests                                              */
/* -------------------------------------------------------------------------- */

/** One failed provider attempt: who, why, and how long it took (Requirement 11.7). */
export const providerAttemptWire = z.strictObject({
  provider: z.enum(MODEL_PROVIDERS),
  failure: z.enum(PROVIDER_FAILURE_KINDS),
  elapsed_ms: z.number().int().nonnegative().max(MAX_LATENCY_MS),
});

/**
 * What the Gateway posts: measurements only.
 *
 * `model` is the **resolved** model name, not the routing label. OpenRouter is
 * itself a gateway, so recording the model it resolved to is what keeps cost
 * attribution accurate rather than collapsing every OpenRouter call into one line.
 *
 * `outcome` uses design.md's endpoint literals `success` and `provider_unavailable`.
 * **design.md gap, reported rather than patched:** the `model_requests` DDL spells
 * the first `succeeded` and admits a third value, `cost_cap_exceeded`, that this
 * payload cannot express — a capped request never reaches a provider, so the
 * Gateway has no measurement to post. Task 29.6 owns the label mapping and the
 * `cost_cap_exceeded` row; this schema stays with the endpoint contract it is the
 * wire form of.
 */
export const modelRequestPayloadWire = z.strictObject({
  provider: z.enum(MODEL_PROVIDERS),
  model: z.string().min(1).max(200),
  task_class: z.enum(TASK_CLASSES),
  attempt_count: z.number().int().min(1).max(MAX_PROVIDERS_PER_REQUEST),
  input_tokens: z.number().int().nonnegative().max(MAX_TOKENS),
  output_tokens: z.number().int().nonnegative().max(MAX_TOKENS),
  latency_ms: z.number().int().nonnegative().max(MAX_LATENCY_MS),
  outcome: z.enum(['success', 'provider_unavailable']),
  attempts: z.array(providerAttemptWire).max(MAX_ATTEMPT_RECORDS),
});

/** What comes back: the persisted row's identifier and the price TypeScript computed. */
export const modelRequestResponseWire = z.strictObject({
  model_request_id: z.uuid(),
  cost_paise: paiseWire,
});

export type ModelProviderWire = (typeof MODEL_PROVIDERS)[number];
export type TaskClassWire = (typeof TASK_CLASSES)[number];
export type ModelCostCapResponseWire = z.infer<typeof modelCostCapResponseWire>;
export type ModelRequestPayloadWire = z.infer<typeof modelRequestPayloadWire>;
export type ModelRequestResponseWire = z.infer<typeof modelRequestResponseWire>;
