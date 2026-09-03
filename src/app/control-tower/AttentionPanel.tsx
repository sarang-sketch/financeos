'use client';

/**
 * Thin, accessible Attention_Panel for Requirements 3.5 and 3.6.
 * All rows and monetary aggregates come from list_exceptions_by_category.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  useEffect,
  useId,
  useReducer,
  type ReactElement,
} from 'react';

import type { ExceptionCategory } from '@/agents/exception-fingerprint';
import type { TenantId } from '@/config/configuration-service';
import type {
  ListExceptionsByCategoryInput,
  ListExceptionsByCategoryOutput,
} from '@/tools/list-exceptions-by-category';
import type { ToolResult } from '@/tools/tool';

import { subscribeToAttentionPanelRealtime } from './attention-panel-realtime';
import {
  ATTENTION_PAGE_SIZE,
  attentionPanelReducer,
  INITIAL_ATTENTION_PANEL_STATE,
  type AttentionPanelState,
} from './attention-panel-state';
import {
  attentionCategoryViews,
  attentionItemViews,
  categoryLabel,
} from './attention-panel-view-model';

export type AttentionPanelLoad = (
  input: ListExceptionsByCategoryInput,
  signal: AbortSignal,
) => Promise<ToolResult<ListExceptionsByCategoryOutput>>;

export interface AttentionPanelSource {
  readonly tenantId: TenantId;
  readonly listExceptionsByCategory: AttentionPanelLoad;
  readonly realtime: SupabaseClient;
}

export interface EvidenceOpenRequest {
  readonly exceptionId: string;
  readonly evidenceChainId: string;
}

export interface AttentionPanelProps {
  readonly source: AttentionPanelSource;
  readonly onOpenEvidence: (request: EvidenceOpenRequest) => void;
}

function loadFailure(result: Exclude<ToolResult<unknown>, { readonly ok: true }>): Error {
  return new Error(`list_exceptions_by_category returned ${result.kind}`);
}

export function AttentionPanel({ source, onOpenEvidence }: AttentionPanelProps): ReactElement {
  const [state, dispatch] = useReducer(attentionPanelReducer, INITIAL_ATTENTION_PANEL_STATE);
  const { listExceptionsByCategory, realtime, tenantId } = source;

  useEffect(
    () =>
      subscribeToAttentionPanelRealtime(realtime, tenantId, () => {
        dispatch({ type: 'realtime_changed' });
      }),
    [realtime, tenantId],
  );

  useEffect(() => {
    const controller = new AbortController();
    listExceptionsByCategory(
      { state: 'open', page: { offset: 0, limit: ATTENTION_PAGE_SIZE } },
      controller.signal,
    ).then(
      (result) => {
        if (!result.ok) throw loadFailure(result);
        const rows = result.value.rows.filter((row) => row.kind === 'category');
        dispatch({ type: 'categories_loaded', rows });
      },
      () => {
        if (!controller.signal.aborted) {
          dispatch({ type: 'categories_failed', message: 'Unable to load open Exceptions.' });
        }
      },
    ).catch(() => {
      if (!controller.signal.aborted) {
        dispatch({ type: 'categories_failed', message: 'Unable to load open Exceptions.' });
      }
    });
    return () => controller.abort();
  }, [listExceptionsByCategory, state.revision]);

  useEffect(() => {
    if (state.selectedCategory === null) return;
    const controller = new AbortController();
    listExceptionsByCategory(
      {
        category: state.selectedCategory,
        state: 'open',
        page: { offset: state.pageOffset, limit: ATTENTION_PAGE_SIZE },
      },
      controller.signal,
    ).then(
      (result) => {
        if (!result.ok) throw loadFailure(result);
        const rows = result.value.rows.filter((row) => row.kind === 'exception');
        dispatch({ type: 'items_loaded', rows, total: result.value.total });
      },
      () => {
        if (!controller.signal.aborted) {
          dispatch({ type: 'items_failed', message: 'Unable to load category Exceptions.' });
        }
      },
    ).catch(() => {
      if (!controller.signal.aborted) {
        dispatch({ type: 'items_failed', message: 'Unable to load category Exceptions.' });
      }
    });
    return () => controller.abort();
  }, [listExceptionsByCategory, state.pageOffset, state.revision, state.selectedCategory]);

  return (
    <AttentionPanelDisplay
      state={state}
      onSelectCategory={(category) => dispatch({ type: 'category_selected', category })}
      onPage={(offset) => dispatch({ type: 'page_requested', offset })}
      onOpenEvidence={onOpenEvidence}
    />
  );
}

export interface AttentionPanelDisplayProps {
  readonly state: AttentionPanelState;
  readonly onSelectCategory: (category: ExceptionCategory) => void;
  readonly onPage: (offset: number) => void;
  readonly onOpenEvidence: (request: EvidenceOpenRequest) => void;
}

/** Pure presentation: native buttons provide pointer, Enter, and Space activation. */
export function AttentionPanelDisplay({
  state,
  onSelectCategory,
  onPage,
  onOpenEvidence,
}: AttentionPanelDisplayProps): ReactElement {
  const headingId = useId();
  const drilldownId = useId();
  const categories = attentionCategoryViews(state.categories);
  const items = attentionItemViews(state.items);
  const selectedLabel =
    state.selectedCategory === null ? null : categoryLabel(state.selectedCategory);
  const currentPage = Math.floor(state.pageOffset / ATTENTION_PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(state.itemTotal / ATTENTION_PAGE_SIZE));
  const hasPrevious = state.pageOffset > 0;
  const hasNext = state.pageOffset + items.length < state.itemTotal;
  const noOpenExceptions = state.categoryStatus === 'ready' && categories.length === 0;

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={state.categoryStatus === 'loading' || state.itemStatus === 'loading'}
      data-control-tower="attention-panel"
    >
      <h2 id={headingId}>Needs attention</h2>

      {state.categoryStatus === 'loading' ? <p role="status">Loading open Exceptions…</p> : null}
      {state.categoryStatus === 'failed' ? (
        <p role="alert">Open Exceptions could not be loaded.</p>
      ) : null}

      {noOpenExceptions ? (
        <p role="status" data-attention-empty="no-open-exceptions">
          No open Exceptions. Nothing needs attention right now.
        </p>
      ) : (
        <ul aria-label="Open Exception categories">
          {categories.map((row) => {
            const selected = row.category === state.selectedCategory;
            return (
              <li key={row.category}>
                <button
                  type="button"
                  aria-pressed={selected}
                  aria-controls={selected ? drilldownId : undefined}
                  data-attention-category={row.category}
                  onClick={() => onSelectCategory(row.category)}
                >
                  <span>{row.label}</span>{' '}
                  <span>{row.openCount} open {row.openCount === 1 ? 'exception' : 'exceptions'}</span>{' '}
                  <data value={row.impactPaise}>{row.impactText}</data>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {noOpenExceptions || state.selectedCategory === null ? null : (
        <section id={drilldownId} aria-label={`${selectedLabel ?? ''} open Exceptions`}>
          <h3>{selectedLabel}</h3>
          {state.itemStatus === 'loading' ? <p role="status">Loading Exceptions…</p> : null}
          {state.itemStatus === 'failed' ? (
            <p role="alert">Exceptions in this category could not be loaded.</p>
          ) : null}
          {state.itemStatus !== 'ready' ? null : (
            <>
              <ol start={state.pageOffset + 1}>
                {items.map((item) => (
                  <li key={item.exceptionId} data-exception-id={item.exceptionId}>
                    <article aria-label={`Exception ${item.exceptionId}`}>
                      <h4>{item.exceptionId}</h4>
                      <p>
                        Impact <data value={item.impactPaise}>{item.impactText}</data>
                      </p>
                      <dl>
                        {item.sourceRecords.map((source) => (
                          <div key={source.key}>
                            <dt>{source.type}</dt>
                            <dd>{source.id}</dd>
                          </div>
                        ))}
                      </dl>
                      <button
                        type="button"
                        data-open-evidence={item.evidenceChainId}
                        onClick={() =>
                          onOpenEvidence({
                            exceptionId: item.exceptionId,
                            evidenceChainId: item.evidenceChainId,
                          })
                        }
                      >
                        Open evidence for Exception {item.exceptionId}
                      </button>
                    </article>
                  </li>
                ))}
              </ol>
              <nav aria-label="Exception pages">
                <button
                  type="button"
                  disabled={!hasPrevious}
                  onClick={() => onPage(Math.max(0, state.pageOffset - ATTENTION_PAGE_SIZE))}
                >
                  Previous
                </button>
                <span aria-current="page">Page {currentPage} of {pageCount}</span>
                <button
                  type="button"
                  disabled={!hasNext}
                  onClick={() => onPage(state.pageOffset + ATTENTION_PAGE_SIZE)}
                >
                  Next
                </button>
              </nav>
            </>
          )}
        </section>
      )}
    </section>
  );
}
