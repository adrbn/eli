// Loading the shipped faces and drawing them on the vector display: `node --test 'web/tests/*.test.mjs'`.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compileFace } from '../js/faceformat.js';
import { drawFace, loadFaces } from '../js/faceview.js';

const fromDisk = (url) => readFile(new URL(`../${url}`, import.meta.url), 'utf8').then((text) => ({ ok: true, text: async () => text, json: async () => JSON.parse(text) }));

test('every theme of index.json gets a compiled face, each file compiled once', async () => {
  const faces = await loadFaces('faces/', fromDisk);
  assert.equal(faces.pixel.face.id, 'pixel');
  assert.equal(faces.blocs.face, faces.pixel.face);
  assert.equal(faces.matrice.face.space, 'square');
});

test('a broken face names its file', async () => {
  const get = async (url) => (url.endsWith('index.json')
    ? { ok: true, json: async () => ({ pixel: { face: 'pixel' } }) }
    : { ok: true, text: async () => '{"format": 2}' });
  await assert.rejects(loadFaces('faces/', get), { message: 'pixel.eliface: format: must be 1' });
});

// A canvas that only records what is drawn.
function recorder() {
  const calls = [];
  const ctx = new Proxy({ fillStyle: '#46ff86', calls }, {
    get: (o, k) => (k in o ? o[k] : (...args) => calls.push([k, ...args])),
    set: (o, k, v) => { o[k] = v; calls.push([`=${String(k)}`, v]); return true },
  });
  return { ctx, calls };
}
const still = { T: 0, eyes: { gx: 0, gy: 0, open: 1, hap: 0, sc: 1, bo: 0, ang: 0 }, mouth: { o: 0, w: 0, r: 0, t: 0 } };

test('drawFace paints in list order: fills, strokes, cuts in black, levels as alpha', () => {
  const face = compileFace(JSON.stringify({ format: 1, id: 't', frame: [140, -30, 40], shapes: [
    { rect: [110, 80, 10, 10], radius: 2 },
    { cut: { ellipse: [110, 80, 5, 5] } },
    { segment: [0, 0, 10, 0], stroke: 1.5, level: 0.4 },
  ] }));
  const { ctx, calls } = recorder();
  drawFace(face)(ctx, still, 1);
  const names = calls.map((c) => c[0]);
  assert.ok(names.indexOf('roundRect') < names.indexOf('ellipse'));
  assert.ok(names.indexOf('ellipse') < names.indexOf('lineTo'));
  assert.ok(calls.some((c) => c[0] === '=fillStyle' && c[1] === '#000'));
  assert.ok(calls.some((c) => c[0] === '=globalAlpha' && c[1] === 0.4));
  assert.ok(calls.some((c) => c[0] === '=lineWidth' && c[1] === 3));
});

test('glow strokes in pale green with a halo, 0.8125 of the width', () => {
  const face = compileFace(JSON.stringify({ format: 1, id: 't', frame: [140, -30, 40], shapes: [{ segment: [0, 0, 10, 0], stroke: 1.6 }] }));
  const { ctx, calls } = recorder();
  drawFace(face, { glow: true })(ctx, still, 2);
  assert.ok(calls.some((c) => c[0] === '=strokeStyle' && c[1] === '#d2ffe1'));
  assert.ok(calls.some((c) => c[0] === '=shadowBlur' && c[1] === 24));
  assert.ok(calls.some((c) => c[0] === '=lineWidth' && Math.abs(c[1] - 2.6) < 1e-9));
});

test('outfits sit where the code faces put them', async () => {
  const { catAnchors, pixAnchors } = await import('../js/looks.js');
  const faces = await loadFaces('faces/', fromDisk);
  const f = { ...still, eyes: { ...still.eyes, gx: 0.7, gy: -0.4, sc: 1.1, bo: 0.3 } };
  const close = (a, b) => ['ey', 'ew', 'eh', 'crown', 'hw'].every((k) => Math.abs(a[k] - b[k]) < 1e-9) && a.ex.every((x, i) => Math.abs(x - b.ex[i]) < 1e-9);
  for (const id of ['trait', 'trait-doux', 'trait-contour']) assert.ok(close(faces[id].face.anchors(f, [100, 10, 50]), pixAnchors(f)), id);
  assert.ok(close(faces.chaton.face.anchors(f, [120, -10, 62]), catAnchors(f)), 'chaton');
  for (const id of ['pixel', 'chat-pixel']) assert.ok(close(faces[id].face.anchors(f), (id === 'pixel' ? pixAnchors : catAnchors)(f)), id);
});
