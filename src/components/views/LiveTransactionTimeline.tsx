'use client';

import React, { useState, useEffect, useCallback } from 'react';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

interface AuditEvent {
  id: string;
  time: string;
  actor: string;
  action: string;
  result: string;
  hash: string;
  reason: string;
}

interface LiveTransactionTimelineProps {
  orderId?: string | null;
  autoRefresh?: boolean;
  refreshIntervalMs?: number;
}

/* -------------------------------------------------------------------------- */
/* Style constants                                                            */
/* -------------------------------------------------------------------------- */

const ACTOR_COLORS: Record<string, string> = {
  AI_BUYER: '#4f46e5',
  MERCHANT_AGENT: '#10b981',
  MONEY_FIREWALL: '#ef4444',
  RAZORPAY_GATEWAY: '#3b82f6',
  REVENUE_AGENT: '#f59e0b',
  SYSTEM: '#6b7280',
};

const RESULT_BADGE: Record<string, { bg: string; text: string }> = {
  APPROVED: { bg: '#dcfce7', text: '#166534' },
  BLOCKED: { bg: '#fee2e2', text: '#991b1b' },
  COUNTERED: { bg: '#fef3c7', text: '#92400e' },
  VERIFIED: { bg: '#dbeafe', text: '#1e40af' },
  FAILED: { bg: '#fee2e2', text: '#991b1b' },
};

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

export function LiveTransactionTimeline({
  orderId = null,
  autoRefresh = true,
  refreshIntervalMs = 2000,
}: LiveTransactionTimelineProps) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [prevCount, setPrevCount] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchEvents = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '30' });
      if (orderId) params.set('orderId', orderId);
      const res = await fetch(`/api/audit-logs?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        const logs = data.logs || [];
        setPrevCount(events.length);
        setEvents(logs);
      }
    } catch {
      // Silent fail for polling
    } finally {
      setLoading(false);
    }
  }, [orderId, events.length]);

  useEffect(() => {
    setLoading(true);
    fetchEvents();
    if (autoRefresh) {
      const interval = setInterval(fetchEvents, refreshIntervalMs);
      return () => clearInterval(interval);
    }
  }, [orderId, autoRefresh, refreshIntervalMs]); // eslint-disable-line react-hooks/exhaustive-deps

  const copyHash = (hash: string, id: string) => {
    navigator.clipboard.writeText(hash).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    });
  };

  if (loading && events.length === 0) {
    return (
      <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
        <div style={{
          width: '20px', height: '20px', margin: '0 auto 10px',
          border: '2px solid var(--border-default)', borderTop: '2px solid var(--brand)',
          borderRadius: '50%', animation: 'spin 0.8s linear infinite',
        }} />
        Loading audit trail...
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div role="log" aria-label="Audit Trail" style={{
        padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px',
        background: 'var(--bg-surface-subtle)', borderRadius: '8px',
      }}>
        <div style={{ fontSize: '24px', marginBottom: '6px' }}>📜</div>
        No audit events yet. Run a transaction to generate the trust ledger.
      </div>
    );
  }

  return (
    <div role="log" aria-label="Live Audit Trail" style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
      {events.map((event, idx) => {
        const actorColor = ACTOR_COLORS[event.actor] || '#6b7280';
        const badge = RESULT_BADGE[event.result] || { bg: '#f3f4f6', text: '#374151' };
        const isNew = idx < events.length - prevCount;
        const isLatest = idx === 0;

        return (
          <div
            key={event.id}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '10px',
              padding: '10px 12px',
              borderRadius: '6px',
              background: isLatest ? 'var(--bg-surface-subtle)' : 'transparent',
              borderLeft: `3px solid ${actorColor}`,
              fontSize: '12px',
              transition: 'background 0.2s ease',
              animation: isNew ? 'slideInLeft 0.4s cubic-bezier(0.16, 1, 0.3, 1)' : 'none',
            }}
          >
            {/* Timeline dot */}
            <div
              style={{
                width: '9px',
                height: '9px',
                borderRadius: '50%',
                background: actorColor,
                marginTop: '4px',
                flexShrink: 0,
                boxShadow: isLatest ? `0 0 8px ${actorColor}` : 'none',
                transition: 'box-shadow 0.3s ease',
              }}
              aria-hidden="true"
            />

            {/* Content */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <span
                    style={{
                      fontWeight: 800,
                      color: actorColor,
                      fontSize: '10px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                    }}
                  >
                    {event.actor.replace(/_/g, ' ')}
                  </span>
                  <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                    {event.action.replace(/_/g, ' ')}
                  </span>
                </div>
                <span
                  style={{
                    fontSize: '10px',
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: '4px',
                    background: badge.bg,
                    color: badge.text,
                    flexShrink: 0,
                    letterSpacing: '0.3px',
                  }}
                >
                  {event.result}
                </span>
              </div>

              {event.reason && (
                <div
                  style={{
                    color: 'var(--text-secondary)',
                    marginTop: '3px',
                    lineHeight: '1.4',
                    fontSize: '12px',
                  }}
                >
                  {event.reason}
                </div>
              )}

              <div style={{ display: 'flex', gap: '14px', marginTop: '4px', alignItems: 'center' }}>
                <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                  {new Date(event.time).toLocaleTimeString('en-IN', { hour12: false })}
                </span>
                <button
                  onClick={() => copyHash(event.hash, event.id)}
                  style={{
                    all: 'unset',
                    cursor: 'pointer',
                    fontFamily: 'monospace',
                    fontSize: '11px',
                    color: copiedId === event.id ? 'var(--success-text)' : 'var(--text-muted)',
                    padding: '1px 6px',
                    borderRadius: '3px',
                    background: copiedId === event.id ? 'var(--success-surface)' : 'transparent',
                    transition: 'all 0.2s ease',
                  }}
                  title="Click to copy full digest"
                  aria-label={`Copy SHA-256 digest for ${event.action}`}
                >
                  {copiedId === event.id ? '✓ copied' : `🔗 ${event.hash}`}
                </button>
              </div>
            </div>
          </div>
        );
      })}
      <style>{`
        @keyframes slideInLeft {
          0%   { opacity: 0; transform: translateX(-20px); }
          100% { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}
