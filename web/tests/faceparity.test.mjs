// The .eliface files against the code faces they replace, cell by cell: `node --test web/tests`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileFace } from '../js/faceformat.js';
import { formatLit } from '../js/faceview.js';
import { catLit, matLit, pixLit } from '../js/themes.js';

const load = (name) => compileFace(readFileSync(new URL(`../faces/${name}.eliface`, import.meta.url), 'utf8'));
const GRIDS = [128, 52, 42, 32, 28];

const mulberry32 = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
// Seeded states covering gaze, blinks, smiles both sides of 0.5, eyelid angles of both signs (and 0), the mouth,
// and T inside the ear twitch of each side (7.35 for s = -1, 4.25 for s = +1).
export function sweep(n, seed = 1) {
  const rand = mulberry32(seed), u = (a, b) => a + (b - a) * rand();
  return Array.from({ length: n }, (_, k) => ({
    T: [7.35, 4.25, u(0, 30)][k % 3],
    eyes: {
      gx: u(-1.2, 1.2), gy: u(-1.2, 1.2), open: k % 7 === 0 ? 0 : u(0, 1.1),
      hap: [0, u(0, 0.5), u(0, 1), u(0.5, 1)][k % 4], sc: u(0.8, 1.25), bo: u(-1, 1), ang: k % 5 === 0 ? 0 : u(-1, 1),
    },
    mouth: { o: u(0, 1), w: u(0, 1), r: u(0, 1), t: k % 2 ? u(0, 1) : 0 },
  }));
}

function wideDiffs(code, face) {
  const fmt = formatLit(face, 'wide'), diffs = [];
  for (const f of sweep(400)) {
    for (const cols of GRIDS) {
      const rows = cols / 2, minH = 0.55 / rows;
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const x = ((i + 0.5) / cols) * 2, y = (j + 0.5) / rows;
        if (Boolean(code(f, x, y, minH)) !== fmt(f, x, y, minH)) diffs.push({ cols, i, j, f });
      }
    }
  }
  return diffs;
}
const report = (diffs) => `${diffs.length} differing cells; first: ${JSON.stringify(diffs[0])}`;

test('pixel.eliface draws exactly pixLit', () => {
  const diffs = wideDiffs(pixLit, load('pixel'));
  assert.equal(diffs.length, 0, report(diffs));
});

test('chat-pixel.eliface draws exactly catLit', () => {
  const diffs = wideDiffs(catLit, load('chat-pixel'));
  assert.equal(diffs.length, 0, report(diffs));
});

test('matrice.eliface draws exactly matLit on the 19×19 matrix', () => {
  const N = 19, fmt = formatLit(load('matrice'), 'square'), diffs = [];
  for (const f of sweep(400)) {
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const u = -1 + ((i + 0.5) * 2) / N, v = -1 + ((j + 0.5) * 2) / N;
      if (Boolean(matLit(f, u, v)) !== fmt(f, u, v, 1.1 / N)) diffs.push({ i, j, f });
    }
  }
  assert.equal(diffs.length, 0, report(diffs));
});
