'use client';
import React from 'react';
import styles from '../views/AiBuyerMerchantLabView.module.css';

interface TimeoutRecoveryBannerProps {
  state: 'IDLE' | 'TIMEOUT' | 'RECOVERED';
  onRecover: () => void;
}

/**
 * Small component for timeout state recovery.
 */
export function TimeoutRecoveryBanner({ state, onRecover }: TimeoutRecoveryBannerProps) {
  if (state === 'IDLE') return null;

  const isActive = state === 'TIMEOUT';
  const bannerClass = `${styles.timeoutBanner} ${isActive ? styles.timeoutActive : styles.timeoutRecovered}`;

  return (
    <div className={bannerClass} role="alert" aria-live="assertive">
      <div className={styles.timeoutHeader}>
        <span className={styles.timeoutTitle}>
          {isActive ? 'Timeout Detected' : 'State Recovered'}
        </span>
        {isActive && (
          <button onClick={onRecover}>Recover State</button>
        )}
      </div>
      <div className={styles.timeoutBody}>
        {isActive 
          ? 'Network or processing timeout occurred. Do you want to fallback to defaults or retry?' 
          : 'Gracefully recovered from the timeout state using robust commerce defaults.'}
      </div>
    </div>
  );
}
