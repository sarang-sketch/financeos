'use client';

import React, { useState } from 'react';
import styles from './features.module.css';

const steps = [
  {
    title: "AI Buyer Discovery",
    description: "Watch as Gemini extracts buying intent from natural language and deterministically matches products from the catalog."
  },
  {
    title: "Merchant Offer Engine",
    description: "The Merchant Agent calculates the optimal offer with upsell attachments, scored by intent match × attach rate × margin factor."
  },
  {
    title: "Money Firewall Gate",
    description: "Every action passes through the deterministic policy gate. Drag the sliders to change rules in real-time — watch transactions get BLOCKED or APPROVED."
  },
  {
    title: "Razorpay Payment",
    description: "Real Razorpay test-mode order creation and payment capture. Full HMAC signature verification with idempotency protection."
  },
  {
    title: "SHA-256 Audit Trail",
    description: "Every decision is recorded with a tamper-evident SHA-256 chain. Click any hash to copy. The trail proves WHO did WHAT, WHY, and under WHICH policy."
  },
  {
    title: "Revenue Intelligence",
    description: "The Revenue Agent analyzes performance, generates strategies, and simulates outcomes with Monte Carlo projections — all within merchant-defined boundaries."
  },
  {
    title: "You're Ready!",
    description: "Click 'Run Full Transaction' to see the entire AI commerce loop in action. Try injecting a timeout or triggering a firewall violation to see the safety systems."
  }
];

export function GuidedDemoTour({ onComplete }: { onComplete: () => void }) {
  const [currentStep, setCurrentStep] = useState(0);

  const handleNext = () => {
    if (currentStep === steps.length - 1) {
      onComplete();
    } else {
      setCurrentStep(prev => prev + 1);
    }
  };

  const isLastStep = currentStep === steps.length - 1;

  return (
    <div className={styles.tourOverlay} role="dialog" aria-modal="true" aria-label="Guided Demo Tour">
      <div className={styles.tourTooltip}>
        <div className={styles.tourStep}>Step {currentStep + 1} of {steps.length}</div>
        <div className={styles.tourTitle}>{steps[currentStep]!.title}</div>
        <div className={styles.tourDesc}>{steps[currentStep]!.description}</div>
        
        <div className={styles.tourActions}>
          <div className={styles.tourProgress} aria-label={`Step ${currentStep + 1} of ${steps.length}`}>
            {steps.map((_, index) => (
              <div 
                key={index} 
                className={`${styles.tourDot} ${index === currentStep ? styles.tourDotActive : ''}`} 
                aria-hidden="true"
              />
            ))}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button 
              className={`${styles.tourBtn} ${styles.tourBtnSkip}`} 
              onClick={onComplete}
              aria-label="Skip tour"
            >
              Skip
            </button>
            <button 
              className={`${styles.tourBtn} ${styles.tourBtnPrimary}`} 
              onClick={handleNext}
              aria-label={isLastStep ? "Start Demo" : "Next Step"}
            >
              {isLastStep ? "Start Demo" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
