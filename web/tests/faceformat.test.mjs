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
  const b = face({ frame: [100, 10, 50], shapes: [], anchors: { exL: 70, exR: 150, ey: 90, ew: 20, eh: 24, crown: 60, hw: 82 } }).anchors(state(), [200, 10, 50]);
  assert.deepEqual(b.ex, [0.3, 0.7]);
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
