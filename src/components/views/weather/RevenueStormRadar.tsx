'use client';

import React, { useState } from 'react';
import type { WeatherRadarSummary, StormRadarNetworkNode } from '@/services/weather-radar-service';

interface RevenueStormRadarProps {
  telemetry: WeatherRadarSummary;
}

export function RevenueStormRadar({ telemetry }: RevenueStormRadarProps) {
  const [selectedNetworkNodeId, setSelectedNetworkNodeId] = useState<string>('node_hdfc');
  const selectedNode = telemetry.networkNodes.find((n) => n.id === selectedNetworkNodeId) || telemetry.networkNodes[0]!;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Network Topology Visualizer */}
      <div className="panel" style={{ padding: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
          <div>
            <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
              Revenue Storm Radar (Payment Ecosystem Exposure Network)
            </h3>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Live financial exposure mapping: Gateway → Bank → Method → Failure Type → Customer Segment → Financial Exposure
            </p>
          </div>
          <span className="badge badge-brand">Click node to inspect</span>
        </div>

        {/* Nodes Grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px', marginBottom: '14px' }}>
          {telemetry.networkNodes.map((node) => {
            const isSelected = selectedNetworkNodeId === node.id;
            return (
              <div
                key={node.id}
                onClick={() => setSelectedNetworkNodeId(node.id)}
                className="card-interactive"
                style={{
                  padding: '12px',
                  cursor: 'pointer',
                  border: isSelected ? '2px solid var(--brand)' : `1px solid ${node.status === 'CRITICAL' ? 'var(--danger-border)' : 'var(--border-default)'}`,
                  background: isSelected ? 'var(--brand-surface)' : node.status === 'CRITICAL' ? 'var(--danger-surface)' : '#ffffff',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>
                  <span>{node.type}</span>
                  <span className={`badge ${node.status === 'CRITICAL' ? 'badge-danger' : node.status === 'WARNING' ? 'badge-warning' : 'badge-success'}`} style={{ fontSize: '8px', padding: '1px 4px' }}>
                    {node.status}
                  </span>
                </div>
                <strong style={{ fontSize: '12px', color: 'var(--text-primary)', display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {node.label}
                </strong>
                <div className="mono tabular-nums font-bold" style={{ fontSize: '13px', color: node.status === 'CRITICAL' ? 'var(--danger-text)' : 'var(--text-primary)', marginTop: '4px' }}>
                  {node.exposureInr} <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>exposed</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Selected Node Details */}
        <div style={{ background: 'var(--bg-surface-subtle)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border-default)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
            <strong style={{ fontSize: '14px', color: 'var(--text-primary)' }}>
              Selected Node: {selectedNode.label} ({selectedNode.type})
            </strong>
            <span className="mono font-bold" style={{ color: 'var(--success-text)' }}>
              Recoverable: {selectedNode.recoverableInr} ({selectedNode.affectedCount} Txns)
            </span>
          </div>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
            {selectedNode.description}
          </p>
          {selectedNode.latencyMs && (
            <div style={{ display: 'flex', gap: '16px', fontSize: '11px', color: 'var(--text-muted)' }}>
              <span>Latency: <strong className="mono" style={{ color: 'var(--danger-text)' }}>{selectedNode.latencyMs}ms</strong></span>
              <span>Failure Rate: <strong className="mono">{selectedNode.failureRate}%</strong> (Base: {selectedNode.baselineRate}%)</span>
              <span>Spike: <strong className="mono" style={{ color: 'var(--danger-text)' }}>{selectedNode.spikeFactor}x</strong></span>
            </div>
          )}
        </div>
      </div>

      {/* Velocity Trend & Early Warning */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        <div className="panel" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div>
              <h3 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>
                Failure Velocity Trend (Last 60 Minutes)
              </h3>
              <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                Failures / minute velocity curve
              </p>
            </div>
            <span className="badge badge-warning">3.61x Acceleration</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '10px', height: '120px', paddingBottom: '20px', position: 'relative' }}>
            {telemetry.velocityHistory.map((pt, i) => {
              const heightPct = (pt.velocity / 20) * 100;
              return (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'flex-end' }}>
                  <div
                    title={`${pt.timeOffset}: ${pt.velocity}/min`}
                    style={{
                      width: '100%',
                      maxWidth: '24px',
                      height: `${heightPct}%`,
                      background: pt.velocity > 10 ? 'var(--danger)' : 'var(--brand)',
                      borderRadius: '3px 3px 0 0',
                      transition: 'height 0.3s ease',
                    }}
                  />
                  <span style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '4px' }}>{pt.timeOffset}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="panel" style={{ padding: '20px', borderLeft: '4px solid var(--warning)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span className="badge badge-warning" style={{ fontWeight: 700 }}>
              ⚠️ EARLY WARNING SYSTEM [FORECAST]
            </span>
            <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Confidence: {telemetry.earlyWarning.confidencePercent}%
            </span>
          </div>

          <h4 style={{ fontSize: '14px', fontWeight: 800, color: 'var(--warning-text)', marginBottom: '6px' }}>
            Possible Revenue Storm in {telemetry.earlyWarning.estimatedWindowMins}
          </h4>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
            Failure velocity acceleration and +{telemetry.earlyWarning.latencyDeviationPercent}% latency deviation predict an additional {telemetry.earlyWarning.projectedExposureInr} at risk before the afternoon clearing window.
          </p>

          <div style={{ background: 'var(--bg-surface-subtle)', padding: '10px', borderRadius: '6px', fontSize: '11px', color: 'var(--text-primary)' }}>
            <strong>Recommended Preparation: </strong>{telemetry.earlyWarning.preparationGuidance}
          </div>
        </div>
      </div>
    </div>
  );
}
