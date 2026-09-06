/* Tests des fonctions pures d'analyse de message — aucun réseau, aucun
   Baileys live. Lancer : node --test connector/ */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { unwrapMessage, isViewOnce, extractText, mediaFor, sameUser } from './messages.js';

/* ---------------------------------------------------------------
   unwrapMessage — pèle les couches viewOnce* / ephemeral
   --------------------------------------------------------------- */

test('unwrapMessage rend un message simple tel quel', () => {
  const m = { conversation: 'salut' };
  assert.equal(unwrapMessage(m), m);
});

test('unwrapMessage pèle une enveloppe viewOnceMessageV2', () => {
  const inner = { imageMessage: { mimetype: 'image/jpeg' } };
  assert.equal(unwrapMessage({ viewOnceMessageV2: { message: inner } }), inner);
});

test('unwrapMessage pèle une enveloppe viewOnceMessage héritée', () => {
  const inner = { imageMessage: {} };
  assert.equal(unwrapMessage({ viewOnceMessage: { message: inner } }), inner);
});

test('unwrapMessage pèle une enveloppe viewOnceMessageV2Extension', () => {
  const inner = { audioMessage: {} };
  assert.equal(unwrapMessage({ viewOnceMessageV2Extension: { message: inner } }), inner);
});

test('unwrapMessage pèle une enveloppe ephemeralMessage', () => {
  const inner = { extendedTextMessage: { text: 'coucou' } };
  assert.equal(unwrapMessage({ ephemeralMessage: { message: inner } }), inner);
});

test('unwrapMessage pèle des enveloppes imbriquées ephemeral + viewOnce', () => {
  const inner = { imageMessage: {} };
  const nested = { ephemeralMessage: { message: { viewOnceMessageV2: { message: inner } } } };
  assert.equal(unwrapMessage(nested), inner);
});

test('unwrapMessage renvoie null pour un message absent', () => {
  assert.equal(unwrapMessage(null), null);
  assert.equal(unwrapMessage(undefined), null);
});

/* ---------------------------------------------------------------
   isViewOnce — le contenu doit-il être signalé « vue unique »
   --------------------------------------------------------------- */

test('isViewOnce détecte une enveloppe vue unique directe', () => {
  assert.equal(isViewOnce({ viewOnceMessageV2: { message: {} } }), true);
});

test('isViewOnce détecte une vue unique nichée dans une enveloppe ephemeral', () => {
  assert.equal(
    isViewOnce({ ephemeralMessage: { message: { viewOnceMessage: { message: {} } } } }),
    true
  );
});

test('isViewOnce est faux pour un message simple ou seulement ephemeral', () => {
  assert.equal(isViewOnce({ conversation: 'hi' }), false);
  assert.equal(isViewOnce({ ephemeralMessage: { message: { conversation: 'hi' } } }), false);
  assert.equal(isViewOnce(null), false);
});

/* ---------------------------------------------------------------
   extractText — travaille sur le contenu déjà déballé
   --------------------------------------------------------------- */

test('extractText lit une conversation simple', () => {
  assert.equal(extractText({ conversation: 'salut' }), 'salut');
});

test('extractText lit un extendedTextMessage', () => {
  assert.equal(extractText({ extendedTextMessage: { text: 'lien https://x' } }), 'lien https://x');
});

test('extractText lit une légende d\'image', () => {
  assert.equal(extractText({ imageMessage: { caption: 'regarde' } }), 'regarde');
});

test('extractText lit une légende de vidéo', () => {
  assert.equal(extractText({ videoMessage: { caption: 'clip' } }), 'clip');
});

test('extractText renvoie null sans texte', () => {
  assert.equal(extractText({ imageMessage: {} }), null);
  assert.equal(extractText(null), null);
});

/* ---------------------------------------------------------------
   mediaFor — travaille sur le contenu déjà déballé
   --------------------------------------------------------------- */

test('mediaFor reconnaît une image', () => {
  assert.deepEqual(mediaFor({ imageMessage: { mimetype: 'image/png' } }), {
    kind: 'image',
    mime: 'image/png',
  });
});

test('mediaFor reconnaît un sticker', () => {
  assert.deepEqual(mediaFor({ stickerMessage: { mimetype: 'image/webp' } }), {
    kind: 'sticker',
    mime: 'image/webp',
  });
});

test('mediaFor reconnaît un audio et garde le mimetype brut (espace inclus)', () => {
  assert.deepEqual(mediaFor({ audioMessage: { mimetype: 'audio/ogg; codecs=opus' } }), {
    kind: 'audio',
    mime: 'audio/ogg; codecs=opus',
  });
});

test('mediaFor reconnaît une vidéo', () => {
  assert.deepEqual(mediaFor({ videoMessage: { mimetype: 'video/mp4' } }), {
    kind: 'video',
    mime: 'video/mp4',
  });
});

test('mediaFor retombe sur un mimetype par défaut selon le type', () => {
  assert.equal(mediaFor({ imageMessage: {} }).mime, 'image/jpeg');
  assert.equal(mediaFor({ videoMessage: {} }).mime, 'video/mp4');
  assert.equal(mediaFor({ audioMessage: {} }).mime, 'audio/ogg');
  assert.equal(mediaFor({ stickerMessage: {} }).mime, 'image/webp');
});

test('mediaFor renvoie null sans média', () => {
  assert.equal(mediaFor({ conversation: 'x' }), null);
  assert.equal(mediaFor(null), null);
});

/* ---------------------------------------------------------------
   sameUser — deux JID désignent-ils le même compte (suffixe :device
   ignoré). Sert à reconnaître un accusé de lecture émis par soi-même
   depuis un autre appareil.
   --------------------------------------------------------------- */

test('sameUser ignore le suffixe :device', () => {
  assert.equal(
    sameUser('221777777:12@s.whatsapp.net', '221777777@s.whatsapp.net'),
    true
  );
  assert.equal(
    sameUser('221777777:3@s.whatsapp.net', '221777777:9@s.whatsapp.net'),
    true
  );
});

test('sameUser distingue deux comptes différents', () => {
  assert.equal(
    sameUser('221777777@s.whatsapp.net', '221888888@s.whatsapp.net'),
    false
  );
});

test('sameUser ne confond pas un numéro et un LID de mêmes chiffres', () => {
  assert.equal(sameUser('221777777@s.whatsapp.net', '221777777@lid'), false);
});

test('sameUser est faux si un JID manque', () => {
  assert.equal(sameUser(null, '221777777@s.whatsapp.net'), false);
  assert.equal(sameUser('221777777@s.whatsapp.net', undefined), false);
});
