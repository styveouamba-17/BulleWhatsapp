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
  qr:          document.getElementById('panelQr'),
  msg:         document.getElementById('panelMsg'),
  more:        document.getElementById('panelMore'),
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
  senders:     document.getElementById('senders'),
};

/** File des messages non lus, du plus ancien au plus récent. */
let queue = [];
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

/** Affiche le dernier message du fil choisi — pas forcément le plus
    récent tous expéditeurs confondus. */
function renderThreadContent() {
  const latest = [...queue].reverse().find(m => m.jid === selectedJid);
  if (!latest) return;

  el.qr.hidden = true;   // un vrai message a la priorité sur l'écran de pairage
  el.panelAvatar.src = avatarFor(latest);
  el.panelAvatar.alt = '';
  el.name.textContent = latest.from;
  el.meta.textContent = timeLabel(latest.at);
  el.msg.textContent = latest.text;

  // Les autres messages du même fil restent signalés sans être empilés :
  // le panneau montre le dernier de ce fil, pas une boîte de réception.
  const others = queue.filter(m => m.jid === latest.jid).length - 1;
  el.more.hidden = others < 1;
  el.more.textContent = others === 1
    ? '1 autre message dans cette conversation'
    : `${others} autres messages dans cette conversation`;
}

function selectThread(jid) {
  selectedJid = jid;
  renderThreadContent();
  renderSendersStrip();
  syncHitRegion();
}

function openPanel() {
  const latest = queue[queue.length - 1];

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
  el.name.textContent = 'Bulle';
  el.meta.textContent = '';
  el.more.hidden = true;

  if (connectorState === 'pairing' && pairingQr) {
    el.qr.src = pairingQr;
    el.qr.hidden = false;
    el.msg.textContent = 'Scannez depuis le téléphone : WhatsApp › Réglages › Appareils liés › Lier un appareil.';
  } else {
    el.qr.hidden = true;
    el.msg.textContent = connectorState === 'down'
      ? 'Connecteur injoignable. Vérifiez qu\'il tourne, puis réessayez dans quelques secondes.'
      : 'Session WhatsApp expirée. Relancez le connecteur et scannez un nouveau QR code.';
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
  selectedJid = null;
  el.input.value = '';
  el.send.disabled = true;
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
  queue.push({
    jid:    m.jid,
    from:   m.from || 'Inconnu',
    text:   m.text || '',
    avatar: m.avatar || null,
    at:     m.at || Date.now(),
  });
  render();

  if (el.dock.dataset.state === 'open') {
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
  }
}

/* ---------------------------------------------------------------
   Sortie : on répond
   --------------------------------------------------------------- */

function send() {
  const text = el.input.value.trim();
  const latest = [...queue].reverse().find(m => m.jid === selectedJid);
  if (!text || !latest) return;

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'reply', jid: latest.jid, text }));
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
    }
    if (data.type === 'status' && data.state === 'disconnected') {
      pairingQr = null;
      setConnectorState('expired');
      setStatus('WhatsApp déconnecté. Relancez le connecteur.', 'error');
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
    const secondary = panelOpen
      ? el.panel.getBoundingClientRect()
      : menuOpen
        ? el.ctxmenu.getBoundingClientRect()
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

/* ---------------------------------------------------------------
   Menu contextuel — clic droit sur la bulle
   --------------------------------------------------------------- */

function openCtxMenu(x, y) {
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

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && el.dock.dataset.state === 'open') closePanel();
});

/* Aperçu : messages factices pour juger l'animation et le rythme. */
const SAMPLE = [
  { jid: '2217xxxxxxx@s.whatsapp.net', from: 'Aïssatou Ndiaye', text: 'Tu es dispo pour un point rapide cet après-midi ?' },
  { jid: '2217yyyyyyy@s.whatsapp.net', from: 'Moussa Diop',     text: 'J\'ai poussé la branche, dis-moi si ça compile chez toi.' },
  { jid: '120363xxxx@g.us',            from: 'Équipe produit',  text: 'Réunion décalée à 16h, la salle était prise.' },
  { jid: '2217xxxxxxx@s.whatsapp.net', from: 'Aïssatou Ndiaye', text: 'Ok parfait, à tout à l\'heure alors' },
];
let sampleIndex = 0;

el.devFire.addEventListener('click', () => {
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
setTimeout(() => { if (!socket || socket.readyState !== 1) el.devFire.click(); }, 900);

} // fin de la garde __overlayJsRan
