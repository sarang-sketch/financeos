'use client';

import React, { useState, useEffect } from 'react';
import styles from './features.module.css';

/**
 * Dark/Light mode toggle.
 * Persists preference in localStorage.
 */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('commerceos-theme');
    if (saved === 'dark') {
      setDark(true);
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.setAttribute('data-theme', next ? 'dark' : 'light');
    localStorage.setItem('commerceos-theme', next ? 'dark' : 'light');
  };

  return (
    <button
      className={styles.themeToggle}
      onClick={toggle}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Light mode' : 'Dark mode'}
    >
      <span>{dark ? '☀️' : '🌙'}</span>
      <span>{dark ? 'Light' : 'Dark'}</span>
    </button>
  );
}
