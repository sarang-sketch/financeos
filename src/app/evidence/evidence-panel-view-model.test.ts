import { describe, expect, it } from 'vitest';

import type { ExceptionEvidence } from '@/tools/exception-tools';

import { EvidencePanelViewError, evidencePanelView } from './evidence-panel-view-model';

const CHAIN = '92810000-0000-4281-8281-000000009281';
const AS_OF = '2026-07-30T08:59:00.000Z';

function evidence(patch: Partial<ExceptionEvidence> = {}): ExceptionEvidence {
  return {
    evidence_chain_id: CHAIN,
    figure_paise: 149_000n,
    source_count: 250,
    as_of: AS_OF,
    produced_by: 'get_exception_evidence',
    steps: [
      {
        index: 1,
        operation: 'sum',
        operands: [
          { kind: 'source', ref: { type: 'payment', id: 'pay_1' }, field: 'amount' },
          { kind: 'literal', value: '1000' },
        ],
        result_paise: 150_000n,
        note: 'persisted first step',
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
      {
        ref: { type: 'payment', id: 'pay_0100' },
        fields: ['amount'],
        record_updated_at: AS_OF,
        as_of: AS_OF,
        stale: false,
      },
    ],
    source_page: { offset: 100, limit: 100, next_offset: 200, total: 250 },
    stale: false,
    ...patch,
  };
}

describe('evidencePanelView', () => {
  it('keeps persisted step order and renders every operand reference', () => {
    const view = evidencePanelView(evidence());
    expect(view.steps.map((step) => [step.index, step.operation])).toEqual([
      [1, 'sum'],
      [2, 'subtract'],
    ]);
    expect(view.steps[0]?.operands.map((operand) => operand.text)).toEqual([
      'payment:pay_1.amount',
      'literal 1000',
    ]);
    expect(view.steps[1]?.operands[0]?.text).toBe('step 1');
    expect(view.steps[0]?.note).toBe('persisted first step');
  });


  it('provides direct navigation to every 100-identifier page', () => {
    const view = evidencePanelView(evidence());
    expect(view.pageNumber).toBe(2);
    expect(view.pageCount).toBe(3);
    expect(view.pageLinks).toEqual([
      { number: 1, current: false, request: { offset: 0, limit: 100 } },
      { number: 2, current: true, request: { offset: 100, limit: 100 } },
      { number: 3, current: false, request: { offset: 200, limit: 100 } },
    ]);
    expect(view.sourceCount).toBe(250);
  });

  it('uses the tool-returned chain-level stale decision without re-deriving it from this page', () => {
    const view = evidencePanelView(
      evidence({
        stale: true,
        // The stale record may be on another page; this page is deliberately current.
        sources: evidence().sources.map((source) => ({ ...source, stale: false })),
      }),
    );
    expect(view.stale).toBe(true);
    expect(view.staleText).toContain('at least one referenced Source_Record changed');
  });

  it('formats as-of in IST while preserving a machine-readable instant', () => {
    expect(evidencePanelView(evidence()).asOf).toEqual({
      text: '2026-07-30 14:29:00 IST',
      machine: '2026-07-30T14:29:00+05:30',
    });
  });

  it('rejects pages over 100, misaligned offsets, and totals that disagree with source_count', () => {
    expect(() =>
      evidencePanelView(
        evidence({ source_page: { offset: 0, limit: 101, next_offset: 101, total: 250 } }),
      ),
    ).toThrow(/at most 100/);
    expect(() =>
      evidencePanelView(
        evidence({ source_page: { offset: 50, limit: 100, next_offset: 150, total: 250 } }),
      ),
    ).toThrow(/align/);
    expect(() =>
      evidencePanelView(
        evidence({ source_page: { offset: 100, limit: 100, next_offset: null, total: 249 } }),
      ),
    ).toThrow(EvidencePanelViewError);
  });

  it('rejects a reordered or malformed persisted step instead of inventing a display order', () => {
    expect(() =>
      evidencePanelView(evidence({ steps: [{ index: 2, operation: 'sum', operands: [] }] })),
    ).toThrow(/stated 1-based order/);
  });
});
