/* ---------------------------------------------------------------
   Compile le connecteur en exécutable unique avec bun, nommé selon la
   convention sidecar de Tauri (suffixe = triplet de cible Rust) pour
   que externalBin le trouve. Lancé automatiquement avant `tauri dev` /
   `tauri build` (voir src-tauri/tauri.conf.json, build.beforeDevCommand
   et beforeBuildCommand).
   --------------------------------------------------------------- */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONNECTOR_ENTRY = path.join(ROOT, 'connector', 'index.js');
const BINARIES_DIR = path.join(ROOT, 'src-tauri', 'binaries');

// Le triplet de cible Rust courant (ex: x86_64-pc-windows-msvc), pas
// une valeur en dur — Tauri suffixe le binaire attendu avec celui de
// la machine qui compile.
const targetTriple = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
  .split('\n')
  .find((line) => line.startsWith('host:'))
  ?.split(':')[1]
  ?.trim();

if (!targetTriple) {
  console.error('Impossible de déterminer le triplet de cible via rustc -vV');
  process.exit(1);
}

const outfile = path.join(BINARIES_DIR, `bulle-connector-${targetTriple}.exe`);

console.log(`Compilation du connecteur en sidecar → ${outfile}`);
execFileSync('bun', ['build', '--compile', `--outfile=${outfile}`, CONNECTOR_ENTRY], {
  stdio: 'inherit',
  cwd: path.join(ROOT, 'connector'),
});
