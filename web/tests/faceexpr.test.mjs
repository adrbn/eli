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
  bad(`${'('.repeat(6000)}1${')'.repeat(6000)}`, 'nested deeper than 32');
  bad(`${'-'.repeat(40)}1`, 'nested deeper than 32');
  assert.equal(run(`${'('.repeat(10)}1${')'.repeat(10)}`), 1);
});
