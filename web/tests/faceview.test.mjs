// Loading the shipped faces and drawing them on the vector display: `node --test 'web/tests/*.test.mjs'`.
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
