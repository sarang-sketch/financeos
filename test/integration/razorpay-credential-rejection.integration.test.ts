/**
 * A **live** Razorpay credential rejection (task 6.5, CI stage 11).
 *
 * This is the one scenario of task 6.5's four that needs no valid Razorpay credential, and
 * that is why it is in its own file: a 401 requires only a syntactically well-formed key
 * that belongs to no account, so this suite runs on any machine with egress to
 * `api.razorpay.com` and a Supabase local instance — no Razorpay account at all. Everything
 * asserted below therefore comes from a real HTTP 401 produced by Razorpay, classified by
 * the real `createRazorpayClient`, driven through the real `createIngestionService`, against
 * the real schema.
 *
 * What it asserts, all of Requirement 1.10 plus the parts of 1.6 and 14.5 that hang off it:
 *
 * - the run ends `failed` with `failure_kind = 'credential_rejected'` and an end timestamp;
 * - **zero** Razorpay objects are stored for that run;
 * - an object stored by an earlier run is left byte-identical, compared as
 *   `md5(razorpay_objects::text)` of the whole row, so a change to the payload, to
 *   `retrieved_at`, to `ingestion_run_id` or to any projection would fail it;
 * - the rejection is **not** retried, so the run makes one request and stops — Requirement
 *   1.5 retries rate limits and timeouts only, and re-presenting a rejected key is how an
 *   account gets locked;
 * - the fabricated key's sentinel appears in no failure detail, no run snapshot, no stored
 *   error row and no log line (Requirement 14.5).
 *
 * The prior object is stored by a scripted, offline transport. Only the rejected run talks
 * to Razorpay, and it sends exactly two requests: the run's first page, and one direct
 * `fetchPages` call so the failure object itself can be inspected for `httpStatus`,
 * `retryCount` and `abortsRun`, which `ingestion_errors` has no column for.
 *
 * Requirements: 1.4, 1.6, 1.10, 14.5.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createIngestionService,
  type IngestionRun,
} from '@/ingestion/ingestion-service';
import {
  createRazorpayClient,
  type CredentialRejectedFailure,
  type IngestedObjectType,
  type RazorpayClient,
  type RazorpayFetchResult,
  type RazorpayObject,
  type TimeWindow,
} from '@/ingestion/razorpay-client';
import { announceIfUnreachable, database, newFixture, provision, runOk } from '../db/pg';
import {
  announceIfNoCredential,
  captureLogs,
  cleanUp,
  fabricatedBadCredential,
  note,
  objectCountForRun,
  psqlIngestionStore,
  razorpayApiReachable,
  SENTINEL,
  storedErrors,
  storedRow,
  storedRun,
  type ApiReachability,
} from './razorpay';

const f = newFixture();
const dbReachable = database().reachable;

announceIfUnreachable();
announceIfNoCredential();

/* -------------------------------------------------------------------------- */
/* The prior object, stored by an offline scripted transport                  */
/* -------------------------------------------------------------------------- */

const PRIOR_ID = 'pay_integration_prior';
const PRIOR_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();

const PRIOR_PAYLOAD: RazorpayObject = Object.freeze({
  id: PRIOR_ID,
  entity: 'payment',
  created_at: Math.floor((Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000),
  amount: 150_000,
  fee: 3_540,
  tax: 540,
  currency: 'INR',
  status: 'captured',
  notes: { source: 'task-6.5 integration prior object' },
});

/** Yields one page of payments and nothing for the other eight types. No network. */
function scriptedClient(objects: readonly RazorpayObject[]): RazorpayClient {
  return {
    fetchPages(type: IngestedObjectType) {
      const page: RazorpayFetchResult = {
        kind: 'page',
        objectType: type,
        pageIndex: 0,
        objects: type === 'payment' ? objects : [],
        windowApplied: true,
      };
      return {
        async *[Symbol.asyncIterator]() {
          yield page;
        },
      };
    },
  };
}

const WINDOW: TimeWindow = {
  from: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
  to: new Date(),
};

/* -------------------------------------------------------------------------- */
/* State the suite collects once                                              */
/* -------------------------------------------------------------------------- */

let api: ApiReachability = { reachable: false, reason: 'not probed', status: null };
let priorRunId = '';
let priorFingerprint = '';
let priorRetrievedAt = '';
let rejected: IngestionRun | null = null;
let directFailure: CredentialRejectedFailure | null = null;
let liveRequests = 0;
let logLines: readonly string[] = [];

describe.skipIf(!dbReachable)('a live Razorpay credential rejection', () => {
  beforeAll(async () => {
    runOk(provision(f));

    // Run 1, offline: one payment, so there is a prior object to leave untouched.
    const first = await createIngestionService({
      store: psqlIngestionStore(f),
      client: scriptedClient([PRIOR_PAYLOAD]),
      now: () => new Date(PRIOR_AT),
    }).startRun(f.tenantId, f.userId);
    priorRunId = first.id;
    const before = storedRow(f, PRIOR_ID);
    priorFingerprint = before.md5;
    priorRetrievedAt = before.retrieved_at;

    api = await razorpayApiReachable();
    if (!api.reachable) {
      note(`SKIPPING the live rejection cases - ${api.reason}`);
      return;
    }

    // Run 2, live: a fabricated key that belongs to no account. Every default is the
    // production one — the real `fetch`, the real 30 s timer, the real backoff — because
    // the point is what the shipped transport does with a real 401.
    const capture = captureLogs();
    try {
      const client = createRazorpayClient({
        credential: fabricatedBadCredential(),
        fetch: async (input, init) => {
          liveRequests += 1;
          return fetch(input, init);
        },
      });
      rejected = await createIngestionService({
        store: psqlIngestionStore(f),
        client,
      }).startRun(f.tenantId, f.userId);

      for await (const result of client.fetchPages('payment', WINDOW)) {
        if (result.kind === 'credential_rejected') {
          directFailure = result.failure;
        }
      }
    } finally {
      capture.stop();
      logLines = capture.lines;
    }
  }, 180_000);

  afterAll(() => {
    if (dbReachable) {
      cleanUp(f);
    }
  });

  it('classifies a real Razorpay 401 as a terminal credential rejection', (ctx) => {
    if (!api.reachable) {
      ctx.skip(api.reason);
      return;
    }
    expect(directFailure).not.toBeNull();
    const failure = directFailure as CredentialRejectedFailure;
    expect(failure.category).toBe('credential_rejected');
    // `abortsRun: true` is what makes handing this to the record-and-continue path of
    // Requirement 1.4 a compile error rather than a review comment.
    expect(failure.abortsRun).toBe(true);
    expect(failure.httpStatus).toBe(401);
    // Requirement 1.5 retries rate limits and timeouts only.
    expect(failure.retryCount).toBe(0);
    expect(failure.objectType).toBe('payment');
    expect(failure.errorCode.length).toBeGreaterThan(0);
    note(`live 401 error code: ${failure.errorCode}; detail: ${failure.detail}`);
  });

  it('stops the run without requesting further object types', (ctx) => {
    if (!api.reachable) {
      ctx.skip(api.reason);
      return;
    }
    // One page request for the run, plus the one direct inspection call above. Nine object
    // types would be nine or more requests, and a retried rejection would be six.
    expect(liveRequests).toBe(2);
  });

  it('records the run as failed with the credential cause and an end timestamp', (ctx) => {
    if (!api.reachable) {
      ctx.skip(api.reason);
      return;
    }
    const run = rejected as IngestionRun;
    expect(run.status).toBe('failed');
    expect(run.failure_kind).toBe('credential_rejected');

    const stored = storedRun(f, run.id);
    expect(stored.status).toBe('failed');
    expect(stored.failure_kind).toBe('credential_rejected');
    expect(stored.ended_at).not.toBeNull();
    expect(stored.per_type_stored.payment).toBe(0);
    expect(stored.per_type_errors).toBe(1);

    expect(storedErrors(f, run.id)).toEqual([
      {
        object_type: 'payment',
        error_code: (directFailure as CredentialRejectedFailure).errorCode,
        error_category: 'credential_rejected',
        retry_count: 0,
      },
    ]);
  });

  it('stores zero Razorpay objects for the rejected run', (ctx) => {
    if (!api.reachable) {
      ctx.skip(api.reason);
      return;
    }
    expect(objectCountForRun(f, (rejected as IngestionRun).id)).toBe(0);
  });

  it('leaves the previously stored object byte-identical', (ctx) => {
    if (!api.reachable) {
      ctx.skip(api.reason);
      return;
    }
    const after = storedRow(f, PRIOR_ID);
    expect(after.md5).toBe(priorFingerprint);
    expect(after.ingestion_run_id).toBe(priorRunId);
    expect(after.retrieved_at).toBe(priorRetrievedAt);
    expect(JSON.parse(after.payload)).toEqual(PRIOR_PAYLOAD);
  });

  it('leaks the rejected credential into no detail, no run, no row and no log line', (ctx) => {
    if (!api.reachable) {
      ctx.skip(api.reason);
      return;
    }
    const failure = directFailure as CredentialRejectedFailure;
    const surfaces = [
      failure.detail,
      JSON.stringify(failure),
      JSON.stringify(rejected),
      JSON.stringify(storedRun(f, (rejected as IngestionRun).id)),
      JSON.stringify(storedErrors(f, (rejected as IngestionRun).id)),
      ...logLines,
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain(SENTINEL);
    }
  });
});
