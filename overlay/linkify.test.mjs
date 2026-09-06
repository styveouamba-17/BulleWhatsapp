/* Tests de parseLinks — fonction pure, aucune dépendance DOM.
   Lancer : node --test overlay/linkify.test.mjs */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import './linkify.js';
const { parseLinks } = globalThis;

test('un texte sans URL donne un seul jeton texte', () => {
  assert.deepEqual(parseLinks('bonjour tout le monde'), [
    { type: 'text', value: 'bonjour tout le monde' },
  ]);
});

test('une chaîne vide ou absente donne une liste vide', () => {
  assert.deepEqual(parseLinks(''), []);
  assert.deepEqual(parseLinks(null), []);
  assert.deepEqual(parseLinks(undefined), []);
});

test('une URL seule donne un seul jeton lien', () => {
  assert.deepEqual(parseLinks('https://exemple.com/page'), [
    { type: 'link', value: 'https://exemple.com/page', href: 'https://exemple.com/page' },
  ]);
});

test('le texte avant et après une URL est conservé', () => {
  assert.deepEqual(parseLinks('regarde https://exemple.com stp'), [
    { type: 'text', value: 'regarde ' },
    { type: 'link', value: 'https://exemple.com', href: 'https://exemple.com' },
    { type: 'text', value: ' stp' },
  ]);
});

test('deux URLs dans la même phrase', () => {
  assert.deepEqual(parseLinks('a http://un.fr b https://deux.fr'), [
    { type: 'text', value: 'a ' },
    { type: 'link', value: 'http://un.fr', href: 'http://un.fr' },
    { type: 'text', value: ' b ' },
    { type: 'link', value: 'https://deux.fr', href: 'https://deux.fr' },
  ]);
});

test('la ponctuation finale ne fait pas partie du lien', () => {
  assert.deepEqual(parseLinks('vois https://exemple.com.'), [
    { type: 'text', value: 'vois ' },
    { type: 'link', value: 'https://exemple.com', href: 'https://exemple.com' },
    { type: 'text', value: '.' },
  ]);
});

test('une URL entre parenthèses garde ses parenthèses hors du lien', () => {
  assert.deepEqual(parseLinks('(https://exemple.com)'), [
    { type: 'text', value: '(' },
    { type: 'link', value: 'https://exemple.com', href: 'https://exemple.com' },
    { type: 'text', value: ')' },
  ]);
});

test('seuls http et https sont transformés', () => {
  assert.deepEqual(parseLinks('ftp://exemple.com et www.exemple.com'), [
    { type: 'text', value: 'ftp://exemple.com et www.exemple.com' },
  ]);
});

test('un schéma javascript: n\'est jamais un lien', () => {
  assert.deepEqual(parseLinks('javascript:alert(1)'), [
    { type: 'text', value: 'javascript:alert(1)' },
  ]);
});
