'use client';

import type { ReactElement, ReactNode } from 'react';

export interface FigureEvidenceRef {
  readonly chainId: string;
  readonly asOf: { readonly text: string; readonly machine: string };
}

export type OpenEvidence = (chainId: string) => void;

export interface FigureControlProps {
  readonly evidence: FigureEvidenceRef;
  readonly accessibleFigure: string;
  readonly onOpenEvidence: OpenEvidence;
  readonly children: ReactNode;
}

/**
 * The one rendering path for a displayed figure. A real button makes every figure
 * pointer- and keyboard-operable and exposes the persisted chain id and as-of beside it.
 */
export function FigureControl({
  evidence,
  accessibleFigure,
  onOpenEvidence,
  children,
}: FigureControlProps): ReactElement {
  return (
    <button
      type="button"
      data-figure-control
      data-evidence-chain-id={evidence.chainId}
      aria-label={`Open Evidence_Chain for ${accessibleFigure}`}
      onClick={() => {
        onOpenEvidence(evidence.chainId);
      }}
    >
      <span data-figure-value>{children}</span>
      <span data-figure-evidence-reference>
        Evidence chain <code>{evidence.chainId}</code>; as of{' '}
        <time dateTime={evidence.asOf.machine}>{evidence.asOf.text}</time>
      </span>
    </button>
  );
}
