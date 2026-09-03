'use client';

import React, { useEffect, useRef } from 'react';
import styles from './features.module.css';

interface AgentMessage {
  id: string;
  actor: 'AI_BUYER' | 'MERCHANT_AGENT' | 'MONEY_FIREWALL' | 'RAZORPAY_GATEWAY' | 'SYSTEM';
  message: string;
  timestamp: string;
  meta?: Record<string, string>;
}

const actorConfig = {
  AI_BUYER: { name: 'AI Buyer', emoji: '🤖', className: styles.agentMsgBuyer },
  MERCHANT_AGENT: { name: 'Merchant Agent', emoji: '🏢', className: styles.agentMsgMerchant },
  MONEY_FIREWALL: { name: 'Money Firewall', emoji: '🛡️', className: styles.agentMsgFirewall },
  RAZORPAY_GATEWAY: { name: 'Razorpay', emoji: '💰', className: styles.agentMsgRazorpay },
  SYSTEM: { name: 'System', emoji: '📦', className: styles.agentMsgSystem },
};

export function AgentConversationFeed({ messages, isTyping }: { messages: AgentMessage[]; isTyping?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  return (
    <div
      className={styles.agentFeed}
      ref={containerRef}
      role="log"
      aria-label="Agent Negotiation Feed"
    >
      {messages.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)' }}>
          No messages yet.
        </div>
      ) : (
        messages.map((msg) => {
          const config = actorConfig[msg.actor] || actorConfig.SYSTEM;
          return (
            <div key={msg.id} className={`${styles.agentMsg} ${config.className}`}>
              <div className={styles.agentAvatar} aria-hidden="true">
                {config.emoji}
              </div>
              <div className={styles.agentMsgBody}>
                <div className={styles.agentMsgHeader}>
                  <span className={styles.agentMsgName}>{config.name}</span>
                  <span className={styles.agentMsgTime}>
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                </div>
                <div className={styles.agentMsgText}>{msg.message}</div>
                {msg.meta && Object.keys(msg.meta).length > 0 && (
                  <div className={styles.agentMsgMeta}>
                    {Object.entries(msg.meta).map(([key, value]) => (
                      <span key={key}>
                        <strong>{key}:</strong> {value}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })
      )}
      {isTyping && (
        <div className={`${styles.agentMsg} ${styles.agentMsgSystem}`}>
          <div className={styles.agentAvatar} aria-hidden="true">
            🤖
          </div>
          <div className={styles.agentMsgBody}>
            <div className={styles.typingDots} aria-label="Typing...">
              <span />
              <span />
              <span />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
