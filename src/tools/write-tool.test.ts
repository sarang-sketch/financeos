/**
 * The write-capable tool gate (task 24.3). Requirement 12.10, and 12.7 for the Tenant.
 *
 * `./tool.test.ts` already proves the **invoker's** gate: a `write_capable` invocation
 * whose session carries no resolving pair is refused at step 2 with no connection
 * acquired. This file proves the second gate — the one a **direct `execute` call** meets,
 * which is the bypass `./write-tool.ts` exists for — and it proves the thing that makes
 * the gate more than a convention: the tool body is not reachable, and neither is any
 * `WriteSeam`, without the token the gate mints.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ToolContext, ToolResult } from './tool';
import {
  createWriteCapableTool,
  UNAUTHORIZED_WRITE,
  type AuthorizedWrite,
  type WriteCapableToolGate,
  type WriteSeam,
} from './write-tool';
import {
  approval,
  authorizationLookup,
  AUTHORIZATION_ID,
  AUTHORIZED_PROPOSAL,
  PROPOSAL_ID,
  recordingWriteAudit,
  WRITE_ACTOR,
  WRITE_NOW,
  WRITE_TENANT,
  writeContext,
  writeGate,
} from './write-tools.test-support';

const inputSchema = z.strictObject({ note_id: z.uuid() });
const outputSchema = z.strictObject({ wrote: z.literal(true), proposal_id: z.uuid() });

type SpecimenIn = z.infer<typeof inputSchema>;
type SpecimenOut = z.infer<typeof outputSchema>;

const NOTE_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';

/** A write seam that records the token every reached write was made under. */
function countingSeam(): {
  readonly seam: WriteSeam<{ write(): void }>;
  readonly writes: string[];
} {
  const writes: string[] = [];
  return {
    writes,
    seam: (_ctx: ToolContext, authorized: AuthorizedWrite) => ({
      write: (): void => {
        writes.push(authorized.authorization_id);
      },
    }),
  };
}

/** A specimen whose only write is behind a `WriteSeam`, as both real tools are. */
function specimen(options: {
  readonly seam: WriteSeam<{ write(): void }>;
  readonly gate?: WriteCapableToolGate;
}) {
  const tokens: AuthorizedWrite[] = [];
  const tool = createWriteCapableTool<SpecimenIn, SpecimenOut>(
    {
      name: 'specimen_write_tool',
      inputSchema,
      outputSchema,
      execute(
        ctx: ToolContext,
        _input: SpecimenIn,
        authorized: AuthorizedWrite,
      ): Promise<ToolResult<SpecimenOut>> {
        tokens.push(authorized);
        // The only expression that can start a write, and it needs the token.
        options.seam(ctx, authorized).write();
        return Promise.resolve({
          ok: true,
          value: { wrote: true, proposal_id: authorized.proposal_id },
          evidence: {
            evidence_chain_id: '99999999-9999-4999-8999-999999999999',
            figure_paise: 0n,
            sources: [{ type: 'proposal', id: authorized.proposal_id }],
            source_count: 1,
            steps: [],
            as_of: '2026-07-30T09:00:00.000Z',
            produced_by: 'specimen_write_tool',
          },
        });
      },
    },
    options.gate ?? writeGate(),
  );
  return { tool, tokens };
}

/** Every shape of invocation the gate must refuse, and what it was carrying. */
const REFUSALS: readonly { readonly label: string; readonly session: Partial<ToolContext> }[] = [
  { label: 'neither identifier', session: { proposal_id: undefined, authorization_id: undefined } },
  { label: 'no proposal_id', session: { proposal_id: undefined } },
  { label: 'no authorization_id', session: { authorization_id: undefined } },
  { label: 'a proposal_id that is not a UUID', session: { proposal_id: 'prop_9281' } },
  { label: 'an authorization_id that is not a UUID', session: { authorization_id: 'auth_9281' } },
];

describe('createWriteCapableTool', () => {
  it('declares write_capable with the literal 10 s bound and hands the body a token', async () => {
    const { seam, writes } = countingSeam();
    const { tool, tokens } = specimen({ seam });

    expect(tool.mode).toBe('write_capable');
    expect(tool.timeoutMs).toBe(10_000);

    const result = await tool.execute(writeContext(), { note_id: NOTE_ID });
    expect(result.ok).toBe(true);
    expect(writes).toEqual([AUTHORIZATION_ID]);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.proposal_id).toBe(PROPOSAL_ID);
    expect(tokens[0]?.authorization_id).toBe(AUTHORIZATION_ID);
    // The token carries the **session** Tenant. No argument could have supplied one.
    expect(tokens[0]?.tenant_id).toBe(WRITE_TENANT);
  });

  it('asks the lookup with the session Tenant and the session pair', async () => {
    const lookup = authorizationLookup();
    const { seam } = countingSeam();
    const { tool } = specimen({ seam, gate: writeGate({ authorization: lookup }) });

    await tool.execute(writeContext(), { note_id: NOTE_ID });

    expect(lookup.asked).toEqual([
      { tenantId: WRITE_TENANT, proposalId: PROPOSAL_ID, authorizationId: AUTHORIZATION_ID },
    ]);
  });

  for (const { label, session } of REFUSALS) {
    it(`refuses an invocation carrying ${label}, reaching no seam and appending unauthorized_write_rejected`, async () => {
      const audit = recordingWriteAudit();
      const lookup = authorizationLookup();
      const { seam, writes } = countingSeam();
      const { tool, tokens } = specimen({
        seam,
        gate: writeGate({ audit, authorization: lookup }),
      });
      const ctx = writeContext(session);

      const result = await tool.execute(ctx, { note_id: NOTE_ID });

      expect(result).toEqual(UNAUTHORIZED_WRITE);
      // Tenant state is unchanged because nothing was called, not because something was
      // rolled back: neither the body nor the write seam ran.
      expect(tokens).toEqual([]);
      expect(writes).toEqual([]);
      // A malformed identifier is never asked about: it cannot resolve, and asking is a
      // database round trip that discloses timing.
      expect(lookup.asked).toEqual([]);
      expect(audit.events).toEqual([
        {
          tenantId: WRITE_TENANT,
          eventType: 'unauthorized_write_rejected',
          actor: WRITE_ACTOR,
          outcome: 'blocked',
          sourceRefs: [],
          payload: {
            tool: 'specimen_write_tool',
            mode: 'write_capable',
            reason: 'missing_authorized_proposal',
            // Which barrier caught it. The invoker's gate writes no `gate` key.
            gate: 'tool',
            proposal_id_supplied: ctx.proposal_id !== undefined,
            authorization_id_supplied: ctx.authorization_id !== undefined,
          },
          occurredAt: WRITE_NOW().toISOString(),
        },
      ]);
    });
  }

  it('refuses a recorded-but-rejected Authorization and another Tenant identically', async () => {
    const audit = recordingWriteAudit();
    const { seam, writes } = countingSeam();
    const { tool } = specimen({
      seam,
      gate: writeGate({
        audit,
        authorization: authorizationLookup([
          {
            ...AUTHORIZED_PROPOSAL,
            state: 'rejected',
            authorizations: [approval(PROPOSAL_ID, AUTHORIZATION_ID, { decision: 'rejected' })],
          },
        ]),
      }),
    });

    const declined = await tool.execute(writeContext(), { note_id: NOTE_ID });
    // A Proposal of this Tenant whose only Authorization is a rejection.
    expect(declined).toEqual(UNAUTHORIZED_WRITE);

    const foreign = await tool.execute(writeContext({ tenant_id: OTHER_TENANT }), {
      note_id: NOTE_ID,
    });
    // The same refusal, so nothing about another Tenant's Proposal is disclosed
    // (Requirement 14.4).
    expect(foreign).toEqual(declined);

    expect(writes).toEqual([]);
    expect(audit.events.map((event) => event.eventType)).toEqual([
      'unauthorized_write_rejected',
      'unauthorized_write_rejected',
    ]);
    expect(audit.events.map((event) => event.tenantId)).toEqual([WRITE_TENANT, OTHER_TENANT]);
  });

  it('propagates an Audit sink failure rather than refusing with no record of it', async () => {
    const { seam } = countingSeam();
    const { tool } = specimen({
      seam,
      gate: writeGate({ audit: recordingWriteAudit({ fail: true }) }),
    });

    await expect(
      tool.execute(writeContext({ proposal_id: undefined }), { note_id: NOTE_ID }),
    ).rejects.toThrow(/audit sink unavailable/);
  });

  it('carries a declared free-text allowance through, and omits the key when there is none', () => {
    const { seam } = countingSeam();
    const allowed = createWriteCapableTool<SpecimenIn, SpecimenOut>(
      {
        name: 'specimen_write_tool',
        inputSchema,
        outputSchema,
        freeTextArguments: ['note_id'],
        execute: () => Promise.reject(new Error('not reached')),
      },
      writeGate(),
    );
    expect(allowed.freeTextArguments).toEqual(['note_id']);
    // Absent rather than an empty array, so a reader has nothing to interpret.
    expect(specimen({ seam }).tool.freeTextArguments).toBeUndefined();
  });
});
