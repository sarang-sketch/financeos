'use client';
import React from 'react';
import styles from '../views/AiBuyerMerchantLabView.module.css';

interface ExplainableMoneyTrailProps {
  intent: { category: string } | null;
  selectedProduct: { name: string; marginPercent: number; pricePaise: number } | null;
  offerUpsell: { name?: string; productId?: string } | null;
  maxDiscount: number;
  minMargin: number;
  txResult: { amountPaise: number; razorpayOrderId: string; audit_sha256?: string } | null;
}

/**
 * The WHO/WHAT/WHY/LIMIT/RESULT audit display for transparent commerce interactions.
 */
export function ExplainableMoneyTrail({
  intent,
  selectedProduct,
  offerUpsell,
  maxDiscount,
  minMargin,
  txResult
}: ExplainableMoneyTrailProps) {
  return (
    <div className={styles.moneyTrail} role="log" aria-label="Explainable Money Trail">
      <div className={styles.moneyTrailHeader}>
        <span className={styles.moneyTrailLabel}>Explainable Money Trail</span>
      </div>
      <div className={styles.trailGrid}>
        <div className={styles.trailField}>
          <span className={styles.trailKey}>WHO:</span>
          <span className={styles.trailValue}>User Intent — {intent?.category || 'None'}</span>
        </div>
        <div className={styles.trailField}>
          <span className={styles.trailKey}>WHAT:</span>
          <span className={styles.trailValue}>
            {selectedProduct ? `${selectedProduct.name} (₹${(selectedProduct.pricePaise / 100).toFixed(2)})` : 'None'}
          </span>
        </div>
        <div className={styles.trailField}>
          <span className={styles.trailKey}>WHY:</span>
          <span className={styles.trailValue}>
            {offerUpsell?.name ? `Upsell logic via ${offerUpsell.name}` : 'Direct Intent Matching'}
          </span>
        </div>
        <div className={styles.trailField}>
          <span className={styles.trailKey}>LIMIT:</span>
          <span className={styles.trailValue}>
            Constraint: ≤{maxDiscount}% discount, ≥{minMargin}% margin
          </span>
        </div>
        {txResult && (
          <div className={styles.trailField}>
            <span className={styles.trailKey}>RESULT:</span>
            <span className={styles.trailValue}>
              Processed ₹{(txResult.amountPaise / 100).toFixed(2)} (Ref: {txResult.razorpayOrderId})
            </span>
          </div>
        )}
        {txResult?.audit_sha256 && (
          <div className={styles.moneyTrailHash} style={{ marginTop: '4px' }}>
            <code style={{ fontSize: '12px' }}>{txResult.audit_sha256}</code>
          </div>
        )}
      </div>
    </div>
  );
}
