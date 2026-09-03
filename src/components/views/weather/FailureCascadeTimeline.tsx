'use client';

import React from 'react';
import type { WeatherRadarSummary } from '@/services/weather-radar-service';

interface FailureCascadeTimelineProps {
  telemetry: WeatherRadarSummary;
}

export function FailureCascadeTimeline({ telemetry }: FailureCascadeTimelineProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Cascade Progression */}
      <div className="panel" style={{ padding: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div>
            <span className="badge badge-danger" style={{ marginBottom: '4px' }}>CASCADE DETECTOR</span>
            <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
              Correlated Failure Cascade Progression
            </h3>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Detected 127 failures originating from a single systemic HDFC PG root cause
            </p>
          </div>
          <span className="badge badge-success">Confidence: 94%</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px', marginBottom: '16px' }}>
          {telemetry.cascadeProgression.map((item, idx) => (
            <div key={idx} style={{ padding: '12px', background: 'var(--bg-surface-subtle)', borderRadius: '6px', border: '1px solid var(--border-default)', textAlign: 'center' }}>
              <div className="mono font-bold" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{item.time}</div>
              <div className="mono tabular-nums" style={{ fontSize: '18px', fontWeight: 800, color: 'var(--danger-text)', margin: '4px 0' }}>
                {item.failuresCount} Failures
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>{item.cumulativeExposureInr}</div>
            </div>
          ))}
        </div>

        <div style={{ background: 'var(--bg-surface-subtle)', padding: '12px 14px', borderRadius: '6px', fontSize: '12px', color: 'var(--text-secondary)' }}>
          <strong>System Conclusion: </strong>Treating these as 127 independent payment failures would cause repeated gateway burn and customer fatigue. FinanceOS aggregated the batch under a single defense plan.
        </div>
      </div>

      {/* Incident Timeline */}
      <div className="panel" style={{ padding: '20px' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '16px' }}>
          Live Incident Timeline & Evidence Trail
        </h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {telemetry.incidentTimeline.map((node, idx) => (
            <div key={idx} style={{ display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
              <div className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)', minWidth: '70px', paddingTop: '2px' }}>
                {node.time}
              </div>
              <div style={{ flex: 1, padding: '10px 14px', background: 'var(--bg-surface-subtle)', borderRadius: '6px', border: '1px solid var(--border-default)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                  <strong style={{ fontSize: '12px', color: 'var(--text-primary)' }}>{node.title}</strong>
                  <span className={`badge ${node.severity === 'CRITICAL' ? 'badge-danger' : node.severity === 'WARNING' ? 'badge-warning' : 'badge-brand'}`} style={{ fontSize: '9px' }}>
                    {node.severity}
                  </span>
                </div>
                <p style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{node.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
