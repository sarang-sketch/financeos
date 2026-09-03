import { describe, expect, it } from 'vitest';

import type { ExceptionCategorySummary } from '@/tools/exception-tools';

import {
  ATTENTION_PAGE_SIZE,
  attentionPanelReducer,
  INITIAL_ATTENTION_PANEL_STATE,
} from './attention-panel-state';

const CATEGORY: ExceptionCategorySummary = {
  kind: 'category',
  category: 'settlement_mismatch',
  state: 'open',
  exception_count: 1,
  impact_paise: 100n,
  evidence_chain_id: '10000000-0000-4000-8000-000000000001',
  evidence_as_of: '2026-01-01T00:00:00.000Z',
};

describe('attentionPanelReducer', () => {
  it('selects a category at the first page and marks drill-down loading', () => {
    const loaded = attentionPanelReducer(INITIAL_ATTENTION_PANEL_STATE, {
      type: 'categories_loaded',
      rows: [CATEGORY],
    });
    const selected = attentionPanelReducer(loaded, {
      type: 'category_selected',
      category: CATEGORY.category,
    });
    expect(selected.selectedCategory).toBe(CATEGORY.category);
    expect(selected.pageOffset).toBe(0);
    expect(selected.itemStatus).toBe('loading');
  });

  it('uses pages of 50 and corrects an offset invalidated by a Realtime refresh', () => {
    const selected = attentionPanelReducer(INITIAL_ATTENTION_PANEL_STATE, {
      type: 'category_selected',
      category: CATEGORY.category,
    });
    const secondPage = attentionPanelReducer(selected, {
      type: 'page_requested',
      offset: ATTENTION_PAGE_SIZE,
    });
    const corrected = attentionPanelReducer(secondPage, {
      type: 'items_loaded',
      rows: [],
      total: 3,
    });
    expect(corrected.pageOffset).toBe(0);
    expect(corrected.itemStatus).toBe('loading');
  });

  it('drops a selection when refreshed category rollups no longer contain it', () => {
    const selected = {
      ...INITIAL_ATTENTION_PANEL_STATE,
      selectedCategory: CATEGORY.category,
      itemStatus: 'ready' as const,
      itemTotal: 1,
    };
    const refreshed = attentionPanelReducer(selected, { type: 'categories_loaded', rows: [] });
    expect(refreshed.selectedCategory).toBeNull();
    expect(refreshed.itemStatus).toBe('idle');
    expect(refreshed.itemTotal).toBe(0);
  });

  it('turns each Realtime notification into a reload revision', () => {
    const changed = attentionPanelReducer(INITIAL_ATTENTION_PANEL_STATE, {
      type: 'realtime_changed',
    });
    expect(changed.revision).toBe(1);
  });
});
