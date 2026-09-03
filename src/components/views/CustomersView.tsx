'use client';

import React from 'react';
import type { SeedCustomer } from '@/services/seed-data-service';

interface CustomersViewProps {
  customers: SeedCustomer[];
  onSelectCustomer: (customerId: string) => void;
}

export function CustomersView({ customers, onSelectCustomer }: CustomersViewProps) {
  return (
    <div className="panel" style={{ padding: '24px' }}>
      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>
          Customer Recovery Affinity Directory
        </h2>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Tracking historical payment volumes, preferred payment channels, and recovery success rates
        </p>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>Customer Name</th>
            <th>Customer ID</th>
            <th>Lifetime Value (LTV)</th>
            <th>Successful / Total</th>
            <th>Recovery Rate</th>
            <th>Preferred Channel</th>
            <th style={{ textAlign: 'right' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {customers.map((c) => (
            <tr key={c.id}>
              <td style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{c.name}</td>
              <td className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {c.id}
              </td>
              <td className="mono tabular-nums font-bold" style={{ color: 'var(--success-text)' }}>
                ₹{(c.ltv_paise / 100).toLocaleString('en-IN')}.00
              </td>
              <td className="mono">{c.successful_payments_count} / {c.total_payments_count}</td>
              <td>
                <span className={`badge ${c.successful_payments_count > 0 ? 'badge-success' : 'badge-warning'}`}>
                  {c.total_payments_count > 0
                    ? `${Math.round((c.successful_payments_count / c.total_payments_count) * 100)}%`
                    : '0%'}
                </span>
              </td>
              <td>
                <span className="badge badge-brand">{c.preferred_channel}</span>
              </td>
              <td style={{ textAlign: 'right' }}>
                <button
                  onClick={() => onSelectCustomer(c.id)}
                  className="btn btn-secondary"
                  style={{ fontSize: '11px', padding: '3px 8px' }}
                >
                  Profile ↗
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
