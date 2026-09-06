/* Tests du verrou mono-instance — fonctions pures + une sonde système.
   Lancer : node --test connector/lock.test.mjs */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseLockPid, isProcessAlive, lockDecision } from './lock.js';

test('parseLockPid lit un PID entier', () => {
  assert.equal(parseLockPid('12345'), 12345);
  assert.equal(parseLockPid('  678\n'), 678);
});

test('parseLockPid rejette ce qui n\'est pas un PID valide', () => {
  assert.equal(parseLockPid(''), null);
  assert.equal(parseLockPid('   '), null);
  assert.equal(parseLockPid('abc'), null);
  assert.equal(parseLockPid('0'), null);
  assert.equal(parseLockPid('-4'), null);
  assert.equal(parseLockPid(null), null);
  assert.equal(parseLockPid(undefined), null);
});

test('isProcessAlive est vrai pour le process courant', () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test('isProcessAlive est faux pour un PID libre très improbable', () => {
  // 0x7fffffff : hors de la plage des PID attribués sur Windows comme
  // sur les Unix courants.
  assert.equal(isProcessAlive(2147483647), false);
});

/* ---------------------------------------------------------------
   lockDecision — prend-on le verrou, vu le contenu du fichier ?
   --------------------------------------------------------------- */

const alive = () => true;
const dead = () => false;

test('lockDecision : verrou absent → on prend', () => {
  assert.deepEqual(lockDecision('', { selfPid: 100, isAlive: alive }), {
    acquire: true,
    holder: null,
  });
});

test('lockDecision : verrou périmé (PID mort) → on prend', () => {
  assert.deepEqual(lockDecision('999', { selfPid: 100, isAlive: dead }), {
    acquire: true,
    holder: null,
  });
});

test('lockDecision : verrou tenu par un PID vivant → on ne prend pas', () => {
  assert.deepEqual(lockDecision('999', { selfPid: 100, isAlive: alive }), {
    acquire: false,
    holder: 999,
  });
});

test('lockDecision : verrou à notre propre PID → on prend (relance dans le même process)', () => {
  assert.deepEqual(lockDecision('100', { selfPid: 100, isAlive: alive }), {
    acquire: true,
    holder: null,
  });
});

test('lockDecision : contenu illisible → on prend', () => {
  assert.deepEqual(lockDecision('nawak', { selfPid: 100, isAlive: alive }), {
    acquire: true,
    holder: null,
  });
});
