// Checks the firmware's ports against the original web code: `node firmware/esp32/test/check.mjs`
// Builds the pure C++ modules with the host compiler (no ESP32 toolchain needed), feeds them and the JS the same
// inputs, and compares: level/phrase/pause track, viseme track, and the Pixel faces bit for bit (a few edge pixels
// may differ: float on the board vs double in JS).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOP, SR, analyzeSpeech, visemeTrack } from '../../../web/js/analysis.js';

const here = dirname(fileURLToPath(import.meta.url)), src = join(here, '../src'), tmp = mkdtempSync(join(tmpdir(), 'eli-fw-'));
const bin = join(tmp, 'check');
execFileSync('c++', ['-std=c++17', '-O2', '-Wall', '-Wextra', '-o', bin, join(here, 'check.cpp'),
  ...['clip.cpp', 'face.cpp', 'pixel.cpp'].map((f) => join(src, f))], { stdio: 'inherit' });

// --- inputs -------------------------------------------------------------------------------------------------
// Speech-like bursts and silences at 16 kHz, quantized to int16 exactly as the board receives them.
const segs = [[0.3, 0], [0.5, 0.3], [0.35, 0], [0.4, 0.05], [0.6, 0], [0.25, 0.5], [0.1, 0]];
const pcm = new Int16Array(Math.round(segs.reduce((a, [d]) => a + d, 0) * SR));
for (let i = 0, k = 0; k < segs.length; k++) {
  const [d, amp] = segs[k];
  for (let j = 0; j < Math.round(d * SR); j++, i++) {
    const t = i / SR;
    pcm[i] = Math.round(32767 * amp * (0.6 * Math.sin(2 * Math.PI * 140 * t) + 0.4 * Math.sin(2 * Math.PI * 900 * t)));
  }
}
writeFileSync(join(tmp, 'pcm.raw'), Buffer.from(pcm.buffer));

// Durations off the 10 ms grid: on an exact tie JS doubles land either side by one ulp, the board counts whole ms.
const phonemes = [['b', 47], ['ɔ', 83], ['̃', 41], ['ʒ', 72], ['ˈ', 0], ['u', 93], ['ː', 61], ['ʁ', 54], [' ', 104],
  ['ˌ', 0], ['ˈ', 0], ['t', 43], ['ɛ', 86], ['?', 33], ['ab', 52], ['', 21], ['ɲ', 64], ['m', 37], ['a', 123]];
const N = 140;

const faces = [
  ['pixel', 0, 0, 1, 0, 1, 0, 0, 0, 0.3, 0, 0],
  ['pixel', 1.2, -0.8, 0.5, 0.7, 1.1, 0.3, 0, 0.9, 0.6, 0.2, 1],
  ['pixel', -0.6, 0.4, 1, 0, 0.94, 0, -0.9, 0.03, 0.15, 0.4, 0],
  ['pixel', 0.2, 0, 0.9, 0.3, 1.3, 0, 0.8, 0.4, 0.15, 1, 0],
  ['pixel', 0, 0.3, 0.07, 0, 1, 0, 0, 0.2, 0.25, 0.4, 0],
  ['blocs', 0.5, 0.1, 1, 0.85, 1.06, 0, 0, 0.6, 0.8, 0, 0.2],
  ['perles', -0.3, -0.2, 0.8, 0, 1, 0.5, 0.45, 1, 0.55, 0, 0],
];

writeFileSync(join(tmp, 'in.txt'), [
  `PCM ${join(tmp, 'pcm.raw')} ${SR}`,
  ...phonemes.map(([p, ms]) => `PH ${ms} ${p ? encodeURIComponent(p) : '-'}`),
  `VISEMES ${N}`,
  ...faces.map((f) => `FACE ${f.join(' ')}`),
].join('\n'));
const out = execFileSync(bin, [join(tmp, 'in.txt')], { encoding: 'utf8' }).trim().split('\n');
const line = (tag) => out.filter((l) => l.startsWith(`${tag} `)).map((l) => l.slice(tag.length + 1).split(' '));

// --- level, phrase starts, pauses --------------------------------------------------------------------------
const tr = analyzeSpeech(Float32Array.from(pcm, (v) => v / 32768));
const lv = line('LV')[0].map(Number), flags = line('FLAGS')[0].map(Number);
assert.equal(lv.length, tr.n);
lv.forEach((v, i) => assert.ok(Math.abs(v - tr.lv[i]) < 2e-3, `lv[${i}] ${v} vs ${tr.lv[i]}`));
const times = (bit) => flags.flatMap((f, i) => (f & bit ? [+(i * HOP).toFixed(2)] : []));
assert.deepEqual(times(1), tr.starts.map((t) => +t.toFixed(2)));
assert.deepEqual(times(2), tr.pauses.map((t) => +t.toFixed(2)));

// --- visemes -------------------------------------------------------------------------------------------------
const vt = visemeTrack(phonemes, N);
['vo', 'vw', 'vr', 'vt'].forEach((k, j) => line(`V${j}`)[0].map(Number).forEach((v, i) =>
  assert.ok(Math.abs(v - vt[k][i]) < 1e-4, `${k}[${i}] ${v} vs ${vt[k][i]}`)));

// --- Pixel faces: the JS pixLit and oled() grid, lifted from themes.js ------------------------------------------
const themes = readFileSync(join(here, '../../../web/js/themes.js'), 'utf8');
const fn = (name) => themes.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`))[0];
const pixLit = new Function('clamp01', `${fn('sdBox')}${fn('pixLit')}return pixLit;`)((v) => Math.min(1, Math.max(0, v)));
const pattern = (name) => JSON.parse(themes.match(new RegExp(`const ${name} = (\\[.*\\]);`))[1]);
const grid = (id) => {
  const [, cols, cell, pat] = themes.match(new RegExp(`id: '${id}'.*?oled\\((\\d+), (\\d+), (\\w+|\\[\\[0, 0\\]\\])`));
  return [+cols, +cell, pat.startsWith('[') ? [[0, 0]] : pattern(pat)];
};
line('BMP').forEach(([bits], k) => {
  const [id, gx, gy, open, hap, sc, bo, ang, o, w, r, t] = faces[k];
  const f = { eyes: { gx, gy, open, hap, sc, bo, ang }, mouth: { o, w, r, t } };
  const [cols, cell, pat] = grid(id), rows = cols / 2, x0 = (128 - cols * cell) >> 1, y0 = (64 - rows * cell) >> 1;
  const px = new Uint8Array(128 * 64);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    if (pixLit(f, ((i + 0.5) / cols) * 2, (j + 0.5) / rows, 0.55 / rows)) for (const [a, b] of pat) px[(y0 + j * cell + b) * 128 + x0 + i * cell + a] = 1;
  }
  let diff = 0, lit = 0;
  for (let i = 0; i < px.length; i++) { diff += px[i] !== +bits[i]; lit += px[i] }
  assert.ok(lit > 50, `face ${k} (${id}) is nearly blank`);
  assert.ok(diff <= 4, `face ${k} (${id}): ${diff} pixels differ`);
});

console.log(`ok: native checks, level/phrases (${tr.n} frames), visemes (${N}), ${faces.length} faces vs web/js`);
