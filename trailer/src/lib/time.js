// Time helpers: everything in the trailer is a pure function of t (seconds), so any frame renders on its own.
export const FPS = 60;
export const BEAT = 0.5;
export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const range = (t, a, b) => clamp((t - a) / (b - a));
export const easeOut = (x) => 1 - (1 - clamp(x)) ** 3;
export const easeIn = (x) => clamp(x) ** 3;
export const easeInOut = (x) => { const u = clamp(x); return u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2 };
export const expoOut = (x) => (x >= 1 ? 1 : 1 - 2 ** (-10 * clamp(x)));
export const mix = (a, b, k) => a + (b - a) * k;
export const bell = (u) => Math.sin(Math.PI * clamp(u));

// Critically damped spring from 0 to 1 starting at t0 (w = stiffness).
export const spring = (t, t0, w = 12) => { if (t < t0) return 0; const d = t - t0; return 1 - (1 + w * d) * Math.exp(-w * d) };
// Underdamped: overshoots a little, for things that are thrown.
export const bounce = (t, t0, w = 14, z = 0.5) => {
  if (t < t0) return 0;
  const d = t - t0, wd = w * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * w * d) * (Math.cos(wd * d) + (z / Math.sqrt(1 - z * z)) * Math.sin(wd * d));
};
// Decaying kick after the latest of `times` already passed.
export const pulse = (t, times, k = 7) => { let v = 0; for (const x of times) if (t >= x) v = Math.exp(-k * (t - x)); return v };
export const beatPulse = (t, from, to, k = 7, every = BEAT) => (t < from || t >= to ? 0 : Math.exp(-k * ((t - from) % every)));

// Exponential approach to piecewise targets, the same easing as the app's face (ease(a, b, k, dt)).
export function track(t, keys, k = 8) {
  let v = keys[0][1];
  for (let i = 0; i < keys.length; i++) {
    const [t0, target] = keys[i];
    if (t < t0) break;
    const t1 = i + 1 < keys.length ? Math.min(t, keys[i + 1][0]) : t;
    v = target + (v - target) * Math.exp(-k * (t1 - t0));
  }
  return v;
}

export function seeded(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296 };
}
// Runs fn with Math.random swapped for a seeded generator: the app's code rolls dice, the video must not.
export function withRandom(rng, fn) {
  const keep = Math.random;
  Math.random = rng;
  try { return fn() } finally { Math.random = keep }
}
