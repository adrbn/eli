# Face format (`.eliface`), web side: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every face of Eli exists as a declarative `.eliface` file that the page can draw instead of the code,
with Pixel, Chat pixel and Matrice giving 0 differing cells against the code.

**Architecture:** `faceexpr.js` compiles formulas to closures; `faceformat.js` compiles a face file and evaluates it
once per frame into items that answer "is this point lit?"; `faceview.js` adapts that to the existing displays
(`oled`, `dots`, `matrice` take a `lit` function, `vector` takes a `draw` function). `themes.js` keeps its code
faces and switches to the files only under `?faces=format`.

**Tech Stack:** plain ES modules, `node --test` (Node ≥ 20), Canvas 2D. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-02-face-format-design.md`. The ESP32 part (spec §3) is a second plan,
written once this one passes.

## Global Constraints

- Public repo: no IPs, personal URLs or personal names in committed files.
- Code and comments in English for new modules; keep the French comments of `themes.js` style when editing it.
- Commits: conventional (`feat:`, `fix:`, `test:`, `docs:`), no attribution lines. Never push.
- Never run `pkill -f server/app.py`; never touch the dev server on port 5280. Browser checks use the launch config
  `eli-test` (port 5281) from the workspace `.claude/launch.json`, volume 0
  (`localStorage['eli.volume'] = '0'`), then stop the server and reset the viewport.
- Without `?faces=format` the page must behave exactly as before.
- A face file is at most 16 KB, 64 shapes after mirroring, 32 vars.
- Parity faces: **0 differing cells**. A flipped cell is fixed in the face file, never with a tolerance.
- Run tests with `node --test web/tests/` from the repo root.

## Files

| File | Role |
| --- | --- |
| `web/js/faceexpr.js` (new) | formula language: tokenize, parse, compile to closures; `box` |
| `web/js/faceformat.js` (new) | `compileFace(text)`, `face.frame(f, minH)`, `face.anchors(f)`, `hit` |
| `web/js/faceview.js` (new) | `formatLit`, `formatAnchors`, `drawFace`, `loadFaces` |
| `web/faces/*.eliface` (new) | pixel, chat-pixel, matrice, trait, trait-doux, trait-contour, chaton |
| `web/faces/index.json` (new) | theme id → `{ face, glow? }` |
| `web/js/themes.js` | test exports, `useFaces`, themes built through `grid` / `marks` / `drawn` |
| `web/js/main.js` | `?faces=format` loads the faces before the first `theme.make()` |
| `web/tests/faceexpr.test.mjs`, `faceformat.test.mjs`, `faceparity.test.mjs`, `faceview.test.mjs` (new) | tests |
| `web/tests/compare.html` (new, not shipped: the app build excludes `tests`) | code and file side by side |
| `README.md` | a short "Faces" section |

---

### Task 1: The formula language

**Files:**
- Create: `web/js/faceexpr.js`
- Test: `web/tests/faceexpr.test.mjs`

**Interfaces:**
- Produces: `compileExpr(src: string | number, names: Set<string>) → (env: object) => number` (throws
  `Error` with a plain message, no path); `box(px, py, bx, by, r) → number` (same arithmetic as `sdBox` in
  `themes.js`). Booleans are `1` / `0`; truthiness follows JS (`0` and `NaN` are false).

- [ ] **Step 1: Write the failing test**

```js
// web/tests/faceexpr.test.mjs
// The formula language of .eliface faces: `node --test web/tests`.
import assert from 'node:assert/strict';
import test from 'node:test';
import { box, compileExpr } from '../js/faceexpr.js';

const run = (src, env = {}) => compileExpr(src, new Set(Object.keys(env)))(env);

test('arithmetic follows JS precedence and associativity', () => {
  assert.equal(run('1 + 2*3'), 7);
  assert.equal(run('(1 + 2)*3'), 9);
  assert.equal(run('-2*3'), -6);
  assert.equal(run('7 - 2 - 1'), 4);
  assert.equal(run('8/4/2'), 1);
  assert.equal(run('.5 + 1e-1'), 0.6);
  assert.equal(run(2.5), 2.5);
});

test('comparisons and logic give 1 or 0, the ternary nests to the right', () => {
  assert.equal(run('1 < 2 && 2 < 1'), 0);
  assert.equal(run('0 || 3'), 1);
  assert.equal(run('!0'), 1);
  assert.equal(run('!2'), 0);
  assert.equal(run('2 >= 2 == 1'), 1);
  assert.equal(run('0 ? 1 : 0 ? 2 : 3'), 3);
});

test('names read the env, functions and pi are built in', () => {
  assert.equal(run('gx*2', { gx: 1.5 }), 3);
  assert.equal(run('clamp(2, 0, 1)'), 1);
  assert.equal(run('mod(-7.5, 7.3)'), -7.5 % 7.3);
  assert.equal(run('sq(-3) + hypot(3, 4) + abs(-1) + floor(1.7) + sqrt(4) + min(1, 2) + max(1, 2)'), 9 + 5 + 1 + 1 + 2 + 1 + 2);
  assert.equal(run('box(0, 0, 1, 1, 0)'), -1);
  assert.equal(run('pi'), Math.PI);
  assert.equal(run('sin(0) + cos(0)'), 1);
});

test('the same arithmetic as JS, bit for bit', () => {
  const env = { y: 0.4173, ey: 0.3311, hh: 0.2047 };
  assert.equal(run('y - (ey - hh)', env), env.y - (env.ey - env.hh));
  assert.equal(run('(y - ey) - 0.04', env), (env.y - env.ey) - 0.04);
  assert.equal(box(0.3, -0.2, 0.2, 0.1, 0.05), (() => {
    const qx = Math.abs(0.3) - 0.2 + 0.05, qy = Math.abs(-0.2) - 0.1 + 0.05;
    return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - 0.05;
  })());
});

test('bad formulas are rejected with a clear message', () => {
  const bad = (src, msg) => assert.throws(() => compileExpr(src, new Set(['gx'])), { message: msg });
  bad('zz + 1', "unknown name 'zz'");
  bad('constructor(1)', "unknown function 'constructor'");
  bad('toString', "unknown name 'toString'");
  bad('clamp(1, 2)', "'clamp' takes 3 arguments");
  bad('1 +', 'unexpected end');
  bad('1 2', "unexpected '2' at 2");
  bad('(1', "expected ')' at the end");
  bad('$', "unexpected '$' at 0");
  bad(null, 'a formula is a string or a number');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test web/tests/faceexpr.test.mjs`
Expected: FAIL, `Cannot find module '…/web/js/faceexpr.js'`.

- [ ] **Step 3: Implement**

```js
// web/js/faceexpr.js
// The formula language of .eliface faces: numbers, names, + - * /, comparisons, && || !, a ternary and a few pure
// functions. A formula compiles once to a closure over an env object and can reach nothing else.

// Signed distance to a rounded box (negative inside): the same arithmetic as sdBox in themes.js.
export function box(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r, qy = Math.abs(py) - by + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

const FUNCS = {
  min: [2, Math.min], max: [2, Math.max], clamp: [3, (v, lo, hi) => Math.min(hi, Math.max(lo, v))],
  abs: [1, Math.abs], floor: [1, Math.floor], mod: [2, (a, b) => a % b], sin: [1, Math.sin], cos: [1, Math.cos],
  hypot: [2, Math.hypot], sqrt: [1, Math.sqrt], sq: [1, (a) => a ** 2], box: [5, box],
};
const CONSTS = { pi: Math.PI };
const BIN = [['||'], ['&&'], ['==', '!='], ['<', '<=', '>', '>='], ['+', '-'], ['*', '/']];
const OPS = {
  '||': (a, b) => (e) => (a(e) || b(e) ? 1 : 0), '&&': (a, b) => (e) => (a(e) && b(e) ? 1 : 0),
  '==': (a, b) => (e) => (a(e) === b(e) ? 1 : 0), '!=': (a, b) => (e) => (a(e) !== b(e) ? 1 : 0),
  '<': (a, b) => (e) => (a(e) < b(e) ? 1 : 0), '<=': (a, b) => (e) => (a(e) <= b(e) ? 1 : 0),
  '>': (a, b) => (e) => (a(e) > b(e) ? 1 : 0), '>=': (a, b) => (e) => (a(e) >= b(e) ? 1 : 0),
  '+': (a, b) => (e) => a(e) + b(e), '-': (a, b) => (e) => a(e) - b(e),
  '*': (a, b) => (e) => a(e) * b(e), '/': (a, b) => (e) => a(e) / b(e),
};
const TOKEN = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)|([A-Za-z_]\w*)|(<=|>=|==|!=|&&|\|\||[-+*/!<>?:(),]))/y;

function tokenize(src) {
  const out = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    const at = TOKEN.lastIndex, m = TOKEN.exec(src);
    if (!m) {
      const rest = src.slice(at);
      if (!rest.trim()) break;
      throw new Error(`unexpected '${rest.trim()[0]}' at ${at + rest.length - rest.trimStart().length}`);
    }
    const pos = TOKEN.lastIndex - m[0].trimStart().length;
    out.push(m[1] !== undefined ? { num: Number(m[1]), at: pos } : m[2] ? { name: m[2], at: pos } : { op: m[3], at: pos });
  }
  return out;
}

export function compileExpr(src, names) {
  if (typeof src === 'number' && Number.isFinite(src)) return () => src;
  if (typeof src !== 'string') throw new Error('a formula is a string or a number');
  const toks = tokenize(src);
  let i = 0;
  const fail = (msg) => { throw new Error(msg) };
  const show = (t) => t.op ?? t.name ?? String(t.num);
  const take = (op) => (toks[i]?.op === op ? (i++, true) : false);
  const expect = (op) => take(op) || fail(toks[i] ? `expected '${op}' at ${toks[i].at}` : `expected '${op}' at the end`);

  const ternary = () => {
    const c = level(0);
    if (!take('?')) return c;
    const a = ternary();
    expect(':');
    const b = ternary();
    return (e) => (c(e) ? a(e) : b(e));
  };
  const level = (k) => {
    if (k === BIN.length) return unary();
    let left = level(k + 1);
    while (BIN[k].includes(toks[i]?.op)) {
      const op = toks[i++].op;
      left = OPS[op](left, level(k + 1));
    }
    return left;
  };
  const unary = () => {
    if (take('-')) { const a = unary(); return (e) => -a(e) }
    if (take('!')) { const a = unary(); return (e) => (a(e) ? 0 : 1) }
    return primary();
  };
  const primary = () => {
    const t = toks[i++] ?? fail('unexpected end');
    if (t.num !== undefined) { const v = t.num; return () => v }
    if (t.op === '(') { const a = ternary(); expect(')'); return a }
    if (!t.name) return fail(`unexpected '${show(t)}' at ${t.at}`);
    if (toks[i]?.op === '(') {
      i++;
      if (!Object.hasOwn(FUNCS, t.name)) fail(`unknown function '${t.name}'`);
      const [arity, fn] = FUNCS[t.name], args = [];
      if (!take(')')) {
        do args.push(ternary()); while (take(','));
        expect(')');
      }
      if (args.length !== arity) fail(`'${t.name}' takes ${arity} argument${arity > 1 ? 's' : ''}`);
      if (arity === 1) { const [a] = args; return (e) => fn(a(e)) }
      if (arity === 2) { const [a, b] = args; return (e) => fn(a(e), b(e)) }
      return (e) => fn(...args.map((a) => a(e)));
    }
    if (Object.hasOwn(CONSTS, t.name)) { const v = CONSTS[t.name]; return () => v }
    if (!names.has(t.name)) fail(`unknown name '${t.name}'`);
    const name = t.name;
    return (e) => e[name];
  };

  const fn = ternary();
  if (i < toks.length) fail(`unexpected '${show(toks[i])}' at ${toks[i].at}`);
  return fn;
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test web/tests/faceexpr.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add web/js/faceexpr.js web/tests/faceexpr.test.mjs
git commit -m "feat: formula language for declarative faces"
```

---

### Task 2: Compile and evaluate a face

**Files:**
- Create: `web/js/faceformat.js`
- Test: `web/tests/faceformat.test.mjs`

**Interfaces:**
- Consumes: `compileExpr`, `box` from `./faceexpr.js`.
- Produces:
  - `compileFace(text: string) → Face`, throwing `Error('shapes[2].rect[1]: unknown name …')`-style messages;
  - `Face = { id, name, space: 'wide' | 'square', xf: [k, ox, oy] | null, frame(f, minH) → Frame, anchors(f) → anchors | null }`;
  - `Frame = { items: Item[], lit(x, y) → Item | null, on(x, y) → boolean }`, `(x, y)` in the face's space;
  - `Item = { kind, v: number[], radius, stroke, cut, dots, color, lum, level, clip, region?, env? }`, where `v` holds the
    evaluated primitive arguments in author units, and `clip = { inside, kind, v, … } | null`;
  - `hit(g, x, y) → boolean`, the inside test of one item or clip, in author units.

- [ ] **Step 1: Write the failing test**

```js
// web/tests/faceformat.test.mjs
// Compiling and evaluating .eliface faces: `node --test web/tests`.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileFace } from '../js/faceformat.js';

const MIN_H = 0.55 / 64;
const state = (eyes = {}, mouth = {}, T = 0) => ({
  T, eyes: { gx: 0, gy: 0, open: 1, hap: 0, sc: 1, bo: 0, ang: 0, ...eyes }, mouth: { o: 0, w: 0, r: 0, t: 0, ...mouth },
});
const face = (body) => compileFace(JSON.stringify({ format: 1, id: 'test', name: 'Test', ...body }));
const frameOf = (body, f = state()) => face(body).frame(f, MIN_H);

test('a filled rect lights its inside only', () => {
  const fr = frameOf({ shapes: [{ rect: [1, 0.5, 0.2, 0.1] }] });
  assert.ok(fr.lit(1, 0.5));
  assert.equal(fr.lit(1.3, 0.5), null);
  assert.equal(fr.on(1, 0.5), true);
});

test('painter rule: the last shape that holds decides, a cut turns off', () => {
  const big = { rect: [1, 0.5, 0.4, 0.4] }, hole = { cut: { rect: [1, 0.5, 0.1, 0.1] } };
  assert.equal(frameOf({ shapes: [big, hole] }).on(1, 0.5), false);
  assert.equal(frameOf({ shapes: [big, hole] }).on(1.3, 0.5), true);
  assert.equal(frameOf({ shapes: [hole, big] }).on(1, 0.5), true);
});

test('mirror emits s = 1 then s = -1, so the s = -1 copy wins', () => {
  const fr = frameOf({ shapes: [{ mirror: true, group: [{ rect: ['1 + s*0.05', 0.5, 0.2, 0.2], level: 's > 0 ? 0.5 : 1' }] }] });
  assert.equal(fr.items.length, 2);
  assert.equal(fr.lit(1, 0.5).level, 1);
});

test('vars run in order with s, when skips a shape', () => {
  const body = { vars: { a: 's*0.5', b: 'a + 1' }, shapes: [{ mirror: true, group: [{ rect: ['b', 0.5, 0.05, 0.05], when: 'hap > 0.5' }] }] };
  assert.equal(frameOf(body).on(1.5, 0.5), false);
  const fr = frameOf(body, state({ hap: 1 }));
  assert.equal(fr.on(1.5, 0.5), true);
  assert.equal(fr.on(0.5, 0.5), true);
});

test('clip inside and outside', () => {
  const disc = { ellipse: [1, 0.5, 0.3, 0.3] }, half = { rect: [1, 0.25, 1, 0.25] };
  assert.equal(frameOf({ shapes: [{ ...disc, clip: { inside: half } }] }).on(1, 0.6), false);
  assert.equal(frameOf({ shapes: [{ ...disc, clip: { inside: half } }] }).on(1, 0.4), true);
  assert.equal(frameOf({ shapes: [{ ...disc, clip: { outside: half } }] }).on(1, 0.6), true);
});

test('dots and level < 0.75 follow the checkerboard on the grid, lit() still reports the shape', () => {
  const cell = (i, j) => [((i + 0.5) / 128) * 2, (j + 0.5) / 64];
  for (const shape of [{ region: '1', dots: true }, { region: '1', level: 0.5 }]) {
    const fr = frameOf({ shapes: [shape] });
    assert.notEqual(fr.on(...cell(10, 10)), fr.on(...cell(11, 10)));
    assert.equal(fr.on(...cell(10, 10)), fr.on(...cell(11, 11)));
  }
  assert.ok(frameOf({ shapes: [{ region: '1', level: 0.5 }] }).lit(...cell(11, 10)));
});

test('a dark color stays off on the grids', () => {
  const fr = frameOf({ shapes: [{ rect: [1, 0.5, 0.2, 0.2], color: '#101010' }] });
  assert.equal(fr.on(1, 0.5), false);
  assert.equal(fr.lit(1, 0.5).color, '#101010');
});

test('segment, triangle, arc and stroked ellipse', () => {
  const fr = (shape) => frameOf({ shapes: [shape] });
  assert.equal(fr({ segment: [0.5, 0.5, 1.5, 0.5], stroke: 0.02 }).on(1, 0.51), true);
  assert.equal(fr({ segment: [0.5, 0.5, 1.5, 0.5], stroke: 0.02 }).on(1, 0.55), false);
  assert.equal(fr({ triangle: [0.9, 0.4, 1.1, 0.4, 1, 0.6] }).on(1, 0.45), true);
  assert.equal(fr({ triangle: [0.9, 0.4, 1.1, 0.4, 1, 0.6] }).on(1, 0.65), false);
  const top = { arc: [1, 0.5, 0.3, '1.1*pi', '1.9*pi'], stroke: 0.02 };
  assert.equal(fr(top).on(1, 0.2), true);
  assert.equal(fr(top).on(1, 0.8), false);
  assert.equal(fr({ ellipse: [1, 0.5, 0.3, 0.2], stroke: 0.01 }).on(1, 0.5), false);
  assert.equal(fr({ ellipse: [1, 0.5, 0.3, 0.2], stroke: 0.01 }).on(1.3, 0.5), true);
});

test('shift moves the sample point, frame maps the wide space to author units', () => {
  assert.equal(frameOf({ shift: [0, 0.1], shapes: [{ rect: [1, 0.5, 0.01, 0.01] }] }).on(1, 0.4), true);
  assert.equal(frameOf({ frame: [100, 0, 0], shapes: [{ rect: [100, 50, 1, 1] }] }).on(1, 0.5), true);
});

test('anchors come back in the wide space', () => {
  const a = face({ frame: [100, 10, 50], shapes: [], anchors: { exL: 70, exR: 150, ey: 90, ew: 20, eh: 24, crown: 60, hw: 82 } }).anchors(state());
  assert.deepEqual(a, { ex: [0.6, 1.4], ey: 0.4, ew: 0.2, eh: 0.24, crown: 0.1, hw: 0.82 });
  assert.equal(face({ shapes: [] }).anchors(state()), null);
});

test('bad faces are rejected with the path of the problem', () => {
  const bad = (body, msg) => assert.throws(() => face(body), { message: msg });
  bad({ shapes: [{ rect: [1, 'zz', 1, 1] }] }, "shapes[0].rect[1]: unknown name 'zz'");
  bad({ shapes: [{ rect: [1, 'x', 1, 1] }] }, "shapes[0].rect[1]: unknown name 'x'");
  bad({ shapes: [{ rect: [1, 1, 1, 1], radious: 1 }] }, "shapes[0]: unknown key 'radious'");
  bad({ shapes: [{ rect: [1, 1, 1, 1], ellipse: [1, 1, 1, 1] }] }, 'shapes[0]: exactly one of rect, ellipse, segment, triangle, arc, region');
  bad({ shapes: [{ segment: [0, 0, 1, 1] }] }, 'shapes[0].stroke: required on a segment');
  bad({ shapes: [{ mirror: true, group: [{ rect: [1, 1, 1] }] }] }, 'shapes[0].group[0].rect: 4 numbers or formulas');
  bad({ shapes: Array.from({ length: 65 }, () => ({ region: '1' })) }, 'at most 64 shapes after mirroring');
  bad({ vars: Object.fromEntries(Array.from({ length: 33 }, (_, k) => [`v${k}`, 1])), shapes: [] }, 'at most 32 vars');
  bad({ vars: { gx: 1 }, shapes: [] }, "vars.gx: the name is taken or invalid");
  bad({ format: 2, shapes: [] }, 'format: must be 1');
  assert.throws(() => compileFace('{'), /^Error: not JSON/);
  assert.throws(() => compileFace(' '.repeat(16385)), { message: 'a face is at most 16 KB' });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test web/tests/faceformat.test.mjs`
Expected: FAIL, `Cannot find module '…/web/js/faceformat.js'`.

- [ ] **Step 3: Implement**

```js
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
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test web/tests/faceformat.test.mjs`
Expected: PASS, 11 tests. If the anchors test fails on float noise (`(90 - 50) / 100`), compare with
`assert.ok(Math.abs(…) < 1e-12)` per field rather than `deepEqual`; do not change the conversion.

- [ ] **Step 5: Commit**

```bash
git add web/js/faceformat.js web/tests/faceformat.test.mjs
git commit -m "feat: compile and evaluate .eliface faces"
```

---

### Task 3: Pixel in the format, 0 differing cells

**Files:**
- Create: `web/js/faceview.js` (only `formatLit` and `formatAnchors` in this task), `web/faces/pixel.eliface`,
  `web/tests/faceparity.test.mjs`
- Modify: `web/js/themes.js` (one export line after the `THEMES` array)

**Interfaces:**
- Consumes: `compileFace` (Task 2).
- Produces: `formatLit(face, display: 'wide' | 'square') → (f, x, y, minH) => boolean` (frame cached per state
  object); `formatAnchors(face, fallback) → (f) => anchors`; test exports `pixLit, catLit, matLit` from `themes.js`.

- [ ] **Step 1: Export the code faces for the tests**

Append after the `THEMES` array in `web/js/themes.js`:

```js
// Les visages en code, pour les tests de parité avec leurs fichiers .eliface.
export { catLit, matLit, pixLit };
```

- [ ] **Step 2: Write the failing parity test**

```js
// web/tests/faceparity.test.mjs
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
```

- [ ] **Step 3: Run it to see it fail**

Run: `node --test web/tests/faceparity.test.mjs`
Expected: FAIL, `Cannot find module '…/web/js/faceview.js'`.

- [ ] **Step 4: Write `faceview.js` (grids only for now)**

```js
// web/js/faceview.js
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

export const formatAnchors = (face, fallback) => (f) => face.anchors(f) ?? fallback(f);
```

- [ ] **Step 5: Write `web/faces/pixel.eliface`**

Each formula repeats the code's arithmetic exactly (`pixLit` in `themes.js`). The eyelid tilt and the smile are
`region`s because a primitive would round differently; the smile is cut only inside the eye's box and outside its
eyelid, like the code's early `continue`s.

```json
{
  "format": 1,
  "id": "pixel",
  "name": "Pixel",
  "author": "adrbn",
  "license": "MIT",
  "space": "wide",
  "vars": {
    "hw": "0.2*sc",
    "hh": "max(0.03, 0.24*sc*open)",
    "er": "min(hw, hh)*0.6",
    "ex": "1 + s*0.4 + gx*0.125",
    "ey": "0.38 + gy*0.1 - bo*0.0625",
    "mw": "0.075 + w*0.09 - r*0.045",
    "mh": "max(minH, 0.022 + o*0.075 + r*0.012)"
  },
  "shapes": [
    { "rect": [1, 0.82, "mw", "mh"], "radius": "min(mw, mh)*(0.7 + r*0.3)" },
    { "cut": { "region": "abs(y - 0.82) < 0.018" }, "when": "t > 0.5 && mh > 0.05" },
    { "mirror": true, "group": [
      { "rect": ["ex", "ey", "hw", "hh"], "radius": "er",
        "clip": { "outside": { "region": "ang && y - (ey - hh) < hh*(ang > 0 ? ang*1.1*clamp((1 - s*(x - ex)/hw)/2, 0, 1) : -ang*0.9*(1 - clamp((1 - s*(x - ex)/hw)/2, 0, 1)))" } } },
      { "cut": { "region": "box(x - ex, y - ey, hw, hh, er) <= 0 && !(ang && y - (ey - hh) < hh*(ang > 0 ? ang*1.1*clamp((1 - s*(x - ex)/hw)/2, 0, 1) : -ang*0.9*(1 - clamp((1 - s*(x - ex)/hw)/2, 0, 1)))) && sq((x - ex)/(1.3*hw)) + sq((y - ey - 1.1*hh)/(1.2*hh*hap)) <= 1" },
        "when": "hap > 0.05" }
    ]}
  ],
  "anchors": {
    "exL": "0.6 + gx*0.125", "exR": "1.4 + gx*0.125", "ey": "0.38 + gy*0.1 - bo*0.0625",
    "ew": "0.2*sc", "eh": "0.24*sc", "crown": "0.38 + gy*0.1 - bo*0.0625 - 0.24*sc - 0.02", "hw": 0.82
  }
}
```

- [ ] **Step 6: Run the parity test**

Run: `node --test web/tests/faceparity.test.mjs`
Expected: PASS, 0 differing cells. If cells differ, read the first diff's state and cell, compute both sides by hand
in a `node -e` one-off, find the formula whose arithmetic differs from `pixLit`, and fix the face file.

- [ ] **Step 7: Run the whole suite and commit**

Run: `node --test web/tests/`
Expected: PASS (all previous tests plus the new ones).

```bash
git add web/js/faceview.js web/js/themes.js web/faces/pixel.eliface web/tests/faceparity.test.mjs
git commit -m "feat: Pixel as an .eliface file, cell for cell"
```

---

### Task 4: Chat pixel in the format, 0 differing cells

**Files:**
- Create: `web/faces/chat-pixel.eliface`
- Modify: `web/tests/faceparity.test.mjs`

**Interfaces:**
- Consumes: `formatLit`, `wideDiffs`, `load` (Task 3).

- [ ] **Step 1: Add the failing test**

Append to `web/tests/faceparity.test.mjs`:

```js
test('chat-pixel.eliface draws exactly catLit', () => {
  const diffs = wideDiffs(catLit, load('chat-pixel'));
  assert.equal(diffs.length, 0, report(diffs));
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test web/tests/faceparity.test.mjs`
Expected: FAIL, `ENOENT … chat-pixel.eliface`.

- [ ] **Step 3: Write `web/faces/chat-pixel.eliface`**

`catLit` tests, in order: head outline, then for s = -1 and s = +1: ears, inner ear (dots), eyes (ring when happy,
else the eye with its pupil), cheek (dots), whiskers; then nose, the two halves of the ω, the open mouth. The list
below is that order reversed (painter's rule), with `shift` for `y = y0 + bo*0.04`.

```json
{
  "format": 1,
  "id": "chat-pixel",
  "name": "Chat pixel",
  "author": "adrbn",
  "license": "MIT",
  "space": "wide",
  "shift": [0, "bo*0.04"],
  "vars": {
    "line": "max(0.017, minH*0.6)",
    "tw": "mod(T + (s > 0 ? 3.1 : 0), 7.3) < 0.18 ? 0.03 : 0",
    "tipx": "1 + s*(0.47 + tw)",
    "tipy": "0.05 + tw",
    "inx": "1 + s*0.16",
    "outx": "1 + s*0.56",
    "ex": "1 + s*0.25 + gx*0.06",
    "ey": "0.55 + gy*0.05",
    "rx": "0.095*sc",
    "ry": "max(0.018, 0.12*sc*open)",
    "px": "ex + clamp(0.5 + gx*0.5, 0, 1)*rx*0.9 - rx*0.45",
    "py": "ey + clamp(0.5 + gy*0.5, 0, 1)*ry*0.7 - ry*0.45",
    "mmw": "0.035 + w*0.03 - r*0.015",
    "mmh": "max(minH, 0.012 + o*0.06)"
  },
  "shapes": [
    { "rect": [1, "0.745 + mmh", "mmw", "mmh"], "radius": "min(mmw, mmh)*0.9", "when": "o > 0.08" },
    { "mirror": true, "group": [
      { "region": "y >= 0.705 && abs(hypot(x - 1 - s*0.035, y - 0.71) - 0.035) < line*0.55" }
    ]},
    { "triangle": [0.97, 0.655, 1.03, 0.655, 1, 0.685] },
    { "mirror": true, "group": [
      { "segment": ["1 + s*0.5", 0.66, "1 + s*0.8", 0.6], "stroke": "line*0.5" },
      { "segment": ["1 + s*0.5", "0.66 + 0.07", "1 + s*0.8", "0.6 + 0.12"], "stroke": "line*0.5" },
      { "region": "sq((x - 1 - s*0.42)/0.08) + sq((y - 0.72)/0.045) <= 1", "dots": true },
      { "ellipse": ["ex", "ey", "rx", "ry"], "when": "!(hap > 0.5)" },
      { "cut": { "region": "hypot(x - px, y - py) < max(0.03, minH*0.75)" }, "when": "!(hap > 0.5) && ry > 0.06",
        "clip": { "inside": { "ellipse": ["ex", "ey", "rx", "ry"] } } },
      { "region": "abs(hypot((x - ex)/rx, (y - ey - 0.04)/(ry*0.9)) - 1) < 0.35 && y < ey + 0.03", "when": "hap > 0.5" },
      { "triangle": ["tipx - s*0.01", "tipy + 0.09", "inx + s*0.07", "0.2 + 0.01", "outx - s*0.04", "0.37 - 0.06"], "dots": true,
        "clip": { "outside": { "region": "hypot((x - 1)/0.6, (y - 0.58)/0.4) <= 1.05" } } },
      { "segment": ["tipx", "tipy", "inx", 0.2], "stroke": "line*0.75",
        "clip": { "outside": { "region": "hypot((x - 1)/0.6, (y - 0.58)/0.4) <= 1" } } },
      { "segment": ["tipx", "tipy", "outx", 0.37], "stroke": "line*0.75",
        "clip": { "outside": { "region": "hypot((x - 1)/0.6, (y - 0.58)/0.4) <= 1" } } }
    ]},
    { "ellipse": [1, 0.58, 0.6, 0.4], "stroke": "line*0.75" }
  ],
  "anchors": {
    "exL": "0.75 + gx*0.06", "exR": "1.25 + gx*0.06", "ey": "0.55 + gy*0.05",
    "ew": "0.12*sc", "eh": "0.12*sc", "crown": "0.2 - bo*0.04", "hw": 0.64
  }
}
```

- [ ] **Step 4: Run the parity test**

Run: `node --test web/tests/faceparity.test.mjs`
Expected: PASS, 0 differing cells for both faces. Same debugging rule as Task 3 if not.

- [ ] **Step 5: Commit**

```bash
git add web/faces/chat-pixel.eliface web/tests/faceparity.test.mjs
git commit -m "feat: Chat pixel as an .eliface file, cell for cell"
```

---

### Task 5: Matrice in the format, 0 differing cells

**Files:**
- Create: `web/faces/matrice.eliface`
- Modify: `web/tests/faceparity.test.mjs`

**Interfaces:**
- Consumes: `formatLit(face, 'square')` (Task 3). `matLit(f, u, v)` ignores `minH`; the matrix passes
  `MAT_MIN_H = 1.1 / 19` (Task 6), so the test does too.

- [ ] **Step 1: Add the failing test**

```js
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test web/tests/faceparity.test.mjs`
Expected: FAIL, `ENOENT … matrice.eliface`.

- [ ] **Step 3: Write `web/faces/matrice.eliface`**

```json
{
  "format": 1,
  "id": "matrice",
  "name": "Matrice",
  "author": "adrbn",
  "license": "MIT",
  "space": "square",
  "vars": {
    "ex": "s*0.37 + gx*0.1",
    "ey": "-0.2 + gy*0.08 - bo*0.09",
    "rx": "0.17*sc",
    "ry": "max(0.04, 0.23*sc*open)",
    "mrx": "0.17 + w*0.17 - r*0.12",
    "mry": "0.05 + o*0.18 + r*0.05"
  },
  "shapes": [
    { "region": "sq(x/mrx) + sq((y - 0.45)/mry) <= 1 && ((t > 0.5 && abs(y - 0.45) < 0.06) || mry < 0.12 || sq(x/(mrx - 0.11)) + sq((y - 0.45)/(mry - 0.11)) > 1)" },
    { "mirror": true, "group": [
      { "ellipse": ["ex", "ey", "rx", "ry"], "when": "!(hap > 0.5)" },
      { "region": "abs(hypot((x - ex)/0.18, (y - ey - 0.1)/0.22) - 1) < 0.38 && y < ey + 0.06", "when": "hap > 0.5" }
    ]}
  ]
}
```

- [ ] **Step 4: Run the parity test**

Run: `node --test web/tests/faceparity.test.mjs`
Expected: PASS, three faces, 0 differing cells.

- [ ] **Step 5: Commit**

```bash
git add web/faces/matrice.eliface web/tests/faceparity.test.mjs
git commit -m "feat: Matrice as an .eliface file, cell for cell"
```

---

### Task 6: The page draws the grid faces from their files under `?faces=format`

**Files:**
- Create: `web/faces/index.json`
- Modify: `web/js/faceview.js` (add `loadFaces`), `web/js/themes.js` (`useFaces`, `grid`, `marks`, `matrice(lit)`,
  the grid entries of `THEMES`), `web/js/main.js` (imports, the switch before `let theme`)
- Test: `web/tests/faceview.test.mjs`

**Interfaces:**
- Consumes: `compileFace`, `formatLit`, `formatAnchors`.
- Produces: `loadFaces(base = 'faces/', get = fetch) → Promise<{ [themeId]: { face: Face, glow?: true } }>`;
  `useFaces(map)` in `themes.js`. Task 7 adds `drawn` for the vector themes.

- [ ] **Step 1: Write `web/faces/index.json`**

```json
{
  "pixel": { "face": "pixel" },
  "blocs": { "face": "pixel" },
  "perles": { "face": "pixel" },
  "perles-fond": { "face": "pixel" },
  "grille": { "face": "pixel" },
  "chat-pixel": { "face": "chat-pixel" },
  "chat-perles": { "face": "chat-pixel" },
  "matrice": { "face": "matrice" }
}
```

- [ ] **Step 2: Write the failing test**

```js
// web/tests/faceview.test.mjs
// Loading the shipped faces and drawing them on the vector display: `node --test web/tests`.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadFaces } from '../js/faceview.js';

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
```

- [ ] **Step 3: Run it to see it fail**

Run: `node --test web/tests/faceview.test.mjs`
Expected: FAIL, `loadFaces` is not exported.

- [ ] **Step 4: Add `loadFaces` to `web/js/faceview.js`**

```js
import { compileFace } from './faceformat.js';

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
```

Put the `import` line at the top of the file.

- [ ] **Step 5: Run it to see it pass**

Run: `node --test web/tests/faceview.test.mjs`
Expected: PASS, 2 tests.

- [ ] **Step 6: Wire the grids in `web/js/themes.js`**

Add the import next to the existing one:

```js
import { formatAnchors, formatLit } from './faceview.js';
```

After `export const setCustom = …`, add:

```js
// ?faces=format : chaque thème dessine son fichier .eliface (web/faces) au lieu du code ci-dessous, gardé comme
// référence. Le choix se fait quand le thème est créé (make), donc useFaces passe avant le premier make.
let FACES = {};
export const useFaces = (faces) => { FACES = faces };
const grid = (id, code, space = 'wide') => (FACES[id] ? formatLit(FACES[id].face, space) : code);
const marks = (id, code) => (FACES[id] ? formatAnchors(FACES[id].face, code) : code);
```

Change `matrice()` to take the lit function and give it a `minH`:

```js
const MAT_MIN_H = 1.1 / 19; // la matrice n'a pas de lignes : une valeur pour les fichiers qui lisent minH

function matrice(lit = matLit) {
```

and inside it replace `matLit(f, -1 + ((i + 0.5) * 2) / N, -1 + ((j + 0.5) * 2) / N)` with
`lit(f, -1 + ((i + 0.5) * 2) / N, -1 + ((j + 0.5) * 2) / N, MAT_MIN_H)`.

Replace the `make` of the grid themes (the other entries stay as they are):

```js
  { id: 'pixel', …, make: () => oled(128, 1, [[0, 0]], grid('pixel', pixLit), marks('pixel', pixAnchors)) },
  { id: 'blocs', …, make: () => oled(42, 3, BLOC, grid('blocs', pixLit), marks('blocs', pixAnchors)) },
  { id: 'perles', …, make: () => oled(32, 4, PLUS, grid('perles', pixLit), marks('perles', pixAnchors)) },
  { id: 'perles-fond', …, make: () => dots(() => ({ cols: 28, shape: 'perle', bg: true }), grid('perles-fond', pixLit), marks('perles-fond', pixAnchors)) },
  { id: 'grille', …, make: () => dots(getCustom, grid('grille', pixLit), marks('grille', pixAnchors)) },
  { id: 'chat-pixel', …, make: () => oled(128, 1, [[0, 0]], grid('chat-pixel', catLit), marks('chat-pixel', catAnchors)) },
  { id: 'chat-perles', …, make: () => dots(() => ({ cols: 52, shape: 'perle', bg: true }), grid('chat-perles', catLit), marks('chat-perles', catAnchors)) },
  { id: 'matrice', …, make: () => matrice(grid('matrice', matLit, 'square')) },
```

(`…` = the entry's existing `name`, `family`, `screen`, `note`, unchanged.)

- [ ] **Step 7: The switch in `web/js/main.js`**

Change the themes import and add the faceview import:

```js
import { THEMES, getCustom, setCustom, setInk, themeById, useFaces } from './themes.js';
import { loadFaces } from './faceview.js';
```

Just above `let theme = themeById(store.get('theme', 'pixel')) || THEMES[0];`:

```js
// ?faces=format : tous les visages viennent de leurs fichiers (web/faces), pour comparer avec le code.
if (params.get('faces') === 'format') {
  try { useFaces(await loadFaces()) } catch (err) { console.error('faces:', err) }
}
```

- [ ] **Step 8: Run the suite**

Run: `node --test web/tests/`
Expected: PASS.

- [ ] **Step 9: Check in the browser**

1. `preview_start` with `{ name: "eli-test" }`, then in the page: `localStorage.setItem('eli.volume', '0')`.
2. Open `http://localhost:5281/?faces=format`. `read_console_messages` with `onlyErrors: true`: no error.
3. For each of `pixel`, `blocs`, `perles`, `perles-fond`, `grille`, `chat-pixel`, `chat-perles`, `matrice`: pick it in
   the Faces pane, take a screenshot. Each shows its face, blinking and moving as without the parameter.
4. Open `http://localhost:5281/` (no parameter): same faces, no error.
5. `preview_stop`, `resize_window` preset `desktop`.

- [ ] **Step 10: Commit**

```bash
git add web/faces/index.json web/js/faceview.js web/js/themes.js web/js/main.js web/tests/faceview.test.mjs
git commit -m "feat: ?faces=format draws the grid themes from their .eliface files"
```

---

### Task 7: The vector display, and the soft faces (Doux, Contour, Néon)

**Files:**
- Modify: `web/js/faceview.js` (add `drawFace`), `web/js/themes.js` (`drawn`, the three soft entries),
  `web/faces/index.json`, `web/tests/faceview.test.mjs`
- Create: `web/faces/trait-doux.eliface`, `web/faces/trait-contour.eliface`, `web/tests/compare.html`

**Interfaces:**
- Consumes: `hit` from `faceformat.js`; `vector(w, h, draw, fade, xf, anchors)` in `themes.js` calls
  `draw(ctx, f, s)` with the 220×220 box transform set and `ctx.fillStyle` = the ink.
- Produces: `drawFace(face, { glow } = {}) → (ctx, f, s) => void`.

- [ ] **Step 1: Write the failing test**

Append to `web/tests/faceview.test.mjs`:

```js
import { compileFace } from '../js/faceformat.js';
import { drawFace } from '../js/faceview.js';

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
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test web/tests/faceview.test.mjs`
Expected: FAIL, `drawFace` is not exported.

- [ ] **Step 3: Add `drawFace` to `web/js/faceview.js`**

Change the import to `import { compileFace, hit } from './faceformat.js';` and add:

```js
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
```

- [ ] **Step 4: Run it to see it pass**

Run: `node --test web/tests/faceview.test.mjs`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the two soft faces**

`web/faces/trait-doux.eliface` (`traitSoft(false, false)`; author units = the 220 box of `vector()`; the frame shows
the box from x −30 to 250 and y 40 to 180 on the grids; the anchors are `pixAnchors` in box units):

```json
{
  "format": 1,
  "id": "trait-doux",
  "name": "Doux",
  "author": "adrbn",
  "license": "MIT",
  "space": "wide",
  "frame": [140, -30, 40],
  "vars": {
    "ex": "110 + s*42 + gx*12",
    "ey": "86 + gy*9 - bo*7",
    "ew": "34*sc",
    "eh": "max(3, 40*sc*open)",
    "mw": "30 + w*30 - r*18",
    "mh": "max(5, 5 + o*26 + r*6)"
  },
  "shapes": [
    { "mirror": true, "group": [
      { "rect": ["ex", "ey", "ew/2", "eh/2"], "radius": "min(ew, eh)*0.42" },
      { "cut": { "ellipse": ["ex", "ey + eh*0.55", "ew*0.68", "eh*0.6*hap"] }, "when": "hap > 0.05" }
    ]},
    { "rect": [110, 152, "mw/2", "mh/2"], "radius": "min(mw, mh)/2" },
    { "cut": { "rect": [110, 152, "mw*0.36", 1.3] }, "when": "t > 0.4 && mh > 10" }
  ],
  "anchors": {
    "exL": "70 + gx*12.5", "exR": "150 + gx*12.5", "ey": "88 + gy*10 - bo*6.25",
    "ew": "20*sc", "eh": "24*sc", "crown": "88 + gy*10 - bo*6.25 - 24*sc - 2", "hw": 82
  }
}
```

`web/faces/trait-contour.eliface` (`traitSoft(true, …)`; Néon is this face with `glow`):

```json
{
  "format": 1,
  "id": "trait-contour",
  "name": "Contour",
  "author": "adrbn",
  "license": "MIT",
  "space": "wide",
  "frame": [140, -30, 40],
  "vars": {
    "ex": "110 + s*42 + gx*12",
    "ey": "86 + gy*9 - bo*7",
    "ew": "34*sc",
    "eh": "max(3, 40*sc*open)",
    "mw": "30 + w*30 - r*18",
    "mh": "max(3, 5 + o*26 + r*6)"
  },
  "shapes": [
    { "mirror": true, "group": [
      { "rect": ["ex", "ey", "ew/2", "eh/2"], "radius": "min(ew, eh)*0.42", "stroke": 1.6, "when": "!(hap > 0.5)" },
      { "arc": ["ex", "ey + 8", "ew*0.5", "1.12*pi", "1.88*pi"], "stroke": 1.6, "when": "hap > 0.5" }
    ]},
    { "rect": [110, 152, "mw/2", "mh/2"], "radius": "min(mw, mh)/2", "stroke": 1.6 },
    { "segment": ["110 - mw*0.32", 152, "110 + mw*0.32", 152], "stroke": 1.6, "when": "t > 0.4 && mh > 10" }
  ],
  "anchors": {
    "exL": "70 + gx*12.5", "exR": "150 + gx*12.5", "ey": "88 + gy*10 - bo*6.25",
    "ew": "20*sc", "eh": "24*sc", "crown": "88 + gy*10 - bo*6.25 - 24*sc - 2", "hw": 82
  }
}
```

Add to `web/faces/index.json`:

```json
  "trait-doux": { "face": "trait-doux" },
  "trait-contour": { "face": "trait-contour" },
  "trait-neon": { "face": "trait-contour", "glow": true },
```

- [ ] **Step 6: Wire the vector themes in `web/js/themes.js`**

Extend the faceview import to `import { drawFace, formatAnchors, formatLit } from './faceview.js';` and add after
`marks`:

```js
// Un visage vectoriel en fichier : ses unités sont celles de la boîte 220×220, et son frame dit où tombent les extras.
const drawn = (id, w, h, code, fade, xf, anchors) => (FACES[id]
  ? vector(220, 220, drawFace(FACES[id].face, FACES[id]), 0, FACES[id].face.xf ?? [100, 10, 50], formatAnchors(FACES[id].face, anchors ?? pixAnchors))
  : vector(w, h, code, fade, xf, anchors));
```

and the three entries:

```js
  { id: 'trait-doux', …, make: () => drawn('trait-doux', 220, 220, traitSoft(false, false)) },
  { id: 'trait-contour', …, make: () => drawn('trait-contour', 220, 220, traitSoft(true, false)) },
  { id: 'trait-neon', …, make: () => drawn('trait-neon', 220, 220, traitSoft(true, true)) },
```

- [ ] **Step 7: The side-by-side page `web/tests/compare.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Faces: code and file</title>
<style>
  body { margin: 0; padding: 16px; background: #050605; color: #9aa59a; font: 13px ui-monospace, monospace; }
  .row { display: grid; grid-template-columns: 120px 1fr 1fr; gap: 12px; align-items: center; margin-bottom: 12px; }
  canvas { width: 100%; aspect-ratio: 2; background: #000; }
</style>
</head>
<body>
<p>Left: the code face. Right: its .eliface file. Same state, driven by time.</p>
<div id="rows"></div>
<script type="module">
  import { THEMES, useFaces } from '../js/themes.js';
  import { loadFaces } from '../js/faceview.js';

  const faces = await loadFaces('../faces/');
  const ids = Object.keys(faces);
  const code = ids.map((id) => THEMES.find((t) => t.id === id).make());
  useFaces(faces);
  const file = ids.map((id) => THEMES.find((t) => t.id === id).make());
  const canvases = ids.map((id) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.append(Object.assign(document.createElement('span'), { textContent: id }));
    const pair = [0, 1].map(() => row.appendChild(Object.assign(document.createElement('canvas'), { width: 480, height: 240 })));
    document.getElementById('rows').append(row);
    return pair;
  });
  const wave = (T, k) => Math.sin(T * k);
  let last = performance.now();
  const frame = (now) => {
    const T = now / 1000, dt = (now - last) / 1000;
    last = now;
    const f = {
      T, notes: [], look: null,
      eyes: { gx: wave(T, 0.7), gy: 0.6 * wave(T, 0.5), open: Math.abs(wave(T, 0.4)) < 0.05 ? 0.1 : 1, hap: Math.max(0, wave(T, 0.23)),
        sc: 1 + 0.08 * wave(T, 0.9), bo: 0.5 * wave(T, 1.3), ang: Math.max(-1, Math.min(1, 1.5 * wave(T, 0.17))) },
      mouth: { o: (wave(T, 3) + 1) / 2, w: (wave(T, 0.6) + 1) / 2, r: (wave(T, 0.35) + 1) / 2, t: wave(T, 0.8) > 0.3 ? 1 : 0 },
    };
    canvases.forEach(([a, b], k) => {
      code[k](a.getContext('2d'), a.width, a.height, f, dt);
      file[k](b.getContext('2d'), b.width, b.height, f, dt);
    });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
</script>
</body>
</html>
```

- [ ] **Step 8: Check by eye**

1. `node --test web/tests/` → PASS.
2. `preview_start` `{ name: "eli-test" }`, open `http://localhost:5281/tests/compare.html`. No console error.
3. Screenshot. Grid rows: identical pairs. `trait-doux`, `trait-contour`, `trait-neon`: same eyes, smile cut, mouth
   and teeth, same glow; the extras (none in this page) aside, nothing visibly different.
4. Open `http://localhost:5281/?faces=format`, pick Doux, Contour and Néon: they render; no console error.
5. `preview_stop`, `resize_window` preset `desktop`.

- [ ] **Step 9: Commit**

```bash
git add web/js/faceview.js web/js/themes.js web/faces web/tests/faceview.test.mjs web/tests/compare.html
git commit -m "feat: vector display for .eliface faces, Doux, Contour and Néon as files"
```

---

### Task 8: Trait and Chaton as files

**Files:**
- Create: `web/faces/trait.eliface`, `web/faces/chaton.eliface`
- Modify: `web/faces/index.json`, `web/js/themes.js` (two entries)

**Interfaces:**
- Consumes: `drawn` (Task 7).

- [ ] **Step 1: Write `web/faces/trait.eliface`**

The code's Bézier lips become two half ellipses (the spec accepts the difference): the upper lip's height is the
curve's peak, `1.05*up - 2.25` (at least 0.6), the lower one `2.25 + 0.975*dn`. Each is clipped to its half.

```json
{
  "format": 1,
  "id": "trait",
  "name": "Trait",
  "author": "adrbn",
  "license": "MIT",
  "space": "wide",
  "frame": [140, -30, 40],
  "vars": {
    "ex": "110 + s*40 + gx*12",
    "ey": "88 + gy*9 - bo*7",
    "er": "12*sc",
    "hw": "25 + w*14 - r*14",
    "up": "o*7 + r*5",
    "dn": "o*22 + r*8"
  },
  "shapes": [
    { "mirror": true, "group": [
      { "ellipse": ["ex", "ey", "er", "max(1.6, er*open)"], "when": "!(hap > 0.5)" },
      { "arc": ["ex", "ey + 6", "er", "1.1*pi", "1.9*pi"], "stroke": 1.75, "when": "hap > 0.5" }
    ]},
    { "ellipse": [110, 148, "hw", "max(0.6, up*1.05 - 2.25)"], "stroke": 1.75, "clip": { "inside": { "rect": [110, 98, 80, 50] } } },
    { "ellipse": [110, 148, "hw", "2.25 + dn*0.975"], "stroke": 1.75, "clip": { "inside": { "rect": [110, 198, 80, 50] } } },
    { "segment": ["110 - hw*0.5", "150 - up*0.4", "110 + hw*0.5", "150 - up*0.4"], "stroke": 1.75, "level": "min(1, t)", "when": "t > 0.3" }
  ],
  "anchors": {
    "exL": "70 + gx*12.5", "exR": "150 + gx*12.5", "ey": "88 + gy*10 - bo*6.25",
    "ew": "20*sc", "eh": "24*sc", "crown": "88 + gy*10 - bo*6.25 - 24*sc - 2", "hw": 82
  }
}
```

- [ ] **Step 2: Write `web/faces/chaton.eliface`**

`kitten` in shapes; the quadratic mouth becomes the lower half of an ellipse. The frame `[150, -40, 36]` keeps the
chin (y 186) on the grids; the anchors are `catAnchors` placed by the old `xf` `[120, -10, 62]`, in box units.

```json
{
  "format": 1,
  "id": "chaton",
  "name": "Chaton",
  "author": "adrbn",
  "license": "MIT",
  "space": "wide",
  "frame": [150, -40, 36],
  "vars": {
    "cy": "128 - bo*6",
    "tw": "mod(T + (s > 0 ? 3.1 : 0), 7.3) < 0.18 ? 5 : 0",
    "ex": "110 + s*30 + gx*8",
    "ey": "cy + gy*6",
    "rx": "11*sc",
    "ry": "max(2, 14*sc*open)",
    "mw": "6 + w*5 - r*3",
    "mh": "2 + o*15"
  },
  "shapes": [
    { "ellipse": [110, "cy", 80, 58], "stroke": 1.6 },
    { "mirror": true, "group": [
      { "segment": ["110 + s*72", "cy - 24", "110 + s*(62 + tw)", "cy - 84 + tw"], "stroke": 1.6 },
      { "segment": ["110 + s*(62 + tw)", "cy - 84 + tw", "110 + s*22", "cy - 55"], "stroke": 1.6 },
      { "triangle": ["110 + s*63", "cy - 36", "110 + s*(60 + tw)", "cy - 70 + tw", "110 + s*36", "cy - 52"], "level": 0.3 },
      { "ellipse": ["110 + s*50", "cy + 18", 12, 7], "level": 0.3 },
      { "ellipse": ["ex", "ey", "rx", "ry"], "when": "!(hap > 0.5)" },
      { "cut": { "ellipse": ["ex + clamp(gx, -1, 1)*4.5", "ey - ry*0.15 + clamp(gy, -1, 1)*5", 4.2, 4.2] }, "when": "!(hap > 0.5) && ry > 7" },
      { "arc": ["ex", "ey + 6", "rx", "1.15*pi", "1.85*pi"], "stroke": 1.6, "when": "hap > 0.5" },
      { "segment": ["110 + s*62", "cy + 10", "110 + s*100", "cy + 2"], "stroke": 1 },
      { "segment": ["110 + s*62", "cy + 19", "110 + s*100", "cy + 18"], "stroke": 1 }
    ]},
    { "rect": [110, "cy + 16", 5, 3], "radius": 3 },
    { "arc": [104.5, "cy + 22", 5.5, 0.15, "pi - 0.1"], "stroke": 1.2 },
    { "arc": [115.5, "cy + 22", 5.5, 0.1, "pi - 0.15"], "stroke": 1.2 },
    { "ellipse": [110, "cy + 28", "mw", "mh"], "when": "o > 0.08",
      "clip": { "inside": { "rect": [110, "cy + 28 + mh/2", "mw + 2", "mh/2"] } } }
  ],
  "anchors": {
    "exL": "80 + gx*7.2", "exR": "140 + gx*7.2", "ey": "128 + gy*6",
    "ew": "14.4*sc", "eh": "14.4*sc", "crown": "86 - bo*4.8", "hw": 76.8
  }
}
```

- [ ] **Step 3: index.json and themes.js**

Add to `web/faces/index.json`:

```json
  "trait": { "face": "trait" },
  "chaton": { "face": "chaton" }
```

In `web/js/themes.js`:

```js
  { id: 'trait', …, make: () => drawn('trait', 220, 220, traitClassic) },
  { id: 'chaton', …, make: () => drawn('chaton', 220, 220, kitten, 0, [120, -10, 62], catAnchors) },
```

- [ ] **Step 4: Tests and a look**

1. `node --test web/tests/` → PASS (`faceview` loads every face of `index.json`).
2. `preview_start` `{ name: "eli-test" }`, `http://localhost:5281/tests/compare.html`, screenshot the `trait` and
   `chaton` rows. Expected: same eyes, ears, cheeks, whiskers, ω; lips and the kitten's mouth slightly different in
   shape (half ellipses), same size and motion. Then `?faces=format` with Trait and Chaton, and with an outfit on
   (the Looks pane): the outfit sits on the eyes and head as without the parameter.
3. `preview_stop`, `resize_window` preset `desktop`.

- [ ] **Step 5: Commit**

```bash
git add web/faces web/js/themes.js
git commit -m "feat: Trait and Chaton as .eliface files"
```

---

### Task 9: Document the format

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Faces" section to `README.md`**

Place it after the section that lists the themes (find it with `grep -n "Pixel" README.md`):

```markdown
### Faces as files

Every face also exists as a small JSON file in `web/faces/` (`.eliface`): shapes whose sizes and positions are
formulas of Eli's state (gaze, blink, smile, mouth). Open the page with `?faces=format` to draw every theme from
its file instead of its code; `web/tests/compare.html` shows both side by side. Pixel, Chat pixel and Matrice match
their code cell for cell (`node --test web/tests`). The format is described in
`docs/superpowers/specs/2026-10-02-face-format-design.md`.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: faces as .eliface files in the README"
```

---

## After this plan

- Second plan: the ESP32 side (spec §3): `faceformat.{h,cpp}`, `POST /face`, the server push, host check ≤ 4 pixels
  per frame against this JS evaluator.
- Then the gallery and `.elimod`, then the visual editor.
