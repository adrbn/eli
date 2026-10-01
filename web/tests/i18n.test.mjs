// Vérifs de la traduction : `node --test web/tests`.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { EN, pickLang, setLang, t } from '../js/i18n.js';
import { LOOKS } from '../js/looks.js';
import { THEMES } from '../js/themes.js';

const js = new URL('../js/', import.meta.url);

test('t : anglais, repli sur le français, variables', () => {
  setLang('en');
  assert.equal(t('Prêt'), 'Ready');
  assert.equal(t('pas dans le dico'), 'pas dans le dico');
  assert.equal(t('Je télécharge « {q} »…', { q: 'jazz' }), 'Downloading “jazz”…');
  assert.equal(t('inconnu {x} {y}', { x: 1 }), 'inconnu 1 {y}');
  setLang('fr');
  assert.equal(t('Prêt'), 'Prêt');
  assert.equal(t('Je cherche « {q} »…', { q: 'jazz' }), 'Je cherche « jazz »…');
});

test('pickLang : français si le navigateur est en français, anglais sinon', () => {
  assert.equal(pickLang({ nav: 'fr-FR' }), 'fr');
  assert.equal(pickLang({ nav: 'fr' }), 'fr');
  assert.equal(pickLang({ nav: 'en-US' }), 'en');
  assert.equal(pickLang({ nav: 'de-DE' }), 'en');
  assert.equal(pickLang({ nav: 'it' }), 'en');
  assert.equal(pickLang({}), 'en');
  assert.equal(pickLang({ nav: 'de-DE', saved: 'fr' }), 'fr', 'le choix des Réglages passe devant');
  assert.equal(pickLang({ nav: 'fr-FR', server: 'en' }), 'en', 'ELI_LANG passe devant le navigateur');
  assert.equal(pickLang({ nav: 'fr-FR', server: 'auto' }), 'fr', '« auto » laisse décider le navigateur');
  assert.equal(pickLang({ nav: 'de', server: 'fr', saved: 'en' }), 'en', 'les Réglages passent devant le serveur');
  assert.equal(pickLang({ nav: 'fr', server: 'fr', saved: 'fr', query: 'en' }), 'en', '?lang= passe devant tout');
  assert.equal(pickLang({ nav: 'fr', saved: 'auto', query: 'xx' }), 'fr');
});

test('chaque t(\'…\') des sources a sa traduction anglaise', () => {
  const missing = [];
  for (const f of readdirSync(js).filter((n) => n.endsWith('.js') && n !== 'i18n.js')) {
    for (const [, key] of readFileSync(new URL(f, js), 'utf8').matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) {
      if (!(key in EN)) missing.push(`${f}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('visages et tenues : noms et notes traduits', () => {
  const same = new Set(['Pixel', 'Tropical', 'Rock', 'Rap', 'Jazz', 'Country', 'Chill', 'Pop']);
  const words = [...THEMES.flatMap((x) => [x.name, x.note, x.family]), ...Object.values(LOOKS).map((l) => l.name)];
  assert.deepEqual(words.filter((w) => !(w in EN) && !same.has(w)), []);
});

test('aucune traduction anglaise ne retombe sur une autre clé française (translateDom marche dans les deux sens)', () => {
  const clash = Object.entries(EN).filter(([fr, en]) => en !== fr && en in EN);
  assert.deepEqual(clash, []);
  assert.equal(new Set(Object.values(EN)).size, Object.keys(EN).length, 'deux clés, une même traduction');
});
