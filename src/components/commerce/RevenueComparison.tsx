'use client';

import React from 'react';
import styles from './features.module.css';

interface ComparisonData {
  aiRevenuePaise: number;
  manualRevenuePaise: number;
  aiAovPaise: number;
  manualAovPaise: number;
  aiUpsellRate: number;
  manualUpsellRate: number;
  aiCartAbandon: number;
  manualCartAbandon: number;
  upliftMultiple: number;
}

export function RevenueComparison({ data }: { data: ComparisonData | null }) {
  if (!data) {
    return (
      <div className={styles.comparisonGrid} role="region" aria-label="Revenue Comparison">
        Loading comparison...
      </div>
    );
  }

  const formatINR = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;

  const maxRevenue = Math.max(data.aiRevenuePaise, data.manualRevenuePaise) || 1;
  const maxAov = Math.max(data.aiAovPaise, data.manualAovPaise) || 1;

  return (
    <div className={styles.comparisonGrid} role="region" aria-label="Revenue Comparison">
      <div className={`${styles.comparisonSide} ${styles.comparisonManual}`}>
        <div className={styles.comparisonLabel}>😴 WITHOUT AI</div>
        
        <div className={styles.comparisonMetric}>
          <span className={styles.comparisonMetricLabel}>Revenue</span>
          <span className={styles.comparisonMetricValue}>{formatINR(data.manualRevenuePaise)}</span>
        </div>
        <div className={styles.comparisonBar} aria-hidden="true">
          <div 
            className={`${styles.comparisonBarFill} ${styles.comparisonBarManual}`} 
            style={{ width: `${(data.manualRevenuePaise / maxRevenue) * 100}%` }}
          ></div>
        </div>

        <div className={styles.comparisonMetric}>
          <span className={styles.comparisonMetricLabel}>AOV</span>
          <span className={styles.comparisonMetricValue}>{formatINR(data.manualAovPaise)}</span>
        </div>
        <div className={styles.comparisonBar} aria-hidden="true">
          <div 
            className={`${styles.comparisonBarFill} ${styles.comparisonBarManual}`} 
            style={{ width: `${(data.manualAovPaise / maxAov) * 100}%` }}
          ></div>
        </div>

        <div className={styles.comparisonMetric}>
          <span className={styles.comparisonMetricLabel}>Upsell Rate</span>
          <span className={styles.comparisonMetricValue}>{data.manualUpsellRate}%</span>
        </div>
        <div className={styles.comparisonBar} aria-hidden="true">
          <div 
            className={`${styles.comparisonBarFill} ${styles.comparisonBarManual}`} 
            style={{ width: `${data.manualUpsellRate}%` }}
          ></div>
        </div>

        <div className={styles.comparisonMetric}>
          <span className={styles.comparisonMetricLabel}>Cart Abandon</span>
          <span className={styles.comparisonMetricValue}>{data.manualCartAbandon}%</span>
        </div>
        <div className={styles.comparisonBar} aria-hidden="true">
          <div 
            className={`${styles.comparisonBarFill} ${styles.comparisonBarManual}`} 
            style={{ width: `${data.manualCartAbandon}%` }}
          ></div>
        </div>
      </div>

      <div className={styles.comparisonDivider}>
        <div className={styles.comparisonBadge}>{data.upliftMultiple}x Uplift</div>
      </div>

      <div className={`${styles.comparisonSide} ${styles.comparisonAi}`}>
        <div className={styles.comparisonLabel}>🤖 WITH AI</div>
        
        <div className={styles.comparisonMetric}>
          <span className={styles.comparisonMetricLabel}>Revenue</span>
          <span className={styles.comparisonMetricValue}>{formatINR(data.aiRevenuePaise)}</span>
        </div>
        <div className={styles.comparisonBar} aria-hidden="true">
          <div 
            className={`${styles.comparisonBarFill} ${styles.comparisonBarAi}`} 
            style={{ width: `${(data.aiRevenuePaise / maxRevenue) * 100}%` }}
          ></div>
        </div>

        <div className={styles.comparisonMetric}>
          <span className={styles.comparisonMetricLabel}>AOV</span>
          <span className={styles.comparisonMetricValue}>{formatINR(data.aiAovPaise)}</span>
        </div>
        <div className={styles.comparisonBar} aria-hidden="true">
          <div 
            className={`${styles.comparisonBarFill} ${styles.comparisonBarAi}`} 
            style={{ width: `${(data.aiAovPaise / maxAov) * 100}%` }}
          ></div>
        </div>

        <div className={styles.comparisonMetric}>
          <span className={styles.comparisonMetricLabel}>Upsell Rate</span>
          <span className={styles.comparisonMetricValue}>{data.aiUpsellRate}%</span>
        </div>
        <div className={styles.comparisonBar} aria-hidden="true">
          <div 
            className={`${styles.comparisonBarFill} ${styles.comparisonBarAi}`} 
            style={{ width: `${data.aiUpsellRate}%` }}
          ></div>
        </div>

        <div className={styles.comparisonMetric}>
          <span className={styles.comparisonMetricLabel}>Cart Abandon</span>
          <span className={styles.comparisonMetricValue}>{data.aiCartAbandon}%</span>
        </div>
        <div className={styles.comparisonBar} aria-hidden="true">
          <div 
            className={`${styles.comparisonBarFill} ${styles.comparisonBarAi}`} 
            style={{ width: `${data.aiCartAbandon}%` }}
          ></div>
        </div>
      </div>
    </div>
  );
}
