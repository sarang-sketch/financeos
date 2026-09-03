'use client';
import React from 'react';
import styles from '../views/AiBuyerMerchantLabView.module.css';

interface MoneyFirewallCardProps {
  maxDiscount: number;
  minMargin: number;
  onMaxDiscountChange: (val: number) => void;
  onMinMarginChange: (val: number) => void;
  firewallResult: {
    allowed: boolean;
    governance_level: string;
    reason: string;
    requested_discount_percent: number;
    max_discount_allowed: number;
    projected_margin_percent?: number;
    counter_offer_discount_percent?: number;
    audit_sha256?: string;
  } | null;
  violation: boolean;
  onTriggerViolation: () => void;
  onTriggerTimeout: () => void;
}

/**
 * The interactive Money Firewall with color-gradient sliders.
 */
export function MoneyFirewallCard({
  maxDiscount,
  minMargin,
  onMaxDiscountChange,
  onMinMarginChange,
  firewallResult,
  violation,
  onTriggerViolation,
  onTriggerTimeout
}: MoneyFirewallCardProps) {
  const cardClass = violation 
    ? `${styles.firewallCard} ${styles.firewallCardViolation}` 
    : firewallResult?.allowed 
      ? `${styles.firewallCard} ${styles.firewallCardApproved}` 
      : styles.firewallCard;

  return (
    <div className={cardClass} role="region" aria-label="Money Firewall Policy Gate">
      <div className={styles.firewallHeader}>
        <div className={styles.firewallHeaderLeft}>
          <span className={styles.firewallTitle}>Policy Gate: Money Firewall</span>
        </div>
      </div>

      <div className={styles.sliderBox}>
        <div className={styles.sliderRow}>
          <label htmlFor="max-discount">Max Discount (%)</label>
          <span>{maxDiscount}%</span>
        </div>
        <input 
          id="max-discount"
          type="range"
          min="0"
          max="30"
          value={maxDiscount}
          onChange={(e) => onMaxDiscountChange(parseInt(e.target.value, 10))}
          className={`${styles.sliderInput} ${styles.sliderSafe}`}
          aria-label="Maximum discount percentage"
        />
        {maxDiscount > 15 && (
          <div className={styles.sliderWarning}>
            ⚠️ Permissive discount policy — margin erosion risk
          </div>
        )}
      </div>

      <div className={styles.sliderBox}>
        <div className={styles.sliderRow}>
          <label htmlFor="min-margin">Min Margin (%)</label>
          <span>{minMargin}%</span>
        </div>
        <input 
          id="min-margin"
          type="range"
          min="0"
          max="50"
          value={minMargin}
          onChange={(e) => onMinMarginChange(parseInt(e.target.value, 10))}
          className={`${styles.sliderInput} ${styles.sliderMargin}`}
          aria-label="Minimum margin percentage"
        />
        {minMargin < 20 && (
          <div className={styles.sliderWarning}>
            ⚠️ Low margin floor — profitability at risk
          </div>
        )}
      </div>

      {!violation && !firewallResult && (
        <div className={styles.policyGrid}>
          <div className={styles.policyItem}>
            <div className={styles.policyItemLabel}>Status</div>
            <div>Active</div>
          </div>
        </div>
      )}

      {violation && (
        <div className={styles.violationText}>
          Violation blocked: Discount requested exceeds margin bounds.
        </div>
      )}

      {firewallResult?.allowed && !violation && (
        <div className={styles.approvalText}>
          Approved: Transaction meets policy requirements.
        </div>
      )}

      <div className={styles.firewallActions}>
        <button className={styles.btnDanger} onClick={onTriggerViolation}>
          Test Violation
        </button>
        <button className={styles.btnWarning} onClick={onTriggerTimeout}>
          Test Timeout
        </button>
      </div>
    </div>
  );
}
