/* ---------------------------------------------------------------
   Bulle — repérage des liens dans le texte d'un message
   Analyseur pur : rend une liste de jetons { type:'text' | 'link' },
   sans toucher au DOM (voir linkify.test.mjs). overlay.js construit les
   nœuds à partir de ces jetons — jamais d'innerHTML.

   Chargé en <script> classique avant overlay.js : pas d'export, la
   fonction est posée sur globalThis pour rester lisible côté navigateur
   comme côté node --test.
   --------------------------------------------------------------- */

(function () {
  // Seuls http(s) : pas de file:, javascript:, data:… Un « mot » d'URL
  // s'arrête au premier blanc.
  const URL_RE = /https?:\/\/[^\s]+/g;

  // Ponctuation qui suit une URL dans une phrase sans en faire partie.
  // Cas limite assumé : une URL qui se termine réellement par l'un de ces
  // caractères (rare) se fait rogner.
  const TRAILING = /[.,;:!?)\]}'"<>»]+$/;

  function parseLinks(text) {
    if (!text) return [];

    const tokens = [];
    let last = 0;
    let m;

    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text)) !== null) {
      const raw = m[0];
      const url = raw.replace(TRAILING, '');
      const dropped = raw.slice(url.length);

      if (m.index > last) {
        tokens.push({ type: 'text', value: text.slice(last, m.index) });
      }
      tokens.push({ type: 'link', value: url, href: url });
      if (dropped) tokens.push({ type: 'text', value: dropped });

      last = m.index + raw.length;
    }

    if (last < text.length) {
      tokens.push({ type: 'text', value: text.slice(last) });
    }
    return tokens;
  }

  globalThis.parseLinks = parseLinks;
})();
