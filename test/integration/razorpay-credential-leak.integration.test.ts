/**
 * "The credential value appears in no response body, no log line, and no error message"
 * — task 6.5's second bullet, Requirement 14.5 — asserted across the **whole ingestion
 * run**, not just the transport.
 *
 * This is the one part of task 6.5 that needs no Razorpay credential and no network, and
 * that is deliberate: a leak check must not depend on a third party being reachable, and a
 * fabricated sentinel-bearing credential proves more than a real one could. A real key
 * cannot be asserted against — printing it to compare would be the leak.
 *
 * It complements `src/ingestion/razorpay-client.test.ts` rather than repeating it. That
 * file asserts the transport's own surfaces: the request URL, the returned
 * `RazorpayFetchResult`, and the redaction of a provider error body that echoes the key.
 * What this file adds is every surface the *run* creates on top of them — the
 * `IngestionRun` snapshot, the rows handed to `IngestionStore.recordErrors` and
 * `completeRun`, the Realtime event handed to `IngestionRunPublisher`, a thrown
 * configuration error, an own-property serialisation of the kind an error reporter
 * performs, and anything written to `console` or straight to a file descriptor while the
 * run is in flight.
 *
 * The scripted provider is hostile on purpose: it echoes **both halves** of the credential
 * back in its error description, which is the case a value-keyed redaction filter has to
 * catch and a name-keyed one cannot.
 *
 * Requirements: 14.5. Supporting: 1.4, 1.6, 1.10.
 */

import { describe, expect, it } from 'vitest';
import {
  createIngestionService,
  type IngestionError,
  type IngestionRun,
  type IngestionRunEvent,
  type IngestionStore,
  type RazorpayObjectRow,
  type RunCompletion,
} from '@/ingestion/ingestion-service';
import {
  createRazorpayClient,
  RazorpayRequestConfigurationError,
  type RazorpayFetchResult,
  type TimeWindow,
} from '@/ingestion/razorpay-client';
import { captureLogs, fabricatedBadCredential, SENTINEL } from './razorpay';

const TENANT = '3f1c9d5a-2b7e-4a6c-9d81-0e5f4a3b2c1d';
const ACTOR = '7a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d';

const WINDOW: TimeWindow = {
  from: new Date('2026-01-01T00:00:00.000Z'),
  to: new Date('2026-02-01T00:00:00.000Z'),
};

/** Everything the run handed to the storage and Realtime seams. */
interface Recorder {
  readonly store: IngestionStore;
  readonly rows: RazorpayObjectRow[];
  readonly errors: IngestionError[];
  readonly completions: RunCompletion[];
  readonly events: IngestionRunEvent[];
}

function recorder(): Recorder {
  const rows: RazorpayObjectRow[] = [];
  const errors: IngestionError[] = [];
  const completions: RunCompletion[] = [];
  const events: IngestionRunEvent[] = [];
  return {
    rows,
    errors,
    completions,
    events,
    store: {
      async createRun(run) {
        return { id: 'run_leak_probe', startedAt: run.startedAt };
      },
      async upsertObjects(batch) {
        rows.push(...batch);
      },
      async recordErrors(_tenantId, _runId, batch) {
        errors.push(...batch);
      },
      async completeRun(completion) {
        completions.push(completion);
      },
    },
  };
}

/**
 * A provider that answers every request with an error body echoing both halves of the
 * credential. `status` selects the disposition under test: 401 is the run-aborting
 * credential rejection of Requirement 1.10, 400 the record-and-continue provider error of
 * Requirement 1.4.
 */
function echoingFetch(status: number): {
  readonly fetch: typeof globalThis.fetch;
  readonly urls: string[];
} {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (input) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          error: {
            code: 'BAD_REQUEST_ERROR',
            description:
              `key rzp_test_${SENTINEL} with secret rzp_secret_${SENTINEL} is not ` +
              `authorised for this account`,
          },
        }),
        { status, headers: { 'content-type': 'application/json' } },
      );
    },
  };
}

interface RunOutcome {
  readonly run: IngestionRun;
  readonly urls: readonly string[];
  readonly recorded: Recorder;
  readonly logs: readonly string[];
}

async function runAgainst(status: number): Promise<RunOutcome> {
  const transport = echoingFetch(status);
  const recorded = recorder();
  const capture = captureLogs();
  try {
    const run = await createIngestionService({
      store: recorded.store,
      client: createRazorpayClient({
        credential: fabricatedBadCredential(),
        fetch: transport.fetch,
        sleep: async () => undefined,
        schedule: () => () => undefined,
      }),
      publisher: {
        async publish(event) {
          recorded.events.push(event);
        },
      },
    }).startRun(TENANT, ACTOR);
    return { run, urls: transport.urls, recorded, logs: capture.lines };
  } finally {
    capture.stop();
  }
}

/** Every surface a run produces, flattened to strings. */
function surfaces(outcome: RunOutcome): readonly string[] {
  return [
    ...outcome.urls,
    ...outcome.logs,
    JSON.stringify(outcome.run),
    JSON.stringify(outcome.recorded.rows),
    JSON.stringify(outcome.recorded.errors),
    JSON.stringify(outcome.recorded.completions),
    JSON.stringify(outcome.recorded.events),
    ...outcome.recorded.errors.map((e) => `${e.errorCode} ${e.objectType} ${e.requestedAt}`),
  ];
}

describe('the credential never leaves the ingestion path (Requirement 14.5)', () => {
  it('is absent from every surface of a run aborted by a credential rejection', async () => {
    const outcome = await runAgainst(401);

    expect(outcome.run.status).toBe('failed');
    expect(outcome.run.failure_kind).toBe('credential_rejected');
    // One request: a rejection is terminal and unretried.
    expect(outcome.urls).toHaveLength(1);

    for (const surface of surfaces(outcome)) {
      expect(surface).not.toContain(SENTINEL);
    }
    // The Realtime seam was actually exercised, so "absent from the published event" is a
    // real assertion rather than a vacuous one over an empty list.
    expect(outcome.recorded.events.length).toBeGreaterThan(0);
  });

  it('is absent from every surface of a run that recorded provider errors', async () => {
    const outcome = await runAgainst(400);

    // Nine recorded object-type failures, no stored objects, so the run failed for having
    // stored nothing rather than for the credential.
    expect(outcome.run.status).toBe('failed');
    expect(outcome.run.failure_kind).toBe('no_records_stored');
    expect(outcome.recorded.errors.length).toBeGreaterThan(0);
    expect(outcome.recorded.rows).toHaveLength(0);

    for (const surface of surfaces(outcome)) {
      expect(surface).not.toContain(SENTINEL);
    }
  });

  it('masks the echoed credential in the propagated provider detail', async () => {
    const transport = echoingFetch(400);
    const client = createRazorpayClient({
      credential: fabricatedBadCredential(),
      fetch: transport.fetch,
      sleep: async () => undefined,
      schedule: () => () => undefined,
    });

    const results: RazorpayFetchResult[] = [];
    for await (const result of client.fetchPages('payment', WINDOW)) {
      results.push(result);
    }

    const [only] = results;
    if (only?.kind !== 'object_type_failed') {
      throw new Error('expected a recordable failure');
    }
    expect(only.failure.detail).not.toContain(SENTINEL);
    expect(only.failure.detail).toContain('[redacted:RAZORPAY_KEY_ID]');
    expect(only.failure.detail).toContain('[redacted:RAZORPAY_KEY_SECRET]');
  });

  it('is absent from a thrown configuration error and its own-property serialisation', async () => {
    const client = createRazorpayClient({
      credential: fabricatedBadCredential(),
      fetch: echoingFetch(400).fetch,
      sleep: async () => undefined,
      schedule: () => () => undefined,
    });

    let thrown: unknown;
    try {
      // A nested collection with no parent identifier: a programming error, not a provider
      // outcome, so it throws rather than yielding a classified failure.
      for await (const _ of client.fetchPages('transfer_reversal', WINDOW)) {
        break;
      }
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBeInstanceOf(RazorpayRequestConfigurationError);
    const error = thrown as Error;
    expect(error.message).not.toContain(SENTINEL);
    expect(String(error)).not.toContain(SENTINEL);
    expect(error.stack ?? '').not.toContain(SENTINEL);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(SENTINEL);
  });

  it('masks both halves under interpolation and serialisation', () => {
    const credential = fabricatedBadCredential();

    expect(`${credential.keyId}`).toBe('[redacted:RAZORPAY_KEY_ID]');
    expect(`${credential.keySecret}`).toBe('[redacted:RAZORPAY_KEY_SECRET]');
    expect(JSON.stringify(credential)).not.toContain(SENTINEL);
    expect(JSON.stringify({ nested: { deep: credential } })).not.toContain(SENTINEL);
    // Reachable only through the explicit, grep-able call.
    expect(credential.keyId.reveal()).toContain(SENTINEL);
  });
});
