'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  context?: {
    totalRevenue: number;
    totalOrders: number;
    firewallBlocks: number;
    estimatedProfit: number;
  };
}

/* -------------------------------------------------------------------------- */
/* Suggested prompts                                                          */
/* -------------------------------------------------------------------------- */

const SUGGESTIONS = [
  'What is my loss today? Why?',
  'Show me today\'s revenue breakdown',
  'Which products are low on stock?',
  'How many transactions were blocked by the firewall?',
  'What is my best-selling product?',
  'Why is my margin dropping?',
];

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

export function AskAssistant() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isLoading) return;

    const userMsg: ChatMessage = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: text.trim(),
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    try {
      const res = await fetch('/api/assistant/commerce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text.trim() }),
      });

      const data = await res.json();

      const assistantMsg: ChatMessage = {
        id: `msg_${Date.now()}_ai`,
        role: 'assistant',
        content: data.answer || data.error || 'Sorry, I couldn\'t process that.',
        timestamp: new Date().toISOString(),
        context: data.context,
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch {
      setMessages((prev) => [...prev, {
        id: `msg_${Date.now()}_err`,
        role: 'assistant',
        content: 'Connection error. Please try again.',
        timestamp: new Date().toISOString(),
      }]);
    }

    setIsLoading(false);
  }, [isLoading]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  return (
    <>
      {/* Floating Toggle Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        aria-label={isOpen ? 'Close AI Assistant' : 'Open AI Assistant'}
        style={{
          position: 'fixed',
          bottom: '20px',
          right: '24px',
          zIndex: 600,
          width: '52px',
          height: '52px',
          borderRadius: '50%',
          border: 'none',
          background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
          color: '#ffffff',
          fontSize: '22px',
          cursor: 'pointer',
          boxShadow: '0 4px 20px rgba(79, 70, 229, 0.4)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'transform 0.2s ease, box-shadow 0.2s ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.1)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
      >
        {isOpen ? '✕' : '🤖'}
      </button>

      {/* Chat Panel */}
      {isOpen && (
        <div
          role="dialog"
          aria-label="Ask Assistant"
          style={{
            position: 'fixed',
            bottom: '82px',
            right: '24px',
            zIndex: 599,
            width: '400px',
            maxHeight: '560px',
            borderRadius: '14px',
            background: 'var(--bg-surface, #ffffff)',
            border: '1px solid var(--border-default, #e2e8f0)',
            boxShadow: '0 16px 48px rgba(0, 0, 0, 0.15)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            animation: 'chatSlideUp 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
          }}
        >
          {/* Header */}
          <div style={{
            padding: '14px 18px',
            background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
            color: '#ffffff',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <div>
              <div style={{ fontSize: '14px', fontWeight: 800 }}>🤖 Ask Assistant</div>
              <div style={{ fontSize: '11px', opacity: 0.8 }}>Powered by Gemini — Real-Time Commerce Intelligence</div>
            </div>
            <div style={{
              width: '8px', height: '8px', borderRadius: '50%', background: '#4ade80',
              boxShadow: '0 0 6px rgba(74, 222, 128, 0.6)',
            }} />
          </div>

          {/* Messages */}
          <div
            ref={scrollRef}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '14px',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              minHeight: '280px',
              maxHeight: '380px',
            }}
          >
            {messages.length === 0 && (
              <div style={{ textAlign: 'center', padding: '20px 10px' }}>
                <div style={{ fontSize: '28px', marginBottom: '8px' }}>💡</div>
                <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
                  Ask me anything about your commerce data
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '14px' }}>
                  I have access to your revenue, orders, firewall, inventory, and audit trail in real-time.
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {SUGGESTIONS.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => sendMessage(s)}
                      style={{
                        all: 'unset',
                        cursor: 'pointer',
                        fontSize: '11px',
                        padding: '8px 12px',
                        borderRadius: '8px',
                        background: 'var(--bg-surface-subtle, #f8fafc)',
                        border: '1px solid var(--border-subtle, #e2e8f0)',
                        color: 'var(--text-secondary)',
                        textAlign: 'left',
                        transition: 'all 0.15s ease',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--brand, #4f46e5)'; e.currentTarget.style.color = 'var(--brand, #4f46e5)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-subtle, #e2e8f0)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg) => (
              <div
                key={msg.id}
                style={{
                  display: 'flex',
                  justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                  animation: 'chatMsgIn 0.3s ease',
                }}
              >
                <div style={{
                  maxWidth: '85%',
                  padding: '10px 14px',
                  borderRadius: msg.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                  background: msg.role === 'user'
                    ? 'linear-gradient(135deg, #4f46e5, #7c3aed)'
                    : 'var(--bg-surface-subtle, #f8fafc)',
                  color: msg.role === 'user' ? '#ffffff' : 'var(--text-primary)',
                  fontSize: '12px',
                  lineHeight: '1.5',
                  border: msg.role === 'assistant' ? '1px solid var(--border-subtle, #e2e8f0)' : 'none',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}>
                  {msg.role === 'assistant' && (
                    <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--brand, #4f46e5)', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <span>🤖</span> CommerceOS Assistant
                    </div>
                  )}
                  {msg.content}
                  {msg.context && (
                    <div style={{
                      marginTop: '8px',
                      padding: '6px 8px',
                      borderRadius: '6px',
                      background: 'rgba(79, 70, 229, 0.06)',
                      border: '1px solid rgba(79, 70, 229, 0.1)',
                      fontSize: '10px',
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: '4px',
                      color: 'var(--text-muted)',
                    }}>
                      <span>Revenue: <strong>₹{msg.context.totalRevenue.toLocaleString('en-IN')}</strong></span>
                      <span>Orders: <strong>{msg.context.totalOrders}</strong></span>
                      <span>Profit: <strong style={{ color: msg.context.estimatedProfit >= 0 ? 'var(--success-text)' : 'var(--danger-text)' }}>₹{msg.context.estimatedProfit.toLocaleString('en-IN')}</strong></span>
                      <span>FW Blocks: <strong>{msg.context.firewallBlocks}</strong></span>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {isLoading && (
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <div style={{
                  padding: '12px 16px',
                  borderRadius: '14px 14px 14px 4px',
                  background: 'var(--bg-surface-subtle, #f8fafc)',
                  border: '1px solid var(--border-subtle, #e2e8f0)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                }}>
                  <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--brand)', marginRight: '4px' }}>🤖</span>
                  <span style={{ display: 'inline-flex', gap: '3px' }}>
                    {[0, 1, 2].map((i) => (
                      <span key={i} style={{
                        width: '6px', height: '6px', borderRadius: '50%',
                        background: 'var(--text-muted)',
                        animation: `dotPulse 1.4s infinite ${i * 0.2}s`,
                      }} />
                    ))}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <div style={{
            padding: '10px 14px',
            borderTop: '1px solid var(--border-default, #e2e8f0)',
            display: 'flex',
            gap: '8px',
            alignItems: 'center',
          }}>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about revenue, orders, losses..."
              aria-label="Type your question"
              style={{
                flex: 1,
                padding: '10px 14px',
                borderRadius: '10px',
                border: '1px solid var(--border-default, #e2e8f0)',
                background: 'var(--bg-surface-subtle, #f8fafc)',
                fontSize: '13px',
                color: 'var(--text-primary)',
                outline: 'none',
                transition: 'border-color 0.2s ease',
              }}
              onFocus={(e) => { e.target.style.borderColor = 'var(--brand, #4f46e5)'; }}
              onBlur={(e) => { e.target.style.borderColor = 'var(--border-default, #e2e8f0)'; }}
            />
            <button
              onClick={() => sendMessage(input)}
              disabled={isLoading || !input.trim()}
              aria-label="Send message"
              style={{
                width: '38px',
                height: '38px',
                borderRadius: '10px',
                border: 'none',
                background: isLoading || !input.trim() ? 'var(--border-default)' : 'linear-gradient(135deg, #4f46e5, #7c3aed)',
                color: '#ffffff',
                fontSize: '16px',
                cursor: isLoading || !input.trim() ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.2s ease',
                flexShrink: 0,
              }}
            >
              ↑
            </button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes chatSlideUp {
          0%   { opacity: 0; transform: translateY(16px) scale(0.96); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes chatMsgIn {
          0%   { opacity: 0; transform: translateY(6px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes dotPulse {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40% { transform: translateY(-5px); opacity: 1; }
        }
      `}</style>
    </>
  );
}
