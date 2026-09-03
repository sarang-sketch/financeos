'use client';

import React, { useState } from 'react';
import { WeatherRadarService, type WeatherRadarSummary } from '@/services/weather-radar-service';
import { RevenueStormSimulationModal } from './RevenueStormSimulationModal';
import { RevenueStormRadar } from './weather/RevenueStormRadar';
import { RevenueDefenseActionCenter } from './weather/RevenueDefenseActionCenter';
import { HighLtvProtectionTable } from './weather/HighLtvProtectionTable';
import { FailureCascadeTimeline } from './weather/FailureCascadeTimeline';

interface WeatherRadarViewProps {
  onInspectLeak: (leakId: string) => void;
  onApplyIntervention: (leakId: string) => void;
  onInspectEvidence?: (id: string) => void;
  onNavigateToDecisionLab?: () => void;
}

export function WeatherRadarView({
  onInspectLeak,
  onApplyIntervention,
  onInspectEvidence = () => {},
  onNavigateToDecisionLab = () => {},
}: WeatherRadarViewProps) {
  const telemetry: WeatherRadarSummary = WeatherRadarService.getTelemetry();
  const [isSimModalOpen, setIsSimModalOpen] = useState<boolean>(false);
  const [activeTabSection, setActiveTabSection] = useState<'OVERVIEW' | 'DEFENSE_ACTIONS' | 'HIGH_LTV' | 'CASCADE'>('OVERVIEW');

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
            <span className="badge badge-danger">Live Revenue Defense</span>
            <span className="badge badge-brand">Autonomy: {telemetry.autonomyState}</span>
            <span className="badge badge-warning">Storm Severity: {telemetry.stormSeverity}</span>
          </div>
          <h1 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
            Failure Weather & Revenue Defense
          </h1>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
            Predict revenue storms before they become revenue losses. Real-time systemic failure defense and retry suppression.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={() => setIsSimModalOpen(true)}
            className="btn btn-primary"
            style={{ fontWeight: 700, padding: '7px 16px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <span>🎬</span>
            <span>Run Revenue Storm Simulation</span>
          </button>
          <button
            onClick={onNavigateToDecisionLab}
            className="btn btn-secondary"
            style={{ fontWeight: 700 }}
          >
            Simulate Response ↗
          </button>
        </div>
      </div>

      {/* 2. Immediate 4-Question Executive Summary Bar */}
      <div
        className="panel-raised"
        style={{
          padding: '16px 20px',
          background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
          color: '#ffffff',
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '16px',
        }}
      >
        <div>
          <div style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            1. WHAT IS FAILING?
          </div>
          <div style={{ fontSize: '13px', fontWeight: 800, color: '#f87171', marginTop: '2px' }}>
            HDFC 3DS Card Auth (340ms)
          </div>
          <div style={{ fontSize: '11px', color: '#cbd5e1' }}>Latency +369% error spike</div>
        </div>

        <div>
          <div style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            2. MONEY AT RISK?
          </div>
          <div className="mono tabular-nums" style={{ fontSize: '14px', fontWeight: 800, color: '#fbbf24', marginTop: '2px' }}>
            ₹8.40 Lakh (127 Txns)
          </div>
          <div style={{ fontSize: '11px', color: '#cbd5e1' }}>₹6.90 Lakh recoverable</div>
        </div>

        <div>
          <div style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            3. IF WE DO NOTHING?
          </div>
          <div style={{ fontSize: '13px', fontWeight: 800, color: '#f87171', marginTop: '2px' }}>
            ₹6.56 Lakh Lost in 24h
          </div>
          <div style={{ fontSize: '11px', color: '#cbd5e1' }}>Decays to ₹1.84L [PREDICTED]</div>
        </div>

        <div>
          <div style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            4. FINANCEOS ACTION:
          </div>
          <div style={{ fontSize: '13px', fontWeight: 800, color: '#34d399', marginTop: '2px' }}>
            Pause Retries 10m + Route UPI
          </div>
          <div style={{ fontSize: '11px', color: '#cbd5e1' }}>117 retries suppressed</div>
        </div>
      </div>

      {/* 3. Top Key Metrics Strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
        <div className="panel" style={{ padding: '16px', borderLeft: '4px solid var(--danger)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>REVENUE STORM INDEX</span>
            <span className="badge badge-danger">CRITICAL</span>
          </div>
          <div className="mono tabular-nums" style={{ fontSize: '24px', fontWeight: 800, color: 'var(--danger-text)', margin: '4px 0' }}>
            {telemetry.stormIndex} <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>/ 100</span>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
            Velocity 3.61x • ₹8.40L exposed
          </div>
        </div>

        <div className="panel" style={{ padding: '16px', borderLeft: '4px solid var(--warning)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>FAILURE VELOCITY</span>
            <span className="badge badge-warning">{telemetry.velocityAcceleration}x Accel</span>
          </div>
          <div className="mono tabular-nums" style={{ fontSize: '24px', fontWeight: 800, color: 'var(--warning-text)', margin: '4px 0' }}>
            {telemetry.currentFailureVelocity} <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>/ min</span>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
            Baseline: {telemetry.baselineFailureVelocity} failures/min
          </div>
        </div>

        <div className="panel" style={{ padding: '16px', borderLeft: '4px solid var(--success)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>REVENUE DEFENDED</span>
            <span className="badge badge-success">SAVED</span>
          </div>
          <div className="mono tabular-nums" style={{ fontSize: '24px', fontWeight: 800, color: 'var(--success-text)', margin: '4px 0' }}>
            ₹{(telemetry.totalRevenueDefendedPaise / 10000000).toFixed(2)} Lakh
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
            Loss avoided via retry suppression
          </div>
        </div>

        <div className="panel" style={{ padding: '16px', borderLeft: '4px solid var(--brand)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>RETRY SUPPRESSION</span>
            <span className="badge badge-brand">PROTECTED</span>
          </div>
          <div className="mono tabular-nums" style={{ fontSize: '24px', fontWeight: 800, color: 'var(--brand-text)', margin: '4px 0' }}>
            {telemetry.suppressedRetriesTotal} <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Txns</span>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
            342 duplicates avoided (₹14.3k saved)
          </div>
        </div>
      </div>

      {/* 4. Section Tabs Navigation */}
      <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid var(--border-default)', paddingBottom: '8px' }}>
        {[
          { id: 'OVERVIEW', label: 'Revenue Storm Radar & Topology' },
          { id: 'DEFENSE_ACTIONS', label: 'Action Center & Decay Forecast' },
          { id: 'HIGH_LTV', label: 'High-LTV Customer Protection' },
          { id: 'CASCADE', label: 'Failure Cascade & Incident Timeline' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTabSection(tab.id as any)}
            style={{
              padding: '6px 14px',
              borderRadius: '6px',
              border: 'none',
              background: activeTabSection === tab.id ? 'var(--brand-surface)' : 'transparent',
              color: activeTabSection === tab.id ? 'var(--brand-text)' : 'var(--text-secondary)',
              fontWeight: activeTabSection === tab.id ? 700 : 500,
              fontSize: '12px',
              cursor: 'pointer',
              borderBottom: activeTabSection === tab.id ? '2px solid var(--brand)' : '2px solid transparent',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 5. Active Section Content */}
      {activeTabSection === 'OVERVIEW' && (
        <RevenueStormRadar telemetry={telemetry} />
      )}

      {activeTabSection === 'DEFENSE_ACTIONS' && (
        <RevenueDefenseActionCenter
          telemetry={telemetry}
          onApplyIntervention={onApplyIntervention}
          onInspectEvidence={onInspectEvidence}
          onNavigateToDecisionLab={onNavigateToDecisionLab}
        />
      )}

      {activeTabSection === 'HIGH_LTV' && (
        <HighLtvProtectionTable telemetry={telemetry} />
      )}

      {activeTabSection === 'CASCADE' && (
        <FailureCascadeTimeline telemetry={telemetry} />
      )}

      {/* 6. Live Revenue Storm Simulation Modal */}
      <RevenueStormSimulationModal
        isOpen={isSimModalOpen}
        onClose={() => setIsSimModalOpen(false)}
        onViewEvidence={onInspectEvidence}
      />
    </div>
  );
}
