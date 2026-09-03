import type { ExceptionCategory } from '@/agents/exception-fingerprint';
import type {
  ExceptionCategorySummary,
  ExceptionItemSummary,
} from '@/tools/exception-tools';

export const ATTENTION_PAGE_SIZE = 50;
export type AttentionLoadStatus = 'loading' | 'ready' | 'failed';

export interface AttentionPanelState {
  readonly categoryStatus: AttentionLoadStatus;
  readonly categories: readonly ExceptionCategorySummary[];
  readonly categoryError: string | null;
  readonly selectedCategory: ExceptionCategory | null;
  readonly pageOffset: number;
  readonly itemStatus: 'idle' | AttentionLoadStatus;
  readonly items: readonly ExceptionItemSummary[];
  readonly itemTotal: number;
  readonly itemError: string | null;
  readonly revision: number;
}

export const INITIAL_ATTENTION_PANEL_STATE: AttentionPanelState = {
  categoryStatus: 'loading',
  categories: [],
  categoryError: null,
  selectedCategory: null,
  pageOffset: 0,
  itemStatus: 'idle',
  items: [],
  itemTotal: 0,
  itemError: null,
  revision: 0,
};

export type AttentionPanelAction =
  | { readonly type: 'categories_loaded'; readonly rows: readonly ExceptionCategorySummary[] }
  | { readonly type: 'categories_failed'; readonly message: string }
  | { readonly type: 'category_selected'; readonly category: ExceptionCategory }
  | { readonly type: 'page_requested'; readonly offset: number }
  | { readonly type: 'items_loaded'; readonly rows: readonly ExceptionItemSummary[]; readonly total: number }
  | { readonly type: 'items_failed'; readonly message: string }
  | { readonly type: 'realtime_changed' };

export function attentionPanelReducer(
  state: AttentionPanelState,
  action: AttentionPanelAction,
): AttentionPanelState {
  switch (action.type) {
    case 'categories_loaded': {
      const selectionRemains = action.rows.some(
        (row) => row.category === state.selectedCategory && row.exception_count > 0,
      );
      return {
        ...state,
        categoryStatus: 'ready',
        categories: [...action.rows],
        categoryError: null,
        selectedCategory: selectionRemains ? state.selectedCategory : null,
        pageOffset: selectionRemains ? state.pageOffset : 0,
        itemStatus: selectionRemains ? state.itemStatus : 'idle',
        items: selectionRemains ? state.items : [],
        itemTotal: selectionRemains ? state.itemTotal : 0,
        itemError: selectionRemains ? state.itemError : null,
      };
    }
    case 'categories_failed':
      return { ...state, categoryStatus: 'failed', categoryError: action.message };
    case 'category_selected':
      return {
        ...state,
        selectedCategory: action.category,
        pageOffset: 0,
        itemStatus: 'loading',
        items: [],
        itemTotal: 0,
        itemError: null,
      };
    case 'page_requested':
      return {
        ...state,
        pageOffset: action.offset,
        itemStatus: 'loading',
        items: [],
        itemError: null,
      };
    case 'items_loaded': {
      if (action.total > 0 && state.pageOffset >= action.total) {
        const finalOffset = Math.floor((action.total - 1) / ATTENTION_PAGE_SIZE) * ATTENTION_PAGE_SIZE;
        return { ...state, pageOffset: finalOffset, itemStatus: 'loading', items: [], itemTotal: action.total };
      }
      return {
        ...state,
        itemStatus: 'ready',
        items: [...action.rows],
        itemTotal: action.total,
        itemError: null,
      };
    }
    case 'items_failed':
      return { ...state, itemStatus: 'failed', itemError: action.message };
    case 'realtime_changed':
      return { ...state, revision: state.revision + 1 };
  }
}
