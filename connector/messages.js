/* ---------------------------------------------------------------
   Bulle — analyse d'un message WhatsApp
   Fonctions pures, sans dépendance réseau ni Baileys live, isolées ici
   pour être testables (voir messages.test.mjs). index.js les câble au
   flux réel.

   Un message WhatsApp a une dizaine de formes. On ne traite que celles
   qui portent du texte ou un média affichable dans une bulle de
   réponse rapide : le reste (réaction, appel, accusé) est ignoré en
   amont.
   --------------------------------------------------------------- */

/** Enveloppes qui encapsulent un vrai message sous une clé `.message`.
    `viewOnce*` : photo/vidéo/vocal à usage unique. `ephemeralMessage` :
    fil en messages éphémères — enveloppe *tous* les messages du fil, donc
    sans ce déballage un fil éphémère est entièrement muet côté Bulle. */
const WRAPPERS = [
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'ephemeralMessage',
];

/** Pèle récursivement les enveloppes (ephemeral + viewOnce peuvent
    s'imbriquer) et renvoie le contenu réel. `null` si rien. */
export function unwrapMessage(message) {
  let content = message ?? null;
  // Garde de profondeur : une enveloppe malformée qui se référencerait
  // elle-même ne doit pas boucler.
  for (let depth = 0; depth < 8 && content; depth++) {
    const key = WRAPPERS.find((k) => content[k]?.message);
    if (!key) break;
    content = content[key].message;
  }
  return content;
}

/** Le contenu doit-il être signalé « vue unique » à l'overlay — vrai même
    si l'enveloppe viewOnce est nichée dans une enveloppe ephemeral. */
export function isViewOnce(message) {
  let content = message ?? null;
  for (let depth = 0; depth < 8 && content; depth++) {
    if (content.viewOnceMessage || content.viewOnceMessageV2 || content.viewOnceMessageV2Extension) {
      return true;
    }
    if (!content.ephemeralMessage?.message) return false;
    content = content.ephemeralMessage.message;
  }
  return false;
}

/** Texte du message, ou `null`. Attend un contenu déjà déballé
    (voir unwrapMessage). */
export function extractText(content) {
  if (!content) return null;
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    null
  );
}

const MEDIA_KINDS = [
  ['imageMessage', 'image', 'image/jpeg'],
  ['videoMessage', 'video', 'video/mp4'],
  ['stickerMessage', 'sticker', 'image/webp'],
  ['audioMessage', 'audio', 'audio/ogg'],
];

/** Métadonnées du média porté par le contenu, ou `null`. Le mimetype est
    laissé brut (l'audio Baileys contient un espace : "audio/ogg;
    codecs=opus") — c'est downloadMedia qui le nettoie avant la data URL. */
export function mediaFor(content) {
  if (!content) return null;
  for (const [key, kind, fallbackMime] of MEDIA_KINDS) {
    if (content[key]) return { kind, mime: content[key].mimetype || fallbackMime };
  }
  return null;
}

/** Deux JID désignent-ils le même compte, en ignorant le suffixe
    `:device` que le multi-appareils accole (`221…:12@s.whatsapp.net`) ?
    Le domaine doit correspondre — un numéro et un LID de mêmes chiffres
    ne sont pas le même compte. Sert uniquement à reconnaître un accusé
    de lecture qu'on a émis soi-même depuis un autre appareil ; ne jamais
    s'en servir pour reconstruire l'identité d'un fil (voir CLAUDE.md). */
export function sameUser(a, b) {
  if (!a || !b) return false;
  const strip = (s) => String(s).replace(/:\d+(?=@)/, '');
  return strip(a) === strip(b);
}
