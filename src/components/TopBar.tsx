'use client';

import React, { useEffect, useState } from 'react';
import type { NavTab } from './Sidebar';
import { downloadTransactionsCsv } from '@/utils/export-transactions';
import { TopBarAskAssistant } from './TopBarAskAssistant';

interface TopBarProps {
  activeTab: NavTab;
  onSelectTab?: (tab: NavTab) => void;
  onRefresh?: () => void;
  onIngestClick?: () => void;
  isAssistantOpen?: boolean;
  onToggleAssistant?: () => void;
}

export function TopBar({
  activeTab,
  onSelectTab: _onSelectTab,
  onRefresh: _onRefresh,
  onIngestClick,
  isAssistantOpen: propAssistantOpen,
  onToggleAssistant,
}: TopBarProps) {
  const [internalAssistantOpen, setInternalAssistantOpen] = useState<boolean>(false);
  const assistantOpen = propAssistantOpen !== undefined ? propAssistantOpen : internalAssistantOpen;
  const handleToggleAssistant = onToggleAssistant || (() => setInternalAssistantOpen((prev) => !prev));
  const [timeIst, setTimeIst] = useState<string>('');
  const [timeUtc, setTimeUtc] = useState<string>('');
  const [showExportMenu, setShowExportMenu] = useState<boolean>(false);

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setTimeUtc(now.toISOString().slice(11, 19) + ' UTC');
      setTimeIst(
        now.toLocaleTimeString('en-IN', {
          timeZone: 'Asia/Kolkata',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }) + ' IST',
      );
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  const titles: Record<NavTab, { title: string; subtitle: string }> = {
    dashboard: { title: 'Executive Dashboard', subtitle: 'Merchant revenue growth, autonomous AI buyer commerce, and cashflow optimization' },
    ai_buyer_demo: { title: 'AI Buyer ↔ Merchant Lab', subtitle: 'Dual-screen live transaction loop: Autonomous AI buyer on left, Merchant Control Room on right' },
    agentic_commerce: { title: 'AI Growth & Commerce', subtitle: 'Autonomous AI buyer checkout, agent-readable catalog, and upsell engine' },
    buyer_activity: { title: 'Abandoned Carts & Recovery', subtitle: 'Real-time store visitor intent tracking, dropped checkouts, and multi-channel recovery' },
    decision_lab: { title: 'Recovery Decision Lab', subtitle: 'Counterfactual simulator & Net Expected Value optimization' },
    weather_radar: { title: 'Failure Weather & Revenue Defense', subtitle: 'Predict revenue storms before they become revenue losses.' },
    failed_payments: { title: 'Failed Payments & Action Queue', subtitle: 'Historical failures, root-cause classification, and recovery proposal dispatch' },
    audit_logs: { title: 'Audit Trail & Cryptographic Proofs', subtitle: 'RFC-8785 SHA-256 hash-chained financial state audit log and replay' },
    agent_manager: { title: 'Agent Manager Mode', subtitle: 'Future Scope: Connectors, Agent Runners, Wallets & AI Content Generation — Roadmap 2027' },
    settings: { title: 'Settings & Policy', subtitle: 'Auto-recovery thresholds, approval rules, and notification preferences' },
  };

  const handleDownload = (days: 7 | 30 | 90) => {
    setShowExportMenu(false);
    downloadTransactionsCsv(days);
  };

  return (
    <>
      <header className="top-bar">
      {/* Breadcrumb & Section Info */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
          <span style={{ color: 'var(--text-muted)' }}>FinanceOS</span>
          <span style={{ color: 'var(--text-muted)' }}>/</span>
          <span style={{ color: 'var(--text-muted)' }}>AI Growth & Commerce</span>
          <span style={{ color: 'var(--text-muted)' }}>/</span>
          <span style={{ color: 'var(--brand)', fontWeight: 700 }}>{titles[activeTab]?.title || 'Overview'}</span>
        </div>
      </div>

      {/* Right Actions & Clock */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', position: 'relative' }}>
        {/* Real-time IST / UTC Clock */}
        <div className="mono" style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', background: 'var(--bg-surface-subtle)', padding: '5px 12px', borderRadius: '6px', border: '1px solid var(--border-default)' }}>
          <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{timeIst || '00:00:00 IST'}</span>
          <span style={{ color: 'var(--text-muted)' }}>•</span>
          <span style={{ color: 'var(--text-muted)' }}>{timeUtc || '00:00:00 UTC'}</span>
        </div>

        {/* Excel Export Dropdown */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setShowExportMenu(!showExportMenu)}
            className="btn btn-secondary"
            style={{ fontSize: '12px', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <span>📥</span>
            <span>Export Excel</span>
            <span style={{ fontSize: '9px' }}>▼</span>
          </button>

          {showExportMenu && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                marginTop: '6px',
                width: '240px',
                background: '#ffffff',
                border: '1px solid var(--border-default)',
                borderRadius: '8px',
                boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                padding: '6px',
                zIndex: 100,
                display: 'flex',
                flexDirection: 'column',
                gap: '2px',
              }}
            >
              <div style={{ padding: '6px 10px', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
                SELECT TRANSACTION TIMEFRAME
              </div>
              <button
                onClick={() => handleDownload(7)}
                className="btn btn-secondary"
                style={{ justifyContent: 'flex-start', border: 'none', padding: '8px 10px', fontSize: '12px', width: '100%' }}
              >
                📊 7 Days Transactions (~245 Rows)
              </button>
              <button
                onClick={() => handleDownload(30)}
                className="btn btn-secondary"
                style={{ justifyContent: 'flex-start', border: 'none', padding: '8px 10px', fontSize: '12px', width: '100%', color: 'var(--brand)', fontWeight: 700 }}
              >
                📊 30 Days Transactions (~750 Rows)
              </button>
              <button
                onClick={() => handleDownload(90)}
                className="btn btn-secondary"
                style={{ justifyContent: 'flex-start', border: 'none', padding: '8px 10px', fontSize: '12px', width: '100%' }}
              >
                📊 90 Days Transactions (~1,620 Rows)
              </button>
            </div>
          )}
        </div>

        {/* Ingest Webhook Event */}
        <button
          onClick={onIngestClick}
          className="btn btn-secondary"
          style={{ fontSize: '12px', padding: '6px 14px' }}
        >
          ⚡ Ingest Payment Event
        </button>

        {/* Ask Assistant Toggle Button */}
        <button
          onClick={handleToggleAssistant}
          className="btn"
          style={{
            fontSize: '12px',
            padding: '6px 14px',
            background: assistantOpen
              ? 'var(--brand)'
              : 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
            color: '#ffffff',
            fontWeight: 700,
            border: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            boxShadow: '0 2px 8px rgba(79, 70, 229, 0.35)',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
          aria-expanded={assistantOpen}
          aria-label="Toggle Ask Assistant"
        >
          <span>🤖</span>
          <span>Ask Assistant</span>
          <span style={{ fontSize: '10px' }}>{assistantOpen ? '▲' : '▼'}</span>
        </button>
      </div>
    </header>

    {/* Toggle-Down Ask Assistant Bar */}
    <TopBarAskAssistant
      isOpen={assistantOpen}
      onClose={() => handleToggleAssistant()}
      activeTabTitle={titles[activeTab]?.title}
    />
  </>
  );
}
