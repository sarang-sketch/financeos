'use client';

import React, { useState } from 'react';
import { MetricCard } from '@/components/MetricCard';
import { downloadTransactionsCsv } from '@/utils/export-transactions';

export function AnalyticsView() {
  const [downloadingDays, setDownloadingDays] = useState<number | null>(null);

  const handleDownload = (days: 7 | 30 | 90) => {
    setDownloadingDays(days);
    downloadTransactionsCsv(days);
    setTimeout(() => setDownloadingDays(null), 1000);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Top Analytics Metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
        <MetricCard label="Proposal Acceptance Rate" value="94.2%" trend="3.1%" trendDirection="up" status="success" />
        <MetricCard label="Customer vs Tenant Ratio" value="68% / 32%" trend="Customer dominant" trendDirection="neutral" status="info" />
        <MetricCard label="Average Time to Recover" value="4.2 mins" trend="12% faster" trendDirection="up" status="success" />
        <MetricCard label="Net Recovered Margin" value="98.2%" secondaryValue="Minimal gateway retry fees" status="success" />
      </div>

      {/* Excel / CSV Report Download Banner */}
      <div
        className="panel"
        style={{
          padding: '20px 24px',
          background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '16px',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <span className="badge badge-brand">Audit & Export</span>
            <span className="badge badge-success">Excel / CSV Supported</span>
          </div>
          <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
            Export Comprehensive Daily Transactions
          </h3>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Includes transaction IDs, timestamp (IST), customer profiles, payment methods, gross amounts, MDR fees, GST, and SHA-256 audit hashes.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={() => handleDownload(7)}
            disabled={downloadingDays !== null}
            className="btn btn-secondary"
            style={{ fontSize: '12px', padding: '7px 14px' }}
          >
            📊 {downloadingDays === 7 ? 'Exporting...' : 'Export 7 Days'}
          </button>
          <button
            onClick={() => handleDownload(30)}
            disabled={downloadingDays !== null}
            className="btn btn-primary"
            style={{ fontSize: '12px', padding: '7px 16px' }}
          >
            📊 {downloadingDays === 30 ? 'Exporting...' : 'Export 30 Days (Recommended)'}
          </button>
          <button
            onClick={() => handleDownload(90)}
            disabled={downloadingDays !== null}
            className="btn btn-secondary"
            style={{ fontSize: '12px', padding: '7px 14px' }}
          >
            📊 {downloadingDays === 90 ? 'Exporting...' : 'Export 90 Days'}
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        {/* Failure Reason Breakdown */}
        <div className="panel" style={{ padding: '20px' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '12px' }}>
            Payment Failure Reasons Breakdown
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {[
              { reason: 'Bank Gateway Server Timeout', count: 180, pct: '36%', color: '#4f46e5' },
              { reason: 'Insufficient Account Balance', count: 140, pct: '28%', color: '#f59e0b' },
              { reason: 'Authentication / 3DS Failure', count: 95, pct: '19%', color: '#0284c7' },
              { reason: 'Card Expired / Invalid CVV', count: 55, pct: '11%', color: '#ef4444' },
              { reason: 'UPI PIN Limit / Technical Dropout', count: 30, pct: '6%', color: '#10b981' },
            ].map((r) => (
              <div key={r.reason}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{r.reason}</span>
                  <span className="mono font-bold" style={{ color: 'var(--text-primary)' }}>
                    {r.count} ({r.pct})
                  </span>
                </div>
                <div style={{ height: '7px', background: 'var(--bg-surface-subtle)', borderRadius: '4px', overflow: 'hidden' }}>
                  <div style={{ width: r.pct, height: '100%', background: r.color, borderRadius: '4px' }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Evidence Basis Split */}
        <div className="panel" style={{ padding: '20px' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '12px' }}>
            Evidence Basis Distribution
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ padding: '14px', background: 'var(--brand-surface)', border: '1px solid var(--brand-border)', borderRadius: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <strong style={{ color: 'var(--brand-text)' }}>Customer-Level Evidence (68%)</strong>
                <span className="badge badge-brand">340 Payments</span>
              </div>
              <p style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                Calculated from specific customer transaction histories and historical payment method affinity.
              </p>
            </div>

            <div style={{ padding: '14px', background: 'var(--warning-surface)', border: '1px solid var(--warning-border)', borderRadius: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <strong style={{ color: 'var(--warning-text)' }}>Tenant-Level Fallback (32%)</strong>
                <span className="badge badge-warning">160 Payments</span>
              </div>
              <p style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                Applied when customer has zero prior successful transactions. Zero hallucinated history applied.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
