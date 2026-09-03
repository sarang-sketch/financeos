'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  windowSummary?: {
    revenueAtRisk?: string;
    netRecovered?: string;
    recoveryRate?: string;
    systemicWeather?: string;
  };
}

interface TopBarAskAssistantProps {
  isOpen: boolean;
  onClose: () => void;
  activeTabTitle?: string;
}

const QUICK_PROMPTS = [
  'What is my loss of today? Why is there a loss?',
  'Why is Revenue at Risk ₹14.65 Lakh?',
  'Explain the HDFC latency spike (+340%) and how to fix it',
  'Which payment channels have the highest drop-offs today?',
  'How much revenue did AI recover today?',
];

export function TopBarAskAssistant({ isOpen, onClose, activeTabTitle = 'Executive Dashboard' }: TopBarAskAssistantProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome_1',
      role: 'assistant',
      content:
        `👋 Hello! I am your real-time **Ask Assistant**. I am currently reading your **${activeTabTitle}** and all live payment nodes across your store.\n\nYou can ask me questions like:\n* *"What is my loss of today? Why is there a loss?"*\n* *"Why is Revenue at Risk ₹14.65 Lakh?"*`,
      timestamp: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
    },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  const handleSend = useCallback(async (questionText: string) => {
    if (!questionText.trim() || isLoading) return;

    const userText = questionText.trim();
    const userMsg: ChatMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      content: userText,
      timestamp: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    try {
      const res = await fetch('/api/assistant/commerce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: userText,
          clientContext: {
            currentTab: activeTabTitle,
            revenueAtRisk: '₹14.65 Lakh',
            ingestedVolume: '₹86.4 Lakh',
            netRecovered: '₹33.5 Lakh',
            recoveryRate: '78.4%',
            systemicWeather: 'HDFC Latency Spike (+340%)',
          },
        }),
      });

      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }

      const data = await res.json();
      const assistantMsg: ChatMessage = {
        id: `ai_${Date.now()}`,
        role: 'assistant',
        content: data.answer || 'I could not analyze this request.',
        timestamp: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        windowSummary: data.windowSummary,
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Network error';
      setMessages((prev) => [
        ...prev,
        {
          id: `err_${Date.now()}`,
          role: 'assistant',
          content: `⚠️ Error: ${errorMsg}. Go to ⚙️ Settings → API Keys & Credentials to enter your GEMINI_API_KEY, then restart the dev server.`,
          timestamp: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, activeTabTitle]);

  if (!isOpen) return null;

  return (
    <div
      style={{
        borderBottom: '2px solid var(--brand)',
        background: 'linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)',
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.08)',
        zIndex: 90,
        position: 'relative',
        animation: 'askSlideDown 0.28s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      {/* Top Banner Bar */}
      <div
        style={{
          padding: '12px 24px',
          borderBottom: '1px solid var(--border-default)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'linear-gradient(90deg, rgba(79, 70, 229, 0.08) 0%, rgba(37, 99, 235, 0.03) 100%)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '18px' }}>🤖</span>
            <span style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
              Ask Assistant
            </span>
            <span className="badge badge-brand" style={{ fontSize: '10px' }}>Gemini 3.6 Flash Active</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span
              style={{
                fontSize: '11px',
                padding: '3px 8px',
                borderRadius: '4px',
                background: '#ffffff',
                border: '1px solid var(--border-default)',
                color: 'var(--text-secondary)',
              }}
            >
              👁️ Reading: <strong>{activeTabTitle}</strong>
            </span>
            <span
              style={{
                fontSize: '11px',
                padding: '3px 8px',
                borderRadius: '4px',
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.25)',
                color: 'var(--danger-text, #ef4444)',
                fontWeight: 700,
              }}
            >
              Loss at Risk: ₹14.65 Lakh
            </span>
            <span
              style={{
                fontSize: '11px',
                padding: '3px 8px',
                borderRadius: '4px',
                background: 'rgba(34, 197, 94, 0.1)',
                border: '1px solid rgba(34, 197, 94, 0.25)',
                color: '#16a34a',
                fontWeight: 700,
              }}
            >
              Recovered: ₹33.5 Lakh (78.4%)
            </span>
          </div>
        </div>

        <button
          onClick={onClose}
          className="btn btn-secondary"
          style={{ fontSize: '11px', padding: '4px 10px', gap: '4px' }}
          aria-label="Close Assistant"
        >
          <span>✕</span>
          <span>Close</span>
        </button>
      </div>

      {/* Main Conversation & Quick Actions Panel */}
      <div style={{ display: 'flex', flexDirection: 'column', maxHeight: '360px' }}>
        {/* Quick Suggestion Chips */}
        <div
          style={{
            padding: '10px 24px',
            background: 'var(--bg-surface-subtle)',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            gap: '8px',
            overflowX: 'auto',
            alignItems: 'center',
          }}
        >
          <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            ⚡ Suggested Questions:
          </span>
          {QUICK_PROMPTS.map((promptText, i) => (
            <button
              key={i}
              onClick={() => handleSend(promptText)}
              disabled={isLoading}
              style={{
                fontSize: '11px',
                fontWeight: 600,
                padding: '5px 12px',
                borderRadius: '16px',
                background: '#ffffff',
                border: '1px solid var(--border-default)',
                color: 'var(--text-primary)',
                whiteSpace: 'nowrap',
                cursor: isLoading ? 'not-allowed' : 'pointer',
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--brand)';
                e.currentTarget.style.color = 'var(--brand)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-default)';
                e.currentTarget.style.color = 'var(--text-primary)';
              }}
            >
              {promptText}
            </button>
          ))}
        </div>

        {/* Message Thread Scroll Area */}
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            minHeight: '160px',
            maxHeight: '230px',
          }}
        >
          {messages.map((msg) => (
            <div
              key={msg.id}
              style={{
                display: 'flex',
                justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                animation: 'askMsgIn 0.2s ease',
              }}
            >
              <div
                style={{
                  maxWidth: msg.role === 'user' ? '70%' : '85%',
                  padding: '10px 16px',
                  borderRadius: msg.role === 'user' ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
                  background:
                    msg.role === 'user'
                      ? 'linear-gradient(135deg, #4f46e5 0%, #3b82f6 100%)'
                      : '#ffffff',
                  color: msg.role === 'user' ? '#ffffff' : 'var(--text-primary)',
                  border: msg.role === 'assistant' ? '1px solid var(--border-default)' : 'none',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
                  fontSize: '13px',
                  lineHeight: '1.55',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {msg.role === 'assistant' && (
                  <div
                    style={{
                      fontSize: '10px',
                      fontWeight: 800,
                      color: 'var(--brand)',
                      marginBottom: '4px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                    }}
                  >
                    <span>🤖</span> Ask Assistant
                    <span style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 500, marginLeft: 'auto' }}>
                      {msg.timestamp}
                    </span>
                  </div>
                )}
                {msg.content}
              </div>
            </div>
          ))}

          {isLoading && (
            <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
              <div
                style={{
                  padding: '8px 14px',
                  borderRadius: '12px 12px 12px 2px',
                  background: '#ffffff',
                  border: '1px solid var(--border-default)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  fontSize: '12px',
                  color: 'var(--text-muted)',
                }}
              >
                <span>🤖 Navigating window data...</span>
                <span style={{ display: 'inline-flex', gap: '3px' }}>
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      style={{
                        width: '5px',
                        height: '5px',
                        borderRadius: '50%',
                        background: 'var(--brand)',
                        animation: `askPulse 1.2s infinite ${i * 0.2}s`,
                      }}
                    />
                  ))}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Input Bar */}
        <div
          style={{
            padding: '12px 24px',
            borderTop: '1px solid var(--border-default)',
            background: '#ffffff',
            display: 'flex',
            gap: '10px',
            alignItems: 'center',
          }}
        >
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend(input);
              }
            }}
            placeholder="Ask Assistant: e.g. 'What is my loss of today? Why is there a loss?'"
            aria-label="Ask Assistant Input"
            style={{
              flex: 1,
              padding: '10px 16px',
              borderRadius: '8px',
              border: '1px solid var(--border-default)',
              fontSize: '13px',
              color: 'var(--text-primary)',
              outline: 'none',
              background: 'var(--bg-surface-subtle)',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'var(--brand)';
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-default)';
            }}
          />
          <button
            onClick={() => handleSend(input)}
            disabled={isLoading || !input.trim()}
            className="btn btn-primary"
            style={{
              padding: '10px 20px',
              fontWeight: 700,
              fontSize: '13px',
              opacity: isLoading || !input.trim() ? 0.6 : 1,
              cursor: isLoading || !input.trim() ? 'not-allowed' : 'pointer',
            }}
          >
            {isLoading ? 'Thinking...' : 'Ask AI →'}
          </button>
        </div>
      </div>

      <style>{`
        @keyframes askSlideDown {
          0% { opacity: 0; transform: translateY(-12px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes askMsgIn {
          0% { opacity: 0; transform: translateY(4px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        @keyframes askPulse {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1.2); }
        }
      `}</style>
    </div>
  );
}
