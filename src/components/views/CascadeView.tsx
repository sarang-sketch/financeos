'use client';

import React from 'react';
import { RecoveryMemoryService, type AdaptiveRecoveryCascade, type CustomerRecoveryBehavior } from '@/services/recovery-memory-service';

interface CascadeViewProps {
  onInspectEvidence: (id: string) => void;
}

export function CascadeView({ onInspectEvidence }: CascadeViewProps) {
  const cascade: AdaptiveRecoveryCascade = RecoveryMemoryService.getActiveCascade();
  const customerMemories: CustomerRecoveryBehavior[] = RecoveryMemoryService.getCustomerMemories();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* 1. Header Banner */}
      <div
        className="panel"
        style={{
          padding: '20px 24px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '16px',
          background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <span className="badge badge-brand">Adaptive State Machine</span>
            <span className="badge badge-success">Closed-Loop Learning</span>
          </div>
          <h1 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
            Adaptive Recovery Cascade & Customer Recovery Memory
          </h1>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
            Multi-step execution sequence: Observe → Learn → Decide → Act → Observe. Persists fine-grained customer recovery behavior.
          </p>
        </div>

        <button onClick={() => onInspectEvidence('chain_901')} className="btn btn-secondary">
          View Audit Digest Replay ↗
        </button>
      </div>

      {/* 2. Active Cascade State Machine Replay */}
      <div className="panel" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <div>
            <span className="badge badge-brand" style={{ marginBottom: '4px' }}>
              Active Cascade Replay: {cascade.cascadeId}
            </span>
            <h2 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>
              {cascade.customerName} • ₹{(cascade.amountPaise / 100).toLocaleString('en-IN')}.00
            </h2>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
              Execution completed in {cascade.totalTimeMinutes} minutes • Net Recovered: ₹{(cascade.netRecoveredPaise / 100).toLocaleString('en-IN')}.00
            </div>
          </div>
          <span className="badge badge-success" style={{ fontSize: '12px', padding: '4px 10px' }}>
            ✓ CASCADE RECOVERED
          </span>
        </div>

        {/* Vertical Timeline Steps */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', position: 'relative', paddingLeft: '24px' }}>
          {/* Vertical Connecting Line */}
          <div
            style={{
              position: 'absolute',
              top: '12px',
              bottom: '12px',
              left: '11px',
              width: '2px',
              background: 'var(--border-default)',
            }}
          />

          {cascade.steps.map((step) => (
            <div key={step.stepNumber} style={{ position: 'relative' }}>
              {/* Bullet point */}
              <div
                style={{
                  position: 'absolute',
                  left: '-24px',
                  top: '4px',
                  width: '22px',
                  height: '22px',
                  borderRadius: '50%',
                  background: step.actualOutcome === 'RECOVERED' ? 'var(--success)' : '#ffffff',
                  border: `2px solid ${step.actualOutcome === 'RECOVERED' ? 'var(--success)' : 'var(--brand)'}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '10px',
                  fontWeight: 700,
                  color: step.actualOutcome === 'RECOVERED' ? '#ffffff' : 'var(--brand)',
                }}
              >
                {step.stepNumber}
              </div>

              <div style={{ background: 'var(--bg-surface-subtle)', padding: '14px 16px', borderRadius: '6px', border: '1px solid var(--border-default)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <strong style={{ fontSize: '13px', color: 'var(--text-primary)' }}>{step.title}</strong>
                    <span className="badge badge-brand" style={{ fontSize: '9px' }}>{step.phase}</span>
                  </div>
                  <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{step.timestamp}</span>
                </div>

                <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                  {step.description}
                </p>

                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)', paddingTop: '6px', borderTop: '1px solid var(--border-subtle)' }}>
                  <span>Confidence: <strong style={{ color: 'var(--brand-text)' }}>{step.confidencePercent}%</strong></span>
                  <span className="mono">Audit Digest: {step.sha256AuditDigest}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 3. Customer Recovery Behavior Memory Directory */}
      <div className="panel" style={{ padding: '24px' }}>
        <div style={{ marginBottom: '16px' }}>
          <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
            Customer Recovery Behavior Memory Profiles
          </h3>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Empirical channel recovery conversion rates updated continuously after every recovery attempt
          </p>
        </div>

        <table className="data-table">
          <thead>
            <tr>
              <th>Customer Name</th>
              <th>Card Timeout Success</th>
              <th>WhatsApp Link Conv</th>
              <th>UPI Collect Success</th>
              <th>Preferred AI Intervention</th>
              <th>Total Net Recovered</th>
              <th>Last Updated</th>
            </tr>
          </thead>
          <tbody>
            {customerMemories.map((c) => (
              <tr key={c.customerId}>
                <td>
                  <strong style={{ color: 'var(--text-primary)' }}>{c.customerName}</strong>
                  <div className="mono" style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{c.customerId}</div>
                </td>
                <td>
                  <span className="mono font-bold" style={{ color: c.cardTimeoutRecoveryRate.percent >= 75 ? 'var(--success-text)' : 'var(--text-primary)' }}>
                    {c.cardTimeoutRecoveryRate.success}/{c.cardTimeoutRecoveryRate.attempts} ({c.cardTimeoutRecoveryRate.percent}%)
                  </span>
                </td>
                <td>
                  <span className="mono font-bold" style={{ color: c.whatsAppInteractiveRate.percent >= 75 ? 'var(--success-text)' : 'var(--text-primary)' }}>
                    {c.whatsAppInteractiveRate.success}/{c.whatsAppInteractiveRate.attempts} ({c.whatsAppInteractiveRate.percent}%)
                  </span>
                </td>
                <td>
                  <span className="mono font-bold">
                    {c.upiCollectSuccessRate.success}/{c.upiCollectSuccessRate.attempts} ({c.upiCollectSuccessRate.percent}%)
                  </span>
                </td>
                <td>
                  <span className="badge badge-brand">{c.preferredRecoveryIntervention}</span>
                </td>
                <td className="mono tabular-nums font-bold" style={{ color: 'var(--success-text)' }}>
                  ₹{(c.totalRevenueRecoveredPaise / 100).toLocaleString('en-IN')}.00
                </td>
                <td style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{c.lastUpdated}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
