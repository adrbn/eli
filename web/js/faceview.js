import { compileFace, hit } from './faceformat.js';

// The glue between .eliface faces and the displays of themes.js: the grids ask "is this cell lit?", the vector
// display draws the shapes. No DOM at module level, so the tests can import it.

// A display samples the face at (x, y) of its own space: 'wide' (x ∈ [0, 2], y ∈ [0, 1]) for the OLED and LED grids,
// 'square' (u, v ∈ [-1, 1]) for the round matrix. The frame is evaluated once per state object.
export function formatLit(face, display = 'wide') {
  const map = display === face.space ? null
    : display === 'wide' ? (x, y) => [(x - 1) * 2, y * 2 - 1]
      : (u, v) => [1 + u / 2, (v + 1) / 2];
  let state = null, minH = 0, frame = null;
  return (f, x, y, mh) => {
    if (f !== state || mh !== minH) [state, minH, frame] = [f, mh, face.frame(f, mh)];
    if (!map) return frame.on(x, y);
    const [a, b] = map(x, y);
    return frame.on(a, b);
  };
}

export const formatAnchors = (face, fallback, into) => (f) => face.anchors(f, into) ?? fallback(f);

// index.json: theme id → { face, glow? }. Each .eliface file is fetched and compiled once.
export async function loadFaces(base = 'faces/', get = fetch) {
  const res = await get(`${base}index.json`);
  if (!res.ok) throw new Error(`${base}index.json: ${res.status}`);
  const index = await res.json(), files = new Map();
  const compiled = (name) => {
    if (!files.has(name)) {
      files.set(name, get(`${base}${name}.eliface`).then(async (r) => {
        if (!r.ok) throw new Error(`${name}.eliface: ${r.status}`);
        const text = await r.text();
        try { return compileFace(text) } catch (err) { throw new Error(`${name}.eliface: ${err.message}`) }
      }));
    }
    return files.get(name);
  };
  const entries = await Promise.all(Object.entries(index).map(async ([id, { face, ...opts }]) => [id, { face: await compiled(face), ...opts }]));
  return Object.fromEntries(entries);
}

const TAU = 2 * Math.PI;
const VECTOR_MIN_H = 0.0025; // no grid on the vector display: one 220-box unit, for faces that read minH
// A face without frame is written in its space: placed in the 220 box like the extras of vector() (xf).
const UNIT = { wide: [100, 10, 50], square: [100, 110, 110] };
const SAMPLES = 256; // a region has no path: the vector display samples it on a 256-cell-wide grid

function trace(ctx, g) {
  const v = g.v;
  if (g.kind === 'rect') {
    if (v[2] > 0 && v[3] > 0) ctx.roundRect(v[0] - v[2], v[1] - v[3], 2 * v[2], 2 * v[3], Math.max(0, Math.min(g.radius, v[2], v[3])));
  } else if (g.kind === 'ellipse') {
    if (v[2] > 0 && v[3] > 0) ctx.ellipse(v[0], v[1], v[2], v[3], 0, 0, TAU);
  } else if (g.kind === 'segment') {
    ctx.moveTo(v[0], v[1]);
    ctx.lineTo(v[2], v[3]);
  } else if (g.kind === 'triangle') {
    ctx.moveTo(v[0], v[1]);
    ctx.lineTo(v[2], v[3]);
    ctx.lineTo(v[4], v[5]);
    ctx.closePath();
  } else if (g.kind === 'arc') {
    ctx.moveTo(v[0] + v[2] * Math.cos(v[3]), v[1] + v[2] * Math.sin(v[3]));
    ctx.arc(v[0], v[1], v[2], v[3], v[4]);
  }
}

// The face's whole space, in author units: where a region is sampled.
function bounds(face) {
  const [k, ox, oy] = face.xf ?? [1, 0, 0];
  const [x0, y0, w, h] = face.space === 'square' ? [-1, -1, 2, 2] : [0, 0, 2, 1];
  return [k * x0 + ox, k * y0 + oy, k * w, k * h];
}

function sample(ctx, it, face) {
  const [x0, y0, w, h] = bounds(face), c = w / SAMPLES, rows = Math.ceil(h / c);
  for (let j = 0; j < rows; j++) for (let i = 0; i < SAMPLES; i++) {
    const x = x0 + (i + 0.5) * c, y = y0 + (j + 0.5) * c;
    if (hit(it, x, y) && (!it.clip || hit(it.clip, x, y) === it.clip.inside)) ctx.fillRect(x0 + i * c, y0 + j * c, c * 1.02, c * 1.02);
  }
}

function paint(ctx, it, face, ink, glow, s) {
  ctx.save();
  const color = it.cut ? '#000' : it.color ?? ink;
  ctx.globalAlpha = it.dots ? 0.3 : it.level;
  ctx.fillStyle = color;
  ctx.strokeStyle = glow && !it.cut ? '#d2ffe1' : color;
  if (glow && !it.cut) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 12 * s;
  }
  if (it.kind === 'region' || it.clip?.kind === 'region') sample(ctx, it, face);
  else {
    if (it.clip) {
      ctx.beginPath();
      if (!it.clip.inside) ctx.rect(-1e4, -1e4, 2e4, 2e4);
      trace(ctx, it.clip);
      ctx.clip('evenodd');
    }
    ctx.beginPath();
    trace(ctx, it);
    if (it.stroke === null) ctx.fill();
    else {
      ctx.lineWidth = 2 * it.stroke * (glow ? 0.8125 : 1);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// The vector display: the shapes as paths, in list order (the last one on top), in the ink vector() has set.
export function drawFace(face, { glow = false } = {}) {
  return (ctx, f, s) => {
    const ink = ctx.fillStyle, frame = face.frame(f, VECTOR_MIN_H);
    ctx.save();
    if (!face.xf) {
      const [k, ox, oy] = UNIT[face.space];
      ctx.transform(k, 0, 0, k, ox, oy);
    }
    for (const it of frame.items) paint(ctx, it, face, ink, glow, s);
    ctx.restore();
  };
}
