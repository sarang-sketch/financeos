/**
 * The gate the rest of the `db` project hangs on (task 4.8).
 *
 * Every other file in this directory is wrapped in `describe.skipIf(!database().reachable)`,
 * which is silent by design. This file is NOT skipped: it always runs, and either
 * confirms the two facts the suite depends on or skips with the reason spelled
 * out, so a run that asserted nothing says so instead of looking green.
 *
 * The suite is gated on a live probe rather than on a hardcoded skip, so these
 * files run unmodified wherever the local stack is up.
 */

import { describe, expect, it } from 'vitest';
import { announceIfUnreachable, database } from './pg';

announceIfUnreachable();

describe('Supabase local reachability', () => {
  it('is reachable with the migrations applied', (ctx) => {
    const db = database();
    if (!db.reachable) {
      // `announceIfUnreachable` has already written the reason to stderr; this note
      // carries it into the reporter's expanded output too.
      ctx.skip(db.reason);
      return;
    }
    expect(db.container).not.toBeNull();
  });

  it('runs as a role that can see its own rows while RLS has no policies', (ctx) => {
    const db = database();
    if (!db.reachable) {
      ctx.skip(db.reason);
      return;
    }
    // Until task 26.1 adds policies, every tenant-scoped table matches zero rows
    // for a role without BYPASSRLS. The suite's fixtures would silently see nothing.
    // See the role note at the top of `pg.ts`.
    expect(
      db.bypassRls,
      'the connecting role lost BYPASSRLS: every fixture would match zero rows until task 26.1 ' +
        'adds RLS policies, so the suite would pass vacuously',
    ).toBe(true);
  });

  it('runs as a non-superuser, matching the privilege shape of Supabase-hosted', (ctx) => {
    const db = database();
    if (!db.reachable) {
      ctx.skip(db.reason);
      return;
    }
    // On Supabase local `postgres` holds BYPASSRLS but is not a superuser, the same
    // shape as hosted. This is what makes the dblink finding recorded in
    // `append-only.test.ts` a production defect rather than a local quirk: a
    // superuser here would mask it. If this ever becomes true, that finding needs
    // re-checking against a non-superuser role before it is believed fixed.
    expect(db.superuser).toBe(false);
  });
});
