/**
 * Razorpay test-mode HTTP transport for FinanceOS_Ingestion_Service.
 *
 * This module is **only** the transport: paging, the per-request timeout, the retry
 * schedule, and the classification of a failed request into one of the four categories
 * `ingestion_errors.error_category` accepts. It opens no database connection, writes no
 * `ingestion_runs` or `ingestion_errors` row, publishes nothing over Realtime, and holds
 * no run state. Deciding what to store, what to record, and when a run terminates is
 * task 6.2, which drives this client.
 *
 * ## The three behaviours that have to be exact
 *
 * 1. **Paging.** {@link RAZORPAY_PAGE_SIZE} records per request, and a page that returns
 *    **fewer than** 100 is the terminal signal for that object type (Requirement 1.1). A
 *    page of exactly 100 is always followed by another request, even when the next page
 *    comes back empty. "Stop when the page is empty" would be a different rule and would
 *    silently drop objects on the boundary.
 * 2. **Timeout.** {@link RAZORPAY_REQUEST_TIMEOUT_MS} applies to each **request**, not to
 *    an object type and not to a run (Requirement 1.1). The timer aborts the in-flight
 *    request through an `AbortController` rather than abandoning a promise, and it stays
 *    armed until the response body has been read: a response whose headers arrive in 2 s
 *    and whose body stalls has still exceeded the 30 s bound.
 * 3. **Retries.** {@link RAZORPAY_RETRY_DELAYS_MS} is the schedule, exported as a
 *    constant so a test asserts the literal sequence rather than re-deriving `2 ** n`.
 *    Five delays, so at most five retries and six attempts (Requirement 1.5). Only
 *    `rate_limit` and `timeout` are retried. `provider_error` is not: Requirement 1.4
 *    records it and moves to the next object type. `credential_rejected` is not, and
 *    retrying it would be actively harmful — repeatedly presenting a rejected key is how
 *    an account gets locked.
 *
 * ## Why failures are yielded rather than thrown
 *
 * design.md types this method `AsyncIterable<RazorpayObject[]>`. That shape is preserved
 * inside the {@link RazorpayFetchResult} `page` variant, but a bare `AsyncIterable` of
 * arrays has nowhere to put a failure except a thrown `Error`, and a thrown `Error` erases
 * the one distinction this transport exists to make: Requirement 1.4 records the failure
 * and continues with the remaining object types, while Requirement 1.10 aborts the run,
 * stores **zero** objects, and leaves every previously stored object byte-identical. A
 * caller can forget a `catch` branch; a caller cannot forget a union member it has to
 * discriminate. So the iterable yields a three-way union, and
 * {@link CredentialRejectedFailure} carries `abortsRun: true` against
 * {@link RecordableRazorpayFailure}'s `abortsRun?: undefined`, which makes passing a
 * credential rejection to a function that records-and-continues a compile error rather
 * than a review comment.
 *
 * ## Credentials
 *
 * The key id and key secret arrive as {@link Secret} values, so neither can reach a log
 * line, an error message, a thrown object or `JSON.stringify` output without an explicit
 * `.reveal()` (Requirement 14.5). There are exactly two `.reveal()` calls in this file,
 * both inside {@link basicAuthorization}, and the header value they build is never stored
 * on an object, returned, or included in a failure. Any provider text this module
 * propagates goes through `redactSecrets`, which matches on credential **value**, so a
 * provider that echoes the key id back in an error message cannot leak it either.
 *
 * ## Money
 *
 * Nothing here parses, scales, rounds or truncates a monetary field. The response body is
 * carried through as the parsed payload and stored verbatim by 6.2 (Requirement 1.2, 1.7),
 * and this module surfaces no `amount`, `fee` or `tax` projection at all — the projections
 * on `razorpay_objects` are 6.2's, so there is no code path here that could scale a value.
 */

import { redactSecrets, type Secret } from '@/config/env';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Records requested per page, and the threshold a short page is measured against. */
export const RAZORPAY_PAGE_SIZE = 100;

/** The per-request timeout, in milliseconds (Requirement 1.1). */
export const RAZORPAY_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The retry backoff schedule, in milliseconds: 1 s, 2 s, 4 s, 8 s, 16 s
 * (Requirement 1.5).
 *
 * Written out rather than computed. A test asserts this exact array, so a future change
 * to the doubling rule or the 16 s ceiling has to be made here, deliberately, instead of
 * emerging from an arithmetic expression.
 */
export const RAZORPAY_RETRY_DELAYS_MS: readonly number[] = Object.freeze([
  1_000, 2_000, 4_000, 8_000, 16_000,
]);

/** At most 5 retries per request, so at most 6 attempts (Requirement 1.5). */
export const RAZORPAY_MAX_RETRIES = RAZORPAY_RETRY_DELAYS_MS.length;

/** Razorpay's production host. Test mode is selected by the key, not by the host. */
export const RAZORPAY_BASE_URL = 'https://api.razorpay.com';

/** Bound on propagated provider text, so one error cannot carry an unbounded body. */
const DETAIL_LIMIT = 500;

/* -------------------------------------------------------------------------- */
/* Object types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every label in the `razorpay_object_type` enum
 * (`supabase/migrations/20260101000002_ingestion.sql`), in enum order.
 */
export const RAZORPAY_OBJECT_TYPES = [
  'payment',
  'order',
  'refund',
  'settlement',
  'settlement_recon_report',
  'transfer',
  'transfer_reversal',
  'razorpay_invoice',
  'linked_account',
  'credit_note',
] as const;

export type RazorpayObjectType = (typeof RAZORPAY_OBJECT_TYPES)[number];

/**
 * The **nine** object types ingestion retrieves from the Razorpay API
 * (Requirement 1.1): Payments, Refunds, Settlements, Settlement_Recon_Reports,
 * Transfers, Transfer_Reversals, Orders, Razorpay_Invoices, Linked_Accounts.
 *
 * The enum has ten labels. The tenth, `credit_note`, is **not** an ingestion type and its
 * absence here is deliberate: Requirement 1.1 does not list it, and the migration says so
 * outright — "plus credit_note, which the compliance detectors read". So the enum is the
 * storage vocabulary for every Razorpay-shaped object the system holds, and this list is
 * the subset the ingestion transport requests. Task 6.2's text says "all nine object
 * types", which agrees with Requirement 1.1; the ten-versus-nine gap is `credit_note`
 * arriving from the compliance path rather than from a paged Razorpay list request.
 */
export const INGESTED_OBJECT_TYPES = [
  'payment',
  'order',
  'refund',
  'settlement',
  'settlement_recon_report',
  'transfer',
  'transfer_reversal',
  'razorpay_invoice',
  'linked_account',
] as const;

/** An object type the ingestion transport requests. Nine of the enum's ten labels. */
export type IngestedObjectType = (typeof INGESTED_OBJECT_TYPES)[number];

/**
 * One Razorpay object exactly as returned. Deliberately unmodelled beyond "a JSON
 * object": the payload is stored verbatim (Requirement 1.2), and a narrower type here
 * would invite a field-by-field mapping that Requirement 1.2 forbids.
 *
 * The identifier is not projected onto this type on purpose. Most collections key on
 * `id`, but a combined settlement recon report row keys on `entity_id`, so extracting the
 * Razorpay identifier is per-type work and belongs to 6.2, next to the
 * `(tenant_id, razorpay_id)` upsert that consumes it.
 */
export type RazorpayObject = Readonly<Record<string, unknown>>;

/** The retrieval window. `from` and `to` are inclusive instants (Requirement 1.8, 1.9). */
export interface TimeWindow {
  readonly from: Date;
  readonly to: Date;
}

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How one object type is retrieved.
 *
 * `supportsTimeWindow` is the field worth reading twice. Razorpay's payment, order,
 * refund, settlement and invoice collections accept `from` and `to` as Unix seconds; the
 * transfer, reversal, linked-account and recon-report endpoints do not. Sending `from` to
 * an endpoint that does not accept it risks a 400 that would be recorded as a
 * `provider_error` for a reason no operator could diagnose, so the window is applied only
 * where it is supported and every page reports {@link RazorpayPage.windowApplied}. Where
 * it is `false`, the window restriction of Requirement 1.8 and 1.9 has to be applied by
 * the caller against the payload's creation timestamp. That is 6.2's decision to make
 * explicitly, not something this module should hide by dropping records.
 */
export interface RazorpayEndpoint {
  /** Path template. `{parentId}` is substituted from {@link FetchOptions.parentId}. */
  readonly path: string;
  /** Whether the collection accepts `from` and `to` as Unix seconds. */
  readonly supportsTimeWindow: boolean;
  /** The parent object whose identifier the path needs, when the collection is nested. */
  readonly parent?: RazorpayObjectType;
  /** Query parameters the endpoint requires and the caller must supply. */
  readonly requiredQuery?: readonly string[];
  /** Why this path, where it is not self-evident. */
  readonly note?: string;
}

/**
 * The object-type to endpoint map. A `Record` over {@link IngestedObjectType}, so adding
 * an ingestion type without stating its endpoint is a compile error.
 *
 * `credit_note` is absent because it is not an ingestion type; see
 * {@link INGESTED_OBJECT_TYPES}.
 */
export const RAZORPAY_ENDPOINTS: Readonly<Record<IngestedObjectType, RazorpayEndpoint>> =
  Object.freeze({
    payment: { path: '/v1/payments', supportsTimeWindow: true },
    order: { path: '/v1/orders', supportsTimeWindow: true },
    refund: { path: '/v1/refunds', supportsTimeWindow: true },
    settlement: { path: '/v1/settlements', supportsTimeWindow: true },
    settlement_recon_report: {
      path: '/v1/settlements/recon/combined',
      supportsTimeWindow: false,
      requiredQuery: ['year', 'month'],
      note:
        'The combined recon report is addressed by year and month, not by a from/to ' +
        'window, so the caller supplies them per request. Task 6.2 walks the months the ' +
        'window covers; a missing year or month is a programming error here, not a ' +
        'provider failure.',
    },
    transfer: {
      path: '/v1/transfers',
      supportsTimeWindow: false,
      note: 'Route transfers page on count and skip only.',
    },
    transfer_reversal: {
      path: '/v1/transfers/{parentId}/reversals',
      supportsTimeWindow: false,
      parent: 'transfer',
      note:
        'Reversals are only addressable under their transfer; Razorpay publishes no ' +
        'account-wide reversal collection. Task 6.2 therefore ingests transfers first ' +
        'and then walks reversals per transfer identifier.',
    },
    razorpay_invoice: { path: '/v1/invoices', supportsTimeWindow: true },
    linked_account: {
      path: '/v1/accounts',
      supportsTimeWindow: false,
      note:
        'The Route linked-account collection. Confirm against Razorpay test mode in ' +
        'task 6.5: the v2 onboarding surface documents fetch-by-id only, so if this path ' +
        'does not list, the request classifies as provider_error and, per Requirement ' +
        '1.4, ingestion continues with the remaining object types rather than failing ' +
        'the run.',
    },
  } satisfies Record<IngestedObjectType, RazorpayEndpoint>);

/* -------------------------------------------------------------------------- */
/* Failures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The four error categories, exactly as `ingestion_errors.error_category`'s CHECK
 * declares them in `supabase/migrations/20260101000002_ingestion.sql`. 6.2 writes these
 * values into that column, so the two lists must stay identical.
 */
export const RAZORPAY_ERROR_CATEGORIES = [
  'rate_limit',
  'timeout',
  'provider_error',
  'credential_rejected',
] as const;

export type RazorpayErrorCategory = (typeof RAZORPAY_ERROR_CATEGORIES)[number];

/** The categories a retry is attempted for (Requirement 1.5). */
export const RETRYABLE_CATEGORIES: readonly RazorpayErrorCategory[] = Object.freeze([
  'rate_limit',
  'timeout',
]);

interface FailureCommon {
  readonly objectType: IngestedObjectType;
  /** `ingestion_errors.error_code`. The provider's code where it gave one. */
  readonly errorCode: string;
  /** The HTTP status, or `null` for a timeout or a transport failure with no response. */
  readonly httpStatus: number | null;
  /** Retries performed, 0 to {@link RAZORPAY_MAX_RETRIES}. Matches the column's CHECK. */
  readonly retryCount: number;
  /** `ingestion_errors.requested_at`: when the final attempt was issued. ISO-8601 UTC. */
  readonly requestedAt: string;
  /** Short, redacted provider text. Never contains a credential value. */
  readonly detail: string;
}

/**
 * A failure that Requirement 1.4 and 1.5 record against the object type, after which
 * ingestion continues with the remaining types.
 *
 * `abortsRun?: undefined` is not decoration. It is what makes
 * `record(failure: RecordableRazorpayFailure)` reject a {@link CredentialRejectedFailure}
 * at compile time, because `abortsRun: true` is not assignable to `undefined`.
 */
export interface RecordableRazorpayFailure extends FailureCommon {
  readonly category: 'rate_limit' | 'timeout' | 'provider_error';
  readonly abortsRun?: undefined;
}

/**
 * A 401 or 403. Terminal for the whole run: no further object types are requested, zero
 * objects are stored for the run, and previously stored objects are left untouched
 * (Requirement 1.10).
 */
export interface CredentialRejectedFailure extends FailureCommon {
  readonly category: 'credential_rejected';
  readonly abortsRun: true;
}

export type RazorpayFailure = RecordableRazorpayFailure | CredentialRejectedFailure;

/** One page of objects. Carries design.md's `RazorpayObject[]`. */
export interface RazorpayPage {
  readonly kind: 'page';
  readonly objectType: IngestedObjectType;
  /** 0-based page number within this object type's traversal. */
  readonly pageIndex: number;
  readonly objects: readonly RazorpayObject[];
  /** Whether `from`/`to` were sent. `false` means the caller must filter the window. */
  readonly windowApplied: boolean;
}

/**
 * What {@link RazorpayClient.fetchPages} yields. Exhaustive `switch` on `kind`: the
 * `credential_rejected` arm is the run-abort path of Requirement 1.10 and the
 * `object_type_failed` arm is the record-and-continue path of Requirement 1.4. Either
 * failure variant is the last thing the iterator yields for that object type.
 */
export type RazorpayFetchResult =
  | RazorpayPage
  | { readonly kind: 'object_type_failed'; readonly failure: RecordableRazorpayFailure }
  | { readonly kind: 'credential_rejected'; readonly failure: CredentialRejectedFailure };

/**
 * Thrown when a call is misconfigured — an unknown object type, a nested collection with
 * no parent identifier, a recon report with no year and month. This is a programming
 * error in the caller, not a provider outcome, so it is not one of the four categories
 * and never reaches `ingestion_errors`.
 */
export class RazorpayRequestConfigurationError extends Error {
  override readonly name = 'RazorpayRequestConfigurationError';
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

/** The Razorpay basic-auth pair. Both halves are credentials; both are masked. */
export interface RazorpayCredential {
  /** The basic-auth username, e.g. a `rzp_test_...` key id. */
  readonly keyId: Secret;
  /** The basic-auth password. */
  readonly keySecret: Secret;
}

/** Per-call shape for the endpoints that need more than a window. */
export interface FetchOptions {
  /** The parent identifier for a nested collection, e.g. the transfer of a reversal. */
  readonly parentId?: string;
  /** Extra query parameters, e.g. `{ year: '2026', month: '1' }` for a recon report. */
  readonly query?: Readonly<Record<string, string>>;
}

export interface RazorpayClientDeps {
  /**
   * The credential pair, resolved per request so a rotation mid-run is picked up and so
   * no plaintext is captured in a closure for the life of the client. Task 6.2 supplies
   * a thunk over `ConfigurationService.readCredentialForServerUse(tenantId,
   * 'razorpay_test')`.
   */
  readonly credential: RazorpayCredential | (() => Promise<RazorpayCredential>);
  /** Injected for tests. Defaults to the platform `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Retry backoff. Injected so a test does not wait 31 s. Defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Arms the per-request timeout and returns a cancel function. Injected rather than
   * using `AbortSignal.timeout` so a test can drive the 30 s bound on a fake clock while
   * the default still aborts a real in-flight request.
   */
  readonly schedule?: (ms: number, onDue: () => void) => () => void;
  /** Clock for `requestedAt`. */
  readonly now?: () => Date;
  readonly baseUrl?: string;
  /** Overridable only so a test can assert what was armed. Defaults to 30 s. */
  readonly timeoutMs?: number;
}

/** The transport. One method: pages of one object type, or a classified failure. */
export interface RazorpayClient {
  fetchPages(
    type: IngestedObjectType,
    window: TimeWindow,
    options?: FetchOptions,
  ): AsyncIterable<RazorpayFetchResult>;
}

/** The outcome of a single HTTP attempt, before the retry decision. */
type Attempt =
  | { readonly kind: 'success'; readonly body: unknown }
  | {
      readonly kind: 'failure';
      readonly category: RazorpayErrorCategory;
      readonly errorCode: string;
      readonly httpStatus: number | null;
      readonly detail: string;
    };

/** Distinguishes our own timeout abort from any other abort or transport error. */
const TIMEOUT_ABORT = 'financeos:razorpay-request-timeout';

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const defaultSchedule = (ms: number, onDue: () => void): (() => void) => {
  const handle = setTimeout(onDue, ms);
  return () => {
    clearTimeout(handle);
  };
};

/**
 * The only place a credential plaintext exists in this module. The returned string is
 * passed straight into the request headers and never stored, returned, or logged.
 */
function basicAuthorization(credential: RazorpayCredential): string {
  const encoded = Buffer.from(
    `${credential.keyId.reveal()}:${credential.keySecret.reveal()}`,
    'utf8',
  ).toString('base64');
  return `Basic ${encoded}`;
}

/** Bounded, credential-scrubbed provider text. */
function safeDetail(text: string): string {
  const redacted = redactSecrets(text).replace(/\s+/g, ' ').trim();
  return redacted.length > DETAIL_LIMIT ? `${redacted.slice(0, DETAIL_LIMIT)}…` : redacted;
}

/**
 * Classify an HTTP status into one of the four categories.
 *
 * - 429 is the documented rate-limit status (Requirement 1.5).
 * - 401 and 403 are both credential rejection (Requirement 1.10). 403 is included
 *   because a key that authenticates but is not permitted the collection is, from
 *   ingestion's point of view, the same fault: presenting it again cannot help.
 * - every other non-2xx is `provider_error` (Requirement 1.4).
 *
 * A timeout has no status and is classified by the abort path, not here.
 */
export function classifyStatus(status: number): RazorpayErrorCategory | 'success' {
  if (status >= 200 && status < 300) {
    return 'success';
  }
  if (status === 401 || status === 403) {
    return 'credential_rejected';
  }
  if (status === 429) {
    return 'rate_limit';
  }
  return 'provider_error';
}

/** Razorpay error bodies carry `{ error: { code, description } }`. Best effort only. */
function providerErrorCode(body: string, status: number): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const error: unknown = (parsed as { error: unknown }).error;
      if (typeof error === 'object' && error !== null && 'code' in error) {
        const code: unknown = (error as { code: unknown }).code;
        if (typeof code === 'string' && code.length > 0) {
          return code;
        }
      }
    }
  } catch {
    // Not JSON, or not the documented shape. The HTTP status is the code then.
  }
  return `HTTP_${status}`;
}

/** `{ entity: 'collection', count, items: [...] }`. Anything else is a provider error. */
function readItems(body: unknown): readonly RazorpayObject[] | null {
  if (typeof body !== 'object' || body === null || !('items' in body)) {
    return null;
  }
  const items: unknown = (body as { items: unknown }).items;
  if (!Array.isArray(items)) {
    return null;
  }
  const out: RazorpayObject[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return null;
    }
    out.push(item as RazorpayObject);
  }
  return out;
}

function epochSeconds(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}

export function createRazorpayClient(deps: RazorpayClientDeps): RazorpayClient {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const schedule = deps.schedule ?? defaultSchedule;
  const clock = deps.now ?? (() => new Date());
  const baseUrl = deps.baseUrl ?? RAZORPAY_BASE_URL;
  const timeoutMs = deps.timeoutMs ?? RAZORPAY_REQUEST_TIMEOUT_MS;

  const resolveCredential = async (): Promise<RazorpayCredential> =>
    typeof deps.credential === 'function' ? await deps.credential() : deps.credential;

  function buildUrl(
    type: IngestedObjectType,
    window: TimeWindow,
    skip: number,
    options: FetchOptions,
  ): string {
    const endpoint = RAZORPAY_ENDPOINTS[type];
    if (endpoint === undefined) {
      throw new RazorpayRequestConfigurationError(
        `'${type}' is not an ingestion object type. Known types: ` +
          `${INGESTED_OBJECT_TYPES.join(', ')}.`,
      );
    }

    let path = endpoint.path;
    if (endpoint.parent !== undefined) {
      const parentId = options.parentId;
      if (parentId === undefined || parentId.length === 0) {
        throw new RazorpayRequestConfigurationError(
          `'${type}' is only addressable under its ${endpoint.parent}; supply ` +
            `options.parentId.`,
        );
      }
      path = path.replace('{parentId}', encodeURIComponent(parentId));
    }

    const url = new URL(path, baseUrl);
    url.searchParams.set('count', String(RAZORPAY_PAGE_SIZE));
    url.searchParams.set('skip', String(skip));

    if (endpoint.supportsTimeWindow) {
      url.searchParams.set('from', String(epochSeconds(window.from)));
      url.searchParams.set('to', String(epochSeconds(window.to)));
    }

    for (const name of endpoint.requiredQuery ?? []) {
      const value = options.query?.[name];
      if (value === undefined || value.length === 0) {
        throw new RazorpayRequestConfigurationError(
          `'${type}' requires the query parameter '${name}'; supply it in options.query.`,
        );
      }
    }
    for (const [name, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(name, value);
    }

    return url.toString();
  }

  /**
   * One attempt. The timeout timer is armed before the request and cancelled only after
   * the body has been read, so a stalled body is a timeout rather than a hang.
   */
  async function attemptOnce(url: string): Promise<Attempt> {
    const credential = await resolveCredential();
    const controller = new AbortController();
    let timedOut = false;
    const cancel = schedule(timeoutMs, () => {
      timedOut = true;
      controller.abort(TIMEOUT_ABORT);
    });

    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          // Built inline and not retained. The header value is never logged.
          authorization: basicAuthorization(credential),
          accept: 'application/json',
        },
        signal: controller.signal,
      });
      const text = await response.text();
      const category = classifyStatus(response.status);

      if (category !== 'success') {
        return {
          kind: 'failure',
          category,
          errorCode: providerErrorCode(text, response.status),
          httpStatus: response.status,
          detail: safeDetail(text),
        };
      }

      try {
        return { kind: 'success', body: JSON.parse(text) as unknown };
      } catch {
        return {
          kind: 'failure',
          category: 'provider_error',
          errorCode: 'MALFORMED_RESPONSE_BODY',
          httpStatus: response.status,
          detail: 'response body is not valid JSON',
        };
      }
    } catch (cause) {
      if (timedOut) {
        return {
          kind: 'failure',
          category: 'timeout',
          errorCode: 'REQUEST_TIMEOUT',
          httpStatus: null,
          detail: `request exceeded the ${timeoutMs} ms per-request timeout and was aborted`,
        };
      }
      // A transport failure is not a rate limit and not a credential rejection, so
      // Requirement 1.4 governs: record it and continue with the remaining types. It is
      // deliberately not retried — Requirement 1.5 retries rate limits and timeouts only.
      return {
        kind: 'failure',
        category: 'provider_error',
        errorCode: 'TRANSPORT_ERROR',
        httpStatus: null,
        detail: safeDetail(cause instanceof Error ? cause.message : String(cause)),
      };
    } finally {
      cancel();
    }
  }

  /** Attempt, then retry per {@link RAZORPAY_RETRY_DELAYS_MS} while retryable. */
  async function attemptWithRetries(
    type: IngestedObjectType,
    url: string,
  ): Promise<
    | { readonly kind: 'success'; readonly body: unknown }
    | { readonly kind: 'failure'; readonly failure: RazorpayFailure }
  > {
    for (let retries = 0; ; retries += 1) {
      const requestedAt = clock().toISOString();
      const attempt = await attemptOnce(url);

      if (attempt.kind === 'success') {
        return attempt;
      }

      // The schedule's length is the retry bound: an exhausted schedule is an exhausted
      // retry budget, so the two cannot drift apart (Requirement 1.5).
      const delayMs = retries < RAZORPAY_MAX_RETRIES ? RAZORPAY_RETRY_DELAYS_MS[retries] : undefined;
      if (RETRYABLE_CATEGORIES.includes(attempt.category) && delayMs !== undefined) {
        await sleep(delayMs);
        continue;
      }

      const common: FailureCommon = {
        objectType: type,
        errorCode: attempt.errorCode,
        httpStatus: attempt.httpStatus,
        retryCount: retries,
        requestedAt,
        detail: attempt.detail,
      };
      const failure: RazorpayFailure =
        attempt.category === 'credential_rejected'
          ? { ...common, category: 'credential_rejected', abortsRun: true }
          : { ...common, category: attempt.category };
      return { kind: 'failure', failure };
    }
  }

  return {
    async *fetchPages(type, window, options = {}) {
      const endpoint = RAZORPAY_ENDPOINTS[type];
      let skip = 0;

      for (let pageIndex = 0; ; pageIndex += 1) {
        const url = buildUrl(type, window, skip, options);
        const result = await attemptWithRetries(type, url);

        if (result.kind === 'failure') {
          const { failure } = result;
          if (failure.category === 'credential_rejected') {
            yield { kind: 'credential_rejected', failure };
          } else {
            yield { kind: 'object_type_failed', failure };
          }
          return;
        }

        const objects = readItems(result.body);
        if (objects === null) {
          yield {
            kind: 'object_type_failed',
            failure: {
              objectType: type,
              category: 'provider_error',
              errorCode: 'MALFORMED_COLLECTION',
              httpStatus: 200,
              retryCount: 0,
              requestedAt: clock().toISOString(),
              detail: 'success response carried no items array of objects',
            },
          };
          return;
        }

        yield {
          kind: 'page',
          objectType: type,
          pageIndex,
          objects,
          windowApplied: endpoint.supportsTimeWindow,
        };

        // A short page terminates the traversal; a full page never does, even when the
        // page after it comes back empty (Requirement 1.1).
        if (objects.length < RAZORPAY_PAGE_SIZE) {
          return;
        }
        skip += RAZORPAY_PAGE_SIZE;
      }
    },
  };
}
