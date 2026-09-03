/**
 * The Evidence_Chain builder, in process (task 9.1).
 *
 * Two halves. First the **composition funnel**, which is a pure function: every
 * invariant the database does not check — gapless 1-based `step_index`,
 * backward-only step references, every source operand cited, `source_count >= 1`,
 * a range-checked `result_paise`, a figure equal to the terminal step's result —
 * is asserted here, because here is where it is enforced and because a rejection
 * that reached a statement would already be too late.
 *
 * Second the **service over a fake store**, where the assertion is about calls
 * rather than rows: `incomplete_evidence` and every malformed chain must issue
 * **zero** statements, which a fake can count and a database cannot. Pagination
 * is exercised at the 500 boundary against an in-memory table, so the keyset walk
 * is proven independently of SQL; `test/db/evidence-chain.test.ts` then proves the
 * same boundary against real Postgres, where the ordering and the grouping live.
 *
 * Requirements: 12.2, 12.3, 12.5.
 */

import { describe, expect, it } from 'vitest';

import { PaiseRangeError } from '@/calc/paise';
import {
  composeEvidenceChain,
  createEvidenceChainBuilder,
  EvidenceChainError,
  type EvidenceChainHeaderRow,
  type EvidenceChainInput,
  type EvidenceChainStepRow,
  type EvidenceChainStore,
  type EvidenceChainWrite,
  evidenceChainWriteFor,
  incompleteEvidence,
  MAX_SOURCE_PAGE_SIZE,
  MAX_STEP_INDEX,
  parseEvidenceOperands,
  type EvidenceSourcePage,
  type EvidenceSourceRow,
  type EvidenceStep,
} from './chain-builder';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CHAIN = '92810000-0000-4281-8281-000000009281';
const UPDATED = '2026-07-28T00:00:00.000Z';
const NEWER = '2026-07-29T06:15:00.000Z';

/* -------------------------------------------------------------------------- */
/* A small, well-formed specimen: (a.amount + b.amount) − 1000                 */
/* -------------------------------------------------------------------------- */

const OK_INPUT: EvidenceChainInput = {
  produced_by: 'get_cash_position',
  figure_paise: 149_000n,
  steps: [
    {
      index: 1,
      operation: 'sum',
      operands: [
        { kind: 'source', ref: { type: 'payment', id: 'pay_a' }, field: 'amount' },
        { kind: 'source', ref: { type: 'payment', id: 'pay_b' }, field: 'amount' },
      ],
      result_paise: 150_000n,
      note: 'Σ two Payment amounts',
    },
    {
      index: 2,
      operation: 'subtract',
      operands: [
        { kind: 'step', index: 1 },
        { kind: 'literal', value: '1000' },
      ],
      result_paise: 149_000n,
    },
  ],
  sources: [
    { ref: { type: 'payment', id: 'pay_b' }, field: 'amount', record_updated_at: NEWER },
    { ref: { type: 'payment', id: 'pay_a' }, field: 'amount', record_updated_at: UPDATED },
  ],
};

/** `OK_INPUT` with one field replaced. */
function inputWith(patch: Partial<EvidenceChainInput>): EvidenceChainInput {
  return { ...OK_INPUT, ...patch };
}

/** `OK_INPUT`'s steps with the step at `position` replaced. */
function stepsWith(position: number, patch: Partial<EvidenceStep>): readonly EvidenceStep[] {
  return OK_INPUT.steps.map((step, index) =>
    index === position ? ({ ...step, ...patch } as EvidenceStep) : step,
  );
}

/* -------------------------------------------------------------------------- */
/* composeEvidenceChain — the accepted chain                                   */
/* -------------------------------------------------------------------------- */

describe('composeEvidenceChain: what it derives', () => {
  const draft = composeEvidenceChain(OK_INPUT);

  it('takes as_of from the newest contributing record, not the first', () => {
    expect(draft.as_of).toBe(NEWER);
  });

  it('counts distinct identifiers, and lists them in first-citation order', () => {
    expect(draft.source_count).toBe(2);
    expect(draft.sources).toEqual([
      { type: 'payment', id: 'pay_b' },
      { type: 'payment', id: 'pay_a' },
    ]);
  });

  it('orders the citations by the identity key, so the insert order is stable', () => {
    expect(draft.citations.map((c) => `${c.ref.type}/${c.ref.id}/${c.field}`)).toEqual([
      'payment/pay_a/amount',
      'payment/pay_b/amount',
    ]);
  });

  it('keeps the steps exactly as stated', () => {
    expect(draft.steps).toEqual(OK_INPUT.steps);
    expect(draft.figure_paise).toBe(149_000n);
    expect(draft.produced_by).toBe('get_cash_position');
  });

  it('collapses a repeated citation of the same field at the same timestamp', () => {
    // One (record, field) is one evidence_chain_sources row — the primary key
    // admits no more — and reading a field in two steps is not an error.
    const draft2 = composeEvidenceChain(
      inputWith({
        sources: [
          ...OK_INPUT.sources,
          { ref: { type: 'payment', id: 'pay_a' }, field: 'amount', record_updated_at: UPDATED },
        ],
      }),
    );
    expect(draft2.citations).toHaveLength(2);
    expect(draft2.source_count).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* composeEvidenceChain — the rejection funnel                                */
/* -------------------------------------------------------------------------- */

describe('composeEvidenceChain: the invariants the schema does not check', () => {
  it('rejects a chain citing no Source_Record', () => {
    expect(() => composeEvidenceChain(inputWith({ sources: [] }))).toThrow(EvidenceChainError);
  });

  it('rejects a chain with no steps', () => {
    expect(() => composeEvidenceChain(inputWith({ steps: [] }))).toThrow(/at least 1 computation step/);
  });

  it('rejects a gap in the step indexes', () => {
    // (1, 3): the schema stores it happily and a replay then has nothing to read.
    expect(() => composeEvidenceChain(inputWith({ steps: stepsWith(1, { index: 3 }) }))).toThrow(
      /gapless/,
    );
  });

  it('rejects steps that are not in index order', () => {
    expect(() =>
      composeEvidenceChain(inputWith({ steps: [...OK_INPUT.steps].reverse() })),
    ).toThrow(/declares index 2, expected 1/);
  });

  it('rejects an operand referencing a later step', () => {
    expect(() =>
      composeEvidenceChain(
        inputWith({
          steps: stepsWith(1, {
            operands: [
              { kind: 'step', index: 5 },
              { kind: 'literal', value: '1000' },
            ],
          }),
        }),
      ),
    ).toThrow(/not a \*preceding\* step/);
  });

  it('rejects an operand referencing its own step', () => {
    expect(() =>
      composeEvidenceChain(
        inputWith({
          steps: stepsWith(1, {
            operands: [
              { kind: 'step', index: 2 },
              { kind: 'literal', value: '1000' },
            ],
          }),
        }),
      ),
    ).toThrow(/not a \*preceding\* step/);
  });

  it('rejects a source operand the chain does not cite', () => {
    expect(() =>
      composeEvidenceChain(
        inputWith({
          steps: stepsWith(0, {
            operands: [
              { kind: 'source', ref: { type: 'payment', id: 'pay_a' }, field: 'amount' },
              { kind: 'source', ref: { type: 'payment', id: 'pay_uncited' }, field: 'amount' },
            ],
          }),
        }),
      ),
    ).toThrow(/which the chain does not cite/);
  });

  it('rejects a source operand citing a field the chain did not read', () => {
    expect(() =>
      composeEvidenceChain(
        inputWith({
          steps: stepsWith(0, {
            operands: [
              { kind: 'source', ref: { type: 'payment', id: 'pay_a' }, field: 'fee' },
              { kind: 'source', ref: { type: 'payment', id: 'pay_b' }, field: 'amount' },
            ],
          }),
        }),
      ),
    ).toThrow(/which the chain does not cite/);
  });

  it('rejects two timestamps for one cited field', () => {
    expect(() =>
      composeEvidenceChain(
        inputWith({
          sources: [
            ...OK_INPUT.sources,
            { ref: { type: 'payment', id: 'pay_a' }, field: 'amount', record_updated_at: NEWER },
          ],
        }),
      ),
    ).toThrow(/one Source_Record field has one update timestamp/);
  });

  it('rejects a terminal step with no monetary result', () => {
    expect(() =>
      composeEvidenceChain(inputWith({ steps: stepsWith(1, { result_paise: null }) })),
    ).toThrow(/terminal step .* must carry a monetary result/);
  });

  it('rejects a figure that is not the terminal step result', () => {
    expect(() => composeEvidenceChain(inputWith({ figure_paise: 2_320_000n }))).toThrow(
      /is not the result of terminal step/,
    );
  });

  it('rejects a result outside the paise range, through the one shared guard', () => {
    expect(() =>
      composeEvidenceChain(
        inputWith({
          figure_paise: 100_000_000_000_000n,
          steps: stepsWith(1, { result_paise: 100_000_000_000_000n }),
        }),
      ),
    ).toThrow(PaiseRangeError);
  });

  it('rejects a fixed-arity operation with the wrong operand count', () => {
    expect(() =>
      composeEvidenceChain(
        inputWith({
          steps: stepsWith(1, {
            operands: [
              { kind: 'step', index: 1 },
              { kind: 'literal', value: '500' },
              { kind: 'literal', value: '500' },
            ],
          }),
        }),
      ),
    ).toThrow(/takes exactly 2/);
  });

  it('accepts sum over a single operand, which SET-9281 step 2 needs', () => {
    expect(() =>
      composeEvidenceChain(
        inputWith({
          steps: stepsWith(0, {
            operands: [
              { kind: 'source', ref: { type: 'payment', id: 'pay_a' }, field: 'amount' },
            ],
          }),
          sources: [
            { ref: { type: 'payment', id: 'pay_a' }, field: 'amount', record_updated_at: UPDATED },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a record_updated_at that is not ISO-8601 UTC to the millisecond', () => {
    expect(() =>
      composeEvidenceChain(
        inputWith({
          sources: [
            { ref: { type: 'payment', id: 'pay_a' }, field: 'amount', record_updated_at: UPDATED },
            {
              ref: { type: 'payment', id: 'pay_b' },
              field: 'amount',
              record_updated_at: '2026-07-28 00:00:00+00',
            },
          ],
        }),
      ),
    ).toThrow(/ISO-8601 UTC to millisecond precision/);
  });

  it('rejects an empty produced_by and an empty cited field', () => {
    expect(() => composeEvidenceChain(inputWith({ produced_by: '  ' }))).toThrow(/produced_by/);
    expect(() =>
      composeEvidenceChain(
        inputWith({
          sources: [
            { ref: { type: 'payment', id: 'pay_a' }, field: '', record_updated_at: UPDATED },
            { ref: { type: 'payment', id: 'pay_b' }, field: 'amount', record_updated_at: UPDATED },
          ],
        }),
      ),
    ).toThrow(/field must be a non-empty string/);
  });

  it('rejects more steps than a SMALLINT step_index can hold', () => {
    const steps: EvidenceStep[] = [
      {
        index: 1,
        operation: 'sum',
        operands: [{ kind: 'source', ref: { type: 'payment', id: 'pay_a' }, field: 'amount' }],
        result_paise: 0n,
      },
    ];
    for (let index = 2; index <= MAX_STEP_INDEX + 1; index += 1) {
      steps.push({
        index,
        operation: 'negate',
        operands: [{ kind: 'step', index: index - 1 }],
        result_paise: 0n,
      });
    }
    const input = inputWith({
      figure_paise: 0n,
      steps,
      sources: [
        { ref: { type: 'payment', id: 'pay_a' }, field: 'amount', record_updated_at: UPDATED },
      ],
    });
    expect(() => composeEvidenceChain(input)).toThrow(/at most 32767 steps/);
    // One fewer step is exactly at the bound and is accepted.
    expect(() =>
      composeEvidenceChain({ ...input, steps: steps.slice(0, MAX_STEP_INDEX) }),
    ).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* incomplete_evidence (Requirement 12.3)                                     */
/* -------------------------------------------------------------------------- */

describe('incompleteEvidence', () => {
  it('counts distinct identifiers per type, in enum order, with no figure field', () => {
    const result = incompleteEvidence([
      { type: 'settlement', id: 'setl_1' },
      { type: 'payment', id: 'pay_1' },
      { type: 'payment', id: 'pay_2' },
      // The same record noticed twice is one unavailable record.
      { type: 'payment', id: 'pay_1' },
    ]);
    expect(result).toEqual({
      ok: false,
      kind: 'incomplete_evidence',
      unavailable: [
        { type: 'payment', count: 2 },
        { type: 'settlement', count: 1 },
      ],
    });
    // Requirement 12.3: the figure is omitted entirely, not zeroed or nulled.
    expect(Object.keys(result)).not.toContain('figure_paise');
  });

  it('refuses to state incomplete evidence with nothing unavailable', () => {
    expect(() => incompleteEvidence([])).toThrow(EvidenceChainError);
  });
});

/* -------------------------------------------------------------------------- */
/* Row mapping                                                                */
/* -------------------------------------------------------------------------- */

describe('evidenceChainWriteFor', () => {
  const write = evidenceChainWriteFor(TENANT, composeEvidenceChain(OK_INPUT));

  it('maps the in-memory `index` onto the `step_index` column', () => {
    expect(write.steps.map((s) => s.step_index)).toEqual([1, 2]);
  });

  it('writes every monetary value as an integer string', () => {
    expect(write.figure_paise).toBe('149000');
    expect(write.steps.map((s) => s.result_paise)).toEqual(['150000', '149000']);
  });

  it('writes operands as JSON text and an absent note as null', () => {
    expect(JSON.parse(write.steps[1]?.operands_json ?? '')).toEqual([
      { kind: 'step', index: 1 },
      { kind: 'literal', value: '1000' },
    ]);
    expect(write.steps[1]?.note).toBeNull();
    expect(write.steps[0]?.note).toBe('Σ two Payment amounts');
  });

  it('stamps the Tenant on the header and on every citation', () => {
    expect(write.tenant_id).toBe(TENANT);
    expect(write.sources.every((s) => s.tenant_id === TENANT)).toBe(true);
    expect(write.source_count).toBe(2);
    expect(write.as_of).toBe(NEWER);
  });
});

describe('parseEvidenceOperands', () => {
  it('accepts operands whose keys came back in a different order', () => {
    // JSONB reorders keys; the parse is structural, never textual.
    expect(
      parseEvidenceOperands(
        [{ field: 'amount', ref: { id: 'pay_a', type: 'payment' }, kind: 'source' }],
        'step 1',
      ),
    ).toEqual([{ kind: 'source', ref: { type: 'payment', id: 'pay_a' }, field: 'amount' }]);
  });

  it('rejects a monetary literal that came back as a JSON number', () => {
    expect(() => parseEvidenceOperands([{ kind: 'literal', value: 1000 }], 'step 1')).toThrow(
      /non-string literal/,
    );
  });

  it('rejects an unknown kind, a non-array, and an empty array', () => {
    expect(() => parseEvidenceOperands([{ kind: 'account' }], 'step 1')).toThrow(/unknown operand kind/);
    expect(() => parseEvidenceOperands({ kind: 'step', index: 1 }, 'step 1')).toThrow(/not a JSON array/);
    expect(() => parseEvidenceOperands([], 'step 1')).toThrow(/operands is empty/);
  });

  it('rejects a step operand that is not a 1-based ordinal', () => {
    expect(() => parseEvidenceOperands([{ kind: 'step', index: 0 }], 'step 2')).toThrow(
      /1-based ordinal/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The service over a fake store                                              */
/* -------------------------------------------------------------------------- */

interface FakeStore extends EvidenceChainStore {
  readonly writes: EvidenceChainWrite[];
  calls: number;
}

/**
 * An in-memory stand-in for the three tables. `listSourcePage` sorts by the same
 * total key the SQL adapter orders by, so the keyset walk under test is the real
 * one; the SQL side of that order is proven in `test/db/evidence-chain.test.ts`.
 */
function fakeStore(options?: {
  readonly header?: EvidenceChainHeaderRow | null;
  readonly steps?: readonly EvidenceChainStepRow[];
  readonly sources?: readonly EvidenceSourceRow[];
}): FakeStore {
  const store: FakeStore = {
    writes: [],
    calls: 0,
    insertChain(write: EvidenceChainWrite) {
      store.calls += 1;
      store.writes.push(write);
      return Promise.resolve({ ok: true as const, chain_id: CHAIN });
    },
    findChain() {
      store.calls += 1;
      return Promise.resolve(options?.header ?? null);
    },
    listSteps() {
      store.calls += 1;
      return Promise.resolve(options?.steps ?? []);
    },
    listSourcePage(query) {
      store.calls += 1;
      const all = [...(options?.sources ?? [])].sort((a, b) =>
        `${a.source_record_type}\u0000${a.source_record_id}` <
        `${b.source_record_type}\u0000${b.source_record_id}`
          ? -1
          : 1,
      );
      const after = query.after;
      const remaining =
        after === null
          ? all
          : all.filter(
              (row) =>
                `${row.source_record_type}\u0000${row.source_record_id}` >
                `${after.type}\u0000${after.id}`,
            );
      return Promise.resolve(remaining.slice(0, query.limit));
    },
  };
  return store;
}

const builderOver = (store: EvidenceChainStore) =>
  createEvidenceChainBuilder({ store, tenantId: TENANT });

describe('build', () => {
  it('persists the chain once and returns it with the stored identifier', async () => {
    const store = fakeStore();
    const result = await builderOver(store).build(OK_INPUT);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.evidence).toEqual({
      evidence_chain_id: CHAIN,
      figure_paise: 149_000n,
      sources: [
        { type: 'payment', id: 'pay_b' },
        { type: 'payment', id: 'pay_a' },
      ],
      source_count: 2,
      steps: OK_INPUT.steps,
      as_of: NEWER,
      produced_by: 'get_cash_position',
    });
    expect(store.writes).toHaveLength(1);
  });

  it('returns incomplete_evidence and issues no statement at all', async () => {
    const store = fakeStore();
    const result = await builderOver(store).build(
      inputWith({ unreadable: [{ type: 'settlement_recon_report', id: 'setlrcn_1' }] }),
    );

    expect(result).toEqual({
      ok: false,
      kind: 'incomplete_evidence',
      unavailable: [{ type: 'settlement_recon_report', count: 1 }],
    });
    // Nothing attempted is the strongest form of "the figure is omitted".
    expect(store.calls).toBe(0);
  });

  it('issues no statement for a malformed chain', async () => {
    const store = fakeStore();
    await expect(builderOver(store).build(inputWith({ sources: [] }))).rejects.toThrow(
      EvidenceChainError,
    );
    expect(store.calls).toBe(0);
  });

  it('refuses to construct without the session Tenant as a UUID', () => {
    expect(() =>
      createEvidenceChainBuilder({ store: fakeStore(), tenantId: 'tenant-1' }),
    ).toThrow(/session Tenant identifier as a UUID/);
  });
});

describe('read', () => {
  const header: EvidenceChainHeaderRow = {
    chain_id: CHAIN,
    figure_paise: '149000',
    source_count: 2,
    as_of: NEWER,
    produced_by: 'get_cash_position',
  };
  const steps: readonly EvidenceChainStepRow[] = [
    {
      step_index: 2,
      operation: 'subtract',
      operands: [
        { kind: 'step', index: 1 },
        { kind: 'literal', value: '1000' },
      ],
      result_paise: '149000',
      note: null,
    },
    {
      step_index: 1,
      operation: 'sum',
      operands: [{ kind: 'source', ref: { type: 'payment', id: 'pay_a' }, field: 'amount' }],
      result_paise: '150000',
      note: 'Σ two Payment amounts',
    },
  ];
  const sources: readonly EvidenceSourceRow[] = [
    {
      source_record_type: 'payment',
      source_record_id: 'pay_b',
      fields: ['amount'],
      record_updated_at: NEWER,
    },
    {
      source_record_type: 'payment',
      source_record_id: 'pay_a',
      fields: ['amount', 'fee'],
      record_updated_at: UPDATED,
    },
  ];

  it('returns null for a chain this Tenant does not have', async () => {
    // Absent and "another Tenant's" are the same answer: an error that told them
    // apart would confirm existence.
    await expect(builderOver(fakeStore({ header: null })).read(CHAIN)).resolves.toBeNull();
  });

  it('orders the steps, decodes the money, and pages the sources', async () => {
    const view = await builderOver(fakeStore({ header, steps, sources })).read(CHAIN);
    expect(view).not.toBeNull();
    if (view === null) {
      return;
    }
    expect(view.figure_paise).toBe(149_000n);
    expect(view.steps.map((s) => s.index)).toEqual([1, 2]);
    expect(view.steps[0]?.result_paise).toBe(150_000n);
    expect(view.steps[1]?.note).toBeUndefined();
    expect(view.first_page.page_size).toBe(MAX_SOURCE_PAGE_SIZE);
    expect(view.first_page.next).toBeNull();
    expect(view.first_page.sources.map((s) => s.ref.id)).toEqual(['pay_a', 'pay_b']);
    expect(view.first_page.sources[0]?.fields).toEqual(['amount', 'fee']);
  });

  it('reports record_updated_at against as_of for the stale indicator', async () => {
    const view = await builderOver(fakeStore({ header, steps, sources })).read(CHAIN);
    const rows = view?.first_page.sources ?? [];
    expect(rows.map((s) => [s.record_updated_at, s.as_of, s.stale])).toEqual([
      [UPDATED, NEWER, false],
      [NEWER, NEWER, false],
    ]);

    // A record updated after the chain was composed is what the UI marks stale.
    const staleView = await builderOver(
      fakeStore({
        header: { ...header, as_of: UPDATED },
        steps,
        sources,
      }),
    ).read(CHAIN);
    expect(staleView?.first_page.sources.map((s) => s.stale)).toEqual([false, true]);
  });

  it('rejects a chain identifier that is not a UUID, and an oversized page', async () => {
    const builder = builderOver(fakeStore({ header, steps, sources }));
    await expect(builder.read('not-a-uuid')).rejects.toThrow(/as a UUID/);
    await expect(builder.read(CHAIN, MAX_SOURCE_PAGE_SIZE + 1)).rejects.toThrow(
      /1\.\.500 identifiers/,
    );
  });

  it('rejects a stored chain whose step indexes have a gap', async () => {
    const gapped: readonly EvidenceChainStepRow[] = [
      { ...(steps[1] as EvidenceChainStepRow) },
      { ...(steps[0] as EvidenceChainStepRow), step_index: 4 },
    ];
    await expect(
      builderOver(fakeStore({ header, steps: gapped, sources })).read(CHAIN),
    ).rejects.toThrow(/not gapless/);
  });
});

describe('source pagination at the 500 boundary', () => {
  /** `total` identifiers, deliberately in an order the key sort has to fix. */
  function manySources(total: number): readonly EvidenceSourceRow[] {
    return Array.from({ length: total }, (_unused, index) => ({
      source_record_type: 'payment' as const,
      // Fixed width, so the text order is the numeric order and the expectation
      // below is readable.
      source_record_id: `pay_${String(total - index).padStart(6, '0')}`,
      fields: ['amount'],
      record_updated_at: UPDATED,
    }));
  }

  async function walk(total: number): Promise<readonly EvidenceSourcePage[]> {
    const store = fakeStore({
      header: {
        chain_id: CHAIN,
        figure_paise: '1',
        source_count: total,
        as_of: UPDATED,
        produced_by: 'get_cash_position',
      },
      sources: manySources(total),
    });
    const pages: EvidenceSourcePage[] = [];
    for await (const page of builderOver(store).sourcePages(CHAIN)) {
      pages.push(page);
    }
    return pages;
  }

  it.each([
    [499, [499]],
    [500, [500]],
    [501, [500, 1]],
    [1000, [500, 500]],
    [1001, [500, 500, 1]],
  ])('pages %i identifiers as %j', async (total, expected) => {
    const pages = await walk(total);
    expect(pages.map((p) => p.sources.length)).toEqual(expected);
    // No page exceeds the cap, and only the last page has no successor.
    expect(pages.every((p) => p.sources.length <= MAX_SOURCE_PAGE_SIZE)).toBe(true);
    expect(pages.map((p) => p.next === null)).toEqual(
      expected.map((_size, index) => index === expected.length - 1),
    );
    expect(pages.map((p) => p.page_index)).toEqual(expected.map((_size, index) => index + 1));
  });

  it('yields every identifier exactly once, and source_count matches', async () => {
    const pages = await walk(1001);
    const ids = pages.flatMap((page) => page.sources.map((s) => s.ref.id));
    expect(ids).toHaveLength(1001);
    expect(new Set(ids).size).toBe(1001);
    expect(pages[0]?.source_count).toBe(1001);
    // Ascending in the identity key, across the page boundary.
    expect([...ids].sort()).toEqual(ids);
  });

  it('honours the 100-per-page size the drill-down UI uses', async () => {
    const store = fakeStore({
      header: {
        chain_id: CHAIN,
        figure_paise: '1',
        source_count: 250,
        as_of: UPDATED,
        produced_by: 'get_cash_position',
      },
      sources: manySources(250),
    });
    const pages: EvidenceSourcePage[] = [];
    for await (const page of builderOver(store).sourcePages(CHAIN, 100)) {
      pages.push(page);
    }
    expect(pages.map((p) => p.sources.length)).toEqual([100, 100, 50]);
  });

  it('yields nothing for a chain this Tenant does not have', async () => {
    const pages: EvidenceSourcePage[] = [];
    for await (const page of builderOver(fakeStore({ header: null })).sourcePages(CHAIN)) {
      pages.push(page);
    }
    expect(pages).toEqual([]);
    await expect(builderOver(fakeStore({ header: null })).sourcePage(CHAIN)).resolves.toBeNull();
  });
});
