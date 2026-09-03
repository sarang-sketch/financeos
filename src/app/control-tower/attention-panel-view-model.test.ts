import { describe, expect, it } from 'vitest';

import type {
  ExceptionCategorySummary,
  ExceptionItemSummary,
} from '@/tools/exception-tools';

import {
  attentionCategoryViews,
  attentionItemViews,
  categoryLabel,
} from './attention-panel-view-model';

const CATEGORY_BASE = {
  kind: 'category',
  state: 'open',
  exception_count: 1,
  evidence_chain_id: '10000000-0000-4000-8000-000000000001',
  evidence_as_of: '2026-01-01T00:00:00.000Z',
} as const;

const ITEM_BASE = {
  kind: 'exception',
  category: 'settlement_mismatch',
  state: 'open',
  direction: 'shortfall',
  evidence_chain_id: '20000000-0000-4000-8000-000000000001',
  evidence_as_of: '2026-01-01T00:00:00.000Z',
  fingerprint: 'a'.repeat(64),
  first_detected_at: '2026-01-01T00:00:00.000Z',
  last_detected_at: '2026-01-01T00:00:00.000Z',
  resolved_at: null,
} as const;

describe('Attention Panel view model', () => {
  it('orders category aggregates descending then category ascending without recomputing them', () => {
    const rows: ExceptionCategorySummary[] = [
      { ...CATEGORY_BASE, category: 'settlement_mismatch', impact_paise: 500n },
      { ...CATEGORY_BASE, category: 'gst_anomaly', impact_paise: 700n },
      { ...CATEGORY_BASE, category: 'ambiguous_match', impact_paise: 500n },
    ];
    const views = attentionCategoryViews(rows);
    expect(views.map((view) => view.category)).toEqual([
      'gst_anomaly',
      'ambiguous_match',
      'settlement_mismatch',
    ]);
    expect(views.map((view) => view.impactPaise)).toEqual(['700', '500', '500']);
    expect(views[0]?.impactText).toBe('₹7.00');
  });

  it('orders equal-impact Exceptions by id and exposes source identifiers and tool evidence ids', () => {
    const rows: ExceptionItemSummary[] = [
      {
        ...ITEM_BASE,
        exception_id: '30000000-0000-4000-8000-000000000002',
        impact_paise: 100n,
        source_records: [{ type: 'settlement', id: 'set_2' }],
      },
      {
        ...ITEM_BASE,
        exception_id: '30000000-0000-4000-8000-000000000001',
        impact_paise: 100n,
        source_records: [{ type: 'payment', id: 'pay_1' }],
      },
    ];
    const views = attentionItemViews(rows);
    expect(views.map((view) => view.exceptionId)).toEqual([
      '30000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002',
    ]);
    expect(views[0]?.sourceRecords[0]).toMatchObject({ type: 'payment', id: 'pay_1' });
    expect(views[0]?.evidenceChainId).toBe(ITEM_BASE.evidence_chain_id);
  });

  it('renders category names readably while preserving finance acronyms', () => {
    expect(categoryLabel('missing_gst_information')).toBe('Missing GST information');
    expect(categoryLabel('itc_discrepancy')).toBe('ITC discrepancy');
  });
});
