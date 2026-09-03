import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * One Vitest project per CI stage in design.md, so each stage runs independently:
 *
 *   stage 3  test:unit       — in-process unit tests, co-located with the source
 *   stage 5  test:db         — Supabase local, migrations applied
 *   stage 6  test:contract   — one contract test per Financial_Tool
 *   stage 7  test:transport  — transport schemas and the money wire round-trip
 *   stage 8  test:property   — P1..P15 under fast-check, seeded
 *   stage 10 test:e2e        — the end-to-end demo path against Razorpay test mode
 *   stage 11 test:integration — Razorpay test-mode integration: paging, retry/backoff,
 *                              credential rejection. Advisory, not merge-gating.
 *
 * `passWithNoTests` is on because the stages exist before their suites do; a stage
 * that matches zero files is a clean pass rather than a runner error.
 */

const srcRoot = fileURLToPath(new URL('./src', import.meta.url));

const common = {
  environment: 'node',
  globals: false,
  passWithNoTests: true,
  clearMocks: true,
} as const;

export default defineConfig({
  resolve: {
    alias: {
      '@': srcRoot,
    },
  },
  test: {
    passWithNoTests: true,
    projects: [
      {
        resolve: { alias: { '@': srcRoot } },
        test: {
          ...common,
          name: 'unit',
          // `test/fixtures/**` is here because a fixture's self-check is an in-process
          // unit test with no database and no network: `set-9281.fixture.test.ts` asserts
          // that the worked-example figures are internally consistent and agree with
          // `razorpay-seed.json`. Without this glob no project would collect it, and an
          // uncollected self-check is the same as no self-check.
          //
          // `test/evidence/**` is here for the same reason as of task 9.2. The independent
          // replay interpreter is pure — an ordered `EvidenceStep[]` and a record lookup in,
          // a `bigint` out, no database and no network — so its tests are stage 3. It lives
          // under `test/` rather than beside `src/evidence` because task 9.2 requires it to
          // share no code with the tools that produce a chain, and no project globbed that
          // directory before this entry.
          // `test/worked-example/**` is here as of task 11.3. design.md's SET-9281
          // worked example drives `reconcileSettlement` and the Evidence_Chain builder,
          // persists through the in-memory store and replays what comes back out — pure
          // TypeScript, no database and no network, so stage 3. It lives under `test/`
          // rather than beside `src/agents/reconciliation` because it reaches across
          // three trees (the reconciliation algorithm, the evidence builder and the
          // independent replay interpreter) and belongs to none of them.
          include: [
            'src/**/*.test.ts',
            'src/**/*.test.tsx',
            'test/evidence/**/*.test.ts',
            'test/fixtures/**/*.test.ts',
            'test/worked-example/**/*.test.ts',
          ],
        },
      },
      {
        resolve: { alias: { '@': srcRoot } },
        test: {
          ...common,
          name: 'db',
          include: ['test/db/**/*.test.ts'],
          // Real Postgres over the network; no parallel writers against one local instance.
          fileParallelism: false,
          testTimeout: 60_000,
        },
      },
      {
        resolve: { alias: { '@': srcRoot } },
        test: {
          ...common,
          name: 'contract',
          include: ['test/contract/**/*.test.ts'],
          // A tool held past 10 s must surface `tool_failure`, so the bound is above that.
          testTimeout: 30_000,
        },
      },
      {
        resolve: { alias: { '@': srcRoot } },
        test: {
          ...common,
          name: 'transport',
          include: ['test/transport/**/*.test.ts'],
        },
      },
      {
        resolve: { alias: { '@': srcRoot } },
        test: {
          ...common,
          name: 'property',
          include: ['test/property/**/*.test.ts'],
          // 1000-iteration properties (P1, P3, P11, P12) need room.
          testTimeout: 300_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
      {
        resolve: { alias: { '@': srcRoot } },
        test: {
          ...common,
          name: 'e2e',
          include: ['test/e2e/**/*.test.ts'],
          testTimeout: 300_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        resolve: { alias: { '@': srcRoot } },
        test: {
          ...common,
          name: 'integration',
          // design.md's stage 11: "Integration tests: paging, retry/backoff, credential
          // rejection", advisory because it depends on an external service. Kept out of the
          // `unit` project on purpose — `unit` is stage 3, in-process with no network, and a
          // live-network test in it would make stage 3 fail on a Razorpay outage.
          include: ['test/integration/**/*.test.ts'],
          // A live traversal of nine object types pages over the network, and the recon
          // report is one request per month of the window.
          testTimeout: 900_000,
          hookTimeout: 900_000,
          // Real Razorpay and one local Postgres; no parallel talkers to either.
          fileParallelism: false,
        },
      },
    ],
  },
});
