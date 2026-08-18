// Launches the overlay.
//
// Normally `electron .` is enough. This launcher exists because some antivirus products
// (AVG among them) flag a freshly extracted electron.exe as suspicious and then refuse any
// write to that path — the npm package re-downloads on every start and fails the same way.
//
// The escape hatch is a plain text file, electron-dist.txt, holding the directory of an
// Electron distribution unpacked somewhere the antivirus leaves alone. When it is present
// the npm package is bypassed entirely: no download attempt, no dist/ folder to defend.

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const POINTER = path.join(ROOT, 'electron-dist.txt');
const EXECUTABLE = process.platform === 'win32' ? 'electron.exe' : 'electron';

function resolveElectron() {
  const override = process.env.ELECTRON_OVERRIDE_DIST_PATH || readPointer();
  if (!override) return require('electron'); // resolves to the executable path under plain Node

  const binary = path.join(override, EXECUTABLE);
  if (fs.existsSync(binary)) return binary;

  // The directory is configured and its other files are there, but the executable is not:
  // that is what an antivirus quarantine looks like. Falling back to the npm package here
  // would only produce a confusing "failed to download" error on top of the real cause.
  const siblings = fs.existsSync(override) ? fs.readdirSync(override).length : 0;
  console.error(`\n[start] ${binary} est introuvable.`);
  if (siblings > 0) {
    console.error(`[start] Le dossier existe pourtant et contient ${siblings} autres fichiers.`);
    console.error('[start] C’est la signature d’une mise en quarantaine par l’antivirus :');
    console.error('[start] restaure electron.exe depuis le coffre-fort et ajoute une exception,');
    console.error('[start] sinon il sera supprimé de nouveau au prochain lancement.\n');
  } else {
    console.error(`[start] Vérifie le chemin indiqué dans ${POINTER}\n`);
  }

  process.exit(1);
}

function readPointer() {
  try {
    return fs.readFileSync(POINTER, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

const binary = resolveElectron();
console.log(`[start] ${binary}`);

const child = spawn(binary, [ROOT, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('close', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error(`[start] Impossible de lancer Electron : ${err.message}`);
  process.exit(1);
});
