// Les réactions au-dessus du visage : `node --test web/tests`.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Notes } from '../js/looks.js';

const run = (fx, mood, seconds) => {
  let list = [];
  for (let t = 0; t < seconds; t += 0.05) list = fx.update(0.05, false, 0, mood);
  return list;
};

test('[amour] fait monter des cœurs, deux au plus à la fois', () => {
  const fx = new Notes();
  const first = fx.update(0.05, false, 0, 'amour');
  assert.equal(first.filter((n) => n.kind === 'heart').length, 1);
  const y0 = first[0].y;
  const later = run(fx, 'amour', 6);
  const hearts = later.filter((n) => n.kind === 'heart');
  assert.ok(hearts.length >= 1 && hearts.length <= 2);
  assert.ok(Math.min(...hearts.map((h) => h.y)) < y0, 'ils montent');
});

test('[surprise] allume un « ! » une seule fois, qui ne bouge pas puis s’en va', () => {
  const fx = new Notes();
  const [bang] = fx.update(0.05, false, 0, 'surprise').filter((n) => n.kind === 'bang');
  assert.ok(bang);
  const { x, y } = bang;
  const still = run(fx, 'surprise', 0.5).filter((n) => n.kind === 'bang');
  assert.equal(still.length, 1);
  assert.deepEqual([still[0].x, still[0].y], [x, y]);
  assert.equal(run(fx, 'surprise', 2).length, 0);
});

test('sans émotion ni chant, rien', () => {
  assert.equal(run(new Notes(), null, 3).length, 0);
});
