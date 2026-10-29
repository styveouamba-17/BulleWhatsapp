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
  downloadMediaMessage,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from 'baileys';
import { Boom } from '@hapi/boom';
import { WebSocketServer } from 'ws';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import pino from 'pino';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sealAuthDir, unsealAuthDir } from './authCrypt.js';
import {
  unwrapMessage,
  isViewOnce,
  extractText,
  mediaFor,
  contextInfoFor,
  resolveMentions,
  sameUser,
  pickContactName,
} from './messages.js';
import { parseLockPid, isProcessAlive, lockDecision } from './lock.js';

// %APPDATA% plutôt qu'un chemin relatif au dossier du connecteur : une
// fois empaqueté en sidecar (phase 4), le connecteur tourne depuis un
// dossier d'installation potentiellement en lecture seule (Program
// Files). %APPDATA% est garanti inscriptible pour l'utilisateur courant.
const DATA_DIR = path.join(process.env.APPDATA || os.homedir(), 'Bulle');
const AUTH_DIR = path.join(DATA_DIR, 'auth');
const AUTH_ENC_FILE = path.join(DATA_DIR, 'auth.enc');

// Migration depuis l'ancien emplacement (./auth relatif au CWD, utilisé
// avant que le connecteur ne soit pensé pour tourner en sidecar) — pour
// ne pas perdre une session existante au premier lancement après la mise
// à jour. Ne fait rien si %APPDATA%/Bulle existe déjà.
function migrateLegacyAuthLocation() {
  if (fs.existsSync(AUTH_DIR) || fs.existsSync(AUTH_ENC_FILE)) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync('./auth')) fs.renameSync('./auth', AUTH_DIR);
  if (fs.existsSync('./auth.enc')) fs.renameSync('./auth.enc', AUTH_ENC_FILE);
}
migrateLegacyAuthLocation();

// Verrou mono-instance — AVANT toute prise sur auth/ et avant d'enregistrer
// le moindre handler de sortie : une seconde instance doit ressortir sans
// rien toucher (ni déchiffrer auth/, ni écraser le fichier de découverte de
// la première). Deux connecteurs sur la même session Baileys se
// déconnectent mutuellement en boucle — c'est la bulle qui vire au gris
// puis au vert sans arrêt.
const LOCK_FILE = path.join(DATA_DIR, 'connector.lock');

function acquireSingleInstanceLock() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let lockText = '';
  try {
    lockText = fs.readFileSync(LOCK_FILE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;   // absent = normal ; autre chose = anormal
  }

  const { acquire, holder } = lockDecision(lockText, {
    selfPid: process.pid,
    isAlive: isProcessAlive,
  });
  if (!acquire) {
    console.error(`Un connecteur tourne déjà (PID ${holder}). Sortie.`);
    // Code 0 : le superviseur Rust ne doit pas enchaîner les relances.
    process.exit(0);
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid), { mode: 0o600 });
}

function releaseLock() {
  try {
    if (parseLockPid(fs.readFileSync(LOCK_FILE, 'utf8')) === process.pid) {
      fs.rmSync(LOCK_FILE, { force: true });
    }
  } catch {}
}

acquireSingleInstanceLock();

// Port choisi par l'OS et jeton à usage unique par lancement, plutôt
// que 8787 en dur : un process tiers sur la même machine ne doit pas
// pouvoir lire les messages ou envoyer en se contentant de se
// connecter au bon port. L'overlay découvre les deux via ce fichier
// (voir src-tauri/src/lib.rs, commande read_connector_info).
const TOKEN = crypto.randomBytes(24).toString('hex');
const RUNTIME_FILE = path.join(os.tmpdir(), 'bulle-connector.json');
const AUTH_TIMEOUT_MS = 4000;

function cleanupRuntimeFile() {
  try { fs.rmSync(RUNTIME_FILE, { force: true }); } catch {}
}

// Le dossier auth/ contient la session WhatsApp du compte personnel de
// l'utilisateur (voir CLAUDE.md, §Sécurité). Chiffré au repos via DPAPI
// entre deux lancements — voir connector/authCrypt.js pour les limites
// de cette protection (rien ne couvre un arrêt brutal).
try { unsealAuthDir(AUTH_DIR, AUTH_ENC_FILE); } catch (err) {
  console.error('Déchiffrement de auth/ impossible, poursuite avec ce qui existe :', err?.message);
}
function sealAuthOnExit() {
  try { sealAuthDir(AUTH_DIR, AUTH_ENC_FILE); } catch (err) {
    console.error('Chiffrement de auth/ à la fermeture impossible :', err?.message);
  }
}

process.on('exit', cleanupRuntimeFile);
process.on('exit', sealAuthOnExit);
process.on('exit', releaseLock);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// Un widget qui meurt en silence est abandonné en une semaine (voir
// PROJET.md, phase 3). Une exception isolée — un message malformé, un
// appel réseau qui échoue hors des try/catch déjà en place — ne doit
// pas emporter tout le connecteur : le serveur WS doit rester debout
// pour que l'overlay puisse au moins afficher « connecteur injoignable ».
process.on('uncaughtException', (err) => {
  console.error('Erreur non interceptée (le connecteur continue) :', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Rejet de promesse non intercepté (le connecteur continue) :', err);
});

const log = pino({ level: 'warn' });
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
let sock = null;

/** Clients ayant prouvé qu'ils connaissent le jeton — seuls destinataires des broadcasts. */
const authedClients = new Set();
let latestQr = null;
let connectionState = 'connecting';
let reconnectTimer = null;

/** Chaîne du QR actuellement en cours d'encodage en PNG (async) — permet à
    la promesse de vérifier, à sa résolution, qu'aucun événement plus récent
    (nouveau QR, connexion ouverte) ne l'a entre-temps rendue obsolète. */
let pendingQr = null;

function scheduleStart(delay = 1500) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    start().catch((err) => {
      console.error('Redémarrage impossible :', err);
      scheduleStart(3000);
    });
  }, delay);
}

function clearAuthForPairing() {
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(AUTH_ENC_FILE, { force: true }); } catch {}
}

/** Cache des photos de profil : une requête réseau par contact, pas par message. */
const avatars = new Map();

/** Noms du carnet d'adresses de l'utilisateur, JID → nom qu'*il* a
    enregistré (pas le pushName que le contact s'est donné). Même forme
    que `avatars` : en RAM, non persisté, alimenté par les événements
    contacts.* du multi-appareils. Sert au repli d'affichage des fils 1:1. */
const contacts = new Map();

function rememberContacts(list) {
  if (!Array.isArray(list)) return;
  for (const c of list) {
    const name = pickContactName(c);
    if (c?.id && name) contacts.set(c.id, name);
  }
}

function broadcast(payload) {
  const raw = JSON.stringify(payload);
  for (const client of authedClients) {
    if (client.readyState === 1) client.send(raw);
  }
}

/** Un fil vient d'être traité ailleurs (lu ou répondu depuis le
    téléphone / WhatsApp Web). On le signale à l'overlay pour qu'il
    vide ce fil de sa file. Bulle réagit à une lecture faite ailleurs,
    mais n'en émet jamais (voir CLAUDE.md, « Aucun accusé de lecture »).
    Le console.log reste le temps de vérifier sur appareil réel quels
    événements Baileys sont fiables — à retirer ensuite. */
function signalRead(jid) {
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;
  console.log(`Fil traité ailleurs : ${jid}`);
  broadcast({ type: 'read', jid });
}

/* ---------------------------------------------------------------
   Extraction du texte et du média
   Les formes possibles d'un message WhatsApp — et le déballage des
   enveloppes viewOnce* / ephemeral — vivent dans messages.js (testé).
   Ici on ne fait que télécharger le média une fois qu'on sait qu'il y
   en a un.
   --------------------------------------------------------------- */

async function downloadMedia(msg, content, media) {
  if (!media) return null;
  try {
    // downloadMediaMessage cherche le nœud média dans msg.message.imageMessage
    // etc. — il ne sait pas déballer une enveloppe viewOnce/ephemeral. On lui
    // passe une copie dont .message est le contenu déjà déballé.
    const downloadable = content === msg.message ? msg : { ...msg, message: content };
    const buffer = await downloadMediaMessage(downloadable, 'buffer', {});
    // Baileys renvoie le mimetype audio avec un espace ("audio/ogg; codecs=opus",
    // voir node_modules/baileys/lib/Utils/messages.js) : un espace brut dans une
    // data URL n'est pas un caractère valide, le navigateur le pourcent-encode à
    // la volée et le <audio> ne reconnaît plus le type — la lecture échoue
    // silencieusement. Les mimetypes image/sticker n'ont pas ce paramètre, d'où
    // le bug qui ne touchait que l'audio.
    const mime = media.mime.replace(/\s+/g, '');
    return { ...media, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
  } catch (err) {
    console.error('Téléchargement du média impossible :', err?.message);
    return null;
  }
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

  // Carnet d'adresses : Baileys ne tient pas de store, on garde juste
  // JID → nom enregistré au fil des événements. `messaging-history.set`
  // porte la liste initiale (parmi l'historique qu'on ignore par
  // ailleurs — piège n°1), `contacts.upsert`/`update` les suivants.
  sock.ev.on('messaging-history.set', ({ contacts: list }) => rememberContacts(list));
  sock.ev.on('contacts.upsert', rememberContacts);
  sock.ev.on('contacts.update', rememberContacts);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Le terminal reste utile en dev (npm start lancé à la main) ;
      // l'image sert à l'écran de configuration dans l'overlay.
      console.log('\nScannez ce code depuis WhatsApp › Appareils liés :\n');
      qrcodeTerminal.generate(qr, { small: true });
      pendingQr = qr;
      QRCode.toDataURL(qr, {
        margin: 2,
        width: 240,
        color: { dark: '#000000', light: '#ffffff' },
      })
        .then((dataUrl) => {
          // La génération est async : si un QR plus récent a déjà pris le
          // relais, ou si la connexion s'est ouverte entre-temps (le
          // redémarrage 515 juste après le scan en est le cas courant),
          // ce résultat est obsolète — l'appliquer écraserait un état
          // "connecté" avec un QR périmé, et ça ne s'en irait plus jamais
          // tant que le connecteur tourne.
          if (pendingQr !== qr) return;
          latestQr = dataUrl;
          connectionState = 'pairing';
          broadcast({ type: 'qr', dataUrl });
        })
        .catch((err) => console.error('Génération du QR impossible :', err?.message));
    }

    if (connection === 'open') {
      pendingQr = null;
      latestQr = null;
      connectionState = 'connected';
      console.log('WhatsApp connecté.');
      broadcast({ type: 'status', state: 'connected' });
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;

      // 515 « restart required » juste après l'appairage : attendu, pas une erreur.
      // Tout sauf une déconnexion volontaire mérite une reconnexion.
      if (code === DisconnectReason.loggedOut) {
        clearAuthForPairing();
        pendingQr = null;
        latestQr = null;
        connectionState = 'connecting';
        console.log('Session révoquée. Nouveau QR en préparation…');
        broadcast({ type: 'status', state: 'reconnecting' });
        scheduleStart(500);
        return;
      }

      console.log(`Connexion perdue (${code ?? 'inconnu'}), reconnexion…`);
      connectionState = 'connecting';
      broadcast({ type: 'status', state: 'reconnecting' });
      scheduleStart();
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
      if (msg.key.remoteJid === 'status@broadcast') continue;    // les statuts
      if (msg.key.remoteJid?.endsWith('@newsletter')) continue;  // les chaînes

      // Un message sortant remonté depuis un autre appareil : ce fil vient
      // d'être répondu ailleurs. On le signale, puis on s'arrête là — nos
      // propres envois n'ont pas leur place dans une bulle de réception.
      if (msg.key.fromMe) {
        signalRead(msg.key.remoteJid);
        continue;
      }

      // Déballe les enveloppes viewOnce* / ephemeral : sans ça, une photo
      // à usage unique et l'intégralité d'un fil en messages éphémères
      // passent inaperçues.
      const content = unwrapMessage(msg.message);
      // Mentions de groupe : le texte contient `@<chiffres>`, les noms
      // sont dans contextInfo.mentionedJid. On résout via le carnet
      // (`contacts`) ; une mention inconnue reste `@<chiffres>`.
      const mentioned = contextInfoFor(content)?.mentionedJid || [];
      const text = resolveMentions(extractText(content) || '', mentioned, (jid) => contacts.get(jid));
      const media = await downloadMedia(msg, content, mediaFor(content));
      if (!text && !media) continue;

      // Marque le média « vue unique » : l'overlay l'affiche (il n'a pas de
      // stockage — la photo s'efface avec la file) mais le signale, car
      // elle n'est déjà plus disponible sur le téléphone.
      if (media && isViewOnce(msg.message)) media.viewOnce = true;

      const jid = msg.key.remoteJid;
      const isGroup = jid.endsWith('@g.us');

      // Fil 1:1 : on préfère le nom qu'on a enregistré pour ce contact ;
      // à défaut, le pushName qu'il s'est donné. En groupe, le sujet reste
      // géré côté overlay — on garde le pushName de l'expéditeur.
      const from = (!isGroup && contacts.get(jid))
        || msg.pushName
        || (isGroup ? 'Groupe' : 'Inconnu');

      broadcast({
        type: 'message',
        jid,                                    // clé opaque, jamais reconstruite
        from,
        text,
        media,
        avatar: await avatarFor(jid),
        at: Number(msg.messageTimestamp) * 1000,
        group: isGroup,
      });

      // Volontairement : aucun accusé de lecture. Ouvrir la bulle ne doit
      // pas marquer la conversation comme lue sur le téléphone.
    }
  });

  /* -------------------------------------------------------------
     Lecture ailleurs
     Quand un fil est lu sur un autre appareil (téléphone, WhatsApp
     Web), le multi-appareils propage un chats.update dont le
     unreadCount retombe à 0. unreadCount peut aussi valoir -1
     (« marquer comme non lu ») : on ne traite que l'égalité stricte.
     ------------------------------------------------------------- */

  sock.ev.on('chats.update', (updates) => {
    for (const update of updates) {
      if (update.unreadCount === 0) {
        console.log(`[lecture?] chats.update unreadCount=0 jid=${update.id}`);
        signalRead(update.id);
      }
    }
  });

  /* -------------------------------------------------------------
     Instrumentation temporaire (voir IDEES-WIDGETS.md) — on ne sait pas
     encore quel événement Baileys remonte de façon fiable quand un fil
     est *lu* sur un autre appareil sans réponse. Chaque écouteur logue
     avec un préfixe distinct ; lancer le connecteur avec la sortie
     visible (npm start), lire un fil sur le téléphone, et relever la
     ligne qui apparaît. On garde ensuite le fiable, on retire le reste.

     message-receipt.update : un accusé portant readTimestamp dont le
     userJid est le nôtre = on a lu ce fil quelque part. C'est le
     candidat le plus solide, donc le seul câblé à signalRead pour
     l'instant.

     messages.update : status ∈ {3,4} concerne le fait qu'un
     destinataire a reçu/lu *notre* message — pas nous lisant le sien.
     Log seul, jamais signalRead.
     ------------------------------------------------------------- */

  const selfJid = () => sock?.user?.id;

  sock.ev.on('message-receipt.update', (updates) => {
    for (const { key, receipt } of updates) {
      if (!key?.remoteJid || !receipt) continue;
      const mine = sameUser(receipt.userJid, selfJid());
      console.log(
        `[lecture?] message-receipt.update jid=${key.remoteJid} ` +
        `userJid=${receipt.userJid} readTs=${receipt.readTimestamp ?? '—'} mine=${mine}`
      );
      if (mine && receipt.readTimestamp) signalRead(key.remoteJid);
    }
  });

  sock.ev.on('messages.update', (updates) => {
    for (const { key, update } of updates) {
      if (!key?.remoteJid) continue;
      console.log(
        `[lecture?] messages.update jid=${key.remoteJid} ` +
        `fromMe=${key.fromMe} status=${update?.status ?? '—'}`
      );
    }
  });
}

/* ---------------------------------------------------------------
   Commandes venant de l'overlay
   --------------------------------------------------------------- */

wss.on('connection', (client) => {
  const authTimer = setTimeout(() => {
    if (!authedClients.has(client)) client.close();
  }, AUTH_TIMEOUT_MS);

  client.on('close', () => {
    authedClients.delete(client);
    clearTimeout(authTimer);
  });

  client.on('message', async (raw) => {
    let cmd;
    try { cmd = JSON.parse(raw.toString()); } catch { return; }

    // Premier message obligatoire : prouver qu'on connaît le jeton.
    // Rien d'autre n'est traité tant que ce n'est pas fait.
    if (!authedClients.has(client)) {
      if (cmd.type === 'auth' && cmd.token === TOKEN) {
        authedClients.add(client);
        clearTimeout(authTimer);
        if (latestQr) client.send(JSON.stringify({ type: 'qr', dataUrl: latestQr }));
        client.send(JSON.stringify({ type: 'status', state: connectionState }));
      } else {
        client.close();
      }
      return;
    }

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

wss.on('listening', () => {
  const { port } = wss.address();
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify({ port, token: TOKEN }), { mode: 0o600 });
  console.log(`Connecteur en écoute sur ws://127.0.0.1:${port}`);

  start().catch((err) => {
    console.error('Démarrage impossible :', err);
    process.exit(1);
  });
});
