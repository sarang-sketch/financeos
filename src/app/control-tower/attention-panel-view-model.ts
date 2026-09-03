/** Pure Attention_Panel projections. Monetary values are formatted, never recomputed. */
import { formatInr } from '@/format/inr';
import type {
  ExceptionCategorySummary,
  ExceptionItemSummary,
} from '@/tools/exception-tools';

const ACRONYMS = new Map([
  ['gst', 'GST'],
  ['gstin', 'GSTIN'],
  ['itc', 'ITC'],
  ['tds', 'TDS'],
]);

export interface AttentionCategoryView {
  readonly category: ExceptionCategorySummary['category'];
  readonly label: string;
  readonly openCount: number;
  readonly impactPaise: string;
  readonly impactText: string;
}

export interface AttentionSourceView {
  readonly key: string;
  readonly type: string;
  readonly id: string;
}

export interface AttentionItemView {
  readonly exceptionId: string;
  readonly impactPaise: string;
  readonly impactText: string;
  readonly evidenceChainId: string;
  readonly sourceRecords: readonly AttentionSourceView[];
}

export function categoryLabel(category: string): string {
  const words = category.split('_').map((word) => ACRONYMS.get(word) ?? word);
  const first = words[0] ?? '';
  words[0] = ACRONYMS.get(first) ?? `${first.slice(0, 1).toUpperCase()}${first.slice(1)}`;
  return words.join(' ');
}

/** Preserve the tool values and enforce Requirement 3.5's total display order. */
export function attentionCategoryViews(
  rows: readonly ExceptionCategorySummary[],
): readonly AttentionCategoryView[] {
  return [...rows]
    .filter((row) => row.state === 'open' && row.exception_count > 0)
    .sort((left, right) => {
      if (left.impact_paise !== right.impact_paise) {
        return left.impact_paise > right.impact_paise ? -1 : 1;
      }
      return left.category < right.category ? -1 : left.category > right.category ? 1 : 0;
    })
    .map((row) => ({
      category: row.category,
      label: categoryLabel(row.category),
      openCount: row.exception_count,
      impactPaise: row.impact_paise.toString(),
      impactText: formatInr(row.impact_paise),
    }));
}

/** Preserve tool-provided impacts and enforce Requirement 3.6's total display order. */
export function attentionItemViews(
  rows: readonly ExceptionItemSummary[],
): readonly AttentionItemView[] {
  return [...rows]
    .filter((row) => row.state === 'open')
    .sort((left, right) => {
      if (left.impact_paise !== right.impact_paise) {
        return left.impact_paise > right.impact_paise ? -1 : 1;
      }
      return left.exception_id < right.exception_id
        ? -1
        : left.exception_id > right.exception_id
          ? 1
          : 0;
    })
    .map((row) => ({
      exceptionId: row.exception_id,
      impactPaise: row.impact_paise.toString(),
      impactText: formatInr(row.impact_paise),
      evidenceChainId: row.evidence_chain_id,
      sourceRecords: row.source_records.map((source) => ({
        key: `${source.type}\u0000${source.id}`,
        type: source.type.replace(/_/g, ' '),
        id: source.id,
      })),
    }));
}
