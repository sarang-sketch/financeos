/**
 * Incremental window selection (task 6.6, Requirement 1.8 and 1.9).
 *
 * A file of its own rather than more cases in `ingestion-service.test.ts`, so the window
 * rule is readable as one story: which run advances the watermark, what window that
 * produces, and that the window reaches both the transport and the client-side filter.
 *
 * The two rules under test, and why each matters:
 *
 * - **Only a `completed` run advances the watermark.** A `partially_completed` run stored
 *   something but missed something, so resuming from its start would drop whatever it
 *   missed, permanently. That is the single case worth being loud about.
 * - **`from` is inclusive.** Requirement 1.9 says "at or after", so an object created at
 *   exactly the watermark instant is retrieved.
 */

import { describe, expect, it } from 'vitest';
import type { TenantId } from '@/config/configuration-service';
import {
  createIngestionService,
  FIRST_RUN_WINDOW_DAYS,
  parseWatermark,
  pickWatermark,
  resolveWindow,
  WATERMARK_STATUS,
  withinWindow,
  type IngestionStatus,
  type IngestionStore,
  type NewRun,
  type RazorpayObjectRow,
} from '@/ingestion/ingestion-service';
import type {
  IngestedObjectType,
  RazorpayClient,
  RazorpayFetchResult,
  RazorpayObject,
  TimeWindow,
} from '@/ingestion/razorpay-client';

const TENANT = '11111111-1111-4111-8111-111111111111' as TenantId;
const USER = '22222222-2222-4222-8222-222222222222';

const NOW = new Date('2026-02-01T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function run(status: IngestionStatus, startedAt: string): {
  readonly status: IngestionStatus;
  readonly startedAt: string;
} {
  return { status, startedAt };
}

/* -------------------------------------------------------------------------- */
/* Which run is the watermark                                                 */
/* -------------------------------------------------------------------------- */

describe('pickWatermark', () => {
  it('is null when the Tenant has no runs at all', () => {
    expect(pickWatermark([])).toBeNull();
  });

  it('is the started_at of a completed run', () => {
    const at = pickWatermark([run('completed', '2026-01-20T10:00:00.000Z')]);
    expect(at?.toISOString()).toBe('2026-01-20T10:00:00.000Z');
  });

  it('is not advanced by a partially_completed run', () => {
    // The load-bearing case: that run missed at least one object type, so resuming from
    // its start would put what it missed outside every future window.
    expect(pickWatermark([run('partially_completed', '2026-01-25T10:00:00.000Z')])).toBeNull();
  });

  it('is not advanced by a failed run', () => {
    expect(pickWatermark([run('failed', '2026-01-25T10:00:00.000Z')])).toBeNull();
  });

  it('is not advanced by a run still in progress', () => {
    expect(pickWatermark([run('in_progress', '2026-01-31T23:00:00.000Z')])).toBeNull();
  });

  it('ignores later non-completed runs, so the most recent completed one wins', () => {
    const at = pickWatermark([
      run('completed', '2026-01-05T00:00:00.000Z'),
      run('completed', '2026-01-10T00:00:00.000Z'),
      run('partially_completed', '2026-01-28T00:00:00.000Z'),
      run('failed', '2026-01-30T00:00:00.000Z'),
      run('in_progress', '2026-01-31T00:00:00.000Z'),
    ]);
    expect(at?.toISOString()).toBe('2026-01-10T00:00:00.000Z');
  });

  it('does not depend on the order the runs arrive in', () => {
    const rows = [
      run('failed', '2026-01-30T00:00:00.000Z'),
      run('completed', '2026-01-10T00:00:00.000Z'),
      run('completed', '2026-01-05T00:00:00.000Z'),
    ];
    expect(pickWatermark(rows)?.toISOString()).toBe('2026-01-10T00:00:00.000Z');
    expect(pickWatermark([...rows].reverse())?.toISOString()).toBe('2026-01-10T00:00:00.000Z');
  });

  it('reads only completed, so the watermark status is exactly that', () => {
    expect(WATERMARK_STATUS).toBe('completed');
  });

  it('refuses an unparseable started_at rather than guessing a window', () => {
    expect(() => pickWatermark([run('completed', 'not-a-timestamp')])).toThrow(/not a timestamp/);
  });
});

describe('parseWatermark', () => {
  it('maps a null from the store to no watermark', () => {
    expect(parseWatermark(null)).toBeNull();
  });

  it('maps an ISO timestamp to the same instant', () => {
    expect(parseWatermark('2026-01-10T09:30:00.000Z')?.toISOString()).toBe(
      '2026-01-10T09:30:00.000Z',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The window                                                                 */
/* -------------------------------------------------------------------------- */

describe('resolveWindow with no watermark', () => {
  it('is the 365 days preceding the run start, basis first_run_365d', () => {
    const { window, basis } = resolveWindow(NOW, null);
    expect(basis).toBe('first_run_365d');
    expect(window.to.toISOString()).toBe(NOW.toISOString());
    expect(NOW.getTime() - window.from.getTime()).toBe(FIRST_RUN_WINDOW_DAYS * DAY_MS);
  });

  it('is the default, so an omitted watermark cannot mislabel a run incremental', () => {
    expect(resolveWindow(NOW).basis).toBe('first_run_365d');
  });
});

describe('resolveWindow with a watermark', () => {
  const watermark = new Date('2026-01-10T09:30:00.000Z');

  it('runs from the watermark to the run start, basis incremental', () => {
    const { window, basis } = resolveWindow(NOW, watermark);
    expect(basis).toBe('incremental');
    expect(window.from.toISOString()).toBe(watermark.toISOString());
    expect(window.to.toISOString()).toBe(NOW.toISOString());
  });

  it('includes an object created at exactly the watermark instant', () => {
    // Requirement 1.9 is "at or after", so the lower bound is inclusive.
    const { window } = resolveWindow(NOW, watermark);
    expect(withinWindow(new Date(watermark.getTime()), window)).toBe(true);
    expect(withinWindow(new Date(watermark.getTime() - 1), window)).toBe(false);
    expect(withinWindow(new Date(watermark.getTime() + 1), window)).toBe(true);
  });

  it('copies the watermark instead of aliasing the caller value', () => {
    const mutable = new Date(watermark.getTime());
    const { window } = resolveWindow(NOW, mutable);
    mutable.setUTCFullYear(1999);
    expect(window.from.toISOString()).toBe('2026-01-10T09:30:00.000Z');
  });

  it('never yields an empty window when the clock went backwards between runs', () => {
    const ahead = new Date(NOW.getTime() + 60_000);
    const { window, basis } = resolveWindow(NOW, ahead);
    expect(basis).toBe('incremental');
    expect(window.to.getTime()).toBeGreaterThanOrEqual(window.from.getTime());
    expect(withinWindow(ahead, window)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The window through a run                                                   */
/* -------------------------------------------------------------------------- */

interface Recorded {
  readonly created: NewRun[];
  readonly rows: RazorpayObjectRow[];
  readonly windows: TimeWindow[];
}

function storeWith(watermark: string | null, recorded: Recorded): IngestionStore {
  return {
    async createRun(newRun) {
      recorded.created.push(newRun);
      return { id: 'run_6_6', startedAt: newRun.startedAt };
    },
    async readWatermark() {
      return watermark;
    },
    async upsertObjects(rows) {
      recorded.rows.push(...rows);
    },
    async recordErrors() {
      /* no error path under test here */
    },
    async completeRun() {
      /* the outcome is task 6.4's */
    },
  };
}

/**
 * A transport that records the window it was handed and answers `linked_account` with
 * `windowApplied: false` — one of the four types whose window is applied client-side.
 */
function clientRecording(
  recorded: Recorded,
  unfiltered: readonly RazorpayObject[],
): RazorpayClient {
  return {
    fetchPages(type: IngestedObjectType, window: TimeWindow) {
      recorded.windows.push(window);
      const page: RazorpayFetchResult =
        type === 'linked_account'
          ? {
              kind: 'page',
              objectType: type,
              pageIndex: 0,
              objects: unfiltered,
              windowApplied: false,
            }
          : { kind: 'page', objectType: type, pageIndex: 0, objects: [], windowApplied: true };
      return {
        async *[Symbol.asyncIterator]() {
          yield page;
        },
      };
    },
  };
}

const WATERMARK_ISO = '2026-01-10T09:30:00.000Z';
const WATERMARK_UNIX = Math.floor(Date.parse(WATERMARK_ISO) / 1000);

function linkedAccount(id: string, createdAtUnix: number): RazorpayObject {
  return { id, entity: 'account', created_at: createdAtUnix, status: 'activated' };
}

describe('startRun with a watermark', () => {
  function harness(watermark: string | null, objects: readonly RazorpayObject[]) {
    const recorded: Recorded = { created: [], rows: [], windows: [] };
    const service = createIngestionService({
      store: storeWith(watermark, recorded),
      client: clientRecording(recorded, objects),
      now: () => NOW,
    });
    return { recorded, service };
  }

  it('records window_basis incremental and window_from at the watermark', async () => {
    const { recorded, service } = harness(WATERMARK_ISO, []);
    const result = await service.startRun(TENANT, USER);

    expect(recorded.created[0]?.windowBasis).toBe('incremental');
    expect(recorded.created[0]?.windowFrom).toBe(WATERMARK_ISO);
    expect(result.window_basis).toBe('incremental');
    expect(result.window_from).toBe(WATERMARK_ISO);
  });

  it('hands the incremental window to every transport request', async () => {
    const { recorded, service } = harness(WATERMARK_ISO, []);
    await service.startRun(TENANT, USER);

    expect(recorded.windows.length).toBeGreaterThan(0);
    for (const window of recorded.windows) {
      expect(window.from.toISOString()).toBe(WATERMARK_ISO);
      expect(window.to.toISOString()).toBe(NOW.toISOString());
    }
  });

  it('applies the incremental window client-side for a type the API will not filter', async () => {
    const { recorded, service } = harness(WATERMARK_ISO, [
      // Inside the old 365-day window but before the watermark: dropped now.
      linkedAccount('acc_before', WATERMARK_UNIX - 1),
      // Exactly at the watermark: "at or after" keeps it.
      linkedAccount('acc_at', WATERMARK_UNIX),
      linkedAccount('acc_after', WATERMARK_UNIX + 3600),
    ]);
    const result = await service.startRun(TENANT, USER);

    expect(recorded.rows.map((row) => row.razorpay_id).sort()).toEqual(['acc_after', 'acc_at']);
    expect(result.per_type_window_filtered.linked_account).toBe(1);
    expect(result.per_type_stored.linked_account).toBe(2);
  });

  it('falls back to 365 days when the store reports no completed run', async () => {
    const { recorded, service } = harness(null, [linkedAccount('acc_old', WATERMARK_UNIX - 1)]);
    const result = await service.startRun(TENANT, USER);

    expect(result.window_basis).toBe('first_run_365d');
    expect(NOW.getTime() - Date.parse(result.window_from)).toBe(FIRST_RUN_WINDOW_DAYS * DAY_MS);
    // The same object the incremental run dropped is inside the first-run window.
    expect(recorded.rows.map((row) => row.razorpay_id)).toEqual(['acc_old']);
  });

  it('takes 365 days when the store cannot report a watermark at all', async () => {
    const recorded: Recorded = { created: [], rows: [], windows: [] };
    const withoutRead: IngestionStore = { ...storeWith(null, recorded) };
    delete (withoutRead as { readWatermark?: unknown }).readWatermark;

    const result = await createIngestionService({
      store: withoutRead,
      client: clientRecording(recorded, []),
      now: () => NOW,
    }).startRun(TENANT, USER);

    expect(result.window_basis).toBe('first_run_365d');
  });
});
