/**
 * `mark_exception_resolved` (task 24.3).
 * Requirements 3.5, 4.12, 4.15, 5.11, 12.2, 12.3, 12.7, 12.10.
 *
 * Two things this file is here to pin down. The **lifecycle** is one-way: only an `open`
 * Exception is resolved, an already-`resolved` one is reported with its original closure
 * time and **no** write, and a `dismissed` one is refused rather than rewritten
 * (Requirement 4.12, 4.15). And the tool **composes no Evidence_Chain**: a resolution
 * derives no figure, so the envelope is the Exception's own persisted chain.
 */

import { describe, expect, it } from 'vitest';

import {
  exceptionWithChain,
  MemoryEvidenceStore,
  MemoryExceptionStore,
  OTHER_TENANT,
} from './exception-tools.test-support';
import {
  catalogueEntryFor,
  createMarkExceptionResolved,
  EXCEPTION_RESOLUTION_STATE_PROBE_SQL,
  EXCEPTION_RESOLVE_SQL,
  exceptionResolveParams,
  MARK_EXCEPTION_RESOLVED,
  MAX_RESOLUTION_NOTE_LENGTH,
  type MarkExceptionResolvedDeps,
} from './mark-exception-resolved';
import { createToolRegistry } from './registry';
import type { ToolContext } from './tool';
import {
  absentResolutionStore,
  exceptionResolutionStore,
  notOpenResolutionStore,
  recordingWriteAudit,
  WRITE_NOW,
  WRITE_TENANT,
  WRITE_USER,
  writeContext,
  writeGate,
} from './write-tools.test-support';

const EXCEPTION_ID = '10000000-0000-4000-8000-000000000001';
const FOREIGN_ID = '10000000-0000-4000-8000-000000000099';
const NOTE = 'Settlement shortfall traced to a fee variance and adjusted.';
const RESOLVED_AT = WRITE_NOW().toISOString();

const VALID_INPUT = { exception_id: EXCEPTION_ID, resolution_note: NOTE };

interface World {
  readonly chains: MemoryEvidenceStore;
  readonly resolution: ReturnType<typeof exceptionResolutionStore>;
  readonly deps: MarkExceptionResolvedDeps;
  readonly chainId: string;
}

async function world(
  options: {
    readonly state?: 'open' | 'resolved' | 'dismissed';
    readonly tenantId?: string;
    readonly exceptionId?: string;
    /** Point the Exception at a chain that is stored nowhere (Requirement 12.3). */
    readonly hideChain?: boolean;
  } = {},
): Promise<World> {
  const chains = new MemoryEvidenceStore();
  const exceptionId = options.exceptionId ?? EXCEPTION_ID;
  const stored = await exceptionWithChain({
    store: chains,
    exceptionId,
    impact: 2_320_000n,
    state: options.state ?? 'open',
    ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
  });
  const exception =
    options.hideChain === true
      ? { ...stored, evidence_chain_id: '00000000-0000-4000-8000-0000000000ff' }
      : stored;
  const resolution = exceptionResolutionStore({ known: [exceptionId] });
  return {
    chains,
    resolution,
    chainId: exception.evidence_chain_id,
    deps: {
      exceptions: () => new MemoryExceptionStore([exception]),
      resolution: () => resolution,
      chains: () => chains,
      now: WRITE_NOW,
    },
  };
}

function toolFor(built: World, deps: Partial<MarkExceptionResolvedDeps> = {}) {
  return createMarkExceptionResolved({ ...built.deps, ...deps }, writeGate());
}

describe('mark_exception_resolved', () => {
  it('resolves an open Exception, attributing it to the authorizing User', async () => {
    const built = await world();
    const chainsBefore = built.chains.writes.length;

    const result = await toolFor(built).execute(writeContext(), VALID_INPUT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      exception_id: EXCEPTION_ID,
      lifecycle_state: 'resolved',
      resolved_at: RESOLVED_AT,
    });
    expect(built.resolution.resolved).toEqual([
      {
        exception_id: EXCEPTION_ID,
        resolution_note: NOTE,
        resolved_at: RESOLVED_AT,
        // `resolved_by` is the session User whose Authorization the write rests on.
        resolved_by: WRITE_USER,
      },
    ]);
    // No new chain: a resolution derives no figure, so the envelope is the Exception's
    // own persisted chain.
    expect(built.chains.writes).toHaveLength(chainsBefore);
    expect(result.evidence.evidence_chain_id).toBe(built.chainId);
    expect(result.evidence.figure_paise).toBe(2_320_000n);
    expect(result.evidence.produced_by).toBe('exception_detector');
  });

  it('reports an already-resolved Exception with its original closure time and writes nothing', async () => {
    const built = await world({ state: 'resolved' });

    const result = await toolFor(built).execute(writeContext(), VALID_INPUT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The stored `resolved_at` stands: re-stamping it would overwrite when the Exception
    // was actually closed.
    expect(result.value.resolved_at).toBe('2026-07-29T00:00:00.000Z');
    expect(built.resolution.resolved).toEqual([]);
  });

  it('refuses a dismissed Exception rather than replacing one closure with another', async () => {
    const built = await world({ state: 'dismissed' });

    await expect(toolFor(built).execute(writeContext(), VALID_INPUT)).rejects.toThrow(
      /is dismissed, so it is already closed/,
    );
    expect(built.resolution.resolved).toEqual([]);
  });

  it('refuses when the open guard declines between the read and the write', async () => {
    const built = await world();
    const raced = toolFor(built, { resolution: () => notOpenResolutionStore('resolved') });

    await expect(raced.execute(writeContext(), VALID_INPUT)).rejects.toThrow(
      /became resolved between the read and the write/,
    );
  });

  it('refuses when the Exception disappears between the read and the write', async () => {
    const built = await world();
    const vanished = toolFor(built, { resolution: () => absentResolutionStore });

    await expect(vanished.execute(writeContext(), VALID_INPUT)).rejects.toThrow(/disappeared/);
  });

  it('makes another Tenant’s Exception indistinguishable from an absent one', async () => {
    const built = await world({ exceptionId: FOREIGN_ID, tenantId: OTHER_TENANT });

    await expect(
      toolFor(built).execute(writeContext(), {
        exception_id: FOREIGN_ID,
        resolution_note: NOTE,
      }),
    ).rejects.toThrow(/no Exception .* for this Tenant/);
    expect(built.resolution.resolved).toEqual([]);
  });

  it('withholds the result and writes nothing when the Exception chain cannot be read', async () => {
    const built = await world({ hideChain: true });

    const result = await toolFor(built).execute(writeContext(), VALID_INPUT);

    expect(result).toEqual({
      ok: false,
      kind: 'incomplete_evidence',
      unavailable: [{ type: 'payment', count: 1 }],
    });
    // Ordered before the write, so Tenant state is untouched without a rollback.
    expect(built.resolution.resolved).toEqual([]);
  });

  it('refuses an invocation with no authorized Proposal, writing no transition', async () => {
    const built = await world();
    const audit = recordingWriteAudit();
    const gated = createMarkExceptionResolved(built.deps, writeGate({ audit }));

    const result = await gated.execute(
      writeContext({ proposal_id: undefined, authorization_id: undefined }),
      VALID_INPUT,
    );

    expect(result).toEqual({
      ok: false,
      kind: 'unauthorized_write',
      reason: 'missing_authorized_proposal',
    });
    expect(built.resolution.resolved).toEqual([]);
    expect(audit.events.map((event) => [event.eventType, event.payload['tool']])).toEqual([
      ['unauthorized_write_rejected', MARK_EXCEPTION_RESOLVED],
    ]);
  });

  it('stops before writing when the 10 s bound has already elapsed', async () => {
    const built = await world();
    const aborted = new AbortController();
    aborted.abort();
    const ctx: ToolContext = writeContext({ signal: aborted.signal });

    await expect(toolFor(built).execute(ctx, VALID_INPUT)).rejects.toThrow(/aborted/);
    expect(built.resolution.resolved).toEqual([]);
  });

  it('bounds the one prose argument, declares the allowance, and registers as write_capable', async () => {
    const built = await world();
    const tool = toolFor(built);

    expect(tool.freeTextArguments).toEqual(['resolution_note']);
    expect(tool.inputSchema.safeParse(VALID_INPUT).success).toBe(true);
    expect(
      tool.inputSchema.safeParse({
        ...VALID_INPUT,
        resolution_note: 'a'.repeat(MAX_RESOLUTION_NOTE_LENGTH + 1),
      }).success,
    ).toBe(false);
    // `detail` is JSONB, which rejects `\u0000` outright (SQLSTATE 22P05).
    expect(
      tool.inputSchema.safeParse({ ...VALID_INPUT, resolution_note: 'closed\u0000note' }).success,
    ).toBe(false);
    expect(tool.inputSchema.safeParse({ ...VALID_INPUT, resolution_note: '' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ ...VALID_INPUT, tenant_id: WRITE_TENANT }).success).toBe(
      false,
    );
    expect(tool.inputSchema.safeParse({ ...VALID_INPUT, exception_id: 'exc_1' }).success).toBe(
      false,
    );

    const registry = createToolRegistry([catalogueEntryFor(built.deps, writeGate())]);
    expect(registry.names()).toEqual([MARK_EXCEPTION_RESOLVED]);
    expect(registry.byMode('write_capable')).toHaveLength(1);
  });

  it('guards the UPDATE on the open state and merges the note into detail', () => {
    // The guard is in the `WHERE` clause, which is what makes two concurrent
    // resolutions resolve once rather than twice.
    expect(EXCEPTION_RESOLVE_SQL).toContain("AND lifecycle_state = 'open'");
    // `resolved_at` and `lifecycle_state` move together: their agreement is a CHECK.
    expect(EXCEPTION_RESOLVE_SQL).toContain("lifecycle_state = 'resolved'");
    expect(EXCEPTION_RESOLVE_SQL).toMatch(/resolved_at\s+= \$4::timestamptz/);
    expect(EXCEPTION_RESOLVE_SQL).toMatch(/resolved_by\s+= \$5::uuid/);
    // Merged, not replaced: the detection payload survives key for key.
    expect(EXCEPTION_RESOLVE_SQL).toMatch(
      /detail\s+= detail \|\| jsonb_build_object\('resolution_note', \$3::text\)/,
    );
    // A resolution is not a detection, so neither detection timestamp is touched.
    expect(EXCEPTION_RESOLVE_SQL).not.toContain('last_detected_at');
    // The probe distinguishes "not open" from "no such Exception for this Tenant".
    expect(EXCEPTION_RESOLUTION_STATE_PROBE_SQL).toContain('WHERE tenant_id = $1');

    expect(
      exceptionResolveParams(WRITE_TENANT, {
        exception_id: EXCEPTION_ID,
        resolution_note: NOTE,
        resolved_at: RESOLVED_AT,
        resolved_by: WRITE_USER,
      }),
    ).toEqual([WRITE_TENANT, EXCEPTION_ID, NOTE, RESOLVED_AT, WRITE_USER]);
  });
});
