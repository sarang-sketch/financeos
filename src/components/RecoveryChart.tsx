'use client';

import React, { useState } from 'react';
import { downloadTransactionsCsv } from '@/utils/export-transactions';

type TimeRange = '7D' | '30D' | '90D';

export function RecoveryChart() {
  const [range, setRange] = useState<TimeRange>('30D');
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = () => {
    setIsExporting(true);
    const days = range === '7D' ? 7 : range === '30D' ? 30 : 90;
    downloadTransactionsCsv(days);
    setTimeout(() => setIsExporting(false), 1000);
  };

  const chartData = {
    '7D': [
      { label: 'Aug 24', failed: 1.2, recovered: 0.95 },
      { label: 'Aug 25', failed: 1.8, recovered: 1.45 },
      { label: 'Aug 26', failed: 1.5, recovered: 1.20 },
      { label: 'Aug 27', failed: 2.1, recovered: 1.80 },
      { label: 'Aug 28', failed: 1.4, recovered: 1.15 },
      { label: 'Aug 29', failed: 2.4, recovered: 1.95 },
      { label: 'Aug 30', failed: 1.9, recovered: 1.60 },
    ],
    '30D': [
      { label: 'Aug 01', failed: 1.1, recovered: 0.8 },
      { label: 'Aug 05', failed: 1.8, recovered: 1.4 },
      { label: 'Aug 10', failed: 2.2, recovered: 1.7 },
      { label: 'Aug 15', failed: 1.6, recovered: 1.3 },
      { label: 'Aug 20', failed: 2.5, recovered: 2.0 },
      { label: 'Aug 25', failed: 1.9, recovered: 1.5 },
      { label: 'Aug 30', failed: 2.3, recovered: 1.9 },
    ],
    '90D': [
      { label: 'Jun W1', failed: 6.4, recovered: 4.8 },
      { label: 'Jun W3', failed: 7.2, recovered: 5.6 },
      { label: 'Jul W1', failed: 8.1, recovered: 6.5 },
      { label: 'Jul W3', failed: 7.8, recovered: 6.2 },
      { label: 'Aug W1', failed: 9.0, recovered: 7.4 },
      { label: 'Aug W3', failed: 8.4, recovered: 6.9 },
    ],
  }[range];

  const maxVal = Math.max(...chartData.map((d) => d.failed)) * 1.2;

  return (
    <div className="panel" style={{ padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <h3 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>
            Recovery Performance Over Time
          </h3>
          <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Comparing failed transaction volume vs autonomous AI-recovered volume
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* Time Range Selector */}
          <div style={{ display: 'flex', gap: '4px', background: 'var(--bg-surface-subtle)', padding: '3px', borderRadius: '6px', border: '1px solid var(--border-default)' }}>
            {(['7D', '30D', '90D'] as TimeRange[]).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                style={{
                  background: range === r ? '#ffffff' : 'transparent',
                  color: range === r ? 'var(--brand)' : 'var(--text-secondary)',
                  border: range === r ? '1px solid var(--border-default)' : '1px solid transparent',
                  borderRadius: '4px',
                  padding: '4px 10px',
                  fontSize: '11px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  boxShadow: range === r ? '0 1px 2px rgba(0,0,0,0.05)' : 'none',
                }}
              >
                {r}
              </button>
            ))}
          </div>

          {/* Download Excel Button */}
          <button
            onClick={handleExport}
            className="btn btn-secondary"
            style={{
              fontSize: '11px',
              padding: '5px 12px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              fontWeight: 600,
              background: '#ffffff',
              borderColor: 'var(--border-strong)',
            }}
          >
            <span>📊</span>
            <span>{isExporting ? 'Generating...' : `Download ${range} Excel`}</span>
          </button>
        </div>
      </div>

      {/* SVG Bar Visualization */}
      <div style={{ height: '180px', width: '100%', position: 'relative', display: 'flex', alignItems: 'flex-end', gap: '16px', paddingBottom: '24px', paddingTop: '10px' }}>
        {chartData.map((item, idx) => {
          const failedHeight = (item.failed / maxVal) * 140;
          const recoveredHeight = (item.recovered / maxVal) * 140;
          const recoveryRate = Math.round((item.recovered / item.failed) * 100);

          return (
            <div
              key={idx}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                height: '100%',
                justifyContent: 'flex-end',
                position: 'relative',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: '4px', width: '100%', justifyContent: 'center' }}>
                {/* Failed Bar */}
                <div
                  title={`Failed: ₹${item.failed}L`}
                  style={{
                    width: '40%',
                    maxWidth: '24px',
                    height: `${failedHeight}px`,
                    background: '#fee2e2',
                    border: '1px solid #fca5a5',
                    borderRadius: '4px 4px 0 0',
                    transition: 'height 0.3s ease',
                  }}
                />
                {/* Recovered Bar */}
                <div
                  title={`Recovered: ₹${item.recovered}L (${recoveryRate}%)`}
                  style={{
                    width: '40%',
                    maxWidth: '24px',
                    height: `${recoveredHeight}px`,
                    background: '#10b981',
                    borderRadius: '4px 4px 0 0',
                    transition: 'height 0.3s ease',
                  }}
                />
              </div>

              {/* X Axis Label */}
              <span
                style={{
                  position: 'absolute',
                  bottom: '0',
                  fontSize: '10px',
                  color: 'var(--text-muted)',
                  whiteSpace: 'nowrap',
                  fontWeight: 500,
                }}
              >
                {item.label}
              </span>
            </div>
          );
        })}
      </div>

      {/* Legend & Summary */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-subtle)', paddingTop: '12px', fontSize: '11px' }}>
        <div style={{ display: 'flex', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '2px', background: '#ef4444' }}></span>
            <span style={{ color: 'var(--text-secondary)' }}>Failed Volume</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '2px', background: '#10b981' }}></span>
            <span style={{ color: 'var(--text-secondary)' }}>Recovered Revenue (78.4% avg)</span>
          </div>
        </div>
        <div className="mono" style={{ color: 'var(--text-muted)' }}>
          Total Recovered ({range}): <strong style={{ color: 'var(--success-text)' }}>₹33.5 Lakh</strong>
        </div>
      </div>
    </div>
  );
}
