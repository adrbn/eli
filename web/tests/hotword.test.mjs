import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Segmenter } from '../js/hotword.js';

const RATE = 16000, BLOCK = 1600; // blocs de 0,1 s
const feed = (seg, level, seconds) => {
  for (let i = 0; i < Math.round(seconds * 10); i++) seg.push(new Float32Array(BLOCK).fill(level), level);
};

test('une phrase entre deux silences donne un bout, avec un peu d’avant', () => {
  const out = [];
  const seg = new Segmenter(RATE, (chunks) => out.push(chunks.length * BLOCK / RATE));
  feed(seg, 0.1, 2);
  feed(seg, 0.7, 1.2);
  feed(seg, 0.1, 1);
  assert.equal(out.length, 1);
  assert.ok(out[0] > 1.4 && out[0] < 2.3, `durée ${out[0]}`);
});

test('un claquement trop court est ignoré, une phrase sans fin est coupée', () => {
  const out = [];
  const seg = new Segmenter(RATE, (chunks) => out.push(chunks.length * BLOCK / RATE));
  feed(seg, 0.1, 1);
  feed(seg, 0.7, 0.1);
  feed(seg, 0.1, 1);
  assert.equal(out.length, 0);
  feed(seg, 0.7, 8);
  assert.equal(out.length, 1);
});
