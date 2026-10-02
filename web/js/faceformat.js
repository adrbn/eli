// web/js/faceformat.js
// .eliface faces: compile the JSON once, evaluate it once per frame, then test points. Pure: no DOM.
// Painter's rule: shapes are tested from the last to the first, and the first that holds decides the point.
import { box, compileExpr } from './faceexpr.js';

const MAX_BYTES = 16384, MAX_SHAPES = 64, MAX_VARS = 32, TAU = 2 * Math.PI;
const STATE = ['gx', 'gy', 'open', 'hap', 'sc', 'bo', 'ang', 'w', 'o', 'r', 't', 'T', 'minH', 'rows', 's'];
const ANCHORS = ['exL', 'exR', 'ey', 'ew', 'eh', 'crown', 'hw'];
const PRIMS = { rect: 4, ellipse: 4, segment: 4, triangle: 6, arc: 5 };
const GEOMETRY_KEYS = ['rect', 'ellipse', 'segment', 'triangle', 'arc', 'region', 'radius', 'stroke'];
const SHAPE_KEYS = [...GEOMETRY_KEYS, 'when', 'clip', 'dots', 'color', 'level'];

const clamp01 = (v) => Math.min(1, Math.max(0, v));
// The same arithmetic as segDist and inTri in themes.js.
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, k = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(px - ax - k * dx, py - ay - k * dy);
}
function inTri(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by), d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy), d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
const luminance = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).reduce((sum, c, k) => sum + c * [0.2126, 0.7152, 0.0722][k], 0);

const at = (path, fn) => {
  try { return fn() } catch (err) { throw new Error(`${path}: ${err.message}`) }
};
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Is (x, y), in author units, inside this evaluated item or clip?
export function hit(g, x, y) {
  const v = g.v;
  switch (g.kind) {
    case 'rect': {
      const d = box(x - v[0], y - v[1], v[2], v[3], g.radius);
      return g.stroke === null ? d <= 0 : Math.abs(d) < g.stroke;
    }
    case 'ellipse':
      if (g.stroke === null) return ((x - v[0]) / v[2]) ** 2 + ((y - v[1]) / v[3]) ** 2 <= 1;
      return Math.abs(Math.hypot((x - v[0]) / v[2], (y - v[1]) / v[3]) - 1) * Math.min(v[2], v[3]) < g.stroke;
    case 'segment': return segDist(x, y, v[0], v[1], v[2], v[3]) < g.stroke;
    case 'triangle': return inTri(x, y, v[0], v[1], v[2], v[3], v[4], v[5]);
    case 'arc': {
      if (!(Math.abs(Math.hypot(x - v[0], y - v[1]) - v[2]) < g.stroke)) return false;
      const a = Math.atan2(y - v[1], x - v[0]);
      return v[3] + ((((a - v[3]) % TAU) + TAU) % TAU) <= v[4];
    }
    default:
      g.env.x = x; // ponytail: the frame's env is reused per point, a fresh object per pixel would cost 8192 allocations a frame
      g.env.y = y;
      return Boolean(g.region(g.env));
  }
}

export function compileFace(text) {
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('a face is at most 16 KB');
  let doc;
  try { doc = JSON.parse(text) } catch (err) { throw new Error(`not JSON: ${err.message}`) }
  if (!isObject(doc)) throw new Error('a face is a JSON object');
  if (doc.format !== 1) throw new Error('format: must be 1');
  if (typeof doc.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(doc.id)) throw new Error('id: 1 to 40 characters among a-z, 0-9 and -');
  const space = doc.space ?? 'wide';
  if (space !== 'wide' && space !== 'square') throw new Error("space: 'wide' or 'square'");
  const xf = doc.frame ?? null;
  if (xf !== null && !(Array.isArray(xf) && xf.length === 3 && xf.every((n) => Number.isFinite(n)) && xf[0] > 0)) throw new Error('frame: [k, ox, oy], numbers, k > 0');

  const names = new Set(STATE);
  if (doc.vars !== undefined && !isObject(doc.vars)) throw new Error('vars: an object');
  const varList = Object.entries(doc.vars ?? {});
  if (varList.length > MAX_VARS) throw new Error('at most 32 vars');
  const vars = varList.map(([name, src]) => {
    if (!/^[A-Za-z_]\w*$/.test(name) || names.has(name) || ['x', 'y', 'pi'].includes(name)) throw new Error(`vars.${name}: the name is taken or invalid`);
    const fn = at(`vars.${name}`, () => compileExpr(src, names));
    names.add(name);
    return [name, fn];
  });
  const regionNames = new Set([...names, 'x', 'y']);
  const formula = (path, src) => at(path, () => compileExpr(src, names));

  if (doc.shift !== undefined && !(Array.isArray(doc.shift) && doc.shift.length === 2)) throw new Error('shift: [fx, fy]');
  const shift = doc.shift?.map((src, k) => formula(`shift[${k}]`, src)) ?? null;

  const geometry = (obj, path, allowed) => {
    if (!isObject(obj)) throw new Error(`${path}: a shape is an object`);
    const extra = Object.keys(obj).find((k) => !allowed.includes(k));
    if (extra) throw new Error(`${path}: unknown key '${extra}'`);
    const kinds = Object.keys(obj).filter((k) => Object.hasOwn(PRIMS, k) || k === 'region');
    if (kinds.length !== 1) throw new Error(`${path}: exactly one of rect, ellipse, segment, triangle, arc, region`);
    const kind = kinds[0];
    if (obj.radius !== undefined && kind !== 'rect') throw new Error(`${path}.radius: only on a rect`);
    if (obj.stroke !== undefined && !['rect', 'ellipse', 'segment', 'arc'].includes(kind)) throw new Error(`${path}.stroke: not on a ${kind}`);
    if ((kind === 'segment' || kind === 'arc') && obj.stroke === undefined) throw new Error(`${path}.stroke: required on a ${kind}`);
    if (kind === 'region') return { kind, args: [], radius: null, stroke: null, region: at(`${path}.region`, () => compileExpr(obj.region, regionNames)) };
    const args = obj[kind];
    if (!Array.isArray(args) || args.length !== PRIMS[kind]) throw new Error(`${path}.${kind}: ${PRIMS[kind]} numbers or formulas`);
    return {
      kind, region: null,
      args: args.map((src, k) => formula(`${path}.${kind}[${k}]`, src)),
      radius: obj.radius === undefined ? null : formula(`${path}.radius`, obj.radius),
      stroke: obj.stroke === undefined ? null : formula(`${path}.stroke`, obj.stroke),
    };
  };

  const shape = (raw, path) => {
    if (!isObject(raw)) throw new Error(`${path}: a shape is an object`);
    const { cut, ...rest } = raw;
    if (cut !== undefined && !isObject(cut)) throw new Error(`${path}.cut: a shape`);
    const obj = cut ? { ...cut, ...rest } : rest; // { "cut": { "ellipse": [...] }, "when": ... }
    const g = geometry(obj, path, SHAPE_KEYS);
    if (obj.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(obj.color)) throw new Error(`${path}.color: #rrggbb`);
    let clip = null;
    if (obj.clip !== undefined) {
      const side = isObject(obj.clip) && (obj.clip.inside ? 'inside' : obj.clip.outside ? 'outside' : null);
      if (!side) throw new Error(`${path}.clip: { "inside": shape } or { "outside": shape }`);
      clip = { inside: side === 'inside', ...geometry(obj.clip[side], `${path}.clip.${side}`, GEOMETRY_KEYS) };
    }
    return {
      ...g, clip, cut: cut !== undefined, dots: obj.dots === true, color: obj.color ?? null, lum: obj.color ? luminance(obj.color) : 1,
      level: obj.level === undefined ? null : formula(`${path}.level`, obj.level),
      when: obj.when === undefined ? null : formula(`${path}.when`, obj.when),
    };
  };

  if (!Array.isArray(doc.shapes)) throw new Error('shapes: an array');
  const shapes = doc.shapes.flatMap((item, i) => {
    if (isObject(item) && item.mirror === true) {
      if (!Array.isArray(item.group)) throw new Error(`shapes[${i}].group: an array`);
      const group = item.group.map((g, j) => shape(g, `shapes[${i}].group[${j}]`));
      return [...group.map((g) => ({ ...g, s: 1 })), ...group.map((g) => ({ ...g, s: -1 }))];
    }
    return [{ ...shape(item, `shapes[${i}]`), s: 1 }];
  });
  if (shapes.length > MAX_SHAPES) throw new Error('at most 64 shapes after mirroring');

  if (doc.anchors !== undefined && !isObject(doc.anchors)) throw new Error('anchors: an object');
  const anchors = doc.anchors === undefined ? null : Object.fromEntries(ANCHORS.map((k) => {
    if (doc.anchors[k] === undefined) throw new Error(`anchors.${k}: missing`);
    return [k, formula(`anchors.${k}`, doc.anchors[k])];
  }));

  const envOf = (f, minH, s) => {
    const { gx, gy, open, hap, sc, bo, ang = 0 } = f.eyes, m = f.mouth;
    const env = { gx, gy, open, hap, sc, bo, ang, w: m.w, o: m.o, r: m.r, t: m.t, T: f.T ?? 0, minH, rows: Math.round(0.55 / minH), s, x: 0, y: 0 };
    for (const [name, fn] of vars) env[name] = fn(env);
    return env;
  };
  const evaluate = (g, env) => ({
    kind: g.kind, region: g.region, env, v: g.args.map((a) => a(env)),
    radius: g.radius ? g.radius(env) : 0, stroke: g.stroke ? g.stroke(env) : null,
  });

  function frame(f, minH) {
    const envs = { 1: envOf(f, minH, 1), [-1]: envOf(f, minH, -1) }, base = envs[1];
    const items = [];
    for (const sh of shapes) {
      const env = envs[sh.s];
      if (sh.when && !sh.when(env)) continue;
      items.push({
        ...evaluate(sh, env), cut: sh.cut, dots: sh.dots, color: sh.color, lum: sh.lum,
        level: sh.level ? sh.level(env) : 1, clip: sh.clip && { inside: sh.clip.inside, ...evaluate(sh.clip, env) },
      });
    }
    const sx = shift ? shift[0](base) : 0, sy = shift ? shift[1](base) : 0, rows = base.rows;
    const checker = (x, y) => (Math.floor((x / 2) * rows * 2) + Math.floor(y * rows)) % 2 === 0;
    const pick = (X, Y, mono) => {
      let x = X, y = Y;
      if (xf) { x = xf[0] * X + xf[1]; y = xf[0] * Y + xf[2] }
      if (shift) { x += sx; y += sy }
      for (let k = items.length - 1; k >= 0; k--) {
        const it = items[k];
        if (!hit(it, x, y) || (it.clip && hit(it.clip, x, y) !== it.clip.inside)) continue;
        if (it.cut || (it.dots && !checker(x, y))) return null;
        if (mono && (it.lum <= 0.2 || (it.level < 0.75 && !checker(x, y)))) return null;
        return it;
      }
      return null;
    };
    return { items, lit: (x, y) => pick(x, y, false), on: (x, y) => pick(x, y, true) !== null };
  }

  return {
    id: doc.id, name: typeof doc.name === 'string' ? doc.name : doc.id, space, xf, frame,
    // The anchors are written in author units; looks.js wants them in the wide space.
    anchors(f, minH = 0.55 / 64) {
      if (!anchors || space === 'square') return null;
      const env = envOf(f, minH, 1), a = Object.fromEntries(ANCHORS.map((k) => [k, anchors[k](env)]));
      const [k, ox, oy] = xf ?? [1, 0, 0];
      return { ex: [(a.exL - ox) / k, (a.exR - ox) / k], ey: (a.ey - oy) / k, ew: a.ew / k, eh: a.eh / k, crown: (a.crown - oy) / k, hw: a.hw / k };
    },
  };
}
