/* ---------------------------------------------------------------
   Bulle — verrou mono-instance du connecteur
   Deux connecteurs sur le même dossier auth/ = deux clients Baileys sur
   une session qui n'en autorise qu'un : ils se déconnectent
   mutuellement en boucle (bulle grise ↔ verte). Ça arrive avec un
   sidecar orphelin après un kill forcé, ou un `node connector` lancé à
   la main resté en fond.

   Ici les briques pures ; index.js les câble (fichier connector.lock
   dans %APPDATA%/Bulle, contenant le PID).
   --------------------------------------------------------------- */

/** PID entier positif écrit dans le fichier verrou, ou null si le
    contenu n'est pas exploitable. */
export function parseLockPid(text) {
  const pid = Number.parseInt(String(text ?? '').trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Le process `pid` tourne-t-il encore ? `process.kill(pid, 0)` n'envoie
    aucun signal, il ne fait que tester l'existence. ESRCH = absent ;
    EPERM = présent mais pas à nous (donc vivant). */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Décision pure : vu le contenu du fichier verrou, prend-on le verrou ?
    On le prend si le fichier est absent/illisible, s'il pointe un PID
    mort, ou s'il pointe notre propre PID (relance dans le même process).
    On ne le prend pas s'il est tenu par un autre PID vivant. */
export function lockDecision(lockText, { selfPid, isAlive }) {
  const holder = parseLockPid(lockText);
  if (holder && holder !== selfPid && isAlive(holder)) {
    return { acquire: false, holder };
  }
  return { acquire: true, holder: null };
}
