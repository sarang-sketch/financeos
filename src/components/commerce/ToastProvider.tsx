'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import styles from '../views/AiBuyerMerchantLabView.module.css';

/* -------------------------------------------------------------------------- */
/* Toast types                                                                */
/* -------------------------------------------------------------------------- */

export type ToastType = 'success' | 'danger' | 'warning' | 'info';

interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
  exiting: boolean;
}

/* -------------------------------------------------------------------------- */
/* Context                                                                    */
/* -------------------------------------------------------------------------- */

const ToastContext = React.createContext<(msg: string, type?: ToastType) => void>(() => {});

export function useToast() {
  return React.useContext(ToastContext);
}

/* -------------------------------------------------------------------------- */
/* Provider                                                                   */
/* -------------------------------------------------------------------------- */

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 260);
  }, []);

  const show = useCallback((message: string, type: ToastType = 'success') => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    setToasts((prev) => {
      // Keep max 4 toasts, evict oldest
      const next = [...prev, { id, message, type, exiting: false }];
      if (next.length > 4) {
        const oldest = next[0]!;
        dismiss(oldest.id);
      }
      return next;
    });

    const timer = setTimeout(() => dismiss(id), 4000);
    timersRef.current.set(id, timer);

    return id;
  }, [dismiss]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => clearTimeout(timer));
    };
  }, []);

  const dotClass = (type: ToastType) => {
    if (type === 'danger') return `${styles.toastDot} ${styles.toastDotDanger}`;
    if (type === 'warning') return `${styles.toastDot} ${styles.toastDotWarning}`;
    return styles.toastDot;
  };

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className={styles.toastContainer} role="status" aria-live="polite" aria-label="Notifications">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`${styles.toast} ${t.exiting ? styles.toastExiting : ''}`}
            role="alert"
            onClick={() => dismiss(t.id)}
          >
            <span className={dotClass(t.type)} />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
