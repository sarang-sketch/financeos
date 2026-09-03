'use client';

import React from 'react';
import type { WeatherRadarSummary } from '@/services/weather-radar-service';

interface HighLtvProtectionTableProps {
  telemetry: WeatherRadarSummary;
}

export function HighLtvProtectionTable({ telemetry }: HighLtvProtectionTableProps) {
  return (
    <div className="panel" style={{ padding: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div>
          <span className="badge badge-brand" style={{ marginBottom: '4px' }}>HIGH-VALUE SHIELD</span>
          <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
            High-LTV Customer Revenue Protection
          </h3>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            ₹3.20 Lakh high-LTV exposure across 43 accounts • 31 customers have &gt;80% recovery probability
          </p>
        </div>
        <span className="badge badge-success">Protect High-LTV First</span>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>Customer</th>
            <th>Customer LTV</th>
            <th>Exposed Amount</th>
            <th>Recovery Prob</th>
            <th>Channel Preference</th>
            <th>Recommended Defense Action</th>
            <th>Urgency</th>
          </tr>
        </thead>
        <tbody>
          {telemetry.highLtvCustomers.map((cust) => (
            <tr key={cust.customerId}>
              <td>
                <strong style={{ color: 'var(--text-primary)' }}>{cust.customerName}</strong>
                <div className="mono" style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{cust.customerId}</div>
              </td>
              <td className="mono tabular-nums font-bold" style={{ color: 'var(--success-text)' }}>
                {cust.ltvInr}
              </td>
              <td className="mono tabular-nums font-bold" style={{ color: 'var(--danger-text)' }}>
                {cust.amountAtRiskInr}
              </td>
              <td>
                <span className="badge badge-success">{cust.recoveryProbabilityPercent}%</span>
              </td>
              <td style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{cust.channelPreference}</td>
              <td>
                <span className="badge badge-brand">{cust.recommendedAction}</span>
              </td>
              <td>
                <span className={`badge ${cust.urgency === 'CRITICAL' ? 'badge-danger' : 'badge-warning'}`}>
                  {cust.urgency}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
