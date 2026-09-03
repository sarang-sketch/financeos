'use client';

import React, { useEffect, useState } from 'react';
import styles from './features.module.css';

interface DashboardData {
  totalRevenuePaise: number;
  aiRevenuePaise: number;
  totalOrders: number;
  averageOrderValuePaise: number;
  firewallBlocks: number;
  firewallGateScore: number;
  upsellAttachRate: number;
  avgMarginPercent: number;
  dailyTargetPaise: number;
  progressPercent: number;
  revenueSparkline: number[];
  comparison: any;
  generatedAt: string;
}

export function LiveRevenueDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch('/api/dashboard/commerce');
        if (res.ok) {
          const json = await res.json();
          setData(json);
        }
      } catch (error) {
        console.error('Failed to fetch dashboard data:', error);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 3000);
    return () => clearInterval(interval);
  }, []);

  if (!data) {
    return (
      <div className={styles.dashboard} role="region" aria-label="AI Control Center">
        Loading live data...
      </div>
    );
  }

  const formatINR = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;

  const maxSparkline = Math.max(...(data.revenueSparkline || [1]));

  return (
    <section className={styles.dashboard} role="region" aria-label="AI Control Center">
      <div className={styles.dashboardHeader}>
        <h2 className={styles.dashboardTitle}>
          AI Control Center
          <div className={styles.liveDot} aria-hidden="true"></div>
        </h2>
      </div>

      <div className={styles.metricsGrid}>
        <div className={styles.metricCard}>
          <div className={styles.metricLabel}>AI Revenue</div>
          <div className={`${styles.metricValue} ${styles.metricValueBrand}`}>
            {formatINR(data.totalRevenuePaise)}
          </div>
        </div>
        <div className={styles.metricCard}>
          <div className={styles.metricLabel}>Orders</div>
          <div className={styles.metricValue}>
            {data.totalOrders}
          </div>
        </div>
        <div className={styles.metricCard}>
          <div className={styles.metricLabel}>Avg Cart</div>
          <div className={styles.metricValue}>
            {formatINR(data.averageOrderValuePaise)}
          </div>
        </div>
        <div className={styles.metricCard}>
          <div className={styles.metricLabel}>Gate Score</div>
          <div className={`${styles.metricValue} ${styles.metricValueSuccess}`}>
            {data.firewallGateScore}%
          </div>
        </div>
      </div>

      <div className={styles.progressWrapper}>
        <div className={styles.progressTrack}>
          <div 
            className={styles.progressFill} 
            style={{ width: `${data.progressPercent}%` }} 
            role="progressbar" 
            aria-valuenow={data.progressPercent} 
            aria-valuemin={0} 
            aria-valuemax={100}
            aria-label="Progress toward daily target"
          ></div>
        </div>
      </div>

      <div className={styles.sparklineRow} aria-label="Revenue Sparkline" role="img">
        {data.revenueSparkline?.map((val, idx) => (
          <div 
            key={idx} 
            className={styles.sparkBar} 
            style={{ height: `${Math.max(10, (val / maxSparkline) * 100)}%` }} 
          ></div>
        ))}
      </div>
    </section>
  );
}
