'use client';

/** Thin accessible Evidence_Chain view over persisted get_exception_evidence data. */
import { useId, type ReactElement } from 'react';

import type { ExceptionEvidence } from '@/tools/exception-tools';

import {
  evidencePanelView,
  type EvidencePageRequest,
} from './evidence-panel-view-model';

export interface EvidencePanelProps {
  readonly evidence: ExceptionEvidence;
  readonly onNavigateSourcePage: (request: EvidencePageRequest) => void;
  readonly onClose?: () => void;
}

export function EvidencePanel({
  evidence,
  onNavigateSourcePage,
  onClose,
}: EvidencePanelProps): ReactElement {
  const headingId = useId();
  const view = evidencePanelView(evidence);

  return (
    <section
      aria-labelledby={headingId}
      data-evidence-panel
      data-evidence-chain-id={view.chainId}
      data-stale={view.stale}
    >
      <header>
        <h2 id={headingId}>Evidence chain</h2>
        {onClose === undefined ? null : (
          <button type="button" onClick={onClose} aria-label="Close Evidence panel">
            Close
          </button>
        )}
        <p>
          Chain identifier <code>{view.chainId}</code>
        </p>
        <p>
          As of <time dateTime={view.asOf.machine}>{view.asOf.text}</time>
        </p>
        <p>
          Total Source_Record identifiers <data value={String(view.sourceCount)}>{view.sourceCount}</data>
        </p>
        {view.staleText === null ? null : (
          <p role="status" data-evidence-stale>
            {view.staleText}
          </p>
        )}
      </header>

      <section aria-labelledby={`${headingId}-steps`}>
        <h3 id={`${headingId}-steps`}>Computation steps</h3>
        <ol data-evidence-steps>
          {view.steps.map((step) => (
            <li key={step.index} value={step.index} data-operation={step.operation}>
              <p>
                <strong>{step.operation}</strong>
              </p>
              <p>Operands</p>
              <ol>
                {step.operands.map((operand, index) => (
                  <li key={`${operand.kind}-${index}`} data-operand-kind={operand.kind}>
                    <code>{operand.text}</code>
                  </li>
                ))}
              </ol>
              {step.note === null ? null : <p>{step.note}</p>}
            </li>
          ))}
        </ol>
      </section>


      <section aria-labelledby={`${headingId}-sources`}>
        <h3 id={`${headingId}-sources`}>Source records</h3>
        <p>
          Page {view.pageNumber} of {view.pageCount}
        </p>
        <ul data-evidence-sources>
          {view.sources.map((source) => (
            <li key={`${source.ref.type}:${source.ref.id}`} data-source-stale={source.stale}>
              <code>{source.ref.type}:{source.ref.id}</code>
              <span> — cited fields: {source.fields.join(', ')}</span>
              {source.stale ? <strong> — changed after as-of</strong> : null}
            </li>
          ))}
        </ul>
        <nav aria-label="Evidence source pages">
          <ol>
            {view.pageLinks.map((page) => (
              <li key={page.number}>
                <button
                  type="button"
                  aria-current={page.current ? 'page' : undefined}
                  disabled={page.current}
                  onClick={() => {
                    onNavigateSourcePage(page.request);
                  }}
                >
                  <span className="sr-only">Evidence sources page </span>
                  {page.number}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      </section>
    </section>
  );
}
