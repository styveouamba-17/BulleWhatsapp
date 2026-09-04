/* ---------------------------------------------------------------
   Bulle — connecteur WhatsApp
   Maintient la session appareil lié et expose deux choses à l'overlay
   sur un WebSocket local : les messages entrants, et une commande de
   réponse. Rien d'autre. Pas d'historique, pas de stockage.
   --------------------------------------------------------------- */

// Baileys v7 a introduit des changements cassants, dont le passage de
// makeWASocket en export nommé. Si le démarrage échoue sur un
// « makeWASocket is not a function », basculer sur :
//   import { makeWASocket, ... } from 'baileys'
// Guide de migration : https://whiskey.so/migrate-latest
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from 'baileys';
import { Boom } from '@hapi/boom';
import { WebSocketServer } from 'ws';
import qrcode from 'qrcode-terminal';
import pino from 'pino';

const PORT = 8787;
const AUTH_DIR = './auth';

const log = pino({ level: 'warn' });
const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
let sock = null;

/** Cache des photos de profil : une requête réseau par contact, pas par message. */
const avatars = new Map();

function broadcast(payload) {
  const raw = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(raw);
  }
}

/* ---------------------------------------------------------------
   Extraction du texte
   Un message WhatsApp a une dizaine de formes possibles. On ne traite
   que celles qui portent du texte : le reste (média, réaction, appel,
   accusé) n'a pas sa place dans une bulle de réponse rapide.
   --------------------------------------------------------------- */

function extractText(msg) {
  const m = msg.message;
  if (!m) return null;

  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    null
  );
}

async function avatarFor(jid) {
  if (avatars.has(jid)) return avatars.get(jid);
  let url = null;
  try {
    url = await sock.profilePictureUrl(jid, 'preview');
  } catch {
    // Photo absente ou masquée par les réglages de confidentialité : normal.
  }
  avatars.set(jid, url);
  return url;
}

/* ---------------------------------------------------------------
   Connexion
   --------------------------------------------------------------- */

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: log,
    // On ne se déclare pas en ligne : sinon WhatsApp cesse d'envoyer les
    // notifications push sur le téléphone, qui reste l'appareil principal.
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nScannez ce code depuis WhatsApp › Appareils liés :\n');
      qrcode.generate(qr, { small: true });
      broadcast({ type: 'qr' });
    }

    if (connection === 'open') {
      console.log('WhatsApp connecté.');
      broadcast({ type: 'status', state: 'connected' });
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;

      // 515 « restart required » juste après l'appairage : attendu, pas une erreur.
      // Tout sauf une déconnexion volontaire mérite une reconnexion.
      if (code === DisconnectReason.loggedOut) {
        console.log('Session révoquée. Supprimez ./auth et relancez pour réappairer.');
        broadcast({ type: 'status', state: 'disconnected' });
        return;
      }

      console.log(`Connexion perdue (${code ?? 'inconnu'}), reconnexion…`);
      broadcast({ type: 'status', state: 'reconnecting' });
      setTimeout(start, 1500);
    }
  });

  /* -------------------------------------------------------------
     Messages entrants
     ------------------------------------------------------------- */

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'append' = synchronisation d'historique. Sans ce filtre, la bulle
    // reçoit des centaines de vieux messages au démarrage.
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;                              // nos propres envois
      if (msg.key.remoteJid === 'status@broadcast') continue;    // les statuts
      if (msg.key.remoteJid?.endsWith('@newsletter')) continue;  // les chaînes

      const text = extractText(msg);
      if (!text) continue;

      const jid = msg.key.remoteJid;
      const isGroup = jid.endsWith('@g.us');

      broadcast({
        type: 'message',
        jid,                                    // clé opaque, jamais reconstruite
        from: msg.pushName || (isGroup ? 'Groupe' : 'Inconnu'),
        text,
        avatar: await avatarFor(jid),
        at: Number(msg.messageTimestamp) * 1000,
        group: isGroup,
      });

      // Volontairement : aucun accusé de lecture. Ouvrir la bulle ne doit
      // pas marquer la conversation comme lue sur le téléphone.
    }
  });
}

/* ---------------------------------------------------------------
   Commandes venant de l'overlay
   --------------------------------------------------------------- */

wss.on('connection', (client) => {
  client.on('message', async (raw) => {
    let cmd;
    try { cmd = JSON.parse(raw.toString()); } catch { return; }

    if (cmd.type === 'typing' && sock) {
      try { await sock.sendPresenceUpdate('composing', cmd.jid); } catch {}
      return;
    }

    if (cmd.type === 'reply') {
      if (!sock) {
        client.send(JSON.stringify({ type: 'sent', ok: false, error: 'Connecteur hors ligne.' }));
        return;
      }
      try {
        await sock.sendMessage(cmd.jid, { text: cmd.text });
        await sock.sendPresenceUpdate('paused', cmd.jid);
        client.send(JSON.stringify({ type: 'sent', ok: true, jid: cmd.jid }));
      } catch (err) {
        console.error('Envoi échoué :', err?.message);
        client.send(JSON.stringify({ type: 'sent', ok: false, error: 'Envoi impossible.' }));
      }
    }
  });
});

console.log(`Connecteur en écoute sur ws://127.0.0.1:${PORT}`);
start().catch((err) => {
  console.error('Démarrage impossible :', err);
  process.exit(1);
});
