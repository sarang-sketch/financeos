'use client';

import React, { useState, useEffect, useCallback } from 'react';

interface SettingsViewProps {
  autoCeiling: string;
  onAutoCeilingChange: (v: string) => void;
  strategy: string;
  onStrategyChange: (v: string) => void;
  confidenceThreshold: number;
  onConfidenceThresholdChange: (v: number) => void;
  requireDualAuth: boolean;
  onRequireDualAuthChange: (v: boolean) => void;
  onSave: () => void;
}

interface MaskedKeys {
  GEMINI_API_KEY: string;
  RAZORPAY_KEY_ID: string;
  RAZORPAY_KEY_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export function SettingsView({
  autoCeiling,
  onAutoCeilingChange,
  strategy,
  onStrategyChange,
  confidenceThreshold,
  onConfidenceThresholdChange,
  requireDualAuth,
  onRequireDualAuthChange,
  onSave,
}: SettingsViewProps) {
  // API Keys State
  const [geminiKey, setGeminiKey] = useState('');
  const [razorpayKeyId, setRazorpayKeyId] = useState('');
  const [razorpayKeySecret, setRazorpayKeySecret] = useState('');
  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [supabaseAnonKey, setSupabaseAnonKey] = useState('');
  const [supabaseServiceKey, setSupabaseServiceKey] = useState('');
  const [maskedKeys, setMaskedKeys] = useState<MaskedKeys | null>(null);
  const [keySaveStatus, setKeySaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [keySaveMsg, setKeySaveMsg] = useState('');

  // Load masked keys on mount
  const loadMaskedKeys = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/keys');
      if (res.ok) {
        const data = await res.json();
        setMaskedKeys(data);
      }
    } catch {
      // Silent fail — keys endpoint may not exist
    }
  }, []);

  useEffect(() => {
    loadMaskedKeys();
  }, [loadMaskedKeys]);

  const handleSaveKeys = async () => {
    setKeySaveStatus('saving');
    try {
      const res = await fetch('/api/settings/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          GEMINI_API_KEY: geminiKey || undefined,
          RAZORPAY_KEY_ID: razorpayKeyId || undefined,
          RAZORPAY_KEY_SECRET: razorpayKeySecret || undefined,
          SUPABASE_URL: supabaseUrl || undefined,
          SUPABASE_ANON_KEY: supabaseAnonKey || undefined,
          SUPABASE_SERVICE_ROLE_KEY: supabaseServiceKey || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setKeySaveStatus('saved');
        setKeySaveMsg(data.message || 'Keys saved successfully!');
        loadMaskedKeys();
        // Clear input fields after save
        setGeminiKey('');
        setRazorpayKeyId('');
        setRazorpayKeySecret('');
        setSupabaseUrl('');
        setSupabaseAnonKey('');
        setSupabaseServiceKey('');
      } else {
        setKeySaveStatus('error');
        setKeySaveMsg(data.error || 'Failed to save keys.');
      }
    } catch (err: unknown) {
      setKeySaveStatus('error');
      setKeySaveMsg(err instanceof Error ? err.message : 'Network error');
    }
    setTimeout(() => setKeySaveStatus('idle'), 5000);
  };

  const keyField = (
    label: string,
    placeholder: string,
    value: string,
    onChange: (v: string) => void,
    maskedValue?: string,
    hint?: string
  ) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{label}</label>
        {maskedValue && (
          <span className="mono" style={{ fontSize: '10px', color: maskedValue.includes('not set') ? '#ef4444' : '#16a34a', fontWeight: 600 }}>
            {maskedValue.includes('not set') ? '❌ ' : '✅ '}{maskedValue}
          </span>
        )}
      </div>
      {hint && <p style={{ fontSize: '10px', color: 'var(--text-muted)', margin: 0 }}>{hint}</p>}
      <input
        type="password"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="input-control"
        style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: '12px' }}
      />
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* ========= SECTION 1: API Keys & Credentials (NEW) ========= */}
      <div className="panel" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
          <h2 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
            🔑 API Keys & Credentials
          </h2>
          <span className="badge badge-brand" style={{ fontSize: '10px' }}>Required for Judges</span>
        </div>
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '16px' }}>
          Enter your own API keys below to run FinanceOS on your machine. Keys are saved to <code>.env.local</code> — restart the dev server after saving.
          All keys stay local on your machine and are never transmitted externally.
        </p>

        {/* Status Banner */}
        {keySaveStatus === 'saved' && (
          <div style={{ padding: '10px 16px', borderRadius: '6px', background: 'rgba(34, 197, 94, 0.1)', border: '1px solid rgba(34, 197, 94, 0.3)', marginBottom: '16px', fontSize: '12px', color: '#16a34a', fontWeight: 700 }}>
            ✅ {keySaveMsg}
          </div>
        )}
        {keySaveStatus === 'error' && (
          <div style={{ padding: '10px 16px', borderRadius: '6px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', marginBottom: '16px', fontSize: '12px', color: '#ef4444', fontWeight: 700 }}>
            ❌ {keySaveMsg}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))', gap: '16px' }}>
          {/* Gemini Key */}
          <div style={{ padding: '16px', background: 'var(--bg-surface-subtle)', borderRadius: '8px', border: '1px solid var(--border-default)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
              <span style={{ fontSize: '18px' }}>🤖</span>
              <span style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>Google Gemini API</span>
              <span className="badge badge-danger" style={{ fontSize: '9px' }}>Required</span>
            </div>
            {keyField(
              'GEMINI_API_KEY',
              'AQ.xxxxxx...',
              geminiKey,
              setGeminiKey,
              maskedKeys?.GEMINI_API_KEY,
              'Powers Ask Assistant, AI Buyer intent extraction, and content generation. Get yours at aistudio.google.com'
            )}
          </div>

          {/* Razorpay Keys */}
          <div style={{ padding: '16px', background: 'var(--bg-surface-subtle)', borderRadius: '8px', border: '1px solid var(--border-default)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
              <span style={{ fontSize: '18px' }}>💰</span>
              <span style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>Razorpay (Test Mode)</span>
              <span className="badge badge-warning" style={{ fontSize: '9px' }}>For Payments</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {keyField(
                'RAZORPAY_KEY_ID',
                'rzp_test_xxxx...',
                razorpayKeyId,
                setRazorpayKeyId,
                maskedKeys?.RAZORPAY_KEY_ID,
                'Test-mode Key ID from Razorpay Dashboard → Settings → API Keys'
              )}
              {keyField(
                'RAZORPAY_KEY_SECRET',
                'Your Razorpay secret...',
                razorpayKeySecret,
                setRazorpayKeySecret,
                maskedKeys?.RAZORPAY_KEY_SECRET,
                'Test-mode Secret Key'
              )}
            </div>
          </div>

          {/* Supabase Keys */}
          <div style={{ padding: '16px', background: 'var(--bg-surface-subtle)', borderRadius: '8px', border: '1px solid var(--border-default)', gridColumn: '1 / -1' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
              <span style={{ fontSize: '18px' }}>🗄️</span>
              <span style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>Supabase (Open-Source PostgreSQL Backend)</span>
              <span className="badge badge-neutral" style={{ fontSize: '9px' }}>Optional — Falls back to in-memory seed data</span>
            </div>
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px' }}>
              Supabase is our open-source PostgreSQL backend. The app works fully without it using in-memory seed data.
              To use a live database, create a free project at <strong>supabase.com</strong> and paste the credentials below.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '10px' }}>
              {keyField('SUPABASE_URL', 'https://xxxxx.supabase.co', supabaseUrl, setSupabaseUrl, maskedKeys?.SUPABASE_URL)}
              {keyField('SUPABASE_ANON_KEY', 'eyJhbGci...', supabaseAnonKey, setSupabaseAnonKey, maskedKeys?.SUPABASE_ANON_KEY)}
              {keyField('SUPABASE_SERVICE_ROLE_KEY', 'eyJhbGci...', supabaseServiceKey, setSupabaseServiceKey, maskedKeys?.SUPABASE_SERVICE_ROLE_KEY)}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginTop: '16px' }}>
          <button
            onClick={handleSaveKeys}
            disabled={keySaveStatus === 'saving'}
            className="btn btn-primary"
            style={{ fontWeight: 800 }}
          >
            {keySaveStatus === 'saving' ? '⏳ Saving...' : '💾 Save API Keys to .env.local'}
          </button>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            ⚠️ Restart the dev server after saving for changes to take effect.
          </span>
        </div>
      </div>

      {/* ========= SECTION 2: Recovery Policy ========= */}
      <div className="panel" style={{ padding: '24px' }}>
        <div style={{ marginBottom: '20px' }}>
          <h2 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>
            ⚙️ Recovery Policy & Firewall Settings
          </h2>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Configure autonomous execution ceilings, recovery strategies, and notification preferences
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '640px' }}>
          <div style={{ padding: '16px', background: 'var(--bg-surface-subtle)', borderRadius: '6px', border: '1px solid var(--border-default)' }}>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
              Auto-Execution Ceiling (INR)
            </label>
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px' }}>
              Recovery actions exceeding this amount require dual human authorization.
            </p>
            <input
              type="text"
              value={autoCeiling}
              onChange={(e) => onAutoCeilingChange(e.target.value)}
              className="input-control"
              style={{ width: '100%' }}
            />
          </div>

          <div style={{ padding: '16px', background: 'var(--bg-surface-subtle)', borderRadius: '6px', border: '1px solid var(--border-default)' }}>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
              Recovery Strategy
            </label>
            <select
              value={strategy}
              onChange={(e) => onStrategyChange(e.target.value)}
              className="input-control"
              style={{ width: '100%' }}
            >
              <option value="BALANCED_AGGRESSIVE">Balanced Aggressive (Recommended - Dynamic Retry + Payment Link)</option>
              <option value="CONSERVATIVE">Conservative (Direct Gateway Retries Only)</option>
              <option value="MAX_RECOVERY">Maximum Recovery (Multi-Channel Cascade)</option>
            </select>
          </div>

          <div style={{ padding: '16px', background: 'var(--bg-surface-subtle)', borderRadius: '6px', border: '1px solid var(--border-default)' }}>
            <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
              AI Confidence Threshold ({confidenceThreshold}%)
            </label>
            <input
              type="range"
              min={50}
              max={95}
              value={confidenceThreshold}
              onChange={(e) => onConfidenceThresholdChange(Number(e.target.value))}
              style={{ width: '100%', marginTop: '6px' }}
            />
          </div>

          <div style={{ padding: '16px', background: 'var(--bg-surface-subtle)', borderRadius: '6px', border: '1px solid var(--border-default)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <strong style={{ fontSize: '12px', color: 'var(--text-primary)' }}>Require Dual Authorization for Large Amounts</strong>
                <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Enforce four-eyes principle on recovery adjustments above threshold</p>
              </div>
              <input
                type="checkbox"
                checked={requireDualAuth}
                onChange={(e) => onRequireDualAuthChange(e.target.checked)}
                style={{ width: '16px', height: '16px' }}
              />
            </div>
          </div>

          <button
            onClick={onSave}
            className="btn btn-primary"
            style={{ alignSelf: 'flex-start' }}
          >
            Save Policy Configuration
          </button>
        </div>
      </div>
    </div>
  );
}
