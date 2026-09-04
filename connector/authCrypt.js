/* ---------------------------------------------------------------
   Bulle — chiffrement « au repos » du dossier auth/
   DPAPI protège le contenu tant que le connecteur ne tourne pas.
   Pendant l'exécution, Baileys lit/écrit auth/ en clair exactement
   comme avant : useMultiFileAuthState n'est pas touché, pour ne pas
   risquer de casser une session bien réelle sur un refactor hasardeux.

   Seule la fenêtre entre deux lancements est protégée. Un process tué
   brutalement (crash, kill -9, coupure de courant) laisse le dossier
   en clair jusqu'au prochain arrêt propre — limite assumée, pas un
   chiffrement permanent en mémoire.
   --------------------------------------------------------------- */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function runPowerShell(script) {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'pipe' });
}

function dpapiProtectFile(inPath, outPath) {
  runPowerShell(
    `Add-Type -AssemblyName System.Security; ` +
    `$b = [IO.File]::ReadAllBytes('${inPath}'); ` +
    `$e = [Security.Cryptography.ProtectedData]::Protect($b, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
    `[IO.File]::WriteAllBytes('${outPath}', $e)`
  );
}

function dpapiUnprotectFile(inPath, outPath) {
  runPowerShell(
    `Add-Type -AssemblyName System.Security; ` +
    `$b = [IO.File]::ReadAllBytes('${inPath}'); ` +
    `$d = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
    `[IO.File]::WriteAllBytes('${outPath}', $d)`
  );
}

/** Archive authDir dans encFile (chiffré) puis vide authDir. N'efface
    le clair qu'une fois la copie chiffrée confirmée sur disque. */
export function sealAuthDir(authDir, encFile) {
  if (!fs.existsSync(authDir)) return;
  const files = fs.readdirSync(authDir).filter(f => fs.statSync(path.join(authDir, f)).isFile());
  if (files.length === 0) return;

  const archive = {};
  for (const f of files) {
    archive[f] = fs.readFileSync(path.join(authDir, f)).toString('base64');
  }

  const tmpPlain = path.join(os.tmpdir(), `bulle-auth-${process.pid}.json`);
  const tmpEnc = path.join(os.tmpdir(), `bulle-auth-${process.pid}.enc`);
  try {
    fs.writeFileSync(tmpPlain, JSON.stringify(archive));
    dpapiProtectFile(tmpPlain, tmpEnc);
    fs.copyFileSync(tmpEnc, encFile);           // copie chiffrée confirmée...
    for (const f of files) fs.rmSync(path.join(authDir, f), { force: true }); // ...alors seulement on efface le clair
  } finally {
    fs.rmSync(tmpPlain, { force: true });
    fs.rmSync(tmpEnc, { force: true });
  }
}

/** Restaure authDir depuis encFile, puis supprime encFile — seulement
    si la restauration a réussi. */
export function unsealAuthDir(authDir, encFile) {
  if (!fs.existsSync(encFile)) return;

  const tmpEnc = path.join(os.tmpdir(), `bulle-auth-${process.pid}.enc`);
  const tmpPlain = path.join(os.tmpdir(), `bulle-auth-${process.pid}.json`);
  try {
    fs.copyFileSync(encFile, tmpEnc);
    dpapiUnprotectFile(tmpEnc, tmpPlain);
    const archive = JSON.parse(fs.readFileSync(tmpPlain, 'utf8'));
    fs.mkdirSync(authDir, { recursive: true });
    for (const [name, b64] of Object.entries(archive)) {
      fs.writeFileSync(path.join(authDir, name), Buffer.from(b64, 'base64'));
    }
    fs.rmSync(encFile, { force: true });        // restauration confirmée avant de retirer le chiffré
  } finally {
    fs.rmSync(tmpEnc, { force: true });
    fs.rmSync(tmpPlain, { force: true });
  }
}
