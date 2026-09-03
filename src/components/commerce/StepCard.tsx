'use client';
import React from 'react';
import styles from '../views/AiBuyerMerchantLabView.module.css';

interface StepCardProps {
  title: string;
  active: boolean;
  highlight?: boolean;
  badge?: string;
  loading?: boolean;
  children: React.ReactNode;
}

/**
 * A reusable step card with skeleton loading for the AI Buyer / Merchant Lab view.
 */
export function StepCard({ title, active, highlight, badge, loading, children }: StepCardProps) {
  let cardClass = styles.stepCard;
  if (highlight) {
    cardClass = `${styles.stepCard} ${styles.stepCardHighlight}`;
  } else if (active) {
    cardClass = `${styles.stepCard} ${styles.stepCardActive}`;
  }

  return (
    <div className={cardClass} aria-label={title}>
      <div className={styles.stepCardHeader}>
        <span className={active ? styles.stepTitleActive : styles.stepTitle}>
          {title} {badge && `— ${badge}`}
        </span>
      </div>
      <div className={styles.stepBody}>
        {loading ? (
          <div>
            <div className={`${styles.skeleton} ${styles.skeletonShort}`} />
            <div className={`${styles.skeleton} ${styles.skeletonMedium}`} />
            <div className={`${styles.skeleton} ${styles.skeletonFull}`} />
          </div>
        ) : !active ? (
          <div className={styles.stepWaiting}>Waiting...</div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
