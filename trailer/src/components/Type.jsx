import React from 'react';
import { spring } from '../lib/time.js';

export const SANS = '"SF Pro Display", -apple-system, system-ui, "Helvetica Neue", sans-serif';
export const MONO = 'Departure, ui-monospace, monospace';
export const INK = '#eef3ee';
export const GREEN = '#46ff86';

// Letters fall into place one by one, out of a blur.
export function Reveal({ text, t, t0, size, weight = 700, color = INK, stagger = 0.035, tracking = -0.035, font = SANS, style }) {
  return (
    <div style={{ fontFamily: font, fontSize: size, fontWeight: weight, letterSpacing: `${tracking}em`, color, whiteSpace: 'pre', lineHeight: 1, ...style }}>
      {[...text].map((c, i) => {
        const k = spring(t, t0 + i * stagger, 13);
        return <span key={i} style={{ display: 'inline-block', opacity: k, transform: `translateY(${(1 - k) * 0.3}em)`, filter: k < 0.99 ? `blur(${(1 - k) * 14}px)` : 'none' }}>{c === ' ' ? ' ' : c}</span>;
      })}
    </div>
  );
}

// Typed out like a terminal, with a block cursor.
export function Typed({ text, t, t0, cps = 28, size = 26, color = GREEN, style }) {
  const n = Math.max(0, Math.min(text.length, Math.floor((t - t0) * cps)));
  if (t < t0) return null;
  const blink = Math.floor(t * 2.4) % 2 === 0 || n < text.length;
  return <div style={{ fontFamily: MONO, fontSize: size, color, whiteSpace: 'pre', textShadow: `0 0 18px ${GREEN}55`, ...style }}>{text.slice(0, n)}<span style={{ opacity: blink ? 1 : 0 }}>▌</span></div>;
}
