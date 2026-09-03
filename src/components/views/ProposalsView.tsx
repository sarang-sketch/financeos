'use client';

import React from 'react';
import type { SeedCustomer, SeedRecoveryProposal } from '@/services/seed-data-service';

interface ProposalsViewProps {
  proposals: SeedRecoveryProposal[];
  customers: SeedCustomer[];
  pendingProposalsCount: number;
  executingProposalId: string | null;
  onApproveProposal: (id: string) => void;
  onRejectProposal: (id: string) => void;
  onInspectEvidence: (id: string) => void;
}

export function ProposalsView({
  proposals,
  customers,
  pendingProposalsCount,
  executingProposalId,
  onApproveProposal,
  onRejectProposal,
  onInspectEvidence,
}: ProposalsViewProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div className="panel" style={{ padding: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>
              Recovery Proposal Queue & Policy Gate
            </h2>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              6 independent safety checks evaluated before proposal authorization
            </p>
          </div>
          <span className="badge badge-warning">
            {pendingProposalsCount} Actionable Items
          </span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '16px' }}>
        {proposals.map((prop) => {
          const isApproved = prop.status === 'RECOVERED';
          const isExecuting = executingProposalId === prop.id;
          const cust = customers.find((c) => c.id === prop.customer_id);

          return (
            <div
              key={prop.id}
              className="panel-raised"
              style={{
                padding: '20px',
                borderLeft: `4px solid ${isApproved ? 'var(--success)' : 'var(--warning)'}`,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <div>
                    <span className="badge badge-brand" style={{ fontSize: '10px' }}>
                      Proposal #{prop.id}
                    </span>
                    <h3 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginTop: '4px' }}>
                      {cust?.name || prop.customer_id}
                    </h3>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="mono tabular-nums" style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>
                      ₹{(prop.amount_paise / 100).toLocaleString('en-IN')}.00
                    </div>
                    <span className={`badge ${isApproved ? 'badge-success' : 'badge-warning'}`}>
                      {isApproved ? '✓ RECOVERED' : 'READY FOR APPROVAL'}
                    </span>
                  </div>
                </div>

                <div style={{ background: 'var(--bg-surface-subtle)', padding: '12px', borderRadius: '6px', margin: '12px 0', border: '1px solid var(--border-default)' }}>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px', fontWeight: 600 }}>
                    RECOMMENDED ACTION:
                  </div>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--brand)' }}>
                    {prop.recommended_action}
                  </div>
                  <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                    <span className="badge badge-success">{prop.recovery_probability}% Probability</span>
                    <span className="badge badge-info">{prop.evidence_source}</span>
                    <span className="badge badge-neutral">Risk: {prop.risk_score}</span>
                  </div>
                </div>

                <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  {prop.reasoning}
                </p>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--border-default)' }}>
                <button
                  onClick={() => onInspectEvidence('chain_901')}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--brand)',
                    fontSize: '11px',
                    fontWeight: 600,
                    cursor: 'pointer',
                    textDecoration: 'underline',
                  }}
                >
                  View 10-Step Evidence Chain ↗
                </button>

                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    disabled={isApproved}
                    className="btn btn-danger"
                    style={{ fontSize: '11px', padding: '5px 10px' }}
                    onClick={() => onRejectProposal(prop.id)}
                  >
                    Reject
                  </button>
                  <button
                    disabled={isApproved || isExecuting}
                    onClick={() => onApproveProposal(prop.id)}
                    className="btn btn-success"
                    style={{ fontSize: '11px', padding: '5px 14px' }}
                  >
                    {isExecuting ? 'Executing...' : isApproved ? '✓ Recovered' : 'Authorize & Execute'}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
