import { describe, expect, it } from 'vitest';
import { Secret } from '@/config/env';
import {
  classifyStatus,
  createRazorpayClient,
  INGESTED_OBJECT_TYPES,
  RAZORPAY_ENDPOINTS,
  RAZORPAY_ERROR_CATEGORIES,
  RAZORPAY_MAX_RETRIES,
  RAZORPAY_OBJECT_TYPES,
  RAZORPAY_PAGE_SIZE,
  RAZORPAY_REQUEST_TIMEOUT_MS,
  RAZORPAY_RETRY_DELAYS_MS,
  RazorpayRequestConfigurationError,
  type FetchOptions,
  type IngestedObjectType,
  type RazorpayCredential,
  type RazorpayFetchResult,
  type RazorpayObject,
  type TimeWindow,
} from '@/ingestion/razorpay-client';

/**
 * Both halves of the credential carry this. It must appear in no URL, no log line, no
 * error message, no thrown object and no `JSON.stringify` output (Requirement 14.5).
 */
const SENTINEL = 'SENTINEL_CREDENTIAL_DO_NOT_LEAK';

const credential: RazorpayCredential = {
  keyId: new Secret('RAZORPAY_KEY_ID', `rzp_test_${SENTINEL}`),
  keySecret: new Secret('RAZORPAY_KEY_SECRET', `rzp_secret_${SENTINEL}`),
};

const WINDOW: TimeWindow = {
  from: new Date('2025-01-01T00:00:00.000Z'),
  to: new Date('2026-01-01T00:00:00.000Z'),
};

/** A page of `n` distinct objects, in the collection envelope Razorpay returns. */
function collection(n: number, prefix = 'pay'): string {
  const items = Array.from({ length: n }, (_, i) => ({ id: `${prefix}_${i}`, entity: 'payment' }));
  return JSON.stringify({ entity: 'collection', count: items.length, items });
}

function ok(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

function fail(status: number, code = 'BAD_REQUEST_ERROR'): Response {
  return new Response(JSON.stringify({ error: { code, description: 'nope' } }), { status });
}

interface Harness {
  readonly client: ReturnType<typeof createRazorpayClient>;
  readonly urls: string[];
  readonly headers: Array<Record<string, string>>;
  readonly slept: number[];
  readonly armed: number[];
  /** Fires every armed timeout timer, aborting whatever request is in flight. */
  readonly fireTimeouts: () => void;
}

interface HarnessOptions {
  /** One entry per attempt. A function receives the request signal. */
  readonly responses: ReadonlyArray<Response | ((signal: AbortSignal | null) => Promise<Response>)>;
  readonly timeoutMs?: number;
}

function harness(options: HarnessOptions): Harness {
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const slept: number[] = [];
  const armed: number[] = [];
  const due: Array<() => void> = [];
  let attempt = 0;

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    urls.push(String(input));
    headers.push({ ...(init?.headers as Record<string, string> | undefined) });
    const next = options.responses[Math.min(attempt, options.responses.length - 1)];
    attempt += 1;
    if (next === undefined) {
      throw new Error('the harness was given no responses');
    }
    if (typeof next === 'function') {
      return next(init?.signal ?? null);
    }
    // A `Response` body can only be read once, so hand out a fresh clone per attempt.
    return next.clone();
  };

  const client = createRazorpayClient({
    credential,
    fetch: fetchImpl,
    sleep: async (ms) => {
      slept.push(ms);
    },
    schedule: (ms, onDue) => {
      armed.push(ms);
      due.push(onDue);
      return () => {
        const at = due.indexOf(onDue);
        if (at !== -1) {
          due.splice(at, 1);
        }
      };
    },
    now: () => new Date('2026-02-01T10:00:00.000Z'),
    baseUrl: 'https://api.razorpay.test',
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  return {
    client,
    urls,
    headers,
    slept,
    armed,
    fireTimeouts: () => {
      for (const fire of [...due]) {
        fire();
      }
    },
  };
}

/** Yield to the event loop so the client reaches the fake fetch. */
async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Wait until the nth per-request timer is armed, then expire it. */
async function expireArmedTimeout(h: Harness, nth: number): Promise<void> {
  for (let spins = 0; spins < 50 && h.armed.length < nth; spins += 1) {
    await flush();
  }
  expect(h.armed).toHaveLength(nth);
  h.fireTimeouts();
  await flush();
}

async function drain(
  h: Harness,
  type: IngestedObjectType = 'payment',
  fetchOptions?: FetchOptions,
): Promise<RazorpayFetchResult[]> {
  const out: RazorpayFetchResult[] = [];
  for await (const result of h.client.fetchPages(type, WINDOW, fetchOptions)) {
    out.push(result);
  }
  return out;
}

function pages(results: readonly RazorpayFetchResult[]): ReadonlyArray<readonly RazorpayObject[]> {
  return results.filter((r) => r.kind === 'page').map((r) => r.objects);
}

/* -------------------------------------------------------------------------- */
/* Constants and the object-type map                                          */
/* -------------------------------------------------------------------------- */

describe('constants', () => {
  it('pages at 100 with a 30 second per-request timeout', () => {
    expect(RAZORPAY_PAGE_SIZE).toBe(100);
    expect(RAZORPAY_REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it('retries on exactly 1s, 2s, 4s, 8s, 16s, at most 5 times', () => {
    expect(RAZORPAY_RETRY_DELAYS_MS).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(RAZORPAY_MAX_RETRIES).toBe(5);
  });

  it('names the four error categories the ingestion_errors CHECK accepts', () => {
    expect([...RAZORPAY_ERROR_CATEGORIES]).toEqual([
      'rate_limit',
      'timeout',
      'provider_error',
      'credential_rejected',
    ]);
  });

  it('maps the nine ingested object types, leaving credit_note to the compliance path', () => {
    expect(INGESTED_OBJECT_TYPES).toHaveLength(9);
    expect(RAZORPAY_OBJECT_TYPES).toHaveLength(10);
    expect(RAZORPAY_OBJECT_TYPES).toContain('credit_note');
    expect(INGESTED_OBJECT_TYPES).not.toContain('credit_note');
    for (const type of INGESTED_OBJECT_TYPES) {
      expect(RAZORPAY_ENDPOINTS[type].path.startsWith('/v')).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Paging (Requirement 1.1)                                                   */
/* -------------------------------------------------------------------------- */

describe('paging', () => {
  it('requests 100 per page and stops on a short page', async () => {
    const h = harness({
      responses: [ok(collection(100, 'a')), ok(collection(100, 'b')), ok(collection(37, 'c'))],
    });

    const results = await drain(h);

    expect(pages(results).map((p) => p.length)).toEqual([100, 100, 37]);
    expect(h.urls).toHaveLength(3);
    for (const [index, url] of h.urls.entries()) {
      const query = new URL(url).searchParams;
      expect(query.get('count')).toBe('100');
      expect(query.get('skip')).toBe(String(index * 100));
    }
  });

  it('treats an exactly-100 page as non-terminal and then stops on the empty page', async () => {
    const h = harness({ responses: [ok(collection(100)), ok(collection(0))] });

    const results = await drain(h);

    expect(pages(results).map((p) => p.length)).toEqual([100, 0]);
    expect(h.urls).toHaveLength(2);
  });

  it('stops after a single short first page', async () => {
    const h = harness({ responses: [ok(collection(3))] });

    expect(pages(await drain(h)).map((p) => p.length)).toEqual([3]);
    expect(h.urls).toHaveLength(1);
  });

  it('sends the window only where the collection supports from/to', async () => {
    const windowed = harness({ responses: [ok(collection(0))] });
    const windowedResults = await drain(windowed, 'payment');
    const query = new URL(windowed.urls[0] ?? '').searchParams;
    expect(query.get('from')).toBe(String(Math.floor(WINDOW.from.getTime() / 1000)));
    expect(query.get('to')).toBe(String(Math.floor(WINDOW.to.getTime() / 1000)));
    expect(windowedResults[0]).toMatchObject({ kind: 'page', windowApplied: true });

    const unwindowed = harness({ responses: [ok(collection(0))] });
    const unwindowedResults = await drain(unwindowed, 'transfer');
    expect(new URL(unwindowed.urls[0] ?? '').searchParams.has('from')).toBe(false);
    expect(unwindowedResults[0]).toMatchObject({ kind: 'page', windowApplied: false });
  });

  it('requires a parent identifier for a nested collection and a year/month for recon', async () => {
    const h = harness({ responses: [ok(collection(0))] });

    await expect(drain(h, 'transfer_reversal')).rejects.toThrowError(
      RazorpayRequestConfigurationError,
    );
    await expect(drain(h, 'settlement_recon_report')).rejects.toThrowError(
      RazorpayRequestConfigurationError,
    );

    const nested = harness({ responses: [ok(collection(0))] });
    await drain(nested, 'transfer_reversal', { parentId: 'trf_123' });
    expect(nested.urls[0]).toContain('/v1/transfers/trf_123/reversals');
  });

  it('records a malformed collection as a provider error rather than yielding a page', async () => {
    const h = harness({ responses: [ok(JSON.stringify({ entity: 'collection' }))] });

    const results = await drain(h);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'object_type_failed',
      failure: { category: 'provider_error', errorCode: 'MALFORMED_COLLECTION' },
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Timeout (Requirement 1.1, 1.5)                                             */
/* -------------------------------------------------------------------------- */

describe('per-request timeout', () => {
  it('arms 30 s per request and aborts the in-flight request when it expires', async () => {
    let aborted = false;
    const h = harness({
      responses: [
        (signal) =>
          new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('aborted'));
            });
          }),
      ],
    });

    const iterator = h.client.fetchPages('payment', WINDOW)[Symbol.asyncIterator]();
    const pending = iterator.next();
    // Let the request reach the fake fetch, then expire the armed timer six times: the
    // attempt plus its five retries (Requirement 1.5).
    for (let attempt = 1; attempt <= RAZORPAY_MAX_RETRIES + 1; attempt += 1) {
      await expireArmedTimeout(h, attempt);
    }
    const first = await pending;

    expect(aborted).toBe(true);
    expect(h.armed[0]).toBe(RAZORPAY_REQUEST_TIMEOUT_MS);
    expect(first.value).toMatchObject({
      kind: 'object_type_failed',
      failure: { category: 'timeout', errorCode: 'REQUEST_TIMEOUT', httpStatus: null },
    });
  });

  it('arms the timeout on every attempt, not once per object type', async () => {
    const h = harness({ responses: [ok(collection(100)), ok(collection(1))] });

    await drain(h);

    expect(h.armed).toEqual([RAZORPAY_REQUEST_TIMEOUT_MS, RAZORPAY_REQUEST_TIMEOUT_MS]);
  });
});

/* -------------------------------------------------------------------------- */
/* Retries (Requirement 1.5)                                                  */
/* -------------------------------------------------------------------------- */

describe('retries', () => {
  it('retries a rate limit on the exact schedule and gives up after 5 retries', async () => {
    const h = harness({ responses: [fail(429, 'RATE_LIMIT_ERROR')] });

    const results = await drain(h);

    expect(h.slept).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(h.urls).toHaveLength(6);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'object_type_failed',
      failure: {
        category: 'rate_limit',
        objectType: 'payment',
        retryCount: 5,
        httpStatus: 429,
        errorCode: 'RATE_LIMIT_ERROR',
      },
    });
  });

  it('resumes paging when a retried rate limit succeeds', async () => {
    const h = harness({
      responses: [fail(429), fail(429), ok(collection(100)), ok(collection(2))],
    });

    const results = await drain(h);

    expect(h.slept).toEqual([1_000, 2_000]);
    expect(pages(results).map((p) => p.length)).toEqual([100, 2]);
  });

  it('retries a timeout on the same schedule', async () => {
    const h = harness({
      responses: [
        (signal) =>
          new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ],
    });

    const iterator = h.client.fetchPages('payment', WINDOW)[Symbol.asyncIterator]();
    const pending = iterator.next();
    for (let attempt = 1; attempt <= RAZORPAY_MAX_RETRIES + 1; attempt += 1) {
      await expireArmedTimeout(h, attempt);
    }
    const first = await pending;

    expect(h.slept).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(first.value).toMatchObject({
      kind: 'object_type_failed',
      failure: { category: 'timeout', retryCount: 5 },
    });
  });

  it('does not retry a provider error', async () => {
    const h = harness({ responses: [fail(500, 'SERVER_ERROR')] });

    const results = await drain(h);

    expect(h.slept).toEqual([]);
    expect(h.urls).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'object_type_failed',
      failure: { category: 'provider_error', retryCount: 0, errorCode: 'SERVER_ERROR' },
    });
  });

  it('does not retry a credential rejection', async () => {
    const h = harness({ responses: [fail(401, 'BAD_REQUEST_ERROR')] });

    const results = await drain(h);

    expect(h.slept).toEqual([]);
    expect(h.urls).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: 'credential_rejected',
      failure: { category: 'credential_rejected', retryCount: 0 },
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Classification (Requirement 1.4, 1.5, 1.10)                                */
/* -------------------------------------------------------------------------- */

describe('classification', () => {
  it('maps status to the four categories', () => {
    expect(classifyStatus(200)).toBe('success');
    expect(classifyStatus(204)).toBe('success');
    expect(classifyStatus(401)).toBe('credential_rejected');
    expect(classifyStatus(403)).toBe('credential_rejected');
    expect(classifyStatus(429)).toBe('rate_limit');
    expect(classifyStatus(400)).toBe('provider_error');
    expect(classifyStatus(404)).toBe('provider_error');
    expect(classifyStatus(500)).toBe('provider_error');
    expect(classifyStatus(503)).toBe('provider_error');
  });

  it('classifies both 401 and 403 as a terminal credential rejection', async () => {
    for (const status of [401, 403]) {
      const h = harness({ responses: [fail(status)] });
      const results = await drain(h);

      expect(results).toHaveLength(1);
      const [only] = results;
      expect(only?.kind).toBe('credential_rejected');
      if (only?.kind !== 'credential_rejected') {
        throw new Error('expected a credential rejection');
      }
      // `abortsRun: true` is what stops a caller from passing this to the
      // record-and-continue path of Requirement 1.4 by mistake.
      expect(only.failure.abortsRun).toBe(true);
      expect(only.failure.category).toBe('credential_rejected');
      expect(only.failure.httpStatus).toBe(status);
    }
  });

  it('yields no page before a credential rejection and requests nothing further', async () => {
    const h = harness({ responses: [ok(collection(100)), fail(403)] });

    const results = await drain(h);

    // The first page is real data; the rejection then terminates the traversal, and 6.2
    // discards the run's objects (Requirement 1.10).
    expect(results.map((r) => r.kind)).toEqual(['page', 'credential_rejected']);
    expect(h.urls).toHaveLength(2);
  });

  it('classifies a transport failure as a provider error, unretried', async () => {
    const h = harness({
      responses: [
        () => {
          throw new Error(`socket hang up`);
        },
      ],
    });

    const results = await drain(h);

    expect(h.slept).toEqual([]);
    expect(results[0]).toMatchObject({
      kind: 'object_type_failed',
      failure: { category: 'provider_error', errorCode: 'TRANSPORT_ERROR' },
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The credential (Requirement 14.5)                                          */
/* -------------------------------------------------------------------------- */

describe('credential handling', () => {
  it('sends basic auth built from the key id and secret', async () => {
    const h = harness({ responses: [ok(collection(0))] });

    await drain(h);

    const sent = h.headers[0]?.authorization ?? '';
    expect(sent.startsWith('Basic ')).toBe(true);
    expect(Buffer.from(sent.slice('Basic '.length), 'base64').toString('utf8')).toBe(
      `rzp_test_${SENTINEL}:rzp_secret_${SENTINEL}`,
    );
  });

  it('leaks the credential into no url, no result, no error and no serialisation', async () => {
    const logged: string[] = [];
    const h = harness({
      responses: [
        // A provider that echoes the key id back in its error body: the redaction filter
        // matches on value, so the echo is scrubbed before it is propagated.
        new Response(
          JSON.stringify({
            error: { code: 'BAD_REQUEST_ERROR', description: `key rzp_test_${SENTINEL} rejected` },
          }),
          { status: 400 },
        ),
      ],
    });

    const results = await drain(h);
    logged.push(...h.urls, JSON.stringify(results), JSON.stringify(credential));
    logged.push(String(credential.keyId), `${credential.keySecret}`);

    for (const line of logged) {
      expect(line).not.toContain(SENTINEL);
    }

    // And the propagated provider text is masked rather than merely absent.
    const [only] = results;
    if (only?.kind !== 'object_type_failed') {
      throw new Error('expected a recordable failure');
    }
    expect(only.failure.detail).toContain('[redacted:RAZORPAY_KEY_ID]');
    expect(only.failure.detail).not.toContain(SENTINEL);
  });

  it('resolves the credential per request rather than capturing it once', async () => {
    let reads = 0;
    const client = createRazorpayClient({
      credential: () => {
        reads += 1;
        return Promise.resolve(credential);
      },
      fetch: async () => ok(collection(100)).clone(),
      sleep: async () => undefined,
      schedule: () => () => undefined,
      baseUrl: 'https://api.razorpay.test',
    });

    let seen = 0;
    for await (const result of client.fetchPages('payment', WINDOW)) {
      if (result.kind === 'page') {
        seen += 1;
      }
      if (seen === 3) {
        break;
      }
    }

    expect(reads).toBe(3);
  });
});
