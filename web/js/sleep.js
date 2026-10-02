// Les bruits du sommeil, synthétisés (aucun fichier) et calés sur la respiration du visage :
// le robot ronfle (râle à l'inspiration, petit sifflet à l'expiration), le chat ronronne.
import { BREATH } from './face.js';

export const MAX_SLEEP_H = 8;
const DAY = 24 * 3600e3;
const LEVEL = 0.35; // le sommeil se fait discret : bien en dessous de sa voix

// Sommeil commandé ([dodo…] du serveur) → l'heure du réveil, en ms : « 7h30 » / « 7:30 » = la prochaine fois
// que cette heure sonne, « +20 » = dans 20 min (un jour au plus), sinon MAX_SLEEP_H heures.
export function wakeTime(at, now = new Date()) {
  const t = now.getTime(), rel = /^\+\s*(\d{1,6})$/.exec(at || '');
  if (rel) return t + Math.min(Number(rel[1]) * 60e3, DAY);
  const abs = /^(\d{1,2})\s*[:h]\s*(\d{2})?$/i.exec((at || '').trim());
  if (abs && Number(abs[1]) < 24 && Number(abs[2] || 0) < 60) {
    const d = new Date(now);
    d.setHours(Number(abs[1]), Number(abs[2] || 0), 0, 0);
    return d.getTime() > t ? d.getTime() : d.getTime() + DAY;
  }
  return t + MAX_SLEEP_H * 3600e3;
}

export class Sleeper {
  constructor(player) {
    this.player = player;
    this.noise = null;
    this.prev = 1;
  }

  // À chaque image : f = sortie de face.update. On programme une respiration quand un cycle commence.
  update(f, enabled, cat) {
    const ctx = this.player.ctx, phase = f.phase;
    const begins = phase < this.prev;
    this.prev = phase;
    if (!begins || !enabled || !f.asleep || !this.player.ready || this.player.busy()) return;
    const at = ctx.currentTime + 0.03;
    if (cat) this.purr(ctx, at);
    else this.snore(ctx, at);
  }

  source(ctx, at, dur) {
    if (!this.noise) {
      this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.start(at);
    src.stop(at + dur);
    return src;
  }

  // Une enveloppe qui monte, tient puis retombe ; `rattle` Hz : le volume tremble (le râle, le ronron).
  envelope(ctx, at, peak, rise, hold, fall, rattle = 0, depth = 0) {
    peak *= LEVEL;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + rise);
    g.gain.setValueAtTime(peak, at + rise + hold);
    g.gain.linearRampToValueAtTime(0, at + rise + hold + fall);
    if (rattle) {
      const lfo = ctx.createOscillator(), amt = ctx.createGain();
      lfo.frequency.value = rattle;
      amt.gain.value = peak * depth;
      lfo.connect(amt).connect(g.gain);
      lfo.start(at);
      lfo.stop(at + rise + hold + fall);
    }
    g.connect(this.player.gain);
    return g;
  }

  snore(ctx, at) {
    const inhale = BREATH * 0.4;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(140, at);
    band.frequency.linearRampToValueAtTime(220, at + inhale);
    band.Q.value = 1.4;
    this.source(ctx, at, inhale).connect(band).connect(this.envelope(ctx, at, 0.5, inhale * 0.45, inhale * 0.2, inhale * 0.35, 31, 0.9));
    const hum = ctx.createOscillator(), low = ctx.createBiquadFilter();
    hum.type = 'sawtooth';
    hum.frequency.setValueAtTime(78, at);
    hum.frequency.linearRampToValueAtTime(92, at + inhale);
    low.type = 'lowpass';
    low.frequency.value = 320;
    hum.connect(low).connect(this.envelope(ctx, at, 0.07, inhale * 0.45, inhale * 0.2, inhale * 0.35, 31, 0.9));
    hum.start(at);
    hum.stop(at + inhale);
    const out = at + BREATH * 0.5, exhale = BREATH * 0.32; // le petit sifflet de dessin animé
    const whistle = ctx.createOscillator();
    whistle.frequency.setValueAtTime(1150, out);
    whistle.frequency.exponentialRampToValueAtTime(620, out + exhale);
    whistle.connect(this.envelope(ctx, out, 0.022, exhale * 0.3, exhale * 0.2, exhale * 0.5));
    whistle.start(out);
    whistle.stop(out + exhale);
    const air = ctx.createBiquadFilter();
    air.type = 'highpass';
    air.frequency.value = 1800;
    this.source(ctx, out, exhale).connect(air).connect(this.envelope(ctx, out, 0.03, exhale * 0.3, exhale * 0.2, exhale * 0.5));
  }

  purr(ctx, at) {
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 380;
    // Ronron continu : plus fort à l'inspiration, un peu moins à l'expiration, jamais de trou entre deux cycles.
    const g = this.envelope(ctx, at, 0.55, BREATH * 0.35, BREATH * 0.1, BREATH * 0.6, 26, 0.95);
    this.source(ctx, at, BREATH * 1.05).connect(low).connect(g);
  }
}
