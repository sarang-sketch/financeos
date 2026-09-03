'use client';

import React, { useState } from 'react';
import type {
  BuyerActivitySession,
  BuyerActivityStage,
} from '@/services/agentic-commerce-service';

interface BuyerActivityFeedProps {
  sessions: BuyerActivitySession[];
  onDispatchNudge: (sessionId: string, channel: 'WHATSAPP' | 'EMAIL' | 'CALL' | 'PUSH') => Promise<void>;
  onAutoNudgeAll: () => Promise<void>;
  isProcessing: boolean;
}

export function BuyerActivityFeed({
  sessions,
  onDispatchNudge,
  onAutoNudgeAll,
  isProcessing,
}: BuyerActivityFeedProps) {
  const [stageFilter, setStageFilter] = useState<'ALL' | BuyerActivityStage>('ALL');
  const [selectedQrSession, setSelectedQrSession] = useState<BuyerActivitySession | null>(null);
  const [copySuccess, setCopySuccess] = useState<boolean>(false);

  const filteredSessions = stageFilter === 'ALL'
    ? sessions
    : sessions.filter((s) => s.stage === stageFilter);

  const totalExposurePaise = sessions.reduce((acc, s) => acc + s.totalCartPaise, 0);
  const totalExposureInr = `₹${(totalExposurePaise / 100).toLocaleString('en-IN')}.00`;
  const highIntentCount = sessions.filter((s) => s.intentScorePercent >= 75).length;

  const handleCopyLink = (url: string) => {
    navigator.clipboard.writeText(url);
    setCopySuccess(true);
    setTimeout(() => setCopySuccess(false), 2000);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* 1. Header Banner & Auto-Nudge Trigger */}
      <div
        className="panel-raised"
        style={{
          padding: '20px 24px',
          background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
          color: '#ffffff',
          borderRadius: '10px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <span className="badge badge-brand">LIVE STORE SURVEILLANCE</span>
              <span className="badge badge-warning">{highIntentCount} High-Intent Carts</span>
              <span className="badge badge-success">Policy: 1 Nudge/24h Debounced</span>
            </div>
            <h3 style={{ fontSize: '18px', fontWeight: 850, color: '#f8fafc' }}>
              Active Buyer Sessions & Abandoned Cart Recovery
            </h3>
            <p style={{ fontSize: '12px', color: '#cbd5e1', maxWidth: '680px', marginTop: '4px' }}>
              Real-time store visitor intent tracking. Detects dropped checkouts, idle carts, and saved wishlists. Re-engage buyers instantly via WhatsApp UPI payment links, 1-click emails, and concierge calls.
            </p>
          </div>

          <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px' }}>
            <div>
              <div style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase' }}>TOTAL CART EXPOSURE</div>
              <div className="mono tabular-nums" style={{ fontSize: '22px', fontWeight: 800, color: '#fbbf24' }}>
                {totalExposureInr}
              </div>
            </div>
            <button
              disabled={isProcessing}
              onClick={onAutoNudgeAll}
              className="btn btn-primary"
              style={{ fontWeight: 700, fontSize: '12px', padding: '8px 16px' }}
            >
              {isProcessing ? 'Dispatching...' : '⚡ Auto-Nudge All High-Intent Carts'}
            </button>
          </div>
        </div>
      </div>

      {/* 2. Filter Bar */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginRight: '6px' }}>Filter by Stage:</span>
        {[
          { id: 'ALL', label: `All (${sessions.length})` },
          { id: 'DROPPED_AT_CHECKOUT', label: `Dropped at Checkout (${sessions.filter(s => s.stage === 'DROPPED_AT_CHECKOUT').length})` },
          { id: 'ABANDONED_CART', label: `Abandoned Cart (${sessions.filter(s => s.stage === 'ABANDONED_CART').length})` },
          { id: 'WISHLIST_ACTIVE', label: `Wishlist Saved (${sessions.filter(s => s.stage === 'WISHLIST_ACTIVE').length})` },
          { id: 'AI_AGENT_CART_HELD', label: `AI Agent Cart (${sessions.filter(s => s.stage === 'AI_AGENT_CART_HELD').length})` },
        ].map((f) => (
          <button
            key={f.id}
            onClick={() => setStageFilter(f.id as any)}
            className={`btn ${stageFilter === f.id ? 'btn-primary' : 'btn-secondary'}`}
            style={{ fontSize: '11px', padding: '4px 10px' }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* 3. Session Cards Feed */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {filteredSessions.map((session) => {
          const isDelivered = session.lastNudgeStatus === 'DELIVERED';
          return (
            <div
              key={session.id}
              className="panel-raised"
              style={{
                padding: '18px 20px',
                borderLeft: `4px solid ${
                  session.stage === 'DROPPED_AT_CHECKOUT'
                    ? 'var(--danger)'
                    : session.stage === 'ABANDONED_CART'
                    ? 'var(--warning)'
                    : session.stage === 'AI_AGENT_CART_HELD'
                    ? '#8b5cf6'
                    : 'var(--brand)'
                }`,
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}
            >
              {/* Header: Customer, Stage, Value */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '10px' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                    <span
                      className={`badge ${
                        session.stage === 'DROPPED_AT_CHECKOUT'
                          ? 'badge-danger'
                          : session.stage === 'ABANDONED_CART'
                          ? 'badge-warning'
                          : session.stage === 'AI_AGENT_CART_HELD'
                          ? 'badge-neutral'
                          : 'badge-info'
                      }`}
                      style={{ fontSize: '10px' }}
                    >
                      {session.stage.replace(/_/g, ' ')}
                    </span>
                    <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                      {session.timeAgo}
                    </span>
                    {isDelivered && (
                      <span className="badge badge-success" style={{ fontSize: '10px' }}>
                        ✓ Nudge Dispatched ({session.lastNudgeTime})
                      </span>
                    )}
                  </div>

                  <h4 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
                    {session.buyerName} {session.buyerCompany && <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-secondary)' }}>({session.buyerCompany})</span>}
                  </h4>

                  <div style={{ display: 'flex', gap: '14px', marginTop: '4px', fontSize: '12px', color: 'var(--text-muted)' }}>
                    <span>📱 <strong>{session.phone}</strong></span>
                    <span>✉️ <strong>{session.email}</strong></span>
                  </div>
                </div>

                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>CART TOTAL</div>
                  <div className="mono tabular-nums" style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>
                    {session.totalCartInr}
                  </div>
                  <div style={{ fontSize: '11px', color: session.intentScorePercent >= 85 ? 'var(--success-text)' : 'var(--warning-text)', fontWeight: 700 }}>
                    {session.intentScorePercent}% Purchase Intent
                  </div>
                </div>
              </div>

              {/* Items in Cart */}
              <div style={{ background: 'var(--bg-surface-subtle)', padding: '10px 14px', borderRadius: '6px', border: '1px solid var(--border-default)' }}>
                <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '4px', textTransform: 'uppercase' }}>
                  Items Remaining in Cart:
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {session.items.map((item, idx) => (
                    <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                      <span style={{ color: 'var(--text-primary)' }}>
                        <strong>{item.quantity}x</strong> {item.name}
                      </span>
                      <span className="mono font-semibold" style={{ color: 'var(--text-secondary)' }}>
                        {item.priceInr}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Last Action & AI Recommended Nudge */}
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                <div>
                  <strong style={{ color: 'var(--text-primary)' }}>Last Activity: </strong>{session.lastAction}
                </div>
                <div style={{ marginTop: '3px' }}>
                  <strong style={{ color: 'var(--brand-text)' }}>AI Recommended Action: </strong>{session.recommendedNudge}
                </div>
              </div>

              {/* Multi-Channel Action Bar */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '10px', borderTop: '1px solid var(--border-subtle)', flexWrap: 'wrap', gap: '8px' }}>
                <div className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {session.auditSha256 ? (
                    <span>Audit Hash: <strong>{session.auditSha256}</strong></span>
                  ) : (
                    <span>Preferred Rail: <strong>{session.preferredChannel}</strong></span>
                  )}
                </div>

                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <button
                    disabled={isProcessing}
                    onClick={() => setSelectedQrSession(session)}
                    className="btn btn-secondary"
                    style={{ fontSize: '11px', padding: '5px 10px', color: 'var(--brand)', borderColor: 'var(--brand-border)', fontWeight: 700 }}
                    title="Inspect Razorpay Smart Payment Link and Dynamic UPI QR Code"
                  >
                    📱 UPI QR & Link
                  </button>
                  <button
                    disabled={isProcessing}
                    onClick={() => {
                      onDispatchNudge(session.id, 'WHATSAPP');
                      const phone = session.phone.replace(/[\s+]/g, '');
                      const msg = encodeURIComponent(`Hi ${session.buyerName}! 🎁 Your cart at PlayCraft Toys is waiting — ${session.items.map(i => i.name).join(', ')} (${session.totalCartInr}). Complete your purchase here: https://playcraft.toys/checkout/${session.id}`);
                      window.open(`https://wa.me/${phone}?text=${msg}`, '_blank');
                    }}
                    className="btn btn-secondary"
                    style={{ fontSize: '11px', padding: '5px 10px', color: '#16a34a', borderColor: 'rgba(22, 163, 74, 0.4)' }}
                    title="Send interactive WhatsApp Razorpay payment link"
                  >
                    💬 WhatsApp Link
                  </button>
                  <button
                    disabled={isProcessing}
                    onClick={() => {
                      onDispatchNudge(session.id, 'EMAIL');
                      const subject = encodeURIComponent(`Your cart at PlayCraft Toys is waiting! 🎁`);
                      const body = encodeURIComponent(`Hi ${session.buyerName},\n\nYou left some great items in your cart:\n${session.items.map(i => `• ${i.quantity}x ${i.name} — ${i.priceInr}`).join('\n')}\n\nTotal: ${session.totalCartInr}\n\nComplete your purchase now and we'll add free gift wrapping!\n\nBest,\nPlayCraft Toys & Robotics`);
                      window.open(`mailto:${session.email}?subject=${subject}&body=${body}`, '_blank');
                    }}
                    className="btn btn-secondary"
                    style={{ fontSize: '11px', padding: '5px 10px' }}
                    title="Send 1-click cart recovery email"
                  >
                    ✉️ Send Email
                  </button>
                  <button
                    disabled={isProcessing}
                    onClick={() => {
                      onDispatchNudge(session.id, 'CALL');
                      const phone = session.phone.replace(/[\s+]/g, '');
                      window.open(`tel:${phone}`, '_self');
                    }}
                    className="btn btn-secondary"
                    style={{ fontSize: '11px', padding: '5px 10px' }}
                    title="Prompt account executive call"
                  >
                    📞 Concierge Call
                  </button>
                  <button
                    disabled={isProcessing}
                    onClick={() => onDispatchNudge(session.id, 'PUSH')}
                    className="btn btn-secondary"
                    style={{ fontSize: '11px', padding: '5px 10px' }}
                    title="Send push notification"
                  >
                    🔔 Push Note
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Razorpay Smart Link & Dynamic UPI QR Modal */}
      {selectedQrSession && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(15, 23, 42, 0.65)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 150,
            padding: '20px',
          }}
          onClick={() => setSelectedQrSession(null)}
        >
          <div
            className="panel"
            style={{
              width: '100%',
              maxWidth: '480px',
              padding: '24px',
              borderRadius: '12px',
              background: '#ffffff',
              boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="badge badge-brand">Razorpay Test-Mode</span>
                  <span className="badge badge-success">NPCI UAP QR</span>
                </div>
                <h3 style={{ fontSize: '16px', fontWeight: 800, marginTop: '4px', color: 'var(--text-primary)' }}>
                  Dynamic Payment Link & UPI QR
                </h3>
              </div>
              <button
                onClick={() => setSelectedQrSession(null)}
                className="btn btn-secondary"
                style={{ padding: '4px 10px', fontSize: '13px' }}
              >
                ✕
              </button>
            </div>

            {/* Target Customer & Cart Details */}
            <div style={{ padding: '12px', background: 'var(--bg-surface-subtle)', borderRadius: '8px', marginBottom: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Customer:</span>
                <span style={{ fontSize: '12px', fontWeight: 700 }}>{selectedQrSession.buyerName} ({selectedQrSession.phone})</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Cart Items:</span>
                <span style={{ fontSize: '12px', fontWeight: 600 }}>{selectedQrSession.items.map((it) => it.name).join(', ')}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: '6px', borderTop: '1px solid var(--border-default)' }}>
                <span style={{ fontSize: '13px', fontWeight: 800 }}>Total Payable:</span>
                <span style={{ fontSize: '14px', fontWeight: 900, color: 'var(--brand)' }}>
                  ₹{(selectedQrSession.totalCartPaise / 100).toLocaleString('en-IN')}.00
                </span>
              </div>
            </div>

            {/* Dynamic Visual UPI QR Code */}
            <div style={{ textAlign: 'center', padding: '16px', background: '#f8fafc', borderRadius: '8px', border: '1px solid var(--border-default)', marginBottom: '16px' }}>
              <svg width="150" height="150" viewBox="0 0 100 100" style={{ margin: '0 auto', display: 'block' }}>
                {/* QR Background & Corner Markers */}
                <rect width="100" height="100" fill="#ffffff" rx="6" />
                <rect x="10" y="10" width="24" height="24" fill="#0f172a" rx="2" />
                <rect x="14" y="14" width="16" height="16" fill="#ffffff" rx="1" />
                <rect x="18" y="18" width="8" height="8" fill="#4f46e5" rx="1" />

                <rect x="66" y="10" width="24" height="24" fill="#0f172a" rx="2" />
                <rect x="70" y="14" width="16" height="16" fill="#ffffff" rx="1" />
                <rect x="74" y="18" width="8" height="8" fill="#4f46e5" rx="1" />

                <rect x="10" y="66" width="24" height="24" fill="#0f172a" rx="2" />
                <rect x="14" y="70" width="16" height="16" fill="#ffffff" rx="1" />
                <rect x="18" y="74" width="8" height="8" fill="#4f46e5" rx="1" />

                {/* Simulated Data Matrix Dots */}
                <rect x="38" y="12" width="6" height="6" fill="#0f172a" />
                <rect x="48" y="12" width="6" height="6" fill="#0f172a" />
                <rect x="40" y="24" width="8" height="6" fill="#4f46e5" />
                <rect x="52" y="24" width="6" height="6" fill="#0f172a" />
                <rect x="12" y="42" width="6" height="8" fill="#0f172a" />
                <rect x="24" y="40" width="6" height="6" fill="#0f172a" />
                <rect x="36" y="38" width="28" height="28" fill="#eef2ff" rx="4" />
                <text x="50" y="55" textAnchor="middle" fontSize="13" fontWeight="900" fill="#4f46e5">₹</text>
                <rect x="70" y="42" width="8" height="8" fill="#0f172a" />
                <rect x="82" y="44" width="6" height="6" fill="#0f172a" />
                <rect x="40" y="72" width="6" height="6" fill="#0f172a" />
                <rect x="52" y="68" width="8" height="6" fill="#4f46e5" />
                <rect x="46" y="82" width="6" height="6" fill="#0f172a" />
                <rect x="68" y="72" width="18" height="6" fill="#0f172a" />
                <rect x="78" y="82" width="8" height="8" fill="#0f172a" />
              </svg>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }}>
                Scan with any UPI App (GPay / PhonePe / Paytm / CRED)
              </div>
            </div>

            {/* Smart Razorpay Link with Copy */}
            <div style={{ marginBottom: '16px' }}>
              <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
                RAZORPAY TEST-MODE PAYMENT LINK
              </label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  type="text"
                  readOnly
                  value={`https://rzp.io/i/cart_${selectedQrSession.id.slice(0, 8)}`}
                  className="input-control mono"
                  style={{ flex: 1, fontSize: '12px' }}
                />
                <button
                  onClick={() => handleCopyLink(`https://rzp.io/i/cart_${selectedQrSession.id.slice(0, 8)}`)}
                  className="btn btn-secondary"
                  style={{ fontSize: '12px', minWidth: '70px' }}
                >
                  {copySuccess ? '✓ Copied' : 'Copy'}
                </button>
              </div>
            </div>

            {/* Actions: Instant Test Simulation */}
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                disabled={isProcessing}
                onClick={async () => {
                  const sId = selectedQrSession.id;
                  await onDispatchNudge(sId, 'WHATSAPP');
                  setSelectedQrSession(null);
                }}
                className="btn btn-primary"
                style={{ flex: 1, justifyContent: 'center', padding: '9px 14px', fontSize: '12px', fontWeight: 700 }}
              >
                ⚡ Simulate Customer UPI Scan & Settlement
              </button>
              <button
                onClick={() => setSelectedQrSession(null)}
                className="btn btn-secondary"
                style={{ padding: '9px 14px', fontSize: '12px' }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
