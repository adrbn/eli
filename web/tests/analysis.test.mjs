// Vérifs de l'analyse audio : `node --test web/tests`.
import assert from 'node:assert/strict';
import test from 'node:test';
import { HOP, SR, analyzeMusic, analyzeSpeech, crossed, encodeWav, mouthAt, sample, visemeTrack } from '../js/analysis.js';

const seconds = (s) => new Float32Array(Math.round(s * SR));

// Une voyelle « a » synthétique : harmoniques de 140 Hz renforcées autour de 750 et 1200 Hz.
function vowel(s, f0 = 140, amp = 0.3) {
  const x = seconds(s), bump = (f, c, w) => Math.exp(-(((f - c) / w) ** 2));
  for (let k = 1; k * f0 < 4000; k++) {
    const f = k * f0, a = (amp / k) * (0.3 + bump(f, 750, 250) * 4 + bump(f, 1200, 300) * 2);
    for (let i = 0; i < x.length; i++) x[i] += a * Math.sin((2 * Math.PI * f * i) / SR);
  }
  return x;
}

function hiss(s, amp = 0.2) { // un « s » : bruit aigu
  const x = seconds(s);
  let prev = 0;
  for (let i = 0; i < x.length; i++) {
    const n = Math.random() * 2 - 1;
    x[i] = amp * (n - prev); // différence première = passe-haut
    prev = n;
  }
  return x;
}

const concat = (...parts) => {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length }
  return out;
};
const max = (a) => a.reduce((m, v) => Math.max(m, v), 0);

test('silence : bouche fermée', () => {
  const tr = analyzeSpeech(seconds(1));
  assert.equal(max(tr.o), 0);
  assert.equal(tr.starts.length, 0);
});

test('voyelle : la bouche s’ouvre, puis se referme au silence', () => {
  const tr = analyzeSpeech(concat(seconds(0.3), vowel(0.6), seconds(0.5)));
  assert.ok(mouthAt(tr, 0.6).o > 0.5, `ouverture ${mouthAt(tr, 0.6).o}`);
  assert.ok(mouthAt(tr, 0.15).o < 0.01);
  assert.ok(mouthAt(tr, 1.3).o < 0.01, 'refermée après la voyelle');
});

test('sifflante : les dents se montrent, la bouche reste peu ouverte', () => {
  const tr = analyzeSpeech(concat(vowel(0.4), hiss(0.4)));
  const s = mouthAt(tr, 0.65), a = mouthAt(tr, 0.2);
  assert.ok(s.t > 0.5, `dents ${s.t}`);
  assert.ok(s.o < a.o, 'moins ouverte que sur la voyelle');
});

test('phrases : un début par prise de parole, une pause entre les deux', () => {
  const tr = analyzeSpeech(concat(vowel(0.5), seconds(0.6), vowel(0.5), seconds(0.4)));
  assert.equal(tr.starts.length, 2);
  assert.ok(Math.abs(tr.starts[1] - 1.1) < 0.05, `2e début à ${tr.starts[1]}`);
  assert.ok(tr.pauses.length >= 1 && tr.pauses[0] > 0.5 && tr.pauses[0] < 1.1);
  assert.equal(crossed(tr.starts, 1.0, 1.2), 1);
});

test('musique : retrouve 120 bpm sur un clic régulier', () => {
  const x = seconds(12);
  for (let b = 0.25; b < 12; b += 0.5) { // un coup de grosse caisse toutes les 0,5 s
    const i0 = Math.round(b * SR);
    for (let i = 0; i < 1600 && i0 + i < x.length; i++) x[i0 + i] += 0.8 * Math.exp(-i / 300) * Math.sin((2 * Math.PI * 60 * i) / SR);
  }
  const tr = analyzeMusic(x);
  assert.ok(Math.abs(tr.bpm - 120) < 3, `tempo ${tr.bpm}`);
  const gaps = [];
  for (let i = 1; i < tr.beats.length; i++) gaps.push(tr.beats[i] - tr.beats[i - 1]);
  assert.ok(gaps.every((g) => Math.abs(g - 0.5) < 0.05), `écarts ${gaps}`);
  assert.ok(Math.abs((tr.beats[0] % 0.5) - 0.25) < 0.04, `phase ${tr.beats[0]}`);
  assert.equal(tr.energy.length, tr.n);
  assert.ok(tr.n * HOP >= 11.99);
});

test('WAV : en-tête 16 bits mono correct', () => {
  const v = new DataView(encodeWav(new Float32Array([0, 1, -1, 2]), 16000));
  const tag = (o) => String.fromCharCode(...[0, 1, 2, 3].map((k) => v.getUint8(o + k)));
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint32(40, true), 8);
  assert.equal(v.getInt16(46, true), 32767);
  assert.equal(v.getInt16(48, true), -32767);
  assert.equal(v.getInt16(50, true), 32767, 'écrêté');
});

test('les phonèmes forment les lèvres : fermées sur « m », ouvertes sur « a », rondes sur « u »', () => {
  const n = 100, track = { n, lv: new Float32Array(n).fill(1), ...visemeTrack([['m', 200], ['ˈ', 50], ['a', 250], ['u', 300], ['.', 200]], n) };
  assert.ok(mouthAt(track, 0.15).o < 0.05);
  assert.ok(mouthAt(track, 0.4).o > 0.9);
  assert.ok(mouthAt(track, 0.7).r > 0.9 && mouthAt(track, 0.7).w < 0.1);
  assert.ok(mouthAt(track, 0.95).o < 0.05); // repos sur la ponctuation
});

test('chant : la hauteur suit la note (grave puis aigu)', () => {
  const low = vowel(1, 160), high = vowel(1, 320), x = new Float32Array(low.length + high.length);
  x.set(low);
  x.set(high, low.length);
  const tr = analyzeSpeech(x, -Infinity, true);
  const grave = sample(tr, 'pt', 0.6), aigu = sample(tr, 'pt', 1.7);
  assert.ok(aigu - grave > 0.9, `une octave d'écart : ${grave} → ${aigu}`); // relatif à la médiane du chanteur
});
