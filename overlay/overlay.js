/* ---------------------------------------------------------------
   Bulle — logique de l'overlay
   Sans connecteur, le fichier tourne seul dans un navigateur en mode
   aperçu. Avec le connecteur, il bascule automatiquement sur le vrai
   flux WhatsApp. Aucune bascule manuelle à faire.

   Enveloppé dans une IIFE gardée : sous Tauri (WebView2), la page peut
   être réinjectée dans le même contexte JS sans le rechargement complet
   qu'un navigateur ferait, ce qui provoquerait sinon une collision
   « already been declared » sur les const/let de premier niveau.
   --------------------------------------------------------------- */

if (window.__overlayJsRan) {
  // Deuxième exécution dans le même contexte : ne rien refaire.
} else {
window.__overlayJsRan = true;

// Secours pour l'aperçu navigateur uniquement : sous Tauri, le port et
// le jeton réels sont découverts dynamiquement (voir connect()) — le
// connecteur n'écoute plus sur un port fixe.
const DEFAULT_WS_URL = 'ws://127.0.0.1:8787';
const DORMANT_AFTER = 12000;   // retour au repos si l'utilisateur n'a rien fait

const el = {
  dock:        document.getElementById('dock'),
  bubble:      document.getElementById('bubble'),
  bubbleAvatar:document.getElementById('bubbleAvatar'),
  badge:       document.getElementById('bubbleBadge'),
  panel:       document.getElementById('panel'),
  panelAvatar: document.getElementById('panelAvatar'),
  name:        document.getElementById('panelName'),
  meta:        document.getElementById('panelMeta'),
  muteThread:  document.getElementById('panelMute'),
  qr:          document.getElementById('panelQr'),
  media:       document.getElementById('panelMedia'),
  msg:         document.getElementById('panelMsg'),
  msgToggle:   document.getElementById('panelMsgToggle'),
  more:        document.getElementById('panelMore'),
  previous:    document.getElementById('panelPrevious'),
  readNote:    document.getElementById('panelReadNote'),
  reply:       document.getElementById('reply'),
  emojiToggle: document.getElementById('emojiToggle'),
  emojiPicker: document.getElementById('emojiPicker'),
  input:       document.getElementById('replyInput'),
  send:        document.getElementById('replySend'),
  status:      document.getElementById('panelStatus'),
  devbar:      document.getElementById('devbar'),
  devDot:      document.getElementById('devDot'),
  devLabel:    document.getElementById('devLabel'),
  devFire:     document.getElementById('devFire'),
  ctxmenu:     document.getElementById('ctxmenu'),
  ctxMute:     document.getElementById('ctxMute'),
  ctxAutostart:document.getElementById('ctxAutostart'),
  ctxMutedList:document.getElementById('ctxMutedList'),
  senders:     document.getElementById('senders'),
  peek:        document.getElementById('peek'),
  peekAvatar:  document.getElementById('peekAvatar'),
  peekName:    document.getElementById('peekName'),
  peekText:    document.getElementById('peekText'),
};

/** File des messages non lus, du plus ancien au plus récent. */
let queue = [];

/** Fils signalés « lus sur un autre appareil » pendant qu'on a le
    panneau ouvert dessus : on ne coupe pas ce qu'on lit ou tape, la
    file n'est purgée qu'à la fermeture du panneau. */
let pendingReadJids = new Set();

/** Dernier fil auquel on a répondu depuis Bulle — sert à ignorer l'écho
    'read' que notre propre envoi provoque (voir readElsewhere). */
let lastReply = { jid: null, at: 0 };
let socket = null;
let dormantTimer = null;

/** Fil actuellement affiché dans le panneau — pas forcément le dernier
    arrivé : on peut choisir à qui répondre parmi ceux qui attendent. */
let selectedJid = null;

/** État du connecteur : 'ok' | 'down' (WS injoignable) | 'expired' (session
    WhatsApp révoquée) | 'pairing' (QR à scanner). */
let connectorState = 'ok';

/** Dernier QR reçu (data URL PNG), tant qu'il n'a pas été scanné. */
let pairingQr = null;

function setConnectorState(state) {
  connectorState = state;
  el.dock.dataset.connector = state;
}

const isTauri = Boolean(window.__TAURI__);
if (isTauri) document.body.classList.add('is-tauri');

/* ---------------------------------------------------------------
   Ne pas déranger : la bulle continue de recevoir et de compter,
   mais sans rebond ni anneau. Préférence locale, pas un état de
   conversation — au même titre que la position mémorisée.
   --------------------------------------------------------------- */

let muted = false;
try { muted = localStorage.getItem('bulle.muted') === '1'; } catch {}

function applyMuted() {
  el.dock.dataset.muted = muted ? '1' : '0';
  el.ctxMute.setAttribute('aria-checked', String(muted));
}
applyMuted();

/* ---------------------------------------------------------------
   Sourdine par fil — pour un groupe précis, contrairement au « Ne pas
   déranger » ci-dessus qui coupe tout. Un fil en sourdine ne rentre
   jamais dans la file : pas de badge, pas de rebond, pas de trace.
   Fil -> dernier nom connu, pour pouvoir l'identifier dans le menu de
   désourdine (voir renderMutedMenu) sans jamais garder l'historique
   des messages eux-mêmes.
   --------------------------------------------------------------- */

let mutedJids = new Map();
try {
  const saved = JSON.parse(localStorage.getItem('bulle.mutedJids') || '[]');
  for (const { jid, name } of saved) mutedJids.set(jid, name);
} catch {}

function persistMutedJids() {
  try {
    localStorage.setItem(
      'bulle.mutedJids',
      JSON.stringify([...mutedJids].map(([jid, name]) => ({ jid, name })))
    );
  } catch {}
}

function isJidMuted(jid) {
  return mutedJids.has(jid);
}

function setJidMuted(jid, name, on) {
  if (on) mutedJids.set(jid, name || mutedJids.get(jid) || 'Inconnu');
  else mutedJids.delete(jid);
  persistMutedJids();
}

/* ---------------------------------------------------------------
   Avatar de repli : initiales sur fond coloré, généré localement.
   Évite une dépendance réseau pour un élément affiché en permanence.
   --------------------------------------------------------------- */

function fallbackAvatar(name) {
  const initials = (name || '?')
    .split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">
       <rect width="96" height="96" fill="hsl(${hue} 42% 38%)"/>
       <text x="48" y="61" font-family="Segoe UI,sans-serif" font-size="38"
             font-weight="600" fill="#fff" text-anchor="middle">${initials}</text>
     </svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function avatarFor(m) {
  return m.avatar || fallbackAvatar(m.from);
}

/* ---------------------------------------------------------------
   Rendu
   --------------------------------------------------------------- */

function setState(state) {
  el.dock.dataset.state = state;
  el.bubble.setAttribute('aria-expanded', String(state === 'open'));
}

function render() {
  const latest = queue[queue.length - 1];

  if (!latest) {
    el.badge.hidden = true;
    el.bubbleAvatar.src = fallbackAvatar('');
    el.bubbleAvatar.alt = '';
    return;
  }

  el.badge.hidden = false;
  el.badge.textContent = queue.length > 9 ? '9+' : String(queue.length);
  el.bubbleAvatar.src = avatarFor(latest);
  el.bubbleAvatar.alt = latest.from;
  el.bubble.setAttribute('aria-label', `${queue.length} message(s), dernier de ${latest.from}`);
}

/* ---------------------------------------------------------------
   Qui attend — choisir à qui répondre parmi plusieurs expéditeurs en
   attente, sans que ça devienne une boîte de réception : pas de
   recherche, pas de tri, plafonné à quelques avatars. La pile
   s'efface dès qu'on répond ou qu'on ferme.
   --------------------------------------------------------------- */

const SENDERS_VISIBLE = 4;

/** Un message par expéditeur distinct — le plus récent de chaque fil,
    du plus récent au plus ancien. */
function distinctSenders() {
  const seen = new Map();
  for (let i = queue.length - 1; i >= 0; i--) {
    const m = queue[i];
    if (!seen.has(m.jid)) seen.set(m.jid, m);
  }
  return [...seen.values()];
}

function renderSendersStrip() {
  const senders = distinctSenders();

  if (senders.length < 2) {
    el.senders.hidden = true;
    el.senders.replaceChildren();
    return;
  }

  el.senders.hidden = false;
  el.senders.replaceChildren();

  senders.slice(0, SENDERS_VISIBLE).forEach((m) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'senders__item';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-pressed', String(m.jid === selectedJid));
    btn.setAttribute('aria-label', m.from);
    btn.title = m.from;

    const img = document.createElement('img');
    img.src = avatarFor(m);
    img.alt = '';
    btn.appendChild(img);

    btn.addEventListener('click', () => selectThread(m.jid));
    el.senders.appendChild(btn);
  });

  const overflow = senders.length - SENDERS_VISIBLE;
  if (overflow > 0) {
    const chip = document.createElement('span');
    chip.className = 'senders__more';
    chip.textContent = '+' + overflow;
    chip.title = `${overflow} autre(s) en attente`;
    el.senders.appendChild(chip);
  }
}

/* ---------------------------------------------------------------
   Média et liens dans le panneau
   Bulle n'a pas de stockage : un média vit dans la file en RAM et
   disparaît avec elle. Le voir en grand ou ouvrir un lien est une
   affaire du système, pas de la bulle — on délègue à Rust (visionneuse
   / navigateur par défaut), jamais dans la WebView.
   --------------------------------------------------------------- */

function buildMediaNode(media) {
  if (media.kind === 'audio') {
    const audio = document.createElement('audio');
    audio.className = 'panel__audio';
    audio.controls = true;
    audio.src = media.dataUrl;
    audio.setAttribute('aria-label', 'Message audio');
    return audio;
  }

  if (media.kind === 'video') {
    const video = document.createElement('video');
    video.className = 'panel__media-video';
    video.controls = true;
    video.preload = 'metadata';
    video.src = media.dataUrl;
    return video;   // le plein écran natif de <video> suffit
  }

  const image = document.createElement('img');
  image.className = 'panel__media-image';
  image.src = media.dataUrl;
  image.alt = media.kind === 'sticker' ? 'Sticker reçu' : 'Image reçue';

  // Sticker : petit par nature, pas d'agrandissement. Image : cliquable
  // pour l'ouvrir en grand dans la visionneuse du système.
  if (media.kind === 'sticker') return image;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'panel__media-open';
  btn.title = 'Ouvrir en grand';
  btn.setAttribute('aria-label', 'Ouvrir l’image en grand');
  btn.appendChild(image);
  btn.addEventListener('click', () => openMediaFull(media));
  return btn;
}

function buildMedia(media) {
  const node = buildMediaNode(media);
  if (!media.viewOnce) return node;

  // La photo est déjà consommée sur le téléphone : on la montre mais on
  // le signale.
  const wrap = document.createElement('div');
  wrap.className = 'panel__media-wrap';
  const tag = document.createElement('span');
  tag.className = 'panel__media-tag';
  tag.textContent = 'Vue unique';
  wrap.append(node, tag);
  return wrap;
}

function openMediaFull(media) {
  if (isTauri) {
    window.__TAURI__.core.invoke('open_media', { dataUrl: media.dataUrl, kind: media.kind })
      .catch(() => {});
  } else {
    window.open(media.dataUrl, '_blank', 'noopener');
  }
}

function openUrl(url) {
  if (!/^https?:\/\//i.test(url)) return;   // http(s) seulement, jamais file:/javascript:
  if (isTauri) {
    window.__TAURI__.core.invoke('open_url', { url }).catch(() => {});
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

/** Verse le texte du message dans `target`, liens http(s) rendus
    cliquables. Construit des nœuds (voir linkify.js) — jamais d'innerHTML. */
function renderMessageText(target, m) {
  const fallback = m.media?.kind === 'audio' ? 'Message audio'
    : m.media?.kind === 'video' ? 'Vidéo reçue'
    : m.media ? 'Image reçue'
    : 'Message reçu';
  const text = m.text || fallback;

  target.replaceChildren();
  const tokens = typeof parseLinks === 'function'
    ? parseLinks(text)
    : [{ type: 'text', value: text }];

  for (const tok of tokens) {
    if (tok.type === 'link') {
      const a = document.createElement('a');
      a.className = 'panel__link';
      a.textContent = tok.value;
      a.href = tok.href;
      a.title = tok.href;
      a.addEventListener('click', (e) => { e.preventDefault(); openUrl(tok.href); });
      target.appendChild(a);
    } else {
      target.appendChild(document.createTextNode(tok.value));
    }
  }
}

/** Affiche le dernier message du fil choisi — pas forcément le plus
    récent tous expéditeurs confondus. */
function renderThreadContent() {
  const latest = [...queue].reverse().find(m => m.jid === selectedJid);
  if (!latest) return;

  el.qr.hidden = true;
  el.qr.removeAttribute('src');
  el.media.replaceChildren();
  el.media.hidden = !latest.media;
  if (latest.media) el.media.appendChild(buildMedia(latest.media));
  el.reply.hidden = false;
  el.muteThread.hidden = false;
  updateMuteButton();
  el.panelAvatar.src = avatarFor(latest);
  el.panelAvatar.alt = '';
  el.name.textContent = latest.from;
  el.meta.textContent = timeLabel(latest.at);
  renderMessageText(el.msg, latest);

  // Le texte long reste replié à 3 lignes par défaut — repart replié à
  // chaque rendu, pas d'état qui traîne d'un message à l'autre.
  el.msg.classList.remove('is-expanded');
  el.msgToggle.textContent = 'Voir plus';
  el.msgToggle.hidden = el.msg.scrollHeight <= el.msg.clientHeight + 1;

  // Les autres messages du même fil restent signalés sans être empilés :
  // le panneau montre le dernier de ce fil par défaut, pas une boîte de
  // réception. Un clic sur le compteur révèle au plus les 2 précédents
  // (donc 3 au total avec celui du dessus) — jamais plus, jamais tout
  // l'historique.
  const thread = queue.filter(m => m.jid === latest.jid);
  const others = thread.length - 1;
  el.more.hidden = others < 1;
  el.more.textContent = (others === 1
    ? '1 autre message dans cette conversation'
    : `${others} autres messages dans cette conversation`) + '  ▾';
  el.previous.hidden = true;
  el.previous.replaceChildren();
  for (const m of thread.slice(-3, -1)) {
    const row = document.createElement('div');
    row.className = 'panel__previous-item';
    const from = document.createElement('b');
    from.textContent = m.from;
    const text = document.createElement('span');
    text.textContent = peekPreviewText(m);
    row.append(from, text);
    el.previous.appendChild(row);
  }

  el.readNote.hidden = !pendingReadJids.has(selectedJid);

  hideEmojiPicker();
}

function updateMuteButton() {
  const on = Boolean(selectedJid) && isJidMuted(selectedJid);
  el.muteThread.setAttribute('aria-pressed', String(on));
  const label = on ? 'Réactiver les notifications de ce fil' : 'Mettre ce fil en sourdine';
  el.muteThread.setAttribute('aria-label', label);
  el.muteThread.title = label;
}

function selectThread(jid) {
  selectedJid = jid;
  renderThreadContent();
  renderSendersStrip();
  syncHitRegion();
}

/** `jid` cible un fil précis (ex: clic sur l'aperçu éclair) ; sans lui,
    ouvre sur le tout dernier message reçu, tous fils confondus. */
function openPanel(jid) {
  hidePeek();
  const latest = jid
    ? [...queue].reverse().find(m => m.jid === jid)
    : queue[queue.length - 1];

  if (!latest) {
    if (connectorState === 'ok') return;   // rien en attente, rien à signaler
    showConnectorPanel();
    return;
  }

  selectedJid = latest.jid;
  renderThreadContent();
  renderSendersStrip();

  clearStatus();
  setState('open');
  clearTimeout(dormantTimer);
  requestAnimationFrame(() => el.input.focus());
  syncHitRegion();
}

/** Panneau affiché à la place d'un message quand il n'y a rien en
    attente mais que le connecteur ne va pas bien — la bulle grise
    doit pouvoir s'expliquer d'un clic, sans qu'on ait besoin d'aller
    chercher un terminal. */
function showConnectorPanel() {
  el.senders.hidden = true;
  el.panelAvatar.src = fallbackAvatar('');
  el.panelAvatar.alt = '';
  el.name.textContent = 'Bienvenue dans Bulle';
  el.meta.textContent = 'Première connexion';
  el.more.hidden = true;
  el.reply.hidden = true;
  el.muteThread.hidden = true;
  el.readNote.hidden = true;
  el.media.replaceChildren();
  el.media.hidden = true;

  if (connectorState === 'pairing' && pairingQr) {
    el.qr.src = pairingQr;
    el.qr.hidden = false;
    el.msg.textContent = 'Scannez ce code avec WhatsApp : Réglages > Appareils liés > Lier un appareil.';
  } else {
    el.qr.hidden = true;
    el.msg.textContent = connectorState === 'down'
      ? 'Préparation de la connexion WhatsApp… Le code QR apparaîtra ici dans quelques secondes.'
      : connectorState === 'expired'
        ? 'Session WhatsApp expirée. Relancez le connecteur et scannez un nouveau QR code.'
        : 'Connexion à WhatsApp en cours…';
  }

  clearStatus();
  setState('open');
  clearTimeout(dormantTimer);
  syncHitRegion();
}

function closePanel({ consume = false } = {}) {
  if (consume && selectedJid) {
    queue = queue.filter(m => m.jid !== selectedJid);
  }
  // Fils marqués « lus ailleurs » pendant qu'on avait le panneau ouvert :
  // la purge différée se fait maintenant.
  if (pendingReadJids.size) {
    queue = queue.filter(m => !pendingReadJids.has(m.jid));
    pendingReadJids.clear();
  }
  el.readNote.hidden = true;
  selectedJid = null;
  el.input.value = '';
  el.send.disabled = true;
  hideEmojiPicker();
  render();
  setState(queue.length ? 'idle' : 'dormant');
  scheduleDormant();
  syncHitRegion();
}

function scheduleDormant() {
  clearTimeout(dormantTimer);
  if (!queue.length) return;
  dormantTimer = setTimeout(() => {
    if (el.dock.dataset.state !== 'open') setState('dormant');
  }, DORMANT_AFTER);
}

function timeLabel(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* ---------------------------------------------------------------
   Aperçu éclair — s'entrouvre à l'arrivée d'un message quand le
   panneau n'est pas déjà ouvert, se rétracte seul. Toujours le
   dernier message reçu : un nouveau message remplace le précédent et
   relance le délai plutôt que de s'empiler.
   --------------------------------------------------------------- */

const PEEK_DURATION = 6000;
let peekJid = null;
let peekTimer = null;
let peekRemaining = 0;
let peekStartedAt = 0;

function peekPreviewText(m) {
  if (m.text) return m.text;
  if (m.media?.kind === 'audio') return 'Message audio';
  if (m.media?.kind === 'sticker') return 'Sticker';
  if (m.media) return 'Photo';
  return 'Message reçu';
}

function restartPeekTimer(duration) {
  clearTimeout(peekTimer);
  peekRemaining = duration;
  peekStartedAt = Date.now();
  peekTimer = setTimeout(hidePeek, duration);
}

function showPeek(m) {
  if (el.dock.dataset.state === 'open') return;   // le panneau montre déjà tout

  peekJid = m.jid;
  el.peekAvatar.src = avatarFor(m);
  el.peekAvatar.alt = '';
  el.peekName.textContent = m.from;
  el.peekText.textContent = peekPreviewText(m);

  el.dock.dataset.peek = '1';
  syncHitRegion();
  restartPeekTimer(PEEK_DURATION);

  // Un nouveau message pendant qu'on lit déjà l'aperçu (survol en cours) ne
  // doit pas se remettre à décompter sous le curseur.
  if (el.peek.matches(':hover')) {
    clearTimeout(peekTimer);
    peekTimer = null;
  }
}

function hidePeek() {
  if (el.dock.dataset.peek !== '1') return;
  clearTimeout(peekTimer);
  peekTimer = null;
  peekJid = null;
  delete el.dock.dataset.peek;
  syncHitRegion();
}

el.peek.addEventListener('mouseenter', () => {
  if (!peekTimer) return;
  clearTimeout(peekTimer);
  peekTimer = null;
  peekRemaining -= Date.now() - peekStartedAt;
});

el.peek.addEventListener('mouseleave', () => {
  if (el.dock.dataset.peek !== '1' || peekTimer) return;
  restartPeekTimer(Math.max(peekRemaining, 800));
});

el.peek.addEventListener('click', () => {
  const jid = peekJid;
  if (jid) openPanel(jid);
});

function setStatus(text, tone) {
  el.status.hidden = false;
  el.status.textContent = text;
  if (tone) el.status.dataset.tone = tone; else delete el.status.dataset.tone;
}

function clearStatus() {
  el.status.hidden = true;
  el.status.textContent = '';
  delete el.status.dataset.tone;
}

/* ---------------------------------------------------------------
   Entrée : un message arrive
   --------------------------------------------------------------- */

function incoming(m) {
  if (isJidMuted(m.jid)) return;   // fil en sourdine : ne rentre jamais dans la file

  // Du neuf non lu sur un fil qu'on venait de voir marqué « lu ailleurs » :
  // la mention n'a plus lieu d'être, et ce fil ne doit plus être purgé.
  if (pendingReadJids.has(m.jid)) {
    pendingReadJids.delete(m.jid);
    el.readNote.hidden = true;
  }

  queue.push({
    jid:    m.jid,
    from:   m.from || 'Inconnu',
    text:   m.text || '',
    media:  m.media || null,
    avatar: m.avatar || null,
    at:     m.at || Date.now(),
  });
  render();

  if (el.dock.dataset.state === 'open') {
    if (!selectedJid) {
      selectedJid = m.jid;
      renderThreadContent();
      clearStatus();
      requestAnimationFrame(() => el.input.focus());
    }
    // Le panneau est ouvert sur un autre fil : la pile d'expéditeurs se
    // met à jour, mais on ne coupe pas ce qu'on est en train de lire
    // ou de taper.
    renderSendersStrip();
    if (m.jid === selectedJid) renderThreadContent();
    syncHitRegion();
    return;
  }

  // Le panneau ne s'ouvre pas tout seul : la bulle signale, l'utilisateur
  // décide. S'ouvrir à chaque message devient invivable au bout d'une heure.
  // En mode "Ne pas déranger", le message est compté mais sans rebond.
  if (!muted) {
    setState('alert');
    setTimeout(() => {
      if (el.dock.dataset.state === 'alert') setState('idle');
    }, 950);
    scheduleDormant();
    showPeek(queue[queue.length - 1]);
  }
}

/* ---------------------------------------------------------------
   Lu sur un autre appareil
   Le connecteur signale qu'un fil vient d'être lu ou répondu depuis
   le téléphone / WhatsApp Web. On vide ce fil de la file. Exception :
   si le panneau est ouvert sur ce fil précis, on ne coupe rien — une
   mention discrète s'affiche et la purge attend la fermeture.
   --------------------------------------------------------------- */

function readElsewhere(jid) {
  // Notre propre réponse revient en écho (message key.fromMe) et
  // déclenche un 'read' sur le fil qu'on vient de traiter : sans intérêt,
  // et ça ferait clignoter la mention pendant la fermeture du panneau.
  if (jid === lastReply.jid && Date.now() - lastReply.at < 6000) return;

  if (el.dock.dataset.state === 'open' && selectedJid === jid) {
    pendingReadJids.add(jid);
    el.readNote.hidden = false;
    return;
  }

  const before = queue.length;
  queue = queue.filter(m => m.jid !== jid);
  if (queue.length === before) return;   // rien de ce fil dans la file

  if (peekJid === jid) hidePeek();
  render();
  if (el.dock.dataset.state === 'open') {
    renderSendersStrip();
  } else {
    setState(queue.length ? 'idle' : 'dormant');
  }
  scheduleDormant();
  syncHitRegion();
}

/* ---------------------------------------------------------------
   Sortie : on répond
   --------------------------------------------------------------- */

function send() {
  const text = el.input.value.trim();
  const latest = [...queue].reverse().find(m => m.jid === selectedJid);
  if (!text || !latest) return;

  hideEmojiPicker();

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'reply', jid: latest.jid, text }));
    lastReply = { jid: latest.jid, at: Date.now() };
    setStatus('Envoi…');
    el.send.disabled = true;
  } else {
    // En aperçu, on simule l'aller-retour pour juger du rythme.
    setStatus('Envoi…');
    setTimeout(() => onSent({ ok: true }), 420);
  }
}

function onSent(res) {
  if (res.ok) {
    setStatus('Envoyé');
    setTimeout(() => closePanel({ consume: true }), 520);
  } else {
    setStatus(res.error || 'Envoi impossible. Réessayez.', 'error');
    el.send.disabled = el.input.value.trim().length === 0;
  }
}

/* ---------------------------------------------------------------
   Connexion au connecteur
   --------------------------------------------------------------- */

async function connect() {
  let wsUrl = DEFAULT_WS_URL;
  let token = null;

  // Sous Tauri, le connecteur choisit un port libre et un jeton à
  // chaque lancement (voir connector/index.js) — on va les chercher
  // via Rust plutôt que de supposer un port fixe. Tant que le fichier
  // de découverte n'existe pas, le connecteur n'a pas encore démarré.
  if (isTauri) {
    let info = null;
    try { info = await window.__TAURI__.core.invoke('read_connector_info'); } catch {}
    if (!info) {
      setConnectorState('down');
      setTimeout(connect, 3000);
      return;
    }
    wsUrl = `ws://127.0.0.1:${info.port}`;
    token = info.token;
  }

  try { socket = new WebSocket(wsUrl); }
  catch { return void setTimeout(connect, 3000); }

  socket.onopen = () => {
    el.devDot.dataset.live = '1';
    el.devLabel.textContent = 'Connecteur actif';
    if (token) socket.send(JSON.stringify({ type: 'auth', token }));
    // Le WS répond ; le vrai statut WhatsApp (connecté/expiré) arrive
    // juste après via un message 'status'. On lève déjà le grisé du
    // "connecteur injoignable" en attendant.
    if (connectorState === 'down') setConnectorState('ok');
  };

  socket.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }

    if (data.type === 'message')  incoming(data);
    if (data.type === 'sent')     onSent(data);
    if (data.type === 'read' && data.jid) readElsewhere(data.jid);

    if (data.type === 'qr' && data.dataUrl) {
      pairingQr = data.dataUrl;
      setConnectorState('pairing');
      // QR déjà à l'écran (il se renouvelle toutes les ~20-60s tant
      // qu'il n'est pas scanné) : on le rafraîchit sans rouvrir/fermer.
      if (el.dock.dataset.state === 'open' && !queue.length) showConnectorPanel();
    }

    if (data.type === 'status' && data.state === 'connected') {
      pairingQr = null;
      setConnectorState('ok');
      el.qr.hidden = true;
      el.qr.removeAttribute('src');
      if (!queue.length && el.dock.dataset.state === 'open') {
        setStatus('WhatsApp est connecté.', 'success');
        setTimeout(() => closePanel(), 900);
      }
    }
    if (data.type === 'status' && data.state === 'disconnected') {
      pairingQr = null;
      setConnectorState('down');
      if (el.dock.dataset.state === 'open' && !queue.length) showConnectorPanel();
    }
    if (data.type === 'status' && data.state === 'reconnecting') {
      pairingQr = null;
      setConnectorState('down');
      if (el.dock.dataset.state === 'open' && !queue.length) showConnectorPanel();
    }
  };

  socket.onclose = () => {
    el.devDot.dataset.live = '0';
    el.devLabel.textContent = 'Aperçu — connecteur absent';
    socket = null;
    // Seulement en Tauri : en aperçu navigateur, l'absence de connecteur
    // est l'état normal, pas une panne à signaler.
    if (isTauri) setConnectorState('down');
    setTimeout(connect, 3000);
  };

  socket.onerror = () => socket && socket.close();
}

/* ---------------------------------------------------------------
   Tauri — zone cliquable réelle
   La fenêtre couvre toute la hauteur de l'écran mais reste transparente
   au clic partout sauf sur la bulle (et le panneau quand il est ouvert).
   Le passage des clics est géré nativement côté Rust (voir
   src-tauri/src/lib.rs) : on ne fait que lui signaler où sont les zones
   interactives, en pixels physiques, à chaque changement de mise en page.
   --------------------------------------------------------------- */

let hitRegionQueued = false;

function syncHitRegion() {
  if (!isTauri || hitRegionQueued) return;
  hitRegionQueued = true;

  requestAnimationFrame(() => {
    hitRegionQueued = false;
    const b = el.bubble.getBoundingClientRect();
    const panelOpen = el.dock.dataset.state === 'open';
    const menuOpen = !el.ctxmenu.hidden;
    const peekOpen = el.dock.dataset.peek === '1';
    const secondary = panelOpen
      ? el.panel.getBoundingClientRect()
      : menuOpen
        ? el.ctxmenu.getBoundingClientRect()
        : peekOpen
          ? el.peek.getBoundingClientRect()
          : null;

    window.__TAURI__.core.invoke('sync_hit_region', {
      scale: window.devicePixelRatio || 1,
      bubbleCx: b.left + b.width / 2,
      bubbleCy: b.top + b.height / 2,
      bubbleR: b.width / 2,
      panelOpen: Boolean(secondary),
      panelX: secondary ? secondary.left : 0,
      panelY: secondary ? secondary.top : 0,
      panelW: secondary ? secondary.width : 0,
      panelH: secondary ? secondary.height : 0,
    }).catch(() => {});
  });
}

// syncHitRegion() lit getBoundingClientRect() un rAF après setState('open'),
// alors que le panneau est encore en pleine transition
// `transform: scale(0.90) translateX(14px)` → `scale(1) translateX(0)`
// (250 ms). Le rectangle capturé est donc celui du panneau rétréci et
// décalé, et il n'est plus recalculé ensuite : une bande morte le long des
// bords laisse passer le clic vers le bureau (bouton emoji, moitié gauche
// du lecteur audio…). On resynchronise une fois la transition du panneau
// terminée, quand la géométrie est stable.
el.panel.addEventListener('transitionend', (e) => {
  if (e.target === el.panel && e.propertyName === 'transform') syncHitRegion();
});

/* ---------------------------------------------------------------
   Menu contextuel — clic droit sur la bulle
   --------------------------------------------------------------- */

/** Fils en sourdine listés par leur dernier nom connu, pour pouvoir les
    désourdiner — le seul moyen de revenir en arrière une fois filtrés,
    puisqu'un fil en sourdine ne remonte plus jamais dans la file. Reste
    un menu de préférences, pas une liste de conversations. */
function renderMutedMenu() {
  el.ctxMutedList.replaceChildren();
  if (!mutedJids.size) {
    el.ctxMutedList.hidden = true;
    return;
  }
  el.ctxMutedList.hidden = false;

  const heading = document.createElement('div');
  heading.className = 'ctxmenu__heading';
  heading.textContent = 'En sourdine';
  el.ctxMutedList.appendChild(heading);

  for (const [jid, name] of mutedJids) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctxmenu__item';
    btn.textContent = name || 'Inconnu';
    btn.title = 'Réactiver les notifications de ce fil';
    btn.addEventListener('click', () => {
      setJidMuted(jid, name, false);
      if (selectedJid === jid) updateMuteButton();
      renderMutedMenu();
      closeCtxMenu();
    });
    el.ctxMutedList.appendChild(btn);
  }
}

function openCtxMenu(x, y) {
  renderMutedMenu();
  el.ctxmenu.hidden = false;
  const w = el.ctxmenu.offsetWidth;
  const h = el.ctxmenu.offsetHeight;
  el.ctxmenu.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
  el.ctxmenu.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
  syncHitRegion();
}

function closeCtxMenu() {
  if (el.ctxmenu.hidden) return;
  el.ctxmenu.hidden = true;
  syncHitRegion();
}

el.bubble.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  openCtxMenu(e.clientX, e.clientY);
});

el.ctxMute.addEventListener('click', () => {
  muted = !muted;
  try { localStorage.setItem('bulle.muted', muted ? '1' : '0'); } catch {}
  applyMuted();
  closeCtxMenu();
});

/* Démarrage automatique — sans objet en aperçu navigateur. */
if (isTauri) {
  el.ctxAutostart.hidden = false;
  window.__TAURI__.core.invoke('plugin:autostart|is_enabled')
    .then((enabled) => el.ctxAutostart.setAttribute('aria-checked', String(enabled)))
    .catch(() => {});

  el.ctxAutostart.addEventListener('click', async () => {
    const enabled = el.ctxAutostart.getAttribute('aria-checked') === 'true';
    try {
      await window.__TAURI__.core.invoke(enabled ? 'plugin:autostart|disable' : 'plugin:autostart|enable');
      el.ctxAutostart.setAttribute('aria-checked', String(!enabled));
    } catch {}
    closeCtxMenu();
  });
}

document.addEventListener('pointerdown', (e) => {
  if (!el.ctxmenu.hidden && !el.ctxmenu.contains(e.target)) closeCtxMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.ctxmenu.hidden) closeCtxMenu();
});

/* ---------------------------------------------------------------
   Déplacement vertical le long du bord
   --------------------------------------------------------------- */

let drag = null;

el.bubble.addEventListener('pointerdown', (e) => {
  drag = { y: e.clientY, top: el.dock.getBoundingClientRect().top, moved: false };
  el.bubble.setPointerCapture(e.pointerId);
});

el.bubble.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.abs(dy) < 4) return;   // tolérance : un clic reste un clic

  drag.moved = true;
  el.dock.classList.add('is-dragging');
  const h = el.dock.offsetHeight;
  const top = Math.min(Math.max(drag.top + dy, 8), window.innerHeight - h - 8);
  el.dock.style.top = top + 'px';
  syncHitRegion();
});

el.bubble.addEventListener('pointerup', (e) => {
  el.bubble.releasePointerCapture(e.pointerId);
  el.dock.classList.remove('is-dragging');

  if (drag && !drag.moved) {
    el.dock.dataset.state === 'open' ? closePanel() : openPanel();
  } else if (drag && drag.moved) {
    try { localStorage.setItem('bulle.top', el.dock.style.top); } catch {}
  }
  drag = null;
});

/* ---------------------------------------------------------------
   Câblage
   --------------------------------------------------------------- */

el.input.addEventListener('input', () => {
  el.send.disabled = el.input.value.trim().length === 0;
  clearStatus();
});

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  if (e.key === 'Escape') closePanel();
});

el.send.addEventListener('click', send);
document.getElementById('panelClose').addEventListener('click', () => closePanel());

el.muteThread.addEventListener('click', () => {
  if (!selectedJid) return;
  const latest = [...queue].reverse().find(m => m.jid === selectedJid);
  const turningOn = !isJidMuted(selectedJid);
  setJidMuted(selectedJid, latest?.from, turningOn);
  updateMuteButton();

  // Mettre en sourdine depuis le panneau : ce fil ne doit plus rien
  // afficher, y compris ce qui attendait déjà. closePanel({consume})
  // purge la file du fil courant et re-rend (compteur, bande
  // d'expéditeurs, aperçu). Désactiver la sourdine ne touche à rien.
  if (turningOn) closePanel({ consume: true });
});

el.msgToggle.addEventListener('click', () => {
  const expanded = el.msg.classList.toggle('is-expanded');
  el.msgToggle.textContent = expanded ? 'Voir moins' : 'Voir plus';
  syncHitRegion();
});

el.more.addEventListener('click', () => {
  el.previous.hidden = !el.previous.hidden;
  syncHitRegion();
});

/* ---------------------------------------------------------------
   Palette d'emojis — courante et volontairement limitée : Bulle reste
   une bulle de réponse rapide, pas un clavier emoji complet.
   --------------------------------------------------------------- */

const EMOJIS = [
  '😀', '😂', '🥲', '😍', '😅', '🥹', '😉', '😎',
  '🙏', '👍', '👎', '👏', '🙌', '💪', '🤝', '✌️',
  '❤️', '🔥', '🎉', '👀', '😢', '😡', '😴', '🤔',
  '✅', '❌', '💀', '😭',
];

el.emojiPicker.replaceChildren(...EMOJIS.map((e) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'emoji__btn';
  btn.textContent = e;
  btn.addEventListener('click', () => {
    const start = el.input.selectionStart ?? el.input.value.length;
    const end = el.input.selectionEnd ?? el.input.value.length;
    el.input.value = el.input.value.slice(0, start) + e + el.input.value.slice(end);
    el.input.selectionStart = el.input.selectionEnd = start + e.length;
    el.input.dispatchEvent(new Event('input'));
    el.input.focus();
  });
  return btn;
}));

function showEmojiPicker() {
  el.emojiPicker.hidden = false;
  el.emojiToggle.setAttribute('aria-expanded', 'true');
  syncHitRegion();
}

function hideEmojiPicker() {
  if (el.emojiPicker.hidden) return;
  el.emojiPicker.hidden = true;
  el.emojiToggle.setAttribute('aria-expanded', 'false');
  syncHitRegion();
}

el.emojiToggle.addEventListener('click', () => {
  el.emojiPicker.hidden ? showEmojiPicker() : hideEmojiPicker();
});

document.addEventListener('pointerdown', (e) => {
  if (!el.emojiPicker.hidden
      && !el.emojiPicker.contains(e.target)
      && e.target !== el.emojiToggle
      && !el.emojiToggle.contains(e.target)) {
    hideEmojiPicker();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && el.dock.dataset.state === 'open') closePanel();
});

/* Aperçu navigateur uniquement : messages factices pour juger l'animation. */
const SAMPLE = [
  { jid: '2217xxxxxxx@s.whatsapp.net', from: 'Aïssatou Ndiaye', text: 'Tu es dispo pour un point rapide cet après-midi ?' },
  { jid: '2217yyyyyyy@s.whatsapp.net', from: 'Moussa Diop',     text: 'J\'ai poussé la branche, dis-moi si ça compile chez toi.' },
  { jid: '120363xxxx@g.us',            from: 'Équipe produit',  text: 'Réunion décalée à 16h, la salle était prise.' },
  { jid: '2217xxxxxxx@s.whatsapp.net', from: 'Aïssatou Ndiaye', text: 'Ok parfait, à tout à l\'heure alors' },
  { jid: '120363xxxx@g.us',            from: 'Équipe produit',  text: 'Specs à jour ici : https://exemple.com/specs (partie 3 surtout). Dites-moi.' },
  { jid: '2217yyyyyyy@s.whatsapp.net', from: 'Moussa Diop',     text: 'En fait il y a un souci plus profond que prévu : le endpoint renvoie bien les données en local mais pas une fois déployé, j\'ai regardé les logs et ça ressemble à un problème de variable d\'environnement manquante côté prod, je regarde ça cet après-midi et je te tiens au courant dès que j\'ai isolé le vrai souci.' },
];
let sampleIndex = 0;

el.devFire.addEventListener('click', (e) => {
  // Shift+clic : simule un « lu sur un autre appareil » pour le dernier
  // fil de la file — de quoi éprouver readElsewhere en aperçu navigateur.
  if (e.shiftKey) {
    const last = queue[queue.length - 1];
    if (last) readElsewhere(last.jid);
    return;
  }
  incoming({ ...SAMPLE[sampleIndex % SAMPLE.length], at: Date.now() });
  sampleIndex++;
});

/* Position mémorisée entre deux lancements. */
try {
  const saved = localStorage.getItem('bulle.top');
  if (saved) el.dock.style.top = saved;
} catch {}

render();
connect();
syncHitRegion();
if (!isTauri) {
  setTimeout(() => { if (!socket || socket.readyState !== 1) el.devFire.click(); }, 900);
}
if (isTauri) el.devFire.remove();

} // fin de la garde __overlayJsRan
