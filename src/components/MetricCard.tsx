'use client';

import React from 'react';

interface MetricCardProps {
  label: string;
  value: string;
  secondaryValue?: string;
  trend?: string;
  trendDirection?: 'up' | 'down' | 'neutral';
  status?: 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  evidenceChainId?: string;
  onViewEvidence?: (chainId: string) => void;
}

export function MetricCard({
  label,
  value,
  secondaryValue,
  trend,
  trendDirection = 'up',
  evidenceChainId,
  onViewEvidence,
}: MetricCardProps) {
  return (
    <div className="panel" style={{ padding: '18px 20px', position: 'relative' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
        <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 600 }}>
          {label}
        </span>
        {trend && (
          <span
            className={`badge ${
              trendDirection === 'up' ? 'badge-success' : trendDirection === 'down' ? 'badge-danger' : 'badge-neutral'
            }`}
            style={{ fontSize: '10px' }}
          >
            {trendDirection === 'up' ? '↑' : trendDirection === 'down' ? '↓' : '•'} {trend}
          </span>
        )}
      </div>

      <div className="mono tabular-nums" style={{ fontSize: '24px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '4px' }}>
        {value}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', color: 'var(--text-muted)' }}>
        <span>{secondaryValue}</span>
        {evidenceChainId && onViewEvidence && (
          <button
            onClick={() => onViewEvidence(evidenceChainId)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--brand)',
              fontSize: '11px',
              fontWeight: 600,
              cursor: 'pointer',
              textDecoration: 'underline',
              padding: 0,
            }}
          >
            Evidence ↗
          </button>
        )}
      </div>
    </div>
  );
}
