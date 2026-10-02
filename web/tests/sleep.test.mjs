// L'heure de réveil d'un sommeil commandé (« va dormir », « réveille-moi à 7 h ») : `node --test web/tests`.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_SLEEP_H, wakeTime } from '../js/sleep.js';

const at = (h, m = 0) => new Date(2026, 9, 2, h, m); // 2 oct. 2026, heure locale

test('sans heure : 8 h au plus', () => {
  assert.equal(wakeTime('', at(23)), at(23).getTime() + MAX_SLEEP_H * 3600e3);
  assert.equal(wakeTime('n’importe quoi', at(23)), at(23).getTime() + MAX_SLEEP_H * 3600e3);
});

test('une heure : la prochaine fois qu’elle sonne', () => {
  assert.equal(wakeTime('7h30', at(23)), new Date(2026, 9, 3, 7, 30).getTime(), 'demain matin');
  assert.equal(wakeTime('7:30', at(23)), new Date(2026, 9, 3, 7, 30).getTime());
  assert.equal(wakeTime('7h', at(23)), new Date(2026, 9, 3, 7, 0).getTime());
  assert.equal(wakeTime('14h', at(13)), at(14).getTime(), 'plus tard aujourd’hui');
  assert.equal(wakeTime('25h', at(23)), at(23).getTime() + MAX_SLEEP_H * 3600e3, 'heure impossible : défaut');
});

test('un délai en minutes', () => {
  assert.equal(wakeTime('+20', at(13)), at(13, 20).getTime());
  assert.equal(wakeTime('+99999', at(13)), at(13).getTime() + 24 * 3600e3, 'jamais plus d’un jour');
});
