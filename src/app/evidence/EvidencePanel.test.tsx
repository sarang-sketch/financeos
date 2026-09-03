import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ExceptionEvidence } from '@/tools/exception-tools';

import { EvidencePanel } from './EvidencePanel';

const evidence: ExceptionEvidence = {
  evidence_chain_id: '92810000-0000-4281-8281-000000009281',
  figure_paise: 149_000n,
  source_count: 201,
  as_of: '2026-07-30T08:59:00.000Z',
  produced_by: 'get_exception_evidence',
  steps: [
    {
      index: 1,
      operation: 'sum',
      operands: [{ kind: 'source', ref: { type: 'payment', id: 'pay_1' }, field: 'amount' }],
      result_paise: 150_000n,
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
      fields: ['amount', 'fee'],
      record_updated_at: '2026-07-30T09:00:00.000Z',
      as_of: '2026-07-30T08:59:00.000Z',
      stale: true,
    },
  ],
  source_page: { offset: 100, limit: 100, next_offset: 200, total: 201 },
  stale: true,
};

const html = renderToStaticMarkup(
  <EvidencePanel
    evidence={evidence}
    onNavigateSourcePage={() => {
      /* navigation behavior is represented by pure page requests */
    }}
  />,
);

describe('EvidencePanel', () => {
  it('renders persisted steps in order with operations and operand references', () => {
    expect([...html.matchAll(/data-operation="([a-z_]+)"/g)].map((match) => match[1])).toEqual([
      'sum',
      'subtract',
    ]);
    expect(html).toContain('payment:pay_1.amount');
    expect(html).toContain('step 1');
    expect(html).toContain('literal 1000');
  });

  it('shows the chain id, as-of, and persisted total source count', () => {
    expect(html).toContain('92810000-0000-4281-8281-000000009281');
    expect(html).toContain('2026-07-30 14:29:00 IST');
    expect(html).toContain('<data value="201">201</data>');
  });

  it('renders the current source page and a control for every page', () => {
    expect(html).toContain('Page 2 of 3');
    expect(html).toContain('payment:pay_0100');
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html).toContain('aria-current="page"');
  });

  it('announces chain and source staleness in text, not only an attribute', () => {
    expect(html).toContain('data-stale="true"');
    expect(html).toContain('data-evidence-stale');
    expect(html).toContain('changed after this Evidence_Chain as-of timestamp');
    expect(html).toContain('changed after as-of');
  });
});


describe('EvidencePanel complete paging and freshness coverage', () => {
  const fullPageSources: ExceptionEvidence['sources'] = Array.from(
    { length: 100 },
    (_unused, index) => ({
      ref: { type: 'payment', id: `pay_${String(index + 100).padStart(4, '0')}` },
      fields: ['amount'],
      record_updated_at: '2026-07-30T08:59:00.000Z',
      as_of: '2026-07-30T08:59:00.000Z',
      stale: index === 99,
    }),
  );

  it('renders exactly 100 identifiers on a full page with navigation to every page', () => {
    // Validates: Requirements 12.5
    const pageHtml = renderToStaticMarkup(
      <EvidencePanel
        evidence={{ ...evidence, sources: fullPageSources }}
        onNavigateSourcePage={() => undefined}
      />,
    );

    expect(pageHtml.match(/data-source-stale=/g)).toHaveLength(100);
    expect(pageHtml).toContain('payment:pay_0100');
    expect(pageHtml).toContain('payment:pay_0199');
    expect(pageHtml).toContain('Page 2 of 3');
    expect(pageHtml.match(/<button/g)).toHaveLength(3);
    expect(pageHtml).toMatch(
      /<button type="button" aria-current="page" disabled="">[\s\S]*?2<\/button>/,
    );
  });

  it('renders persisted computation steps in strict 1-based order', () => {
    // Validates: Requirements 12.5
    const orderedEvidence: ExceptionEvidence = {
      ...evidence,
      steps: [
        evidence.steps[0]!,
        evidence.steps[1]!,
        {
          index: 3,
          operation: 'compare',
          operands: [{ kind: 'step', index: 2 }],
          result_paise: null,
          note: 'persisted comparison',
        },
      ],
    };
    const orderedHtml = renderToStaticMarkup(
      <EvidencePanel evidence={orderedEvidence} onNavigateSourcePage={() => undefined} />,
    );

    expect(
      [...orderedHtml.matchAll(/<li value="(\d+)" data-operation="([a-z_]+)">/g)].map(
        (match) => [match[1], match[2]],
      ),
    ).toEqual([
      ['1', 'sum'],
      ['2', 'subtract'],
      ['3', 'compare'],
    ]);
    expect(orderedHtml).toContain('<code>step 2</code>');
    expect(orderedHtml).toContain('persisted comparison');
  });

  it('shows no stale warning when neither the chain nor current-page sources are stale', () => {
    // Validates: Requirements 12.5
    const freshHtml = renderToStaticMarkup(
      <EvidencePanel
        evidence={{
          ...evidence,
          stale: false,
          sources: evidence.sources.map((source) => ({ ...source, stale: false })),
        }}
        onNavigateSourcePage={() => undefined}
      />,
    );

    expect(freshHtml).toContain('data-stale="false"');
    expect(freshHtml).not.toContain('data-evidence-stale');
    expect(freshHtml).not.toContain('changed after as-of');
  });
});