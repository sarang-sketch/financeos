'use client';

import React, { useState } from 'react';
import type {
  SeedCustomer,
  SeedPaymentFailure,
  SeedRecoveryProposal,
} from '@/services/seed-data-service';
import { ProposalsView } from './ProposalsView';

interface FailedPaymentsViewProps {
  failedPayments: SeedPaymentFailure[];
  customers: SeedCustomer[];
  searchQuery: string;
  onSearchChange: (q: string) => void;
  statusFilter: string;
  onStatusFilterChange: (s: string) => void;
  onInspectPayment: (id: string) => void;
  proposals?: SeedRecoveryProposal[];
  pendingProposalsCount?: number;
  executingProposalId?: string | null;
  onApproveProposal?: (id: string) => void;
  onRejectProposal?: (id: string) => void;
  onInspectEvidence?: (id: string) => void;
}

export function FailedPaymentsView({
  failedPayments,
  customers,
  searchQuery,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  onInspectPayment,
  proposals,
  pendingProposalsCount = 3,
  executingProposalId,
  onApproveProposal = () => {},
  onRejectProposal = () => {},
  onInspectEvidence = () => {},
}: FailedPaymentsViewProps) {
  const [viewMode, setViewMode] = useState<'DIRECTORY' | 'ACTION_QUEUE'>('DIRECTORY');

  const filtered = failedPayments.filter((p) => {
    const matchesSearch =
      p.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.customer_id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.failure_reason.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.channel.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === 'ALL' || p.status.toUpperCase().includes(statusFilter);
    return matchesSearch && matchesStatus;
  });

  if (viewMode === 'ACTION_QUEUE' && proposals) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid var(--border-default)', paddingBottom: '8px' }}>
          <button
            onClick={() => setViewMode('DIRECTORY')}
            className="btn btn-secondary"
            style={{ fontSize: '12px', fontWeight: 600, padding: '6px 14px' }}
          >
            ⚡ Failures Directory ({failedPayments.length})
          </button>
          <button
            onClick={() => setViewMode('ACTION_QUEUE')}
            className="btn btn-primary"
            style={{ fontSize: '12px', fontWeight: 700, padding: '6px 14px' }}
          >
            📋 Recovery Action Proposals Queue ({pendingProposalsCount} Pending)
          </button>
        </div>

        <ProposalsView
          proposals={proposals}
          customers={customers}
          pendingProposalsCount={pendingProposalsCount}
          executingProposalId={executingProposalId || null}
          onApproveProposal={onApproveProposal}
          onRejectProposal={onRejectProposal}
          onInspectEvidence={onInspectEvidence}
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {proposals && (
        <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid var(--border-default)', paddingBottom: '8px' }}>
          <button
            onClick={() => setViewMode('DIRECTORY')}
            className="btn btn-primary"
            style={{ fontSize: '12px', fontWeight: 700, padding: '6px 14px' }}
          >
            ⚡ Failures Directory ({failedPayments.length})
          </button>
          <button
            onClick={() => setViewMode('ACTION_QUEUE')}
            className="btn btn-secondary"
            style={{ fontSize: '12px', fontWeight: 600, padding: '6px 14px' }}
          >
            📋 Recovery Action Proposals Queue ({pendingProposalsCount} Pending)
          </button>
        </div>
      )}

      <div className="panel" style={{ padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>
            Payment Failures Directory
          </h2>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Filtered view of all payment failures with computed recovery probabilities and channel affinities
          </p>
        </div>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <input
            type="text"
            placeholder="Search payment, customer, reason..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="input-control"
            style={{ width: '250px' }}
          />
          <select
            value={statusFilter}
            onChange={(e) => onStatusFilterChange(e.target.value)}
            className="input-control"
          >
            <option value="ALL">All Statuses</option>
            <option value="PROPOSAL_READY">Proposal Ready</option>
            <option value="ANALYZING">Analyzing</option>
            <option value="RETRYING">Retrying</option>
            <option value="RECOVERED">Recovered</option>
          </select>
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Payment ID</th>
              <th>Customer & LTV</th>
              <th>Amount</th>
              <th>Failure Reason</th>
              <th>Attempts</th>
              <th>Recovery Prob</th>
              <th>Recommended Channel</th>
              <th>Evidence Basis</th>
              <th>Status</th>
              <th style={{ textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => {
              const cust = customers.find((c) => c.id === p.customer_id);
              return (
                <tr key={p.id}>
                  <td className="mono font-bold" style={{ color: 'var(--text-primary)' }}>
                    {p.id}
                  </td>
                  <td>
                    <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{cust?.name || p.customer_id}</div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                      LTV: ₹{cust ? (cust.ltv_paise / 100).toLocaleString('en-IN') : '0'}.00
                    </div>
                  </td>
                  <td className="mono tabular-nums font-bold" style={{ color: 'var(--text-primary)' }}>
                    ₹{(p.amount_paise / 100).toLocaleString('en-IN')}.00
                  </td>
                  <td>
                    <span className="badge badge-neutral mono" style={{ fontSize: '10px' }}>
                      {p.failure_reason}
                    </span>
                  </td>
                  <td className="mono">{p.attempts_count}</td>
                  <td>
                    <span
                      className={`badge ${
                        p.recovery_probability >= 80
                          ? 'badge-success'
                          : p.recovery_probability >= 60
                          ? 'badge-brand'
                          : 'badge-warning'
                      }`}
                    >
                      {p.recovery_probability}%
                    </span>
                  </td>
                  <td>
                    <span className="mono" style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                      {p.recommended_channel}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`badge ${
                        p.evidence_source === 'CUSTOMER_LEVEL' ? 'badge-info' : 'badge-warning'
                      }`}
                      style={{ fontSize: '9px' }}
                    >
                      {p.evidence_source}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`badge ${
                        p.status === 'RECOVERED'
                          ? 'badge-success'
                          : p.status === 'PROPOSAL_READY'
                          ? 'badge-brand'
                          : p.status === 'RETRYING'
                          ? 'badge-warning'
                          : 'badge-neutral'
                      }`}
                    >
                      {p.status}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      onClick={() => onInspectPayment(p.id)}
                      className="btn btn-secondary"
                      style={{ fontSize: '11px', padding: '3px 8px' }}
                    >
                      Inspect ↗
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
    </div>
  );
}
