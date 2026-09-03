'use client';

import React from 'react';
import { ExperimentService, type StrategyMetrics } from '@/services/experiment-service';

export function ExperimentView() {
  const strategies: StrategyMetrics[] = ExperimentService.getStrategiesComparison();

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
            <span className="badge badge-brand">Strategy Optimization Lab</span>
            <span className="badge badge-success">+25.7% Net Revenue Uplift</span>
          </div>
          <h1 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
            Recovery Strategy A/B Benchmark & Uplift Analysis
          </h1>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
            Empirically comparing Adaptive Digital Twin recovery vs traditional immediate blind retry across historical transaction batches.
          </p>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>MEASURED NET GAIN VS BASELINE</div>
          <div className="mono tabular-nums" style={{ fontSize: '22px', fontWeight: 800, color: 'var(--success-text)' }}>
            +₹7,41,000.00
          </div>
        </div>
      </div>

      {/* 2. Strategy Comparison Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '16px' }}>
        {strategies.map((strat) => {
          const isWinner = strat.strategyId === 'STRAT_B_ADAPTIVE';
          return (
            <div
              key={strat.strategyId}
              className="panel-raised"
              style={{
                padding: '20px',
                borderTop: `4px solid ${isWinner ? 'var(--brand)' : 'var(--border-strong)'}`,
                background: isWinner ? 'var(--brand-surface)' : '#ffffff',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                  <span className={`badge ${isWinner ? 'badge-brand' : 'badge-neutral'}`}>
                    {isWinner ? '★ HIGHEST NET VALUE' : 'BENCHMARK'}
                  </span>
                  <span className="mono font-bold" style={{ fontSize: '16px', color: isWinner ? 'var(--brand-text)' : 'var(--text-primary)' }}>
                    {strat.recoveryRatePercent}% Rate
                  </span>
                </div>

                <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '6px' }}>
                  {strat.name}
                </h3>
                <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.45, marginBottom: '14px' }}>
                  {strat.description}
                </p>

                <div style={{ background: '#ffffff', padding: '12px', borderRadius: '6px', border: '1px solid var(--border-default)', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Gross Recovered:</span>
                    <strong className="mono">₹{(strat.grossRecoveredPaise / 10000000).toFixed(2)} Lakh</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Net Recovered:</span>
                    <strong className="mono" style={{ color: 'var(--success-text)' }}>₹{(strat.netRecoveredPaise / 10000000).toFixed(2)} Lakh</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Avg Retries Per Recovery:</span>
                    <span className="mono font-bold">{strat.averageAttemptsPerRecovery}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Unnecessary Retries Burned:</span>
                    <span className="mono font-bold" style={{ color: strat.unnecessaryRetryBurnCount > 100 ? 'var(--danger-text)' : 'var(--success-text)' }}>
                      {strat.unnecessaryRetryBurnCount} attempts
                    </span>
                  </div>
                </div>
              </div>

              <div style={{ marginTop: '14px', paddingTop: '10px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Net Uplift:</span>
                <span className="mono font-bold" style={{ fontSize: '14px', color: isWinner ? 'var(--success-text)' : 'var(--text-secondary)' }}>
                  {strat.upliftVsBaselinePercent > 0 ? `+${strat.upliftVsBaselinePercent}% (+₹${(strat.netDollarUpliftPaise / 10000000).toFixed(2)}L)` : 'Baseline (0%)'}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* 3. Detailed Strategy Table */}
      <div className="panel" style={{ padding: '20px' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '14px' }}>
          Side-by-Side Efficiency Breakdown
        </h3>

        <table className="data-table">
          <thead>
            <tr>
              <th>Recovery Strategy</th>
              <th>Success Rate</th>
              <th>Net Recovered Revenue</th>
              <th>Avg Attempts</th>
              <th>Friction</th>
              <th>Avg Resolution Time</th>
              <th>Unnecessary Retries</th>
              <th>Net Uplift</th>
            </tr>
          </thead>
          <tbody>
            {strategies.map((strat) => (
              <tr key={strat.strategyId}>
                <td>
                  <strong style={{ color: 'var(--text-primary)' }}>{strat.name}</strong>
                </td>
                <td className="mono font-bold" style={{ color: 'var(--success-text)' }}>{strat.recoveryRatePercent}%</td>
                <td className="mono tabular-nums font-bold">₹{(strat.netRecoveredPaise / 100).toLocaleString('en-IN')}.00</td>
                <td className="mono">{strat.averageAttemptsPerRecovery}</td>
                <td>
                  <span className={`badge ${strat.customerFrictionScore === 'Low' ? 'badge-success' : 'badge-warning'}`}>
                    {strat.customerFrictionScore}
                  </span>
                </td>
                <td className="mono">{strat.averageTimeMinutes} mins</td>
                <td className="mono" style={{ color: strat.unnecessaryRetryBurnCount > 100 ? 'var(--danger-text)' : 'var(--success-text)' }}>
                  {strat.unnecessaryRetryBurnCount}
                </td>
                <td className="mono font-bold" style={{ color: strat.upliftVsBaselinePercent > 0 ? 'var(--success-text)' : 'var(--text-muted)' }}>
                  {strat.upliftVsBaselinePercent > 0 ? `+${strat.upliftVsBaselinePercent}%` : '0%'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
