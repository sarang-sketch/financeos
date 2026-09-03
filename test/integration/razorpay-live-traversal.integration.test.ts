/**
 * The credentialed half of task 6.5: a real traversal of Razorpay test mode (CI stage 11).
 *
 * Every case here needs a real test-mode key, so the whole file is gated on
 * `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` and skips with both names printed when they
 * are absent. Nothing is stubbed when the gate opens: the pages, the payload shapes, the
 * per-type failures and the run outcome all come from `api.razorpay.com`.
 *
 * WHAT IS AND IS NOT LIVE-TESTABLE, AND WHY
 * -----------------------------------------
 * - **Paging past 100 of one type (Requirement 1.1)** — live-testable, but only if the
 *   account holds more than 100 objects of some type. The `pages past the first 100`
 *   case therefore skips *with the observed counts printed* when it does not, while the
 *   short-page termination rule is asserted against whatever the account does hold. An
 *   account that is empty in every one of the nine types is not a pass: the suite fails and
 *   names `npm run seed:razorpay` (task 7.1), because a green tick on an empty account
 *   would assert nothing at all.
 * - **The 1/2/4/8/16 s retry schedule and the 5-retry ceiling (Requirement 1.5)** — **not**
 *   live-forceable. Razorpay cannot be made to return 429 on demand, and deliberately
 *   hammering a third party until it does is not an acceptable test. That schedule is
 *   asserted exhaustively in `src/ingestion/razorpay-client.test.ts`, against an injected
 *   `fetch` and an injected `sleep`, including the exact sequence, the six-attempt bound and
 *   the `retryCount: 5` on the recorded error. What this suite adds is the live-side half of
 *   the same guarantee: the backoff clock is recorded through the whole traversal, so if a
 *   genuine 429 does occur, the delay it waited must be one of the five scheduled values and
 *   nothing else. No test here sleeps 31 s against a live API.
 * - **A single-type error leaving the other types stored (Requirement 1.4, 1.6)** —
 *   live-testable, by asking the live API for a page size it refuses. The error is
 *   Razorpay's, the classification is the shipped transport's, and the run outcome is the
 *   shipped service's; only the choice of which type to spoil is the test's.
 * - **A credential rejection (Requirement 1.10)** — in
 *   `razorpay-credential-rejection.integration.test.ts`, because it needs no valid key.
 *
 * IT ALSO CLOSES THE OPEN QUESTIONS THE FIXTURE AND 6.1 LEFT FOR THIS TASK
 * -----------------------------------------------------------------------
 * `test/fixtures/razorpay-seed.json`'s `confirm_in_task_6_5` list names four payload facts
 * that task 7.1 could only guess at, and `RAZORPAY_ENDPOINTS.linked_account` names a fifth.
 * Each has a case below. Where test mode holds no object of the kind needed, the case skips
 * with the reason printed rather than asserting on nothing — an unconfirmed shape stays
 * visibly unconfirmed.
 *
 * Requirements: 1.1, 1.4, 1.5, 1.6, 14.5.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createIngestionService,
  toIngestedPaise,
  type IngestionRun,
} from '@/ingestion/ingestion-service';
import {
  createRazorpayClient,
  INGESTED_OBJECT_TYPES,
  RAZORPAY_ENDPOINTS,
  RAZORPAY_PAGE_SIZE,
  RAZORPAY_RETRY_DELAYS_MS,
  type FetchOptions,
  type IngestedObjectType,
  type RazorpayClient,
  type RazorpayObject,
  type RecordableRazorpayFailure,
  type TimeWindow,
} from '@/ingestion/razorpay-client';
import { announceIfUnreachable, database, newFixture, provision, runOk } from '../db/pg';
import {
  announceIfNoCredential,
  cleanUp,
  note,
  objectCountForRun,
  psqlIngestionStore,
  storedErrors,
  storedRun,
  testModeCredential,
} from './razorpay';

const credential = testModeCredential();
const dbReachable = database().reachable;

announceIfNoCredential();
announceIfUnreachable();

/** The first-run window of Requirement 1.8: the 365 days preceding the run. */
const NOW = new Date();
const WINDOW: TimeWindow = {
  from: new Date(NOW.getTime() - 365 * 24 * 60 * 60 * 1000),
  to: NOW,
};

/** How many transfers to walk reversals for. Bounded so one run is not hundreds of calls. */
const REVERSAL_PARENTS = 3;

/* -------------------------------------------------------------------------- */
/* The inventory                                                              */
/* -------------------------------------------------------------------------- */

interface Inventory {
  pageLengths: number[];
  objects: RazorpayObject[];
  urls: string[];
  failure: RecordableRazorpayFailure | null;
  windowApplied: boolean;
  /** How many separate traversals fed this entry: 1, or one per month / parent. */
  traversals: number;
}

function emptyInventory(): Inventory {
  return {
    pageLengths: [],
    objects: [],
    urls: [],
    failure: null,
    windowApplied: true,
    traversals: 0,
  };
}

const inventory = new Map<IngestedObjectType, Inventory>();
const sleeps: number[] = [];
const urls: string[] = [];

/** Every month the window touches, as the recon report's `year` / `month` parameters. */
function monthsInWindow(window: TimeWindow): readonly FetchOptions[] {
  const out: FetchOptions[] = [];
  let year = window.from.getUTCFullYear();
  let month = window.from.getUTCMonth() + 1;
  const lastYear = window.to.getUTCFullYear();
  const lastMonth = window.to.getUTCMonth() + 1;
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    out.push({ query: { year: String(year), month: String(month) } });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

function liveClient(): RazorpayClient {
  const pair = credential.credential;
  if (pair === null) {
    throw new Error('the live client was built without a credential');
  }
  return createRazorpayClient({
    credential: pair,
    fetch: async (input, init) => {
      urls.push(String(input));
      return fetch(input, init);
    },
    // The real delay, recorded. A 429 that never comes costs nothing; one that does is
    // waited out on the shipped schedule and shows up in `sleeps`.
    sleep: async (ms) => {
      sleeps.push(ms);
      await new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    },
  });
}

async function collect(
  client: RazorpayClient,
  type: IngestedObjectType,
  options?: FetchOptions,
): Promise<void> {
  const entry = inventory.get(type) ?? emptyInventory();
  inventory.set(type, entry);
  const from = urls.length;
  entry.traversals += 1;

  for await (const result of client.fetchPages(type, WINDOW, options)) {
    if (result.kind === 'credential_rejected') {
      // Nothing below can mean anything if the key itself is refused. The error code is
      // safe to print; the credential is not, and is never included.
      throw new Error(
        `the supplied RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET were rejected by Razorpay ` +
          `(${result.failure.errorCode}, HTTP ${String(result.failure.httpStatus)}). Check the ` +
          `pair is a test-mode key and re-run.`,
      );
    }
    if (result.kind === 'object_type_failed') {
      entry.failure = result.failure;
      break;
    }
    entry.pageLengths.push(result.objects.length);
    entry.objects.push(...result.objects);
    entry.windowApplied = result.windowApplied;
  }
  entry.urls.push(...urls.slice(from));
}

function inv(type: IngestedObjectType): Inventory {
  return inventory.get(type) ?? emptyInventory();
}

/**
 * The single-traversal type that returned the most objects, and how many.
 *
 * Restricted to types walked exactly once, so its pages and its requests line up one to
 * one. `settlement_recon_report` is one traversal per calendar month and
 * `transfer_reversal` one per parent transfer, so neither can carry a paging assertion
 * about "the pages of one object type".
 */
function largest(): { type: IngestedObjectType; count: number } {
  let best: { type: IngestedObjectType; count: number } = {
    type: INGESTED_OBJECT_TYPES[0],
    count: -1,
  };
  for (const type of INGESTED_OBJECT_TYPES) {
    const entry = inv(type);
    if (entry.traversals !== 1) {
      continue;
    }
    if (entry.objects.length > best.count) {
      best = { type, count: entry.objects.length };
    }
  }
  return best;
}

function totalObjects(): number {
  let total = 0;
  for (const type of INGESTED_OBJECT_TYPES) {
    total += inv(type).objects.length;
  }
  return total;
}

const EMPTY_ACCOUNT_HINT =
  'the Razorpay test-mode account returned zero objects of all nine types inside the ' +
  '365-day window, so no paging or payload assertion can mean anything. Run ' +
  '`npm run seed:razorpay` (task 7.1) against this key first.';

/* -------------------------------------------------------------------------- */
/* Paging and payload shapes                                                  */
/* -------------------------------------------------------------------------- */

describe.skipIf(!credential.available)('a live traversal of Razorpay test mode', () => {
  beforeAll(async () => {
    const client = liveClient();

    for (const type of INGESTED_OBJECT_TYPES) {
      if (type === 'transfer_reversal' || type === 'settlement_recon_report') {
        continue;
      }
      await collect(client, type);
    }

    // Reversals are addressable only under their transfer, so they need the transfers first.
    const transfers = inv('transfer')
      .objects.map((o) => o.id)
      .filter((id): id is string => typeof id === 'string')
      .slice(0, REVERSAL_PARENTS);
    for (const parentId of transfers) {
      await collect(client, 'transfer_reversal', { parentId });
    }

    // The combined recon report is addressed by year and month, not by a window.
    for (const options of monthsInWindow(WINDOW)) {
      await collect(client, 'settlement_recon_report', options);
    }

    const summary = INGESTED_OBJECT_TYPES.map(
      (type) =>
        `${type}=${inv(type).objects.length}${inv(type).failure === null ? '' : ' (failed: ' + inv(type).failure?.errorCode + ')'}`,
    ).join(', ');
    note(`live test-mode inventory over 365 days: ${summary}`);
  }, 900_000);

  it('requests 100 per page and stops on the first short page', () => {
    expect(totalObjects(), EMPTY_ACCOUNT_HINT).toBeGreaterThan(0);

    const { type } = largest();
    const entry = inv(type);
    expect(entry.traversals).toBe(1);
    // One request per page. A retried request repeats its URL, so consecutive duplicates
    // are collapsed rather than counted as extra pages.
    const requested = entry.urls.filter((url, index) => url !== entry.urls[index - 1]);
    expect(requested.length).toBe(entry.pageLengths.length);

    for (const [index, length] of entry.pageLengths.entries()) {
      const isLast = index === entry.pageLengths.length - 1;
      // Requirement 1.1: a page of exactly 100 is followed by another request; a page of
      // fewer than 100 terminates the type.
      expect(isLast ? length < RAZORPAY_PAGE_SIZE : length === RAZORPAY_PAGE_SIZE).toBe(true);
    }

    for (const [index, url] of requested.entries()) {
      const query = new URL(url).searchParams;
      expect(query.get('count')).toBe(String(RAZORPAY_PAGE_SIZE));
      expect(query.get('skip')).toBe(String(index * RAZORPAY_PAGE_SIZE));
    }
  });

  it('pages past the first 100 objects of one type', (ctx) => {
    const { type, count } = largest();
    if (count <= RAZORPAY_PAGE_SIZE) {
      const reason =
        `no object type in this test-mode account holds more than ${RAZORPAY_PAGE_SIZE} ` +
        `objects inside the window (largest: ${type} with ${count}), so the second page ` +
        `cannot be exercised. The short-page termination rule is asserted above on the ` +
        `${count} objects that exist.`;
      note(`SKIPPING the multi-page case - ${reason}`);
      ctx.skip(reason);
      return;
    }

    const entry = inv(type);
    expect(entry.pageLengths.length).toBeGreaterThanOrEqual(2);
    expect(entry.pageLengths[0]).toBe(RAZORPAY_PAGE_SIZE);

    // `skip` advanced correctly, so page two is not page one again.
    const ids = entry.objects
      .map((o) => o.id)
      .filter((id): id is string => typeof id === 'string');
    expect(ids).toHaveLength(entry.objects.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sends monetary fields as JSON numbers, exercising the number branch', (ctx) => {
    const carriers: IngestedObjectType[] = ['payment', 'order', 'refund', 'settlement'];
    for (const type of carriers) {
      for (const object of inv(type).objects) {
        const amount = object.amount;
        if (amount === undefined || amount === null) {
          continue;
        }
        // The fixture stores money as digit strings because JSON has no bigint; the live
        // API does not, and this is the case that says so.
        expect(typeof amount, `${type}.amount`).toBe('number');
        expect(Number.isInteger(amount)).toBe(true);
        expect(toIngestedPaise(amount, 'amount')).toBe(BigInt(amount as number));
        note(`confirmed: live ${type}.amount arrives as a JSON number (${String(amount)} paise)`);
        return;
      }
    }
    ctx.skip(
      'no payment, order, refund or settlement with an amount was returned, so the JSON ' +
        'number encoding of money is unconfirmed.',
    );
  });

  it('confirms the settlement recon line field names', (ctx) => {
    const lines = inv('settlement_recon_report').objects;
    if (lines.length === 0) {
      const reason =
        `test mode returned no combined recon lines across the ${inv('settlement_recon_report').traversals} ` +
        `months of the window (Razorpay produces settlements on its own cycle and exposes no ` +
        `create endpoint), so the line shape in razorpay-seed.json stays unconfirmed.`;
      note(`SKIPPING the recon line shape - ${reason}`);
      ctx.skip(reason);
      return;
    }

    const first = lines[0] as RazorpayObject;
    const present = Object.keys(first);
    note(`confirmed: live recon line keys = ${present.join(', ')}`);

    // `entity_id` is the one the ingestion path depends on: RAZORPAY_ID_FIELD keys this
    // type on it rather than on `id`.
    expect(present).toContain('entity_id');
    expect(present).toContain('type');
    for (const field of ['debit', 'credit', 'amount', 'settled_at', 'settlement_utr']) {
      expect(present, `recon line field ${field}`).toContain(field);
    }
    const types = new Set(
      lines.map((line) => (typeof line.type === 'string' ? line.type : 'unknown')),
    );
    note(`confirmed: live recon line \`type\` vocabulary = ${[...types].join(', ')}`);
  });

  it('confirms whether a chargeback arrives as a dispute or as an adjustment line', (ctx) => {
    const lines = inv('settlement_recon_report').objects;
    if (lines.length === 0) {
      const reason =
        'test mode returned no combined recon lines, so whether a chargeback arrives as ' +
        '`type: "dispute"` or as an adjustment stays unconfirmed.';
      note(`SKIPPING the chargeback line kind - ${reason}`);
      ctx.skip(reason);
      return;
    }

    const disputes = lines.filter((line) => line.type === 'dispute');
    const adjustments = lines.filter((line) => line.type === 'adjustment');
    const withDisputeId = lines.filter(
      (line) => line.dispute_id !== undefined && line.dispute_id !== null,
    );
    note(
      `confirmed: recon lines carry ${disputes.length} \`dispute\` line(s), ` +
        `${adjustments.length} \`adjustment\` line(s), ${withDisputeId.length} line(s) with a ` +
        `non-null dispute_id`,
    );
    // Either vocabulary is an acceptable answer; what would be wrong is a chargeback with
    // no recognisable line kind at all, which the reconciliation path could not classify.
    if (withDisputeId.length > 0) {
      for (const line of withDisputeId) {
        expect(['dispute', 'adjustment']).toContain(line.type);
      }
    }
  });

  it('confirms the recon line entity_id is the settled entity, not a line of its own', (ctx) => {
    const lines = inv('settlement_recon_report').objects;
    if (lines.length === 0) {
      const reason =
        'test mode returned no combined recon lines, so the `entity_id` shape — and with it ' +
        'the identifier collision 6.2 flagged against razorpay_objects_tenant_rzp_uniq — ' +
        'stays unconfirmed.';
      note(`SKIPPING the recon entity_id shape - ${reason}`);
      ctx.skip(reason);
      return;
    }

    const paymentIds = new Set(
      inv('payment')
        .objects.map((o) => o.id)
        .filter((id): id is string => typeof id === 'string'),
    );
    const entityIds = lines
      .map((line) => line.entity_id)
      .filter((id): id is string => typeof id === 'string');
    expect(entityIds.length).toBe(lines.length);

    const collisions = entityIds.filter((id) => paymentIds.has(id));
    note(
      `confirmed: ${collisions.length} of ${entityIds.length} recon \`entity_id\` value(s) are ` +
        `also retrieved payment identifiers. Non-zero means a recon line and its payment ` +
        `contend for one (tenant_id, razorpay_id) row — the migration finding recorded at ` +
        `IDENTIFIER_COLLISION_ERROR_CODE in src/ingestion/ingestion-service.ts.`,
    );
  });

  it('confirms whether a settlement reports its fee as fee or fees', (ctx) => {
    const settlements = inv('settlement').objects;
    if (settlements.length === 0) {
      const reason =
        'test mode returned no settlements, so whether the object reports `fee` or `fees` ' +
        'stays unconfirmed. RAZORPAY_MONEY_FIELDS.settlement reads both, in that order.';
      note(`SKIPPING the settlement fee field - ${reason}`);
      ctx.skip(reason);
      return;
    }
    const first = settlements[0] as RazorpayObject;
    const hasFee = first.fee !== undefined;
    const hasFees = first.fees !== undefined;
    note(
      `confirmed: live settlement carries ${hasFee ? '`fee`' : ''}${hasFee && hasFees ? ' and ' : ''}${hasFees ? '`fees`' : ''}${hasFee || hasFees ? '' : 'neither `fee` nor `fees`'}`,
    );
    expect(hasFee || hasFees).toBe(true);
  });

  it('confirms whether /v1/accounts lists Linked_Accounts', () => {
    const entry = inv('linked_account');
    expect(RAZORPAY_ENDPOINTS.linked_account.path).toBe('/v1/accounts');

    if (entry.failure !== null) {
      // 6.1 predicted this: the v2 onboarding surface documents fetch-by-id only. What
      // matters for Requirement 1.4 is that it is recorded and does not abort the run.
      note(
        `confirmed: /v1/accounts does not list for this key - ${entry.failure.category} ` +
          `${entry.failure.errorCode} (HTTP ${String(entry.failure.httpStatus)}); ` +
          `ingestion records it and continues.`,
      );
      expect(entry.failure.category).toBe('provider_error');
      expect(entry.failure.abortsRun).toBeUndefined();
      return;
    }

    note(`confirmed: /v1/accounts lists, returning ${entry.objects.length} linked account(s)`);
    for (const account of entry.objects) {
      expect(typeof account.id).toBe('string');
    }
  });

  it('waited only scheduled backoff delays against the live API', () => {
    // The 1/2/4/8/16 s sequence and the 5-retry ceiling are asserted exhaustively in
    // src/ingestion/razorpay-client.test.ts, which can force a 429; this suite cannot.
    // What is checkable live is that no unscheduled delay was ever used.
    for (const ms of sleeps) {
      expect(RAZORPAY_RETRY_DELAYS_MS).toContain(ms);
    }
    note(
      sleeps.length === 0
        ? 'no rate limit or timeout occurred during the live traversal, so no backoff was ' +
            'exercised; the 1/2/4/8/16 s schedule and the 5-retry ceiling are unit-covered.'
        : `live backoff delays observed: ${sleeps.join(', ')} ms`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* One spoiled object type, against the real API and the real schema           */
/* -------------------------------------------------------------------------- */

const spoiled = newFixture();

/** The type whose requests are deliberately made invalid. */
const SPOILED_TYPE: IngestedObjectType = 'razorpay_invoice';

/**
 * A client that asks the live API for a page of 101 for one object type.
 *
 * Razorpay's collection endpoints accept `count` up to 100, so this is a genuine 400 from
 * the provider rather than a fabricated one — the transport classifies it, the service
 * records it, and every other object type goes through untouched. `FetchOptions.query`
 * overrides are applied after `count` in `buildUrl`, which is what makes this reachable
 * from outside the client.
 */
function clientWithOneSpoiledType(type: IngestedObjectType): RazorpayClient {
  const real = liveClient();
  return {
    fetchPages(requested, window, options) {
      if (requested !== type) {
        return real.fetchPages(requested, window, options);
      }
      return real.fetchPages(requested, window, {
        ...options,
        query: { ...options?.query, count: String(RAZORPAY_PAGE_SIZE + 1) },
      });
    },
  };
}

let spoiledRun: IngestionRun | null = null;

describe.skipIf(!credential.available || !dbReachable)(
  'a live run with one object type failing',
  () => {
    beforeAll(async () => {
      runOk(provision(spoiled));
      spoiledRun = await createIngestionService({
        store: psqlIngestionStore(spoiled),
        client: clientWithOneSpoiledType(SPOILED_TYPE),
      }).startRun(spoiled.tenantId, spoiled.userId);
    }, 900_000);

    afterAll(() => {
      if (dbReachable) {
        cleanUp(spoiled);
      }
    });

    it('records the failing type and still stores the others, run partially_completed', () => {
      const run = spoiledRun as IngestionRun;
      const stored = storedRun(spoiled, run.id);
      const errors = storedErrors(spoiled, run.id);

      const spoiledErrors = errors.filter((e) => e.object_type === SPOILED_TYPE);
      expect(
        spoiledErrors.length,
        `asking for count=${RAZORPAY_PAGE_SIZE + 1} no longer produces an error from ` +
          `Razorpay, so this scenario is no longer forcing one; pick another invalid ` +
          `request shape.`,
      ).toBeGreaterThan(0);
      expect(spoiledErrors[0]?.error_category).toBe('provider_error');
      // Requirement 1.5: a provider error is recorded on the first attempt, not retried.
      expect(spoiledErrors[0]?.retry_count).toBe(0);

      // Requirement 1.4: the remaining object types were still ingested.
      const total = objectCountForRun(spoiled, run.id);
      expect(total, EMPTY_ACCOUNT_HINT).toBeGreaterThan(0);
      expect(stored.per_type_stored[SPOILED_TYPE]).toBe(0);

      // Requirement 1.6: at least one record stored and at least one error.
      expect(stored.status).toBe('partially_completed');
      expect(stored.failure_kind).toBeNull();
      expect(stored.ended_at).not.toBeNull();
      expect(stored.per_type_errors).toBe(errors.length);

      note(
        `live partially_completed run: ${total} object(s) stored, ${errors.length} error(s), ` +
          `${SPOILED_TYPE} failed with ${spoiledErrors[0]?.error_code ?? 'unknown'}`,
      );
    });
  },
);
