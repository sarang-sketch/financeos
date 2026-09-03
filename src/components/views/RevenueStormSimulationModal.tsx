'use client';

import React, { useState, useEffect } from 'react';

interface RevenueStormSimulationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onViewEvidence: (id: string) => void;
}

const STAGES = [
  {
    step: 1,
    name: 'Normal Baseline Operations',
    velocity: '5.1 / min',
    latency: '42ms',
    exposure: '₹0.00',
    detail: 'All payment rails (UPI, Card, Netbanking) operating within healthy 99.2% availability baseline.',
  },
  {
    step: 2,
    name: 'Failure Velocity Spike',
    velocity: '18.4 / min (+361%)',
    latency: '140ms',
    exposure: '₹1.42 Lakh',
    detail: 'Sudden acceleration in payment failures detected across 3DS card authorization routes.',
  },
  {
    step: 3,
    name: 'Gateway Latency Elevated',
    velocity: '18.4 / min',
    latency: '340ms (+710%)',
    exposure: '₹3.60 Lakh',
    detail: 'HDFC core banking clearing server timeout >5,000ms response time.',
  },
  {
    step: 4,
    name: 'Correlated Failure Cascade Detected',
    velocity: '18.4 / min',
    latency: '340ms',
    exposure: '₹6.90 Lakh',
    detail: 'FinanceOS machine detector classifies 127 failures as a single correlated systemic incident (94% confidence).',
  },
  {
    step: 5,
    name: 'Revenue Exposure Peak',
    velocity: '18.4 / min',
    latency: '340ms',
    exposure: '₹8.40 Lakh',
    detail: 'Total financial exposure reaches ₹8.40 Lakh across 83 unique merchant customer accounts.',
  },
  {
    step: 6,
    name: 'Revenue Decay Forecast Calculated',
    velocity: '18.4 / min',
    latency: '340ms',
    exposure: '₹8.40 Lakh',
    detail: 'Predictive model: If no action is taken, recoverable value erodes to ₹1.84 Lakh in 24 hours (₹6.56L loss).',
  },
  {
    step: 7,
    name: 'Counterfactual Futures Evaluated',
    velocity: '18.4 / min',
    latency: '340ms',
    exposure: '₹8.40 Lakh',
    detail: 'Simulated 5 response strategies. Immediate retry rejected due to 85% duplicate failure risk during timeout.',
  },
  {
    step: 8,
    name: 'Optimal Intervention Chosen',
    velocity: '18.4 / min',
    latency: '340ms',
    exposure: '₹8.40 Lakh',
    detail: 'Best Action: Pause card retries for 10 minutes + reroute eligible dropouts to WhatsApp UPI Link (Net EV: ₹6.90L).',
  },
  {
    step: 9,
    name: 'Policy Gate & Safety Evaluation',
    velocity: '18.4 / min',
    latency: '340ms',
    exposure: '₹8.40 Lakh',
    detail: 'Validated 8 policy checks: retry debounce active, monetary limits respected, duplicate prevention engaged.',
  },
  {
    step: 10,
    name: 'Autonomous Revenue Defense Plan Executed',
    velocity: 'Normalized',
    latency: '48ms',
    exposure: 'Defended',
    detail: '117 retries suppressed, ₹7.84 Lakh revenue defended, ₹6.90 Lakh net cash recovered, 83 customers protected.',
  },
];

export function RevenueStormSimulationModal({ isOpen, onClose, onViewEvidence }: RevenueStormSimulationModalProps) {
  const [currentStageIndex, setCurrentStageIndex] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(true);

  useEffect(() => {
    if (!isOpen) {
      setCurrentStageIndex(0);
      setIsPlaying(true);
      return;
    }

    if (!isPlaying) return;

    const timer = setInterval(() => {
      setCurrentStageIndex((prev) => {
        if (prev >= STAGES.length - 1) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, 2400);

    return () => clearInterval(timer);
  }, [isOpen, isPlaying]);

  if (!isOpen) return null;

  const currentStage = STAGES[currentStageIndex]!;
  const isFinished = currentStageIndex === STAGES.length - 1;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.65)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 200,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '780px',
          maxWidth: '92vw',
          maxHeight: '90vh',
          background: '#ffffff',
          borderRadius: '12px',
          border: '1px solid var(--border-default)',
          boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          overflowY: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid var(--border-default)', paddingBottom: '16px', marginBottom: '16px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <span className="badge badge-brand">Autonomous Simulation</span>
              <span className="badge badge-warning">Live Revenue Storm Replay</span>
            </div>
            <h2 style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>
              10-Stage Revenue Storm Defense Lifecycle
            </h2>
          </div>

          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '18px', cursor: 'pointer', color: 'var(--text-muted)' }}>
            ✕
          </button>
        </div>

        {/* Live Stage Progress Indicator */}
        <div style={{ display: 'flex', gap: '4px', marginBottom: '18px' }}>
          {STAGES.map((s, idx) => (
            <div
              key={s.step}
              onClick={() => {
                setIsPlaying(false);
                setCurrentStageIndex(idx);
              }}
              style={{
                flex: 1,
                height: '8px',
                borderRadius: '4px',
                background:
                  idx === currentStageIndex
                    ? 'var(--brand)'
                    : idx < currentStageIndex
                    ? 'var(--success)'
                    : 'var(--border-default)',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
              }}
              title={`Stage ${s.step}: ${s.name}`}
            />
          ))}
        </div>

        {/* Active Stage Callout Box */}
        <div
          style={{
            padding: '20px',
            background: isFinished ? 'var(--success-surface)' : 'var(--bg-surface-subtle)',
            borderRadius: '8px',
            border: `1px solid ${isFinished ? 'var(--success-border)' : 'var(--border-default)'}`,
            marginBottom: '20px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span className="badge badge-brand" style={{ fontSize: '11px' }}>
              STAGE {currentStage.step} OF 10
            </span>
            <span className="mono" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Latency: <strong style={{ color: 'var(--text-primary)' }}>{currentStage.latency}</strong> • Velocity: <strong style={{ color: 'var(--text-primary)' }}>{currentStage.velocity}</strong>
            </span>
          </div>

          <h3 style={{ fontSize: '16px', fontWeight: 800, color: isFinished ? 'var(--success-text)' : 'var(--text-primary)', marginBottom: '8px' }}>
            {currentStage.name}
          </h3>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {currentStage.detail}
          </p>
        </div>

        {/* Final Execution Results Banner (Visible on Stage 10) */}
        {isFinished && (
          <div style={{ padding: '16px', background: '#ffffff', borderRadius: '8px', border: '1px solid var(--success-border)', marginBottom: '20px' }}>
            <h4 style={{ fontSize: '13px', fontWeight: 800, color: 'var(--success-text)', marginBottom: '10px' }}>
              ✓ Autonomous Defense Outcome Summary
            </h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
              <div style={{ padding: '10px', background: 'var(--success-surface)', borderRadius: '6px' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>REVENUE DEFENDED</div>
                <div className="mono" style={{ fontSize: '16px', fontWeight: 800, color: 'var(--success-text)' }}>₹7.84 Lakh</div>
              </div>
              <div style={{ padding: '10px', background: 'var(--brand-surface)', borderRadius: '6px' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>UNNECESSARY RETRIES AVOIDED</div>
                <div className="mono" style={{ fontSize: '16px', fontWeight: 800, color: 'var(--brand-text)' }}>117 Attempts</div>
              </div>
              <div style={{ padding: '10px', background: 'var(--bg-surface-subtle)', borderRadius: '6px' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>NET CASH RECOVERED</div>
                <div className="mono" style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>₹6.90 Lakh</div>
              </div>
            </div>
          </div>
        )}

        {/* Controls Footer */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '12px', borderTop: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => setIsPlaying(!isPlaying)}
              className="btn btn-secondary"
              style={{ fontSize: '12px', padding: '6px 14px' }}
            >
              {isPlaying ? '⏸ Pause' : '▶ Play Replay'}
            </button>
            <button
              onClick={() => {
                setIsPlaying(false);
                setCurrentStageIndex((prev) => Math.max(0, prev - 1));
              }}
              disabled={currentStageIndex === 0}
              className="btn btn-secondary"
              style={{ fontSize: '12px' }}
            >
              ← Prev
            </button>
            <button
              onClick={() => {
                setIsPlaying(false);
                setCurrentStageIndex((prev) => Math.min(STAGES.length - 1, prev + 1));
              }}
              disabled={currentStageIndex === STAGES.length - 1}
              className="btn btn-secondary"
              style={{ fontSize: '12px' }}
            >
              Next →
            </button>
          </div>

          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={() => {
                onClose();
                onViewEvidence('chain_storm_hdfc');
              }}
              className="btn btn-secondary"
              style={{ fontSize: '12px' }}
            >
              View Decision Proof ↗
            </button>
            <button onClick={onClose} className="btn btn-primary" style={{ fontSize: '12px' }}>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
