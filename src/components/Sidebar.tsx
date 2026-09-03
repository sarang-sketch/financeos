'use client';

import React from 'react';

export type NavTab =
  | 'dashboard'
  | 'ai_buyer_demo'
  | 'agentic_commerce'
  | 'buyer_activity'
  | 'decision_lab'
  | 'weather_radar'
  | 'failed_payments'
  | 'audit_logs'
  | 'agent_manager'
  | 'settings';

interface SidebarProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  pendingProposalsCount?: number;
  onToggleAssistant?: () => void;
  isAssistantOpen?: boolean;
}

export function Sidebar({
  activeTab,
  onSelectTab,
  pendingProposalsCount = 3,
  onToggleAssistant,
  isAssistantOpen = false,
}: SidebarProps) {
  const navItems: { id: NavTab; label: string; icon: string; badge?: number | string }[] = [
    { id: 'dashboard', label: 'Executive Dashboard', icon: '📊' },
    { id: 'ai_buyer_demo', label: 'AI Buyer ↔ Merchant Lab', icon: '⚡', badge: 'Flagship Demo' },
    { id: 'agentic_commerce', label: 'AI Growth & Commerce', icon: '🤖', badge: 'A2A Active' },
    { id: 'buyer_activity', label: 'Abandoned Carts & Recovery', icon: '🛒', badge: '5 Carts' },
    { id: 'decision_lab', label: 'Recovery Decision Lab', icon: '🔬' },
    { id: 'weather_radar', label: 'Weather & Revenue Defense', icon: '📡', badge: '3 Alerts' },
    { id: 'failed_payments', label: 'Failed Payments & Queue', icon: '⚡', badge: '500' },
    { id: 'audit_logs', label: 'Audit Trail & Proofs', icon: '🛡️' },
    { id: 'agent_manager', label: 'Agent Manager Mode', icon: '🚀', badge: 'Future Scope' },
  ];

  return (
    <aside className="sidebar">
      {/* Brand Header */}
      <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--border-default)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '8px',
              background: 'linear-gradient(135deg, #4f46e5 0%, #2563eb 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              fontSize: '15px',
              color: '#ffffff',
              boxShadow: '0 2px 6px rgba(79, 70, 229, 0.25)',
            }}
          >
            F
          </div>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
              Finance<span style={{ color: 'var(--brand)' }}>OS</span>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500 }}>
              AI Growth & Agentic Commerce
            </div>
          </div>
        </div>
      </div>

      {/* Navigation Links */}
      <div style={{ padding: '16px 12px', flex: 1, overflowY: 'auto' }}>
        {/* Quick Launch Ask Assistant in Left Sidebar */}
        <div style={{ padding: '0 4px 12px 4px' }}>
          <button
            onClick={onToggleAssistant}
            style={{
              width: '100%',
              padding: '9px 12px',
              borderRadius: '8px',
              border: isAssistantOpen ? '1px solid var(--brand)' : '1px solid rgba(79, 70, 229, 0.3)',
              background: isAssistantOpen
                ? 'var(--brand-surface)'
                : 'linear-gradient(135deg, rgba(79, 70, 229, 0.1) 0%, rgba(37, 99, 235, 0.05) 100%)',
              color: isAssistantOpen ? 'var(--brand)' : 'var(--text-primary)',
              fontSize: '12px',
              fontWeight: 700,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              boxShadow: isAssistantOpen ? '0 0 0 2px rgba(79, 70, 229, 0.2)' : 'none',
              transition: 'all 0.15s ease',
            }}
            aria-label="Toggle Ask Assistant"
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '15px' }}>🤖</span>
              <span>Ask Assistant</span>
            </span>
            <span
              className="badge badge-brand"
              style={{ fontSize: '9px', padding: '2px 6px', fontWeight: 700 }}
            >
              Gemini AI
            </span>
          </button>
        </div>

        <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', padding: '0 10px 8px 10px' }}>
          Platform Navigation
        </div>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onSelectTab(item.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: 'none',
                  background: isActive ? 'var(--brand-surface)' : 'transparent',
                  color: isActive ? 'var(--brand-text)' : 'var(--text-secondary)',
                  fontWeight: isActive ? 700 : 500,
                  fontSize: '12px',
                  textAlign: 'left',
                  cursor: 'pointer',
                  borderLeft: isActive ? '3px solid var(--brand)' : '3px solid transparent',
                  transition: 'all 0.12s ease',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '13px' }}>{item.icon}</span>
                  <span>{item.label}</span>
                </span>
                {item.badge !== undefined && (
                  <span
                    className={`badge ${
                      item.id === 'weather_radar'
                        ? 'badge-warning'
                        : item.id === 'agent_manager'
                        ? 'badge-warning'
                        : typeof item.badge === 'number' && item.badge > 0
                        ? 'badge-brand'
                        : 'badge-neutral'
                    }`}
                    style={{ fontSize: '9px', padding: '1px 5px' }}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Footer / Tenant Profile & Status */}
      <div style={{ padding: '12px 14px', borderTop: '1px solid var(--border-default)', background: 'var(--bg-surface-subtle)' }}>
        <button
          onClick={() => onSelectTab('settings')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            width: '100%',
            padding: '6px 8px',
            marginBottom: '8px',
            borderRadius: '6px',
            border: activeTab === 'settings' ? '1px solid var(--brand)' : '1px solid transparent',
            background: activeTab === 'settings' ? 'var(--brand-surface)' : 'transparent',
            color: activeTab === 'settings' ? 'var(--brand-text)' : 'var(--text-secondary)',
            fontSize: '11px',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <span>⚙️</span>
          <span>Settings & Recovery Policy</span>
        </button>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Gateway Node</span>
          <span className="badge badge-success" style={{ fontSize: '10px' }}>
            Connected
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div
            style={{
              width: '28px',
              height: '28px',
              borderRadius: '50%',
              background: 'var(--brand-surface)',
              border: '1px solid var(--brand-border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '11px',
              fontWeight: 700,
              color: 'var(--brand-text)',
            }}
          >
            PT
          </div>
          <div style={{ overflow: 'hidden' }}>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
              PlayCraft Toys & Robotics Ltd
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Verified Toy Merchant Node</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
