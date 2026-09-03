import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AttentionPanelState } from './attention-panel-state';
import { AttentionPanelDisplay } from './AttentionPanel';

const STATE: AttentionPanelState = {
  categoryStatus: 'ready',
  categories: [
    {
      kind: 'category',
      category: 'settlement_mismatch',
      state: 'open',
      exception_count: 2,
      impact_paise: 1_50_000_00n,
      evidence_chain_id: '10000000-0000-4000-8000-000000000001',
      evidence_as_of: '2026-01-01T00:00:00.000Z',
    },
  ],
  categoryError: null,
  selectedCategory: 'settlement_mismatch',
  pageOffset: 0,
  itemStatus: 'ready',
  items: [
    {
      kind: 'exception',
      exception_id: '20000000-0000-4000-8000-000000000001',
      category: 'settlement_mismatch',
      state: 'open',
      impact_paise: 1_00_00n,
      direction: 'shortfall',
      source_records: [{ type: 'settlement', id: 'set_9281' }],
      evidence_chain_id: '30000000-0000-4000-8000-000000000001',
      evidence_as_of: '2026-01-01T00:00:00.000Z',
      fingerprint: 'a'.repeat(64),
      first_detected_at: '2026-01-01T00:00:00.000Z',
      last_detected_at: '2026-01-01T00:00:00.000Z',
      resolved_at: null,
    },
  ],
  itemTotal: 1,
  itemError: null,
  revision: 0,
};

describe('AttentionPanelDisplay', () => {
  const html = renderToStaticMarkup(
    <AttentionPanelDisplay
      state={STATE}
      onSelectCategory={() => undefined}
      onPage={() => undefined}
      onOpenEvidence={() => undefined}
    />,
  );

  it('renders a no-open-exceptions state and no rows when every category is empty', () => {
    // Validates: Requirements 3.13
    const emptyHtml = renderToStaticMarkup(
      <AttentionPanelDisplay
        state={{
          ...STATE,
          categories: [],
          selectedCategory: null,
          itemStatus: 'idle',
          items: [],
          itemTotal: 0,
        }}
        onSelectCategory={() => undefined}
        onPage={() => undefined}
        onOpenEvidence={() => undefined}
      />,
    );

    expect(emptyHtml).toContain('data-attention-empty="no-open-exceptions"');
    expect(emptyHtml).toContain('No open Exceptions');
    expect(emptyHtml).not.toContain('data-attention-category');
    expect(emptyHtml).not.toContain('data-exception-id');
    expect(emptyHtml).not.toContain('<data');
  });

  it('uses native buttons for pointer and keyboard category selection', () => {
    expect(html).toContain('data-attention-category="settlement_mismatch"');
    expect(html).toContain('<button type="button"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('2 open exceptions');
    expect(html).toContain('₹1,50,000.00');
  });

  it('shows each Exception impact, source id, and evidence-open control', () => {
    expect(html).toContain('20000000-0000-4000-8000-000000000001');
    expect(html).toContain('<data value="10000">₹100.00</data>');
    expect(html).toContain('settlement');
    expect(html).toContain('set_9281');
    expect(html).toContain('data-open-evidence');
    expect(html).toContain('Open evidence for Exception');
  });

  it('renders bounded paging controls with the next page disabled at the end', () => {
    expect(html).toContain('aria-label="Exception pages"');
    expect(html).toContain('Page 1 of 1');
    expect(html).toMatch(/<button type="button" disabled=""[^>]*>Previous<\/button>/);
    expect(html).toMatch(/<button type="button" disabled=""[^>]*>Next<\/button>/);
  });
});


describe('AttentionPanelDisplay ordering, paging, and state coverage', () => {
  const category = (
    name: AttentionPanelState['categories'][number]['category'],
    impactPaise: bigint,
  ): AttentionPanelState['categories'][number] => ({
    ...STATE.categories[0]!,
    category: name,
    impact_paise: impactPaise,
  });

  const item = (
    exceptionId: string,
    impactPaise: bigint,
  ): AttentionPanelState['items'][number] => ({
    ...STATE.items[0]!,
    exception_id: exceptionId,
    impact_paise: impactPaise,
    source_records: [{ type: 'payment', id: `pay_${exceptionId}` }],
  });

  const render = (patch: Partial<AttentionPanelState>): string =>
    renderToStaticMarkup(
      <AttentionPanelDisplay
        state={{ ...STATE, ...patch }}
        onSelectCategory={() => undefined}
        onPage={() => undefined}
        onOpenEvidence={() => undefined}
      />,
    );

  it('orders categories by descending impact with the alphabetical equal-impact tie-break', () => {
    // Validates: Requirements 3.5
    const orderedHtml = render({
      selectedCategory: null,
      itemStatus: 'idle',
      items: [],
      itemTotal: 0,
      categories: [
        category('settlement_mismatch', 500n),
        category('gst_anomaly', 700n),
        category('ambiguous_match', 500n),
      ],
    });

    expect(
      [...orderedHtml.matchAll(/data-attention-category="([a-z_]+)"/g)].map(
        (match) => match[1],
      ),
    ).toEqual(['gst_anomaly', 'ambiguous_match', 'settlement_mismatch']);
  });

  it('renders one ordered page of 50 Exceptions and exposes the next page', () => {
    // Validates: Requirements 3.6
    const descending = Array.from({ length: 50 }, (_unused, index) =>
      item(`exc-${String(index).padStart(2, '0')}`, BigInt(50 - index)),
    );
    const unsorted = [...descending].reverse();
    const pageHtml = render({ items: unsorted, itemTotal: 51, pageOffset: 0 });
    const renderedIds = [...pageHtml.matchAll(/data-exception-id="([^"]+)"/g)].map(
      (match) => match[1],
    );

    expect(renderedIds).toHaveLength(50);
    expect(renderedIds).toEqual(descending.map((row) => row.exception_id));
    expect(pageHtml).toContain('<ol start="1">');
    expect(pageHtml).toContain('Page 1 of 2');
    expect(pageHtml).toMatch(/<button type="button" disabled=""[^>]*>Previous<\/button>/);
    expect(pageHtml).toMatch(/<button type="button">Next<\/button>/);
  });

  it('orders equal-impact drill-down rows by ascending Exception identifier', () => {
    // Validates: Requirements 3.6
    const pageHtml = render({
      items: [item('exc-c', 100n), item('exc-a', 100n), item('exc-b', 200n)],
      itemTotal: 3,
    });

    expect(
      [...pageHtml.matchAll(/data-exception-id="([^"]+)"/g)].map((match) => match[1]),
    ).toEqual(['exc-b', 'exc-a', 'exc-c']);
  });

  it('uses enabled native category buttons for pointer, Enter, and Space selection', () => {
    // Validates: Requirements 3.6
    const selectionHtml = render({ selectedCategory: null, itemStatus: 'idle', items: [] });
    const control = selectionHtml.match(
      /<button type="button" aria-pressed="false" data-attention-category="settlement_mismatch"[^>]*>/,
    )?.[0];

    expect(control).toBeDefined();
    expect(control).not.toContain('disabled');
    expect(control).not.toContain('tabindex="-1"');
    expect(control).not.toContain('role=');
  });

  it.each([
    [
      'category loading',
      {
        categoryStatus: 'loading' as const,
        selectedCategory: null,
        itemStatus: 'idle' as const,
        items: [],
      },
      'Loading open Exceptions…',
      'status',
    ],
    [
      'category failure',
      {
        categoryStatus: 'failed' as const,
        selectedCategory: null,
        itemStatus: 'idle' as const,
        items: [],
      },
      'Open Exceptions could not be loaded.',
      'alert',
    ],
    ['drill-down loading', { itemStatus: 'loading' as const }, 'Loading Exceptions…', 'status'],
    ['drill-down failure', { itemStatus: 'failed' as const }, 'Exceptions in this category could not be loaded.', 'alert'],
  ])('renders the %s state in text with its semantic role', (_name, patch, text, role) => {
    // Validates: Requirements 3.8, 3.9
    const stateHtml = render(patch);
    expect(stateHtml).toContain(`role="${role}"`);
    expect(stateHtml).toContain(text);
    expect(stateHtml).not.toContain('data-exception-id');
  });
});