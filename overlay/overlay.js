/* ---------------------------------------------------------------
   Bulle — logique de l'overlay
   Sans connecteur, le fichier tourne seul dans un navigateur en mode
   aperçu. Avec le connecteur, il bascule automatiquement sur le vrai
   flux WhatsApp. Aucune bascule manuelle à faire.
   --------------------------------------------------------------- */

const WS_URL = 'ws://127.0.0.1:8787';
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
  msg:         document.getElementById('panelMsg'),
  more:        document.getElementById('panelMore'),
  input:       document.getElementById('replyInput'),
  send:        document.getElementById('replySend'),
  status:      document.getElementById('panelStatus'),
  devbar:      document.getElementById('devbar'),
  devDot:      document.getElementById('devDot'),
  devLabel:    document.getElementById('devLabel'),
  devFire:     document.getElementById('devFire'),
};

/** File des messages non lus, du plus ancien au plus récent. */
let queue = [];
let socket = null;
let dormantTimer = null;

if (window.__TAURI__) document.body.classList.add('is-tauri');

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

function openPanel() {
  const latest = queue[queue.length - 1];
  if (!latest) return;

  el.panelAvatar.src = avatarFor(latest);
  el.panelAvatar.alt = '';
  el.name.textContent = latest.from;
  el.meta.textContent = timeLabel(latest.at);
  el.msg.textContent = latest.text;

  // Les autres messages du même fil restent signalés sans être empilés :
  // la bulle montre le dernier, pas une boîte de réception.
  const others = queue.filter(m => m.jid === latest.jid).length - 1;
  el.more.hidden = others < 1;
  el.more.textContent = others === 1
    ? '1 autre message dans cette conversation'
    : `${others} autres messages dans cette conversation`;

  clearStatus();
  setState('open');
  clearTimeout(dormantTimer);
  requestAnimationFrame(() => el.input.focus());
}

function closePanel({ consume = false } = {}) {
  if (consume) {
    const jid = queue.length ? queue[queue.length - 1].jid : null;
    queue = queue.filter(m => m.jid !== jid);
  }
  el.input.value = '';
  el.send.disabled = true;
  render();
  setState(queue.length ? 'idle' : 'dormant');
  scheduleDormant();
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

  // Le panneau ne s'ouvre pas tout seul : la bulle signale, l'utilisateur
  // décide. S'ouvrir à chaque message devient invivable au bout d'une heure.
  if (el.dock.dataset.state !== 'open') {
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
  const latest = queue[queue.length - 1];
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

function connect() {
  try { socket = new WebSocket(WS_URL); }
  catch { return void setTimeout(connect, 3000); }

  socket.onopen = () => {
    el.devDot.dataset.live = '1';
    el.devLabel.textContent = 'Connecteur actif';
  };

  socket.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }

    if (data.type === 'message')  incoming(data);
    if (data.type === 'sent')     onSent(data);
    if (data.type === 'qr')       setStatus('Scannez le QR code affiché dans le terminal.');
    if (data.type === 'status' && data.state === 'disconnected') {
      setStatus('WhatsApp déconnecté. Relancez le connecteur.', 'error');
    }
  };

  socket.onclose = () => {
    el.devDot.dataset.live = '0';
    el.devLabel.textContent = 'Aperçu — connecteur absent';
    socket = null;
    setTimeout(connect, 3000);
  };

  socket.onerror = () => socket && socket.close();
}

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
setTimeout(() => { if (!socket || socket.readyState !== 1) el.devFire.click(); }, 900);
